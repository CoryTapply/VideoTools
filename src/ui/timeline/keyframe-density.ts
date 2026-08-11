// Keyframe row rendering density -- design/README.md's Keyframe row: >=16px spacing draws
// full-height ticks, 3-16px draws short ticks, <3px collapses to a striped texture whose opacity
// scales with spacing. Pure: no canvas, no DOM.

import { timeToX } from './viewport.ts';
import type { Time, Viewport } from './types.ts';

export type KeyframeDensityMode = 'full' | 'short' | 'stripe';

export interface KeyframeDensityInfo {
  mode: KeyframeDensityMode;
  /** Only meaningful when mode === 'stripe': clamp(0.4, pxPerKeyframe*2, 0.85). */
  stripeOpacity: number;
}

export function keyframeDensity(pxPerKeyframe: number): KeyframeDensityInfo {
  if (pxPerKeyframe >= 16) return { mode: 'full', stripeOpacity: 0 };
  if (pxPerKeyframe >= 3) return { mode: 'short', stripeOpacity: 0 };
  return { mode: 'stripe', stripeOpacity: Math.min(0.85, Math.max(0.4, pxPerKeyframe * 2)) };
}

/** Average spacing between keyframes, in ticks -- same computation FrameCache.warmCoarse() uses
 * for its own dense-tier trigger, kept independent here so the timeline draw path never reaches
 * into FrameCache's private state. */
export function averageKeyframeIntervalTicks(keyframeTimes: Float64Array): Time {
  if (keyframeTimes.length < 2) return 0;
  return (keyframeTimes[keyframeTimes.length - 1] - keyframeTimes[0]) / (keyframeTimes.length - 1);
}

function lowerBound(sorted: Float64Array, target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface KeyframeTick {
  time: Time;
  x: number;
}

/** Keyframes within the current viewport, using binary search to skip straight to the visible
 * slice rather than filtering the whole (sorted, ascending) array. */
export function visibleKeyframeTicks(keyframeTimes: Float64Array, viewport: Viewport): KeyframeTick[] {
  if (keyframeTimes.length === 0 || viewport.viewSpan <= 0 || viewport.widthPx <= 0) return [];
  const end = viewport.viewStart + viewport.viewSpan;
  const ticks: KeyframeTick[] = [];
  for (let i = lowerBound(keyframeTimes, viewport.viewStart); i < keyframeTimes.length && keyframeTimes[i] <= end; i += 1) {
    ticks.push({ time: keyframeTimes[i], x: timeToX(keyframeTimes[i], viewport.viewStart, viewport.viewSpan, viewport.widthPx) });
  }
  return ticks;
}
