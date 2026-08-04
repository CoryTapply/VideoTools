// Ported from src/spikes/B-index/queries.ts's binary-search design: pts is NOT monotonic in
// decode order once a track has B-frames, so a presentation-order index (decode-order sample
// indices, sorted once by pts) is built per track up front, and every query binary-searches
// THAT array. All timestamps here are in the TRACK's own timescale units -- see time.ts for the
// only place seconds enter or leave.
//
// ==================================================================================================
// Task spec §7 -- the "1-frame boundary discrepancy" from Spike A's ffmpeg comparison, resolved:
//
// src/spikes/A-remux/select.ts's `lastSampleAtOrBefore` (used for BOTH the in- and out-point of a
// trim) does a DECODE-ORDER forward scan, keeping the last index it sees with pts <= target. Its
// own comment frames this as deliberate: "the last decode-order point such that everything up to
// it has been presented by target". src/spikes/B-index/queries.ts's `searchAtOrBefore` instead
// binary-searches a PRESENTATION-order (pts-sorted) array for the sample with the LARGEST pts <=
// target -- a different definition.
//
// These provably diverge once a track has B-frames, because decode order and presentation order
// aren't the same permutation. Concretely (values observed on the 27GB fixture's video track,
// decode-order samples 0-4): pts = [1440, 5940, 2970, 4410, 10440]. Asking "sample at or before
// pts=3000" under the presentation-order definition correctly returns decode-index 2 (pts 2970,
// the largest pts <= 3000) regardless of where that sample sits in decode order. Under the
// decode-order forward scan, the answer instead depends on ARRIVAL order: `best` gets set to
// decode-index 0 (pts 1440, qualifies), then decode-index 2 (pts 2970, also qualifies and is
// seen later) -- correct here only by coincidence, because the intervening out-of-order sample
// (decode-index 1, pts 5940) didn't qualify and so didn't overwrite `best`. With a longer or
// differently-shaped B-frame run, a qualifying-but-lower-pts sample decoded AFTER a
// qualifying-and-higher-pts one would overwrite `best` with the lower value, or a qualifying
// sample decoded before a non-qualifying one could be left stale -- either way, the forward
// scan's answer tracks decode-arrival order, not "which qualifying sample actually has the
// largest pts". This is hypothesis 1 from the task spec ("last sample in decode order is not the
// last in presentation order").
//
// Resolution for this module: `sampleRange` (and every other query below) uses the
// presentation-order binary search exclusively -- "largest/smallest pts relative to target",
// never a decode-order scan. See sampleRange.test.ts's B-frame-reordering regression test.
// ==================================================================================================

import type { TrackIndex } from './track-index';

interface TrackQueryIndex {
  readonly track: TrackIndex;
  /** decode-order sample indices, sorted ascending by pts */
  readonly presentationOrder: Uint32Array;
  /** decode-order sync-sample indices, sorted ascending by pts */
  readonly syncPresentationOrder: Uint32Array;
}

function buildTrackQueryIndex(track: TrackIndex): TrackQueryIndex {
  const order = Array.from({ length: track.sampleCount }, (_, i) => i);
  order.sort((a, b) => track.pts[a] - track.pts[b]);

  const syncOrder: number[] = [];
  for (let i = 0; i < track.sampleCount; i += 1) if (track.isSync[i] === 1) syncOrder.push(i);
  syncOrder.sort((a, b) => track.pts[a] - track.pts[b]);

  return { track, presentationOrder: Uint32Array.from(order), syncPresentationOrder: Uint32Array.from(syncOrder) };
}

/** Largest-pts-at-or-before binary search over a presentation-order array. Returns the DECODE-order sample index, or -1. */
function searchAtOrBefore(track: TrackIndex, order: Uint32Array, targetTicks: number): number {
  let lo = 0;
  let hi = order.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const sampleIdx = order[mid];
    if (track.pts[sampleIdx] <= targetTicks) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans === -1 ? -1 : order[ans];
}

/** Smallest-pts-at-or-after binary search. Returns the DECODE-order sample index, or -1. */
function searchAtOrAfter(track: TrackIndex, order: Uint32Array, targetTicks: number): number {
  let lo = 0;
  let hi = order.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const sampleIdx = order[mid];
    if (track.pts[sampleIdx] >= targetTicks) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans === -1 ? -1 : order[ans];
}

/** Smallest-position-with-pts->-target binary search (strict). Returns the presentation-order POSITION, or order.length if none qualify. */
function firstPositionStrictlyAfter(track: TrackIndex, order: Uint32Array, targetTicks: number): number {
  let lo = 0;
  let hi = order.length - 1;
  let ans = order.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (track.pts[order[mid]] > targetTicks) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

/** Largest-position-with-pts-<-target binary search (strict). Returns the presentation-order POSITION, or -1 if none qualify. */
function lastPositionStrictlyBefore(track: TrackIndex, order: Uint32Array, targetTicks: number): number {
  let lo = 0;
  let hi = order.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (track.pts[order[mid]] < targetTicks) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export class SampleIndex {
  private readonly byTrackId = new Map<number, TrackQueryIndex>();

  constructor(tracks: TrackIndex[]) {
    for (const track of tracks) this.byTrackId.set(track.trackId, buildTrackQueryIndex(track));
  }

  private require(trackId: number): TrackQueryIndex {
    const qi = this.byTrackId.get(trackId);
    if (!qi) throw new Error(`no track with id ${String(trackId)} in this index`);
    return qi;
  }

  /** Decode-order sample number whose presentation time is the largest at or before `timeTicks`. -1 if none. */
  frameAtTime(trackId: number, timeTicks: number): number {
    const qi = this.require(trackId);
    return searchAtOrBefore(qi.track, qi.presentationOrder, timeTicks);
  }

  /** Composition (presentation) time of decode-order sample `n`, in this track's own timescale units. */
  timeOfSample(trackId: number, n: number): number {
    return this.require(trackId).track.pts[n];
  }

  /** Decode-order sync-sample number with the largest presentation time at or before `timeTicks`. -1 if none. */
  nearestSyncAtOrBefore(trackId: number, timeTicks: number): number {
    const qi = this.require(trackId);
    return searchAtOrBefore(qi.track, qi.syncPresentationOrder, timeTicks);
  }

  /** Decode-order sync-sample number with the smallest presentation time strictly after `timeTicks`. -1 if none. */
  nextSync(trackId: number, timeTicks: number): number {
    const qi = this.require(trackId);
    return searchAtOrAfter(qi.track, qi.syncPresentationOrder, timeTicks + 1);
  }

  /** Decode-order sync-sample number with the largest presentation time strictly before `timeTicks` -- distinct from nearestSyncAtOrBefore only when `timeTicks` lands exactly on a sync sample. -1 if none. */
  prevSync(trackId: number, timeTicks: number): number {
    const qi = this.require(trackId);
    const pos = lastPositionStrictlyBefore(qi.track, qi.syncPresentationOrder, timeTicks);
    return pos === -1 ? -1 : qi.syncPresentationOrder[pos];
  }

  byteRange(trackId: number, n: number): { offset: number; length: number } {
    const track = this.require(trackId).track;
    return { offset: track.offset[n], length: track.size[n] };
  }

  /** All sync-sample presentation times, ascending. */
  keyframeTimes(trackId: number): Float64Array {
    const qi = this.require(trackId);
    const out = new Float64Array(qi.syncPresentationOrder.length);
    for (let i = 0; i < out.length; i += 1) out[i] = qi.track.pts[qi.syncPresentationOrder[i]];
    return out;
  }

  /**
   * Decode-order sample index range [first, last] (inclusive) covering every sample whose
   * presentation time falls in [fromTicks, toTicks). See this file's §7 header comment for why
   * this uses presentation-order boundary search (largest/smallest qualifying pts), not a
   * decode-order scan. Returns undefined if no sample qualifies.
   */
  sampleRange(trackId: number, fromTicks: number, toTicks: number): { first: number; last: number } | undefined {
    const qi = this.require(trackId);
    const order = qi.presentationOrder;
    if (order.length === 0) return undefined;

    const startPos = firstPositionStrictlyAfter(qi.track, order, fromTicks - 1); // >= fromTicks
    const endPos = lastPositionStrictlyBefore(qi.track, order, toTicks); // < toTicks
    if (startPos > endPos || startPos >= order.length || endPos < 0) return undefined;

    let first = order[startPos];
    let last = order[startPos];
    for (let p = startPos + 1; p <= endPos; p += 1) {
      const idx = order[p];
      if (idx < first) first = idx;
      if (idx > last) last = idx;
    }
    return { first, last };
  }
}
