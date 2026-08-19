import { describe, expect, it } from 'vitest';
import { SampleIndex } from '../index/query';
import type { TrackIndex } from '../index/track-index';
import { buildWindowJobs } from './window-jobs';

/** 10 AAC-ish samples at 48kHz, 1024 samples/frame (~21.3ms/sample), decode order === presentation
 * order (pts === dts), no edit list -- same fixture shape as job-builder.test.ts's own. */
function makeSyntheticAudioTrack(overrides: Partial<TrackIndex> = {}): TrackIndex {
  const sampleCount = 10;
  const pts = Float64Array.from({ length: sampleCount }, (_, i) => i * 1024);
  const offset = Float64Array.from({ length: sampleCount }, (_, i) => i * 500);
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
    isSync: new Uint8Array(sampleCount).fill(1),
    description: new Uint8Array([1, 2, 3]),
    audio: { channelCount: 2, sampleRate: 48000, language: 'und', handlerName: '' },
    editOffsetTicks: 0,
    ...overrides,
  };
}

describe('buildWindowJobs', () => {
  it('returns only samples whose presentation time falls in [startSeconds, endSeconds)', () => {
    const track = makeSyntheticAudioTrack();
    const index = new SampleIndex([track]);
    // sample n has pts = n*1024 ticks @ 48000Hz = n*1024/48000 seconds ~= n*0.02133s.
    // window [0.05, 0.15)s covers ticks [2400, 7200) -> samples with pts in that range: 3,4,5,6,7 (pts 3072..7168).
    const jobs = buildWindowJobs(index, track, 0.05, 0.15);
    expect(jobs.map((j) => j.presentationTime)).toEqual([3072, 4096, 5120, 6144, 7168]);
  });

  it('offset/size come from byteRange for each included sample', () => {
    const track = makeSyntheticAudioTrack();
    const index = new SampleIndex([track]);
    const jobs = buildWindowJobs(index, track, 0.05, 0.15);
    expect(jobs[0]?.offset).toBe(3 * 500);
    expect(jobs[0]?.size).toBe(200 + 3);
  });

  it('includes a sample exactly at startSeconds and excludes one exactly at endSeconds', () => {
    const track = makeSyntheticAudioTrack();
    const index = new SampleIndex([track]);
    // sample 2 pts=2048 ticks = 2048/48000s exactly; sample 4 pts=4096 ticks = 4096/48000s exactly.
    const startSeconds = 2048 / 48000;
    const endSeconds = 4096 / 48000;
    const jobs = buildWindowJobs(index, track, startSeconds, endSeconds);
    expect(jobs.map((j) => j.presentationTime)).toEqual([2048, 3072]);
  });

  it('returns an empty list when the window is entirely before the track starts', () => {
    const track = makeSyntheticAudioTrack();
    const index = new SampleIndex([track]);
    expect(buildWindowJobs(index, track, -1, -0.5)).toEqual([]);
  });

  it('returns an empty list when the window is entirely after the track ends', () => {
    const track = makeSyntheticAudioTrack();
    const index = new SampleIndex([track]);
    expect(buildWindowJobs(index, track, 1000, 1001)).toEqual([]);
  });

  it('returns an empty list for a degenerate (non-positive-length) window', () => {
    const track = makeSyntheticAudioTrack();
    const index = new SampleIndex([track]);
    expect(buildWindowJobs(index, track, 0.1, 0.1)).toEqual([]);
    expect(buildWindowJobs(index, track, 0.2, 0.1)).toEqual([]);
  });

  it('shifts by editOffsetTicks, matching presentationTimeOfSample\'s own edit-adjustment', () => {
    const track = makeSyntheticAudioTrack({ editOffsetTicks: 1024 });
    const index = new SampleIndex([track]);
    // presentation time of decode-order sample n is now (n*1024 - 1024) ticks.
    // window [0, 0.1)s covers presentation ticks [0, 4800) -> samples 1,2,3,4,5 (pres pts 0..4096).
    const jobs = buildWindowJobs(index, track, 0, 0.1);
    expect(jobs.map((j) => j.presentationTime)).toEqual([0, 1024, 2048, 3072, 4096]);
  });

  it('walks presentation-order rank, not raw decode-order index, for a reordered track (dts !== pts)', () => {
    const sampleCount = 10;
    const pts = Float64Array.from({ length: sampleCount }, (_, i) => (sampleCount - 1 - i) * 1024);
    const track = makeSyntheticAudioTrack({ pts, dts: pts.slice() });
    const index = new SampleIndex([track]);
    const jobs = buildWindowJobs(index, track, 0.05, 0.15);
    expect(jobs.map((j) => j.presentationTime)).toEqual([3072, 4096, 5120, 6144, 7168]);
    // presentation time 3072 is decode-order sample (9 - 3) = 6, whose offset is 6*500.
    expect(jobs[0]?.offset).toBe(6 * 500);
  });
});
