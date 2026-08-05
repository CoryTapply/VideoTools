# M1 Task 3 — frame cache: summary

Status: implemented and tested (116 tests in `src/media/frames/`, all Node-runnable logic green: `npm run typecheck`,
`npm run lint`, `npm test` all clean project-wide). **Not yet run against the real 27GB fixture or
`longgop.mp4` in a browser** — that requires a real Chrome session with WebCodecs hardware decode,
real Worker threads, OPFS, and (for the memory checkpoints) a human reading Activity Monitor by
hand. This doc is explicit about which numbers are proven and which are still pending that pass —
see "What's still open" below.

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

## Real bugs found during verification (all in test scaffolding, not shipped design)

Writing tests against hand-built synthetic tracks caught two real correctness issues before they
could hide behind convenient assumptions — worth recording since both are the kind of mistake
that's easy to repeat:

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

- **No numbers in this doc are from a real browser run yet.** Everything above is verified in
  Node against fakes/synthetic data. The task prompt's Part 9 numbers (coarse build time on the
  27GB fixture and target <15s, `getNearest()` latency at real scale, dense build/cancel timing,
  atlas OPFS round-trip timing/bytes, and — critically — the OS-level Activity Monitor memory
  checkpoints, the only trustworthy memory number per the prompt's own repeated warning) all
  require running `npm run dev:coi` → `frames.html` by hand against `fixtures/27gb.mp4` and
  `fixtures/longgop.mp4`, same as Task 2's Part 7 report. **Next session: run this harness for
  real and replace this section with the actual measured numbers**, flagging anything that misses
  a target (<15s coarse build, dense cancellation genuinely stopping in-flight work) per the task
  prompt's instructions.
- **Part 0's job-descriptor decision is reasoned, not measured** (see above) — worth a real
  multi-worker timing comparison if a future task's profiling suggests the pool is bottlenecked on
  something this design didn't anticipate.
- **The one carried-forward item from Task 2**: accurate seeks occasionally landing one frame off
  after heavy decoder activity. Watch for this specifically when running Part 9's dense-tier
  cancellation test against the real fixture — if the coarse cache is warm and a scrub-settle seek
  lands on an adjacent frame, the preview could visibly jump on pointer-up. Not reproduced or
  investigated here; flagged for the browser run.
