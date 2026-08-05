import { describe, expect, it } from 'vitest';
import { localTicksToPresentationSeconds, secondsToTicks, ticksToSeconds } from './time';

describe('ticksToSeconds / secondsToTicks', () => {
  it('round-trips through a timescale', () => {
    expect(ticksToSeconds(48000, 48000)).toBe(1);
    expect(secondsToTicks(1, 48000)).toBe(48000);
  });
});

describe('localTicksToPresentationSeconds', () => {
  it('subtracts the edit offset before converting to seconds', () => {
    // A 1024-tick priming delay at 48000Hz timescale (typical AAC encoder delay).
    expect(localTicksToPresentationSeconds(1024, 48000, 1024)).toBe(0);
    expect(localTicksToPresentationSeconds(2048, 48000, 1024)).toBeCloseTo(1024 / 48000, 10);
  });

  it('is a no-op when there is no edit list (editOffsetTicks 0)', () => {
    expect(localTicksToPresentationSeconds(500, 1000, 0)).toBe(0.5);
  });
});
