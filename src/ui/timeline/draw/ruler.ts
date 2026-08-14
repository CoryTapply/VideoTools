// Ruler row draw: background, border-bottom, major/minor ticks, labels, and (per
// design/floating-chrome-changes.md's "4. Keyframe ticks merged into the ruler") the keyframe-tick
// band in its lower 12px. design/README.md's "1. Ruler -- 26px, and it now carries the keyframe
// ticks" -- see ../ruler-ticks.ts for the adaptive step math this consumes.

import { color, rowHeight, type as typeTokens } from '../../tokens.ts';
import { generateRulerTicks } from '../ruler-ticks.ts';
import { drawKeyframeBand, KEYFRAME_BAND_TOP_PX } from './keyframe-band.ts';
import type { CanvasLike } from '../canvas-like.ts';
import type { KeyframeBandHighlights } from './keyframe-band.ts';
import type { Time, Viewport } from '../types.ts';

export const RULER_HEIGHT = rowHeight.ruler;
const MINOR_TICK_HEIGHT = 6;
const LABEL_OFFSET_X = 4;
// Sits in the ruler's top band, clear of the keyframe-tick band that starts at
// KEYFRAME_BAND_TOP_PX -- labels were previously anchored to RULER_HEIGHT's own bottom edge, which
// was correct back when that band was a separate row below the ruler, but now overlaps it.
const LABEL_BASELINE_Y = KEYFRAME_BAND_TOP_PX - 2;

export function drawRuler(
  ctx: CanvasLike,
  widthPx: number,
  viewport: Viewport,
  timescale: number,
  ticksPerFrame: Time,
  keyframeTimes: Float64Array,
  keyframeHighlights?: KeyframeBandHighlights,
): void {
  // No fill here -- the ruler row shows the canvas's own bgBase backdrop through
  // (TimelineRegion.module.css's placeholder never gave `.ruler` its own background either).
  ctx.strokeStyle = color.borderSubtle;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, RULER_HEIGHT - 0.5);
  ctx.lineTo(widthPx, RULER_HEIGHT - 0.5);
  ctx.stroke();

  // Keyframe ticks paint under the time labels drawn below -- design/floating-chrome-changes.md:
  // "the ticks read clearly under the time labels".
  drawKeyframeBand(ctx, widthPx, viewport, keyframeTimes, keyframeHighlights);

  const ticks = generateRulerTicks(viewport, timescale, ticksPerFrame);
  ctx.font = `${typeTokens.size[1].toString()}px ${typeTokens.fontMono}`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  for (const tick of ticks) {
    ctx.strokeStyle = tick.major ? color.textDisabled : color.tickMinor;
    ctx.beginPath();
    if (tick.major) {
      ctx.moveTo(tick.x + 0.5, 0);
      ctx.lineTo(tick.x + 0.5, RULER_HEIGHT);
    } else {
      ctx.moveTo(tick.x + 0.5, RULER_HEIGHT - MINOR_TICK_HEIGHT);
      ctx.lineTo(tick.x + 0.5, RULER_HEIGHT);
    }
    ctx.stroke();

    if (tick.label !== null) {
      ctx.fillStyle = color.textTertiary;
      ctx.fillText(tick.label, tick.x + LABEL_OFFSET_X, LABEL_BASELINE_Y);
    }
  }
}
