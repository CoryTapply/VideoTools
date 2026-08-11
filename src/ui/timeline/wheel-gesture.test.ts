import { describe, expect, it } from 'vitest';
import { isZoomGesture, wheelPanDeltaPx, wheelZoomFactor } from './wheel-gesture.ts';

describe('wheelZoomFactor', () => {
  it('is design/README.md\'s literal formula', () => {
    expect(wheelZoomFactor(100)).toBeCloseTo(Math.pow(1.0025, 100), 10);
    expect(wheelZoomFactor(-100)).toBeCloseTo(Math.pow(1.0025, -100), 10);
  });

  it('is 1 (no-op) for a zero delta', () => {
    expect(wheelZoomFactor(0)).toBe(1);
  });

  it('is >1 (zoom out / grow viewSpan) for positive deltaY, <1 for negative', () => {
    expect(wheelZoomFactor(100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(-100)).toBeLessThan(1);
  });
});

describe('wheelPanDeltaPx', () => {
  it('picks whichever axis has the larger magnitude', () => {
    expect(wheelPanDeltaPx(10, 3)).toBe(10);
    expect(wheelPanDeltaPx(3, 10)).toBe(10);
    expect(wheelPanDeltaPx(-10, 3)).toBe(-10);
  });

  it('ties resolve to deltaX (>=)', () => {
    expect(wheelPanDeltaPx(5, 5)).toBe(5);
  });
});

describe('isZoomGesture', () => {
  it('is true when ctrl or meta is held', () => {
    expect(isZoomGesture({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(isZoomGesture({ ctrlKey: false, metaKey: true })).toBe(true);
  });

  it('is false for a plain wheel event', () => {
    expect(isZoomGesture({ ctrlKey: false, metaKey: false })).toBe(false);
  });
});
