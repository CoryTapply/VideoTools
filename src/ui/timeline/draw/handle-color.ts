// The start/end handle bar's rest/hover/active fill, animated over motion.handleBarTransitionMs --
// design/scrub-chip-prompt.md's "Transition background .12s ease-out". The bars are canvas-drawn
// (draw/handles.ts), so a CSS transition isn't available; this computes the same eased color lerp
// by hand, driven by TimelineControllerState's per-handle BarColorTransition (a timestamp + a pair
// of state labels), the same "duration + performance.now() timestamp, caller owns clearing/advancing
// it every rAF tick" shape as ./snap-flash.ts's snapFlashOpacity.

import { color, motion } from '../../tokens.ts';

export type BarVisualState = 'rest' | 'hover' | 'active';

export interface BarColorTransition {
  from: BarVisualState;
  to: BarVisualState;
  /** performance.now()-style timestamp the transition to `to` started at. */
  startedAt: number;
}

export const restBarTransition: BarColorTransition = { from: 'rest', to: 'rest', startedAt: -Infinity };

function colorForState(state: BarVisualState): string {
  switch (state) {
    case 'rest':
      return color.accent;
    case 'hover':
      return color.handleHover;
    case 'active':
      return color.accentActive;
  }
}

/** Close enough to CSS's `ease-out` keyword (cubic-bezier(0,0,.58,1)) for a 120ms bar-color
 * micro-transition -- a plain cubic power-ease, not a bezier solve. */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const n = Number.parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function lerpHexColor(fromHex: string, toHex: string, t: number): string {
  const from = parseHex(fromHex);
  const to = parseHex(toHex);
  const r = Math.round(from.r + (to.r - from.r) * t);
  const g = Math.round(from.g + (to.g - from.g) * t);
  const b = Math.round(from.b + (to.b - from.b) * t);
  return `rgb(${r.toString()},${g.toString()},${b.toString()})`;
}

/** Starts a fresh motion.handleBarTransitionMs transition toward `target`, from whatever color
 * `prev` was headed to (not `prev`'s current mid-flight blend) -- a deliberate simplification: a
 * hover flick that reverses direction inside one transition window shows a small snap before the
 * reversed transition proceeds, rather than a continuous reversal. No-ops (returns `prev` as-is)
 * when `target` already matches `prev.to`. */
export function advanceBarTransition(prev: BarColorTransition, target: BarVisualState, now: number): BarColorTransition {
  if (prev.to === target) return prev;
  return { from: prev.to, to: target, startedAt: now };
}

/** The transition's current color, `motion.handleBarTransitionMs` after `startedAt` this settles
 * on `colorForState(transition.to)` exactly. */
export function barFillColor(transition: BarColorTransition, now: number): string {
  const elapsed = now - transition.startedAt;
  const t = elapsed >= motion.handleBarTransitionMs ? 1 : Math.max(0, elapsed / motion.handleBarTransitionMs);
  return lerpHexColor(colorForState(transition.from), colorForState(transition.to), easeOut(t));
}
