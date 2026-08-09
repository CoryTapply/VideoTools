# Wire real file selection + parser + playback into the app shell: summary

Status: implemented, tested (359 tests, all green), and **manually verified end to end in a real
browser** against two real fixture files (`src/media/index/__fixtures__/tiny.mp4` and the 2GB
`fixtures/mid-1080p.mp4`) plus a deliberately-invalid file for the error path. `npm run
typecheck`, `npm run lint`, `npm test`, and `npm run build` are all clean project-wide.

This is a follow-up increment on top of M1 Task 4a (`src/ui/`, PR #9), not a formally-numbered
roadmap task — the user tried the shell right after 4a landed and correctly noticed the Open
button, drag-and-drop, and most panel numbers were all decorative. This work wires the two
already-built, already-tested modules from Task 1 (`src/media/index/`) and Task 2
(`src/media/playback/`) into the UI for the first time.

---

## What was built

- **Real file selection** — a hidden `<input type="file">` in `App.tsx`, triggered by the
  title-bar Open button and by clicking the empty-state card; real drag-and-drop accept on the
  empty-state card (`chrome/EmptyState.tsx`'s new `onFileDrop` prop).
- **`state/media-session.ts`** — the new `useMediaSession()` hook, holding the resource-shaped
  parts of "a file is open" (the `File`, the built `SampleIndex`, the `NativeVideoEngine`
  instance, the `<video>` ref) that don't belong in the big reducer — mirroring the precedent
  `state/timeline-controller-state.ts` already set. Parses via `IndexWorkerClient` (off the main
  thread), then on success mounts a real `<video>` and calls `NativeVideoEngine.load()`. A parse
  failure dispatches the raw `IndexError` into `app-state.ts`'s new `openError` field; a
  *playback* failure (index valid, just can't preview -- most commonly `unsupported-codec`) routes
  to the existing `screen: 'unsupported'` card with the real message
  (`formatPlaybackError`) and real codec/resolution/fps. A pure `nextScreenForLoadOutcome()`
  helper makes that mapping directly testable without a real engine.
- **`media/derive-source-info.ts`** — every number the Source/Export panels showed that was
  previously faked now has a real formula: friendly codec names (by RFC 6381 prefix family, not
  full profile decoding), file-size formatting, GOP/bitrate computation, format-chip/
  track-summary/export-row derivation. Pure, Node-tested against hand-built `TrackIndex` fixtures.
- **Transport controls** — play/pause, frame-step (←/→), prev/next-keyframe (↑/↓), set-in/out
  (I/O), jump-to-in/out (Shift+I/O), all wired to the real engine/index via `keyboard-map.ts`
  (already built, previously all no-ops) and the TransportBar's buttons.
- **A necessary type change**: `TrackId`/`TrackSelection` were a closed 7-key union baked to the
  design fixture's exact track list. Generalized to `string`-keyed so real files with an arbitrary
  number of tracks fit. The reducer's hardcoded `"V1 is locked"` special case is gone; locking is
  now data-driven via each track summary's own `locked` flag (`TrackList.tsx` already only wires a
  checkbox's `onClick` when `!locked`).
- **The fixture-fallback mechanism** — `App.tsx` now reads `media.X ?? fixtureX` everywhere it
  used to read a fixture directly. Since `ui-harness.html`'s variant switcher never calls
  `openFile()`, every `media.*` field stays `null` there and it keeps rendering exactly the same
  fixture data it always has. Confirmed unchanged in-browser -- **no changes needed to
  `harness/Harness.tsx` or any harness test.**

## What was found

- **A real, repo-wide-relevant bug**: importing `src/media/index/`'s barrel (`index.ts`) from
  browser code crashes the whole app on load. The barrel re-exports `NodeByteSource`, which
  top-level-imports `node:fs/promises` -- Vite externalizes that for the browser and throws on
  access. The module's own doc comment already says this ("Test-only import surface -- never used
  from the browser bundle") and every existing harness (`media/index/harness.ts`,
  `playback/harness.ts`, ...) already imports submodules directly, never the barrel -- this
  integration's first draft just hadn't followed that convention yet. Fixed everywhere by
  importing from the specific submodule (`errors.ts`, `time.ts`, `track-index.ts`, `query.ts`,
  `worker-client.ts`) instead of the barrel. Worth flagging for any future `src/ui/` code that
  reaches into `src/media/index/`: **never import the barrel from browser-executed code.**
- **Parsing and reaching playback are not separable.** `NativeVideoEngine.load(file, index)`
  hard-requires an already-built `SampleIndex`. Confirmed during planning (reading the actual
  source, not just the module READMEs) before writing any code, which avoided architecting around
  a false assumption.
- **A parser-only test fixture isn't necessarily browser-playable.**
  `src/media/index/__fixtures__/tiny.mp4` parses cleanly (our own container parser handles it, and
  its `SourcePanel` numbers are all correct) but its degenerate audio track (`0 ch · 0.0 kHz` --
  clearly not a real capture) caused real confusion during manual verification: a video element
  manually re-`.load()`-ed against it got stuck at `readyState 0` forever with no error, which
  briefly looked like a real playback bug. Re-tested cleanly (fresh page load, no manual
  `.load()` interference) and it loads and plays fine -- the earlier stuck state was an artifact of
  the *test* calling `.load()` again mid-session, not an app bug. `fixtures/mid-1080p.mp4` (a real,
  32-minute capture) was the fixture that gave real confidence: real duration (1920.02s), real
  play/pause (confirmed `currentTime` advancing), real frame-step and keyframe-nav, and correctly
  surviving a second file being opened in the same session (same `<video>` DOM node reused, fresh
  load, no interference from the first file's now-disposed engine).
- **`Result<T, E>` lives in `src/media/playback/result.ts`, not `PlaybackEngine.ts`** -- despite
  `PlaybackEngine.ts` using it in its own `load()` signature, it isn't re-exported from there.
  Caught immediately by `tsc`, not a real gotcha, but worth noting for the next person importing
  from this module directly (no barrel here either).

## What's still open

- **Drag-scrub on the timeline** is not wired -- there's no timeline yet (Task 4b). Frame-step and
  keyframe-nav work today because they don't need one; scrubbing does.
- **`JobsPanel` and the `thumbs NN%` status-bar figure stay fixture-driven.** No thumbnail
  generation pipeline is wired here.
- **The "heap MB in use" Source-panel row is gone for real files**, not replaced with a real
  number -- no reliable cross-browser in-page memory API exists, and this project's own convention
  (`PROJECT-CONTEXT.md`) is OS-level Activity Monitor measurement, never a fabricated one.
- **Export panel's `est. size` and `folder` rows stay illustrative approximations** -- a real size
  estimate needs per-track bitrate summed over the trimmed range (more work than scoped here), and
  `folder` is genuinely unknowable before a save destination is chosen (Task 5, not started).
- **Codec friendly names are family-level only** (`h264`, `hevc`, `av1`, `aac`), not full profile
  decoding (`avc1.640034` → "h264 / High") -- flagged as a deliberate simplification, not an
  oversight.
- **OPFS index caching** (`opfs-cache.ts`, already built, fully opt-in) is not wired here. Nothing
  in this task needed it; a future session revisiting reopen-the-same-file performance should
  start there rather than rebuilding it.
- **Drag-and-drop was verified by code review and the identical `onDrop` handler path as file-input
  selection, not by simulating a real OS-level drag gesture** -- browser automation can dispatch a
  synthetic `drop` event with a `DataTransfer`, but a full manual drag-from-Finder pass is still
  worth doing once a human is at the keyboard.
