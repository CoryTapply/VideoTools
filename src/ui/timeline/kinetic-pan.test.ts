import { describe, expect, it } from 'vitest';
import { decayVelocity, isCoastingDone, updateVelocity } from './kinetic-pan.ts';

describe('updateVelocity', () => {
  it('moves toward the new instantaneous sample, not fully onto it', () => {
    const next = updateVelocity(0, 100, 10); // instantaneous = 10 ticks/ms
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(10);
  });

  it('converges toward a sustained constant rate over repeated samples', () => {
    let v = 0;
    for (let i = 0; i < 50; i += 1) v = updateVelocity(v, 100, 10); // always 10 ticks/ms
    expect(v).toBeCloseTo(10, 1);
  });

  it('ignores a non-positive time delta rather than dividing by zero', () => {
    expect(updateVelocity(5, 100, 0)).toBe(5);
    expect(updateVelocity(5, 100, -10)).toBe(5);
  });
});

describe('decayVelocity', () => {
  it('shrinks velocity toward zero, never flips sign', () => {
    const decayed = decayVelocity(10, 16.7);
    expect(decayed).toBeGreaterThan(0);
    expect(decayed).toBeLessThan(10);
  });

  it('decays negative velocity toward zero from below, not past it', () => {
    const decayed = decayVelocity(-10, 16.7);
    expect(decayed).toBeLessThan(0);
    expect(decayed).toBeGreaterThan(-10);
  });

  it('decays more over a longer frame', () => {
    const short = decayVelocity(10, 16.7);
    const long = decayVelocity(10, 100);
    expect(long).toBeLessThan(short);
  });

  it('is a no-op for a non-positive frame duration', () => {
    expect(decayVelocity(10, 0)).toBe(10);
  });
});

describe('isCoastingDone', () => {
  it('is true once velocity magnitude drops below the threshold', () => {
    expect(isCoastingDone(0.0001, 0.0005)).toBe(true);
    expect(isCoastingDone(-0.0001, 0.0005)).toBe(true);
  });

  it('is false above the threshold, in either direction', () => {
    expect(isCoastingDone(0.001, 0.0005)).toBe(false);
    expect(isCoastingDone(-0.001, 0.0005)).toBe(false);
  });
});
