// Cheap, no-I/O size estimate for a resolved selection -- a real sum of the sample sizes an
// export would actually copy, not a fabricated formula. Cheap enough to call on every tin/tout
// drag or track toggle for a live "est. size" UI row.

import type { TrackIndex } from '../index/track-index';
import type { ExportSelection } from './types';

export function estimateExportBytes(selection: ExportSelection, tracksById: ReadonlyMap<number, TrackIndex>): number {
  let total = 0;
  for (const range of selection.ranges) {
    const track = tracksById.get(range.trackId);
    if (!track) continue;
    for (let i = range.first; i <= range.last; i += 1) total += track.size[i];
  }
  return total;
}
