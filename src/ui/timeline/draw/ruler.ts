// Ruler row draw: background, border-bottom, major/minor ticks, labels. design/README.md's
// "1. Ruler -- 22px" -- see ../ruler-ticks.ts for the adaptive step math this consumes.

import { color, rowHeight, type as typeTokens } from '../../tokens.ts';
import { generateRulerTicks } from '../ruler-ticks.ts';
import type { CanvasLike } from '../canvas-like.ts';
import type { Time, Viewport } from '../types.ts';

export const RULER_HEIGHT = rowHeight.ruler;
const MAJOR_TICK_TOP = 4;
const MINOR_TICK_HEIGHT = 6;
const LABEL_OFFSET_X = 4;

export function drawRuler(ctx: CanvasLike, widthPx: number, viewport: Viewport, timescale: number, ticksPerFrame: Time, fps: number): void {
  // No fill here -- the ruler row shows the canvas's own bgBase backdrop through
  // (TimelineRegion.module.css's placeholder never gave `.ruler` its own background either).
  ctx.strokeStyle = color.borderSubtle;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, RULER_HEIGHT - 0.5);
  ctx.lineTo(widthPx, RULER_HEIGHT - 0.5);
  ctx.stroke();

  const ticks = generateRulerTicks(viewport, timescale, ticksPerFrame, fps);
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
      ctx.fillText(tick.label, tick.x + LABEL_OFFSET_X, RULER_HEIGHT - MAJOR_TICK_TOP - 2);
    }
  }
}
