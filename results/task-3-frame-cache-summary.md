# M1 Task 3 — frame cache: summary

Status: implemented, tested (128 tests in `src/media/frames/`, all Node-runnable logic green:
`npm run typecheck`, `npm run lint`, `npm test` all clean project-wide), and **now confirmed
against a real browser run on `longgop.mp4`** — coarse build, `getNearest()`, dense build +
cancellation, atlas round-trip, and the 20-cycle leak check all pass with real, believable numbers
(see "Part 9 measurements" below). Three real WebCodecs integration bugs were found and fixed
along the way — the Node-only test suite could not have caught any of them, since Node has no
WebCodecs. **Still pending**: the same run against `fixtures/27gb.mp4` (the actual target fixture)
and the manual OS-level Activity Monitor memory checkpoints. See "What's still open" below.

This is a handoff/context summary for a future session. Full design rationale lives in
`src/media/frames/README.md`; this file is about what was built, what was decided, and what's
still open.

---

## What was built

New module at `src/media/frames/`, on top of Task 1's `src/media/index/` (presentation-native
`SampleIndex` queries, `ByteSource`, `computeFingerprint`) and mirroring Task 2's testability
pattern (`src/media/playback/`'s `VideoElementLike`/`FakeVideoElement`).

- **Frame lifecycle safety net** (`frame-lifecycle.ts`) — `withFrame`/`withFrameAsync` close a
  `Closable` (VideoFrame or ImageBitmap) in `finally`, so no raw decoder-output frame can escape
  its scope even on the error or cancellation path. `FrameLifecycleRegistry` is a plain,
  caller-held ledger (never a global) used both here and by the LRU, giving a real in-JS
  `liveCount` signal for leak checks.
- **`FrameDecoder` port** (`FrameDecoder.ts`, `RealFrameDecoder.ts`, `FakeFrameDecoder.ts`) —
  mirrors `VideoElementLike`. `RealFrameDecoder` ports spike C's hard-won WebCodecs findings
  (16-decode/flush batching, in-band SPS/PPS/SEI NAL stripping via `src/spikes/C-decode/nal-strip`,
  reject-all-pending on decoder error) rather than rediscovering them. `FakeFrameDecoder` has
  configurable latency/failure injection and its own self-test.
- **Worker pool** (`worker-pool.ts`, `worker.ts`, `worker-client.ts`, `worker-protocol.ts`) —
  `FrameWorkerPool`'s dispatch/cancellation logic is decoupled from any real `Worker` (tested
  against a fake `WorkerHandle`), so it's fully Node-testable. Real cancellation: a queued-but-
  undispatched job resolves cancelled immediately; an in-flight job's worker is told to stop and
  closes everything it was holding. `defaultWorkerCount`: starts at 2, caps at
  `min(4, hardwareConcurrency/2)`.
- **Atlas storage** (`atlas-layout.ts`, `atlas-pack.ts`, `atlas-cache.ts`) — 100 thumbnails/atlas,
  10x10 grid, WebP q60, OPFS-backed. Decode-once-per-atlas + canvas-crop (`atlas-pack.ts`) is the
  fix for spike C's 23.81ms-per-tile finding. Cache key folds in Task 1's `FileFingerprint` plus a
  schema version and tile dimensions.
- **Eviction** (`lru.ts`) — byte-budgeted LRU, `close()` on every eviction, an `onRemove` callback
  so `FrameCache`'s own lookup arrays never point at an already-closed bitmap after a budget
  eviction. Default budget ~96MB (justification in README.md).
- **Scheduling** (`scheduler.ts`) — `PriorityScheduler` orders pending items by distance from a
  center (playhead or viewport), with real out-of-range cancellation and progress bookkeeping.
  Used by the coarse tier's chunked dispatch; the dense tier doesn't need it (one atomic
  submit-and-cancel-on-supersede window, not a priority queue of independent items).
- **Two-tier orchestration** (`job-builder.ts`, `coarse-tier.ts`, `dense-tier.ts`) — pure
  `SampleIndex` → `DecodeJobDescriptor` translation, plus dependency-injected `warmCoarse`/
  `rebuildDense` functions tested against a fake pool.
- **`FrameCache`** (`FrameCache.ts`) — the public API from the task prompt's Part 8, exactly:
  `warmCoarse`, `setViewport`, `getNearest`, `getRange`, `onFrameAvailable`, `clear`, `dispose`.
  `getNearest` is a zero-allocation binary search (`binary-search.ts`) over both tiers.
- **Harness** (`harness.ts` + `frames.html`, wired into `vite.config.ts`) — Part 9's automated
  measurements (coarse build time/rate, `getNearest()` latency percentiles, dense build +
  cancellation timing, atlas round-trip, frames decoded-vs-kept, 20-cycle leak check) plus a
  separate manual section for OS-level memory checkpoints.
- **`FEASIBILITY.md` §4 updated** — the old "2fps, 5-minute window" constant replaced with the
  two-tier design and the keyframe-sampling rationale (Part 1's required deliverable).

## Decisions made

- **Part 0: job descriptors, not `SharedArrayBuffer`-shared index.** Decode workers only need
  byte ranges + presentation times for their assigned keyframes, never general index query
  capability, since the pool owner does every query once up front. Each worker reads its own
  bytes via its own `FileByteSource(file)` clone (same "File is structured-cloneable" precedent
  `src/media/index/worker.ts` already uses). Full reasoning in `worker-pool.ts`'s header comment
  and README.md's "Part 0" section. **This is a reasoned architectural decision, not one confirmed
  by a fresh in-browser SAB-vs-transferables measurement** — the already-recorded FEASIBILITY.md
  numbers (SAB 9.03ms/2 readers vs. 25.34ms/1 reader via transferables) describe a different case
  (handing a FULL index to a worker that queries it), which doesn't apply to this module's
  narrower job-descriptor design.
- **Eviction budget: 96MB**, per the task prompt's own proposed number. Covers the full coarse
  tier resident (~58MB) plus headroom for a realistic dense window, under the ~190MB
  "everything resident" ceiling. Arithmetic in README.md.
- **Atlas persistence is opt-in via `FrameCacheOptions.onCoarseAtlasReady`, not hardwired into
  `FrameCache`.** Packing needs a real `OffscreenCanvas`, absent in Node; keeping the seam
  optional is what keeps `FrameCache.ts` itself fully Node-testable. `harness.ts` wires it to the
  real `packAtlas`/`writeAtlas` pipeline for the browser run.
- **Dense tier windows are atomic**, not scheduler-prioritized like coarse's keyframes — a dense
  window is one contiguous decode chain (intervening delta frames depend on the ones before them
  within the same decoder session), so splitting it across a priority queue would break the
  chain's ordering guarantee. Coarse's independent keyframes have no such constraint.
- **Dense-tier `keep` selection is "first sample at or past each 2fps grid target,"** not true
  nearest-neighbor — a deliberate simplification; at 0.5s spacing the difference is imperceptible
  for a scrub preview, and the simpler algorithm was much cheaper to implement and verify.

## Part 9 measurements — longgop.mp4 (real browser run, Chrome 151, 2026-08-06)

The first real run surfaced three genuine WebCodecs integration bugs in a row (see next section)
before producing a clean pass. Full JSON:
`fixtures/frame_cache_harness_longgop.mp4_2026-08-06T14_17_17.874Z.json`.

| Metric | Result | Target | Status |
|---|---|---|---|
| Coarse build (192 keyframes) | 247.2ms (776.6 keyframes/sec) | <15000ms | **PASS** (61x margin) |
| `getNearest()` over 2000 calls | p50=0.000ms p95=0.005ms p99=0.005ms max=0.040ms | 60Hz-viable (≤16.67ms) | **PASS** |
| Dense build (first window) | 343.8ms | — | real, non-trivial cost |
| Dense rebuild after viewport moved (cancel + new window) | 325.2ms | — | real, non-trivial cost |
| Dense decoded-vs-kept (one window) | 1 kept / 301 decoded | — | confirms the decode-chain cost this task's Part 1 redesign is built around |
| Atlas round-trip (40 atlas builds across the leak-check cycles) | pack 5193.7ms / write 137.4ms / read 37.4ms / decode-once 785.9ms total, 10,310,720 bytes written | — | OPFS write/read are cheap; packing (WebP encode) dominates, as expected |
| 20-cycle warm/clear leak check | `liveCount` = 0 after every single cycle | 0 | **PASS** |
| Keyframe interval, longgop.mp4 (192 keyframes) | matches FEASIBILITY.md's already-recorded 10.000s constant | — | consistent with prior spike C measurement |

Worker count: 2 (of `hardwareConcurrency=10`, capped by `defaultWorkerCount`'s `min(4, hw/2)`
rule but starting at the "start with 2" default). Codec: `avc1.640028`, 1920x1080, track timescale
15360.

**Not yet run**: the same measurements against `fixtures/27gb.mp4` (4K, the actual target fixture
— longgop.mp4 is 1080p, and spike C's own numbers show decode throughput is resolution-dependent),
and the Part B manual Activity Monitor memory checkpoints (idle / coarse-warm / dense-warm /
after-`clear()`) — the only trustworthy memory number per this task's own repeated warning.

## Real bugs found during verification

Three genuine WebCodecs integration bugs were found and fixed via the first real browser run
against `longgop.mp4` — none of these could have been caught by the Node-only test suite, since
Node has no WebCodecs implementation to test against at all. In order of discovery (each one
masked the next until fixed):

1. **`VideoDecoderConfig.description` included the avcC/hvcC box's 8-byte header.** Task 1's
   `TrackIndex.description` deliberately keeps the full box (header included) for its other
   consumers (remux/export need it); WebCodecs wants only the
   AVCDecoderConfigurationRecord/HEVCDecoderConfigurationRecord content, starting at
   `configurationVersion`. Passing the header-included bytes made `configure()` fail silently on
   every single worker, for every single request — the only visible symptom was a generic,
   misleading "Cannot call decode on a closed codec" the moment `decode()` was first called,
   because the `VideoDecoder`'s `error()` callback fired with nothing in the pending queue yet
   (right after `configure()`, before any `decode()`) and its real message was silently dropped.
   Fixed by `stripBoxHeader()` (`FrameDecoder.ts`, tested) plus capturing `error()`'s message even
   when nothing is pending, so the *real* cause surfaces instead of the downstream symptom.
2. **Dense-tier decode chains got split at fixed-size flush boundaries, in TWO separate places.**
   `flush()` resets WebCodecs' "key frame required" flag; a dense window is one continuous chain
   (a keyframe followed by many dependent delta frames) that must never be split across a flush.
   `RealFrameDecoder.decodeBatch()`'s own internal batching had this bug, AND — after fixing that
   — `worker.ts`'s separate outer chunking loop (which exists only to check cancellation between
   chunks) had the identical bug one layer up, reproducing the exact same failure even after the
   inner fix landed. Both now use the same `groupIntoFlushBatches()` (`FrameDecoder.ts`, tested):
   independent keyframes (coarse tier) still batch up to `batchSize` per flush, preserving spike
   C's throughput finding, but a decode chain is never split regardless of length.
3. **A decode error left the worker's `VideoDecoder` instance wedged for every subsequent
   request.** `worker.ts` documented "a decode error leaves the decoder unusable" but didn't act
   on it — it kept reusing the same broken decoder instead of closing it and building a fresh one,
   so one bad batch would have silently broken every later request on that worker too.

None of these were hypothetical — each was found by literally running the harness, reading the
resulting error, and tracing it to a specific line. The general lesson, consistent with Task 2's
own experience: this module's "everything provably correct in Node before touching a real
decoder" strategy worked exactly as intended for the LOGIC (batching, scheduling, LRU, atlas
layout, cancellation, the two-tier sampling math — all of which needed zero changes once real
WebCodecs entered the picture) — but real WebCodecs behavior itself is only ever discoverable by
actually running it, which is precisely why Part 9's browser pass is not optional busywork.

## Test-scaffolding bugs found during Node-level verification

Writing tests against hand-built synthetic tracks caught two more correctness issues, this time in
the module's own logic rather than its WebCodecs integration — worth recording since both are the
kind of mistake that's easy to repeat:

1. **Dense-window clamping against the wrong bound.** An early version of `setViewport` clamped
   the dense window's end to the coarse tier's own keyframe extent (`coarseTimes[last]`) instead
   of the actual file duration. Since the last keyframe is rarely the last sample, this would have
   silently excluded the tail of every real file from dense-tier scrubbing. Fixed by only clamping
   the window's start to 0 and letting `frameAtPresentationTime`'s natural saturation handle an
   over-long end.
2. **Test track proportions inverted the real GOP/dense-step relationship**, initially making a
   test's coarse tier denser than its dense tier (backwards from reality, where GOP ~4.17s is much
   wider than dense's 0.5s step) — the test appeared to fail because dense wasn't "winning"
   `getNearest()` lookups, when the actual bug was in the test fixture's proportions, not the
   implementation. Fixed by widening the synthetic GOP relative to the dense step to match the
   real fixture's ratio.

## What's still open

- **`fixtures/27gb.mp4` (the actual target fixture) hasn't been run through the harness yet** —
  only `longgop.mp4` (1080p, 2GB) has a confirmed real-browser pass. longgop.mp4's clean numbers
  make it very likely the 27GB run will also succeed now that the three WebCodecs bugs above are
  fixed, but decode throughput is resolution-dependent (spike C: 648.8/sec on longgop.mp4 vs.
  150.4/sec on the 4K fixture, both batched) and the 27GB file's coarse tier is ~5x larger (1,015
  keyframes vs. 192), so its own numbers — especially whether coarse build stays under the 15s
  target — still need to be captured for real, not assumed from longgop's result.
- **The Part B manual Activity Monitor memory checkpoints have not been run at all** — the only
  trustworthy memory number per this task's own repeated warning (GPU-backed VideoFrame/ImageBitmap
  memory is invisible to every JS API). `harness.ts`'s Part B section is built and ready
  (`npm run dev:coi` → `frames.html`, scroll to "Part B: OS-level memory checkpoints").
- **Part 0's job-descriptor decision is reasoned, not measured** (see above) — worth a real
  multi-worker timing comparison if a future task's profiling suggests the pool is bottlenecked on
  something this design didn't anticipate.
- **The one carried-forward item from Task 2**: accurate seeks occasionally landing one frame off
  after heavy decoder activity. Watch for this specifically when running Part 9's dense-tier
  cancellation test against the real fixture — if the coarse cache is warm and a scrub-settle seek
  lands on an adjacent frame, the preview could visibly jump on pointer-up. Not reproduced or
  investigated here; flagged for the browser run.
