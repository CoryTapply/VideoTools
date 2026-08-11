// Playhead draw: 1.5px line + 11x11 head. design/README.md's "Playhead" -- z-index 22 (drawn last,
// on top of everything else in the row stack), never intercepts pointer events (canvas has no
// per-element hit-testing to suppress; the controller simply never hit-tests this pixel run).

import { color } from '../../tokens.ts';
import type { CanvasLike } from '../canvas-like.ts';

const LINE_WIDTH = 1.5;
const HEAD_SIZE = 11;
const HEAD_RADIUS = 3;

export function drawPlayhead(ctx: CanvasLike, x: number, topPx: number, heightPx: number): void {
  ctx.strokeStyle = color.playhead;
  ctx.lineWidth = LINE_WIDTH;
  ctx.beginPath();
  ctx.moveTo(x, topPx);
  ctx.lineTo(x, topPx + heightPx);
  ctx.stroke();

  ctx.fillStyle = color.playhead;
  drawHeadShape(ctx, x - HEAD_SIZE / 2, topPx, HEAD_SIZE, HEAD_SIZE, HEAD_RADIUS);
  ctx.fill();
}

/** The head is a square with only its two bottom corners rounded (radius `0 0 r r` in the design
 * doc's CSS shorthand) -- built from lines/arcs rather than a plain fillRect so the shape matches. */
function drawHeadShape(ctx: CanvasLike, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - r);
  ctx.lineTo(x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.lineTo(x, y + h - r);
  ctx.lineTo(x, y);
}
