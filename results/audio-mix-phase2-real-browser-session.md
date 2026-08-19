# Live audio-mix Phase 2: real-browser session notes

Closes out the Phase 2 plan doc's "Real-browser only" verification section for wiring
`src/media/audio-mix/` into the real app (`AudioMixEngine`, `useAudioMix`, the volume-slider
repointing, J/K/L shuttle handling). Run by a human directly in a normal focused Chrome window, not
`claude-in-chrome` automation, for the same reason as Phase 1: the automation tab's `<video>`
element never leaves `readyState: 0` (`document.visibilityState: 'hidden'` in that context appears
to stall real media loading entirely).

## What this session covered

Five scenarios from the plan's real-browser checklist, run against the real app (`app.html`), not
the standalone harness:

1. **Single-track pass on `fixtures/27gb.mp4`** — native `<video>` produces no sound, only the
   checked track is audible, play/pause/seek/keyframe-jump/scrub-release all stay in sync.
2. **All 6 audio tracks checked simultaneously, several minutes of playback** — the scenario Phase 1
   never ran (it only ever exercised one track at a time). Watched for per-track glitches, dropped
   video frames from six concurrent decode+fill loops contending with video rendering, and memory
   growth.
3. **File-switching mid-playback** — opening a new file before the previous one's audio-mix state
   had settled, checked for leaked `AudioContext`s or cross-file audio bleed.
4. **J/K/L shuttle** — mixers pausing cleanly during non-1x playback rate and resuming correctly at
   1x, exercising `AudioMixEngine.setPlaybackRateHint()` and the `handleKeyUp`/`shuttle-forward`
   wiring in `App.tsx`.
5. **Volume slider** — fast drags on the master gain with multiple tracks playing, checking for the
   audible "zipper" artifact `GainNode.gain.value = x`'s instantaneous step (vs. `<video>.volume`'s
   browser-smoothed one) could in principle produce.

**Result: all five confirmed working correctly**, no issues reported. Unlike Phase 1's session (run
with per-tick drift logging pasted back and analyzed in detail, which is how those bugs' exact root
causes — e.g. a spike magnitude landing on `2 x WINDOW_SECONDS` — were found), this pass was a
direct manual check across all five scenarios without capturing quantitative logs or numeric
readings. That means this doc can confirm the feature *works* as verified by ear/eye across every
scenario the plan called for, but doesn't carry the same kind of measured evidence (steady-state
drift figures, dropped-frame counts, before/after memory numbers) Phase 1's document does. If a
regression is ever suspected in one of these five areas, re-running with the harness's own drift
logging (or `NativeVideoEngine.droppedFrameCount`, already exposed) re-enabled would give that same
level of detail again.

## What's still open

Nothing from the Phase 2 plan's verification checklist remains outstanding. Constants
(`WINDOW_SECONDS`, `LOOKAHEAD_SECONDS`, `DRIFT_THRESHOLD_SECONDS`, `FILL_POLL_MS`) are still at their
original Phase 1 starting-point values, never retuned — unaffected by this pass since nothing
here surfaced a reason to. The startup-settling transient noted in Phase 1's own results doc
(brief drift dip in the first ~1-6s after a cold start/seek) was not specifically re-examined here.

## Bottom line

The live per-track audio preview feature is complete and verified end-to-end: the original ask
(checking/unchecking a track in the Export panel mutes/unmutes it live during preview) now works in
the real app, including the harder cases Phase 1 could only prove in isolation — real
`NativeVideoEngine` sync, multiple simultaneous tracks, file-switching, variable-rate shuttle, and
the repurposed master-volume control. No known open bugs.
