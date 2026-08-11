import { describe, expect, it } from 'vitest';
import { chooseTickStep, generateRulerTicks } from './ruler-ticks.ts';

const TIMESCALE = 90000;
const FPS = 60;
const TICKS_PER_FRAME = TIMESCALE / FPS;

describe('chooseTickStep', () => {
  it('picks the finest candidate (1 frame) at extreme zoom-in', () => {
    // 1 frame must be >= 90px: viewSpan of just a few frames across a wide canvas.
    const viewport = { viewStart: 0, viewSpan: 2 * TICKS_PER_FRAME, widthPx: 2000 };
    expect(chooseTickStep(viewport, TIMESCALE, TICKS_PER_FRAME)).toBe(TICKS_PER_FRAME);
  });

  it('picks the smallest candidate that clears MIN_MAJOR_TICK_PX, not a coarser one', () => {
    // 10px/sec: 0.5s->5px, 1s->10px, 2s->20px, 5s->50px, 10s->100px (first to clear 90px).
    const viewport = { viewStart: 0, viewSpan: 90 * TIMESCALE, widthPx: 900 };
    expect(chooseTickStep(viewport, TIMESCALE, TICKS_PER_FRAME)).toBe(10 * TIMESCALE);
  });

  it('falls back to the coarsest candidate (1h) at extreme zoom-out', () => {
    const viewport = { viewStart: 0, viewSpan: 100_000 * TIMESCALE, widthPx: 200 };
    expect(chooseTickStep(viewport, TIMESCALE, TICKS_PER_FRAME)).toBe(3600 * TIMESCALE);
  });

  it('returns a 1-second fallback for a degenerate (zero) viewport', () => {
    expect(chooseTickStep({ viewStart: 0, viewSpan: 0, widthPx: 800 }, TIMESCALE, TICKS_PER_FRAME)).toBe(TIMESCALE);
  });
});

describe('generateRulerTicks', () => {
  it('produces only major ticks with labels when minor ticks would be illegibly close', () => {
    // Very zoomed out: minor (step/5) ticks would be far under MIN_MINOR_TICK_PX apart.
    const viewport = { viewStart: 0, viewSpan: 100_000 * TIMESCALE, widthPx: 800 };
    const ticks = generateRulerTicks(viewport, TIMESCALE, TICKS_PER_FRAME, FPS);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every((t) => t.major)).toBe(true);
    expect(ticks.every((t) => t.label !== null)).toBe(true);
  });

  it('includes unlabeled minor ticks when they are legible', () => {
    // Zoomed in enough that step/5 minor ticks are still comfortably spaced.
    const widthPx = 2000;
    const viewport = { viewStart: 0, viewSpan: 20 * TIMESCALE, widthPx };
    const ticks = generateRulerTicks(viewport, TIMESCALE, TICKS_PER_FRAME, FPS);
    expect(ticks.some((t) => !t.major)).toBe(true);
    expect(ticks.filter((t) => !t.major).every((t) => t.label === null)).toBe(true);
  });

  it('places tick x-positions consistently with the viewport transform', () => {
    const viewport = { viewStart: 5 * TIMESCALE, viewSpan: 20 * TIMESCALE, widthPx: 1000 };
    const ticks = generateRulerTicks(viewport, TIMESCALE, TICKS_PER_FRAME, FPS);
    for (const tick of ticks) {
      const expectedX = ((tick.time - viewport.viewStart) / viewport.viewSpan) * viewport.widthPx;
      expect(tick.x).toBeCloseTo(expectedX, 6);
    }
  });

  it('formats major labels as HH:MM at minute-scale steps', () => {
    const viewport = { viewStart: 0, viewSpan: 3600 * TIMESCALE, widthPx: 100 };
    const ticks = generateRulerTicks(viewport, TIMESCALE, TICKS_PER_FRAME, FPS);
    const majors = ticks.filter((t) => t.major);
    expect(majors.length).toBeGreaterThan(0);
    for (const tick of majors) {
      expect(tick.label).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it('formats major labels as MM:SS:FF at frame-scale steps', () => {
    const viewport = { viewStart: 0, viewSpan: 2 * TICKS_PER_FRAME, widthPx: 2000 };
    const ticks = generateRulerTicks(viewport, TIMESCALE, TICKS_PER_FRAME, FPS);
    const majors = ticks.filter((t) => t.major);
    expect(majors.length).toBeGreaterThan(0);
    for (const tick of majors) {
      expect(tick.label).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    }
  });

  it('returns nothing for a degenerate viewport', () => {
    expect(generateRulerTicks({ viewStart: 0, viewSpan: 0, widthPx: 800 }, TIMESCALE, TICKS_PER_FRAME, FPS)).toEqual([]);
  });
});
