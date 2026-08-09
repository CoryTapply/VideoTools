# M1 Task 4a — app shell and design system: summary

Status: implemented, tested (341 tests: 335 pure-logic/Node plus 6 component files under
`@testing-library/react` + jsdom, all green), and **manually verified in-browser** against all 13
`design/screens/*.png` references via the new `ui-harness.html` dev harness. `npm run typecheck`,
`npm run lint`, `npm test`, and `npm run build` are all clean project-wide.

This is a handoff/context summary for a future session. Design rationale lives in
`src/ui/README.md`; this file is about what was built, what was decided, what was found, and
what's still open.

---

## What was built

New module at `src/ui/`, fully greenfield — this is the first UI code in the project (React 19,
`@vitejs/plugin-react`, `jsdom` + `@testing-library/react` for component tests, all added to
`package.json`; `tsconfig.json` gained `"jsx": "react-jsx"`; `eslint.config.js` gained a
`react-hooks` block scoped to `src/ui/**/*.tsx`).

- **`tokens.ts`** — verbatim transcription of `design/README.md`'s Design Tokens table (color,
  type, spacing, radius, shadow, row heights, motion), plus every additional color that turned up
  scattered through `design/reference/Video Trimmer.dc.html`'s inline styles while building each
  component but never made it into the doc's own summary table (see "What was found" below). This
  is the sole hex-literal source in `src/ui/`; `tokens.css.ts` mirrors `color`/`shadow` onto CSS
  custom properties for plain CSS Modules to consume. `tokens.test.ts` enforces the rule with a
  scanner over `src/ui/**/*.{ts,tsx,css}`, not just a documented promise.
- **`state/`** — six DOM-free, Node-testable modules: `app-state.ts` (the React state shape +
  reducer), `timeline-controller-state.ts` (type + inert factory only — the seam Task 4b's real
  rAF-driven controller implements against), `keyboard-map.ts` (pure chord matching over the full
  keyboard table), `snap-notice.ts` (timecode/duration/frame-number formatting, keyframe-shift
  notice copy), `splitter.ts` (timeline-height clamp math), `panel-timers.ts` (hover-open/close
  timing via an injectable `Scheduler`, mirroring the `ByteSource`/`VideoElementLike` seam pattern
  from `src/media/`).
- **`chrome/`** — `App.tsx` (root, owns the reducer and the keyboard-shortcut dispatch), `TitleBar`,
  `DegradedStrip`, `Stage` (composes preview/rail/panels), `PreviewSurface`, `EmptyState`,
  `UnsupportedState`, `Rail`, `FloatingPanel`, `PinnedPanel`, `TransportBar`, `Splitter`,
  `TimelineRegion` (placeholder only — see below), `StatusBar`, `ExportOverlay`, `ExportToast`,
  `KeyboardOverlay`.
- **`panels/`** — `PanelRows`, `TrackList`, `SourcePanel`, `ExportPanel`, `JobsPanel`, transcribed
  directly from the prototype's `panelData()`/`trackRows()` logic (not just the written spec —
  see "What was found").
- **`icons/index.tsx`** — inline SVG set, paths transcribed from the prototype's `ICON`/`T_ICON`
  tables and inline markup (empty-state icon, pin, checkbox tick, warning triangle).
- **`fixtures.ts`** — static placeholder display data (filenames, track metadata, timecodes,
  panel rows, the keyboard-overlay table) standing in for real media/index/export data. This
  module is meant to be deleted once later tasks wire in real data.
- **`harness/`** — `ui-harness.html` → `harness/main.tsx` → `Harness.tsx`, a control panel next to
  a 924px-wide `<App>` viewport (matching the design screenshots' capture width) exposing every
  variant-switchable field: `screen` (all 8), `permissionLost`, `exactAvailable`, `trimMode`,
  `timelineHeight`, floating/pinned panel, keyboard overlay, full-screen, export
  progress/toast, and the keyframe-shift notice (which/delta/popover). Each control change
  remounts `<App>` with a fresh `initialState` — the harness only needs to reproduce static
  snapshots, not animate live transitions.
- **`main.tsx`** / **`app.html`** — the real (non-harness) entry point.

## Decisions

- **`permissionLost` as one new orthogonal flag, not a `degraded` clone.** `design/README.md`'s own
  State Management section already types `screen` with a `'degraded'` value (the "no File System
  Access API, downloads capped at 2GB" case — the 22px `DegradedStrip`). `design/original-brief.md`
  separately lists "permission lost" (a previously-granted file handle was revoked — the title-bar
  amber "Reconnect file" pill) as a distinct state. The prototype renders both off one `isDegraded`
  boolean because it only needed one screenshot per state; this implementation keeps `screen`
  exactly as the doc's own 8-value union and adds `permissionLost` as the one genuinely missing
  orthogonal flag. Verified independently controllable via the harness (both pieces render
  correctly together and separately).
- **CSS Modules, plain CSS, no framework.** Matches the project's existing minimalism (no
  precedent for styled-components/Tailwind anywhere in the repo) while still getting real class
  scoping. Colors always go through `var(--color-*)`/`var(--shadow-*)`, never a literal.
- **Google Fonts CDN for now, matching the prototype's own loading approach**; self-hosting is
  flagged as a follow-up in `src/ui/README.md` since no font files were provided in the design
  bundle.
- **Remount-on-change harness**, not live prop updates. `useReducer`'s lazy initializer only runs
  once, and the harness only needs to reproduce 13 static screenshots — a `key`-driven full
  remount is simpler and more honest than plumbing live external-state sync into `App`.

## What was found

Working from the actual prototype file (`design/reference/Video Trimmer.dc.html`), not just the
written spec, surfaced several real details that the written spec alone would have missed or that
required judgment calls:

- **The read-only Source panel never shows a checkmark**, even for the always-on `V1` track —
  `trackRows('source')` forces `on: false` unconditionally. Reading only `design/README.md`'s "The
  Source panel shows the same list read-only with inert boxes" line, it would have been easy to
  render V1 checked there (it conceptually always is).
- **A meaningful number of colors used throughout the prototype never made it into
  `design/README.md`'s own "Design Tokens" table** — the splitter's hover fill, several button
  hover states (`Keep exact frame`, `Show in folder`), the track-list checkbox's unchecked border,
  the empty-state card's background and hover fill, the preview placeholder's two-stop stripe
  texture, the video element's own background, the export overlay's translucent backing, the
  indexing-state stripe pair, and the keyboard-overlay scrim. All added to `tokens.ts` alongside
  the documented ones, each with a comment noting it came from the prototype rather than the
  table, so a future reader isn't confused about provenance.
- **Rail hover-open's "only if none is open" check happens at fire time, not at hover-start** —
  the prototype's `setTimeout` callback re-reads `this.state.panel` when it actually fires, 400ms
  later, not when the timer was scheduled. `Rail.tsx` replicates this with a ref kept current via
  `useEffect`, not a captured closure value (confirmed necessary via the `Rail.test.tsx`
  hover-open-blocked-while-a-panel-is-open case).
- **Opening a rail panel closes the keyboard overlay, and vice versa** — a real interaction in the
  prototype's button handlers, not written anywhere in `design/README.md`'s prose. Folded into
  `app-state.ts`'s reducer (`panel/open` clears `shortcuts`; `shortcuts/toggle` clears `panel`).
- **`design/screens/11-degraded-browser.png`** appears to be a byte-identical duplicate of
  `01-ready.png`, not an actual capture of the degraded-browser state — likely a screenshot-bundling
  mistake in the design deliverable itself. Not something to fix here; noted so a future session
  doesn't waste time trying to pixel-match against it. The written spec (title-bar reconnect pill +
  22px caption strip) was implemented and verified correct via the harness regardless.

## Two lint rules worth knowing about for future `src/ui/` work

- `@typescript-eslint/restrict-template-expressions` (from `strictTypeChecked`) rejects a bare
  `number` inside a template literal — write `${n.toString()}`, not `${n}`.
- `react-hooks/refs` (new in this React-Compiler-era eslint plugin) rejects mutating
  `ref.current` directly in a component's render body — even the common "keep a ref in sync with a
  prop" pattern needs a `useEffect`, not an inline assignment. Both surfaced immediately as real
  lint failures during this task (see `git log` for the fix commits) rather than needing separate
  documentation, but are easy to trip on again.

## What's still open

- **Task 4b** builds the actual canvas timeline — `TimelineRegion` is deliberately just
  correctly-sized placeholder rows (ruler/keyframe/filmstrip, no waveform per the M1 default) with
  an indexing-state stripe overlay and nothing else. No `<canvas>`, no viewport math, no
  drag-scrub exists yet.
- **`fixtures.ts` is a placeholder module.** Filename, track list, panel rows, timecodes are all
  static. Task 5 (export) and the eventual real media-index wiring should replace it rather than
  extend it — it's not meant to become a real data layer.
- **The unsupported-codec state's title-bar format chip is still the H.264 fixture** (`MP4 · H.264
  · 19.4 GB`) instead of an HEVC-specific one, unlike the reference screenshot (`MP4 · HEVC · 41.2
  GB`). Minor, fixture-only — `App.tsx` doesn't branch `FORMAT_CHIP` by screen. Would take one more
  fixture constant plus a conditional if a future session wants exact parity.
- **`ExportOverlay`'s "Show in folder" button is wired to a no-op**, matching the prototype (it has
  no `onClick` there either) — there's no real filesystem integration to call yet.
- **Font self-hosting** (`design/README.md`'s Assets section: "Fonts load from Google Fonts;
  self-host in production") is deferred — no font files were included in the design bundle.
