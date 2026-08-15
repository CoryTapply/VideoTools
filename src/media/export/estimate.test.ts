import { describe, expect, it } from 'vitest';
import { estimateExportBytes } from './estimate';
import type { TrackIndex } from '../index/track-index';
import type { ExportSelection } from './types';

function makeTrack(trackId: number, sizes: number[]): TrackIndex {
  return {
    trackId,
    kind: 'video',
    handlerType: 'vide',
    codec: 'avc1.640034',
    timescale: 1000,
    duration: 0,
    sampleCount: sizes.length,
    pts: Float64Array.from(sizes.map((_, i) => i * 100)),
    dts: Float64Array.from(sizes.map((_, i) => i * 100)),
    offset: Float64Array.from(sizes.map((_, i) => i * 1000)),
    size: Uint32Array.from(sizes),
    isSync: Uint8Array.from(sizes.map(() => 1)),
    description: new Uint8Array(0),
    editOffsetTicks: 0,
  };
}

describe('estimateExportBytes', () => {
  it('sums real sample sizes over each range, no I/O', () => {
    const a = makeTrack(1, [100, 200, 300, 400]);
    const b = makeTrack(2, [50, 60, 70]);
    const tracksById = new Map([
      [1, a],
      [2, b],
    ]);
    const selection: ExportSelection = {
      ranges: [
        { trackId: 1, first: 1, last: 2 }, // 200 + 300
        { trackId: 2, first: 0, last: 1 }, // 50 + 60
      ],
      actualStartTicks: 0,
      actualEndTicks: 0,
      keyframeShiftTicks: 0,
    };
    expect(estimateExportBytes(selection, tracksById)).toBe(200 + 300 + 50 + 60);
  });

  it('ignores a range whose track is missing from the map', () => {
    const a = makeTrack(1, [100, 200]);
    const selection: ExportSelection = {
      ranges: [
        { trackId: 1, first: 0, last: 1 },
        { trackId: 99, first: 0, last: 0 },
      ],
      actualStartTicks: 0,
      actualEndTicks: 0,
      keyframeShiftTicks: 0,
    };
    expect(estimateExportBytes(selection, new Map([[1, a]]))).toBe(300);
  });
});
