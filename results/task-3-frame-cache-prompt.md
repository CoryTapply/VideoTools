# M1 Task 3 — the frame cache

About a week. The largest task in M1, and the one with the most ways to leak memory invisibly.

This subsystem serves two consumers that earlier drafts treated as separate: the **timeline filmstrip** and the **drag-scrub preview**. They're the same frames, the same decode pass, and the same storage. Building them as one thing is the central decision here.

---

```
Context: I'm building a browser video trimmer for 20GB+ local files.

Task 1 shipped the production ISOBMFF parser and sample index (src/media/index/).
Task 2 shipped the PlaybackEngine port and NativeVideoEngine (src/media/playback/),
and resolved the time-base question: the canonical public time base is PRESENTATION
time (edit-list adjusted), expressed as integer ticks in the primary video track's
timescale. SampleIndex has presentation-native query methods
(frameAtPresentationTime, nearestSyncAtOrBeforePresentation,
keyframePresentationTimes, presentationRank, sampleAtPresentationRank, ...). Use
those. Never call the raw-tick methods from this module — on the 27GB fixture the two
differ by a constant 0.016s, which is under a frame and therefore invisible until it
isn't.

This task builds the frame cache: decoded thumbnails serving BOTH the timeline
filmstrip and the drag-scrub preview.

Measured baselines from spike C on the 27GB OBS fixture: keyframe decode 42/sec
sequential, 150.4/sec batched at 16 decodes per flush; GOP 4.166s constant; 1,015
keyframes total; cache-backed scrub sustains 60Hz at p50 0.00ms, p95 0.01ms. Task 2
measured <video> seek at p50 281.6ms, which is why scrubbing cannot go through the
player.

Same production rules as tasks 1 and 2: strict TypeScript, real module boundaries,
tests that run in Node, errors as values. Do not modify src/spikes/.

=== PART 0: the deferred worker/SAB check (do this first) ===

Task 2's Part 0b was never run. This task depends on it, so it lands here.

Wire the index worker path into a harness and exercise it against the 27GB fixture,
both branches: SharedArrayBuffer under crossOriginIsolated, and transferables without.
Confirm the index arrives intact (sample counts plus a few hundred random samples
compared against a main-thread build) and record transfer time for 41.8MB of typed
arrays.

The property that matters: transferables GIVE THE ARRAYS AWAY. Once transferred, a
second consumer cannot have the index without a copy. This pool needs 2-4 workers
reading it simultaneously, so:
  - if SAB works with two simultaneous readers, share one index across the pool
  - if not, the pool owner keeps the index and hands workers plain
    {offset, size, presentationTime} job descriptors instead

Decide based on what you measure, state which, and build the pool accordingly.

=== PART 1: the cache design (resolve the documented contradiction) ===

FEASIBILITY.md's constants say a 2fps cache over a 5-minute window. Architecture v2 §3
overrides that. Build the architecture v2 design and update FEASIBILITY.md's constants
section so the two documents stop disagreeing.

WHY: filling 600 slots at 2fps required decoding 18,210 frames — every frame in the
window — because 2fps sample points don't land on keyframes. That's 27.1s per window,
and on a 70-minute recording it leaves 93% of the timeline uncached with no designed
behaviour for scrubbing there.

Keyframes decode independently, with no dependency chain. Sampling at keyframes:
  - 1,015 entries covers the ENTIRE 27GB file
  - at 150.4/sec batched, roughly 6.7 seconds
  - the "outside the window" problem disappears because there is no window

Two tiers:

  COARSE — whole file, one entry per keyframe (~4.17s spacing), 160x90.
           Built eagerly on open. Target under 15s for the 27GB fixture.
           This is the filmstrip AND the default scrub source.

  DENSE  — ±30s around the viewport, 2fps, 320x180.
           Built lazily, only when zoom exceeds roughly one keyframe per 40px.
           Cancelled and rebuilt as the viewport moves.
           This is spike C's validated path, now scoped to only run when coarse is
           genuinely too sparse.

Sanity check: at full-file zoom on a ~1400px timeline, 4.17s is about 5px — finer than
the pointer. Coarse is sufficient for the large majority of scrubbing.

=== PART 2: frame lifecycle safety (build this BEFORE any decoding) ===

Spike C's leak test: unclosed VideoFrames grow memory at 11-13MB/frame, LINEARLY, with
ZERO errors thrown, to 800 frames / 9.3GB. No decoder stall, no exception, no runtime
signal of any kind until the OS intervenes. This is the most dangerous failure mode in
the project because it is completely silent.

Make it structurally impossible rather than a matter of discipline:
  - No raw VideoFrame escapes the function that creates it. Provide a scope-bound
    helper (withFrame(frame, fn) closing in finally) and use it at every decoder
    output site.
  - In dev builds, keep a registry of live frames with creation timestamps and assert
    loudly when one outlives its expected scope.
  - Same rule for ImageBitmap: close() on eviction, never rely on GC.
  - Test with a fake decoder that N decodes produce exactly N closes — including on
    the error path and the cancellation path.

MEASUREMENT WARNING: ImageBitmap and VideoFrame memory is GPU-backed and does NOT
appear in performance.measureUserAgentSpecificMemory(). On macOS, hardware-decoded
frames live in VTDecoderXPCService, outside Chrome's process tree entirely, so they
don't show in Chrome's own task manager either. Every memory claim in this task must be
cross-checked in Activity Monitor against the whole process group. A memory number
measured from a JS API in this module has not been measured.

=== PART 3: the decoder wrapper ===

  - Batch 16 decode() calls per flush(). Spike C's highest-leverage finding: 3.6x
    throughput, from amortising flush cost, not I/O.
  - NEVER flush speculatively to check progress. flush() resets the decoder's
    key-frame-required flag, forcing a keyframe restart on the next decode. This is
    exactly why spike C's "warm decoder" idea failed.
  - Read sample bytes via the index's byteRange() and task 1's ByteSource seam.
    Coalesce reads within a 4MB window, but don't over-invest — spike C showed read
    coalescing barely moved the number here. Decode dominates.
  - hardwareAcceleration: 'prefer-hardware', isConfigSupported() checked first, clean
    error if unsupported. A machine without hardware H.264 decode measured ~4x slower,
    so surface which path is active.
  - Downscale via createImageBitmap(frame, {resizeWidth, resizeHeight}), then close the
    frame immediately.

TESTABILITY SEAM, mirroring ByteSource and VideoElementLike: define a FrameDecoder port
so the scheduler, batching, LRU, and atlas packing are testable in Node against a fake
decoder with configurable latency and failure injection. Task 2's experience is the
argument — its three real bugs were all browser-timing behaviour the fake couldn't
reproduce, which means everything that ISN'T browser-timing should be provably correct
before you get to the browser.

=== PART 4: worker pool ===

  - Start with 2 workers and measure before raising it. 4K hardware decode may already
    be the bottleneck, in which case more workers just contend. Cap at
    min(4, hardwareConcurrency/2).
  - Index distribution per Part 0.
  - Jobs are RANGES of keyframe indices, not individual frames, so batching survives
    the pool boundary.
  - Cancellation must be real: a cancelled job stops promptly and closes everything it
    holds. Test the cancel path for leaks specifically — it's where frames get orphaned
    and it produces no error to notice.

=== PART 5: atlas storage ===

  - Pack 100 thumbnails per atlas, 10x10 grid, WebP quality 60, written to OPFS.
  - CRITICAL: createImageBitmap(blob, sx, sy, sw, sh) decodes the ENTIRE atlas
    internally on every call — spike C measured 23.81ms per call regardless of crop
    size. Decode each atlas ONCE per session into a single ImageBitmap, then crop tiles
    from that in-memory bitmap via canvas drawImage. Per-tile calls against the blob
    would cost ~950ms per filmstrip repaint.
  - Key on the same file fingerprint the index cache uses (size + lastModified + hash
    of first/last 1MB), plus a SCHEMA VERSION so a change to thumbnail dimensions or
    packing invalidates stale atlases rather than silently serving wrong frames.
  - Quota exceeded degrades to memory-only, never fails.

=== PART 6: eviction ===

Byte-budgeted LRU over live ImageBitmaps, close() on eviction.

Budget arithmetic:
  - coarse tier, all 1,015 at 160x90 RGBA: ~58MB
  - dense tier, 600 at 320x180 RGBA: ~132MB
  - both fully resident: ~190MB of GPU memory no JS API can see

Set an explicit total budget (propose ~96MB and justify it), keep visible-plus-margin
resident, let OPFS atlases back the rest. Test that OS-level process-group memory
returns to baseline after clear().

=== PART 7: scheduling ===

  - Priority queue scored by distance from viewport centre.
  - Requests scrolling out of range are CANCELLED, not deprioritised.
  - Coarse tier builds outward from the current playhead, not from t=0 — the user is
    usually looking somewhere specific when they open a file.
  - Progress granular enough for a status bar ("thumbs 68%").

=== PART 8: public API ===

  interface FrameCache {
    warmCoarse(onProgress?): Promise<void>
    setViewport(start: Time, end: Time, pixelsPerSecond: number): void
    getNearest(time: Time): CachedFrame | null
    getRange(from: Time, to: Time, count: number): (CachedFrame | null)[]
    onFrameAvailable(cb): Unsubscribe
    clear(): void
    dispose(): void
  }

Time is presentation ticks, per task 2.

getNearest() is called at 60Hz inside a pointermove handler. It must be a lookup and
nothing else — no promises, no allocation, no triggering of decodes. That constraint is
the entire reason the coarse tier is built eagerly.

=== PART 9: harness and measurements ===

Extend the manual harness. Against the 27GB fixture, report:
  - coarse build time (target under 15s) and effective keyframes/sec
  - getNearest() latency over a simulated 60Hz drag: p50, p95, p99, max
  - dense build time and cancellation responsiveness when the viewport moves
  - OS-level process-group memory (Activity Monitor) at: idle, coarse warm, dense warm,
    after clear() — the only trustworthy memory numbers in this task
  - atlas write/read timings and total OPFS bytes
  - frames decoded vs frames kept per tier (the ratio that motivated Part 1)
  - leak check: warm and clear 20 times, confirm memory returns to baseline each cycle

Also run the coarse build against longgop.mp4 and report its measured keyframe interval
and rate. Spike C measured 648.8/sec batched there versus 150.4/sec on the 4K fixture,
so decode rate is resolution-dependent and the 15s target needs a resolution-aware
estimate rather than a flat number.

=== DO NOT BUILD ===

  - timeline canvas rendering, zoom, handles — task 4
  - waveform — M2
  - any encoding — the transcode path was cut from scope entirely
  - export or remux — task 5
  - a general-purpose media cache abstraction; this serves two known consumers

=== DELIVERABLE ===

src/media/frames/ with the two-tier cache, worker pool, atlas storage, LRU, and
scheduler. Tests green including frame-lifecycle leak tests. FEASIBILITY.md's constants
updated. A README covering the two tiers and when each applies, the frame lifecycle rule
and why it's structural, the atlas decode-once rule, and the measured budgets.
```

---

## The three things most likely to go wrong

**Per-tile `createImageBitmap` against the atlas blob.** It looks correct, passes every test, and costs 23.81ms per tile because it decodes the whole atlas each time. A filmstrip drawing 40 tiles per repaint would spend ~950ms doing it. Decode once, crop from memory.

**Leaks on the cancellation path.** The happy path gets tested. The cancelled-mid-batch path is where frames get orphaned, and it produces no error, no stall, and no signal — just linear growth until the OS steps in.

**Measuring memory with a JS API.** The numbers that matter here are GPU-backed and invisible to `measureUserAgentSpecificMemory()`. If a report says memory is fine and it was measured in JS, it hasn't been measured.

## One carried-forward item

Task 2's observation that accurate seeks occasionally land one frame off after heavy decoder activity matters for task 4, not this one — but it's worth watching here too. If the coarse cache is warm and the scrub-settle seek lands on an adjacent frame, the preview will visibly jump on pointer-up. Note any instance of it you see while running Part 9.
