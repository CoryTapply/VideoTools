# Claude Code prompt — global volume control

Copy everything below into Claude Code.

---

Add a global output volume control to the video trimmer's floating transport bar.

## Where it goes

In the transport bar, immediately after the play/step/keyframe button group and before the in/out/dur timecode readouts. It must not change the bar's resting width — the bar is centered with `translateX(-50%)` and already close to the stage width when the side panel is pinned.

## Behavior

**Speaker button** (26×26, same radius/hover treatment as the transport buttons)
- Click toggles mute. `M` also toggles it (add to the existing keydown map and to the keyboard-shortcuts overlay as "M — mute output").
- Icon reflects state: crossed-out speaker when muted, one arc when volume ≤ 55%, two arcs above that.
- When muted, the button gets the warning color (`#EF9F27`) and an active background.

**Volume popover**
- Appears on hover over the speaker button, anchored above it, centered horizontally. Absolutely positioned so the transport bar's layout width never changes.
- Panel chrome matches the existing float panel: `background:#1A1A1C`, `1px solid #2E2E32`, radius 8, `0 10px 26px rgba(0,0,0,.5)`, short fade-in.
- Contents: an 84px horizontal slider plus a 28px readout slot.
- Closes ~250 ms after the pointer leaves the group, so travel from button to slider doesn't dismiss it.

**Slider**
- 3px track (`#26262A`), filled portion `#4C8DF6`, 9px round knob with a 2px ring in the panel background so it reads against the fill.
- Drag anywhere on the track sets the level from the pointer's x position within the track rect; mousedown sets it immediately, then follows mousemove until mouseup. Range 0–1, clamped.
- Dragging while muted unmutes.
- Muted state greys the fill and knob to `#4A4A4E`.

**Readout slot**
- Unmuted: percentage in the mono face, 11px, `#9A9A96` (e.g. `72%`).
- Muted: the crossed-out speaker icon in `#EF9F27`, centered in the same 28px slot — no text.

## Wiring

- State: `vol` (0–1, default 0.70), `muted` (bool), `volOpen` (bool, hover).
- The gain applies to the preview player only. It is a monitoring control and must not affect export output.
- keybinds to change volume up and down by increments of 0.05 with SHIFT + arrow up / SHIFT + arrow down
- keybind to toggle mute with the `m` key

## Constraints

- Inline styles only, matching the file's existing conventions (dark palette `#0E0E0F` / `#1A1A1C` / `#2E2E32`, accent `#4C8DF6`, warning `#EF9F27`, `var(--ui)` / `var(--mono)` faces).
- Verify at a 900px-wide viewport with the side panel pinned: the transport bar must stay fully inside the stage with the popover open — the leading timecode must not clip and the trim toggle must not be pushed past the right edge.

