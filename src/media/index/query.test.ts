import { describe, expect, it } from 'vitest';
import { SampleIndex } from './query';
import type { TrackIndex } from './track-index';

function makeTrack(pts: number[], isSync: number[]): TrackIndex {
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
    isSync: Uint8Array.from(isSync),
    description: new Uint8Array(0),
    editOffsetTicks: 0,
  };
}

describe('SampleIndex -- monotonic (no B-frames)', () => {
  const track = makeTrack([0, 1000, 2000, 3000, 4000], [1, 0, 1, 0, 0]);
  const index = new SampleIndex([track]);

  it('frameAtTime finds the largest pts at or before the target', () => {
    expect(index.frameAtTime(1, 2500)).toBe(2);
    expect(index.frameAtTime(1, 2000)).toBe(2);
    expect(index.frameAtTime(1, -1)).toBe(-1);
  });

  it('nearestSyncAtOrBefore / nextSync / prevSync', () => {
    expect(index.nearestSyncAtOrBefore(1, 2500)).toBe(2);
    expect(index.nearestSyncAtOrBefore(1, 2000)).toBe(2);
    expect(index.prevSync(1, 2000)).toBe(0); // strictly before an exact sync match
    expect(index.nextSync(1, 0)).toBe(2);
  });

  it('byteRange and keyframeTimes', () => {
    expect(index.byteRange(1, 2)).toEqual({ offset: 2000, length: 1000 });
    expect(Array.from(index.keyframeTimes(1))).toEqual([0, 2000]);
  });

  it('sampleRange covers a contiguous presentation window', () => {
    expect(index.sampleRange(1, 1000, 3000)).toEqual({ first: 1, last: 2 });
    expect(index.sampleRange(1, 10_000, 20_000)).toBeUndefined();
  });
});

describe('SampleIndex -- §7 regression: B-frame reordering (decode order != presentation order)', () => {
  // Decode-order pts, matching the pattern observed on the 27GB fixture's video track:
  // pts is NOT monotonic in decode order. Decode-index -> pts: 0->1440, 1->5940, 2->2970,
  // 3->4410, 4->10440. Presentation order (by pts ascending) is decode-indices [0, 2, 3, 1, 4].
  const track = makeTrack([1440, 5940, 2970, 4410, 10440], [1, 0, 0, 0, 0]);
  const index = new SampleIndex([track]);

  it('frameAtTime returns the decode-index whose pts is the largest <= target, not whichever the forward scan saw last', () => {
    // Largest pts <= 3000 is 2970 at decode-index 2 -- correct even though decode-index 1 (pts
    // 5940, decoded BEFORE index 2) does not qualify, and decode-index 3 (pts 4410, decoded
    // AFTER index 2) also does not qualify. A decode-order forward scan that blindly overwrote
    // `best` on every qualifying sample it encountered would still get this one right by luck;
    // the case that actually separates the two definitions is the next assertion.
    expect(index.frameAtTime(1, 3000)).toBe(2);
  });

  it('sampleRange picks presentation-order boundaries, matching frameAtTime exactly at the edges', () => {
    // Presentation order: pts 1440(#0), 2970(#2), 4410(#3), 5940(#1), 10440(#4).
    // Window [2970, 5940) should include exactly decode-indices {2, 3} (pts 2970 and 4410) --
    // NOT decode-index 1 (pts 5940, excluded by the half-open upper bound), even though index 1
    // was decoded before index 3.
    expect(index.sampleRange(1, 2970, 5940)).toEqual({ first: 2, last: 3 });
  });

  it('a window ending exactly on a decoded-early, presented-late sample excludes it (half-open upper bound)', () => {
    // decode-index 1 (pts 5940) is decoded second but presented fourth. A window up to (but not
    // including) 5940 must not pull it in just because it appears early in decode order.
    const range = index.sampleRange(1, 0, 5940);
    expect(range).toEqual({ first: 0, last: 3 }); // decode-indices {0, 2, 3} -> pts {1440, 2970, 4410}
  });
});
