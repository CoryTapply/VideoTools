// Windowed sibling of src/media/waveform/job-builder.ts's buildWaveformJobs (whole-track only):
// every sample of `track` whose PRESENTATION time falls in [startSeconds, endSeconds), in
// presentation order. Walks via sampleAtPresentationRank(), the same "never assume decode order ==
// presentation order" doctrine documented in src/media/index/README.md's "Presentation time vs.
// media time" section -- audio dts==pts in every fixture checked so far, but nothing here assumes
// that holds for every file that exists.
//
// Returns descriptors only (offset/size/presentationTime) -- reading the actual compressed bytes
// is an impure, File-touching step the caller (LiveAudioMixer) does separately, mirroring how
// WaveformCache.doBuild() builds descriptors on the main thread but leaves the byte read to the
// worker.

import { secondsToTicks } from '../index/time';
import type { SampleIndex } from '../index/query';
import type { TrackIndex } from '../index/track-index';
import type { WaveformSampleDescriptor } from '../waveform/job-builder';

export function buildWindowJobs(index: SampleIndex, track: TrackIndex, startSeconds: number, endSeconds: number): WaveformSampleDescriptor[] {
  if (endSeconds <= startSeconds) return [];

  const startTicks = secondsToTicks(startSeconds, track.timescale);
  const endTicks = secondsToTicks(endSeconds, track.timescale);

  const atOrBefore = index.frameAtPresentationTime(track.trackId, startTicks);
  let rank = atOrBefore < 0 ? 0 : index.presentationRank(track.trackId, atOrBefore);

  const jobs: WaveformSampleDescriptor[] = [];
  for (;;) {
    const n = index.sampleAtPresentationRank(track.trackId, rank);
    if (n < 0) break;
    const presentationTime = index.presentationTimeOfSample(track.trackId, n);
    if (presentationTime >= endTicks) break;
    if (presentationTime >= startTicks) {
      const range = index.byteRange(track.trackId, n);
      jobs.push({ offset: range.offset, size: range.length, presentationTime });
    }
    rank += 1;
  }
  return jobs;
}
