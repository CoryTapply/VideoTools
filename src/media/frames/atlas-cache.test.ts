// Only the pure key-derivation logic is testable in Node -- readAtlas/writeAtlas are OPFS calls
// with no Node equivalent, exercised via harness.ts against a real browser instead (same split
// as src/media/index/opfs-cache.test.ts, which only covers serializeIndex/deserializeIndex).
import { describe, expect, it } from 'vitest';
import { atlasCacheKey, ATLAS_SCHEMA_VERSION, type AtlasCacheKeyInput } from './atlas-cache';
import type { FileFingerprint } from '../index/fingerprint';

const fingerprint: FileFingerprint = { size: 27_000_000_000, lastModified: 1_700_000_000_000, headHash: 0xdeadbeef, tailHash: 0xcafef00d };

function input(overrides: Partial<AtlasCacheKeyInput> = {}): AtlasCacheKeyInput {
  return { fingerprint, tier: 'coarse', atlasId: 0, tileWidth: 160, tileHeight: 90, ...overrides };
}

describe('atlasCacheKey', () => {
  it('is stable for identical inputs', () => {
    expect(atlasCacheKey(input())).toBe(atlasCacheKey(input()));
  });

  it('differs when the fingerprint differs (a different file)', () => {
    const other = { ...fingerprint, size: fingerprint.size + 1 };
    expect(atlasCacheKey(input())).not.toBe(atlasCacheKey(input({ fingerprint: other })));
  });

  it('differs by tier', () => {
    expect(atlasCacheKey(input({ tier: 'coarse' }))).not.toBe(atlasCacheKey(input({ tier: 'dense' })));
  });

  it('differs by atlasId', () => {
    expect(atlasCacheKey(input({ atlasId: 0 }))).not.toBe(atlasCacheKey(input({ atlasId: 1 })));
  });

  it('differs by tile dimensions, so a packing/size change invalidates old atlases by simply missing', () => {
    expect(atlasCacheKey(input({ tileWidth: 160, tileHeight: 90 }))).not.toBe(atlasCacheKey(input({ tileWidth: 320, tileHeight: 180 })));
  });

  it('embeds the current ATLAS_SCHEMA_VERSION', () => {
    expect(atlasCacheKey(input())).toContain(`v${String(ATLAS_SCHEMA_VERSION)}`);
  });
});
