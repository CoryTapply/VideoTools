import { describe, expect, it } from 'vitest';
import { nextShuttleRate } from './shuttle.ts';

describe('nextShuttleRate', () => {
  it('starts at the base rate from a stop', () => {
    expect(nextShuttleRate(0, 1)).toBe(1);
    expect(nextShuttleRate(0, -1)).toBe(-1);
  });

  it('doubles when repeating the same direction', () => {
    expect(nextShuttleRate(1, 1)).toBe(2);
    expect(nextShuttleRate(2, 1)).toBe(4);
    expect(nextShuttleRate(4, 1)).toBe(8);
  });

  it('caps at +/-8x', () => {
    expect(nextShuttleRate(8, 1)).toBe(8);
    expect(nextShuttleRate(-8, -1)).toBe(-8);
  });

  it('resets to the base rate on a direction reversal, not a continued double', () => {
    expect(nextShuttleRate(4, -1)).toBe(-1);
    expect(nextShuttleRate(-4, 1)).toBe(1);
  });
});
