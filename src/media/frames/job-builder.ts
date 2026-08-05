// Turns SampleIndex queries into DecodeJobDescriptors. Presentation-native methods only, per the
// task prompt: frameAtPresentationTime, nearestSyncAtOrBeforePresentation,
// presentationTimeOfSample, keyframePresentationTimes, byteRange -- never the raw-tick siblings.

import type { SampleIndex } from '../index/query';
import type { DecodeJobDescriptor } from './worker-pool';
import type { Time } from './types';

export interface TimedJob {
  readonly time: Time;
  readonly job: DecodeJobDescriptor;
}

/** One independent job per keyframe, whole-file -- the coarse tier's entire job set. Each is independently decodable (no chain), so callers are free to reorder/chunk this list however they like. */
export function buildCoarseJobs(index: SampleIndex, trackId: number): TimedJob[] {
  const times = index.keyframePresentationTimes(trackId);
  const jobs: TimedJob[] = [];
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i];
    const n = index.frameAtPresentationTime(trackId, t);
    if (n < 0) continue;
    const range = index.byteRange(trackId, n);
    jobs.push({ time: t, job: { id: n, offset: range.offset, size: range.length, presentationTime: t, type: 'key', keep: true } });
  }
  return jobs;
}

/**
 * One contiguous decode-order chain covering [windowStart, windowEnd], marking `keep: true`
 * roughly every `stepTicks` (2fps target grid, per the task prompt) and `keep: false` on every
 * intervening dependency frame -- all of which still get decoded (spike C's ~30:1
 * decode-to-keep ratio is inherent here, not a bug, because 2fps sample points don't generally
 * land on keyframes). MUST be submitted as one ordered, uninterrupted job list to a single
 * decoder session -- splitting it would break the chain's inter-frame dependencies. Keep-point
 * selection is a simple "first sample at or past the next grid target" walk, not true
 * nearest-neighbor -- close enough at 2fps (0.5s spacing) to not matter for a scrub preview.
 */
export function buildDenseWindowJobs(index: SampleIndex, trackId: number, windowStart: Time, windowEnd: Time, stepTicks: number): TimedJob[] {
  const track = index.tracks().find((t) => t.trackId === trackId);
  if (!track) return [];

  const startN = index.nearestSyncAtOrBeforePresentation(trackId, windowStart);
  const endN = index.frameAtPresentationTime(trackId, windowEnd);
  if (startN < 0 || endN < 0 || endN < startN) return [];

  const jobs: TimedJob[] = [];
  let nextGridTarget = windowStart;
  for (let n = startN; n <= endN; n += 1) {
    const t = index.presentationTimeOfSample(trackId, n);
    const range = index.byteRange(trackId, n);
    const keep = t >= nextGridTarget;
    if (keep) nextGridTarget += stepTicks;
    jobs.push({ time: t, job: { id: n, offset: range.offset, size: range.length, presentationTime: t, type: track.isSync[n] === 1 ? 'key' : 'delta', keep } });
  }
  return jobs;
}
