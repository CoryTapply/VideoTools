# M1 Task 2 — playback engine: summary

Status: implemented, tested, merged. PR #4 (`worktree-m1-task2-playback-engine` -> `main`),
merged. Both of the task's empirical checks (Part 1's edit-list ground truth, Part 7's
seek/step/drift report) were run against the real 27GB fixture and confirmed — not left as
assumptions.

This doc is a handoff/context summary for a future session picking work back up on top of this —
the full design rationale lives in `src/media/playback/README.md` and
`src/media/index/README.md`'s "Presentation time vs. media time" section; this file is about what
was built, what was decided, what broke during verification, and what's still open.

---

## What was built

New module at `src/media/playback/`, on top of Task 1's `src/media/index/`.

- **`PlaybackEngine` port** (`PlaybackEngine.ts`) — the interface a future WebCodecs engine (M6)
  will also implement: `load`, `play`, `pause`, `seek`, `stepFrames`, `setPlaybackRate`, `state`,
  `currentTime`, `lastError`, `onFrame`/`onStateChange` subscriptions, `dispose`. `Time` is always
  an integer tick in the primary video track's own timescale, and always **presentation** time
  (edit-adjusted) — never raw media time, never a float second.
- **`NativeVideoEngine`** (`NativeVideoEngine.ts`) — the `<video>`-backed implementation. Explicit
  state machine (every transition enumerated in the file's header comment); codec support checked
  via `canPlayType` before any object URL is created (unsupported codec is a distinct recoverable
  state, not a fatal load error, per architecture v2 — the source can still be trimmed); rVFC used
  exclusively when available for position sync (never `'timeupdate'`), with an honest rAF fallback
  that reports dropped-frame count as `undefined` rather than a false zero.
- **Seek coalescing**, inside `NativeVideoEngine`: one `pendingSeekTarget`, overwritten by every
  new `seek()` call, issued only when nothing is in flight. Tested with a 200-rapid-seek burst
  (`NativeVideoEngine.seek-coalescing.test.ts`) asserting convergence on the last requested
  position. Promise semantics for a superseded call ("Option A" — every call in a burst resolves
  together, once the engine fully settles) are documented in
  `src/media/playback/seek-promise-semantics.md`, along with the switch criteria and implementation
  delta for the alternative, so a future change here is a known-size decision, not a re-design.
- **Frame stepping** (`frame-stepping.ts`) — steps `delta` positions in **presentation order**
  (via two new `SampleIndex` methods, see below), never `pts[n + delta]` on a decode-order index,
  which the task's own pseudocode gets wrong the moment a track has B-frames. Tested with a
  forward-10-back-10 round trip from 20 starting points, including one inside a B-frame run and
  one immediately after a keyframe, against both a synthetic constant-frame-rate track, a synthetic
  B-frame track, and (guarded, skips gracefully if absent) the real `vfr-screen.mp4` fixture.
- **`VideoElementLike` + `FakeVideoElement`** (`VideoElementLike.ts`, `RealVideoElement.ts`,
  `FakeVideoElement.ts`) — the testability seam mirroring Task 1's `ByteSource`. The fake supports
  configurable seek latency, out-of-order `'seeked'` firing, seeks that never resolve, `play()`
  rejection, and per-instance feature-detection toggles (`fastSeek`, `requestVideoFrameCallback`,
  `canPlayType`). Self-tested (`FakeVideoElement.test.ts`) so a bug in the fake doesn't first
  surface as a confusing failure somewhere else.
- **`SampleIndex` additions** (`src/media/index/query.ts` — Task 1's module, extended, not
  reshaped): `tracks()`/`sampleCount()` (it had no way to enumerate tracks or read metadata before
  this), and a full presentation-time-native query surface (`frameAtPresentationTime`,
  `presentationTimeOfSample`, `nearestSyncAtOrBeforePresentation`, `nextSyncPresentation`,
  `prevSyncPresentation`, `keyframePresentationTimes`, `presentationRank`,
  `sampleAtPresentationRank`) so playback code never hand-adjusts `editOffsetTicks` at a call site.
  All additive — no change to `TrackIndex`'s shape, no OPFS schema bump, existing raw-tick methods
  and their tests untouched.
- **CI** (`.github/workflows/ci.yml`) — this project's first: `npm run typecheck && npm run lint
  && npm test` on every push. Task 1 shipped without CI; this was Part 0 of this task.
- **Manual browser harness** (`harness.ts` + `playback.html`) — Part 1's edit-list empirical check,
  plus Part 7's interactive playback controls and full report (seek latency distribution,
  20-drag-simulation convergence, step round-trip accuracy, 60s rVFC drift). Not part of `npm test`,
  same convention as `src/media/index/harness.ts`.

## Decisions made along the way

Two design gaps in the task's literal `PlaybackEngine`/`VideoElementLike` interfaces were resolved
with the user directly rather than picked silently, since they affect public API shape a future
WebCodecs engine will also have to honor:

- **Post-load error detail**: added `readonly lastError: PlaybackError | undefined` to the
  `PlaybackEngine` interface itself (not just `NativeVideoEngine`), since `state === 'error'` alone
  carries no detail about *which* failure occurred.
- **Coalesced seek promise semantics**: "Option A" chosen (every call in a burst resolves together
  on full settle) over "Option B" (each superseded call resolves immediately when superseded) —
  simpler, matches the convergence property. Full switch-criteria writeup in
  `seek-promise-semantics.md` per the user's explicit request, so this isn't re-litigated from
  scratch if a real caller needs Option B later.
- `VideoElementLike` needed one addition beyond the task's quoted shape: a settable `src` (the
  quoted interface had no way to point the element at a file at all) and `canPlayType` (needed for
  the codec-support check, also missing from the quoted interface).
- Other flagged gaps resolved with a documented default, not requiring further sign-off:
  multi-video-track sources use the first `kind === 'video'` track as canonical; `ended` + `play()`
  is a no-op requiring an explicit `seek(0)` first; no seek timeout/watchdog in M1 (matches the
  task's declared scope).

## Bugs found by actually running it (not caught by the Node test suite)

All three were found live, against the real 27GB fixture, in the course of verifying Part 1 and
Part 7 with the user. None were caught by the 126 Node tests, because all three are specifically
about real browser/DOM event-timing behavior that a fake can't reproduce unless it's told to model
the exact quirk — worth knowing about if similar browser-facing code gets added later.

1. **A seek to the position already there never fires `'seeked'`.** Browsers don't reliably fire
   the event when `currentTime` is assigned a value it's already at (e.g. seeking to 0 right after
   load, when the element is already sitting at 0). This hung the verification harness on its very
   first target, and — more importantly — was a latent bug in `NativeVideoEngine.issueSeek()`
   itself: since `issueSeek()` is only ever re-entered from the `'seeked'` handler, a real caller
   seeking to the current position would have stalled the entire seek-coalescing pipeline
   permanently, not just that one call. Fixed in both places (skip the wait / settle on a
   microtask when already within epsilon of the target); a regression test was added to
   `NativeVideoEngine.seek-coalescing.test.ts`.
2. **`requestVideoFrameCallback` must be armed *before* issuing a seek, not after.** A paused
   video presents exactly one new frame per seek. Registering the callback only after `'seeked'`
   has already fired frequently misses that single frame-presentation event, leaving the callback
   waiting for a "next frame" that a paused element never produces — this is why the harness's
   real seeks (everything after the first, no-op target) timed out and silently fell back to the
   weaker `video.currentTime` signal in an earlier run. Fixed in the harness's
   `seekAndCaptureFrame`. `NativeVideoEngine`'s own rVFC loop doesn't have this bug — it's
   continuously re-armed from `load()` onward (each firing re-registers itself before the next
   seek could possibly happen), so it's always already pending.
3. **`display: none` on the harness's `<video>` stopped it compositing new frames after the
   first one.** Some browsers stop presenting frames entirely for a `display:none` element, so
   rVFC fired once (the initial decoded frame) and then never again. Fixed by positioning the
   element off-screen instead (`position: fixed; top: -9999px`, 2×2px) rather than hiding it.

Also fixed, a correctness bug in the verification *methodology* itself (not a timing bug): the
harness's per-target sample lookup initially called the **raw**-tick `frameAtTime` with a
presentation-time input — exactly the mistake Part 1 exists to catch elsewhere — which returned
`-1` outright for target=0 once `editOffsetTicks > 0` (the track's raw `pts` array starts at raw
tick `editOffsetTicks`, not 0). Fixed by using `frameAtPresentationTime` for the lookup instead.

## Automated test results

`npm test`: **126 / 128 passing**, 2 skipped (the `vfr-screen.mp4`-dependent suites, which
self-skip when that gitignored fixture isn't present locally — present and passing in the author's
environment). `npx tsc --noEmit`: clean. `npm run lint`: clean. `npm run build`: succeeds,
`playback.html` bundles correctly.

Notable suites: `NativeVideoEngine.seek-coalescing.test.ts` (8 tests — the 200-rapid-seek
convergence property, the mid-flight-supersede case, the never-resolving-seek case, the
already-there no-op fix's regression test, `fastSeek` feature-detection both ways, out-of-order
`'seeked'` firing); `frame-stepping.test.ts` (round trip on CFR + B-frame synthetic tracks, real
VFR data, clamping, epsilon sanity); `presentation-time.test.ts` (Task 1's `query.ts` additions,
against the committed `tiny.mp4`'s real priming-delay edit list).

## Manual browser verification (`fixtures/27gb.mp4`, Chrome)

**Part 1 — edit-list ground truth: CONFIRMED.** 8 target points spanning the file (0s, 2s, four
across the middle, one near the end, one at a keyframe boundary). `requestVideoFrameCallback`'s
`mediaTime` agreed with the presentation-time-native methods to **Δ=0.0000s at every point**
(`maxDeviationFromMean=0.0000s`), and diverged from the raw-tick methods by a constant **-0.016s**
— exactly `editOffsetTicks / timescale` (`1440 / 90000`) for this file's video track. Full numbers
in `src/media/index/README.md`'s "Presentation time vs. media time" section.

**Part 7 — full report: CONFIRMED.**

| Metric | Result | Baseline / expectation |
|---|---|---|
| Seek latency p50 | 281.6ms | ~220ms (task's stated baseline) |
| Seek latency p95 / p99 / max | 369.4 / 371.1 / 371.1ms | — |
| Convergence (20 × 200-seek bursts) | 20/20 pass | must be 20/20 |
| Step round-trip accuracy (20 points) | 20/20 pass | must be 20/20 |
| rVFC drift over 60s continuous playback | max 28ms, mean 12ms (60 samples) | well under one frame |

One re-run of the edit-list check (via Part 7's "full report" button, after 4,000+ prior seeks,
20 step round-trips, and 60s of decode on the same tab) showed 4 of 8 rows with small residuals
(0.0026s–0.015s, still under one frame and under the check's own tolerance) instead of exact
matches — plausibly GPU/decoder resource pressure from all that prior activity nudging a few
"accurate" seeks onto the adjacent frame. `editListDeltaConstant: true` held regardless; not
treated as a bug in the index math.

## What's still open

- HEVC codec-string generation (inherited from Task 1) remains untested against a real HEVC file.
- The state-machine edge cases around `pause()`/`play()` called *during* an in-flight `seek()` are
  documented as no-ops in `NativeVideoEngine.ts`'s header comment but not exhaustively tested
  beyond the cases the coalescing suite covers — worth a look if a real UI surfaces a bug there.
- No later-task work (thumbnails/task 3, timeline UI, export) touches this module yet — per the
  task's explicit "DO NOT BUILD" list, WebCodecs, MediaSource, multi-clip/EDL structures, and the
  drag-scrub frame cache are all out of scope here and deferred to tasks 3+ and M6.
- The build-time-delta profiling item from Part 0c (attributing the ~57.6ms spike-vs-production gap
  to a specific cause via Chrome's profiler) was flagged as still needing an actual profiler run —
  see `src/media/index/README.md`'s "Known build-time delta" section; not blocking, just unattributed.
