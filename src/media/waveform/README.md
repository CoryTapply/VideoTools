# `src/media/waveform/` -- the peak-pyramid cache

Production module, M2. Demuxes one audio track, decodes it through `AudioDecoder` in a worker, and
reduces it to a multi-resolution min/max peak pyramid, stored in OPFS. **Never `decodeAudioData`**
-- roadmap.md's own worst case, a 4-hour 48kHz stereo source, is ~5.5GB as raw float32. If you're
new to this module: read this file, then `WaveformCache.ts` (the public entry point), then
`pyramid.ts` (the math everything else feeds).

## Why no coarse/dense tier split

`src/media/frames/` (the sibling video module) splits into a cheap whole-file coarse pass
(keyframes only) and an expensive, viewport-scoped dense pass, because decoding every frame of a
long video is prohibitively expensive and keyframes offer a shortcut most other frames don't.
Audio has no equivalent shortcut -- every AAC frame decodes independently regardless of target
resolution, so there's no "cheap whole-file pass vs. targeted expensive pass" split to make. This
module builds one track's whole pyramid in a single pass instead.

## Why no LRU/eviction

The entire pyramid for a realistic file is a handful of plain `Int16Array`s -- see the size math
below, worst case ~49.4MB, typically far less. That's not GPU-backed, not a `Closable`, nothing to
leak or budget against, unlike `FrameCache`'s decoded bitmaps. `WaveformCache` just holds the
pyramid resident for as long as it's wanted.

## Pyramid design and size math

Min/max envelope per channel, quantized to `Int16` (`pyramid.ts`'s `quantize()`/`PEAK_INT16_MAX`).
Level 0 covers `128` raw samples/bucket (`DEFAULT_L0_SAMPLES_PER_BUCKET`, ~2.7ms @48kHz -- matched
to the timeline's max zoom, where a video frame is already the smallest addressable unit, so
sub-frame audio precision has no consumer). Each level above folds `8` buckets
(`DEFAULT_RATIO`) from the level below into one, terminating once a level's own bucket count
reaches 1 -- a pure function of the real sample count, no hardcoded level-count constant
(`buildLevelSpecs()`).

Worst case (4hr/48kHz/stereo, matching roadmap.md's own example): **≈49.4MB** total
(`estimatePyramidBytes()`, cross-checked in `pyramid.test.ts`), dominated by level 0 -- a geometric
series with common ratio 1/8 converges fast. The real stress fixture, `fixtures/27gb.mp4` (70.4min,
**six** independent stereo AAC tracks -- `AudioTrackMeta.handlerName` exists precisely to
distinguish these), scales to ≈14.5MB/track, ≈87MB if all six were built eagerly. That's why
`WaveformCache` builds lazily, one track at a time, on `build()` -- never eagerly for every audio
track at file-open.

### `PyramidBuilder`'s two-phase design, and the bug that shaped it

Level 0 is the only level built incrementally, during `push()` -- it has to be, to keep memory O(1)
per raw sample regardless of file length, never buffering the raw float32 stream (the whole point
of this class existing). Every level ABOVE level 0 is built once, in `finish()`, as a plain
non-incremental fold over level 0's already-completed array.

This was originally attempted as a fully incremental cascade -- every level folding into the next
live, during `push()`. That design has a genuine bug, caught by a real OOM crash during
development, not a hypothetical: a level whose data ends up fitting in exactly one bucket has no
way to know, AT PUSH TIME, whether more data is still coming that would eventually justify a
parent level. Eagerly creating that parent regardless means a lonely single bucket gets wrapped in
another lonely single bucket, forever -- an unbounded level chain with no terminating condition.
Building levels 1+ only after `finish()`, when the total is finally known for certain, has no such
ambiguity: `buildLevelSpecs()`'s `ceil(bucketCount / ratio)` recurrence, applied directly to the
already-known level-below array, terminates exactly when a level's own bucket count reaches 1, by
construction. See `pyramid.ts`'s header comment for the full account.

## OPFS storage layout

Self-describing versioned binary blob, following `src/media/index/opfs-cache.ts`'s convention
(embed the fingerprint INSIDE the blob, compare on read) rather than
`src/media/frames/atlas-cache.ts`'s key-only-folding model -- this data needs more parameters than
an atlas's `tier + dims` (fingerprint, trackId, channelCount, sampleRate, a *variable-length*
level table), and a truncated raw `Int16Array` region doesn't self-detect corruption the way a
broken WebP blob does inside its own decoder. No JSON metadata layer, unlike the index cache: that
existed there for variable-length strings this format doesn't have. See `opfs-cache.ts`'s header
comment for the exact byte layout.

## Worker architecture

Mirrors `src/media/frames/`'s worker-pool/client/protocol pattern exactly: a `File` posted once at
init (structured-cloneable), every subsequent message a small job descriptor, one decode worker
per `WaveformWorkerPool` handle. **Single-worker pool for the MVP** (`worker-pool.ts`'s header
comment) -- audio has no keyframe-only shortcut the way video's coarse tier does, but is also
expected to be dramatically cheaper per second of content than 4K H.264 decode (no GPU/driver
hazards, software-only). This is unmeasured; splitting into parallel segments, each its own
`AudioDecoder` instance starting mid-stream, is a natural follow-up if real throughput against
`fixtures/27gb.mp4`'s six tracks proves too slow -- contingent on confirming mid-stream AAC
decode-start is clean (also unverified, see below).

`RealWaveformDecoder.ts` ports `src/media/frames/RealFrameDecoder.ts`'s defensive pattern
(timeout-raced `flush()`, an `error()` callback rejecting every pending output) as insurance, NOT
because the same hang has been observed for `AudioDecoder` -- it hasn't been exercised against a
real browser at all yet. Deliberately simpler than the video decoder in two ways: no
hardware/software acceleration toggle (`AudioDecoder` has none; audio decode is software-only), and
no decode-chain-preserving batch logic (`groupIntoFlushBatches`) -- every AAC frame decodes
independently, so a `flushEvery` group boundary can land anywhere, unlike a video B-frame chain.

## Testability seam

`WaveformDecoder` (`WaveformDecoder.ts`) mirrors `src/media/frames/FrameDecoder.ts`: a real
WebCodecs implementation (`RealWaveformDecoder.ts`, the only WebCodecs-touching file) plus a
Node-testable fake (`FakeWaveformDecoder.ts`) with configurable latency, failure injection, and a
configurable sample generator. Everything above this seam -- job building, the pyramid reducer, the
worker pool's dispatch/cancellation, OPFS serialization, `WaveformCache`'s orchestration -- is
proven correct in Node against the fake (or, for `WaveformCache` itself, against a fake
`WorkerHandle` that runs the real `PyramidBuilder` on deterministic synthetic samples) before any
of it touches a real `AudioDecoder`.

## Real-browser session: closed

Three real Chrome sessions (`npm run dev:coi`, `waveform.html`) closed every item from this
section's original list, including against the real `fixtures/27gb.mp4` stress fixture and a real
Chrome Task Manager memory reading -- full findings and real numbers in
`results/m2-waveform-session-notes.md`.

- ✔ `AudioDecoder` output arrives correctly under the `flushEvery`-checkpoint design -- zero decode
  errors across four real fixtures (mono and stereo, 28MB to 27GB), including all twelve builds
  against `27gb.mp4`'s six real tracks.
- ✔ `extractAudioSpecificConfig()`'s extracted bytes pass a real `AudioDecoder.configure()`, same
  evidence.
- ✔ Real OPFS round-trip, confirmed at both small and stress scale: a smaller fixture's fresh build
  (351.6ms) to cache-hit rebuild (6.1ms), and `27gb.mp4`'s six tracks (~43.7s/track fresh build to
  ~13.7ms/track cache-hit rebuild, a 3183x speedup). Every track's real `l0BucketCount` matched the
  closed-form sample-count math exactly.
- ✔ Real single-worker decode throughput: ~108-125x real-time on smaller fixtures, ~96.7x real-time
  on `27gb.mp4`'s six tracks. Comfortably fast enough that the "no parallel segments" MVP decision
  holds at this scale.
- ✔ **Real, authoritative memory reading**: Chrome Task Manager (this project's own stated ground
  truth, `src/measure/memory.ts`) showed a **+250MB** rise building one track's pyramid against the
  real 27GB file (334MB idle -> 584MB after build) -- ~6.2x smaller than even that one track's own
  raw float32 PCM cost (1.51GB), before even reaching the roadmap's four-hour/six-track worst case.
  Notably, this is meaningfully higher than the JS-heap-only `measureUserAgentSpecificMemory()`
  proxy used earlier in the same investigation (+1.4MB on a smaller fixture) -- that proxy had
  entirely missed transient pipeline overhead (Worker/decoder state, `AudioData` cycling through
  before being reduced) that Task Manager's process-wide reading catches and the pyramid data
  itself (~13.8MB, 5.5% of the real delta) does not explain.

**Two things surfaced by real testing, tracked as explicit follow-ups, not blockers**: a real UX
gap (~44s with no progress indicator before a track's waveform first appears on a file this long --
the lazy per-track build avoids paying this six times, not once), and mid-stream AAC decode-start
was never exercised (a prerequisite for a possible future parallel-segment split, not this pass). A
second, smaller bug was also caught and fixed during this testing: the harness's own size-estimate
log line was computing from the wrong sample-count unit.

## `getRange()`'s time-domain assumption

`WaveformCache.getRange()`'s `Time` values are presentation ticks in the AUDIO TRACK's own
timescale (`types.ts`'s `Time`, a separate local alias from `src/media/frames/types.ts`'s -- this
module has no notion of a video track at all). Bucket-to-tick mapping assumes
`ticksPerRawSample = timescale / sampleRate` is exactly `1` for virtually every real MP4 audio
track (timescale conventionally equals sample rate) -- computed rather than hardcoded, in case a
file doesn't follow that convention, but NOT verified against a real file where it doesn't.
Bridging this module's ticks to the timeline's video-track ticks, and actually drawing a waveform
on the canvas, is explicitly out of scope for this pass -- see `getRange()`'s own doc comment and
roadmap.md's M2 entry.

## What's out of scope here

Canvas drawing (a `draw/waveform.ts` sibling to `src/ui/timeline/draw/filmstrip.ts`) -- this
module's job ends at `getRange()` returning normalized peak columns. Any UI wiring in
`src/ui/timeline/` or `TimelineController`. Parallel multi-worker decode (see "Worker architecture"
above). Any change to `src/media/frames/` beyond importing `frame-lifecycle.ts`'s `Closable`/
`withFrame`.

One deliberate deviation from the plan this module was built against: `getRange()` picks a bucket
by direct index arithmetic (`floor(samplePos / samplesPerBucket)`), not
`src/media/frames/binary-search.ts`'s pattern. Binary search earns its keep against irregularly
spaced keyframe times; pyramid buckets are exact, evenly spaced multiples of `samplesPerBucket`, so
a direct index computation is both simpler and cheaper.
