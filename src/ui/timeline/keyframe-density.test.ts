import { describe, expect, it } from 'vitest';
import { averageKeyframeIntervalTicks, keyframeDensity, visibleKeyframeTicks } from './keyframe-density.ts';

describe('keyframeDensity', () => {
  it('draws full-height ticks at >= 16px spacing', () => {
    expect(keyframeDensity(16).mode).toBe('full');
    expect(keyframeDensity(50).mode).toBe('full');
  });

  it('draws short ticks between 3px and 16px', () => {
    expect(keyframeDensity(15.999).mode).toBe('short');
    expect(keyframeDensity(3).mode).toBe('short');
  });

  it('collapses to a striped texture below 3px, opacity clamped to [0.4, 0.85]', () => {
    expect(keyframeDensity(2.999).mode).toBe('stripe');
    expect(keyframeDensity(0).stripeOpacity).toBe(0.4);
    expect(keyframeDensity(1).stripeOpacity).toBeCloseTo(0.85, 6); // 1*2=2, clamped down to 0.85
    expect(keyframeDensity(0.2).stripeOpacity).toBeCloseTo(0.4, 6); // 0.2*2=0.4, exactly the floor
  });
});

describe('averageKeyframeIntervalTicks', () => {
  it('is the mean spacing across the whole array', () => {
    const times = Float64Array.from([0, 10, 20, 30]);
    expect(averageKeyframeIntervalTicks(times)).toBe(10);
  });

  it('is 0 for fewer than two keyframes', () => {
    expect(averageKeyframeIntervalTicks(new Float64Array(0))).toBe(0);
    expect(averageKeyframeIntervalTicks(Float64Array.from([5]))).toBe(0);
  });
});

describe('visibleKeyframeTicks', () => {
  const times = Float64Array.from([0, 100, 200, 300, 400, 500]);

  it('returns only keyframes within [viewStart, viewStart+viewSpan]', () => {
    const viewport = { viewStart: 150, viewSpan: 200, widthPx: 1000 };
    const ticks = visibleKeyframeTicks(times, viewport);
    expect(ticks.map((t) => t.time)).toEqual([200, 300]);
  });

  it('positions x consistently with the viewport transform', () => {
    const viewport = { viewStart: 0, viewSpan: 500, widthPx: 1000 };
    const ticks = visibleKeyframeTicks(times, viewport);
    for (const tick of ticks) {
      expect(tick.x).toBeCloseTo((tick.time / 500) * 1000, 6);
    }
  });

  it('returns nothing for an empty array or a degenerate viewport', () => {
    expect(visibleKeyframeTicks(new Float64Array(0), { viewStart: 0, viewSpan: 500, widthPx: 1000 })).toEqual([]);
    expect(visibleKeyframeTicks(times, { viewStart: 0, viewSpan: 0, widthPx: 1000 })).toEqual([]);
  });

  it('includes boundary keyframes exactly at viewStart/viewEnd', () => {
    const viewport = { viewStart: 100, viewSpan: 300, widthPx: 1000 };
    const ticks = visibleKeyframeTicks(times, viewport);
    expect(ticks.map((t) => t.time)).toEqual([100, 200, 300, 400]);
  });
});
