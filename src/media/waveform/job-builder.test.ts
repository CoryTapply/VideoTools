import { describe, expect, it } from 'vitest';
import { SampleIndex } from '../index/query';
import type { TrackIndex } from '../index/track-index';
import { buildWaveformJobs } from './job-builder';

/** 5 AAC-ish samples, decode order === presentation order (pts === dts), no edit list. */
function makeSyntheticAudioTrack(overrides: Partial<TrackIndex> = {}): TrackIndex {
  const sampleCount = 5;
  const pts = Float64Array.from({ length: sampleCount }, (_, i) => i * 1024);
  const offset = Float64Array.from({ length: sampleCount }, (_, i) => i * 500); // distinct, so byteRange mapping is checkable
  const size = Uint32Array.from({ length: sampleCount }, (_, i) => 200 + i);
  return {
    trackId: 2,
    kind: 'audio',
    handlerType: 'soun',
    codec: 'mp4a.40.2',
    timescale: 48000,
    duration: sampleCount * 1024,
    sampleCount,
    pts,
    dts: pts.slice(),
    offset,
    size,
    isSync: new Uint8Array(sampleCount).fill(1), // every AAC sample independently decodable
    description: new Uint8Array([1, 2, 3]),
    audio: { channelCount: 2, sampleRate: 48000, language: 'und', handlerName: '' },
    editOffsetTicks: 0,
    ...overrides,
  };
}

describe('buildWaveformJobs', () => {
  it('produces one job per sample, in presentation-order rank, whole-track', () => {
    const index = new SampleIndex([makeSyntheticAudioTrack()]);
    const jobs = buildWaveformJobs(index, 2);
    expect(jobs.map((j) => j.presentationTime)).toEqual([0, 1024, 2048, 3072, 4096]);
  });

  it('offset/size come from byteRange for the decode-order sample at each rank', () => {
    const index = new SampleIndex([makeSyntheticAudioTrack()]);
    const jobs = buildWaveformJobs(index, 2);
    expect(jobs[2]?.offset).toBe(2 * 500);
    expect(jobs[2]?.size).toBe(200 + 2);
  });

  it('shifts presentation times by editOffsetTicks', () => {
    const index = new SampleIndex([makeSyntheticAudioTrack({ editOffsetTicks: 512 })]);
    const jobs = buildWaveformJobs(index, 2);
    expect(jobs.map((j) => j.presentationTime)).toEqual([-512, 512, 1536, 2560, 3584]);
  });

  it('walks presentation-order rank, not raw decode-order index, so a reordered track (dts !== pts) still comes out in ascending presentation time', () => {
    // Reverse the presentation order relative to decode order: decode-order sample n has
    // pts = (sampleCount - 1 - n) * 1024, so presentation-order rank 0 is decode-order sample 4.
    const sampleCount = 5;
    const pts = Float64Array.from({ length: sampleCount }, (_, i) => (sampleCount - 1 - i) * 1024);
    const track = makeSyntheticAudioTrack({ pts, dts: pts.slice() });
    const index = new SampleIndex([track]);
    const jobs = buildWaveformJobs(index, 2);
    expect(jobs.map((j) => j.presentationTime)).toEqual([0, 1024, 2048, 3072, 4096]);
    // presentation-order rank 0 (time 0) is decode-order sample 4, whose offset is 4*500.
    expect(jobs[0]?.offset).toBe(4 * 500);
  });

  it('returns an empty list for a track with no samples', () => {
    const track = makeSyntheticAudioTrack({
      sampleCount: 0,
      pts: new Float64Array(0),
      dts: new Float64Array(0),
      offset: new Float64Array(0),
      size: new Uint32Array(0),
      isSync: new Uint8Array(0),
    });
    const index = new SampleIndex([track]);
    expect(buildWaveformJobs(index, 2)).toEqual([]);
  });
});
