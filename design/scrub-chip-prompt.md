# Change request: IN/OUT scrub time chips + handle polish

Two changes to the trimmer timeline: replace the raw timecode label that appears while dragging with a hover/drag tooltip chip, and clean up the handle geometry and cursors.

## 1. Remove the current drag timecode label

Today, moving an IN/OUT handle shows a full SMPTE timecode (`00:05:54:09`) as a blue label under the ruler. Remove it entirely — the label element, its position calculation, and any state feeding it.

## 2. Add the IN/OUT chip

A single chip per handle, anchored to that handle's edge, pointing down at it with a hairline leader.

Markup structure (one per handle):

```
chip wrapper   position:absolute; left:<handle edge %>; transform:translateX(-50%);
               bottom: calc(100% - <clip region top offset>)  /* see "Attachment" below */
               z-index:60; pointer-events:none;
               display:flex; flex-direction:column; align-items:center;
  chip         display:flex; align-items:center; gap:7px;
               padding:4px 8px; border-radius:6px;
               background:rgba(14,14,15,.94); border:1px solid #2E2E32;
               box-shadow:0 4px 14px rgba(0,0,0,.5); white-space:nowrap;
    tag        "IN" / "OUT" — mono, 9.5px, letter-spacing:.1em, color:#4C8DF6
    time       mono, 12.5px, color:#E8E8E6
  hairline     width:1px; height:9px; background:#4C8DF6;
```

The chip is never a solid blue pill — dark chip on a blue tag so it stays readable over bright frames.

### Attachment — the chip must touch the handle

The chip sits fully **above** the timeline, floating over the video panel, with the bottom of its 9px hairline landing exactly on the top edge of the clip region, which is also the top edge of the handle bar. No gap, and no overlap onto the clip: hairline bottom == handle top, so the two read as one connected object.

Do not place the chip inside the clip region (e.g. a small `top` offset like `top:30px`) — that leaves it floating over the thumbnails with the hairline buried in the blue bar, which reads as detached.

To achieve this, anchor from the bottom of the timeline container rather than the top:

- the chip wrapper is `position:absolute` inside the timeline container,
- `bottom: calc(100% - Npx)` where **N is the y offset of the clip region's top edge within that container** (ruler height + its bottom border — 27px in the current layout: 26px ruler + 1px border),
- the timeline container must be `overflow: visible` so the chip can extend above it. The ruler row, thumbnail row and waveform row each keep their own `overflow: hidden`, so nothing else escapes.

The chip travels horizontally with the handle edge, so it stays attached at every scroll and zoom level.

### Visibility rules

Show the chip for a handle when either is true:

- the pointer is hovering that handle's hit area (and no drag is in progress), or
- that handle is being dragged.

Hide it otherwise. Never show both chips at once except when both conditions independently apply — hover is suppressed while a drag is active, so during a drag only the dragged handle's chip is visible. The chip must keep rendering during the whole drag even if the pointer leaves the handle's hit area (the drag is tracked on `window`), and must disappear on mouse-up if the pointer is no longer over the handle.

No fade-in delay; the chip appears immediately on hover.

### Time format

Not SMPTE. Human-readable, minutes and seconds, hours only when nonzero:

- `23m 02s` — under an hour, minutes unpadded, seconds always 2 digits
- `1h 24m 02s` — one hour or more, hours unpadded, minutes and seconds padded to 2 digits

```js
const p2 = n => String(Math.floor(n)).padStart(2, '0');
function hms(seconds) {
  const t = Math.round(Math.max(0, seconds));
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  return h > 0 ? `${h}h ${p2(m)}m ${p2(s)}s` : `${m}m ${p2(s)}s`;
}
```

Round to the nearest whole second (no frames, no fractional seconds).

## 3. Handle geometry — de-blocked

The handles currently render as hard-edged blocks. Exact target spec:

- **Hit area** (invisible): 32px wide, full height of the clip region, centred on the edge — `left:<edge %>; width:32px; transform:translateX(-16px)`. Background transparent. This is the only element with pointer handlers.
- **Visible bar**: 8px wide, full height, centred inside the hit area (`left:12px`), `border-radius:2px`, `background:#4C8DF6`. Rounded on all four corners — not square, and not a full pill.
- **Grip**: 2px × 14px, `border-radius:1px`, `background:rgba(11,18,32,.55)`, centred vertically and horizontally in the bar.
- **Bar fill states**: `#4C8DF6` at rest, `#6BA0F9` on hover, `#7FB0FF` while that handle is being dragged. Transition `background .12s ease-out`. Hover highlight is suppressed while any drag is in progress, so an unhovered handle never lights up mid-drag; the dragged handle keeps its `#7FB0FF` fill until mouse-up regardless of where the pointer is.
- The region between the handles keeps its 1.5px `rgba(76,141,246,.55)` top and bottom rules; the outside is dimmed with `rgba(10,10,11,.72)`.

## 4. Cursors

- Handle hit area at rest and on hover: `cursor: ew-resize`.
- While dragging: keep `ew-resize` and pin it globally — on mousedown set `document.body.style.cursor = 'ew-resize'` and add `user-select: none`; restore both on mouseup. Without this the cursor flickers to the underlying element's cursor as the pointer runs off the handle.
- Do not use `col-resize`, `grab`, or `grabbing` anywhere on the handles.
- The chip and its hairline are `pointer-events:none` so they never steal the cursor from the handle underneath.

## Acceptance checks

- Hovering the IN handle shows one chip reading e.g. `IN  23m 02s`; leaving hides it.
- Dragging past the one-hour mark switches the format to `1h 24m 02s` with no layout jump other than the chip widening.
- Dragging with the pointer far above or below the timeline keeps the chip visible and following the handle.
- The hairline's bottom pixel touches the handle's top pixel — no gap, no overlap — at every timeline height and zoom level, and the chip is drawn over the video panel, not over the thumbnails.
- No SMPTE timecode appears anywhere on the timeline during a drag.
- Cursor is `ew-resize` from hover through mouse-up, with no flicker.
- Handle bar visibly brightens on hover and brightens further while dragging, and returns to `#4C8DF6` once the pointer leaves after mouse-up.
