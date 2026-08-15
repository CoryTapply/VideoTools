import { describe, expect, it } from 'vitest';
import { clampHandleDrag, edgeX, hitTestHandle, HANDLE_HIT_ZONE_PX, scrubTimeFromPointer } from './drag-gesture.ts';

const viewport = { viewStart: 1000, viewSpan: 4000, widthPx: 800 };

describe('scrubTimeFromPointer', () => {
  it('matches the viewport transform inside the visible range', () => {
    expect(scrubTimeFromPointer(0, viewport, 100_000)).toBe(1000);
    expect(scrubTimeFromPointer(800, viewport, 100_000)).toBe(5000);
    expect(scrubTimeFromPointer(400, viewport, 100_000)).toBe(3000);
  });

  it('clamps to [0, durationTicks], not just the visible viewport', () => {
    // Dragging past the left edge of a viewport that starts > 0 must not go negative.
    expect(scrubTimeFromPointer(-200, viewport, 100_000)).toBe(0);
    // Dragging past the right edge is clamped to the real duration, even if that's inside the
    // current viewport's nominal range (a zoomed-in view near the very end of the file).
    expect(scrubTimeFromPointer(1600, { viewStart: 1000, viewSpan: 4000, widthPx: 800 }, 3000)).toBe(3000);
  });
});

describe('hitTestHandle', () => {
  const startX = 100;
  const endX = 400;

  it('hits "start" inside its 32px zone', () => {
    expect(hitTestHandle(startX, startX, endX)).toBe('start');
    expect(hitTestHandle(startX + HANDLE_HIT_ZONE_PX / 2, startX, endX)).toBe('start');
  });

  it('hits "end" inside its 32px zone', () => {
    expect(hitTestHandle(endX, startX, endX)).toBe('end');
    expect(hitTestHandle(endX - HANDLE_HIT_ZONE_PX / 2, startX, endX)).toBe('end');
  });

  it('misses when outside both zones', () => {
    expect(hitTestHandle(250, startX, endX)).toBeNull();
    expect(hitTestHandle(startX + HANDLE_HIT_ZONE_PX / 2 + 1, startX, endX)).toBeNull();
  });

  it('prefers "start" on an exact tie', () => {
    expect(hitTestHandle(250, 240, 260)).toBe('start');
  });
});

describe('clampHandleDrag', () => {
  const ticksPerSecond = 1000; // 1000 ticks/sec for round numbers
  const durationTicks = 10_000; // 10s

  it('keeps the start handle at least HANDLE_MIN_GAP_SECONDS before the end handle', () => {
    expect(clampHandleDrag('start', 5900, 6000, durationTicks, ticksPerSecond)).toBe(5800); // 6000 - 200
    expect(clampHandleDrag('start', 3000, 6000, durationTicks, ticksPerSecond)).toBe(3000); // unaffected
  });

  it('keeps the end handle at least HANDLE_MIN_GAP_SECONDS after the start handle', () => {
    expect(clampHandleDrag('end', 2100, 2000, durationTicks, ticksPerSecond)).toBe(2200); // 2000 + 200
    expect(clampHandleDrag('end', 8000, 2000, durationTicks, ticksPerSecond)).toBe(8000); // unaffected
  });

  it('never leaves [0, durationTicks]', () => {
    expect(clampHandleDrag('start', -500, 6000, durationTicks, ticksPerSecond)).toBe(0);
    expect(clampHandleDrag('end', 50_000, 2000, durationTicks, ticksPerSecond)).toBe(durationTicks);
  });

  it('never pushes the start handle negative even when the end handle is near 0', () => {
    expect(clampHandleDrag('start', 50, 100, durationTicks, ticksPerSecond)).toBe(0);
  });
});

describe('edgeX', () => {
  it('matches the viewport transform', () => {
    expect(edgeX(1000, viewport)).toBe(0);
    expect(edgeX(5000, viewport)).toBe(800);
  });
});
