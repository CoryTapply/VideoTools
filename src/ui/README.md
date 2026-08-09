# `src/ui/` -- the app shell and design system

M1 Task 4a, plus an immediate follow-up wiring it to real data. React shell consuming
`design/README.md`'s handoff spec: layout regions, design tokens, rail and floating/pinned panels,
transport bar, status bar, splitter, and every M1 screen state. `src/media/index/` (the parser) and
`src/media/playback/` (the playback engine) are connected for real -- opening a file, dragging one
onto the empty state, play/pause/step/keyframe-nav/set-in-out all work against real data. If you're
new to this module: read this file, then `tokens.ts`, then `App.tsx`, then `state/media-session.ts`.

## Why tokens.ts is the sole hex-literal source

`design/README.md` states it directly: "No hex literal appears anywhere else in the codebase --
including inside the canvas draw code, which reads the same token module." `tokens.test.ts`
enforces this with a scanner, not just a documented rule -- it walks `src/ui/**/*.{ts,tsx,css}`
(excluding `tokens.ts`/`tokens.css.ts` themselves) and fails on any `#rrggbb`-shaped match. Plain
CSS files reference `var(--color-bg-base)` etc., set once at startup by `tokens.css.ts`'s
`applyTokenCssVariables()`. When Task 4b's canvas draw code needs a color, it imports `tokens.ts`
directly rather than going through CSS custom properties.

`tokens.ts` only tokenizes genuinely reusable values -- the color palette, type scale, spacing
scale, radius scale, shadows, the row heights `design/README.md` names explicitly, and motion
durations. Component-specific one-off geometry (a 250px panel width, a 34px icon tile) lives as a
literal number in that component's own file; the "no literal" rule in the design doc is about
colors, not every pixel measurement.

## The React-state / timeline-controller-state split

`architecture-v3.md` draws a hard line: the canvas timeline (Task 4b) is "an imperative controller
subscribed to a store, drawing on `requestAnimationFrame`... React re-renders only on discrete
state changes... Never on playhead movement." `state/app-state.ts` holds the low-frequency React
state (`screen`, `tin`/`tout`, `panel`, `sel`, ...). `state/timeline-controller-state.ts` holds only
the *type* and an inert factory for the 60Hz-mutable fields (`t`, `viewStart`, `viewSpan`, `drag`,
...) -- establishing the seam Task 4b implements against, without this task building any rAF loop
or drawing itself.

## Reconciling the state table

`design/README.md`'s own State Management section already types `screen` with eight values
including `'degraded'` -- that value is the "no File System Access API at all, exports fall back to
capped downloads" case (the 22px `DegradedStrip`, gated in the row table on "the degraded state").
`design/original-brief.md`'s fuller state table also lists "permission lost" (a previously-granted
File System Access handle was revoked) as a distinct state, which is a different failure mode with
different messaging -- the title-bar amber "Reconnect file" pill, not the 22px strip. The prototype
(`design/reference/Video Trimmer.dc.html`) renders both off one `isDegraded` boolean, because it
only needed one screenshot per state. `app-state.ts` instead reuses `screen === 'degraded'` for the
first case and adds one new orthogonal flag, `permissionLost`, for the second -- they can occur
independently (a file can lose its permission grant while the browser fully supports File System
Access) and `screen` otherwise stays exactly the doc's eight-value union.

## Panel timers use an injectable scheduler

`state/panel-timers.ts`'s hover-open (400ms) / close (220ms, cancelled on re-enter) logic takes a
scheduler function rather than calling `setTimeout` directly, so its tests can drive it with
`vi.useFakeTimers()` instead of real waits -- the same testability-seam pattern as `ByteSource`
(`src/media/index/`) and `VideoElementLike` (`src/media/playback/`).

## Never import src/media/index/'s barrel from this module

`src/media/index/index.ts` re-exports `NodeByteSource`, which top-level-imports `node:fs/promises`
-- Vite externalizes that for the browser and it throws on load, crashing the whole app. The
module's own comment already says this ("Test-only import surface -- never used from the browser
bundle"), and every `src/media/*/harness.ts` already imports submodules directly. Do the same here:
`'../../media/index/errors.ts'`, `.../time.ts`, `.../track-index.ts`, `.../query.ts`,
`.../worker-client.ts` -- never `.../index.ts`. `src/media/playback/` has no barrel at all, so this
only comes up for `media/index/`. Found the hard way (a blank white screen) while wiring
`state/media-session.ts` -- see `results/task-4a-media-integration-summary.md`.

## The fixture-fallback mechanism

`state/media-session.ts`'s `useMediaSession()` hook holds `null` for every derived field (tracks,
source rows, format chip, ...) until a real file is opened. `App.tsx` reads `media.X ?? fixtureX`
everywhere -- `ui-harness.html`'s variant switcher never calls `openFile()`, so `media.X` stays
`null` there and it keeps rendering exactly `fixtures.ts`'s static data, unaffected by any of this.
This is *why* the harness needed zero changes when real data wiring landed: fixtures went from
"the only source" to "the fallback when nothing is open," a one-line change per field in `App.tsx`,
not a rewrite.

## Where things are

- `tokens.ts` / `tokens.css.ts` / `reset.css` -- the design system.
- `state/` -- pure, DOM-free logic (reducer, chord matching, formatting, clamp math, timers) plus
  `media-session.ts`, the one hook here that *does* touch the DOM/File/Worker APIs (real file
  open, parsing, and playback) -- kept separate from `app-state.ts`'s reducer for the same reason
  `timeline-controller-state.ts` is: resource-shaped state (a `File`, a `SampleIndex`, an engine
  instance) doesn't belong in reducer state.
- `media/` -- pure derivation from real parsed data to the UI's display shapes
  (`derive-source-info.ts`), and the shared `TrackSummary`/`PanelRowFixture` types both real
  derivation and `fixtures.ts` produce.
- `chrome/` -- the shell: title bar, transport bar, status bar, splitter, stage, rail, panels
  (structural), preview surface (real `<video>` once a file is open), empty/unsupported states
  (real drag-and-drop, real error messages), overlays.
- `panels/` -- panel *content* (Source/Export/Jobs, the shared row/track-list renderers) --
  `tracks`/`rows` are always props now, never imported from `fixtures.ts` directly, so the same
  components render real or fixture data depending on the caller.
- `icons/` -- inline SVG set.
- `fixtures.ts` -- static placeholder display data; the fallback described above, and
  `ui-harness.html`'s only data source.
- `harness/` -- `ui-harness.html`'s dev-only state-variant switcher; not shipped product code.
- `App.tsx` / `main.tsx` / `app.html` -- the real (non-harness) entry point.

Full task writeups: `results/task-4a-app-shell-summary.md` (the original shell, what was found
reading the actual prototype file rather than just the written spec) and
`results/task-4a-media-integration-summary.md` (real file/parser/playback wiring, the barrel-import
bug above, and what's still open).
