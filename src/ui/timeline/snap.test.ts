import { describe, expect, it } from 'vitest';
import { nearestKeyframe, screenPxToTicks, snapTo } from './snap.ts';

const keyframeTimes = Float64Array.from([0, 1000, 2000, 3000, 4000]);

describe('nearestKeyframe', () => {
  it('finds the closest keyframe', () => {
    expect(nearestKeyframe(keyframeTimes, 950)).toBe(1000);
    expect(nearestKeyframe(keyframeTimes, 1499)).toBe(1000);
    expect(nearestKeyframe(keyframeTimes, 1500)).toBe(1000); // ties resolve to the lower index
  });

  it('returns null for an empty array', () => {
    expect(nearestKeyframe(new Float64Array(0), 500)).toBeNull();
  });
});

describe('screenPxToTicks', () => {
  it('is constant in screen pixels, not time -- scales with zoom', () => {
    expect(screenPxToTicks(8, 10_000, 1000)).toBe(80); // 8px at 10 ticks/px
    expect(screenPxToTicks(8, 1_000, 1000)).toBe(8); // 8px at 1 tick/px -- same px, less time
  });

  it('is 0 for a zero-width viewport', () => {
    expect(screenPxToTicks(8, 10_000, 0)).toBe(0);
  });
});

describe('snapTo', () => {
  const context = { keyframeTimes, playhead: 500, duration: 4000, oppositeHandle: 2500 };

  it('snaps to the nearest keyframe within tolerance', () => {
    expect(snapTo(1010, context, 50)).toBe(1000);
  });

  it('snaps to the playhead when closer than any keyframe', () => {
    expect(snapTo(510, context, 50)).toBe(500);
  });

  it('snaps to 0 or duration at the file boundaries', () => {
    expect(snapTo(10, context, 50)).toBe(0);
    expect(snapTo(3990, context, 50)).toBe(4000);
  });

  it('snaps to the opposite handle when within tolerance', () => {
    expect(snapTo(2480, context, 50)).toBe(2500);
  });

  it('returns t unchanged when nothing is within tolerance', () => {
    expect(snapTo(1500, context, 50)).toBe(1500);
  });

  it('ignores the opposite handle when null (e.g. a general scrub, not a handle drag)', () => {
    const noOpposite = { ...context, oppositeHandle: null };
    expect(snapTo(2480, noOpposite, 50)).toBe(2480);
  });

  it('picks the closest candidate, not just the first in tolerance', () => {
    // 1990 is 10 away from keyframe 2000 and within tolerance of nothing else -- must pick 2000,
    // not fall through to a farther candidate.
    expect(snapTo(1990, context, 50)).toBe(2000);
  });
});
