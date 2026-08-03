// Spike B / Step 3 -- query latency against the typed-array index. See
// prompts/m0.5-spike-prompts.md Step 3.
//
// Binary search needs a MONOTONIC array to search over, but `cts` in decode order is NOT
// monotonic when the track has B-frames (confirmed on the 27GB fixture's video track: cts
// values like [1440, 5940, 2970, 4410, 10440] for decode-order samples 0-4). So a presentation-
// order index (decode-order sample indices, sorted once by cts) is built up front, and binary
// search happens over THAT -- this is the standard fix, and it's a one-time O(n log n) cost
// separate from the O(log n) per-query cost being measured here.

import type { TrackIndex } from '../A-remux/mp4-index';

export interface QueryIndex {
  track: TrackIndex;
  /** decode-order sample indices, sorted ascending by cts (presentation time) */
  presentationOrder: Uint32Array;
  /** decode-order sample indices of sync samples only, sorted ascending by cts */
  syncPresentationOrder: Uint32Array;
}

export function buildQueryIndex(track: TrackIndex): QueryIndex {
  const order = Array.from({ length: track.sampleCount }, (_, i) => i);
  order.sort((a, b) => track.cts[a]! - track.cts[b]!);

  const syncOrder: number[] = [];
  for (let i = 0; i < track.sampleCount; i += 1) if (track.sync[i] === 1) syncOrder.push(i);
  syncOrder.sort((a, b) => track.cts[a]! - track.cts[b]!);

  return {
    track,
    presentationOrder: Uint32Array.from(order),
    syncPresentationOrder: Uint32Array.from(syncOrder),
  };
}

/** Largest-cts-at-or-before binary search over a presentation-order array. Returns the DECODE-order sample index, or -1. */
function searchAtOrBefore(track: TrackIndex, order: Uint32Array, targetLocalUnits: number): number {
  let lo = 0;
  let hi = order.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const sampleIdx = order[mid]!;
    if (track.cts[sampleIdx]! <= targetLocalUnits) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans === -1 ? -1 : order[ans]!;
}

/** Frame index (decode-order sample index) at or before an arbitrary local (track-timescale) timestamp. */
export function frameIndexAtTimestamp(qi: QueryIndex, targetLocalUnits: number): number {
  return searchAtOrBefore(qi.track, qi.presentationOrder, targetLocalUnits);
}

/** Nearest preceding sync sample (decode-order index) at or before an arbitrary local timestamp. */
export function nearestPrecedingSyncSample(qi: QueryIndex, targetLocalUnits: number): number {
  return searchAtOrBefore(qi.track, qi.syncPresentationOrder, targetLocalUnits);
}

/** PTS (local track-timescale units) of the Nth frame in PRESENTATION order -- the frame-stepping path. O(1). */
export function ptsOfPresentationFrame(qi: QueryIndex, n: number): number | undefined {
  const sampleIdx = qi.presentationOrder[n];
  return sampleIdx === undefined ? undefined : qi.track.cts[sampleIdx];
}

/** Byte range for a given decode-order sample index. O(1). */
export function byteRangeOfSample(track: TrackIndex, sampleIdx: number): { offset: number; size: number } {
  return { offset: track.offset[sampleIdx]!, size: track.size[sampleIdx]! };
}

export interface QueryBenchmarkResult {
  name: string;
  iterations: number;
  totalMs: number;
  nsPerOp: number;
}

function bench(name: string, iterations: number, fn: (i: number) => void): QueryBenchmarkResult {
  const t0 = performance.now();
  for (let i = 0; i < iterations; i += 1) fn(i);
  const totalMs = performance.now() - t0;
  return { name, iterations, totalMs, nsPerOp: (totalMs * 1e6) / iterations };
}

export function runQueryBenchmarks(track: TrackIndex, iterations = 10_000): { queryIndexBuildMs: number; results: QueryBenchmarkResult[] } {
  const t0 = performance.now();
  const qi = buildQueryIndex(track);
  const queryIndexBuildMs = performance.now() - t0;

  const lastCts = track.cts[track.sampleCount - 1]!;
  // Precompute random targets up front so target generation isn't counted in the per-op time.
  const targets = new Float64Array(iterations);
  for (let i = 0; i < iterations; i += 1) targets[i] = Math.random() * lastCts;
  const frameTargets = new Int32Array(iterations);
  for (let i = 0; i < iterations; i += 1) frameTargets[i] = 1 + Math.floor(Math.random() * (track.sampleCount - 2));

  let sink = 0; // accumulates results so the JIT can't optimize away "unused" work

  const results: QueryBenchmarkResult[] = [
    bench('frameIndexAtTimestamp (binary search)', iterations, (i) => {
      sink += frameIndexAtTimestamp(qi, targets[i]!);
    }),
    bench('nearestPrecedingSyncSample (binary search)', iterations, (i) => {
      sink += nearestPrecedingSyncSample(qi, targets[i]!);
    }),
    bench('ptsOfPresentationFrame N/N+1/N-1 (frame-stepping)', iterations, (i) => {
      const n = frameTargets[i]!;
      sink += (ptsOfPresentationFrame(qi, n - 1) ?? 0) + (ptsOfPresentationFrame(qi, n) ?? 0) + (ptsOfPresentationFrame(qi, n + 1) ?? 0);
    }),
    bench('byteRangeOfSample', iterations, (i) => {
      const r = byteRangeOfSample(track, frameTargets[i]!);
      sink += r.offset + r.size;
    }),
  ];

  if (Number.isNaN(sink)) throw new Error('unreachable'); // keep `sink` observably used
  return { queryIndexBuildMs, results };
}
