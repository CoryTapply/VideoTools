// M1 Task 2, Part 6: frame stepping. Pure functions, built entirely on SampleIndex's
// presentation-order additions (query.ts) -- no VideoElementLike/browser dependency, so the
// interesting arithmetic is Node-testable directly.
//
// The task's own pseudocode (`target = pts[n + delta]`) is wrong given frameAtTime's actual
// contract: frameAtTime/frameAtPresentationTime return a DECODE-order sample number, and `n +
// delta` on a decode-order index only means "step forward delta frames" if decode order equals
// presentation order -- false the moment a track has B-frames (see query.ts's §7 header comment).
// Stepping instead walks `delta` positions in PRESENTATION order via presentationRank /
// sampleAtPresentationRank, then maps back to a decode-order sample only at the very end.

import type { SampleIndex } from '../index/query';

/**
 * Seek target (presentation ticks) for stepping `delta` frames from `currentTicks`. Clamps at the
 * first/last frame -- no wraparound, no error. Adds an epsilon (half the TARGET frame's own
 * duration, from adjacent presentation-order pts deltas, never a nominal fps -- correct for both
 * constant-frame-rate and VFR tracks) to defeat float rounding at the `currentTime` boundary,
 * which otherwise lands on the previous frame roughly half the time.
 */
export function stepTarget(index: SampleIndex, trackId: number, currentTicks: number, delta: number): number {
  const sampleCount = index.sampleCount(trackId);
  const currentSample = index.frameAtPresentationTime(trackId, currentTicks);
  const currentRank = currentSample >= 0 ? index.presentationRank(trackId, currentSample) : 0;
  const targetRank = Math.max(0, Math.min(sampleCount - 1, currentRank + delta));

  const targetSample = index.sampleAtPresentationRank(trackId, targetRank);
  const targetTicks = index.presentationTimeOfSample(trackId, targetSample);
  const epsilon = frameDurationTicks(index, trackId, targetRank, sampleCount) / 2;
  return targetTicks + Math.floor(epsilon);
}

function frameDurationTicks(index: SampleIndex, trackId: number, rank: number, sampleCount: number): number {
  const thisSample = index.sampleAtPresentationRank(trackId, rank);
  const thisTicks = index.presentationTimeOfSample(trackId, thisSample);
  if (rank + 1 < sampleCount) {
    const nextSample = index.sampleAtPresentationRank(trackId, rank + 1);
    return index.presentationTimeOfSample(trackId, nextSample) - thisTicks;
  }
  if (rank > 0) {
    const prevSample = index.sampleAtPresentationRank(trackId, rank - 1);
    return thisTicks - index.presentationTimeOfSample(trackId, prevSample);
  }
  return 0; // single-sample track -- degenerate, epsilon is moot
}

/**
 * Picks up to `count` starting decode-order sample indices for the forward-10-back-10 round-trip
 * test (and the Part 7 harness's equivalent real-browser check, which imports this rather than
 * duplicating the selection): a spread across the whole track, plus -- when the track has enough
 * keyframes -- one sample immediately after a keyframe and one sample inside a run of consecutive
 * non-sync samples between two keyframes (a B/P-frame run), the two cases most likely to expose an
 * epsilon or presentation-rank bug.
 */
export function pickStepStartingPoints(index: SampleIndex, trackId: number, count = 20): number[] {
  const sampleCount = index.sampleCount(trackId);
  if (sampleCount === 0) return [];

  const points = new Set<number>();
  const spreadCount = Math.max(1, count - 2);
  for (let i = 0; i < spreadCount; i += 1) {
    points.add(Math.floor((i / spreadCount) * (sampleCount - 1)));
  }

  const keyframeTimes = index.keyframePresentationTimes(trackId);
  if (keyframeTimes.length > 0) {
    const firstKeyframeSample = index.frameAtPresentationTime(trackId, keyframeTimes[0]);
    const firstKeyframeRank = index.presentationRank(trackId, firstKeyframeSample);
    if (firstKeyframeRank + 1 < sampleCount) {
      points.add(index.sampleAtPresentationRank(trackId, firstKeyframeRank + 1));
    }
  }

  if (keyframeTimes.length >= 2) {
    const firstSample = index.frameAtPresentationTime(trackId, keyframeTimes[0]);
    const secondSample = index.frameAtPresentationTime(trackId, keyframeTimes[1]);
    const firstRank = index.presentationRank(trackId, firstSample);
    const secondRank = index.presentationRank(trackId, secondSample);
    if (secondRank - firstRank > 2) {
      const midRank = Math.floor((firstRank + secondRank) / 2);
      points.add(index.sampleAtPresentationRank(trackId, midRank));
    }
  }

  return Array.from(points)
    .slice(0, count)
    .sort((a, b) => a - b);
}
