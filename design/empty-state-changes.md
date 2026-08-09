# Change note: Empty state (no file open)

Supersedes the **Empty state** paragraph in `README.md` and screenshot `screenshots/08-empty.png` (re-captured). Everything else in the README is unchanged.

## Why it changed

The old empty state was a single small dashed card floating in an otherwise fully-populated chrome: a live title bar showing "No file open", a status bar with zoom and index readouts, and three rail panels that opened to real-looking metadata. That gave the screen two problems. It advertised state that did not exist, and it gave the user only one thing to do (drop a file) while showing a dozen controls that could not respond.

The revision does two things: strips chrome that has nothing to report, and replaces panel contents with skeletons that say what will fill in.

## What changed

### 1. Top bar and status bar are hidden

In `screen === 'empty'` the 40px title bar and the 30px status bar are not rendered at all. The icon rail runs full height against the right edge.

Rationale: with no file, the title bar carried a dead dot, the string "No file open", and a format chip with nothing to put in it; the status bar had no zoom, thumb, or index numbers to show. Both were removed rather than filled with placeholder values.

The rail stays because its three panels are the explanation surface for what the app is about to do.

### 2. Drop target is larger and directly actionable

| | Before | After |
|---|---|---|
| Card width | `min(520px, 80%)` | `min(560px, 78%)` |
| Padding | `40px 32px` | `52px 40px` |
| Border | `1px dashed #2E2E32`, radius 8 | `1px dashed #34343A`, radius 10 |
| Icon tile | 34px | 44px, radius 8, border `#2E2E32`, bg `#1A1A1C`, 20px stroke icon `#9A9A96` |
| Headline | "Drop an MP4 or MOV file, or open one" (14px) | "Drop a video file to start trimming" (16px) |
| Sub | "Files stay on your machine. 20 GB and up is fine." | "Nothing uploads — the file is read from disk in this tab." (12.5px `#6B6B68`, `max-width:340px`, `line-height:1.5`) |
| Action | none — the card was the only affordance | `Choose file` button + `⌘O` hint |

Card hover unchanged: border `#4C8DF6`, bg `#131317`. The whole card is clickable, not just the button.

`Choose file`: 30px tall, `0 16px`, radius 6, bg + border `#4C8DF6`, text `#0B1220` weight 600 at 12.5px, hover `#5E99F7`. `⌘O` sits 8px to its right in Plex Mono 11px `#4A4A4E`. Button row has `margin-top:10px`.

The headline dropped the container list. Which containers open is a support question, not a first-run instruction, and the unsupported-codec state already handles the failure case properly.

### 3. Recent files list

New. Sits 26px below the drop card, same `min(560px, 78%)` width, `7px` row gap.

- Header: `Recent`, 10.5px uppercase, `letter-spacing:.06em`, `#4A4A4E`, `padding-bottom:5px`, rule `1px #1F1F23`.
- Row: `display:flex`, `align-items:baseline`, `justify-content:space-between`, gap 16, padding `5px 6px`, radius 5, hover bg `#141416`, pointer cursor.
- Filename: Plex Mono 11.5px `#9A9A96`, `white-space:nowrap`, ellipsized on overflow.
- Timestamp: Plex Mono 11px `#4A4A4E`, `white-space:nowrap`, right-aligned.

Fixture rows (three; the real list should cap at 3–5):

| name | when |
|---|---|
| `rec_2026-07-18_session-4.mp4` | yesterday |
| `rec_2026-07-11_session-3.mp4` | last week |
| `capture_2026-06-29.mov` | Jun 29 |

Note for implementation: File System Access handles can be persisted in IndexedDB and re-acquired with `queryPermission`/`requestPermission`, so a recent list is real functionality, not a mock. A handle whose permission is denied on re-open should route to the degraded state's reconnect flow rather than erroring.

### 4. Panels show skeletons, not fabricated data

All three rail panels (Source, Export, Jobs) still open in the empty state, keep their titles, and render a skeleton body plus one explanatory line. No numbers, no track names, no fake values anywhere.

**Key/value skeleton rows** — one per row that will exist once a file is open: 8 rows for Source and Export, 5 for Jobs. Each row is `height:16px`, `justify-content:space-between`, with two 7px-tall radius-3 bars — label bar `#202024` on the left, value bar `#26262A` on the right. Bar widths vary per row (40–70px) so the block does not read as a grid.

**Track skeleton** (Source and Export only, above the key/value rows, matching the real panel order): the `TRACKS` header rule stays with a 52px `#26262A` bar where the count goes. Five rows follow, each `padding:4px`, gap 7: an inert `11×11` radius-3 box with `1px #2A2A2E` border (checkbox placeholder, unchecked, not interactive), an 18px id bar, then a two-line stack — 8px name bar and 6px meta bar, widths varying per row.

**Pulse**: every bar runs `om-pulse 1.6s ease-in-out infinite`. The checkbox outlines do not pulse — they are structure, not pending content.

**Note line** — 11px `#4A4A4E`, `line-height:1.45`, `margin-top:6px`, below the skeleton:

- Source — "Container, codec and track list are read once a file is open."
- Export — "Export settings unlock when a file is open."
- Jobs — "No jobs yet — indexing starts when a file is open."

Skeletons render identically in floating and pinned panels.

### 5. Inert interactions

Timeline scrubbing, in/out handle drags, and export are all no-ops while `screen === 'empty'`. Panel open/close, pinning, and the keyboard overlay still work.

## Unchanged

Preview surround color, rail geometry and icons, panel chrome (position, width, header, pin, fade timing, hover-open and close delays), all tokens. Every other screen state.
