import { describe, expect, it } from 'vitest';
import { SampleIndex } from '../index/query';
import { resolveExportSelection } from './select';
import type { TrackIndex } from '../index/track-index';

function makeTrack(opts: {
  trackId: number;
  kind: 'video' | 'audio';
  timescale: number;
  editOffsetTicks?: number;
  pts: number[];
  isSync?: number[];
}): TrackIndex {
  const { trackId, kind, timescale, pts } = opts;
  return {
    trackId,
    kind,
    handlerType: kind === 'video' ? 'vide' : 'soun',
    codec: kind === 'video' ? 'avc1.640034' : 'mp4a.40.2',
    timescale,
    duration: 0,
    sampleCount: pts.length,
    pts: Float64Array.from(pts),
    dts: Float64Array.from(pts),
    offset: Float64Array.from(pts.map((_, i) => i * 1000)),
    size: Uint32Array.from(pts.map(() => 1000)),
    isSync: Uint8Array.from(opts.isSync ?? pts.map(() => 1)),
    description: new Uint8Array(0),
    editOffsetTicks: opts.editOffsetTicks ?? 0,
  };
}

describe('resolveExportSelection -- inherits query.ts §7 B-frame correctness for free', () => {
  // Same decode-order pts pattern as query.test.ts's regression fixture, extended with a second
  // sync sample at decode-index 2 (pts 2970) so the start-point snap has a real choice to make.
  const video = makeTrack({
    trackId: 1,
    kind: 'video',
    timescale: 30000,
    pts: [1440, 5940, 2970, 4410, 10440],
    isSync: [1, 0, 1, 0, 0],
  });
  const index = new SampleIndex([video]);

  it('snaps the start point to the largest sync pts <= requested, matching query.ts\'s own worked example', () => {
    // Requesting start at pts=3000 (0.1s @ 30000): largest sync pts <= 3000 is 2970 (decode-index 2)
    // -- the exact counter-example from query.ts's §7 header comment. A decode-order forward scan
    // (the spike's select.ts bug) is not exercised here at all; sampleRange does the real work.
    const result = resolveExportSelection(index, [video], new Set([1]), 3000 / 30000, 5940 / 30000);
    if ('error' in result) throw new Error('expected a selection, got an error');
    expect(result.actualStartTicks).toBe(2970);
    expect(result.keyframeShiftTicks).toBe(2970 - 3000);
    // sampleRange(1, 2970, 5940) -- window excludes decode-index 1 (pts 5940) by the half-open
    // upper bound despite it being decoded before index 3. Matches query.test.ts exactly.
    expect(result.ranges).toEqual([{ trackId: 1, first: 2, last: 3 }]);
  });
});

describe('resolveExportSelection -- multi-track selection', () => {
  const video = makeTrack({ trackId: 1, kind: 'video', timescale: 1000, pts: [0, 100, 200, 300, 400] });
  const mic = makeTrack({ trackId: 2, kind: 'audio', timescale: 2000, editOffsetTicks: 50, pts: [50, 250, 450, 650, 850] });
  const silentAudio = makeTrack({ trackId: 3, kind: 'audio', timescale: 1000, pts: [1000, 1100, 1200] });
  const tracks = [video, mic, silentAudio];
  const index = new SampleIndex(tracks);

  it('video (unsnapped, all-sync) supplies the presentation window [0.1, 0.35)', () => {
    const result = resolveExportSelection(index, tracks, new Set([1, 2, 3]), 0.1, 0.35);
    if ('error' in result) throw new Error('expected a selection, got an error');
    expect(result.actualStartTicks).toBe(100);
    expect(result.actualEndTicks).toBe(350);
    expect(result.keyframeShiftTicks).toBe(0);
  });

  it('converts the shared presentation window into each track\'s own raw ticks via its editOffsetTicks', () => {
    const result = resolveExportSelection(index, tracks, new Set([1, 2, 3]), 0.1, 0.35);
    if ('error' in result) throw new Error('expected a selection, got an error');
    // video: pts in [100, 350) -> decode-indices 1,2,3 (100, 200, 300); 400 excluded.
    // mic: raw ticks in [250, 750) -> decode-indices 1,2,3 (250, 450, 650); 850 excluded, 50 excluded.
    // silentAudio: entirely outside the window -> legitimately excluded, not an error.
    expect(result.ranges).toEqual([
      { trackId: 1, first: 1, last: 3 },
      { trackId: 2, first: 1, last: 3 },
    ]);
  });

  it('exporting only the mic track: video supplies the cut grid but is absent from ranges -- no special case', () => {
    const result = resolveExportSelection(index, tracks, new Set([2]), 0.1, 0.35);
    if ('error' in result) throw new Error('expected a selection, got an error');
    expect(result.actualStartTicks).toBe(100); // still derived from the video track
    expect(result.ranges).toEqual([{ trackId: 2, first: 1, last: 3 }]);
  });

  it('a track with zero overlap in the window is excluded, not an error', () => {
    const result = resolveExportSelection(index, tracks, new Set([3]), 0.1, 0.35);
    expect(result).toEqual({ error: { kind: 'empty-selection' } });
  });
});

describe('resolveExportSelection -- error cases', () => {
  it('no video track', () => {
    const audio = makeTrack({ trackId: 2, kind: 'audio', timescale: 1000, pts: [0, 100, 200] });
    const index = new SampleIndex([audio]);
    const result = resolveExportSelection(index, [audio], new Set([2]), 0, 0.1);
    expect(result).toEqual({ error: { kind: 'no-video-track' } });
  });

  it('requested end point at or before the (possibly-snapped) start point', () => {
    const video = makeTrack({ trackId: 1, kind: 'video', timescale: 1000, pts: [0, 100, 200, 300, 400] });
    const index = new SampleIndex([video]);
    const result = resolveExportSelection(index, [video], new Set([1]), 0.2, 0.05);
    expect(result).toEqual({ error: { kind: 'empty-selection' } });
  });

  it('empty selectedTrackIds', () => {
    const video = makeTrack({ trackId: 1, kind: 'video', timescale: 1000, pts: [0, 100, 200, 300, 400] });
    const index = new SampleIndex([video]);
    const result = resolveExportSelection(index, [video], new Set(), 0.1, 0.35);
    expect(result).toEqual({ error: { kind: 'empty-selection' } });
  });
});
