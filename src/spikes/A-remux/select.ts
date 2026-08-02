// Spike A / Step 2 -- map a desired [in, out] presentation window (seconds)
// to per-track sample ranges. See prompts/m0.5-spike-prompts.md Step 2.
//
// Edit lists are honored (per decision on the 27GB fixture, where every
// track has a single-entry priming-delay edit list): presentation time 0
// maps to each track's own `editList[0].mediaTime`, not to sample 0.

import type { TrackIndex } from './mp4-index';

export interface SampleRange {
  track: TrackIndex;
  /** inclusive, decode-order sample index */
  startIdx: number;
  /** inclusive, decode-order sample index */
  endIdx: number;
}

export interface SelectionResult {
  ranges: SampleRange[];
  requestedInSec: number;
  requestedOutSec: number;
  /** presentation seconds of the actually-chosen video sync sample, edit-list-adjusted */
  actualInSec: number;
  /** presentation seconds of the actually-chosen video out sample, edit-list-adjusted */
  actualOutSec: number;
  inShiftSec: number;
}

function editOffset(track: TrackIndex): number {
  return track.editList?.[0]?.mediaTime ?? 0;
}

function presentationToLocalUnits(track: TrackIndex, presentationSec: number): number {
  return editOffset(track) + presentationSec * track.timescale;
}

function localUnitsToPresentationSec(track: TrackIndex, localUnits: number): number {
  return (localUnits - editOffset(track)) / track.timescale;
}

/**
 * Last decode-order sample index whose cts <= targetLocalUnits (optionally restricted to
 * sync samples). cts isn't strictly monotonic in decode order (B-frame reordering), but
 * scanning forward and remembering the last qualifying index is still the right definition:
 * it's "the last decode-order point such that everything up to it has been presented by
 * targetLocalUnits", which is what a real cut needs regardless of local cts jitter.
 */
function lastSampleAtOrBefore(track: TrackIndex, targetLocalUnits: number, syncOnly: boolean): number {
  let best = -1;
  for (let i = 0; i < track.sampleCount; i += 1) {
    if (syncOnly && track.sync[i] !== 1) continue;
    if (track.cts[i]! <= targetLocalUnits) best = i;
  }
  return best;
}

function sampleDuration(track: TrackIndex, i: number): number {
  if (i + 1 < track.sampleCount) return track.dts[i + 1]! - track.dts[i]!;
  return Math.max(1, track.mediaDuration - track.dts[i]!);
}

/** All samples whose [cts, cts+duration) overlaps [localStart, localEnd). */
function selectOverlapping(track: TrackIndex, localStart: number, localEnd: number): { startIdx: number; endIdx: number } | undefined {
  let startIdx = -1;
  let endIdx = -1;
  for (let i = 0; i < track.sampleCount; i += 1) {
    const sStart = track.cts[i]!;
    const sEnd = sStart + sampleDuration(track, i);
    if (sEnd > localStart && sStart < localEnd) {
      if (startIdx === -1) startIdx = i;
      endIdx = i;
    }
  }
  return startIdx === -1 ? undefined : { startIdx, endIdx };
}

export function selectSamples(tracks: TrackIndex[], requestedInSec: number, requestedOutSec: number): SelectionResult {
  const videoTrack = tracks.find((t) => t.handlerType === 'vide');
  if (!videoTrack) throw new Error('no video track found');

  const targetInLocal = presentationToLocalUnits(videoTrack, requestedInSec);
  const targetOutLocal = presentationToLocalUnits(videoTrack, requestedOutSec);

  const videoInIdx = lastSampleAtOrBefore(videoTrack, targetInLocal, true);
  if (videoInIdx === -1) throw new Error(`no sync sample at or before requested in-time ${requestedInSec}s`);
  const videoOutIdx = lastSampleAtOrBefore(videoTrack, targetOutLocal, false);
  if (videoOutIdx === -1 || videoOutIdx < videoInIdx) {
    throw new Error(`no valid out-sample for requested out-time ${requestedOutSec}s (in-sample idx ${videoInIdx})`);
  }

  const actualInSec = localUnitsToPresentationSec(videoTrack, videoTrack.cts[videoInIdx]!);
  const actualOutSec = localUnitsToPresentationSec(videoTrack, videoTrack.cts[videoOutIdx]!);

  const ranges: SampleRange[] = [{ track: videoTrack, startIdx: videoInIdx, endIdx: videoOutIdx }];

  for (const track of tracks) {
    if (track === videoTrack) continue;
    const localStart = presentationToLocalUnits(track, actualInSec);
    const localEnd = presentationToLocalUnits(track, actualOutSec);
    const overlap = selectOverlapping(track, localStart, localEnd);
    if (overlap) ranges.push({ track, startIdx: overlap.startIdx, endIdx: overlap.endIdx });
    // A track with zero overlapping samples (e.g. a silent/empty audio track for this
    // range) is legitimately excluded rather than an error.
  }

  return {
    ranges,
    requestedInSec,
    requestedOutSec,
    actualInSec,
    actualOutSec,
    inShiftSec: actualInSec - requestedInSec,
  };
}
