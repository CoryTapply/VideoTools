# Change request: waveform band — bottom-anchored bars

Replace the centered/mirrored waveform bars in the timeline's waveform row with bottom-anchored bars (VU-meter style).

## Current behavior

The waveform row renders one `sc-for` over a `wave` array, each item a 2px-wide `div` centered vertically (`top:50%; transform:translateY(-50%)`) with a per-sample height and color.

## Change

Keep the same `wave` data shape and generation logic (sample step, height calc, in/out coloring) — only change how each bar is positioned and its corner radius:

- Anchor each bar to the bottom of the 26px row instead of the vertical center: `position:absolute; left:<w.left>; bottom:0; width:2px; height:<w.h>`.
- Remove the `top:50%; transform:translateY(-50%)` centering.
- Round only the top corners: `border-radius:1px 1px 0 0` (was `border-radius:1px` all around).
- Slightly reduce bar height so bars don't touch the top of the row on the tallest peaks — multiply the existing height calculation by 0.9.
- Everything else is unchanged: the 5px sample step, `#2E2E33` outside the selection, `rgba(76,141,246,.62)` inside, the 26px row height, and the row's background/border.

## Where

The waveform row markup and its `wave` array construction, inside the trimmer's timeline (`Video Trimmer.dc.html`) — the `sc-if value="showWaveform"` block and the `/* waveform — quiet secondary band */` section of `renderVals()`.

## Acceptance

- Bars grow up from the bottom edge of the waveform row, not out from the middle.
- Bar tops are rounded, bottoms are square against the row's bottom edge.
- Selection coloring and the 26px row height are unchanged.
