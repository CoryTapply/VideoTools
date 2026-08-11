// Handle-drag snapping -- design/README.md's Snapping section: candidates are the nearest real
// keyframe (binary search over keyframePresentationTimes(), never `round(t/GOP)*GOP` -- that's
// the reference prototype's fiction, banned since VFR/mid-file encoder changes break a
// constant-GOP assumption), the playhead, 0, duration, and the opposite handle. Tolerance is 8
// *screen* px converted to time at the current zoom, so it stays constant in pixels, not time.

import { binarySearchNearest } from '../../media/frames/binary-search.ts';
import type { Time, Viewport } from './types.ts';

export const SNAP_TOLERANCE_PX = 8;

export function screenPxToTicks(px: number, viewSpan: Time, widthPx: number): Time {
  if (widthPx <= 0) return 0;
  return (px / widthPx) * viewSpan;
}

export interface SnapContext {
  keyframeTimes: Float64Array;
  playhead: Time;
  duration: Time;
  /** The other in/out edge, or null when not applicable (e.g. general playhead scrub). */
  oppositeHandle: Time | null;
}

/** Nearest real keyframe to `t`, or null if there are none. Pure binary search -- no allocation,
 * safe to call every pointermove, same as FrameCache.getNearest()'s own rationale. */
export function nearestKeyframe(keyframeTimes: Float64Array, t: Time): Time | null {
  const idx = binarySearchNearest(keyframeTimes, t);
  return idx === -1 ? null : keyframeTimes[idx];
}

/** Snaps `t` to the closest candidate within `toleranceTicks`, or returns `t` unchanged if none
 * qualify. Ties (equal distance) prefer the earlier-listed candidate: keyframe, playhead, 0,
 * duration, opposite handle. */
export function snapTo(t: Time, context: SnapContext, toleranceTicks: Time): Time {
  const candidates: Time[] = [];
  const kf = nearestKeyframe(context.keyframeTimes, t);
  if (kf !== null) candidates.push(kf);
  candidates.push(context.playhead, 0, context.duration);
  if (context.oppositeHandle !== null) candidates.push(context.oppositeHandle);

  let best: Time | null = null;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const dist = Math.abs(candidate - t);
    if (dist <= toleranceTicks && dist < bestDist) {
      best = candidate;
      bestDist = dist;
    }
  }
  return best ?? t;
}

/** Convenience wrapper computing the tolerance from the current viewport. */
export function snapToViewport(t: Time, context: SnapContext, viewport: Viewport): Time {
  return snapTo(t, context, screenPxToTicks(SNAP_TOLERANCE_PX, viewport.viewSpan, viewport.widthPx));
}
