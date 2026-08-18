# M2 waveform: real-browser session notes

`src/media/waveform/README.md`'s "What needs a real, non-automated browser session" list, closed in
two sessions: Part 1 via `claude-in-chrome` automation against three smaller real fixtures (deviates
from this project's usual human-at-the-keyboard convention, see `task-4c-session-guide.md`, because
those fixtures fit the automation's file-size constraints); Part 2 by a human, directly against the
real `fixtures/27gb.mp4` six-track stress case Part 1 couldn't safely load.

## Part 1 — automated session (three smaller fixtures)

## Setup

Real fixtures are too large for the `file_upload` tool's 10MB limit, so they were served
same-origin instead: symlinked into `public/tmp-waveform-test/` (removed after the session, `git
status` confirmed clean) and loaded in-page via `fetch()` + a `DataTransfer`-constructed `File`
dispatched at the harness's real `<input>` element — functionally identical to a human picking the
file, since the harness never cares how `fileInput.files` got populated.

Three real fixtures, exercising both the button-driven harness UI and (for the memory reading) the
harness's underlying classes directly via dynamic `import()` of the same Vite-served modules:

| Fixture | Audio | Duration | Size |
|---|---|---|---|
| `GonnResetTheBoss.mp4` | AAC-LC, 2ch @ 48kHz | short | 28MB |
| `vfr-screen.mp4` | AAC-LC, 1ch @ 48kHz | 300s | 61MB |
| `27gb_clip.mp4` | AAC-LC, 2ch @ 48kHz | 210s | 1.26GB |

`fixtures/27gb.mp4` itself (the real six-audio-track stress fixture) was **not** loaded this way —
deliberately. The technique above materializes the whole file as an in-memory `Blob` before
touching `WaveformCache`, which is fine at gigabyte scale but risks crashing the tab at 27GB. That
fixture's six-track case is still open; see below.

## What this confirmed

- **`AudioSpecificConfig` extraction passes `AudioDecoder.configure()`.** All three fixtures
  decoded with zero errors reported via `WaveformCache`'s `onError` callback. If
  `stsd.ts`'s new `extractAudioSpecificConfig()` had produced bytes `AudioDecoder` rejected, this
  would have surfaced as a decode error per track, not a silent empty pyramid — it didn't.
- **`AudioDecoder` output arrives correctly under the `flushEvery`-checkpoint design.** Every build
  produced a non-empty, correctly-shaped pyramid (`levelCount`/`l0BucketCount` matching the
  expected `sampleCount × 8` bucket math for AAC's 1024-sample frames at `L0=128`), across mono and
  stereo. Real decoded audio is reaching the reducer, not silently dropped.
- **OPFS round-trip is real and correct**, not just internally consistent. `GonnResetTheBoss.mp4`:
  fresh build **351.6ms** (`OPFS cache read-back: hit` right after writing), then a second build of
  the *same* file **6.1ms** (`rebuild (expect OPFS hit)` — ~57× faster, consistent with skipping
  decode entirely and reading the cached blob).
- **Real single-track decode throughput**, both via the harness UI and via a direct
  `WaveformCache` call bypassing the OPFS cache (`fingerprint: undefined`, forcing a real decode
  every time):

  | Fixture | Audio duration | Build time | Real-time factor |
  |---|---|---|---|
  | `vfr-screen.mp4` (mono) | 300s | 2409ms | ~125× |
  | `27gb_clip.mp4` (stereo, 1.26GB file) | 210s | 1973ms / 1932ms (two runs) | ~108× |

  Single-worker sequential AAC decode is not the bottleneck this pipeline needs to worry about at
  these durations. Extrapolating linearly to `27gb.mp4`'s six tracks (unconfirmed, not a
  substitute for measuring the real file): if each track were similarly ~200–300s, six sequential
  builds would cost single-digit seconds total — comfortably fine for the "build lazily, one track
  at a time, when its lane is shown" design. This is an extrapolation, not a direct measurement of
  the real 27GB fixture's six tracks.
- **Memory does not balloon.** `performance.measureUserAgentSpecificMemory()` (real Chrome API,
  requires `crossOriginIsolated` — confirmed `true` throughout) around a real, cache-bypassed
  decode+build of `27gb_clip.mp4`'s 210s stereo track: **before 6.34MB → peak 7.74MB → after
  6.86MB** (agent-cluster-wide estimate, sampled at GC boundaries). A ~1.4MB rise during a build
  that decoded 1.26GB of source file is a strong first-hand signal against anything
  `decodeAudioData`-shaped, consistent with `pyramid.ts`'s incremental-reduction design actually
  working as intended (never buffering the raw float32 stream).
- **Zero console errors or warnings** across the entire session (checked after every phase, not
  just at the end).

**Not exercised in Part 1**: mid-stream AAC decode-start (a prerequisite for a future
parallel-segment split, per `README.md`'s "Worker architecture" section) — every Part 1 build
started from the beginning of the track. Still open; not attempted in Part 2 either.

## Part 2 — real `fixtures/27gb.mp4`, six tracks, human session

Run directly against the real stress fixture via the harness's normal `<input type=file>` picker
(not Part 1's `fetch().blob()` technique, which would risk crashing the tab at 27GB). Index build:
**179.5ms**, correctly found **7 tracks** (1 video + 6 independent stereo AAC, `SoundHandler`),
each **198,081** AAC frames (= 202,834,944 raw samples/channel, 4225.7s / 70.43min — matches this
project's previously-documented duration for this file exactly).

All six tracks, fresh build then rebuild:

| Track | Fresh build | Rebuild (cache hit) |
|---|---|---|
| 2 | 43,489.2ms | 13.0ms |
| 3 | 44,765.7ms | 15.3ms |
| 4 | 45,002.3ms | 15.5ms |
| 5 | 44,077.8ms | 13.7ms |
| 6 | 43,452.8ms | 13.0ms |
| 7 | 41,514.7ms | 11.9ms |

**Zero decode errors across all twelve builds.** Every track's `l0BucketCount` was **1,584,648** —
matches the closed-form `ceil(202,834,944 / 128)` exactly, confirming the real decode pipeline
processed every raw sample correctly, not just "some bytes came out."

Derived numbers:
- **Avg fresh build 43.7s/track, avg rebuild 13.7ms/track — a 3183x cache speedup**, holding up at
  six tracks on the real stress fixture (Part 1 only measured this at single-track/smaller scale).
- **Real-time factor ~96.7x** (70.43min of audio decoded in 43.7s) — slightly lower than Part 1's
  108-125x (unsurprising: this file is ~14x longer per track than Part 1's largest fixture).
- **Pyramid size ~13.82MB/track, ~82.9MB for all six** — matches the plan's original ~14.5MB/track,
  ~87MB estimate closely, now confirmed against the real file rather than a smaller stand-in.
- **Total sequential build time for all six tracks: 262.3s (4.37min)** — but per the module's
  lazy-per-track design, a real user only pays this once per track they actually look at, not all
  six unless every lane gets opened.

**A real UX finding, not previously flagged**: ~44 seconds with no visible progress before a
waveform lane appears, the first time any one track is viewed on a file this long. The lazy-build
design avoids paying this six times over, but doesn't avoid paying it once. Worth a follow-up:
either a progress indicator during `build()`, or streaming level-0 buckets into the UI
incrementally as they're produced instead of waiting for the whole promise to resolve.

**A real bug this session caught**: the harness's own size-estimate log line was wrong --
`estimatePyramidBytes(track.sampleCount, ...)` was passing an ISOBMFF sample count (AAC frame
count, 198,081) into a function that expects a *raw* PCM sample count, producing a nonsensical
"~0.01MB" estimate against a real ~13.8MB pyramid. Fixed in `harness.ts` to derive the estimate
from the real build's own `l0BucketCount` instead (a closed-form geometric-series scale-up,
`DEFAULT_RATIO / (DEFAULT_RATIO - 1)`, anchored to a real measurement rather than a
wrongly-scaled input) -- no functional code was wrong, only this diagnostic line.

**Seven `Unchecked runtime.lastError: Could not establish connection. Receiving end does not
exist.` messages appeared during the session.** Confirmed unrelated to this module: grepping the
entire `src/` tree for `chrome.runtime`/`runtime.lastError` finds nothing -- `WaveformWorkerClient`
uses a plain dedicated `Worker`, never extension messaging APIs. This is a well-known artifact of
Chrome extensions' own background/content-script handshake, unrelated to the page under test.

## Part 3 — real Chrome Task Manager memory reading, real six-track file

A human walked through the harness's Part B checkpoints (`waveform.html`, "OS-level memory
checkpoints") against `fixtures/27gb.mp4` with one track selected, reading Task Manager's "Memory
footprint" for the tab's render process at each step (raw checkpoint JSON:
`results/waveform-memory-checkpoints_27gb.mp4_2026-08-18T17_03_57.290Z.json`):

| Checkpoint | Task Manager (ground truth) | `measureUserAgentSpecificMemory()` (directional) |
|---|---|---|
| 1 — idle (file loaded, track selected, nothing built) | 334 MB | 66,194,558 B |
| 2 — after build (real decode, cache bypassed) | 584 MB | 66,161,030 B |
| **delta** | **+250 MB** | **-33,528 B (flat, noise)** |

This is the authoritative reading, by this project's own stated convention
(`src/measure/memory.ts`'s header comment) — and it tells a more honest story than Part 1's
JS-heap-only proxy did. The +250MB real rise is **not** explained by the pyramid itself (~13.8MB,
just 5.5% of the delta) — it's transient pipeline overhead (Worker/`AudioDecoder` internal state,
`AudioData` objects cycling through before being reduced and closed, structured-clone cost moving
the finished pyramid back to the main thread) that Task Manager's process-wide reading catches and
the JS-heap-scoped `measureUserAgentSpecificMemory()` reading in Part 1/2 entirely missed.

Framed against what matters — the roadmap's actual warning: **250MB is still ~6.2x smaller than
even a single track's raw float32 PCM would cost** (202,834,944 samples x 2 channels x 4 bytes =
1.51GB for this one track alone, before even reaching the roadmap's four-hour/6.2-track worst
case). The "never `decodeAudioData`" claim holds under the authoritative measurement, just with a
real, non-trivial constant-factor overhead this session is glad to have surfaced rather than
missed.

**Worth flagging, not measured**: this was a single track. The idle baseline itself (334MB, just
from having a 27GB file open and indexed) plus one track's build (584MB) is already close to M1's
own "peak process memory under 500MB" export criterion, in a different context (idle-with-file-open
vs. mid-export) that isn't directly comparable -- but if multiple waveform lanes were ever open at
once, six sequential ~250MB deltas would be a real number to measure before assuming it's fine,
not something to extrapolate casually. This module's per-track lazy-build design means that
scenario isn't automatic, but it's reachable if the UI ever lets several lanes stay open together.

## What's still open

- **Mid-stream AAC decode-start** -- not exercised in any session (see Part 1). A prerequisite for
  a future parallel-segment split, not this pass.

Everything else `README.md`'s original "needs a real browser" list flagged is now closed, against
real files up to and including the actual `27gb.mp4` stress fixture, using this project's own
stated ground-truth measurement method.

## Bottom line

The pipeline works correctly against four real files spanning three orders of magnitude in size
(28MB to 27GB) and up to six simultaneous tracks, with zero decode errors across eighteen total
builds, a cache round-trip confirmed correct and fast at every scale tested (13.7ms rebuilds vs.
43.7s fresh builds on the real stress fixture), pyramid sizes matching the plan's original
estimates almost exactly, and a real, authoritative Task Manager reading confirming the "never
`decodeAudioData`" design goal by more than 6x even in the least favorable framing (a single
track vs. that track's own raw-PCM cost). Two things remain as explicit, scoped follow-ups rather
than blockers to calling the data pipeline done: the ~44s no-feedback wait on a track's first
build (Part 2), and mid-stream AAC decode-start for a possible future parallel-segment split.
