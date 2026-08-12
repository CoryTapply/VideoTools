import { describe, expect, it } from 'vitest';
import { SampleIndex } from '../../media/index/query.ts';
import { describeSeekDrift } from './seek-drift.ts';
import type { TrackIndex } from '../../media/index/track-index.ts';

// Same fixture shape as media/index/query.test.ts's makeTrack -- decode order == presentation
// order here (no B-frames), which is all this module's own logic needs to exercise.
function makeTrack(pts: number[], editOffsetTicks: number): TrackIndex {
  return {
    trackId: 1,
    kind: 'video',
    handlerType: 'vide',
    codec: 'avc1.640034',
    timescale: 30000,
    duration: 0,
    sampleCount: pts.length,
    pts: Float64Array.from(pts),
    dts: Float64Array.from(pts),
    offset: Float64Array.from(pts.map((_, i) => i * 1000)),
    size: Uint32Array.from(pts.map(() => 1000)),
    isSync: Uint8Array.from(pts.map(() => 1)),
    description: new Uint8Array(0),
    editOffsetTicks,
  };
}

describe('describeSeekDrift', () => {
  const track = makeTrack([0, 1000, 2000, 3000, 4000], 0);
  const index = new SampleIndex([track]);

  it('reports no drift when requested and landed ticks map to the same frame', () => {
    // 2000 and 2500 both fall in frame 2's window [2000, 3000) -- same frame, not drift, even
    // though the raw ticks differ (sub-frame rounding is expected, not a bug).
    const report = describeSeekDrift(2000, 2500, index, 1);
    expect(report.framesOff).toBe(0);
    expect(report.requestedFrame).toBe(2);
    expect(report.landedFrame).toBe(2);
  });

  it('reports +1 when the settle-seek lands one frame ahead of the request', () => {
    const report = describeSeekDrift(2000, 3000, index, 1);
    expect(report.framesOff).toBe(1);
    expect(report.requestedFrame).toBe(2);
    expect(report.landedFrame).toBe(3);
  });

  it('reports -1 when the settle-seek lands one frame behind the request', () => {
    const report = describeSeekDrift(3000, 2000, index, 1);
    expect(report.framesOff).toBe(-1);
    expect(report.requestedFrame).toBe(3);
    expect(report.landedFrame).toBe(2);
  });

  it('applies editOffsetTicks the same way frameAtPresentationTime does, on both sides', () => {
    const shiftedTrack = makeTrack([500, 1500, 2500, 3500, 4500], 500);
    const shiftedIndex = new SampleIndex([shiftedTrack]);
    // Raw pts are shifted by +500 vs. the unshifted fixture, but editOffsetTicks cancels it back
    // out -- presentation-space behavior should be identical to the unshifted case above.
    const report = describeSeekDrift(2000, 2500, shiftedIndex, 1);
    expect(report.framesOff).toBe(0);
    expect(report.requestedFrame).toBe(2);
  });
});
