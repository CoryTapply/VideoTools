# Live audio-mix Phase 1: real-browser session notes

Closes out the plan doc's "Real-browser verification (mandatory, and cannot be done through this
session's browser automation)" section for `src/media/audio-mix/`'s Phase 1 (`LiveAudioMixer`,
`window-jobs.ts`, the `audio-mix.html` harness). Run by a human directly, not `claude-in-chrome`
automation: an earlier attempt to use that tooling for this feature found the automation tab's
`<video>` element stuck at `readyState: 0` (`document.visibilityState` reports `'hidden'` in that
context, which appears to stall media loading entirely) — confirmed separately, before this
session, as the reason the initial `HTMLMediaElement.audioTracks`-availability check had to be read
as a plain DOM-property-existence test rather than a real playback test. Real playback/sync/drift
verification needed a normal, focused window the whole way through.

## Why this module exists at all

The original ask ("mute an audio track in preview when it's unchecked in the Export panel")
couldn't be built on the obvious mechanism: **Chrome has never implemented
`HTMLMediaElement.audioTracks`/`videoTracks`** — confirmed empirically against a real Chrome 151
instance:

```js
'audioTracks' in HTMLMediaElement.prototype // false
Object.getOwnPropertyNames(HTMLMediaElement.prototype).filter(p => /track/i.test(p))
// -> ["textTracks", "addTextTrack"]
```

With no native per-track control available, the only way to get real per-track audio control is to
stop delegating sound to `<video>` and decode+mix it independently via WebCodecs `AudioDecoder` +
Web Audio — the architecture this project's own `roadmap.md` reserves for the open-ended M6
milestone. Phase 1's scope, deliberately narrow: prove that mechanism (decode one track, play it
through a real Web Audio graph, stay in sync with an external clock) actually works, via a
standalone harness, before wiring anything into the real app.

## Fixture

`fixtures/27gb.mp4` — the project's existing six-independent-audio-track stress fixture (1 video +
6 stereo AAC tracks, ~70min/track, previously characterized in
`results/m2-waveform-real-browser-session.md`). Used directly, not a smaller stand-in, specifically
because Phase 1's highest-priority open question (mid-file AAC decode-start) needed real
multi-track content at scale to mean anything. A smaller synthetic 2-tone fixture
(`fixtures/tiny-2audio.mp4`, 440Hz/880Hz on two tracks, generated via `scripts/make-fixtures.sh`)
was used for the first pass of manual verification before moving to the stress fixture.

## Bugs found this session, in the order they surfaced

Every one of these was caught by a human actually listening to and watching the harness — none
would have been visible from code review alone, which is the point of this pass.

1. **Harness track-selection caching.** `ensureMixer()` cached the first `LiveAudioMixer` it built
   and returned it unconditionally on every later Play click, ignoring the track `<select>`'s
   current value. Symptom: switching the dropdown had no audible effect until a Pause+Play cycle
   coincidentally rebuilt state. Fixed by tracking the selected track's id and disposing/rebuilding
   the mixer whenever it changes.

2. **`seek()` while paused started audio.** `LiveAudioMixer.seek()` unconditionally called
   `start()`, which sets `playing = true` — so seeking a paused mixer made it audible, unlike a
   paused `<video>` whose `currentTime` can be repositioned without starting playback. Fixed:
   `seek()` is now a no-op unless already playing.

3. **Audible gap on every seek while playing.** The original `start()`/`seek()` stopped all
   currently-scheduled audio immediately, then decoded the new position — so every seek produced
   silence for exactly as long as that decode+file-read round trip took. Fixed with a
   `pendingCutover` flag: old audio keeps playing until the new window is actually decoded and
   ready, at which point `fillNextWindow()` performs the stop+schedule cutover atomically. Tradeoff
   accepted deliberately: briefly, stale pre-seek audio can keep playing a moment longer rather than
   going silent — judged far less jarring.

4. **Drift-correction self-interference during a cutover.** `reportMasterPosition()`'s periodic
   drift check, run from the harness's independent polling loop, would see the intentionally-stale
   position during an in-flight cutover, read it as enormous drift, and call `seek()` again —
   restarting the very decode it was waiting on, repeatedly, before it could ever finish. Fixed by
   suppressing the drift check while `pendingCutover` is true.

5. **Real race condition: seeks could be silently dropped entirely.** The original design spawned a
   *new* fill-loop invocation per `start()`/`seek()` call, guarded by a single shared
   `fillLoopRunning` flag. If a seek arrived before the old loop had a turn on the event loop to
   notice its generation was stale, the new loop's launch saw the flag still held and no-op'd —
   permanently orphaning that seek. Observed directly: seeking to 500s (later 800s) played
   whatever was already buffered from the old position (a few seconds, matching
   `LOOKAHEAD_SECONDS`) and then went silent forever, while the driving `<video>` kept advancing
   normally. Fixed by replacing the per-call spawned loop with a single loop started once, for the
   mixer's entire lifetime, that re-reads `playing`/`pendingCutover`/`generation` fresh every
   iteration — nothing left to race.

6. **Many small file reads per window.** `fillNextWindow()` originally issued one
   `file.slice().arrayBuffer()` call *per AAC sample* (~65-70 calls for a 1.5s window at ~21ms
   frames), all in parallel via `Promise.all`. Against a 27GB file this plausibly caused occasional
   multi-second I/O stalls, observed as two spontaneous ~3000ms drift spikes over a ~250s session.
   Fixed by computing one combined byte range spanning the whole window and issuing a single read,
   slicing individual sample bytes out of that one buffer in memory afterward.

7. **Stale `ctxStart` bookkeeping.** If a window's decode ever did fall behind real time,
   `node.start(ctxStart)` was called with a `ctxStart` already in the past — Web Audio silently
   clamps that to "now" internally, but the code's own `ScheduledChunk.ctxStart` kept the stale,
   pre-clamp value, corrupting later position estimates. Fixed by clamping
   `ctxStart = Math.max(nextScheduleAt, ctx.currentTime)` before it's ever recorded, matching what
   the browser actually does.

8. **Root cause of the remaining ~3000ms drift spikes.** Fixes 6 and 7 reduced but didn't eliminate
   two more spontaneous ~3000ms spikes (magnitude: almost exactly `2 x WINDOW_SECONDS`), appearing
   out of otherwise-clean steady-state playback with no seek nearby and self-reverting after one
   tick. Root cause: `estimatedPositionSeconds()`'s fallback path, reached whenever `now` didn't
   fall inside any scheduled chunk's `[ctxStart, ctxStart+duration)` range (a sub-millisecond gap
   between chunks, from floating-point rounding accumulating over hundreds of `nextScheduleAt +=
   buffer.duration` updates), grabbed `this.scheduled.at(-1)` — normally the *furthest-ahead*
   lookahead chunk (up to `LOOKAHEAD_SECONDS/WINDOW_SECONDS - 1` windows in the future), not the one
   actually playing. Fixed by scanning for the chunk with the largest `ctxStart <= now` instead of
   trusting array order/position.

## What's confirmed, after all eight fixes, across two long sessions against `fixtures/27gb.mp4`

- **Cold-start decode at arbitrary mid-file positions works cleanly** — seeked cold to 300s, 500s,
  800s repeatedly across both sessions; every one decoded and played correctly. This was Phase 1's
  single highest-priority open question (nothing in this codebase had verified AAC decode-start off
  `t=0` before this session) and it holds.
- **Seeking repeatedly while playing has no audible gap** — the cutover mechanism (fix 3) confirmed
  working as designed: old audio continues, new audio takes over the instant it's ready.
- **Seeking while paused correctly stays silent** (fix 2 confirmed).
- **Long continuous playback is clean.** Two sessions, ~264s and ~177s of largely uninterrupted
  playback each, zero dropouts after fix 8 landed. Steady-state drift settles into a tight ±20ms
  band; the periodic `reportMasterPosition()` resync (threshold 80ms) is confirmed firing correctly
  on the rare occasions drift approaches it.
- **Memory stayed flat** across a multi-minute session, by the user's direct Activity Monitor
  observation (qualitative — no numeric checkpoint captured this pass; see "What's still open").
- **Track switching works** (440Hz vs. 880Hz on `tiny-2audio.mp4`, confirmed audibly distinct once
  fix 1 landed).

## What's still open

- **A startup-settling transient**, not fully root-caused: in the first ~1-6 seconds after a fresh
  `start()`/`seek()`, drift has been observed dipping to roughly -150 to -220ms before self-correcting
  cleanly (no discontinuity, unlike the fixed spike bugs) — once via the normal resync path. Not
  investigated further this session; likely benign (self-heals within the existing drift-correction
  design) but worth a closer look if `WINDOW_SECONDS`/`DRIFT_THRESHOLD_SECONDS`/`FILL_POLL_MS` get
  tuned for Phase 2.
- **No numeric memory checkpoint recorded** the way `results/m2-waveform-real-browser-session.md`'s
  Part 3 did (real Task Manager / Activity Monitor readings before/after, saved to a results JSON).
  This session's "memory was flat" is a direct human observation, not a captured measurement.
- **Tuning constants never revisited**: `WINDOW_SECONDS` (1.5s), `LOOKAHEAD_SECONDS` (4.5s),
  `DRIFT_THRESHOLD_SECONDS` (80ms), `FILL_POLL_MS` (200ms) are all still at their original
  starting-point values from the initial implementation, unchanged despite everything above.
- Per the plan's explicit Phase 1 scope, still entirely undone and untouched this session:
  `AudioWorklet` delivery, worker-thread decode, true simultaneous multi-track mixing,
  playback-rate/shuttle sync, and any wiring into the real app (`NativeVideoEngine`, the Export
  panel's `sel`/`TrackSelection`, permanently muting the native `<video>`).

## Bottom line

The core mechanism works: independent WebCodecs `AudioDecoder` decode, scheduled through a real Web
Audio graph, stays in sync with an external clock across cold starts at arbitrary positions,
repeated seeks during playback, and multi-minute continuous playback, against the project's real
six-track 27GB stress fixture — not just a small synthetic one. Every failure mode this session
turned up (two design bugs, one real race condition, one performance issue, two bookkeeping bugs)
was found by a human actually running the harness, not by reasoning about the code in the abstract,
which is exactly why the plan scoped this as mandatory human verification rather than something to
skip. Phase 1's stated goal — prove the mechanism before wiring it into the real app — is met.
