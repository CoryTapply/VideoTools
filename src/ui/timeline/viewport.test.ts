import { describe, expect, it } from 'vitest';
import { clampViewSpan, fitToDuration, MAX_FRAME_PX, panByPixels, timeToX, xToTime, zoomAtCursor, zoomAtPlayhead } from './viewport.ts';

describe('timeToX / xToTime', () => {
  it('round-trips through the viewport transform', () => {
    const viewStart = 1000;
    const viewSpan = 5000;
    const widthPx = 800;
    for (const t of [1000, 2500, 6000]) {
      const x = timeToX(t, viewStart, viewSpan, widthPx);
      expect(xToTime(x, viewStart, viewSpan, widthPx)).toBeCloseTo(t, 6);
    }
  });

  it('maps viewStart to x=0 and viewStart+viewSpan to x=widthPx', () => {
    expect(timeToX(1000, 1000, 5000, 800)).toBe(0);
    expect(timeToX(6000, 1000, 5000, 800)).toBe(800);
  });

  it('degenerates safely when viewSpan/widthPx is zero rather than dividing by zero', () => {
    expect(timeToX(100, 0, 0, 800)).toBe(0);
    expect(xToTime(100, 0, 5000, 0)).toBe(0);
  });
});

describe('clampViewSpan', () => {
  const timescale = 90000;
  const fps = 60;
  const ticksPerFrame = timescale / fps;
  const durationTicks = 1000 * timescale;

  it('never lets a requested span exceed the full duration', () => {
    expect(clampViewSpan(durationTicks * 10, 800, ticksPerFrame, durationTicks)).toBe(durationTicks);
  });

  it('never lets a single frame exceed MAX_FRAME_PX on screen', () => {
    const widthPx = 800;
    const span = clampViewSpan(1, widthPx, ticksPerFrame, durationTicks);
    const framePx = (ticksPerFrame / span) * widthPx;
    expect(framePx).toBeLessThanOrEqual(MAX_FRAME_PX + 1e-9);
  });

  it('passes an in-range span through unchanged', () => {
    const span = 10 * timescale;
    expect(clampViewSpan(span, 800, ticksPerFrame, durationTicks)).toBe(span);
  });

  it('skips the zoom-in clamp when ticksPerFrame is 0 (VFR/unknown)', () => {
    expect(clampViewSpan(1, 800, 0, durationTicks)).toBe(1);
  });
});

describe('panByPixels', () => {
  const durationTicks = 100_000;

  it('moves viewStart proportionally to the pixel delta', () => {
    const viewport = { viewStart: 10_000, viewSpan: 20_000, widthPx: 1000 };
    // 100px of a 1000px-wide, 20_000-tick viewport is 2_000 ticks.
    expect(panByPixels(viewport, 100, durationTicks)).toBe(12_000);
    expect(panByPixels(viewport, -100, durationTicks)).toBe(8_000);
  });

  it('clamps to [0, duration - viewSpan]', () => {
    const viewport = { viewStart: 0, viewSpan: 20_000, widthPx: 1000 };
    expect(panByPixels(viewport, -100_000, durationTicks)).toBe(0);
    expect(panByPixels({ ...viewport, viewStart: 80_000 }, 100_000, durationTicks)).toBe(80_000);
  });
});

describe('zoomAtCursor', () => {
  const timescale = 90000;
  const ticksPerFrame = timescale / 60;
  const durationTicks = 1000 * timescale;

  it('keeps the time under the cursor fixed on screen', () => {
    const viewport = { viewStart: 10 * timescale, viewSpan: 100 * timescale, widthPx: 1000 };
    const cursorX = 300;
    const anchorTime = xToTime(cursorX, viewport.viewStart, viewport.viewSpan, viewport.widthPx);
    const zoomed = zoomAtCursor(viewport, cursorX, 0.5, ticksPerFrame, durationTicks);
    const xAfter = timeToX(anchorTime, zoomed.viewStart, zoomed.viewSpan, viewport.widthPx);
    expect(xAfter).toBeCloseTo(cursorX, 6);
  });

  it('zooming in shrinks viewSpan, zooming out grows it', () => {
    const viewport = { viewStart: 0, viewSpan: 100 * timescale, widthPx: 1000 };
    expect(zoomAtCursor(viewport, 500, 0.5, ticksPerFrame, durationTicks).viewSpan).toBeLessThan(viewport.viewSpan);
    expect(zoomAtCursor(viewport, 500, 2, ticksPerFrame, durationTicks).viewSpan).toBeGreaterThan(viewport.viewSpan);
  });
});

describe('zoomAtPlayhead', () => {
  it('is equivalent to zoomAtCursor anchored at the playhead\'s current x', () => {
    const timescale = 90000;
    const ticksPerFrame = timescale / 60;
    const durationTicks = 1000 * timescale;
    const viewport = { viewStart: 10 * timescale, viewSpan: 100 * timescale, widthPx: 1000 };
    const playhead = 40 * timescale;
    const viaPlayhead = zoomAtPlayhead(viewport, playhead, 0.5, ticksPerFrame, durationTicks);
    const cursorX = timeToX(playhead, viewport.viewStart, viewport.viewSpan, viewport.widthPx);
    const viaCursor = zoomAtCursor(viewport, cursorX, 0.5, ticksPerFrame, durationTicks);
    expect(viaPlayhead).toEqual(viaCursor);
  });
});

describe('fitToDuration', () => {
  it('spans the whole file starting at 0', () => {
    expect(fitToDuration(12345)).toEqual({ viewStart: 0, viewSpan: 12345 });
  });
});
