import { describe, expect, it } from 'vitest';
import { clampTimelineHeight, nextTimelineHeight, SPLITTER_MIN_HEIGHT_PX } from './splitter.ts';

describe('clampTimelineHeight', () => {
  it('passes through values within range', () => {
    expect(clampTimelineHeight(300, 1000)).toBe(300);
  });

  it('clamps to the 150px floor', () => {
    expect(clampTimelineHeight(50, 1000)).toBe(SPLITTER_MIN_HEIGHT_PX);
  });

  it('clamps to 55vh', () => {
    expect(clampTimelineHeight(9999, 1000)).toBe(550);
  });
});

describe('nextTimelineHeight', () => {
  it('shrinks when the pointer moves down', () => {
    expect(nextTimelineHeight(300, 40, 1000)).toBe(260);
  });

  it('grows when the pointer moves up', () => {
    expect(nextTimelineHeight(300, -40, 1000)).toBe(340);
  });

  it('clamps the result', () => {
    expect(nextTimelineHeight(200, 1000, 1000)).toBe(SPLITTER_MIN_HEIGHT_PX);
  });
});
