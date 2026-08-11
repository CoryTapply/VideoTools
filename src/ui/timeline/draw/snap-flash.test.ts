import { describe, expect, it } from 'vitest';
import { motion } from '../../tokens.ts';
import { snapFlashOpacity } from './snap-flash.ts';

describe('snapFlashOpacity', () => {
  it('starts at full opacity', () => {
    expect(snapFlashOpacity(1000, 1000)).toBe(1);
  });

  it('fades linearly to 0 over motion.snapFlashMs', () => {
    const half = motion.snapFlashMs / 2;
    expect(snapFlashOpacity(1000, 1000 + half)).toBeCloseTo(0.5, 6);
  });

  it('is null once fully expired', () => {
    expect(snapFlashOpacity(1000, 1000 + motion.snapFlashMs)).toBeNull();
    expect(snapFlashOpacity(1000, 1000 + motion.snapFlashMs + 100)).toBeNull();
  });

  it('is null for a not-yet-started flash (clock skew guard)', () => {
    expect(snapFlashOpacity(1000, 999)).toBeNull();
  });
});
