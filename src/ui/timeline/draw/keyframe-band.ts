// Keyframe-tick draw: density-dependent ticks (full/short/stripe) painted into the ruler's own
// lower band. design/floating-chrome-changes.md's "4. Keyframe ticks merged into the ruler" --
// the row this used to own (its own background, border-bottom) is gone; ruler.ts now supplies the
// backdrop. See ../keyframe-density.ts for the density math (unchanged).

import { color } from '../../tokens.ts';
import { averageKeyframeIntervalTicks, keyframeDensity, visibleKeyframeTicks } from '../keyframe-density.ts';
import type { CanvasLike } from '../canvas-like.ts';
import type { Time, Viewport } from '../types.ts';

/** The band's top, in canvas px from the ruler's own origin -- design/floating-chrome-changes.md:
 * "position:absolute; ... top:14px; bottom:0". The old row's `top:0`/`top:5px` tick offsets are
 * now relative to this instead. */
export const KEYFRAME_BAND_TOP_PX = 14;
/** Ruler height (26) minus the band's top (14) -- the band runs to the ruler's own bottom edge. */
export const KEYFRAME_BAND_HEIGHT_PX = 12;
const SHORT_TICK_TOP = 5;
const STRIPE_PERIOD_PX = 8;

export interface KeyframeBandHighlights {
  /** Presentation ticks currently coinciding with the start or end point -- drawn accent-colored. */
  accentTimes: readonly Time[];
}

export function drawKeyframeBand(ctx: CanvasLike, widthPx: number, viewport: Viewport, keyframeTimes: Float64Array, highlights?: KeyframeBandHighlights): void {
  if (keyframeTimes.length < 2 || viewport.viewSpan <= 0) return;
  const intervalTicks = averageKeyframeIntervalTicks(keyframeTimes);
  const pxPerKeyframe = (intervalTicks / viewport.viewSpan) * widthPx;
  const density = keyframeDensity(pxPerKeyframe);

  if (density.mode === 'stripe') {
    ctx.globalAlpha = density.stripeOpacity;
    ctx.fillStyle = color.keyframeTickShort;
    for (let x = 0; x < widthPx; x += STRIPE_PERIOD_PX) {
      ctx.fillRect(x, KEYFRAME_BAND_TOP_PX, 1, KEYFRAME_BAND_HEIGHT_PX);
    }
    ctx.globalAlpha = 1;
    return;
  }

  const accentSet = new Set(highlights?.accentTimes ?? []);
  const ticks = visibleKeyframeTicks(keyframeTimes, viewport);
  const top = density.mode === 'full' ? KEYFRAME_BAND_TOP_PX : KEYFRAME_BAND_TOP_PX + SHORT_TICK_TOP;
  const bottom = KEYFRAME_BAND_TOP_PX + KEYFRAME_BAND_HEIGHT_PX;
  for (const tick of ticks) {
    ctx.strokeStyle = accentSet.has(tick.time) ? color.accent : density.mode === 'full' ? color.keyframeTickFull : color.keyframeTickShort;
    ctx.beginPath();
    ctx.moveTo(tick.x + 0.5, top);
    ctx.lineTo(tick.x + 0.5, bottom);
    ctx.stroke();
  }
}
