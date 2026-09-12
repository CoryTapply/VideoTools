import { describe, expect, it } from 'vitest';
import { centerViewStart, playheadPct, trimBandPct, zoomCapsulePct } from './minimap.ts';

describe('trimBandPct', () => {
  const durationSeconds = 3600;

  it('matches the raw percentage for a normal trim range', () => {
    expect(trimBandPct(900, 2700, durationSeconds)).toEqual({ leftPct: 25, widthPct: 50 });
  });

  it('floors the width at 0.4% for a short trim on a long file', () => {
    // 2 minutes of a 30-hour file is well under 0.4%.
    const longDuration = 30 * 3600;
    const { widthPct } = trimBandPct(0, 120, longDuration);
    expect(widthPct).toBe(0.4);
  });

  it('returns zero when duration is not yet known', () => {
    expect(trimBandPct(10, 20, 0)).toEqual({ leftPct: 0, widthPct: 0 });
  });
});

describe('zoomCapsulePct', () => {
  const durationTicks = 90_000 * 3600;

  it('matches the raw percentage for a normal zoom window', () => {
    expect(zoomCapsulePct(durationTicks * 0.25, durationTicks * 0.5, durationTicks)).toEqual({
      leftPct: 25,
      widthPct: 50,
    });
  });

  it('floors the width at 0.6% for a narrow zoom window on a long file', () => {
    const { widthPct } = zoomCapsulePct(0, durationTicks * 0.001, durationTicks);
    expect(widthPct).toBe(0.6);
  });

  it('returns zero when duration is not yet known', () => {
    expect(zoomCapsulePct(0, 100, 0)).toEqual({ leftPct: 0, widthPct: 0 });
  });
});

describe('playheadPct', () => {
  const durationTicks = 100_000;

  it('maps 0 to 0% and the full duration to 100%', () => {
    expect(playheadPct(0, durationTicks)).toBe(0);
    expect(playheadPct(durationTicks, durationTicks)).toBe(100);
  });

  it('returns zero when duration is not yet known', () => {
    expect(playheadPct(500, 0)).toBe(0);
  });
});

describe('centerViewStart', () => {
  const durationTicks = 100_000;

  it('centers the view on the clicked point mid-file', () => {
    expect(centerViewStart(50_000, 20_000, durationTicks)).toBe(40_000);
  });

  it('clamps to 0 when the click is near the start', () => {
    expect(centerViewStart(1_000, 20_000, durationTicks)).toBe(0);
  });

  it('clamps to duration - viewSpan when the click is near the end', () => {
    expect(centerViewStart(99_000, 20_000, durationTicks)).toBe(80_000);
  });

  it('clamps to 0 when the viewSpan already covers the whole file', () => {
    expect(centerViewStart(50_000, 150_000, durationTicks)).toBe(0);
  });
});
