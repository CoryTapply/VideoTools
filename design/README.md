# Handoff: Browser-Based Video Trimmer

> **Two change notes supersede parts of this file.** `floating-chrome-changes.md` (current) replaces everything about the title bar, transport bar, status bar, ruler and keyframe rows. `empty-state-changes.md` replaces the empty-state description. Read both before implementing.

## Overview

A dark, dense, desktop-only web UI for a browser app that opens very large local video files (20 GB+ MP4/H.264), lets the user scrub a 4-hour timeline, set in/out points, and export a trimmed clip via stream copy. Everything runs client-side — the file is read through the File System Access API and never uploaded.

The design is a single application screen (preview + transport + timeline + right rail) with all secondary states — empty, indexing, exporting, unsupported codec, degraded browser — rendered as variations of that same screen rather than separate pages.

## About the Design Files

The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, not production code to copy directly.

`Video Trimmer.dc.html` is authored in a streaming component format with a template section and a logic class. It runs standalone in a browser (open the file directly with `support.js` alongside it), but its markup conventions (`<sc-if>`, `<sc-for>`, `{{ hole }}`, `style-hover`) are specific to that prototyping runtime and should **not** be reproduced. Read it for geometry, math, colors, and interaction logic; the JS logic class is close to directly portable to a React class or hooks component.

The task is to **recreate this design in the target codebase's existing environment** (React, Vue, Svelte, etc.) using its established patterns, state library, and component primitives. If no environment exists yet, pick the most appropriate framework and implement there. The heavy lifting — demuxing, index parsing, thumbnail decode, stream-copy remux — is assumed to be real work (WebCodecs + a WASM demuxer/muxer, or similar); the prototype fakes all of it with synthetic data.

## Fidelity

**High fidelity.** Colors, type, spacing, row heights, and interaction timing are all final and intentional. Densities were tuned against a 1440px-wide viewport. Recreate pixel-accurately, substituting the codebase's own primitives where they exist (buttons, tooltips, popovers) as long as the resulting metrics match.

---

## Architecture constraints

These override anything in the sections below. The prototype is a faithful
picture of the *result*; it is not a picture of how the result is produced.

### The timeline is a canvas

A four-hour 60fps source has 862,401 frames. At frame-level zoom the DOM
timeline described below would need hundreds of thousands of nodes and would
die. The four timeline rows are a single `<canvas>` with an offscreen layer
stack.

From the timeline sections that follow, extract **numbers only**: row heights,
tick weights, label size and offset, tile width and seam treatment, handle
width, corner radius and hit-padding, dim opacity, playhead line width and cap
dimensions, and every color as a token. The `repeating-linear-gradient`
keyframe texture, the tile `box-shadow` seams, and the waveform bars all become
imperative draw calls with the same measured values.

Everything outside the timeline — title bar, transport, rail, panels, popovers,
overlays, dialogs — is ordinary DOM and should be built as described.

### React owns the shell, not the playhead

The timeline is an imperative controller subscribed to a store, drawing on
`requestAnimationFrame`. React re-renders only on discrete state changes:
selection changed, tool changed, file opened, panel toggled. **Never on
playhead movement.** The playhead updates at 60Hz and must not enter React's
render path. See *State Management* for the split.

### The preview is a `<video>` element

Not a decode canvas. Playback is native `<video>`; a canvas overlay on top of
it paints cached filmstrip frames during a scrub drag. Both surfaces share the
same 16/9 box, which is why nothing in the layout is allowed to resize it
mid-session.

### Scrub is cache-backed, and coarse

During a drag the preview reads the frame cache, not the video. One real seek
fires on pointer-up. `<video>` seek measures 281ms p50 — 17× too slow for 60Hz.

Consequence for the design: at full-file zoom the frame shown during a drag can
be up to ~4.17s away from the true position, snapping exact on release. Inside
the dense cache window (±30s of the playhead) it is much tighter. Any reading
of this document that implies frame-exact preview during a drag is describing
something the architecture does not do.

---

## Screen: Trimmer (single view)

**Purpose:** open a very large local recording, find a moment, set in/out, export the range.

**Layout** — a full-viewport (`100vh`) vertical flex column, `overflow:hidden`, no page scroll:

| Row | Height | Notes |
|---|---|---|
| ~~Title bar~~ | — | now a floating overlay, out of the column — see `floating-chrome-changes.md` |
| Degraded notice | `22px` | only in the degraded state |
| Stage area | `flex:1, min-height:0` | horizontal flex: preview / pinned panel / icon rail |
| ~~Transport bar~~ | — | now a floating pill over the preview — see `floating-chrome-changes.md` |
| Splitter | `5px` | `cursor:row-resize` |
| Timeline | `236px` default, resizable `150–55vh` | ruler / keyframes / filmstrip / waveform |
| ~~Status bar~~ | — | removed; only the keyframe-shift notice survives, as a floating chip |

The stage row is the only flexible one — the timeline is a fixed pixel height driven by state, and the splitter mutates it.

### Title bar (44px, floating — geometry per `floating-chrome-changes.md`; contents below still apply)

- Left: `8×8px` rounded-`2px` green dot (`#5DCAA5`), then the filename in IBM Plex Mono `12.5px`, ellipsized. Empty state shows `No file open`.
- Format chip: `22px` tall, `0 8px`, radius `6px`, bg `#232326`, border `1px #2E2E32`, Plex Mono `11px`, color `#9A9A96`. Content: `MP4 · H.264 · 19.4 GB`.
- Degraded state inserts an amber pill here: `24px` tall, bg `rgba(239,159,39,.10)`, border `1px rgba(239,159,39,.35)`, text `#EF9F27` 12px, reading `Reconnect file — access to this file was lost`, with an inline `Reconnect` button (18px tall, transparent, amber border).
- Right: `Open` — 28px tall, `0 12px`, radius 6, bg `#1A1A1C`, border `1px #2E2E32`, hover `#232326`. Then `Export clip` — 28px, bg `#4C8DF6`, text `#0B1220` weight 600, hover `#5E99F7`, with `⌘E` in Plex Mono 11px at 60% opacity.

### Preview stage

Centered, `padding:8px`, bg `#0B0B0C`. The video surface is `aspect-ratio:16/9`, `width:100%`, `max-height:100%`, black, `1px #1A1A1C` border. In the prototype it is filled with a 115° repeating stripe placeholder (`#131418` / `#0F1013`, 14px bands) and the centered label `decoded frame` — in the real app this is a native `<video>` element with a canvas overlay for cached scrub frames.

Bottom-left overlay, Plex Mono 11px `#6B6B68`, 12px gap: current frame number (comma-grouped, suffix ` f`) and full timecode.

While dragging an in/out handle the label switches to `filmstrip cache frame` — the preview shows the nearest cached filmstrip tile rather than a fresh decode, because seeking a 20 GB file per drag frame is not viable.

**Export progress** is an overlay inside the stage, not a layout row — `position:absolute`, `top/left/right:14px`, `34px` tall, radius 8, bg `rgba(19,19,21,.92)`, border `1px #2E2E32`, shadow `0 10px 26px rgba(0,0,0,.5)`. Contains a 4px track (`#232326`) with `#4C8DF6` fill, a Plex Mono 11.5px line reading `<n> MB written · 214 MB/s · <n> s left`, and a Cancel button. Overlaying is deliberate: the video must not resize when an export starts.

**Export toast** — bottom-right, `320px`, radius 8, bg `#1A1A1C`, border `1px #2E2E32`, animates in with `translateY(6px)→0` over 180ms. Green dot + `Clip exported — 2 m 02 s`, output path in Plex Mono 11px `#6B6B68` (`word-break:break-all`), then `Show in folder` and `Trim another range` buttons (24px tall).

**Empty state** replaces the video surface, hides the title and status bars, and swaps panel bodies for skeletons — see `empty-state-changes.md`, which supersedes this paragraph.

**Unsupported-codec state**: `min(560px,86%)` card, bg `#1A1A1C`, border `1px #2E2E32`, radius 8, `26px 28px`. Headline 14px: *This file's codec can't be previewed in your browser, but it can still be trimmed.* Body 12.5px `#9A9A96` explains that index, keyframe map, and waveform read normally and stream copy still works. Footer row of Plex Mono 11.5px `#6B6B68` facts: `hevc / Main 10`, `3840 × 2160`, `59.94 fps`. The timeline stays fully live in this state — only decode is unavailable.

### Icon rail (34px)

Right edge, border-left `1px #2E2E32`. Four `26×26` buttons, radius 6, `2px` gap, `6px` top padding. Idle icon `#6B6B68`, hover/active `#E8E8E6`, active bg `#232326`.

1. Source info (circle-i)
2. Export settings (sliders)
3. Jobs (two stacked bars)
4. Keyboard (`?` overlay)

Click toggles a panel; hover for 400ms opens it too (only when no panel is already open). Panels are transient by default and pinnable.

### Panels

**Floating** — `position:absolute`, `top:8px`, `right:42px`, `250px` wide, `max-height:calc(100% - 16px)`, scrollable, radius 8, bg `#1A1A1C`, border `1px #2E2E32`, shadow `0 12px 32px rgba(0,0,0,.55)`, 120ms fade. Sticky 28px header with an uppercase 11.5px `#9A9A96` title and a pin button. Closes 220ms after the pointer leaves (cancelled on re-enter), and on any timeline interaction.

**Pinned** — clicking the pin moves the panel into the layout as a `258px` flex column with border-left, pushing the preview narrower. Header shows a blue (`#4C8DF6`) pin to unpin.

Panel body rows are a two-column Plex Mono 11px line, `line-height:16px`, `5px` gap: label `#6B6B68` left, value right-aligned and color-coded (`#E8E8E6` neutral, `#4C8DF6` informational, `#5DCAA5` good, `#EF9F27` warning).

**Source panel** rows: container `mp4`, codec `h264 / High`, resolution `2560 × 1440`, frame rate `60.00 fps`, frames `862,401`, keyframes `3,422`, GOP `252 frames · 4.2 s`, bitrate `11.6 Mb/s`, size `19.4 GB`, heap `147 MB in use`.

**Export panel** rows: container `mp4`, video `stream copy` (or `none selected` in amber when the video track is deselected), audio `stream copy × N` (or `none selected` in amber when N = 0), range `00:02:02`, est. size `178 + 29N MB`, writer `file system access`, folder `~/Recordings`, name `session-4_clip.mp4`.

**Jobs panel** rows: index `done · 138 ms`, keyframe map `done · 41 ms`, thumbs `68% · running`, waveform `queued`, plus finished/canceled prior exports.

**Track list** (Source and Export panels) sits at the **top** of the panel body, above the key/value rows — export selection must be visible without scrolling. Header line: uppercase 10.5px `Tracks` and a count (`1 video · 6 audio` in Source, `2 of 7 selected` in Export), with a `1px #2E2E32` rule beneath.

Each row: `3px 4px` padding, radius 4, 7px gap, hover bg `#232326`. An `11×11` checkbox (radius 3; checked = `#4C8DF6` fill with a `#0B1220` tick, unchecked = `1px #3A3A3E` border). Then the track id in Plex Mono 10.5px, fixed 22px wide, green `#5DCAA5` for video and blue `#4C8DF6` for audio. Then a two-line stack: track name (11.5px, `#9A9A96` when deselected) and a Plex Mono 10px `#6B6B68` meta line.

Fixture tracks — one video, six audio (a realistic OBS multi-track capture):

| id | name | meta |
|---|---|---|
| V1 | Screen Capture | h264 · 2560×1440 · 60.00 fps · 4:00:00 |
| A1 | Mic — NT-USB | aac · eng · mono · 48 kHz · 4:00:00 |
| A2 | Desktop Audio | aac · eng · stereo · 48 kHz · 4:00:00 |
| A3 | Game Capture | aac · eng · stereo · 48 kHz · 4:00:00 |
| A4 | Voice Chat | aac · eng · stereo · 48 kHz · 3:58:12 |
| A5 | Browser Media | aac · und · stereo · 48 kHz · 4:00:00 |
| A6 | Alerts | aac · und · stereo · 44.1 kHz · 4:00:00 |

Only the Export panel's checkboxes are interactive, including V1 -- deselecting it (with at least one audio track selected) exports an audio-only clip. Selected rows get bg `rgba(76,141,246,.10)`. Defaults: V1 + A1. The Source panel shows the same list read-only with inert `#232326` boxes.

### Transport bar (40px floating pill — geometry per `floating-chrome-changes.md`; contents below still apply)

`14px` gaps, borders top and bottom `1px #2E2E32`.

1. **Timecode** — Plex Mono 15px weight 500, `min-width:118px`, format `HH:MM:SS:FF` at 60fps, zero-padded, tabular numerals (`font-variant-numeric:tabular-nums` is set on the root and matters everywhere).
2. **Transport** — five `30×26` buttons, radius 6, 2px gap, idle `#9A9A96`, hover bg `#232326` + `#E8E8E6`: prev keyframe, step back, play/pause (play icon swaps to pause, bg `#232326` while playing), step forward, next keyframe.
3. **In / out / dur** — three label+value pairs. Labels Plex Sans 11px `#6B6B68`; values Plex Mono 12px, in/out `#4C8DF6`, dur `#E8E8E6`.
4. **Trim mode** (right-aligned) — 11px `trim` label, then a segmented control: 2px padding, radius 6, bg `#1A1A1C`, border `1px #2E2E32`, two 22px buttons (`copy`, `exact`) — active bg `#232326` + `#E8E8E6`, idle `#6B6B68`. When frame-exact trimming is not shipped, `exact` is disabled: color `#4A4A4E`, opacity `.55`, `cursor:not-allowed`, tooltip `Frame-exact trim ships in a later release`.

### Timeline (resizable, default 236px)

A vertical stack inside a container that owns pointer handling. Four rows:

**1. Ruler — 26px, and it now carries the keyframe ticks (`floating-chrome-changes.md`).** `border-bottom:1px #232326`, `cursor:text`. Adaptive tick step chosen from `[1f, 2f, 5f, 10f, 0.5s, 1s, 2s, 5s, 10s, 30s, 1m, 2m, 5m, 10m, 30m, 1h]` — the first candidate whose on-screen width is ≥ 90px. Minor ticks at step/5, drawn only when ≥ 13px apart. Major tick `#4A4A4E` full height; minor `#2A2A2E`, 6px. Labels Plex Mono 10.5px `#6B6B68`, offset `+4px` right of their tick, truncated by zoom level: `HH:MM` at ≥1min steps, `HH:MM:SS` at ≥1s, `MM:SS:FF` below. During indexing a 2px `#4C8DF6` progress fill runs along the bottom of this row.

**2. Keyframe ticks — REMOVED as a row, merged into the ruler (`floating-chrome-changes.md`); tick rules below still apply.** bg `#121215`, `border-bottom:1px #232326`, tooltip `Keyframes — cuts in copy mode land here`. GOP is `4.2s` (252 frames). Rendering depends on keyframe spacing in px:
- ≥ 16px: full-height ticks, `#8A8A92`
- 3–16px: short ticks starting at `top:5px`, `#6E6E76`
- < 3px: a repeating-linear-gradient texture (`#6E6E76` 1px stripes at the keyframe pitch), opacity `clamp(0.4, kfPx*2, 0.85)`

Ticks coinciding with the current in or out point are drawn `#4C8DF6`.

**3. Filmstrip — `flex:1`, `min-height:60px`.** bg `#141416`. The dominant visual row; it absorbs all surplus height when the splitter is dragged. Tiles are a **fixed 120px wide** and crop rather than letterbox — the point is many frame boundaries across the view, not correct per-tile aspect. Each tile: absolutely positioned by time, `box-shadow: inset -1px 0 0 rgba(0,0,0,.55), inset 0 0 0 1px rgba(255,255,255,.05)` for the seam. Unloaded tiles are flat `#1B1B1F`; the prototype fakes loaded ones with a 155° two-stop gradient in the 30–60% lightness band so the strip reads as real footage.

**4. Waveform — 26px fixed. M2 only.**

In M1 the row is not rendered and occupies no height: no band, no top border,
no reserved stripe. The filmstrip's `flex:1` absorbs the 27px (26px row + 1px
`#232326` rule), so the M1 filmstrip is 27px taller than the M2 filmstrip at
the same timeline height. This is the intended trade — a permanently blank
audio band for the length of a milestone reads as a bug, and the filmstrip is
the row that benefits from every pixel it can get.

When it ships: bg `#0F0F11`, `border-top:1px #232326`. 2px bars every 5px,
bottom-anchored (VU-meter style, growing up from the row's floor rather than
out from the middle), top corners only rounded at radius 1 (square at the
bottom), height `(3–20px) × 0.9` so the tallest peaks don't touch the row's
top edge. Heights are normalized per visible viewport, not to a fixed
absolute amplitude: the loudest bar currently on screen always reaches the
full height, and every other visible bar scales relative to it — a quiet
passage fills the row the same as a loud one, trading absolute-loudness
accuracy for always-visible variation regardless of zoom or content. Inside
the in/out range `rgba(76,141,246,.62)`; outside `#2E2E33`. Deliberately
quiet — it is reference, not the primary target. (`prompts/waveform-bars-prompt.md`.)

The canvas layer stack should be built with the row present from the start and
its height driven by a single value, so M2 is a height change rather than a
re-layout.

**In/out region:**
- Two dim overlays (`rgba(10,10,11,.72)`) cover everything left of in and right of out, `pointer-events:none`.
- The selected span gets 1.5px `rgba(76,141,246,.55)` top and bottom borders.
- Handles: a **32px transparent hit area** centered on the edge (`transform:translateX(-16px)`) containing an 8px `#4C8DF6` painted bar (radius 2) and a 2px `rgba(11,18,32,.55)` grip line. Active drag lightens the bar to `#7FB0FF`. The generous hit zone is essential at 4-hour zoom levels.
- While dragging, a timecode chip follows the handle: `top:26px`, centered on the edge, `2px 6px`, radius 4, bg `#4C8DF6`, text `#0B1220`, Plex Mono 11px.

**Playhead:** 1.5px `#E2574F` full-height line, `z-index:22`, with an `11×11` head at the top (radius `0 0 3px 3px`). Never intercepts pointer events.

**Snap flash:** when a drag snaps, a 2px `#5DCAA5` line appears at the snapped position from `top:22px` down and fades out over 450ms (`opacity .9 → 0`).

**Indexing state** covers the filmstrip and waveform with a 10px/20px vertical stripe pattern (`#151517` / `#121214`) and blocks pointer interaction.

### Status bar — REMOVED (`floating-chrome-changes.md`); notice chip contents below still apply

Plex Mono 11px `#6B6B68`, 16px gaps, border-top `1px #2E2E32`.

- **Zoom:** `1 frame = N px` when a frame is ≥ 1px wide, otherwise `1 px = N frames` (comma-grouped).
- **Thumbs:** `thumbs 68%` / `thumbs queued`.
- **Index:** `index 862,401 frames · 3,422 keyframes` / `reading index — 138 ms`.
- **Keyframe-shift notice** (right-aligned, only in copy mode after a snap): 24px pill, bg `rgba(239,159,39,.14)`, border `1px rgba(239,159,39,.45)`, radius 6, with a warning-triangle icon, `in moved` in Plex Sans 12px, and the delta in Plex Mono 12px weight 500 `#FFB84D` (e.g. `−4.17 s`). Given a 4.2s GOP the shift can be seconds, so it carries real visual weight — it is not a whisper.

Hovering the pill opens a `262px` popover above it (bg `#1A1A1C`, border `1px #2E2E32`, shadow `0 12px 32px rgba(0,0,0,.55)`, radius 8): body text *"Stream copy can only cut on a keyframe, so the in point moved back to `HH:MM:SS:FF`."*, then `Keep exact frame` (switches to exact mode and restores the user's original frame) and `Dismiss`, with a footnote *"Re-encodes ~4 s at the head of the clip."* When frame-exact trim is not available, the primary button and the footnote are both omitted — only Dismiss remains.

### Keyboard overlay

Triggered by `?` or the rail's keyboard button. Full-screen scrim `rgba(8,8,9,.72)`, 120ms fade, click anywhere to close. Card `min(680px,88%)`, bg `#1A1A1C`, border `1px #2E2E32`, radius 8, `18px 20px`. Header: uppercase 13px `Keyboard` left, `Esc to close` right. Two-column grid, `6px 28px` gaps; each row has the chord in Plex Mono 11.5px `#E8E8E6` and the description in 12px `#9A9A96`, separated by a `1px #232326` bottom rule.

---

## Interactions & Behavior

### Pointer

| Gesture | Behavior |
|---|---|
| Click / drag anywhere in the timeline | Scrub the playhead; continues on `window` mousemove until mouseup. Disabled while empty or indexing. |
| Drag in/out handle | Moves that edge, clamped ≥ 0.2s from the other. Stops propagation so it never scrubs. |
| Alt while dragging | Disables snapping for that movement. |
| Wheel over timeline | Horizontal pan (uses the larger of `deltaX`/`deltaY`). |
| Ctrl/⌘ + wheel | Zoom anchored at the cursor's timestamp — that instant stays under the pointer. `Math.pow(1.0025, deltaY)`, clamped so a frame never exceeds 40px and the span never exceeds the full duration. |
| Drag splitter | Resizes the timeline, `150px` to `55vh`. |
| Hover rail icon 400ms | Opens that panel (only if none is open). |
| Leave floating panel | Closes after 220ms. |

The wheel listener must be attached imperatively with `{passive:false}` — React's synthetic `onWheel` is passive and cannot `preventDefault`, so page zoom would fire instead.

### Snapping

On drag, candidate targets are the nearest real keyframe, the playhead, `0`,
`duration`, and the opposite handle. Tolerance is 8 screen px converted to
time, so it stays constant in pixels at every zoom level. Snapping to a
candidate triggers the green flash.

The prototype's `round(t/4.2)*4.2` is a fiction and must not be ported.
Production snaps to the actual sync-sample timestamps from the container index,
via a binary search over the keyframe array. Real measured GOP on the target
footage is 4.166s and constant, but nothing in the code may assume a constant
GOP — VFR and mid-file encoder changes both break it.

### Keyframe enforcement (the core interaction)

On **mouseup** in copy mode, the released edge is forced outward to a real keyframe — in floors, out ceils — so the exported range never loses content. If that moves the edge at all, state records `{delta, at, which}` and the amber status-bar notice appears. `Keep exact frame` restores the user's original position and switches the mode to exact. Switching manually to `exact` clears the notice. Every notice must name the direction, the magnitude in seconds, and the resulting timecode; at a 4.2s GOP a silent snap would be an unacceptable content change.

### Playback

`requestAnimationFrame` loop advancing `t` by wall-clock delta while playing. In a real implementation this is driven by the decoder's presentation clock instead.

### Export

Export runs in two phases and the progress bar must show both.

**Copy** — the byte-copy loop, roughly 75% of total time at ~250 MB/s.
**Finalising** — `close()`, which runs strictly after the last byte is written
and is size-proportional: ~1.4s at 1GB, ~5.5s at 4GB. It is a *growing* share
of total time now that the copy loop is 1.7–3× faster.

A naive bar reaches 100% and then hangs for seconds. Reserve a distinct final
segment of the track for finalising, and swap the status line to `finalising…`
with the throughput and ETA fields dropped. The `<n> s left` estimate must
model both phases or it will read zero while the export is still running.

The app stays fully interactive throughout. The user keeps scrubbing, keeps
moving in/out, keeps opening panels. Export is never modal and never resizes
the preview — this is the same rule that governs rail panels.

Cancel reverts immediately and leaves a 0-byte file (File System Access writes
are transactional).

### Keyboard map

| Chord | Action |
|---|---|
| Space / K | Play · pause |
| J / L | Shuttle back/forward 2s (accelerating in the real app) |
| ← / → | Step one frame |
| Shift + ← / → | Step one second |
| I / O | Set in · out at the playhead |
| Shift + I / O | Jump the playhead to in · out |
| Alt + I / O | Clear in · out (to 0 / duration) |
| ↑ / ↓ | Previous · next keyframe |
| + / − | Zoom in (×0.6) · out (×1.7), centered on the playhead |
| Shift + Z | Zoom to fit |
| Home / End | Jump to start · end |
| F | Full-screen preview (hides chrome, caps timeline at 140px) |
| ⌘/Ctrl + E | Export clip |
| ⌘/Ctrl + Z | Undo (documented, not implemented in the prototype) |
| Alt (held during drag) | Disable snapping |
| ? | Toggle the keyboard overlay |
| Esc | Close overlay/panel, exit full-screen |

All handlers `preventDefault`. Modifier chords are checked before the plain map so ⌘E does not fall through. In production, suppress these when focus is in a text input.

---

## State Management

State is split by update frequency, not by feature. Anything that changes at
60Hz lives in the timeline controller and never triggers a React render.

**React state** — discrete, low-frequency, drives the DOM shell:

```
screen        'ready' | 'empty' | 'opening' | 'indexing' | 'exporting' | 'finalising' | 'unsupported' | 'degraded'
tin, tout     number   in/out points, seconds
trimMode      'copy' | 'exact'
panel         string|null   transient panel id
pinned        string|null   docked panel id
sel           {V1..A6: boolean}   export track selection
notice        {delta, at, which} | null
noticeOpen    boolean
shortcuts     boolean
full          boolean   full-screen preview
timelineH     number    splitter-driven height
exportPct     number    throttled to ~4Hz — see below
toast         boolean
```

**Timeline controller state** — mutable, read on every `requestAnimationFrame`,
never in React:

```
t             number   playhead, seconds
viewStart     number   left edge of the visible window, seconds
viewSpan      number   width of the visible window, seconds
playing       boolean
drag          'in' | 'out' | null
snapFlash     number|null   timestamp, cleared after 460ms
tlW           number   measured canvas width in px (ResizeObserver)
```

`tin` / `tout` appear in both worlds: React owns them, and the controller reads
them from the store on each frame to draw the dim overlays, handles, and range
borders. Handle drags mutate a controller-local ghost value and commit to React
state once, on pointer-up — the same pointer-up that runs keyframe enforcement.

`t` is likewise readable by React for the transport bar's timecode, but that
readout is driven by a direct DOM text write from the rAF loop, not by state.
It is the one place where bypassing React is visible in the component tree, and
it is deliberate.

`exportPct` is genuine React state but is throttled to roughly 4Hz. Progress is
a slow-moving number and does not need frame-rate updates.

`viewStart` / `viewSpan` remain the single source of truth for the viewport;
every x-position is derived as `(t - viewStart) / viewSpan * 100%` — computed in
canvas pixel space rather than CSS percentages. `tlW` must come from a
`ResizeObserver`: tick density, snap tolerance, and tile count all depend on
real pixel width.

Fixture constants: `FPS = 60`, `DUR = 862401/60 ≈ 14373.35s` (3:59:33). Keyframe
positions come from the index, not from a GOP constant.

### Data the real implementation needs

- Container index (frame count, duration, timescale) — target < 200ms for a 20 GB file, seeking to the moov/cues rather than reading linearly.
- Keyframe map (timestamps of all 3,422 sync samples).
- Thumbnail decode queue — decode at keyframes only, prioritized by what's on screen, LRU-evicted; the `thumbs 68%` readout reflects this.
- Waveform peaks — a background pass; the prototype assumes it lags the filmstrip (`queued` in the jobs panel).
- Track list from the container's track boxes.

---

## Design Tokens

Transcribe this section into `src/ui/tokens.ts` before writing any component.
Every color, spacing value, radius, type size, row height, and motion duration
gets a name and is referenced by that name. **No hex literal appears anywhere
else in the codebase** — including inside the canvas draw code, which reads the
same token module.

**Color**

| Token | Hex | Use |
|---|---|---|
| bg/base | `#0E0E0F` | app background, bars |
| bg/stage | `#0B0B0C` | preview surround |
| bg/panel | `#1A1A1C` | panels, popovers, buttons |
| bg/raised | `#232326` | active/hover fills, chips |
| bg/timeline | `#141416` | filmstrip |
| bg/keyframes | `#121215` | keyframe row |
| bg/waveform | `#0F0F11` | waveform row |
| bg/tile-empty | `#1B1B1F` | unloaded filmstrip tile |
| border/base | `#2E2E32` | all structural borders |
| border/subtle | `#232326` | inner timeline rules |
| text/primary | `#E8E8E6` | |
| text/secondary | `#9A9A96` | |
| text/tertiary | `#6B6B68` | labels, monospace metadata |
| text/disabled | `#4A4A4E` | |
| accent | `#4C8DF6` | in/out, selection, primary action |
| accent/hover | `#5E99F7` | |
| accent/active | `#7FB0FF` | handle while dragging |
| accent/on | `#0B1220` | text on accent fills |
| good | `#5DCAA5` | file-ready dot, video track, done |
| warn | `#EF9F27` | keyframe-shift notice, degraded |
| warn/bright | `#FFB84D` | the delta value itself |
| playhead | `#E2574F` | |
| dim | `rgba(10,10,11,.72)` | out-of-range overlay |

**Type** — IBM Plex Sans (400/500/600) for UI, IBM Plex Mono (400/500) for all numerics, timecodes, and metadata. `font-variant-numeric:tabular-nums` on the root. Sizes: 10px / 10.5px / 11px / 11.5px / 12px / 12.5px / 13px (base) / 14px / 15px (timecode).

**Spacing** — 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 26, 32, 40.

**Radius** — 2 (handles), 3, 4, 5, 6 (buttons, chips), 8 (panels, cards).

**Shadow** — panels `0 12px 32px rgba(0,0,0,.55)`; export overlay `0 10px 26px rgba(0,0,0,.5)`.

**Row heights** — 44 floating title overlay / 40 floating transport pill / 26 ruler (incl. keyframe ticks) / 26 waveform / 5 splitter / 34 rail width / 250 floating panel / 258 pinned panel. No title, transport or status row occupies column height any more.

**Motion** — panel fade 120ms ease-out; toast rise 180ms ease-out; snap flash 450ms ease-out; panel hover-open delay 400ms; panel close delay 220ms. No transitions on anything that tracks the pointer.

## Assets

None. All icons are inline SVG drawn at a 16×16 or 20×20 viewBox with `stroke-width:1.3` and `currentColor` — swap them for the codebase's icon set (info, sliders, stacked-bars/queue, keyboard, prev-keyframe, step-back, play, pause, step-forward, next-keyframe, pin, warning triangle, check). Fonts load from Google Fonts; self-host in production.

## Screenshots

`screenshots/` — captured at a 924px-wide viewport (the design is desktop-only; at wider widths the filmstrip simply shows more tiles):

| File | State |
|---|---|
| `01-ready.png` | Default: file open, in/out set, floating chrome visible, keyframe-shift chip |
| `02-chrome-hidden.png` | Same, two seconds later: chrome faded out, in-frame readout visible |
| `02-keyframe-shift-popover.png` | Notice popover with `Keep exact frame` |
| `03-panel-source.png` | Floating Source panel with the read-only track list |
| `04-panel-export-tracks.png` | Export panel — track checkboxes, selection count, derived audio/size rows |
| `05-panel-jobs.png` | Jobs panel |
| `06-keyboard-overlay.png` | Keyboard overlay |
| `07-exporting.png` | Export progress overlaid on the preview |
| `08-empty.png` | No file open |
| `09-indexing.png` | Index reading — timeline hatched, ruler progress |
| `10-unsupported-codec.png` | HEVC: no preview, timeline still live |
| `11-degraded-browser.png` | No File System Access — reconnect pill + download-cap note |
| `12-variant-no-waveform.png` | First-release variant (`waveform: false`) |
| `13-variant-exact-disabled.png` | `exactAvailable: false` — exact toggle disabled |

## Files

- `Video Trimmer.dc.html` — the full design: template markup plus the logic class (state, geometry math, snapping, keyboard, tick/tile/waveform generation). The logic class is the most directly portable part.
- `support.js` — runtime for the prototype format. Needed only to open the HTML locally; do not port.
- `empty-state-changes.md` — revision note for the empty state (current; supersedes this file's empty-state description).
- `empty-state-prompt.md` — ready-to-paste prompt for the empty-state revision.
- `floating-chrome-changes.md` — revision note for the preview-height work (current).
- `floating-chrome-prompt.md` — ready-to-paste prompt for that revision.
- `original-brief.md` — the initial design brief.
- `revision-request.md` — the follow-up revision round (MP4, timeline proportions, keyframe row, track list, indexing timing, GOP).

Prototype variants are exposed as props on the root component and are worth checking before building: `screen` (all six states), `waveform: false` (first release, no audio band), `exactAvailable: false` (exact trim disabled), `trimMode`, `snapping`, `timelineHeight`.
