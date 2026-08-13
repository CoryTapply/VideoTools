// In/out region draw: dim overlays outside the selection, top/bottom selection borders, handle
// bars+grips, and the drag timecode chip. design/README.md's "In/out region" -- see
// ../drag-gesture.ts for the hit-testing this geometry is drawn to match.

import { color, type as typeTokens } from '../../tokens.ts';
import type { CanvasLike } from '../canvas-like.ts';
import type { DragTarget } from '../../state/timeline-controller-state.ts';

const HANDLE_BAR_WIDTH_PX = 8;
const HANDLE_BAR_RADIUS_PX = 2;
const GRIP_HEIGHT_PX = 16;
const CHIP_TOP_PX = 30;
const CHIP_PADDING_X_PX = 6;
const CHIP_HEIGHT_PX = 18;
/** No measureText() in CanvasLike (kept narrow on purpose -- see canvas-like.ts) -- a fixed
 * per-character advance is close enough for Azeret Mono at this size to size the chip's background. */
const CHIP_CHAR_WIDTH_PX = 6.5;

export interface HandlesGeometry {
  inX: number;
  outX: number;
  heightPx: number;
  /** Which handle (if any) is actively being dragged -- the dragged one draws brighter and shows
   * the timecode chip. */
  drag: DragTarget;
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

function drawHandle(ctx: CanvasLike, x: number, heightPx: number, active: boolean): void {
  ctx.fillStyle = active ? color.accentActive : color.accent;
  drawRoundedBar(ctx, x, 0, heightPx, HANDLE_BAR_WIDTH_PX, HANDLE_BAR_RADIUS_PX);

  ctx.strokeStyle = color.handleGrip;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, (heightPx - GRIP_HEIGHT_PX) / 2);
  ctx.lineTo(x, (heightPx + GRIP_HEIGHT_PX) / 2);
  ctx.stroke();
}

function drawTimecodeChip(ctx: CanvasLike, x: number, label: string): void {
  const chipWidth = label.length * CHIP_CHAR_WIDTH_PX + CHIP_PADDING_X_PX * 2;
  ctx.fillStyle = color.accent;
  drawRoundedBar(ctx, x, CHIP_TOP_PX, CHIP_HEIGHT_PX, chipWidth, 4);
  ctx.font = `${typeTokens.size[4].toString()}px ${typeTokens.fontMono}`;
  ctx.fillStyle = color.accentOn;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x, CHIP_TOP_PX + CHIP_HEIGHT_PX / 2);
}

/** Nudges a handle's *drawn* x so the full bar always stays on-canvas, even when the true edge
 * is at x=0 or x=widthPx (the default full-clip selection). Without this, a bar centered exactly
 * on the boundary has its outer half clipped -- losing its rounded corner and reading as a flush
 * border rather than a grabbable handle, which is never how the design mockups show it (they
 * always have room on both sides). Hit-testing (drag-gesture.ts) still uses the true, unclamped
 * edge position -- only the paint position moves. */
function clampBarX(x: number, widthPx: number): number {
  const half = HANDLE_BAR_WIDTH_PX / 2;
  return Math.min(Math.max(x, half), widthPx - half);
}

/** `chipLabel` is pre-formatted by the caller (state/snap-notice.ts's formatTimecode) -- this
 * module only draws, it doesn't know the track's frame rate. Pass null while not dragging. */
export function drawHandles(ctx: CanvasLike, widthPx: number, geometry: HandlesGeometry, chipLabel: string | null): void {
  const { inX, outX, heightPx, drag } = geometry;

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

  const barInX = clampBarX(inX, widthPx);
  const barOutX = clampBarX(outX, widthPx);
  drawHandle(ctx, barInX, heightPx, drag === 'in');
  drawHandle(ctx, barOutX, heightPx, drag === 'out');

  if (drag !== null && chipLabel !== null) {
    drawTimecodeChip(ctx, drag === 'in' ? barInX : barOutX, chipLabel);
  }
}
