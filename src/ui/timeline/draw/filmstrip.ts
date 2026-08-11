// Filmstrip row draw: background, fixed-width cropped tiles, seams, empty-tile placeholders.
// design/README.md's "3. Filmstrip" -- tiles crop rather than letterbox so many frame boundaries
// stay visible across the row, which is the row's whole point as the primary scrub source.

import { color } from '../../tokens.ts';
import type { DecodedBitmap } from '../../../media/frames/FrameDecoder.ts';
import type { CanvasLike } from '../canvas-like.ts';

/** Fixed on-screen tile width -- design/README.md's Filmstrip section. */
export const FILMSTRIP_TILE_WIDTH_PX = 120;

export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** "Cover" crop: the largest centered rect of the source's aspect ratio that fully covers a
 * `dstW` x `dstH` box, cropping whichever axis overflows. Pure geometry, no canvas dependency. */
export function computeCoverCrop(srcW: number, srcH: number, dstW: number, dstH: number): CropRect {
  if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) return { sx: 0, sy: 0, sw: srcW, sh: srcH };
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  if (srcAspect > dstAspect) {
    // Source is wider than the box -- crop its sides.
    const sw = srcH * dstAspect;
    return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH };
  }
  // Source is taller than (or equal to) the box -- crop top/bottom.
  const sh = srcW / dstAspect;
  return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh };
}

export function drawFilmstrip(ctx: CanvasLike, widthPx: number, top: number, height: number, tiles: readonly (DecodedBitmap | null)[], tileWidthPx: number = FILMSTRIP_TILE_WIDTH_PX): void {
  ctx.fillStyle = color.bgTimeline;
  ctx.fillRect(0, top, widthPx, height);

  const tileCount = Math.ceil(widthPx / tileWidthPx) + 1;
  for (let i = 0; i < tileCount; i += 1) {
    const x = i * tileWidthPx;
    const bitmap = tiles[i] ?? null;
    if (bitmap === null) {
      ctx.fillStyle = color.bgTileEmpty;
      ctx.fillRect(x, top, tileWidthPx, height);
    } else {
      const crop = computeCoverCrop(bitmap.width, bitmap.height, tileWidthPx, height);
      ctx.drawImage(bitmap, crop.sx, crop.sy, crop.sw, crop.sh, x, top, tileWidthPx, height);
    }

    if (i > 0) {
      ctx.strokeStyle = color.filmstripSeamLight;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, top);
      ctx.lineTo(x + 0.5, top + height);
      ctx.stroke();
      ctx.strokeStyle = color.filmstripSeamDark;
      ctx.beginPath();
      ctx.moveTo(x - 0.5, top);
      ctx.lineTo(x - 0.5, top + height);
      ctx.stroke();
    }
  }
}
