// Keyframe row draw: background, border-bottom, density-dependent ticks (full/short/stripe).
// design/README.md's "2. Keyframe row -- 15px" -- see ../keyframe-density.ts for the density math.

import { color, rowHeight } from '../../tokens.ts';
import { averageKeyframeIntervalTicks, keyframeDensity, visibleKeyframeTicks } from '../keyframe-density.ts';
import type { CanvasLike } from '../canvas-like.ts';
import type { Time, Viewport } from '../types.ts';

export const KEYFRAME_ROW_TOP = rowHeight.ruler;
export const KEYFRAME_ROW_HEIGHT = rowHeight.keyframes;
const SHORT_TICK_TOP = 5;
const STRIPE_PERIOD_PX = 8;

export interface KeyframeRowHighlights {
  /** Presentation ticks currently coinciding with the in or out point -- drawn accent-colored. */
  accentTimes: readonly Time[];
}

export function drawKeyframeRow(ctx: CanvasLike, widthPx: number, viewport: Viewport, keyframeTimes: Float64Array, highlights?: KeyframeRowHighlights): void {
  ctx.fillStyle = color.bgKeyframes;
  ctx.fillRect(0, KEYFRAME_ROW_TOP, widthPx, KEYFRAME_ROW_HEIGHT);
  ctx.strokeStyle = color.borderSubtle;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, KEYFRAME_ROW_TOP + KEYFRAME_ROW_HEIGHT - 0.5);
  ctx.lineTo(widthPx, KEYFRAME_ROW_TOP + KEYFRAME_ROW_HEIGHT - 0.5);
  ctx.stroke();

  if (keyframeTimes.length < 2 || viewport.viewSpan <= 0) return;
  const intervalTicks = averageKeyframeIntervalTicks(keyframeTimes);
  const pxPerKeyframe = (intervalTicks / viewport.viewSpan) * widthPx;
  const density = keyframeDensity(pxPerKeyframe);

  if (density.mode === 'stripe') {
    ctx.globalAlpha = density.stripeOpacity;
    ctx.fillStyle = color.keyframeTickShort;
    for (let x = 0; x < widthPx; x += STRIPE_PERIOD_PX) {
      ctx.fillRect(x, KEYFRAME_ROW_TOP, 1, KEYFRAME_ROW_HEIGHT);
    }
    ctx.globalAlpha = 1;
    return;
  }

  const accentSet = new Set(highlights?.accentTimes ?? []);
  const ticks = visibleKeyframeTicks(keyframeTimes, viewport);
  const top = density.mode === 'full' ? KEYFRAME_ROW_TOP : KEYFRAME_ROW_TOP + SHORT_TICK_TOP;
  const bottom = KEYFRAME_ROW_TOP + KEYFRAME_ROW_HEIGHT;
  for (const tick of ticks) {
    ctx.strokeStyle = accentSet.has(tick.time) ? color.accent : density.mode === 'full' ? color.keyframeTickFull : color.keyframeTickShort;
    ctx.beginPath();
    ctx.moveTo(tick.x + 0.5, top);
    ctx.lineTo(tick.x + 0.5, bottom);
    ctx.stroke();
  }
}
