# M1 Task 2 — playback engine

Three to four days. The first task where the index meets the player, and where a whole class of timing bugs either gets caught or gets baked in for the rest of the project.

**Part 1 is the reason this task is sequenced here.** Every one of the seven tracks in the fixture carries an edit list, and until you know whether `TrackIndex.pts` agrees with what `<video>` actually presents, nothing built on top of the index can be trusted to land on the right frame.

---

```
Context: I'm building a browser video trimmer for 20GB+ local files. Task 1 shipped a
production ISOBMFF parser and sample index at src/media/index/ — typed-array
TrackIndex per track, a SampleIndex query API (frameAtTime, nearestSyncAtOrBefore,
byteRange, sampleRange...), all times in integer timescale units, tested against two
differential oracles. The 27GB OBS fixture indexes in ~110-165ms, 7 tracks,
253,544 video samples.

This task builds the playback engine: the thing that shows the right frame at the
right time and reports where it is accurately enough to drive a timeline.

Same production rules as task 1: strict TypeScript, real module boundaries, tests
that run in Node, errors as values. Do not modify src/spikes/.

=== PART 0: housekeeping carried from task 1 (do first, ~90 min total) ===

a) Add CI. GitHub Actions running `npx tsc --noEmit`, `npm run lint`, and `npm test`
   on every push. The differential tests against the spike parser and mediabunny are
   this project's only defence against a silent parser regression producing byte
   offsets that generate a file which plays but is subtly wrong. Tests that only run
   when someone remembers to type `npm test` will eventually not run.

b) Wire the worker path into the manual harness and exercise it against the 27GB
   fixture. Both branches: SharedArrayBuffer under crossOriginIsolated, and
   transferables without. Confirm the index arrives intact (spot-check sample counts
   and a few hundred random samples against a main-thread build) and record the
   transfer time for 41.8MB of typed arrays.

   Note the property that makes this matter: transferables GIVE THE ARRAYS AWAY. Once
   transferred to the main thread, a second consumer — thumbnail workers in task 3,
   export in task 5 — cannot have the index without a copy. Confirm the SAB path
   allows two simultaneous readers, since that's the configuration later tasks need.

c) Profile the build-time delta once: 107.1ms in the spike vs 164.7ms in production,
   same browser (Chrome). Under the 250ms budget so not urgent, but "browser
   overhead" is currently an assumption, not a measurement, and this project has
   twice fitted a confident story to an unexplained delta and been wrong. Fifteen
   minutes with the profiler, write down the answer, move on.

=== PART 1: edit-list ground truth (the important one) ===

All 7 tracks in the fixture produce edit-list warnings (priming-delay pattern). The
task 1 mediabunny differential passed "edit-list-adjusted," which leaves the real
question open:

  Does TrackIndex.pts contain raw media time, or edit-list-adjusted presentation time?

This matters because <video>.currentTime honours edit lists. If the index stores raw
media time while the player reports edited presentation time, every trim point,
keyframe tick and frame step lands offset by the edit — consistently, silently, and
by an amount (tens of ms) small enough to look like a rounding bug for months.

Establish ground truth empirically:
  - Load the 27GB fixture in <video> via an object URL.
  - Pick at least 8 target timestamps: 0, a few seconds in, four spread across the
    middle, one near the end, and one exactly at a known keyframe boundary.
  - For each: seek, await 'seeked', then capture requestVideoFrameCallback's
    reported mediaTime for the presented frame.
  - Compare against what SampleIndex reports for the same nominal time: frameAtTime,
    then timeOfSample for that frame.
  - Report the delta at every point. If it's a constant offset, that's the edit list.
    If it varies, something worse is going on and I want to know before anything is
    built on it.

Then decide and document:
  - The PUBLIC time base for the app is presentation time — what the player shows and
    what the user's timeline means. Apply edit lists at the index boundary so that
    frameAtTime and <video>.currentTime speak the same language.
  - RAW MEDIA TIME must still be retained per track, because the remux rewrites sample
    tables in media time and has to reproduce or adjust the elst on output. Do not
    throw it away; expose both with unmistakable names (e.g. presentationTime vs
    mediaTime) and document the conversion in src/media/index/README.md next to the
    existing time-representation rule.
  - Add a regression test asserting the two agree on the committed tiny.mp4 fixture,
    which already has a real priming-delay edit list.

If it turns out the index already applies edit lists, say so plainly and just add the
test — but verify it against <video>, don't infer it from the mediabunny comparison
passing.

=== PART 2: the PlaybackEngine port ===

Define the port at src/media/playback/PlaybackEngine.ts. This exists so a WebCodecs
compositing engine can replace it in M6 without the timeline noticing.

  type PlaybackState = 'idle' | 'loading' | 'ready' | 'playing' | 'seeking' | 'ended' | 'error'

  interface PlaybackEngine {
    load(file: File, index: SampleIndex): Promise<Result<void, PlaybackError>>
    play(): void
    pause(): void
    seek(time: Time, mode: 'accurate' | 'scrub'): Promise<void>
    stepFrames(n: number): Promise<void>
    setPlaybackRate(rate: number): void      // J/K/L shuttle needs this
    readonly state: PlaybackState
    readonly currentTime: Time               // presentation time, integer timescale units
    onFrame(cb: (t: Time, frameIndex: number) => void): Unsubscribe
    onStateChange(cb: (s: PlaybackState) => void): Unsubscribe
    dispose(): void
  }

Times are integer timescale units, never float seconds — same rule as task 1.

=== PART 3: the testability seam (mirror task 1's ByteSource) ===

The seek-coalescing state machine and the frame-stepping arithmetic are pure logic and
must be testable in Node without a browser. Define a minimal port:

  interface VideoElementLike {
    currentTime: number
    readonly duration: number
    readonly paused: boolean
    playbackRate: number
    play(): Promise<void>
    pause(): void
    addEventListener(type, cb): void
    removeEventListener(type, cb): void
    fastSeek?(time: number): void
    requestVideoFrameCallback?(cb): number
    cancelVideoFrameCallback?(handle: number): void
  }

Real implementation wraps HTMLVideoElement. A FakeVideoElement in tests lets you
simulate configurable seek latency, out-of-order 'seeked' events, and seeks that never
resolve. This is the same trick ByteSource played for the parser, and for the same
reason: the interesting bugs live in the edge cases, and edge cases need to be cheap
to construct.

=== PART 4: NativeVideoEngine ===

  - Load via URL.createObjectURL(file). Revoke it in dispose() — an un-revoked object
    URL pins the entire File and its resources for the lifetime of the document.
  - Playhead sync via requestVideoFrameCallback, which reports the actual presented
    mediaTime. Do NOT use 'timeupdate' — it fires roughly 4x/second and is useless for
    an editor. Feature-detect and fall back to rAF + currentTime, and record in the
    engine's state which path is active so the UI can degrade honestly.
  - rVFC also reports presentedFrames. Track it to detect dropped frames during
    playback and expose the count — useful diagnostics for a 4K60 source.
  - Explicit state machine. Every transition enumerated, illegal transitions rejected
    rather than tolerated. Seeking while seeking, playing while loading, and disposing
    mid-seek all need defined behaviour.
  - Error surface as a discriminated union like task 1's IndexError:
    'unsupported-codec' (canPlayType says no), 'decode-error' (video element error
    event), 'load-failed', 'aborted'.

Codec support check: before creating the object URL, use the index's codec string with
video.canPlayType() and report 'unsupported-codec' cleanly. Per architecture v2, a
source the browser cannot preview can still be TRIMMED, so this must be a distinct
recoverable state, not a fatal load error. The engine reports it; the app decides.

=== PART 5: seek coalescing ===

Measured baseline: <video> seek on the 27GB fixture averages ~220ms. At 60Hz drag
input that is roughly thirteen seek requests arriving per completed seek. Without
coalescing, seeks queue and the playhead falls seconds behind.

Implement a single pending target:
  - hold one `pendingSeekTarget`, overwritten by each new request
  - issue a seek only when no seek is in flight
  - on 'seeked', if pendingSeekTarget differs from what was just satisfied, issue the
    next one immediately
  - scrub mode uses fastSeek() where available (Safari and Firefox implement it;
    Chrome does not — feature-detect, don't assume), accurate mode always sets
    currentTime

THE CORRECTNESS PROPERTY, and the thing to test hardest: after input stops, the engine
MUST converge on the final requested position. Dropping intermediate seeks is the
point; dropping the last one is a bug. Write a test with the FakeVideoElement that
fires 200 seek requests over simulated time and asserts final position equals last
requested position, including the case where the last request arrives while a seek is
already in flight.

Note: this task will NOT produce smooth drag-scrubbing — that needs the frame cache
from task 3. Expect visible lag during a drag. The bar here is convergence and no
queue backlog, not smoothness.

=== PART 6: frame stepping ===

Step off the real PTS list, never `currentTime += 1/fps`. The fixture is 59.94fps and
vfr-screen.mp4 is genuinely variable; assuming a constant frame rate is wrong on both.

  - frameAtTime(current) -> n
  - target = pts[n + delta]
  - seek to target + epsilon, where epsilon is half the duration of the frame at the
    target (computed from pts deltas, not from a nominal fps) — this defeats float
    rounding at the currentTime boundary, which otherwise lands you on the previous
    frame roughly half the time
  - clamp at first and last frame, no wraparound, no error

THE CORRECTNESS TEST: from an arbitrary starting frame, step forward 10 and back 10;
you must land on the byte-identical starting frame, verified by frame index, not by
timestamp proximity. Run it from 20 different starting points including one inside a
B-frame run and one immediately after a keyframe. Then run the same test against
vfr-screen.mp4.

=== PART 7: harness ===

Extend the existing manual harness with a playback page. Load the 27GB fixture and
show: current timecode, current frame index, engine state, sync path in use (rVFC or
rAF), dropped frame count, and a scrub slider. Buttons for step ±1, ±10, seek to
random, and a "fire 200 seeks" convergence check.

Record and report:
  - seek latency distribution with coalescing active: p50, p95, p99, max
  - convergence: final position vs last requested, across 20 drag simulations
  - step round-trip accuracy: pass/fail across the 20 starting points
  - rVFC mediaTime vs currentTime drift during 60s of continuous playback
  - the edit-list delta table from Part 1

=== DO NOT BUILD ===

  - timeline UI, canvas rendering, thumbnails, waveform — tasks 3 and 4
  - WebCodecs anything — task 3
  - MediaSource — not until multi-clip, per architecture v2
  - multi-clip or EDL structures — M5
  - drag-scrub frame cache — task 3

=== DELIVERABLE ===

src/media/playback/ with the port, NativeVideoEngine, the VideoElementLike seam and
its fake, tests green, CI running. Plus a short README covering the state machine, the
coalescing invariant, and — most importantly — the resolved answer to Part 1 and which
time base is canonical where.
```

---

## What to watch

**Part 1 can invalidate assumptions elsewhere.** If the delta turns out to vary rather than being a constant offset, stop and report before building on it — a varying discrepancy means something is wrong in either the index or the edit-list interpretation, and it would corrupt every trim point downstream.

**The convergence test is the one that matters in Part 5.** Coalescing that drops intermediate seeks is correct; coalescing that drops the *final* seek leaves the playhead somewhere the user didn't ask for, and it only shows up under fast input, which is exactly when nobody is looking carefully.

**The step round-trip test is deceptively strict on purpose.** Forward-ten-back-ten landing on the same frame index catches epsilon bugs, off-by-ones in `frameAtTime`, and B-frame ordering mistakes in one assertion.
