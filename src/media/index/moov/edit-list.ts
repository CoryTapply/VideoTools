import { findChild, readFullBoxVersion, type BoxHeader } from '../box-cursor';

export interface EditListEntry {
  readonly segmentDuration: number;
  /** -1 marks an "empty edit": a presentation-timeline gap with no media, per the ISO spec. */
  readonly mediaTime: number;
  readonly mediaRateInteger: number;
  readonly mediaRateFraction: number;
}

/** elst: version 0 fields are 32-bit, version 1 are 64-bit (segmentDuration/mediaTime only). */
export function parseEditList(view: DataView, elst: BoxHeader): EditListEntry[] {
  const contentStart = elst.offset + elst.headerSize;
  const { version } = readFullBoxVersion(view, contentStart);
  const entryCount = view.getUint32(contentStart + 4);
  const entries: EditListEntry[] = [];
  let p = contentStart + 8;
  for (let e = 0; e < entryCount; e += 1) {
    if (version === 1) {
      entries.push({
        segmentDuration: Number(view.getBigUint64(p)),
        mediaTime: Number(view.getBigInt64(p + 8)),
        mediaRateInteger: view.getInt16(p + 16),
        mediaRateFraction: view.getInt16(p + 18),
      });
      p += 20;
    } else {
      entries.push({
        segmentDuration: view.getUint32(p),
        mediaTime: view.getInt32(p + 4),
        mediaRateInteger: view.getInt16(p + 8),
        mediaRateFraction: view.getInt16(p + 10),
      });
      p += 12;
    }
  }
  return entries;
}

export function findEditList(view: DataView, trakStart: number, trakEnd: number): EditListEntry[] | undefined {
  const edts = findChild(view, trakStart, trakEnd, 'edts');
  if (!edts) return undefined;
  const edtsStart = edts.offset + edts.headerSize;
  const elst = findChild(view, edtsStart, edts.offset + edts.boxSize, 'elst');
  if (!elst) return undefined;
  return parseEditList(view, elst);
}

function isSingleTrivialEntry(entries: EditListEntry[], movieDuration: number): boolean {
  if (entries.length !== 1) return false;
  const e = entries[0];
  return e.mediaTime === 0 && e.mediaRateInteger === 1 && e.mediaRateFraction === 0 && e.segmentDuration === movieDuration;
}

export interface EditOffsetResult {
  /** Local (track-timescale) time that maps to presentation time 0. 0 if there's no edit list. */
  readonly editOffsetTicks: number;
  /** True unless the list is exactly one entry of (media_time 0, full duration, rate 1.0) -- see TrackIndex.editList's doc comment for what this drives. */
  readonly isNonTrivial: boolean;
}

/**
 * Resolves an edit list into a single presentation-offset in the TRACK's own timescale units.
 * `elst`'s segmentDuration is in the MOVIE (mvhd) timescale but mediaTime is in the track's own
 * timescale -- converting requires rounding at the right point (into the track's own timescale
 * first) or the result drifts from what other demuxers report (confirmed empirically against
 * mediabunny in Spike B: naively mixing the two timescales in floating seconds produced errors of
 * about 1 part in 4000 on the vfr-screen.mp4 fixture).
 *
 * Edit lists with more than one REAL (non-empty) entry describe a genuine multi-segment cut, not
 * just a priming-delay gap -- building a full multi-segment edit-list player is out of scope for
 * this task (see task spec §9). Such tracks still get a best-effort offset, computed from the
 * FIRST real edit only, and `isNonTrivial` is set so the caller can attach a warning rather than
 * silently returning a number that only covers part of the track's actual edit structure.
 */
export function computeEditOffset(entries: EditListEntry[], movieTimescale: number, trackTimescale: number, movieDuration: number): EditOffsetResult {
  const isNonTrivial = !isSingleTrivialEntry(entries, movieDuration);
  const realEdit = entries.find((e) => e.mediaTime !== -1);
  if (!realEdit) return { editOffsetTicks: 0, isNonTrivial };

  const emptyEditTicks = entries
    .filter((e) => e.mediaTime === -1)
    .reduce((sum, e) => sum + Math.round((e.segmentDuration / movieTimescale) * trackTimescale), 0);
  return { editOffsetTicks: realEdit.mediaTime - emptyEditTicks, isNonTrivial };
}
