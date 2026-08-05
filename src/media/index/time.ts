/**
 * Every timestamp/duration in a TrackIndex is an integer count of a track's own
 * timescale units. Float seconds are never stored -- only computed here, at the
 * boundary, on request. Accumulating float seconds across a long timeline drifts
 * and will eventually put a cut one frame off; integer ticks don't.
 */
export function ticksToSeconds(ticks: number, timescale: number): number {
  return ticks / timescale;
}

export function secondsToTicks(seconds: number, timescale: number): number {
  return Math.round(seconds * timescale);
}

/**
 * Converts a raw local (track-timescale) tick -- e.g. a TrackIndex.pts entry -- into
 * presentation seconds, honoring the track's edit-list offset (TrackIndex.editOffsetTicks; 0 if
 * there's no edit list). This is the edit-adjusted convention other demuxers (and mediabunny's
 * packet.timestamp) report against -- see moov/edit-list.ts's computeEditOffset doc comment.
 */
export function localTicksToPresentationSeconds(localTicks: number, timescale: number, editOffsetTicks: number): number {
  return (localTicks - editOffsetTicks) / timescale;
}
