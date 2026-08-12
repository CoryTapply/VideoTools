import { describe, expect, it } from 'vitest';
import { planMergedEntries, planMergedSchedule } from './schedule';
import type { TrackIndex } from '../index/track-index';
import type { ExportRange } from './types';

function makeTrack(trackId: number, offsets: number[], sizes: number[]): TrackIndex {
  return {
    trackId,
    kind: 'video',
    handlerType: 'vide',
    codec: 'avc1.640034',
    timescale: 1000,
    duration: 0,
    sampleCount: offsets.length,
    pts: Float64Array.from(offsets.map((_, i) => i * 100)),
    dts: Float64Array.from(offsets.map((_, i) => i * 100)),
    offset: Float64Array.from(offsets),
    size: Uint32Array.from(sizes),
    isSync: Uint8Array.from(offsets.map(() => 1)),
    description: new Uint8Array(0),
    editOffsetTicks: 0,
  };
}

describe('planMergedEntries', () => {
  it('flattens ranges across tracks and sorts by source byte offset, not by track', () => {
    // Video samples physically interleaved with audio samples in the source file.
    const video = makeTrack(1, [0, 20, 40, 60], [10, 10, 10, 10]);
    const audio = makeTrack(2, [10, 30, 50, 70], [5, 5, 5, 5]);
    const tracksById = new Map([
      [1, video],
      [2, audio],
    ]);
    const ranges: ExportRange[] = [
      { trackId: 1, first: 0, last: 3 },
      { trackId: 2, first: 0, last: 3 },
    ];
    const entries = planMergedEntries(ranges, tracksById);
    expect(entries.map((e) => [e.trackId, e.sampleIdx])).toEqual([
      [1, 0], // offset 0
      [2, 0], // offset 10
      [1, 1], // offset 20
      [2, 1], // offset 30
      [1, 2], // offset 40
      [2, 2], // offset 50
      [1, 3], // offset 60
      [2, 3], // offset 70
    ]);
  });

  it('skips a range whose track is missing from the map', () => {
    const video = makeTrack(1, [0, 10], [5, 5]);
    const ranges: ExportRange[] = [
      { trackId: 1, first: 0, last: 1 },
      { trackId: 99, first: 0, last: 0 },
    ];
    const entries = planMergedEntries(ranges, new Map([[1, video]]));
    expect(entries).toHaveLength(2);
  });
});

describe('planMergedSchedule', () => {
  it('groups the offset-sorted flat list into maximal same-track contiguous runs', () => {
    const video = makeTrack(1, [0, 20, 40, 60], [10, 10, 10, 10]);
    const audio = makeTrack(2, [10, 30, 50, 70], [5, 5, 5, 5]);
    const tracksById = new Map([
      [1, video],
      [2, audio],
    ]);
    const ranges: ExportRange[] = [
      { trackId: 1, first: 0, last: 3 },
      { trackId: 2, first: 0, last: 3 },
    ];
    // Perfectly interleaved (video, audio, video, audio, ...) -> every run is a single sample.
    const schedule = planMergedSchedule(ranges, tracksById);
    expect(schedule).toEqual([
      { trackId: 1, first: 0, last: 0 },
      { trackId: 2, first: 0, last: 0 },
      { trackId: 1, first: 1, last: 1 },
      { trackId: 2, first: 1, last: 1 },
      { trackId: 1, first: 2, last: 2 },
      { trackId: 2, first: 2, last: 2 },
      { trackId: 1, first: 3, last: 3 },
      { trackId: 2, first: 3, last: 3 },
    ]);
  });

  it('merges consecutive same-track samples into one run when they are contiguous in offset order', () => {
    // All of track 1's samples happen to sit before all of track 2's in the source.
    const video = makeTrack(1, [0, 10, 20], [10, 10, 10]);
    const audio = makeTrack(2, [30, 40, 50], [10, 10, 10]);
    const tracksById = new Map([
      [1, video],
      [2, audio],
    ]);
    const ranges: ExportRange[] = [
      { trackId: 1, first: 0, last: 2 },
      { trackId: 2, first: 0, last: 2 },
    ];
    const schedule = planMergedSchedule(ranges, tracksById);
    expect(schedule).toEqual([
      { trackId: 1, first: 0, last: 2 },
      { trackId: 2, first: 0, last: 2 },
    ]);
  });
});
