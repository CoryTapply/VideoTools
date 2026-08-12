// The merged single-pass copy: walks every selected track's samples together in source-offset
// order (via planMergedEntries), coalescing into `windowBytes` windows that may freely span
// multiple tracks, and invokes `onWindow` once per window with the needed bytes concatenated in
// that same order -- which is also the exact output write order `planMergedSchedule` assumed when
// it laid out stco/stsc, so no reordering happens anywhere in this path. Dropping tracks (e.g.
// exporting a single audio track) works with no special case: `ranges` simply has fewer/other
// tracks in it.
//
// Ported from src/spikes/A-remux/remux-write.ts's forEachWindowMerged, with one real change: reads
// through the ByteSource seam (src/media/index/byte-source.ts) instead of a hard-coded
// `File.slice().arrayBuffer()`, which is what makes this Node-testable, and polls a cancellation
// signal once per window -- the actual mechanism Cancel rides on.

import { concatBytes } from './box-writer';
import { planMergedEntries } from './schedule';
import type { ByteSource } from '../index/byte-source';
import type { TrackIndex } from '../index/track-index';
import type { ExportRange } from './types';

/** T0's measured plateau: 1MB windows -> ~80.5MB/s, 4MB -> ~91.1MB/s, 16MB -> ~92.0MB/s. */
export const COALESCE_WINDOW_BYTES = 4 * 1024 * 1024;

export interface CoalescedReadStats {
  readonly windowReads: number;
  readonly windowBytesRead: number;
}

export interface CancelSignal {
  cancelled: boolean;
}

export async function forEachWindowMerged(
  source: ByteSource,
  ranges: readonly ExportRange[],
  tracksById: ReadonlyMap<number, TrackIndex>,
  windowBytes: number,
  onWindow: (bytes: Uint8Array, sampleCount: number) => Promise<void>,
  signal: CancelSignal,
): Promise<CoalescedReadStats> {
  const entries = planMergedEntries(ranges, tracksById);
  let windowReads = 0;
  let windowBytesRead = 0;
  let i = 0;
  while (i < entries.length) {
    if (signal.cancelled) break;

    const windowStart = entries[i].offset;
    let windowEnd = windowStart;
    let j = i;
    while (j < entries.length && entries[j].offset + entries[j].size - windowStart <= windowBytes) {
      windowEnd = entries[j].offset + entries[j].size;
      j += 1;
    }
    if (j === i) {
      // a single sample bigger than the window -- read it directly, can't coalesce further
      windowEnd = entries[i].offset + entries[i].size;
      j = i + 1;
    }

    const windowBuf = await source.read(windowStart, windowEnd - windowStart);
    windowReads += 1;
    windowBytesRead += windowBuf.byteLength;

    const sampleCount = j - i;
    const parts: Uint8Array[] = [];
    for (let k = i; k < j; k += 1) {
      const relOffset = entries[k].offset - windowStart;
      parts.push(windowBuf.subarray(relOffset, relOffset + entries[k].size));
    }
    await onWindow(sampleCount === 1 ? parts[0] : concatBytes(parts), sampleCount);
    i = j;
  }
  return { windowReads, windowBytesRead };
}
