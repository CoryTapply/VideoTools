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
  /** Pre-resolved fill colors for each handle bar -- resolved by the caller (TimelineController's
   * draw loop, via draw/handle-color.ts's rest/hover/active transition), not here: this module only
   * draws, it doesn't own the hover/drag state machine or the color-lerp animation. */
  inFill: string;
  outFill: string;
}

function drawRoundedBar(ctx: CanvasLike, cx: number, top: number, height: number, width: number, radius: number): void {
  const x = cx - width / 2;
  ctx.beginPath();
  ctx.moveTo(x, top + radius);
  ctx.lineTo(x, top + height - radius);
  ctx.lineTo(x + width, top + height - radius);
  ctx.lineTo(x + width, top + radius);
  ctx.lineTo(x, top + radius);
  ctx.fill();
}

function drawHandle(ctx: CanvasLike, x: number, heightPx: number, fillColor: string): void {
  ctx.fillStyle = fillColor;
  drawRoundedBar(ctx, x, 0, heightPx, HANDLE_BAR_WIDTH_PX, HANDLE_BAR_RADIUS_PX);

  ctx.strokeStyle = color.handleGrip;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, (heightPx - GRIP_HEIGHT_PX) / 2);
  ctx.lineTo(x, (heightPx + GRIP_HEIGHT_PX) / 2);
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
  const { inX, outX, heightPx, inFill, outFill } = geometry;

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

  drawHandle(ctx, clampBarX(inX, widthPx), heightPx, inFill);
  drawHandle(ctx, clampBarX(outX, widthPx), heightPx, outFill);
}
