import { describe, expect, it } from 'vitest';
import { binarySearchNearest } from './binary-search';

describe('binarySearchNearest', () => {
  it('returns -1 for an empty array', () => {
    expect(binarySearchNearest(new Float64Array(0), 5)).toBe(-1);
  });

  it('returns the only index for a single-element array', () => {
    expect(binarySearchNearest(Float64Array.from([42]), -100)).toBe(0);
    expect(binarySearchNearest(Float64Array.from([42]), 100)).toBe(0);
  });

  it('clamps a target before the first element to index 0', () => {
    expect(binarySearchNearest(Float64Array.from([10, 20, 30]), -5)).toBe(0);
  });

  it('clamps a target after the last element to the last index', () => {
    expect(binarySearchNearest(Float64Array.from([10, 20, 30]), 500)).toBe(2);
  });

  it('finds an exact match', () => {
    expect(binarySearchNearest(Float64Array.from([0, 4166, 8332, 12498]), 8332)).toBe(2);
  });

  it('picks the closer of two straddling neighbors', () => {
    const times = Float64Array.from([0, 4166, 8332, 12498]);
    expect(binarySearchNearest(times, 4200)).toBe(1); // closer to 4166 than 8332
    expect(binarySearchNearest(times, 6300)).toBe(2); // closer to 8332 than 4166
  });

  it('resolves an exact tie to the lower index', () => {
    expect(binarySearchNearest(Float64Array.from([0, 100]), 50)).toBe(0);
  });

  it('matches a linear scan across a large synthetic keyframe-spaced array (27GB-fixture scale)', () => {
    const times = Float64Array.from({ length: 1015 }, (_, i) => i * 4166.67);
    for (const target of [0, 1000, 4166.67, 2_100_000, 4_223_000.5, 4_226_000]) {
      let expected = 0;
      let bestDist = Infinity;
      for (let i = 0; i < times.length; i += 1) {
        const dist = Math.abs(times[i] - target);
        if (dist < bestDist) {
          bestDist = dist;
          expected = i;
        }
      }
      expect(binarySearchNearest(times, target)).toBe(expected);
    }
  });
});
