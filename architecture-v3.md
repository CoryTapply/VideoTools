# Architecture v3

**Supersedes:** `architecture-v2.md`
**Basis:** M0/M0.5 spikes plus M1 tasks 1–3, all measured against a 27 GB / 70-minute OBS recording on an M1 Max, Chrome 151
**Status:** M1 half built. Tasks 4 and 5 remain.

Read `PROJECT-CONTEXT.md` first if you're new. Per-module `README.md` files are authoritative for their own module; this document is the system view.

---

## 0. What changed since v2

| # | v2 said | v3 says | Driver |
|---|---|---|---|
| 1 | Canonical time base unresolved | **Presentation time** (edit-adjusted), integer ticks in the primary video track's timescale | Task 2 Part 1: rVFC `mediaTime` matched presentation-native queries to 0.0000 s at all 8 test points; raw ticks diverged by a constant 0.016 s |
| 2 | Enable cross-origin isolation for SAB index sharing | COI still on, but **SAB is not needed at the decode-worker boundary** | Task 3: decode workers need byte ranges, not query capability. They get plain job descriptors and their own `FileByteSource` clone |
| 3 | Coarse cache ~7 s estimated | **5.19 s measured** for 1,015 keyframes | Task 3, 2 workers at 195.5/sec |
| 4 | Eviction budget 96 MB proposed | **Unvalidated — real cost is ~2× the estimate** | Task 3 Part B: coarse warm costs +121 MB real vs 58 MB naive |
| 5 | Worker pool scales with core count | **Decode-bound, not worker-bound** | Doubling workers gave 1.3×, not 2× (150.4 → 195.5/sec) |

Everything else in v2 held.

---

## 1. System shape

```
┌─ MAIN THREAD ────────────────────────────────────────────────┐
│  React shell            <video>            Timeline canvas    │
│  (task 4a)              NativeVideoEngine  (task 4b)          │
│                         ✔ built            │                  │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ Document state · command stack · viewport                │ │
│  │ (task 4a)                                                 │ │
│  └──────────────────────────────────────────────────────────┘ │
│  SampleIndex ✔    FrameCache ✔    ExportStrategy (task 5)     │
└──────────────────────────┬───────────────────────────────────┘
                           │ job descriptors, transferables
┌──────────────────────────┴───────────────────────────────────┐
│  WORKERS                                                      │
│  index.worker ✔        frame decode pool ✔ (2–4)             │
│  export.worker (task 5)                                       │
└──────────────────────────┬───────────────────────────────────┘
┌──────────────────────────┴───────────────────────────────────┐
│  STORAGE                                                      │
│  Source File (lazy slices, never copied)                      │
│  OPFS: index cache · thumbnail atlases                        │
│  FileSystemWritableFileStream (export output)                 │
└───────────────────────────────────────────────────────────────┘

SIDE CHANNEL: <video src=blob:> — browser demux + hardware decode.
Zero JS memory. Preview never flows through the pipeline above.
```

---

## 2. Time

**Presentation time is canonical.** Integer ticks in the primary video track's timescale. Never float seconds, never raw media time outside the index module.

The 27 GB fixture's video track has an edit offset of 1,440 ticks at timescale 90,000 — exactly 0.016 s. That is under one frame at 59.94 fps, which is precisely why it would have gone unnoticed: every trim point, keyframe tick and frame step would have been consistently wrong by an amount that reads as a rounding bug.

`SampleIndex` exposes a presentation-native query surface (`frameAtPresentationTime`, `nearestSyncAtOrBeforePresentation`, `keyframePresentationTimes`, `presentationRank`, `sampleAtPresentationRank`). Raw-tick methods remain because the remux rewrites sample tables in media time and must reproduce or adjust the `elst` on output. **Call sites outside `src/media/index/` use the presentation-native methods exclusively.**

Frame stepping steps in *presentation order*. `pts[n + delta]` on a decode-order index is wrong the moment a track has B-frames.

---

## 3. Subsystem status

### 3.1 Index — `src/media/index/` ✔ built

Typed-array `TrackIndex` per track; `SampleIndex` query API; `IndexError` discriminated union returned as a value; fMP4 and encrypted detection; OPFS cache keyed on fingerprint plus schema version; worker wrapper.

`ByteSource` port keeps the whole parsing core Node-testable — only four files touch DOM types. Differential-tested against mediabunny and the original spike parser, including against a real VFR fixture.

1.44M samples across 7 tracks in 110–165 ms, 41.8 MB retained, 27.24 MB read.

### 3.2 Playback — `src/media/playback/` ✔ built

`PlaybackEngine` port with `NativeVideoEngine`. Object URL, rVFC playhead sync with honest rAF fallback, explicit state machine, codec check via `canPlayType` producing a *recoverable* unsupported-codec state — a source the browser can't preview can still be trimmed.

Seek coalescing holds one pending target. The correctness property is convergence: intermediate seeks are dropped by design, the final one never is. Verified 20/20 across 200-seek bursts.

`VideoElementLike` + `FakeVideoElement` seam, with the fake self-tested.

### 3.3 Frame cache — `src/media/frames/` ✔ built

Serves the filmstrip *and* the scrub preview from one decode pass. Two tiers:

| Tier | Coverage | Spacing | Size | Built |
|---|---|---|---|---|
| Coarse | whole file | every keyframe (~4.17 s) | 160×90 | eagerly, 5.19 s |
| Dense | ±30 s of viewport | 2 fps | 320×180 | lazily past a zoom threshold |

`getNearest()` is a zero-allocation binary search across both tiers — p50 0.000 ms, max 0.040 ms. It is called at 60 Hz inside a pointermove handler and must never trigger async work. That constraint is why coarse is built eagerly.

Decode batches 16 per flush, and **never splits a decode chain across a flush** — `flush()` resets the key-frame-required flag. Coarse keyframes are independent and batch freely; dense windows are one continuous chain and are atomic.

Atlases: 100 tiles per WebP, decoded **once per atlas per session** then cropped from the in-memory bitmap. Measured 23.4 ms per `createImageBitmap` against an atlas blob regardless of crop size, so per-tile calls would cost ~950 ms per filmstrip repaint.

### 3.4 Timeline — task 4b, not built

Canvas layer stack. Rendering, hit-testing, zoom and pan in a rational-time viewport transform. Draws the filmstrip from `getRange()`, keyframe ticks from `keyframePresentationTimes()`, playhead from the engine's `onFrame`.

**Not DOM.** A four-hour 60 fps source has 862,401 frames.

### 3.5 Export — task 5, not built

`RemuxStrategy` promoted from spike A, with the merged single-pass copy loop. Track selection. Temp-name-and-rename write. Progress driven by the measured model with an explicit finalising phase.

**Must use `query.ts`'s `sampleRange`, not port `select.ts`.** The spike's out-point selection does a decode-order forward scan, which diverges from presentation-order selection under B-frame reordering. That divergence was the 1-frame discrepancy, and promotion is exactly where it would sneak back in.

---

## 4. Open issues

### 4.1 The eviction budget is undersized — and may be causing silent filmstrip loss

`DEFAULT_BUDGET_BYTES` is 96 MB, calibrated against a naive 58 MB RGBA estimate for the coarse tier. Real measured coarse-warm cost is **+121 MB** — roughly 2×, from GPU texture padding, alignment, and driver overhead that JS arithmetic can't see.

Task 3 also recorded an anomaly: dense-warm measured 210 MB against coarse-warm's 295 MB, an 85 MB *drop* where adding a tier should only add. The writeup attributes this to transient buffers settling between checkpoints.

**A more likely explanation is that the LRU was working correctly and evicting the coarse tier to make room for dense.** Coarse at ~58 MB naive fits the 96 MB budget alone; adding a dense window at spike C's 600-frame configuration (~132 MB naive) pushes the total to ~190 MB, requiring ~94 MB of eviction — close to the 85 MB observed.

If that's what happened, the consequence is a real bug rather than a measurement artefact: **zooming in evicts the filmstrip**, and zooming back out leaves it partly empty with a 5.2-second re-warm. In task 4 this would present as a timeline bug and be diagnosed in the wrong module.

**Resolve before task 4b.** Log the LRU's eviction count and `liveCount` at each memory checkpoint and repeat the run. If evictions are non-zero at dense-warm, the fix is a protected reservation for the coarse tier rather than one undifferentiated pool — the coarse tier is the scrub source and must not be evictable by a transient dense window.

### 4.2 Atlas packing is a third of the coarse warm

WebP encoding measured ~157 ms per atlas, 11 atlases per coarse warm — about 1.7 s of the 5.19 s total. OPFS write and read are negligible by comparison (~3.8 ms and ~0.85 ms per atlas).

Packing exists to make the *second* open of a file fast. It doesn't need to be on the critical path of the first. Consider deferring packing until the coarse tier is fully resident and the UI is interactive.

### 4.3 Carried forward

- **Post-load seek accuracy.** Accurate seeks occasionally land one frame off after heavy decoder activity. Watch for it in task 4b's scrub-settle: coarse cache warm, drag, release, and see whether the preview jumps.
- **Index build-time delta.** 107 ms spike vs 165 ms production, same browser, unprofiled.
- **`.crswap` copy-vs-rename.** Never observed. Determines whether a 10 GB export transiently needs 20 GB free — a disk-full failure arriving during finalising, which task 5 must handle.
- **HEVC codec strings** untested against a real HEVC file.
- **Dense-tier kept-frame count** isn't reported alongside the 1.61 s build time, which makes that number hard to interpret. Worth adding to the harness output.

---

## 5. Constants for tasks 4 and 5

```
time base            presentation ticks, primary video track timescale
GOP (real, OBS)      4.166 s constant — cut shift is up to ~4.2 s, not sub-second
coarse spacing       every keyframe, ~4.17 s, 160×90
dense spacing        2 fps, 320×180, ±30 s, past ~1 keyframe per 40 px
getNearest budget    must stay under ~1 ms; measured 0.040 ms max
seek (settle only)   p50 281.6 ms — never in a drag loop
export copy          merged single read pass, 4 MB window, 1.00× amplification
export progress      copy_ms and close_ms split; finalising phase is now
                     ~40–50% of total since copy got 1.7–3× faster
worker count         2, capped min(4, hardwareConcurrency/2) — decode-bound
```

---

## 6. Unchanged from v2

The three-tier export model (remux → smart render → transcode, ffmpeg.wasm as tier-4 escape hatch). `<video>` plus object URL for preview. MediaSource stays out until multi-clip. OPFS for derived data only, never a copy of the source. `domain/` imports nothing browser-shaped. Chromium-first, with Safari and Firefox as view-and-small-export targets since neither can stream an export to disk. Multi-track audio is a first-class requirement — the fixture has 7 tracks.
