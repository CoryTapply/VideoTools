// The snap-flash indicator: a 2px line at the snapped position, fading out over motion.snapFlashMs
// -- design/README.md's "Snap flash". `startedAt`/`now` are both performance.now()-style
// timestamps; the caller (TimelineController) is responsible for clearing
// TimelineControllerState.snapFlash back to null once expired, this module just computes opacity.

import { color, motion } from '../../tokens.ts';
import type { CanvasLike } from '../canvas-like.ts';

const TOP_PX = 22; // below the ruler, matching rowHeight.ruler -- the flash starts at the keyframe row.

/** 1 (just snapped) fading linearly to 0 over motion.snapFlashMs; null once fully expired. */
export function snapFlashOpacity(startedAt: number, now: number): number | null {
  const elapsed = now - startedAt;
  if (elapsed < 0 || elapsed >= motion.snapFlashMs) return null;
  return 1 - elapsed / motion.snapFlashMs;
}

export function drawSnapFlash(ctx: CanvasLike, x: number, heightPx: number, opacity: number): void {
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = color.good;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, TOP_PX);
  ctx.lineTo(x, heightPx);
  ctx.stroke();
  ctx.globalAlpha = 1;
}
