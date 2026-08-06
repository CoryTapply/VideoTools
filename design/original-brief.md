# Design a browser-based video trimmer

Design a dark, dense desktop web UI for a browser app that opens very large local video files (20 GB and up), lets you scrub a multi-hour recording, set in and out points, and export a trimmed clip. Everything runs client-side; nothing uploads.

The user is comfortable with Premiere or DaVinci Resolve. They will use keyboard shortcuts. They want a two-minute segment out of a four-hour file in under a minute. Don't design a wizard, don't design onboarding, don't design a marketing page.

---

## Priority

**The video preview is the most important element on screen and should be as large as possible.** The timeline is second. Everything else gets out of the way.

---

## Layout — one screen, no navigation, no routes

```
┌───────────────────────────────────────────────────┬──────┐
│ TOP BAR  40px                                     │      │
│ filename · format chip · Open · Export clip       │      │
├───────────────────────────────────────────────────┤ RAIL │
│ PREVIEW — full width, 16:9, letterboxed           │ 34px │
│ overlay: frame number, bottom-left, muted         │ ⓘ⚙☰⌨ │
├───────────────────────────────────────────────────┴──────┤
│ TRANSPORT BAR  36px                                       │
│ timecode │ ◀ ▶ ⏵ │ in · out · dur │ [ copy | exact ]     │
├──────────────────────────────────────────────────────────┤
│ TIMELINE  ~180px min, resizable via splitter             │
│  ruler · keyframe ticks · thumbnail strip · waveform     │
│  in/out handles · playhead spanning all rows             │
├──────────────────────────────────────────────────────────┤
│ STATUS BAR  28px                                          │
│ zoom · thumbnail progress · keyframe-shift notice         │
└──────────────────────────────────────────────────────────┘
```

A draggable splitter sits between preview and timeline. The timeline can grow to half the window.

---

## Progressive disclosure — the video never resizes

There is no persistent side panel. Anything not needed every second lives behind the 34px icon rail on the right edge: source info, export settings, job queue, keyboard shortcuts.

- Rail panels **float over** the video as popovers. They never push the preview narrower — resizing the video mid-session is jarring and re-letterboxes the frame you're inspecting.
- ~200px wide, anchored to their rail button, aligned to the top of the preview.
- Open on click; on hover, open after ~400ms so passing the cursor doesn't flicker panels.
- Dismiss on outside click, `Esc`, or moving to the timeline. One panel open at a time.
- Each panel has a pin control. Pinned panels dock and reserve width — explicit user choice, never the default.

The source info panel holds a monospace table: codec, frame count, keyframe count, GOP length, bitrate, audio format, heap usage. This is reference material — read once, occasionally rechecked, never acted on mid-edit.

Three things were deliberately promoted *out* of the panel because they're used constantly:

- Trim mode → a two-state `copy | exact` segmented control at the right of the transport bar.
- Keyframe-shift notice → status bar, always visible.
- File size and format → a chip in the top bar.

`F` toggles full-screen preview: hides top bar, rail, and status bar, leaving preview + transport + a thin timeline. `Esc` restores.

---

## The timeline

This is the product. Give it the most attention.

**Ruler.** Tick density adapts to zoom: hours → minutes → seconds → frames. Labels never collide; drop to every 2nd, 5th, or 10th tick as needed. Label format follows zoom (`01:52` when zoomed out, `01:52:04:12` at frame level).

**Keyframe tick row.** A 4–6px band of thin vertical marks, one per keyframe. Not decoration — it shows where a stream-copy cut is allowed to land. Reads as texture when zoomed out, as individual targets when zoomed in.

**Thumbnail strip.** 48px continuous filmstrip, no gaps between frames. Thumbnails arrive progressively — coarse first, refining as you watch. Not-yet-loaded regions render as a flat placeholder tint. Never a spinner, never a layout shift.

**Trim region.** The kept range is at full brightness. Everything outside dims to ~28% opacity. The dim covers the thumbnail strip and waveform, not the ruler.

**In/out handles.** 8px wide, full height of the strip, accent-colored, with 12px invisible hit padding either side. `ew-resize` cursor on hover. While dragging, a floating timecode label sits above the handle.

**Playhead.** 1.5px vertical line spanning every row, with a small grab cap in the ruler. A different color from in/out so the two are never confused.

**Waveform.** 32px of centered peak bars. Accent-colored inside the trim region, muted gray outside. Loads after thumbnails — show an empty tinted band meanwhile rather than collapsing the layout.

**Zoom and pan.** Wheel scrolls horizontally. Ctrl/Cmd+wheel zooms, anchored at the cursor so the frame under the pointer stays fixed. Range: whole file visible → one frame ≈ 40px. Status bar shows the scale as "1 px = 4 frames".

**Snapping.** In/out handles snap to keyframes, the playhead, and clip edges within ~8px. Alt disables. When a snap engages, briefly flash the target tick.

---

## The interaction that defines the product

Stream-copy trimming can only start at a keyframe. Most tools either silently move the cut or force a slow re-encode. Do neither — make it visible and controllable.

1. User drags the in-handle to an arbitrary frame.
2. On release it snaps to the nearest preceding keyframe.
3. The status bar shows `in moved −0.84 s` in the warning color.
4. Hovering that notice offers two outs: "keep exact frame (re-encodes 2 s)" or "dismiss".

Make this feel considered. It's the moment that earns the user's trust.

---

## States to design

| State | What it looks like |
|---|---|
| **Empty** | Centered drop zone: "Drop a video file, or open one". Below it, the honest constraint: "Files stay on your machine. 20 GB and up is fine." |
| **Opening** | Preview is playable almost immediately. A determinate index progress bar runs across the ruler. Playback is never blocked by indexing. |
| **Indexing** | Status bar: "Reading index — 2.1 M frames". Timeline rows placeholder-tinted. In/out handles disabled until the index lands. |
| **Thumbnails generating** | Strip fills in from the viewport outward. Status bar: "thumbs 68%". No spinner over the video. |
| **Exporting** | Slim progress bar pinned under the top bar with bytes written, MB/s, and time remaining. The app stays fully interactive — the user can keep scrubbing. Cancel is always one click. |
| **Export done** | Inline toast with the output path, plus "Show in folder" and "Trim another range". Not a modal. |
| **Unsupported codec** | Preview replaced by an explanatory panel: "This file's codec can't be previewed in your browser, but it can still be trimmed." Timeline and export stay fully usable. This is a normal state, not an error screen. |
| **Degraded browser** | Export button carries a caption: "Saves via download — capped at 2 GB in this browser". Never a blocking dialog. |
| **Permission lost** | Inline banner in the top bar: "Reconnect file", one button. |

---

## Visual system

Dark, dense, quiet. The chrome recedes; the video and timeline are the only bright things.

| Token | Value |
|---|---|
| App background | `#0E0E0F` |
| Panel surface | `#1A1A1C` |
| Raised control | `#232326` |
| Hairline border | `#2E2E32`, 1px |
| Primary text | `#E8E8E6` |
| Secondary text | `#9A9A96` |
| Muted / metadata | `#6B6B68` |
| Accent — in/out, selection | `#4C8DF6` |
| Playhead | `#E2574F` |
| Success / ready | `#5DCAA5` |
| Warning / cut moved | `#EF9F27` |

- Every numeric readout — timecode, frame counts, file sizes, byte offsets — in monospace with **tabular figures**. Timecode that reflows as digits change is the most annoying thing a video tool can do.
- Radius 6px on controls, 8px on panels. No shadows except a focus ring and the rail popover.
- Icons: outline style, 16px in chrome, 20px in transport.
- Compact density: 28px control height, 8px gutters. Sentence case everywhere.

---

## Keyboard map

Surface these in a `?` overlay. Follow Premiere and Resolve muscle memory.

`Space`/`K` play·pause · `J`/`L` shuttle (repeat accelerates) · `←`/`→` step frame · `Shift+←/→` step second · `I`/`O` set in·out · `Shift+I`/`Shift+O` jump to in·out · `Alt+I`/`Alt+O` clear · `↑`/`↓` previous·next keyframe · `+`/`-` zoom · `Shift+Z` zoom to fit · `Home`/`End` start·end · `F` full-screen preview · `Cmd/Ctrl+E` export · `Cmd/Ctrl+Z` undo

---

## Copy rules

- Sentence case. No exclamation marks. No "please", "simply", or "successfully".
- Errors say what happened and what to do: "Couldn't write the file — the disk may be full. Try another location."
- Numbers always formatted: `19.4 GB`, `862,401 frames`, `01:52:04:12`. Never a raw float.
- Prefer a real number over a vague adjective. "147 MB in use" beats "low memory usage".

---

## Out of scope

Multi-track layering, transitions, effects, color tools, a media bin, project save/load. One source, one clip, one range. Designing for the future editor now will make the trimmer worse.
