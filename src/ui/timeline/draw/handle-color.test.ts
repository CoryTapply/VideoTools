import { describe, expect, it } from 'vitest';
import { color, motion } from '../../tokens.ts';
import { advanceBarTransition, barFillColor } from './handle-color.ts';
import type { BarColorTransition } from './handle-color.ts';

function hexToRgbTuple(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbTuple(rgb: string): [number, number, number] {
  const match = /rgb\((\d+),(\d+),(\d+)\)/.exec(rgb);
  if (match === null) throw new Error(`not an rgb() string: ${rgb}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

describe('advanceBarTransition', () => {
  it('is a no-op when the target already matches the transition in flight/settled', () => {
    const prev: BarColorTransition = { from: 'rest', to: 'hover', startedAt: 100 };
    expect(advanceBarTransition(prev, 'hover', 200)).toBe(prev);
  });

  it('starts a fresh transition from the previous target when the target changes', () => {
    const prev: BarColorTransition = { from: 'rest', to: 'hover', startedAt: 100 };
    const next = advanceBarTransition(prev, 'active', 250);
    expect(next).toEqual({ from: 'hover', to: 'active', startedAt: 250 });
  });

  it('handles a reversal back toward the original state', () => {
    const prev: BarColorTransition = { from: 'rest', to: 'hover', startedAt: 100 };
    const next = advanceBarTransition(prev, 'rest', 150);
    expect(next).toEqual({ from: 'hover', to: 'rest', startedAt: 150 });
  });
});

describe('barFillColor', () => {
  it('is exactly the "from" color at elapsed=0', () => {
    const transition: BarColorTransition = { from: 'rest', to: 'active', startedAt: 1000 };
    expect(rgbTuple(barFillColor(transition, 1000))).toEqual(hexToRgbTuple(color.accent));
  });

  it('is exactly the "to" color once the transition duration has fully elapsed', () => {
    const transition: BarColorTransition = { from: 'rest', to: 'active', startedAt: 1000 };
    expect(rgbTuple(barFillColor(transition, 1000 + motion.handleBarTransitionMs))).toEqual(hexToRgbTuple(color.accentActive));
    // Stays clamped to the "to" color well past the duration too.
    expect(rgbTuple(barFillColor(transition, 1000 + motion.handleBarTransitionMs * 5))).toEqual(hexToRgbTuple(color.accentActive));
  });

  it('is strictly between the two endpoint colors partway through the transition', () => {
    const transition: BarColorTransition = { from: 'rest', to: 'active', startedAt: 1000 };
    const [fr, fg, fb] = hexToRgbTuple(color.accent);
    const [tr, tg, tb] = hexToRgbTuple(color.accentActive);
    const [r, g, b] = rgbTuple(barFillColor(transition, 1000 + motion.handleBarTransitionMs / 2));
    expect(r).toBeGreaterThanOrEqual(Math.min(fr, tr));
    expect(r).toBeLessThanOrEqual(Math.max(fr, tr));
    expect(g).toBeGreaterThanOrEqual(Math.min(fg, tg));
    expect(g).toBeLessThanOrEqual(Math.max(fg, tg));
    expect(b).toBeGreaterThanOrEqual(Math.min(fb, tb));
    expect(b).toBeLessThanOrEqual(Math.max(fb, tb));
  });

  it('resolves rest/hover/active to their exact tokens.ts colors', () => {
    expect(rgbTuple(barFillColor({ from: 'rest', to: 'rest', startedAt: 0 }, 0))).toEqual(hexToRgbTuple(color.accent));
    expect(rgbTuple(barFillColor({ from: 'hover', to: 'hover', startedAt: 0 }, 0))).toEqual(hexToRgbTuple(color.handleHover));
    expect(rgbTuple(barFillColor({ from: 'active', to: 'active', startedAt: 0 }, 0))).toEqual(hexToRgbTuple(color.accentActive));
  });
});
