// OffscreenCanvas-touching packing/decode/crop, mirroring RealFrameDecoder.ts's role as this
// module's DOM-boundary file -- not Node-testable (no OffscreenCanvas in Node), exercised via
// harness.ts. The layout math it depends on (atlas-layout.ts) is pure and IS tested there.
//
// The rule this file exists to enforce (spike C's highest-leverage atlas finding):
// createImageBitmap(blob, sx, sy, sw, sh) decodes the ENTIRE atlas internally on EVERY call --
// 23.81ms regardless of crop size, ~950ms for a 40-tile filmstrip repaint done that way. Decode
// each atlas blob ONCE per session (decodeAtlas), then crop every subsequent tile from the
// resulting in-memory ImageBitmap via canvas drawImage (cropTile) -- cheap, because the source is
// already raster data, not compressed bytes needing a fresh decode.

import { ATLAS_GRID, tileRect } from './atlas-layout';

export const ATLAS_WEBP_QUALITY = 0.6;

export interface PackedAtlas {
  readonly blob: Blob;
  readonly tileCount: number;
}

/** Packs up to 100 bitmaps into one WebP atlas, bitmaps[i] -> slot i (row-major, see atlas-layout.ts). Does not close the input bitmaps -- their lifetime is the caller's call, packing is just a read. */
export async function packAtlas(bitmaps: readonly ImageBitmap[], tileWidth: number, tileHeight: number): Promise<PackedAtlas> {
  const capacity = ATLAS_GRID * ATLAS_GRID;
  if (bitmaps.length === 0) throw new Error('packAtlas: at least one bitmap is required');
  if (bitmaps.length > capacity) throw new Error(`packAtlas: at most ${String(capacity)} bitmaps per atlas, got ${String(bitmaps.length)}`);

  const canvas = new OffscreenCanvas(tileWidth * ATLAS_GRID, tileHeight * ATLAS_GRID);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('packAtlas: failed to acquire a 2d context');

  bitmaps.forEach((bitmap, slot) => {
    const rect = tileRect(slot, tileWidth, tileHeight);
    ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height);
  });

  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: ATLAS_WEBP_QUALITY });
  return { blob, tileCount: bitmaps.length };
}

/** Decode-once entry point -- call exactly once per atlas per session, then serve every tile from cropTile() against the result. */
export function decodeAtlas(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob);
}

/** Crops one tile from an already-decoded atlas bitmap. Caller owns the returned bitmap's lifetime (close() it on eviction, same rule as any other DecodedBitmap). */
export function cropTile(atlasBitmap: ImageBitmap, slot: number, tileWidth: number, tileHeight: number): ImageBitmap {
  const rect = tileRect(slot, tileWidth, tileHeight);
  const canvas = new OffscreenCanvas(tileWidth, tileHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('cropTile: failed to acquire a 2d context');
  ctx.drawImage(atlasBitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, tileWidth, tileHeight);
  return canvas.transferToImageBitmap();
}
