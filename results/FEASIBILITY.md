# M0.5 Feasibility Synthesis

Source: spikes A (remux + streamed write), B (index at scale), C (WebCodecs scrub +
thumbnails), all run against the real 27GB OBS fixture (and `longgop.mp4` /
`vfr-screen.mp4` where noted), per `prompts/m0.5-spike-prompts.md`. All numbers below
are real measurements taken during this work — reported in-browser (Chrome) unless
otherwise noted — not synthetic estimates, except where explicitly labeled
"extrapolated."

No `results/*.json` records or `M0-FINDINGS.md` existed prior to this document. Most
numbers were pulled directly from the session's real browser output and cross-checked
against the raw transcript; several Spike A numbers came from structured JSON records
already saved to `fixtures/A-remux_*.json` by the harness, discovered mid-write when a
gap in this document turned out to already have real data behind it. None of it was
backfilled from memory.

## Executive summary

- **Spike A (remux + streamed export): GO.** Every fail condition — throughput, export
  heap growth, abort behavior, the write-side 64-bit largesize path, all 3 required
  export ranges, playback in VLC/QuickTime/Chrome — is confirmed clean with real data.
  **Correction (see `results/T0-EXPORT-COST.md` / `T0-FOLLOWUP.md`):** the throughput
  table below was originally read as "scales with export size, small trims are slow."
  A controlled follow-up diagnosis (3MB–4GB, 5 source positions, warm/cold cache) found
  the opposite: throughput is flat at **~178MB/s** with a ~13ms fixed cost, comfortably
  clearing the 100MB/s bar at every size. The one small-trim data point that looked slow
  (166MB last-frame, 18.77MB/s) does not reproduce and is now attributed to transient
  system load, not export size — see below and §5.
- **Spike B (index at scale): GO, no caveats.** Zero correctness mismatches against an
  independent reference implementation. Every quantitative bar (build time, memory,
  query latency) clears with 3–47x margin.
- **Spike C (WebCodecs scrub + thumbnails): GO-WITH-CHANGES — one required architecture
  change.** On-demand frame decode (cold or kept warm across a drag) does not work: it
  fails the spec's own stated bar for scrub latency. The fix is a different design, not
  a tuning problem — pre-decode a sparse frame cache and serve scrub drags from lookups
  instead of live decode. That design was built and tested here and works decisively
  (60Hz sustained, ~100x latency margin). Everything else in Spike C (filmstrip
  thumbnails, index integration) passes cleanly.
- **Bottom line: M1 can proceed.** The only required change from the original
  architecture is the scrub interaction, which needs to be built on the pre-decoded
  cache design validated in this document, not on-demand decode. See §3 for the full
  list of design changes and §4 for concrete constants to build against.

## 1. Headline table

| Metric | Result | Fail bar | Status |
|---|---|---|---|
| Index build time (27GB, 1,442,030 samples / 7 tracks) | 107.1ms | ≤5s | **PASS** (47x margin) |
| Index retained bytes (27GB, all tracks) | 41.82MB (41,818,870 B) | ≤150MB | **PASS** |
| Extrapolated 8hr/60fps (~1.7M samples) retained/build | ~49MB / ~114ms | ≤400MB / — | **PASS** (extrapolated) |
| Remux export throughput, 1.1–1.3GB near-start range (5 runs) | 91.1–92.0 MB/s | ≥100MB/s | **SUPERSEDED** — see below |
| Remux export throughput, 166MB last-frame range | 18.77 MB/s | ≥100MB/s | **RETRACTED** — see below |
| Remux export throughput, 10.39GB mid-file range (2 runs) | 134.9–163.0 MB/s | ≥100MB/s | **PASS** (35–63% margin) |
| **Remux export throughput, controlled re-test (T0: 3MB–4GB, 5 positions)** | **~178MB/s flat, ~13ms fixed cost** | ≥100MB/s | **PASS** (78% margin, every size) |
| Export JS heap growth (5 real runs, 1MB/4MB/16MB windows) | peak growth 2.0–13.7MB, returns to baseline after close | ≤100MB growth | **PASS** (7–50x margin) |
| Abort-mid-export result (real run, 1620s mid-file range) | target left as real, unlocked, 0-byte file — never truncated | no truncated/locked file | **PASS** |
| Keyframe decode rate, 27GB, sequential | 42.2–42.5/sec | ≥50/sec | **FAIL** |
| Keyframe decode rate, 27GB, batched (16) | 150.4/sec | ≥50/sec | **PASS** (3x margin) |
| Keyframe decode rate, longgop.mp4, sequential | 178.0/sec | ≥50/sec | **PASS** |
| Keyframe decode rate, longgop.mp4, batched (16) | 648.8/sec | ≥50/sec | **PASS** |
| Real keyframe interval, 27GB | 4.166–4.167s (constant) | — | matches M0's ~4.2s estimate |
| Real keyframe interval, longgop.mp4 | 10.000s (constant) | — | — |
| Arbitrary-frame latency vs `<video>`, 27GB (cold-start) | WebCodecs p50=270ms vs `<video>` p50=281ms | beat `<video>` | **MARGINAL** (~4%, within noise) |
| Arbitrary-frame latency vs `<video>`, longgop.mp4 | WebCodecs p50=53ms vs `<video>` p50=49ms | beat `<video>` | **FAIL** (WebCodecs slower) |
| Warm-decoder forward scrub, stops arriving before trailing flush | hardware 0/29, software 1/29 | make sequential scrubbing cheap | **FAIL** |
| Cache-backed scrub, 60Hz drag sustainability | p50=0.00ms p95=0.01ms max=0.17ms | sustain 60Hz | **PASS** (~100x margin) |
| Cache build time (2fps, 5-min window, 600 slots) | 27.1s (18,210 frames decoded) | not stated numerically | real, non-trivial cost |
| Query latency (10k iters, 4 query types) | 61.5–352.0 ns/op | ≤1000ns (~1μs) | **PASS** (3–16x margin) |
| Worker index transfer (253,544-sample track) | transferables 25.34ms (1 worker) / SharedArrayBuffer 9.03ms (2 workers) | — | SAB faster despite serving more workers |
| OPFS index cache vs. rebuild-from-file (253,544-sample track) | 4.86ms vs. 110.26ms | — | **22.7x faster**, worth caching |
| Thumbnail atlas (10x10, WebP q0.6) | 391,160 B, encode 148.7ms, OPFS write 1.4ms, single-thumb read+decode 23.81ms | — | works; see gap note on per-tile decode cost |
| Leak test (no `frame.close()`) | ~11–13MB/frame linear growth, 0 errors thrown up to 800 frames / 9.3GB | — | no internal safety net |
| Mediabunny correctness cross-check (27GB + vfr-screen.mp4) | 0 mismatches | any mismatch fails | **PASS** (after 3 real bugs fixed) |

## 2. Per-spike verdict

### Spike A — remux + streamed write: **GO**

Correctness and index-build cost are excellent, and the core remux pipeline produces
structurally-correct output (frame count matches the ffmpeg reference exactly on the
last-frame range and within a 1-frame boundary tolerance elsewhere, clean multi-track
A/V sync, zero decode errors, confirmed via `scripts/compare-remux.sh`). Every gap
originally flagged against this spike has since closed with real data:

- **Retracted: export throughput does not scale with export size.** This spike's original
  three-point read (91.1–92.0MB/s near-start, 18.77MB/s on a tiny 166MB last-frame clip,
  134.9–163.0MB/s on a 10.39GB mid-file export) was interpreted as "throughput scales
  with size, small exports pay a fixed toll." A dedicated follow-up diagnosis
  (`results/T0-EXPORT-COST.md`, `results/T0-FOLLOWUP.md`) deliberately decoupled size,
  source position, and cache state — the three things those three original points varied
  on simultaneously — and found none of them drives a meaningful difference: throughput
  is flat at **~178MB/s with a ~13ms fixed cost**, holding from 3MB to 4GB and across all
  5 source positions tested (R² effectively 1). The per-sample-read/write history (37.0
  → 56.6 → 91.1MB/s via 4MB coalescing) is real and still the correct account of *that*
  optimization. What's retracted is the "small exports are throughput-constrained"
  conclusion drawn from the 166MB/18.77MB/s point: that number does not reproduce (a
  controlled re-test of the identical byte range got 176.6MB/s, the fastest of 5
  positions tried), and is now attributed to transient system load — that run started
  ~11 minutes after two other exports moved a combined 12GB+ through the same pipeline —
  not to output size. Full analysis in `T0-FOLLOWUP.md` item 1. **Net: the 100MB/s bar
  is met at every size, not just multi-GB exports**, and progress estimation should use
  T0's flat-rate model (§4), not a size-dependent one.
- JS heap growth during export was measured across 5 real runs (peak growth 2.0–13.7MB,
  always returning to baseline after close): a clean pass with 7–50x margin against the
  ~100MB fail bar.
- Abort-mid-export behavior is now confirmed in a real run (1620s mid-file range,
  aborted partway through pass 2): the target is left as a real, unlocked, exactly
  0-byte file — never truncated with partial content, matching the transactional
  File System Access API write model (all buffered writes are discarded atomically on
  `abort()`, regardless of how far into the write it happens).
- VLC, QuickTime Player, and Chrome playback all confirmed directly by the user on both
  the mid-file and last-frame exports.
- The write-side 64-bit `largesize` path is confirmed correct on a real >4.29GB export:
  the 10.39GB mid-file output's `mdat` box header was directly inspected (`size32=1`,
  `size64=10,388,027,510`), and `ftyp+moov+mdat` sums to the exact file size on disk.
- All 3 required export ranges (near-start, mid-file, last-frame) have a full
  ffprobe/ffmpeg structural comparison passing, plus (mid-file) reproducible exports,
  confirmed playback in all 3 players, and a directly-verified `mdat` header.

### Spike B — index at scale: **GO**

Zero mismatches against mediabunny on both the 27GB file and `vfr-screen.mp4`, after
fixing three real bugs found during this work (a severe Chrome memory-ballooning bug in
mediabunny's default `BlobSource` mode, an unbounded keyframe/metadata walk that crashed
the browser at scale, and a systematic ~33ms edit-list offset bug). Every quantitative
fail condition clears with large margin: build time 107.1ms (47x under the 5s bar),
retained bytes 41.82MB (3.6x under the 150MB bar), and all 4 query types 61.5–352.0ns/op
(3–16x under the 1μs bar). No caveats.

### Spike C — WebCodecs scrub + thumbnails: **GO-WITH-CHANGES** (architecture pivot required)

The originally-envisioned scrub architecture — arbitrary on-demand WebCodecs decode,
optionally kept warm across a drag — **fails the spec's own explicit fail condition**:
arbitrary-frame latency doesn't clearly beat `<video>` (a ~4% win within noise on the
27GB file, an outright loss on `longgop.mp4`), **and** warm-decoder forward scrubbing
fails to help (0/29 and 1/29 stops actually benefited from staying warm). The root
cause: `flush()` — required to get *any* output from this decoder at all — resets the
decoder's internal "key frame required" flag, so periodically flushing to check on a
scrub target's progress forces a keyframe-restart-equivalent cost on the very next
decode, defeating warmth before it can be measured. Per the spec's own words, this
combination "means the scrub design needs rethinking entirely."

The pivot — a pre-decoded 2fps cache serving lookups instead of on-demand decode — is
the actual answer, and it works decisively: 60Hz sustained with roughly two orders of
magnitude of latency margin (p50=0.00ms against a 16.67ms budget). This should be the
scrub architecture for M1, not on-demand decode. Keyframe throughput (the filmstrip
path, a separate and simpler use case than scrubbing) passes cleanly once batched
(150.4–648.8/sec vs. the 50/sec bar, a fix that came from amortizing `flush()` cost, not
from faster I/O — coalesced reads alone barely moved the number). The leak test and
thumbnail atlas both completed with real, actionable findings.

## 3. Design changes required

- **Drag-to-scrub via on-demand WebCodecs decode is not viable, warm or cold.** The
  interaction must change to: pre-decode a sparse cache (2fps / 5-minute window, the
  spec's own tested config) and serve drag events from cache lookups, never decoding
  live during a drag. This is a real, working architecture, but it means the product
  cannot promise frame-accurate scrubbing at *every* timeline position — only positions
  within a pre-built cache window. Scrubbing far outside a cached window (e.g., a
  multi-hour recording, cache limited to a 5-minute span) needs its own fallback
  behavior (rebuild the cache around the new position, show a loading state, etc.) —
  not designed or tested here.
- **The index does not need to be chunked or lazily built** at the tested scale (27GB /
  1.44M total samples / 253,544 video samples) — 107.1ms build time is nowhere near a UX
  problem, and even the extrapolated 8hr/60fps case (~1.7M samples, ~114ms) stays
  comfortably under the fail bar. Chunked/lazy building would solve a problem that
  doesn't exist at these scales; don't build it speculatively.
- **The real-world GOP length (~4.2s on OBS footage)**, confirmed independently by both
  M0 and this session's direct measurement (4.166–4.167s, constant), means the
  keyframe-shift UI must clearly communicate potentially multi-second shifts when
  snapping a trim in-point to the preceding keyframe. Spike C's arbitrary-frame-latency
  numbers make concrete *why* that snap exists: a cold-start decode chain averages ~146
  frames (up to ~234) on this footage, which is the direct cost driver behind both the
  latency numbers and the decision to snap to keyframes rather than decode arbitrary
  frames on the fly.
- **Faststart output in one pass is affordable at every tested size, not just large
  exports.** Pass-1 (moov build) time scales with sample count, not a flat constant
  (~0.5ms at 3MB up to ~674ms at 4GB in the T0 re-test — still under 3% of total time
  even at the largest size). Throughput is **flat, not size-dependent**: ~178MB/s with a
  ~13ms fixed cost, holding from 3MB to 4GB (see the retraction note in §2 and
  `T0-EXPORT-COST.md`) — comfortably clearing the spec's 100MB/s bar everywhere, small
  trims included. **Fixed since (`T0-FOLLOWUP.md` item 3):** the copy loop originally read
  ~6.5x more bytes than it wrote on this 7-track fixture — a per-track-pass read pattern,
  each track independently re-reading the same physically-interleaved source region. A
  merged single-pass copy loop (source-offset order across all tracks, output
  interleaving follows source interleaving, no reordering buffer) cuts that to 1.00x and
  total export time by 1.2–1.9x depending on size, with no correctness regression
  (re-validated against the same bar as the original Spike A validation) and no unbounded
  memory growth. This is now the exported functions `buildMoovMerged` /
  `forEachWindowMerged` in `remux-write.ts`, additive alongside the original
  `buildMoov`/`forEachWindowCoalesced` (untouched, still what Spike A's own UI calls).
  Pipelining reads and writes on top of this is still the next lever if more is needed
  (both tested window sizes above 4MB plateaued, so it isn't bigger buffers either way).

## 4. Constants for M1

- **Read/write coalescing window: 4MB.** Settled after testing 1MB (80.5MB/s), 4MB
  (91.1MB/s), 16MB (92.0MB/s, no further gain) on a real ~1.05GB export range.
- **Thumbnail decode batching: 16 `decode()` calls per `flush()`.** 3.6x throughput over
  fully-sequential decoding (which flushes after every frame), clearing the ~50/sec bar
  by 3x on both test files. This is the single highest-leverage fix found in Spike C.
- **Index cache strategy: cache to OPFS.** Read-back (4.86ms) is 22.7x faster than
  rebuilding from the source file (110.26ms) for a 253,544-sample track (7.35MB
  serialized) — an easy win for repeat-open scenarios.
- **Multi-worker index sharing: use `SharedArrayBuffer`, not per-worker transferable
  copies**, if more than one worker needs read access to the index — 9.03ms to 2 workers
  concurrently beat 25.34ms to a single worker via transferables in this test.
- **Scrub cache: two tiers, not a single 2fps/5-minute window.** Superseded by M1 Task 3
  (`src/media/frames/`, see its README.md) after this constant produced a real design
  problem: filling 600 slots at 2fps required decoding 18,210 frames — every frame in the
  window, a ~30:1 decode-to-keep ratio inherent to needing every intervening frame, not a
  bug — costing 27.1s per window, and on a 70-minute recording left 93% of the timeline
  uncached with no designed fallback for scrubbing there. The fix: sample at KEYFRAMES
  instead of a fixed frame rate, since keyframes decode independently with no dependency
  chain. On the 27GB fixture, 1,015 keyframes cover the ENTIRE file in ~6.7s at
  150.4/sec batched (vs. 27.1s for one 5-minute window at 2fps) — the "outside the
  window" problem disappears because there is no window.
  - **COARSE** — whole file, one entry per keyframe (~4.17s spacing on the 27GB
    fixture), 160x90. Built eagerly on open, target under 15s (resolution-dependent —
    longgop.mp4 measured 648.8/sec batched vs. 150.4/sec on the 4K fixture, so a flat
    15s target needs a resolution-aware estimate). This is the filmstrip AND the
    default scrub source: at full-file zoom on a ~1400px timeline, a 4.17s keyframe
    interval is about 5px, finer than the pointer, so coarse alone covers the large
    majority of scrubbing.
  - **DENSE** — +/-30s around the viewport, 2fps, 320x180 — spike C's originally
    validated path (60Hz sustained, ~100x latency margin), now scoped to build lazily
    and only when zoom exceeds roughly one keyframe per 40px, cancelled and rebuilt as
    the viewport moves, instead of being the only cache tier.
  - Both must build progressively / in the background, never as a blocking operation
    before first scrub — unchanged from the original guidance.
- **Expected export throughput for progress estimation: flat, not size-dependent.**
  Superseding this section's earlier size-scaled guidance (see the retraction in §2):
  `total_ms ≈ 13.2 + size_MB / 178.5`, holding from 3MB to 4GB and across all 5 source
  positions tested (R² effectively 1; see `results/T0-EXPORT-COST.md` §2). For a
  cold-cache-conservative estimate, multiply by ~1.12. `close()` itself is a real,
  separate, proportional-to-size phase (~25% of total, ~734MB/s) that runs strictly
  after all bytes are copied — the progress UI needs an explicit finalizing phase for
  exports above ~500MB (below that it's imperceptible), not a bar that reads 100% before
  the file is actually safely committed. Full model and per-size finalizing-phase
  durations in `T0-EXPORT-COST.md` §8–9. **Superseded for `copy` specifically** by the
  merged copy loop (`T0-FOLLOWUP.md` item 3c): `copy` is now 1.7–3x faster depending on
  size (a clean single-line refit wasn't done — see that section for the measured
  before/after table). `close` is unaffected by that change and its part of the model
  above still holds as-is.
- **Frame lifecycle discipline is entirely the caller's responsibility.** WebCodecs
  provides no backpressure or safety net for forgotten `frame.close()` calls (confirmed:
  linear ~11–13MB/frame growth with zero thrown errors up to 800 unclosed 4K frames /
  9.3GB). Any production code path handling `VideoFrame` objects needs rigorous,
  defensive `close()` discipline (try/finally, not just the happy path) — the runtime
  will not catch this class of bug.
- **Thumbnail atlas: decode once per session, crop many times from the resulting
  bitmap in memory.** `createImageBitmap(atlasFile, sx, sy, sw, sh)` decodes the *entire*
  atlas internally even for a single requested tile (23.81ms per call) — repeating that
  call per visible thumbnail in a filmstrip would cost far more than necessary.

## 5. Known gaps

Spike A originally had five open validation gaps (export heap growth, abort behavior,
all 3 required export ranges, VLC/QuickTime playback, and the write-side >4.29GB
`largesize` path). All five are now closed with real data — see §2's Spike A verdict
for the full detail on each. What's still genuinely open:

- **Spike C: the cache-backed scrub memory footprint** (item 3's "report the memory held
  by 600 cached ImageBitmaps") could only be estimated theoretically (~131.8MB raw
  RGBA), not measured — `performance.memory.usedJSHeapSize` does not count
  `ImageBitmap`'s GPU/native-backed storage in this Chrome build.
- **Methodology note, project-wide:** JS heap APIs (`performance.memory`,
  `measureUserAgentSpecificMemory`) systematically undercount memory held by
  ArrayBuffers/GPU-backed objects living outside the JS heap. This was independently
  rediscovered twice in this session — once during Spike B's mediabunny
  memory-ballooning investigation, once during Spike C's cache-scrub memory report — and
  once during the leak test, where hardware-decoded frames didn't show up in Chrome's
  own process list at all (macOS hardware decode runs through a system service,
  `VTDecoderXPCService`, entirely outside Chrome's process tree). Any future memory
  claim based on JS-level APIs alone should be cross-checked against OS-level Activity
  Monitor, and hardware-path memory claims specifically need the *system* process list,
  not just Chrome's.
- **All measurements come from one machine** (M1 Max, fast NVMe SSD, per the
  carried-forward M0 context) running Chrome. Numbers most likely to degrade on slower
  storage or weaker hardware:
  - **Remux export throughput (~178MB/s flat, per the T0 re-test — not size-dependent,
    see the §2 retraction)** — directly disk-I/O-bound, would scale down roughly with
    storage read/write bandwidth on a slower drive. T0 also found cold-vs-warm OS page
    cache is only a ~10-15% effect on this NVMe machine; that gap may be larger on
    slower storage and is worth re-checking if a target device differs significantly.
  - **Cache build time (27.1s for a 600-frame/5-min window)** — bound by decode
    throughput. Software decode was ~4x slower than hardware in this session's own
    measurements (9.8–9.9/sec vs. 42.2–42.5/sec on the 27GB file), so a machine without
    capable hardware H.264 decode would see this multiply accordingly.
  - **Keyframe/thumbnail decode throughput generally** — same hardware-vs-software gap
    applies to both the atlas and filmstrip paths.
  - **Index build time (107.1ms) and query latency (tens-to-hundreds of ns/op)** are
    CPU/memory-bound rather than disk-bound and should be comparatively
    storage-independent, though a slower CPU would still scale these up somewhat.
- **Launch-blocker assessment:** nothing here is launch-blocking. Spike A has no open
  items (see above). Spike C's memory-footprint gap is a measurement limitation, not a
  design risk — the cache-based scrub architecture it describes already works
  decisively on every metric that *was* measured (latency, hit rate, 60Hz
  sustainability). The single-machine caveat matters most for progress-estimate
  accuracy (export throughput, cache build time) on lower-end hardware, not for
  correctness.
