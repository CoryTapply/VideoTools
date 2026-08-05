import { describe, expect, it } from 'vitest';
import { SampleIndex } from '../index/query';
import type { TrackIndex } from '../index/track-index';
import { buildCoarseJobs, buildDenseWindowJobs } from './job-builder';

/** 30 samples, GOP of 10 (sync at 0/10/20), no B-frames (pts === dts, so decode order === presentation order), no edit list. */
function makeSyntheticTrack(overrides: Partial<TrackIndex> = {}): TrackIndex {
  const sampleCount = 30;
  const pts = Float64Array.from({ length: sampleCount }, (_, i) => i * 1000);
  const isSync = Uint8Array.from({ length: sampleCount }, (_, i) => (i % 10 === 0 ? 1 : 0));
  const offset = Float64Array.from({ length: sampleCount }, (_, i) => i * 5000); // distinct, so byteRange mapping is checkable
  const size = Uint32Array.from({ length: sampleCount }, (_, i) => 100 + i);
  return {
    trackId: 1,
    kind: 'video',
    handlerType: 'vide',
    codec: 'avc1.640034',
    timescale: 30000,
    duration: sampleCount * 1000,
    sampleCount,
    pts,
    dts: pts.slice(),
    offset,
    size,
    isSync,
    description: new Uint8Array([1, 2, 3]),
    video: { codedWidth: 1920, codedHeight: 1080, displayWidth: 1920, displayHeight: 1080, rotationDegrees: 0, nominalFrameRate: 30, constantDuration: true },
    editOffsetTicks: 0,
    ...overrides,
  };
}

describe('buildCoarseJobs', () => {
  it('produces one keep:true, type:key job per keyframe, in ascending time order', () => {
    const index = new SampleIndex([makeSyntheticTrack()]);
    const jobs = buildCoarseJobs(index, 1);
    expect(jobs.map((j) => j.time)).toEqual([0, 10000, 20000]);
    expect(jobs.every((j) => j.job.keep && j.job.type === 'key')).toBe(true);
  });

  it('job.id is the decode-order sample index, and offset/size come from byteRange', () => {
    const index = new SampleIndex([makeSyntheticTrack()]);
    const jobs = buildCoarseJobs(index, 1);
    expect(jobs.map((j) => j.job.id)).toEqual([0, 10, 20]);
    expect(jobs[1]?.job.offset).toBe(10 * 5000);
    expect(jobs[1]?.job.size).toBe(100 + 10);
  });

  it('shifts times by editOffsetTicks, matching the presentation-native contract', () => {
    const index = new SampleIndex([makeSyntheticTrack({ editOffsetTicks: 1000 })]);
    const jobs = buildCoarseJobs(index, 1);
    expect(jobs.map((j) => j.time)).toEqual([-1000, 9000, 19000]);
  });
});

describe('buildDenseWindowJobs', () => {
  it('covers a contiguous decode-order chain from the preceding sync sample through the window end', () => {
    const index = new SampleIndex([makeSyntheticTrack()]);
    const jobs = buildDenseWindowJobs(index, 1, 500, 15500, 2000);
    expect(jobs.map((j) => j.job.id)).toEqual(Array.from({ length: 16 }, (_, i) => i)); // n=0..15
  });

  it('types the chain start and any interior sync samples as key, everything else as delta', () => {
    const index = new SampleIndex([makeSyntheticTrack()]);
    const jobs = buildDenseWindowJobs(index, 1, 500, 15500, 2000);
    const keyIds = jobs.filter((j) => j.job.type === 'key').map((j) => j.job.id);
    expect(keyIds).toEqual([0, 10]); // n=0 (chain start) and n=10 (interior GOP boundary)
  });

  it('keeps roughly one sample per stepTicks, starting the grid at windowStart', () => {
    const index = new SampleIndex([makeSyntheticTrack()]);
    const jobs = buildDenseWindowJobs(index, 1, 0, 15000, 2000);
    const keptTimes = jobs.filter((j) => j.job.keep).map((j) => j.time);
    // grid targets 0, 2000, 4000, ... -- first sample AT OR PAST each target, in 1000-tick steps
    expect(keptTimes).toEqual([0, 2000, 4000, 6000, 8000, 10000, 12000, 14000]);
  });

  it('starts the chain at the nearest PRECEDING sync sample, even if that sync sample is well before the window (decoding a mid-GOP window still needs its GOP start)', () => {
    const index = new SampleIndex([makeSyntheticTrack()]);
    const jobs = buildDenseWindowJobs(index, 1, 9000, 11000, 2000);
    // n=10's sync sample is AT pts=10000, after windowStart=9000 -- the true preceding sync is n=0
    expect(jobs[0]?.job.id).toBe(0);
    expect(jobs[0]?.job.type).toBe('key');
    expect(jobs[jobs.length - 1]?.job.id).toBe(11); // endN = frameAtPresentationTime(11000)
  });

  it('returns an empty list when the window has no sync sample at or before it', () => {
    const track = makeSyntheticTrack({ isSync: new Uint8Array(30) }); // no sync samples at all
    const index = new SampleIndex([track]);
    expect(buildDenseWindowJobs(index, 1, 0, 5000, 2000)).toEqual([]);
  });
});
