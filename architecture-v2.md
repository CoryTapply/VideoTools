# Architecture v2 — post-feasibility

**Supersedes:** `architecture.md` (v1, pre-measurement)
**Basis:** M0 and M0.5 spike results, all measured against a real 27 GB / 70-minute OBS recording on an M1 Max
**Status:** cleared to build M1

---

## 0. What changed, and why

Five things moved. Everything else in v1 survived contact with measurement.

| # | v1 said | v2 says | Driver |
|---|---|---|---|
| 1 | Index build is the highest-variance risk; may need chunking | Build it eagerly, in full, at open. No chunking. | 107ms for 1.44M samples, 41.8 MB retained |
| 2 | Scrub via on-demand WebCodecs decode | Scrub from a **keyframe-aligned frame cache** that is the same artifact as the filmstrip | On-demand decode failed; the 2fps cache that replaced it costs 27s per 5-minute window |
| 3 | mediabunny is the engine | The in-house parser is the engine; mediabunny is a **test oracle only** | Three real mediabunny bugs found, including one that crashed the browser |
| 4 | Avoid cross-origin isolation | Enable it | Free here, and it unlocks SAB plus real memory measurement |
| 5 | One video track, one audio track | **Multi-track audio is a first-class requirement** | The OBS fixture has 7 tracks |

Plus one unresolved finding the feasibility document mischaracterised — see §2.

---

## 1. Measured baseline

Every number below is real, from the 27 GB fixture on an M1 Max with NVMe unless noted. Treat these as the constants the implementation is built around, and treat them as *optimistic* — they're from fast hardware.

**Index**
- 1,442,030 samples across 7 tracks (253,544 video) → **107.1 ms**, **41.8 MB retained**
- Extrapolated 8-hour / 60fps case (~1.7M samples): ~114 ms, ~49 MB
- Queries: 61.5–352 ns/op across all four query types
- OPFS cache read-back **4.86 ms** vs **110.26 ms** to rebuild — cache it
- Zero correctness mismatches against mediabunny on both the 27 GB file and the VFR fixture

**Remux export**
- Structurally correct, faststart, single copying pass
- Write-side 64-bit largesize verified on a real 10.39 GB output
- Abort leaves a **0-byte file** — FSA writes are transactional, nothing partial reaches disk
- 4 MB read/write coalescing window (1 MB → 80.5 MB/s, 4 MB → 91.1, 16 MB → 92.0, plateau)
- Pass-1 moov build: 24 ms at 8,774 samples, 1.4–1.6 s at 552,830 samples

**Decode**
- Keyframe decode: **42/sec sequential, 150.4/sec batched at 16 decodes per flush** — 3.6× from batching alone
- Real GOP on OBS footage: **4.166 s, constant** (≈250 frames at 59.94fps)
- On-demand arbitrary-frame decode: p50 270 ms vs `<video>`'s 281 ms — no meaningful win
- Cache-backed scrub: p50 0.00 ms, p95 0.01 ms, max 0.17 ms — 60 Hz with ~100× margin
- `VideoFrame` leak: ~11–13 MB/frame, linear, **zero errors up to 800 frames / 9.3 GB**

**Playback (M0)**
- `<video>` seek on the 27 GB file: avg 221.6 ms Chrome, 355.8 ms Safari with >1s tail outliers
- Sequential read of the whole 27 GB file: 16.2 s Chrome (≈1.67 GB/s)

---

## 2. Export cost — resolved, with one lever still on the table

Task 0 ran a decoupled matrix (size varied at fixed position, position varied at fixed size, warm vs cold cache) and settled this. **There is no fixed multi-second toll.** The M0.5 reading of "throughput scales with size," and the v2-draft reading of "a 5–8 second constant," were both artefacts of three uncontrolled data points varying along three axes at once.

Measured model, warm cache, R² effectively 1 across 3 MB – 4 GB:

```
copy_ms   ≈  9.5 + size_MB / 245.6      (~73% of total)
close_ms  ≈ 26.6 + size_MB / 734.1      (~25% of total)
total_ms  ≈ 13.2 + size_MB / 178.5
```

Fixed cost is ~13 ms. Source position has no effect — the last-frame range that produced the original 18.77 MB/s outlier is now the *fastest* of five positions tested. Cold OS cache costs ~10–15%, not multiples. `createWritable()` does not scale with the size of an existing file at the target path.

**One item remains open; two are closed.**

**(a) The 18.77 MB/s outlier — closed enough.** A controlled re-test of the identical byte range measured 176.6 MB/s, the fastest of five positions tried. The writeup attributes the original to transient system load, which remains unsatisfying as an explanation, but it is no longer load-bearing: the model now rests on 30+ controlled runs with R² effectively 1 across a 400× size range, not on the three original points. Treat the old throughput table as retracted and move on.

**(b) Read amplification — confirmed and fixed.** The copy loop was reading ~6.5× more bytes than it wrote: a per-track pass structure, each of the 7 tracks independently re-reading the same physically interleaved source region. Replaced with a **merged single-pass loop** — one list of source byte ranges across all selected tracks, sorted by offset, walked once, with output interleaving following source interleaving so no reordering buffer is needed. Amplification is now **1.00×**, copy is 1.7–3× faster, total export 1.2–1.9× faster, with no correctness regression and no unbounded memory growth.

Shipped as `buildMoovMerged` / `forEachWindowMerged` in `remux-write.ts`, additive alongside the original `buildMoov` / `forEachWindowCoalesced`. **Keep both.** The original path is now a differential oracle for the copy loop, the same role mediabunny plays for the parser — any divergence in output between the two is a bug in one of them.

Note the consequence for the progress model: with copy 1.7–3× faster and `close()` unchanged, **`close()` is now roughly 40–50% of total export time rather than 25%**. The finalising phase is proportionally much more prominent, and the ~500 MB threshold below should drop accordingly. The model has not been refitted against the merged loop — do that in M1 task 5 before wiring the progress bar.

**(c) `close()` may be copying rather than renaming — still unrun.** It scales proportionally at ~734 MB/s, about the cost of reading and rewriting the same bytes on NVMe. If Chrome copies the `.crswap` file into place instead of moving it, every exported byte is written twice. This no longer matters much for *timing* — the empirical model already absorbs it — but it matters for the **failure mode**: a copy-on-commit means a 10 GB export transiently needs 20 GB free, and the failure surfaces during finalising, after the user has waited. Worth a two-minute directory listing during an export before task 5 designs its error states.

**Progress UI consequence.** `close()` runs strictly after the last mdat byte is written, so a naive bar reaches 100% and then hangs. Reserve a distinct finalising phase above ~500 MB of output:

| Output | Finalising phase |
|---|---|
| 10 MB | ~27 ms — invisible |
| 200 MB | ~300 ms |
| 1 GB | ~1.4 s |
| 4 GB | ~5.5 s |

Use `total_ms` for the ETA and the `copy_ms` / `close_ms` split to place the phase boundary. Multiply by ~1.12 for a cold-cache-safe estimate rather than exposing cache state as a UI concept.


## 3. Scrub: unify the cache with the filmstrip

The feasibility document validated a 2fps / 5-minute frame cache: 60 Hz drag, ~100× latency margin. That works. But it costs **27.1 seconds to build**, because filling 600 slots at 2fps required decoding 18,210 frames — every frame in the window, since 2fps sample points don't land on keyframes. And it leaves scrubbing outside the cached window undesigned, which on a 70-minute recording is 93% of the timeline.

There's a much cheaper cache available, and you already generate it.

**Sample the cache at keyframes, not at 2fps.** Keyframes decode independently — no dependency chain, no intervening frames. For this footage:

| | 2fps cache | Keyframe cache |
|---|---|---|
| Frames decoded per 5-min window | 18,210 | 72 |
| Decode cost | 27.1 s | ~0.5 s at 150/sec |
| Whole 70-min file | ~6.3 minutes | **~7 seconds** (1,015 keyframes) |
| Temporal resolution | 0.5 s | 4.17 s |

The whole file caches in about seven seconds. The "outside the window" problem disappears entirely, because there is no window.

Is 4.17-second resolution enough for a drag? At full-file zoom on a 1400px timeline, 4.17 s is roughly 5 px — finer than the pointer. It's more than enough. Resolution only becomes inadequate when zoomed in past roughly one keyframe per 40 px, at which point you build a dense secondary cache **around the viewport only**, using the 2fps approach that's already validated.

And the payoff: **this cache is the filmstrip.** Same source frames, same decode pass, same atlas storage. One subsystem produces both the timeline thumbnails and the scrub preview. That's a genuine simplification, not just an optimisation.

Resulting scrub model:

```
pointerdown  → freeze <video>, switch preview to cache-backed rendering
pointermove  → nearest cached frame → draw to preview canvas    [~0 ms]
pointerup    → single real <video> seek to the exact time       [~220 ms, once]
```

`<video>`'s 220 ms seek is fine when it happens once per drag instead of sixty times per second.

**Two-tier cache spec:**

| Tier | Coverage | Spacing | Size | Built |
|---|---|---|---|---|
| Coarse | whole file | every keyframe (~4.2 s) | 160×90 | eagerly at open, ~7 s |
| Dense | ±30 s around viewport | 2 fps | 320×180 | on zoom past threshold, background |

Memory: 1,015 coarse frames at 160×90 RGBA is ~58 MB as live `ImageBitmap`s. Keep only the visible span plus margin live in a byte-budgeted LRU that calls `.close()` on eviction; the rest live as WebP atlases in OPFS. Per the atlas finding, **decode each atlas once per session and crop many tiles from the resulting bitmap** — `createImageBitmap(file, sx, sy, sw, sh)` decodes the entire atlas internally at 23.81 ms per call, so per-tile calls are catastrophic in a filmstrip.

---

## 4. Multi-track audio is a requirement

The fixture has **7 tracks** — 1 video and 6 audio, which is ordinary for OBS (separate mic, desktop, application, and mixed tracks). v1 assumed one of each. That was wrong, and it touches three subsystems:

- **Index:** already builds per-track and handled it fine. No change.
- **Remux:** must select which tracks to carry, rewrite each track's tables in its own media timescale, and interleave all selected tracks in ~1-second groups. Carrying all six audio tracks bloats output for no benefit; carrying only the first may silently drop the user's microphone.
- **UI:** a track selection control in the export flow. Default: video plus the first audio track, with the rest listed and toggleable. Show each track's language/handler name and duration so the choice is informed.

This also affects the design brief — the export dialog now needs a track list, which the current design doesn't have.

---

## 5. Revised subsystem decisions

### 5.1 Container parsing — in-house, mediabunny as oracle

v1 recommended mediabunny as the engine. M0.5 found three real bugs in it: memory ballooning in the default `BlobSource` mode, an unbounded keyframe walk that crashed the browser at scale, and a systematic ~33 ms edit-list offset error. Meanwhile the hand-rolled parser built for spikes A and B is fast, correct against every cross-check, and already handles the 64-bit largesize case that a real file exposed.

**Decision:** the in-house ISOBMFF parser is the production path. Keep mediabunny in `devDependencies` as a differential-testing oracle — running both and comparing is how the parser earned confidence, and it should stay in CI. This inverts v1's recommendation but leaves the door open: if you later need MKV or WebM, mediabunny's demuxers are still the fastest way there.

### 5.2 Cross-origin isolation — enable it

v1 argued against COOP/COEP because they were only needed for ffmpeg.wasm's threaded build, which is now a distant tier-4 fallback. But the app loads no third-party subresources, so isolation costs nothing, and it buys two things: `SharedArrayBuffer` (9.03 ms to share the index with two workers, versus 25.34 ms to transfer to one) and `performance.measureUserAgentSpecificMemory()`, without which you have no memory visibility at all.

Set `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`.

Caveat carried from the gaps section: **JS-level memory APIs systematically undercount** `ArrayBuffer` and GPU-backed storage. Hardware-decoded frames on macOS live in `VTDecoderXPCService`, entirely outside Chrome's process tree, so they don't appear in Chrome's own task manager either. Any memory claim needs an OS-level cross-check.

### 5.3 Frame lifecycle — enforce it structurally

The leak test is worse news than v1 assumed. v1 predicted the decoder would stall, which would at least be a loud failure. It doesn't: memory grows linearly at 11–13 MB/frame with **zero errors thrown**, all the way to 9.3 GB. There is no runtime safety net and no signal until the OS intervenes.

**Decision:** no raw `VideoFrame` may escape the function that creates it. Wrap every decoder output in a scope-bound helper that closes in `finally`, and in dev builds maintain a registry that asserts on any frame alive past its expected lifetime. This is cheap to build now and nearly impossible to retrofit.

### 5.4 Export write — guard against the abort hazard

Abort leaving a clean 0-byte file is excellent behaviour: nothing partial ever reaches disk. But note the consequence — if the user targets an **existing** file and then cancels, that file is now 0 bytes. `createWritable()` defaults to `keepExistingData: false`, so the original content is gone.

**Decision:** write to a temporary name in the chosen directory and rename on successful close, or at minimum warn explicitly before overwriting an existing file. This is a data-loss bug waiting to be reported.

### 5.5 Decode batching

Batch **16 `decode()` calls per `flush()`**. This was the single highest-leverage finding in spike C — 3.6× throughput, and it came from amortising flush cost, not from I/O. Coalesced reads barely moved the number. Bake it into the decoder wrapper so no call site has to remember.

Note the underlying mechanism, because it explains why the warm-decoder idea failed: `flush()` resets the decoder's key-frame-required flag, so flushing to check progress forces a keyframe restart on the next decode. Never flush speculatively.

---

## 6. M1 build plan

M1 is the walking skeleton: open a file, scrub it, set in and out, export a real clip. Roughly five weeks.

**Task 0 — done, with three follow-ups.** (1 day)
The fixed-cost hypothesis was disproved; see §2 for the measured model. Remaining: (a) verify where spike A's timer started, to explain the 9× discrepancy rather than leaving it as noise; (b) confirm the per-track read amplification and, if present, restructure the copy loop as a single merged read pass — this is a structural decision that must land before task 5, not after; (c) observe the `.crswap` file during an export to determine whether `close()` copies or renames.

**Task 1 — production parser and index.** (1 week)
Promote the spike parser out of `src/spikes/` into `src/media/index/`. Typed-array `SampleIndex`, per-track. OPFS caching keyed on size + `lastModified` + a hash of the first and last 1 MB. Differential test against mediabunny in CI. Resolve the 1-frame boundary discrepancy the ffmpeg comparison reported — a one-frame disagreement is either a real off-by-one in out-point selection or a defensible tolerance, and it should be understood rather than tolerated.

**Task 2 — playback and native engine.** (3 days)
`PlaybackEngine` port with `NativeVideoEngine`. Object URL, `requestVideoFrameCallback` playhead sync, seek coalescing with a single pending target, frame stepping off the real PTS list.

**Task 3 — coarse frame cache.** (1 week)
Keyframe decode in a worker pool, batched 16-per-flush, RAII frame wrapper, WebP atlases in OPFS, one decode per atlas per session with in-memory cropping, byte-budgeted LRU. This is the subsystem that serves both the filmstrip and the scrub.

**Task 4 — timeline.** (1 week)
Canvas layer stack, viewport transform in rational time, zoom anchored at cursor, keyframe ticks, in/out handles with snapping, playhead on `rVFC`. Cache-backed scrub per §3.

**Task 5 — export.** (1 week)
`RemuxStrategy` from the spike code, promoted and hardened, with the copy loop restructured as a single merged read pass across tracks (§2b). Track selection UI. Temp-name-and-rename write. Progress driven by the measured `copy_ms` / `close_ms` model with an explicit finalising phase above ~500 MB. Cancel.

**M1 exit criteria:**
- Trim a 30-second clip from the 27 GB fixture; output plays in VLC, QuickTime, and Chrome
- Peak process memory under 500 MB measured at the OS level, not via JS APIs
- Drag-scrub sustains 60 Hz across the full timeline after the coarse cache is warm
- Coarse cache for the whole 27 GB file completes in under 15 s
- Multi-track audio selection works; exporting only the mic track produces a valid file
- Cancelling an export never damages an existing file

---

## 7. Roadmap beyond M1

Largely unchanged from v1, with one reordering.

**M2 — timeline polish** (3 weeks). Dense secondary cache on zoom, waveform, drop-frame timecode, full keyboard map, `?` overlay.

**M3 — frame accuracy** (4 weeks). Smart render for exact in-points. The measured 4.17 s GOP makes this more valuable than v1 assumed — a cut landing four seconds early is very visible. Note that the multi-resolution export feature was considered and dropped, so this is now the *only* re-encode path in the product, and the WebCodecs encoder plumbing exists solely to serve it.

**M4 — hardening** (3 weeks). Capability detection, degradation paths, the stress matrix (VFR, rotated, HDR, 8-hour, B-frame-heavy), lower-spec hardware baseline. **Every number in this document comes from one M1 Max with fast NVMe** — the export throughput and cache build times in particular will degrade roughly with storage bandwidth and decode capability, and a machine without hardware H.264 decode was measured 4× slower.

**M5 — editor foundations** (6 weeks). Multi-clip EDL, undo/redo, batch trimming, metadata inspector.

**M6 — multi-track video.** Open-ended.

---

## 8. Carried forward unchanged from v1

These held up and need no revision: the three-tier export model (remux → smart render → transcode, with ffmpeg.wasm as a lazily-loaded tier-4 escape hatch); `<video>` plus object URL as the playback engine; MediaSource stays out until multi-clip; OPFS for derived data only, never a copy of the source; the folder structure and the rule that `domain/` imports nothing browser-shaped; Chromium-first with graceful degradation, and Safari/Firefox as second-class targets since neither can stream an export to disk.
