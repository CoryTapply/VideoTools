// In/out region draw: dim overlays outside the selection, top/bottom selection borders, and
// handle bars+grips. design/README.md's "In/out region" -- see ../drag-gesture.ts for the
// hit-testing this geometry is drawn to match. The hover/drag IN/OUT chip is a DOM overlay drawn
// by TimelineRegion.tsx/TimelineController.ts, not this module -- see design/scrub-chip-prompt.md.

import { color } from '../../tokens.ts';
import type { CanvasLike } from '../canvas-like.ts';

const HANDLE_BAR_WIDTH_PX = 8;
const HANDLE_BAR_RADIUS_PX = 2;
const GRIP_HEIGHT_PX = 14;

export interface HandlesGeometry {
  inX: number;
  outX: number;
  heightPx: number;
  /** Top of the handle bars/grips, in canvas px -- the filmstrip row's top, not the canvas's, so
   * the bars start level with the first thumbnail rather than poking up through the ruler row. The
   * dim overlays and selection borders are unaffected and still span the full 0..heightPx. */
  barTopPx: number;
  /** Pre-resolved fill colors for each handle bar -- resolved by the caller (TimelineController's
   * draw loop, via draw/handle-color.ts's rest/hover/active transition), not here: this module only
   * draws, it doesn't own the hover/drag state machine or the color-lerp animation. */
  inFill: string;
  outFill: string;
}

/** Corners are chamfered (cut with a short diagonal) rather than true arcs, matching
 * playhead.ts's drawHeadShape -- CanvasLike exposes only line/move primitives, no arcTo, and at
 * radius 2 a chamfer and a true arc are visually indistinguishable. */
function drawRoundedBar(ctx: CanvasLike, cx: number, top: number, height: number, width: number, radius: number): void {
  const x = cx - width / 2;
  const bottom = top + height;
  const right = x + width;
  ctx.beginPath();
  ctx.moveTo(x, top + radius);
  ctx.lineTo(x, bottom - radius);
  ctx.lineTo(x + radius, bottom);
  ctx.lineTo(right - radius, bottom);
  ctx.lineTo(right, bottom - radius);
  ctx.lineTo(right, top + radius);
  ctx.lineTo(right - radius, top);
  ctx.lineTo(x + radius, top);
  ctx.lineTo(x, top + radius);
  ctx.fill();
}

function drawHandle(ctx: CanvasLike, x: number, topPx: number, heightPx: number, fillColor: string): void {
  const barHeight = heightPx - topPx;
  ctx.fillStyle = fillColor;
  drawRoundedBar(ctx, x, topPx, barHeight, HANDLE_BAR_WIDTH_PX, HANDLE_BAR_RADIUS_PX);

  ctx.strokeStyle = color.handleGrip;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, topPx + (barHeight - GRIP_HEIGHT_PX) / 2);
  ctx.lineTo(x, topPx + (barHeight + GRIP_HEIGHT_PX) / 2);
  ctx.stroke();
}

/** Nudges a handle's *drawn* x so the full bar always stays on-canvas, even when the true edge
 * is at x=0 or x=widthPx (the default full-clip selection). Without this, a bar centered exactly
 * on the boundary has its outer half clipped -- losing its rounded corner and reading as a flush
 * border rather than a grabbable handle, which is never how the design mockups show it (they
 * always have room on both sides). Hit-testing (drag-gesture.ts) still uses the true, unclamped
 * edge position -- only the paint position moves. */
export function clampBarX(x: number, widthPx: number): number {
  const half = HANDLE_BAR_WIDTH_PX / 2;
  return Math.min(Math.max(x, half), widthPx - half);
}

export function drawHandles(ctx: CanvasLike, widthPx: number, geometry: HandlesGeometry): void {
  const { inX, outX, heightPx, barTopPx, inFill, outFill } = geometry;

  ctx.fillStyle = color.dim;
  if (inX > 0) ctx.fillRect(0, 0, Math.min(inX, widthPx), heightPx);
  if (outX < widthPx) ctx.fillRect(Math.max(outX, 0), 0, widthPx - Math.max(outX, 0), heightPx);

  ctx.strokeStyle = color.selectionBorder;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(inX, 0.75);
  ctx.lineTo(outX, 0.75);
  ctx.moveTo(inX, heightPx - 0.75);
  ctx.lineTo(outX, heightPx - 0.75);
  ctx.stroke();

  drawHandle(ctx, clampBarX(inX, widthPx), barTopPx, heightPx, inFill);
  drawHandle(ctx, clampBarX(outX, widthPx), barTopPx, heightPx, outFill);
}
