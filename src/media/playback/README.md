# `src/media/playback/` -- the playback engine

Production module. Shows the right frame at the right time and reports position
accurately enough to drive a timeline, on top of Task 1's sample index
(`src/media/index/`). If you're new to this module: read this file, then
`PlaybackEngine.ts` (the port every consumer and every engine implementation is
written against), then `NativeVideoEngine.ts` (the only implementation so far).

## The port, and why it exists

`PlaybackEngine` (`PlaybackEngine.ts`) exists so a WebCodecs compositing engine (M6)
can replace `NativeVideoEngine.ts` without the timeline noticing. Everything on the
interface is written against what a timeline UI actually needs (`play`, `pause`,
`seek`, `stepFrames`, `setPlaybackRate` for J/K/L shuttle, frame/state subscriptions),
not against `<video>`'s API shape.

**Time base:** `Time` is always an integer count of the loaded file's primary video
track's own timescale units (the first `kind === 'video'` track from
`SampleIndex.tracks()`), fixed at `load()` time -- same ticks-not-seconds rule as
`src/media/index/` (see that module's README). It is always **presentation time**
(edit-adjusted), never raw media time -- see "Presentation time vs. media time" below.

**Error surface:** `PlaybackError` (`errors.ts`) mirrors `src/media/index/errors.ts`'s
`IndexError` -- a discriminated union, never a thrown exception, for expected failure
conditions (`unsupported-codec`, `decode-error`, `load-failed`, `aborted`,
`no-video-track`). `load()` returns one via `Result` (`result.ts`); `lastError` (on the
`PlaybackEngine` interface itself, not just `NativeVideoEngine`) surfaces one for a
failure that happens after load, since `state === 'error'` alone carries no detail.

## Presentation time vs. media time (the resolved Part 1 answer)

All of `NativeVideoEngine`'s index queries go through `SampleIndex`'s
presentation-time-native methods (`frameAtPresentationTime`,
`presentationTimeOfSample`, etc. -- `src/media/index/query.ts`), never the raw-tick
methods (`frameAtTime`, `timeOfSample`) with `editOffsetTicks` added or subtracted by
hand. This is the sanctioned boundary: **playback code lives entirely in presentation
time**; `TrackIndex.pts`/`dts` remain raw media time underneath (needed for the
remux/export path to reproduce or adjust the `elst` box on output), and the two are
never confused because every presentation-time method's name says so.

**Confirmed** against the real 27GB OBS fixture via `harness.ts` (`playback.html`):
`<video>.currentTime`/`requestVideoFrameCallback().mediaTime` agreed with these
presentation-time methods to Δ=0.0000s at all 8 tested points (spanning the file,
including a keyframe boundary), and diverged from the raw-tick methods by a constant
`-0.016s` -- exactly `editOffsetTicks / timescale` for this file. See
`src/media/index/README.md`'s "Presentation time vs. media time" section for the full
numbers and the two harness bugs (a no-op seek not firing `'seeked'`, and
`requestVideoFrameCallback` needing to be armed before the seek, not after) found and
fixed while getting a clean run.

## The state machine

Every transition is enumerated in `NativeVideoEngine.ts`'s header comment (search for
"STATE MACHINE") and reproduced here:

| From | Event | To |
|---|---|---|
| `idle` | `load()` | `loading` |
| `loading` | no video track in the index | `error` (`no-video-track`) -- before any object URL |
| `loading` | `canPlayType` fails | `error` (`unsupported-codec`) -- before any object URL |
| `loading` | `'loadedmetadata'` | `ready` |
| `loading` | video `'error'` | `error` (`decode-error` \| `load-failed`, from `MediaError.code`) |
| `ready` | `play()` | `playing` |
| `ready` | `seek()` | `seeking` → (settle) → `ready` |
| `playing` | `pause()` | `ready` |
| `playing` | `seek()` | `seeking` → (settle) → `playing` |
| `playing` | reaches end | `ended` |
| `playing` | video `'error'` | `error` |
| `seeking` | another `seek()` | stays `seeking` (coalesced) |
| `ended` | `seek()` | `seeking` → (settle) → `ready` |
| `ended` | `play()` | no-op -- caller must `seek(0)` first |
| `error` | `load()` | `loading` (re-entrant load allowed) |
| any | `dispose()` | terminal, idempotent |

Anything not listed is a silent no-op, with one deliberate exception: `stepFrames()`
called while `playing` implicitly pauses first (stepping while shuttling is a normal
editing affordance, not a state a caller should have to avoid).

**Codec support is checked, and an unsupported codec is a distinct recoverable state,
before any object URL is created** -- per architecture v2, a source the browser can't
preview must still be usable for trimming, so `NativeVideoEngine` never treats this as
a fatal load failure; the app decides what to do with it.

**`dispose()` always revokes the object URL exactly once**, regardless of which state
disposal happens from -- an un-revoked object URL pins the entire `File` for the
document's lifetime.

## Sync path: rVFC, with an honest rAF fallback

`requestVideoFrameCallback` is used exclusively when available -- never `'timeupdate'`,
which fires ~4x/second and is useless for an editor. It reports the actual presented
`mediaTime` and a `presentedFrames` counter; gaps between consecutive
`presentedFrames` values are dropped-frame detection. When rVFC isn't available, the
engine falls back to `requestAnimationFrame` + polling `currentTime`, and reports
`droppedFrameCount` as `undefined` (not `0`) on that path, since it genuinely cannot
measure drops there -- a UI reading this should show "unavailable," not a false zero.

Which path is active (`engine.syncPath`) and the dropped-frame count
(`engine.droppedFrameCount`) are extra getters on the concrete `NativeVideoEngine`
class, not on the portable `PlaybackEngine` interface -- they're diagnostics the Part 7
harness needs, not something a future WebCodecs engine is obligated to replicate
identically.

## The seek-coalescing invariant

Measured baseline: `<video>` seek on the 27GB fixture averages ~220ms. At 60Hz drag
input that's roughly thirteen seek requests arriving per completed seek -- without
coalescing, seeks queue and the playhead falls seconds behind.

The engine holds one `pendingSeekTarget`, overwritten by every new `seek()` call, and
issues a real seek only when none is currently in flight; on `'seeked'`, if a newer
target is pending, it's issued immediately. **The correctness property, tested
hardest** (`NativeVideoEngine.seek-coalescing.test.ts`): after input stops, the engine
converges on the LAST requested position. Dropping intermediate seeks is the point;
dropping the final one is a bug -- and it only shows up under fast input, which is
exactly when nobody is looking carefully. The suite includes 200 rapid seek requests,
the last-request-arrives-mid-flight case, a never-resolving seek (no crash, no
double-issue, no timeout/watchdog in M1 by design), and out-of-order `'seeked'` firing.

Scrub mode uses `fastSeek()` only when feature-detected present (Safari/Firefox have
it; Chrome does not) -- never assumed. Accurate mode always sets `currentTime`.

**Promise semantics for a coalesced-away `seek()` call** are documented separately in
[`seek-promise-semantics.md`](./seek-promise-semantics.md): every call's promise
currently resolves together, once the engine fully settles, regardless of whether that
call's own target was the one that landed. That file also covers the switch criteria
and the (small, isolated) implementation delta for the alternative, so a future change
here is a known-size decision, not a re-design.

This project has twice fitted a confident story to an unexplained perf delta and been
wrong (see `src/media/index/README.md`'s build-time-delta note) -- so seek latency
numbers are measured via the Part 7 harness against the real fixture, not assumed from
the synthetic-fake test suite's timings.

## Frame stepping

`frame-stepping.ts`'s `stepTarget` steps `delta` positions in **presentation order**
(via `SampleIndex.presentationRank`/`sampleAtPresentationRank`), never `pts[n + delta]`
on a decode-order index -- decode order and presentation order diverge the moment a
track has B-frames (see `query.ts`'s header comment), which the task's own naive
pseudocode gets wrong. The result is clamped at the first/last frame (no wraparound,
no error) and offset by half the *target* frame's own duration (from adjacent
presentation-order pts deltas, never a nominal fps -- correct for VFR tracks too) to
defeat float rounding at the `currentTime` boundary.

**The correctness test, deliberately strict:** stepping forward 10 then back 10 from
an arbitrary starting frame must land on the byte-identical starting decode-order
sample index -- verified by index, not timestamp proximity. Run from 20 starting
points including one inside a B-frame run and one immediately after a keyframe, then
again against a real VFR fixture when present locally (`frame-stepping.test.ts`).

## The testability seam

`VideoElementLike.ts` mirrors `src/media/index/byte-source.ts`'s `ByteSource`: a
narrow interface capturing exactly what `NativeVideoEngine` uses, with one real
DOM-backed implementation (`RealVideoElement.ts`, deliberately trivial) and one
Node-testable fake (`FakeVideoElement.ts`) that can simulate configurable seek
latency, out-of-order `'seeked'` firing, seeks that never resolve, and play()
rejection -- the same trick, for the same reason: the interesting bugs live in the
edge cases, and edge cases need to be cheap to construct.

Both `fastSeek` and `requestVideoFrameCallback` are feature-detected as *runtime*
optional (left `undefined` rather than defined-but-throwing) in `RealVideoElement`,
because `lib.dom.d.ts` declares both unconditionally on `HTMLMediaElement`/
`HTMLVideoElement` even though Chrome doesn't implement `fastSeek` at runtime -- a
naive `typeof video.fastSeek === 'function'` check against a wrapper that always
defines the method would be a type-level check with no relationship to reality.

## What's NOT covered by `npm test`

`harness.ts` + `playback.html` (run via `npm run dev`) is where the empirical edit-list
ground-truth check (Part 1), real seek-latency numbers, real 20-drag-simulation
convergence, real step round-trip accuracy, and real rVFC-vs-`currentTime` drift over
60 seconds of continuous playback all get exercised against a real `<video>` element
and (for the full run) the 27GB fixture -- none of those exist in Node. Same
convention as `src/media/index/harness.ts`: run by hand, not part of CI.
