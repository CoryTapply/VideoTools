// Resolves a requested [start, end] presentation window plus a set of selected tracks into
// per-track sample ranges. This is a deliberate, from-scratch replacement for
// src/spikes/A-remux/select.ts, NOT a port -- that file's `lastSampleAtOrBefore` does a
// decode-order forward scan for both the start- and end-point of a trim, which silently gives the
// wrong answer under B-frame reordering (see src/media/index/query.ts's §7 header comment for the
// exact counter-example). Using SampleIndex.sampleRange (presentation-order binary search) instead
// makes that class of bug impossible here by construction -- see query.test.ts's B-frame
// regression fixture, reused below.

import { secondsToTicks, ticksToSeconds } from '../index/time';
import type { SampleIndex } from '../index/query';
import type { TrackIndex } from '../index/track-index';
import type { ExportError, ExportRange, ExportSelection } from './types';

export function resolveExportSelection(
  sampleIndex: SampleIndex,
  tracks: readonly TrackIndex[],
  selectedTrackIds: ReadonlySet<number>,
  requestedStartSec: number,
  requestedEndSec: number,
): ExportSelection | { error: ExportError } {
  const videoTrack = tracks.find((t) => t.kind === 'video');
  if (!videoTrack) return { error: { kind: 'no-video-track' } };

  // Presentation ticks, primary video track's own timescale -- the canonical time base (see
  // architecture-v3.md §2). The video track supplies the keyframe/timeline reference regardless
  // of whether it's itself in `selectedTrackIds` -- this is what makes "export only the mic
  // track" produce the same cut boundaries a video export of the same range would have, with no
  // special case.
  const requestedStartTicks = secondsToTicks(requestedStartSec, videoTrack.timescale);
  const requestedEndTicks = secondsToTicks(requestedEndSec, videoTrack.timescale);

  let syncIdx = sampleIndex.nearestSyncAtOrBeforePresentation(videoTrack.trackId, requestedStartTicks);
  if (syncIdx === -1) {
    // Requested start point is before the track's first sync sample (e.g. a negative or
    // near-zero request racing an edit-offset priming delay) -- fall back to the earliest sync
    // sample in the track rather than failing outright.
    syncIdx = sampleIndex.nextSyncPresentation(videoTrack.trackId, -1);
  }
  if (syncIdx === -1) return { error: { kind: 'empty-selection' } };

  const actualStartTicks = sampleIndex.presentationTimeOfSample(videoTrack.trackId, syncIdx);
  const actualEndTicks = requestedEndTicks;
  if (actualEndTicks <= actualStartTicks) return { error: { kind: 'empty-selection' } };

  const actualStartSec = ticksToSeconds(actualStartTicks, videoTrack.timescale);
  const actualEndSec = ticksToSeconds(actualEndTicks, videoTrack.timescale);

  const ranges: ExportRange[] = [];
  for (const track of tracks) {
    if (!selectedTrackIds.has(track.trackId)) continue;
    const rawStart = secondsToTicks(actualStartSec, track.timescale) + track.editOffsetTicks;
    const rawEnd = secondsToTicks(actualEndSec, track.timescale) + track.editOffsetTicks;
    const range = sampleIndex.sampleRange(track.trackId, rawStart, rawEnd);
    // A track with no samples overlapping this window (e.g. a silent/empty audio track for this
    // range) is legitimately excluded rather than an error.
    if (range) ranges.push({ trackId: track.trackId, first: range.first, last: range.last });
  }
  if (ranges.length === 0) return { error: { kind: 'empty-selection' } };

  return {
    ranges,
    actualStartTicks,
    actualEndTicks,
    keyframeShiftTicks: actualStartTicks - requestedStartTicks,
  };
}
