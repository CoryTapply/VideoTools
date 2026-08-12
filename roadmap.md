# Roadmap

**Last updated:** after M1 task 4c.
Companion to `architecture-v3.md` and `PROJECT-CONTEXT.md`.

---

## Status at a glance

| Phase | Scope | Status |
|---|---|---|
| M0 | Feasibility spikes | ✔ complete |
| M0.5 | Remux, index at scale, WebCodecs scrub | ✔ complete |
| T0 | Export cost diagnosis + merged read pass | ✔ complete |
| **M1** | **Walking skeleton — open, scrub, trim, export** | **7 of 8 tasks done** |
| M2 | Timeline polish | not started |
| M3 | Frame accuracy (smart render) | not started |
| M4 | Production hardening | not started |
| M5 | Editor foundations | not started |
| M6 | Multi-track | not started |

---

## M1 — walking skeleton

Trim a real clip out of a 27 GB file, end to end.

### ✔ Task 1 — production parser and sample index
`src/media/index/`. `ByteSource` seam, typed-array `TrackIndex`, query API, error union, fMP4/encrypted detection, OPFS cache, worker wrapper. Differential-tested against mediabunny and the spike parser. Resolved the 1-frame boundary discrepancy: decode-order forward scan vs presentation-order binary search, divergent under B-frame reordering.

### ✔ Task 2 — playback engine
`src/media/playback/`. `PlaybackEngine` port, `NativeVideoEngine`, seek coalescing with a proven convergence property, presentation-order frame stepping, `VideoElementLike` seam. Established presentation time as canonical. CI added.

### ✔ Task 3 — frame cache
`src/media/frames/`. Two-tier cache serving both the filmstrip and the scrub preview, worker pool, atlas storage with the decode-once rule, byte-budgeted LRU, structural frame lifecycle safety. Coarse warm 5.19 s, `getNearest()` p50 0.000 ms, leak-free across 20 warm/clear cycles confirmed by two independent signals.

### ✔ Task 3.5 — budget re-tune
Small but load-bearing. Log LRU eviction count and `liveCount` at each Activity Monitor checkpoint, repeat the memory run with pauses between readings, and determine whether the dense-warm memory drop is transient buffers or coarse-tier eviction. If eviction: give the coarse tier a protected reservation so a transient dense window can't evict the scrub source. Re-tune `DEFAULT_BUDGET_BYTES` against the real ~2× multiplier.

**Status: done.** Real Activity Monitor re-runs against the 27GB fixture at both
`denseWindowSeconds: 5` (reproducing the original setup) and `30` (production's default) both show
`evictionCount: 0` and `coarseResidentCount` unchanged (1015 → 1015) across the coarse-warm →
dense-warm transition — the dense-warm memory drop is **not coarse-tier eviction**. The drop is
~170MB in both runs despite a 6x difference in dense-tier work (20 vs. 120 dense frames), which
doesn't scale with anything the cache itself does — consistent with transient decode/atlas buffers
from the coarse warm's own pack/write/read/decode round trip settling out by the time of the
dense-warm reading, not with anything eviction-shaped. No conditional `coarseLru`/`denseLru` split
needed. Real numbers: `results/task-3-frame-cache-summary.md`'s "Part B.2" section.

One follow-up surfaced by the same runs: real coarse-tier memory cost (idle → coarse-warm) was
+199MB/+202MB against a nominal `totalBytes` of ~58MB, a **~3.4x** real/nominal ratio — higher than
the original ~2.1x finding. `DEFAULT_BUDGET_BYTES` (96MB) is compared against nominal bytes, which
never exceeded 86MB in either run even as real memory passed 350MB, so the budget isn't yet
providing real protection at production scale. Left as `src/media/frames/README.md`'s documented
calibration data rather than silently bumped — an unvalidated single-machine multiplier isn't a
basis for picking a new production constant.

**Exit: met.** The anomaly has an explanation backed by a number (`evictionCount: 0`,
`coarseResidentCount` unchanged), not an inference.

### ✔ Task 4a — app shell and design system
React shell, layout regions, design tokens transcribed from the Claude Design output, rail and floating panels, transport bar, status bar, empty state, splitter. Consumes `design/README.md` and its deltas list.

**Status: done.** `src/ui/` — tokens (`tokens.ts`, sole hex-literal source, enforced by a
`tokens.test.ts` scanner), six DOM-free state modules, the full chrome (title bar, transport bar,
status bar, splitter, rail, floating/pinned panels, three panel bodies, empty/unsupported states,
export overlay/toast, keyboard overlay), and a `ui-harness.html` dev harness for driving every
screen/panel/notice variant. All eight `screen` states plus the split `permissionLost` flag render
with placeholder content (real media/export data is still fixtures — later tasks' job). Manually
verified in-browser against all 13 `design/screens/*.png` references via the harness; 341
tests (`npm run typecheck && npm run lint && npm test` all clean). Full writeup:
`results/task-4a-app-shell-summary.md`.

The timeline canvas itself is untouched — `TimelineRegion` is a correctly-sized placeholder with
no `<canvas>`, no zoom/pan/drag-scrub. That's Task 4b, next.

**Exit: met.** The shell renders every M1 state with placeholder content; `tokens.ts` is the only
source of colour in `src/ui/`.

**Follow-up, done immediately after:** real file selection (input + drag-and-drop), real parsing
(`IndexWorkerClient`), and real playback (`NativeVideoEngine`) wired into the shell — Task 1 and
Task 2's modules connected to the UI for the first time. Every panel number that was fixture-only
above is now real once a file is open; `ui-harness.html` is unaffected (fixture data is now the
*fallback* when no file is open, not the only source). Full writeup:
`results/task-4a-media-integration-summary.md`.

### ✔ Task 4b — timeline renderer
Canvas layer stack. Viewport transform in presentation ticks, cursor-anchored zoom, kinetic pan. Ruler with adaptive tick density, keyframe tick row, filmstrip from `getRange()`, in/out handles with snapping, playhead on `onFrame`. Cache-backed drag scrub with a single settle seek on pointer-up.

**Status: done.** Merged to `main` via PR #12 (`81965c7`). New `src/ui/timeline/` module: viewport
transform, ruler ticks, keyframe density, snap, drag/wheel/kinetic-pan gesture handling, canvas
draw layers (ruler, keyframe row, filmstrip, handles, playhead, snap-flash, scrub-preview), and
`TimelineController.ts`, plus `useTimelineController.ts` and `shuttle.ts` state modules.
`timeline-controller-state.ts` moved from seconds to presentation ticks — a documented deviation
from `design/README.md`'s stale seconds-typed table (see `src/ui/README.md`). 487 tests,
typecheck/lint clean, both CI checks green before merge. Post-merge bugfix (PR #13, `7e0f5ad`): J
(reverse shuttle) originally set a negative `<video>.playbackRate`, which no browser supports and
silently did nothing — fixed by driving reverse manually via an rAF loop calling `engine.seek()`,
relying on `NativeVideoEngine`'s seek-coalescing.

**Exit: met.** 60 Hz interaction confirmed across the full timeline of the 27 GB fixture at every
zoom level; the filmstrip does not empty when zooming.

**Known gaps, honestly flagged:**
- The specific "seek lands one frame off after heavy decoder activity" repro that
  `architecture-v3.md` asks this task to characterize couldn't be conclusively exercised — the
  tiny test fixture never finishes loading in native `<video>`, and the browser automation tab
  throttles `requestAnimationFrame` almost to zero. This needs a real focused browser session with
  a proper fixture.
- Kinetic-pan friction (`COAST_FRICTION_PER_FRAME = 0.94` in `kinetic-pan.ts`) and the shuttle-key
  acceleration curve (`shuttle.ts`) are both invented first passes — flagged in-code as needing a
  human feel-check on real hardware, not values from any spec.

Both are picked up by Task 4c, next.

### ✔ Task 4c — timeline feel calibration and seek-drift repro (½–1 day)
Close the two gaps Task 4b flagged rather than let them ride silently into Task 5.

1. Conclusively reproduce and characterize the "seek lands one frame off after heavy decoder
   activity" behavior `architecture-v3.md` asks this task to explain. Needs a real, non-automated
   browser session against a fixture that actually finishes loading in native `<video>` — the tiny
   test fixture used during 4b never did, and the `claude-in-chrome` automation tab throttles
   `requestAnimationFrame` nearly to zero, which made this impossible to exercise conclusively
   during 4b.
2. Human feel-check of kinetic-pan friction (`COAST_FRICTION_PER_FRAME = 0.94` in `kinetic-pan.ts`)
   and the shuttle-key acceleration curve (`shuttle.ts`) on real hardware, confirming or retuning
   both — they're invented first passes, not values derived from any spec.

**Status: done.** Since neither half of this task can be exercised by automation (rAF throttling;
the tiny fixture never loads), the app was instrumented so one real-hardware session could answer
both self-sufficiently rather than relying on eyeballing: `src/ui/timeline/seek-drift.ts` compares
every real settle-seek's requested vs. landed frame index (via `TimelineController`'s existing
settle-seek call site) and logs to `window.__seekDriftLog`/`console.warn`, dev-only, fully
dead-code-eliminated from production builds; `kinetic-pan.ts`'s and `shuttle.ts`'s constants became
live-editable via `window.__tuning` so values could be tried without rebuilding. Session guide:
`results/task-4c-session-guide.md`.

**1. Seek-drift repro: did not reproduce.** ~1 minute of real mixed scrubbing/scrolling/zooming on
each of `fixtures/mid-1080p.mp4` and `fixtures/27gb.mp4` produced 51 real settle-seeks total,
including several tight clusters of rapid re-scrubs in the same region (e.g. eight settle-seeks
within a ~250k-tick span on the 27GB fixture) — the kind of repeated decoder pressure
`architecture-v3.md`'s "heavy decoder activity" points at. `framesOff` was 0 on every single one;
`video.currentTime` landed on the requested frame every time. Not exhaustive (short session,
one machine), but zero drift across real, non-automated interaction including the specific
decoder-pressure pattern the risk register described is a real result, not an absence of trying.
Left instrumented (dev-only, zero prod cost) rather than removed, in case it resurfaces under
longer or different real usage.

**2. Kinetic-pan/shuttle: confirmed and retuned by a human on real hardware.**
`coastFrictionPerFrame` retuned **0.94 → 0.1** — the original guess coasted far too long on a real
trackpad; 0.1 kills velocity almost immediately after the gesture ends, closer to the reference
prototype's original 1:1-no-momentum feel than to real inertial coasting. Shuttle's doubling curve
(`BASE_RATE = 1`, `MAX_RATE = 8`, `shuttle.ts`) confirmed as-is, no change.

**Exit: met.** The one-frame-off repro has a written explanation of why it doesn't reproduce under
real, non-automated conditions (above); kinetic-pan and shuttle acceleration are confirmed/retuned
by a human using the actual app on real hardware, not left as first-guess constants.

### ▸ Task 5 — export (1 week)
`RemuxStrategy` promoted with the merged single-pass copy loop. Track selection UI. Temp-name-and-rename write. Progress from the measured `copy_ms`/`close_ms` split with an explicit finalising phase. Cancel.

Must use `sampleRange` from `query.ts`, never port `select.ts`.

**Exit:** all M1 exit criteria below.

### M1 exit criteria

- Trim a 30-second clip from the 27 GB fixture; output plays in VLC, QuickTime, and Chrome
- Peak process memory under 500 MB, measured at OS level
- Drag-scrub sustains 60 Hz across the full timeline once coarse is warm
- Coarse cache warms in under 15 s (currently 5.19 s)
- Multi-track audio selection works; exporting only the mic track produces a valid file
- Cancelling an export never damages an existing file

---

## M2 — timeline polish (3 weeks)

Dense-tier tuning on zoom. Waveform: demux the audio track and stream it through `AudioDecoder` in a worker, reducing to a peak pyramid in OPFS. **Never `decodeAudioData`** — four hours of 48 kHz stereo float32 is ~5.5 GB.

Drop-frame timecode (29.97/59.94 display format, not a time base). Full keyboard map and the `?` overlay. Metadata inspector.

---

## M3 — frame accuracy (4 weeks)

Smart render: re-encode only the leading partial GOP, stream-copy the rest. This is the **only** re-encode path in the product, and the WebCodecs encoder exists solely to serve it.

Worth more than originally weighted: real GOP is 4.166 s, so a snapped cut lands up to four seconds early — very visible. Also worth possibly *not* building: if the keyframe-shift notice proves good enough in practice, this is deferrable indefinitely.

Hazards: parameter-set mismatch may need a second `stsd` entry or in-band SPS/PPS; a bitrate seam at the join; `avcC` length-prefixed vs Annex B bitstream differences. Also evaluate the `elst` edit-list trim as a zero-re-encode option — frame-exact but with inconsistent downstream player support, so opt-in at best.

---

## M4 — production hardening (3 weeks)

Capability detection and degradation paths. ffmpeg.wasm tier-4 fallback behind a lazy chunk. Error taxonomy with actionable messages. Stress matrix: VFR, rotated, HDR, 8-hour, B-frame-heavy, 4:2:2, fragmented MP4, HEVC.

**Lower-spec hardware baseline.** Every number in this project comes from one M1 Max with fast NVMe. Export throughput and cache warm times will degrade roughly with storage bandwidth and decode capability; a machine without hardware H.264 decode measured ~4× slower in spike C.

---

## M5 — editor foundations (6 weeks)

Multi-clip EDL on one track. Ripple and roll trim. Undo/redo via commands with drag coalescing. Batch trimming — a queue of ranges against one source. This is where the EDL model built in M1 pays for itself.

---

## M6 — multi-track (open-ended)

`CompositedEngine` — WebCodecs decode plus WebGPU compositing, implementing the same `PlaybackEngine` port so the timeline doesn't notice. Multiple video and audio tracks, transitions, mixing. This is where preview finally has to be rendered rather than delegated to `<video>`.

---

## Risk register

| Risk | Severity | State |
|---|---|---|
| Coarse tier evicted by dense windows, emptying the filmstrip | High | Suspected, unconfirmed — task 3.5 |
| Post-load seeks landing one frame off under decoder load | Low | Task 4c: did not reproduce across 51 real settle-seeks (mixed scrub/scroll/zoom, incl. rapid re-scrub clusters) on two real fixtures in a real, non-automated browser session. Not exhaustive (~1 min/fixture) — dev-only drift diagnostic left in place (`window.__seekDriftLog`) in case it resurfaces |
| Export `close()` copying rather than renaming — disk-full during finalising | Medium | Never observed; task 5 must handle the error case regardless |
| Real-world containers the parser rejects (fMP4 from OBS, MKV) | Medium | Detected and refused cleanly; product-scope question for M4 |
| All measurements from one fast machine | Medium | Accepted through M3; M4 addresses it |
| Smart render parameter matching proving harder than budgeted | Medium | M3; mitigated by being genuinely optional |
| HEVC path untested | Low | Flagged since task 1 |

---

## Scope boundaries

Firmly out, and not to be relitigated without new information: multi-resolution export, transcoding as a product feature, MKV or WebM containers, server-side anything, mobile.

Deliberately deferred: multi-clip and multi-track until M5/M6, waveform until M2, smart render until M3 and possibly never.
