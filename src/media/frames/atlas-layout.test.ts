import { describe, expect, it } from 'vitest';
import { ATLAS_CAPACITY, ATLAS_GRID, atlasSlotFor, tileRect } from './atlas-layout';

describe('atlasSlotFor', () => {
  it('fills atlas 0 for the first 100 indices', () => {
    expect(atlasSlotFor(0)).toEqual({ atlasId: 0, slot: 0 });
    expect(atlasSlotFor(99)).toEqual({ atlasId: 0, slot: 99 });
  });

  it('rolls over to the next atlas at the capacity boundary', () => {
    expect(atlasSlotFor(100)).toEqual({ atlasId: 1, slot: 0 });
    expect(atlasSlotFor(101)).toEqual({ atlasId: 1, slot: 1 });
    expect(atlasSlotFor(199)).toEqual({ atlasId: 1, slot: 99 });
    expect(atlasSlotFor(200)).toEqual({ atlasId: 2, slot: 0 });
  });

  it('covers the full 27GB-fixture coarse tier (1,015 keyframes) across 11 atlases', () => {
    const last = atlasSlotFor(1014);
    expect(last.atlasId).toBe(10);
    expect(last.slot).toBe(14);
  });

  it('rejects negative or non-integer indices', () => {
    expect(() => atlasSlotFor(-1)).toThrow(/non-negative integer/);
    expect(() => atlasSlotFor(1.5)).toThrow(/non-negative integer/);
  });
});

describe('tileRect', () => {
  it('places slot 0 at the origin', () => {
    expect(tileRect(0, 160, 90)).toEqual({ x: 0, y: 0, width: 160, height: 90 });
  });

  it('fills a row before wrapping to the next', () => {
    expect(tileRect(ATLAS_GRID - 1, 160, 90)).toEqual({ x: 9 * 160, y: 0, width: 160, height: 90 });
    expect(tileRect(ATLAS_GRID, 160, 90)).toEqual({ x: 0, y: 90, width: 160, height: 90 });
  });

  it('places the last slot at the bottom-right corner', () => {
    expect(tileRect(ATLAS_CAPACITY - 1, 160, 90)).toEqual({ x: 9 * 160, y: 9 * 90, width: 160, height: 90 });
  });

  it('rejects a slot outside [0, ATLAS_CAPACITY)', () => {
    expect(() => tileRect(-1, 160, 90)).toThrow(/must be in/);
    expect(() => tileRect(ATLAS_CAPACITY, 160, 90)).toThrow(/must be in/);
  });
});
