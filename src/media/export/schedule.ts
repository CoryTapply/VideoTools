// Read-amplification fix (T0's finding): windowing each track's samples SEPARATELY, grouped into
// per-track ~1s chunks, means an N-track fixture reads each ~1s span of physically interleaved
// source bytes once per track -- measured 6.5x amplification on a 7-track fixture, near the 7x
// ceiling. Every selected track's samples are already physically interleaved in the source at
// roughly the same offsets for a given time span, so walking ALL selected tracks' samples
// together, sorted once by source offset, visits the exact same bytes exactly once -- and happens
// to yield samples in very close to the order you'd want to write them anyway. Ported from
// src/spikes/A-remux/remux-write.ts's planMergedEntries/planMergedSchedule, retyped against
// ExportRange + a trackId->TrackIndex map instead of the spike's SampleRange[].

import type { TrackIndex } from '../index/track-index';
import type { ExportRange } from './types';

export interface WriteChunk {
  readonly trackId: number;
  /** inclusive, decode-order sample index */
  readonly first: number;
  /** inclusive, decode-order sample index */
  readonly last: number;
}

export interface MergedEntry {
  readonly trackId: number;
  /** decode-order sample index, within its track */
  readonly sampleIdx: number;
  readonly offset: number;
  readonly size: number;
}

/**
 * Flattens every selected range across every track into one list, sorted by source byte offset.
 * This is the single source of truth for both the merged schedule (stco/stsc grouping) and the
 * merged copy loop (forEachWindowMerged) -- both derive from this exact order, so moov's declared
 * byte layout and the copy loop's actual write order can never disagree.
 */
export function planMergedEntries(ranges: readonly ExportRange[], tracksById: ReadonlyMap<number, TrackIndex>): MergedEntry[] {
  const entries: MergedEntry[] = [];
  for (const range of ranges) {
    const track = tracksById.get(range.trackId);
    if (!track) continue;
    for (let i = range.first; i <= range.last; i += 1) {
      entries.push({ trackId: range.trackId, sampleIdx: i, offset: track.offset[i], size: track.size[i] });
    }
  }
  entries.sort((a, b) => a.offset - b.offset);
  return entries;
}

/**
 * Groups the source-offset-sorted flat list into maximal same-track, contiguous-sampleIdx runs.
 * Runs are typically short (a handful of samples) since tracks interleave tightly in the source,
 * which grows stco/stsc somewhat (more, smaller chunks) -- bounded by total sample count,
 * negligible next to the moov build's existing per-sample cost.
 */
export function planMergedSchedule(ranges: readonly ExportRange[], tracksById: ReadonlyMap<number, TrackIndex>): WriteChunk[] {
  const entries = planMergedEntries(ranges, tracksById);
  const schedule: WriteChunk[] = [];
  for (const e of entries) {
    const lastIdx = schedule.length - 1;
    if (lastIdx >= 0 && schedule[lastIdx].trackId === e.trackId && schedule[lastIdx].last === e.sampleIdx - 1) {
      schedule[lastIdx] = { trackId: e.trackId, first: schedule[lastIdx].first, last: e.sampleIdx };
    } else {
      schedule.push({ trackId: e.trackId, first: e.sampleIdx, last: e.sampleIdx });
    }
  }
  return schedule;
}
