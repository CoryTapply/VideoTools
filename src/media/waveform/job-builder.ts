// Turns SampleIndex queries into WaveformSampleDescriptors. Unlike src/media/frames/job-builder.ts
// (coarse: keyframes only; dense: a decode-chain from a sync point), audio has no keyframe/B-frame
// concept -- every sample decodes independently in presentation order. Still walks via
// sampleAtPresentationRank(), never a raw decode-order loop: this project's index module has a
// standing "never assume decode order == presentation order" doctrine (see
// src/media/index/README.md's "Presentation time vs. media time" section) -- audio dts==pts in
// every real fixture checked, but nothing here should rely on that holding for every file that
// exists.

import type { SampleIndex } from '../index/query';

export interface WaveformSampleDescriptor {
  readonly offset: number;
  readonly size: number;
  /** Presentation ticks, carried through untouched -- this module does no time-base math (same convention as src/media/frames/job-builder.ts's DecodeJobDescriptor). */
  readonly presentationTime: number;
}

/** Every sample of `trackId`, in presentation order, whole-track. */
export function buildWaveformJobs(index: SampleIndex, trackId: number): WaveformSampleDescriptor[] {
  const sampleCount = index.sampleCount(trackId);
  const jobs: WaveformSampleDescriptor[] = [];
  for (let rank = 0; rank < sampleCount; rank += 1) {
    const n = index.sampleAtPresentationRank(trackId, rank);
    if (n < 0) continue;
    const range = index.byteRange(trackId, n);
    const presentationTime = index.presentationTimeOfSample(trackId, n);
    jobs.push({ offset: range.offset, size: range.length, presentationTime });
  }
  return jobs;
}
