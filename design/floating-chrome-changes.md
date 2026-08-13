# Change note: floating chrome and a taller preview

Current as of this revision. Supersedes the README's title bar, transport bar, status bar, ruler and keyframe-row sections. Screenshots `01-ready.png` (chrome visible) and `02-chrome-hidden.png` (after idle) are the target.

## Why it changed

On a wide window the preview is limited by height, not width: a 16:9 frame fits vertically and the leftover width goes black. In a 2560 × 1440 window, 581px of the height was chrome — 40 title bar, 36 transport, 30 status, 475 timeline — leaving the frame 1499px wide with roughly 505px of black on each side.

Chrome height converts to frame width at about 1.78:1, so every 10px removed gives the frame 18px. This revision reclaims 106px of column height (title, transport, status) plus 11px from merging the keyframe row into the ruler.

## What changed

### 1. Title bar floats over the preview

It is no longer a 40px row in the column. Same contents, same order, now an absolutely-positioned overlay:

```
position:absolute; left:0; top:0; right:<railWidth>; height:44px; z-index:32;
display:flex; align-items:center; gap:10px; padding:0 12px;
background:linear-gradient(rgba(11,11,12,.94), rgba(11,11,12,0));
opacity:<1 | 0>; pointer-events:<auto | none>; transition:opacity .18s ease-out;
```

`right` is the icon rail (34px), or rail + pinned panel (292px) when a panel is pinned, so the overlay never crosses the rail. The `border-bottom` is gone — the scrim does that job. Everything inside (green dot, filename, format chip, degraded reconnect chip, Open, Export clip) keeps its existing spec.

### 2. Transport becomes a floating pill

```
position:absolute; bottom:<timelineHeight + 19>px; left:calc(50% - <railWidth / 2>px);
transform:translateX(-50%); height:40px; z-index:32;
display:flex; align-items:center; gap:16px; padding:0 14px;
border:1px solid #2E2E32; border-radius:10px; background:rgba(14,14,15,.9);
box-shadow:0 10px 28px rgba(0,0,0,.45);
opacity:<1 | 0>; pointer-events:<auto | none>; transition:opacity .18s ease-out;
```

Centered over the preview area, sitting 14px above the splitter. Contents are unchanged except that the `flex:1` spacer is gone (the pill hugs its content) and gaps went 14 → 16. Height 36 → 40.

### 3. Status bar removed

The zoom, thumbs and index readouts are gone from the UI entirely. Keep computing them if something else needs them, but they no longer render.

The keyframe-shift notice, which used to live at the right end of that bar, is now a floating chip:

```
position:absolute; right:14px; margin-right:<railWidth>;
bottom:<timelineHeight + 71>px; z-index:34;
```

The chip and its popover keep their existing spec, including the popover opening upward at `bottom:30px`.

### 4. Keyframe ticks merged into the ruler

The 15px keyframe row is deleted. The ruler goes 22px → 26px and hosts the ticks in its lower band:

```
position:absolute; left:0; right:0; top:14px; bottom:0; overflow:hidden;
```

Inside that band: the low-zoom `kfBand` gradient at its computed opacity, then the individual ticks. All existing tick rules carry over (≥16px spacing → full-height `#8A8A92`; 3–16px → short ticks from `top:5px` `#6E6E76`; <3px → gradient band; ticks coinciding with in/out → `#4C8DF6`). Because the band is 12px tall, `top:0` and `top:5px` now mean 0 and 5px inside the band, under the time labels.

Two dependent offsets moved with it: the drag label `top: 26px → 30px`, the snap flash `top: 22px → 26px`.

### 5. Auto-hide behaviour

State `chromeVisible`, default true. `pointermove` and `pointerdown` on the window, and any key input, set it true and re-arm a 2000ms timer. On expiry it goes false — unless any of these hold, in which case the timer simply does not hide:

- the pointer is over the title overlay or the transport pill (hover pins them)
- a rail panel is open or pinned
- the keyboard-shortcut sheet is open
- there is no file open (the empty state never hides its chrome)

Both overlays cross-fade over 180ms and take `pointer-events:none` while hidden, so a hidden pill never eats a click meant for the frame.

### 6. In-frame readout cross-fades

The frame-count + timecode readout at the preview's bottom-left is the inverse of the chrome: `opacity: chromeVisible ? 0 : 1`, same 180ms transition. It would otherwise sit under the pill, and the pill already shows the timecode. This is the only place the current frame is visible once the chrome hides, so do not remove it.

### 7. Export progress overlay moved down

`top: 14px → 56px`, so it clears the floating title bar instead of colliding with it.

## Result

At 2560 × 1440 with the timeline at its 236px default, the frame goes from 1499 × 843 to about 1714 × 964 — 215px wider, with the black bars down from roughly 505px to 398px per side.

## Unchanged

Timeline internals below the ruler (filmstrip, waveform, in/out handles, dim overlays, playhead), splitter, icon rail, all panels, every token, keyboard map, and all other screen states. The full-screen `F` mode still works and now simply hides the overlays as well.
