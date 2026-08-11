// The drag-scrub preview overlay -- design/README.md: "the preview shows the nearest cached
// filmstrip tile" while dragging, drawn with the same `object-fit: contain` letterbox behavior as
// the real <video> beneath it (PreviewSurface.module.css's `.video`), not the filmstrip's crop.

import type { CanvasLike } from '../canvas-like.ts';
import type { DecodedBitmap } from '../../../media/frames/FrameDecoder.ts';

export interface ContainRect {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** "Contain" fit: the largest centered rect of the source's aspect ratio that fits entirely
 * inside a `dstW` x `dstH` box, letterboxing whichever axis has slack. */
export function computeContainFit(srcW: number, srcH: number, dstW: number, dstH: number): ContainRect {
  if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) return { dx: 0, dy: 0, dw: dstW, dh: dstH };
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  if (srcAspect > dstAspect) {
    const dw = dstW;
    const dh = dstW / srcAspect;
    return { dx: 0, dy: (dstH - dh) / 2, dw, dh };
  }
  const dh = dstH;
  const dw = dstH * srcAspect;
  return { dx: (dstW - dw) / 2, dy: 0, dw, dh };
}

/** Clears the overlay (letting the real <video> show through) when `bitmap` is null -- the
 * caller is responsible for only passing a bitmap while a drag-scrub is active. */
export function drawScrubPreview(ctx: CanvasLike, widthPx: number, heightPx: number, bitmap: DecodedBitmap | null): void {
  ctx.clearRect(0, 0, widthPx, heightPx);
  if (bitmap === null) return;
  const fit = computeContainFit(bitmap.width, bitmap.height, widthPx, heightPx);
  ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, fit.dx, fit.dy, fit.dw, fit.dh);
}
