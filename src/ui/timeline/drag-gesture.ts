// Pointer-drag geometry -- general playhead scrub and in/out handle drag. Pure: no DOM, no
// pointer-capture wiring (that's TimelineController's job).

import { timeToX, xToTime } from './viewport.ts';
import type { DragTarget } from '../state/timeline-controller-state.ts';
import type { Time, Viewport } from './types.ts';

/** design/README.md: "Click/drag anywhere scrubs the playhead." Clamped to the file's real
 * duration, never the (possibly narrower) current viewport. */
export function scrubTimeFromPointer(offsetX: number, viewport: Viewport, durationTicks: Time): Time {
  const t = xToTime(offsetX, viewport.viewStart, viewport.viewSpan, viewport.widthPx);
  return Math.min(Math.max(0, t), Math.max(0, durationTicks));
}

/** design/README.md: "a 32px transparent hit area centered on the edge." */
export const HANDLE_HIT_ZONE_PX = 32;

/** The other edge can't be crossed within this margin, in ticks. design/README.md: "Drag handle
 * clamped >= 0.2s from the other edge." */
export const HANDLE_MIN_GAP_SECONDS = 0.2;

/** Which handle (if any) a pointerdown at screen x hits, given the in/out edges' current screen
 * x positions. Ties (equally close, both within the zone) resolve to 'in'. */
export function hitTestHandle(x: number, inX: number, outX: number): DragTarget {
  const half = HANDLE_HIT_ZONE_PX / 2;
  const distIn = Math.abs(x - inX);
  const distOut = Math.abs(x - outX);
  if (distIn > half && distOut > half) return null;
  return distIn <= distOut ? 'in' : 'out';
}

/** Clamps a handle drag so it can't cross the other edge within HANDLE_MIN_GAP_SECONDS, and
 * can't leave [0, durationTicks]. */
export function clampHandleDrag(which: 'in' | 'out', t: Time, oppositeTicks: Time, durationTicks: Time, ticksPerSecond: Time): Time {
  const minGapTicks = HANDLE_MIN_GAP_SECONDS * ticksPerSecond;
  const clamped = Math.min(Math.max(0, t), Math.max(0, durationTicks));
  if (which === 'in') return Math.max(0, Math.min(clamped, oppositeTicks - minGapTicks));
  return Math.min(Math.max(0, durationTicks), Math.max(clamped, oppositeTicks + minGapTicks));
}

/** Screen x position of an edge, for hit-testing/drawing. Thin wrapper kept alongside
 * hitTestHandle so callers don't need a separate import for this one conversion. */
export function edgeX(t: Time, viewport: Viewport): number {
  return timeToX(t, viewport.viewStart, viewport.viewSpan, viewport.widthPx);
}
