// Pure slot-assignment math for atlas packing (Part 5): 100 thumbnails per atlas, 10x10 grid.
// Kept separate from atlas-pack.ts (which needs a real OffscreenCanvas) so this is fully
// Node-testable -- every tier/LRU consumer that needs to know "which atlas and slot does entry N
// live in" goes through this, never hand-computed inline.

export const ATLAS_GRID = 10;
export const ATLAS_CAPACITY = ATLAS_GRID * ATLAS_GRID; // 100

export interface AtlasSlot {
  readonly atlasId: number;
  /** 0..ATLAS_CAPACITY-1, this atlas's own local slot index. */
  readonly slot: number;
}

/** Maps a tier-local sequential index (0-based position among all of one tier's entries, in the order they were built) to which atlas it lives in and which slot within it. */
export function atlasSlotFor(tierIndex: number): AtlasSlot {
  if (!Number.isInteger(tierIndex) || tierIndex < 0) throw new Error(`atlasSlotFor: tierIndex must be a non-negative integer, got ${String(tierIndex)}`);
  return { atlasId: Math.floor(tierIndex / ATLAS_CAPACITY), slot: tierIndex % ATLAS_CAPACITY };
}

export interface TileRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Pixel rect of `slot` within one atlas image, row-major (slot 0 top-left, slot 9 top-right, slot 10 starts row 2). */
export function tileRect(slot: number, tileWidth: number, tileHeight: number): TileRect {
  if (!Number.isInteger(slot) || slot < 0 || slot >= ATLAS_CAPACITY) throw new Error(`tileRect: slot must be in [0, ${String(ATLAS_CAPACITY)}), got ${String(slot)}`);
  const col = slot % ATLAS_GRID;
  const row = Math.floor(slot / ATLAS_GRID);
  return { x: col * tileWidth, y: row * tileHeight, width: tileWidth, height: tileHeight };
}
