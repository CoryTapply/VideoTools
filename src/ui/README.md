# `src/ui/` -- the app shell and design system

M1 Task 4a. React shell consuming `design/README.md`'s handoff spec: layout regions, design
tokens, rail and floating/pinned panels, transport bar, status bar, splitter, and every M1 screen
state rendered with placeholder content. If you're new to this module: read this file, then
`tokens.ts`, then `App.tsx`.

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

## Where things are

- `tokens.ts` / `tokens.css.ts` / `reset.css` -- the design system.
- `state/` -- pure, DOM-free logic (reducer, chord matching, formatting, clamp math, timers).
- `chrome/` -- the shell: title bar, transport bar, status bar, splitter, stage, rail, panels
  (structural), preview surface, empty/unsupported states, overlays.
- `panels/` -- panel *content* (Source/Export/Jobs, the shared row/track-list renderers).
- `icons/` -- inline SVG set.
- `fixtures.ts` -- static placeholder display data. Delete/replace as real data wiring lands.
- `harness/` -- `ui-harness.html`'s dev-only state-variant switcher; not shipped product code.
- `App.tsx` / `main.tsx` / `app.html` -- the real (non-harness) entry point.

Full task writeup, including what was found reading the actual prototype file rather than just the
written spec, and what's still open: `results/task-4a-app-shell-summary.md`.
