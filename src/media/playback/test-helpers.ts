// Shared test-only helpers for src/media/playback/*.test.ts -- hand-built TrackIndex/SampleIndex
// fixtures, mirroring src/media/index/query.test.ts's makeTrack() convention, so engine tests
// don't need a real MP4 file or a browser.

import { SampleIndex } from '../index/query';
import type { TrackIndex } from '../index/track-index';

export interface MakeVideoTrackOptions {
  trackId?: number;
  codec?: string;
  timescale?: number;
  editOffsetTicks?: number;
  /** Presentation-order pts values, decode-order indexed (i.e. same convention as TrackIndex.pts itself: this array IS the decode-order pts array). */
  pts: number[];
  isSync: number[];
}

export function makeVideoTrack(options: MakeVideoTrackOptions): TrackIndex {
  const { trackId = 1, codec = 'avc1.640034', timescale = 30000, editOffsetTicks = 0, pts, isSync } = options;
  return {
    trackId,
    kind: 'video',
    handlerType: 'vide',
    codec,
    timescale,
    duration: Math.max(...pts) + 1000,
    sampleCount: pts.length,
    pts: Float64Array.from(pts),
    dts: Float64Array.from(pts),
    offset: Float64Array.from(pts.map((_, i) => i * 1000)),
    size: Uint32Array.from(pts.map(() => 1000)),
    isSync: Uint8Array.from(isSync),
    description: new Uint8Array(0),
    editOffsetTicks,
  };
}

/** A simple constant-frame-rate track: `count` samples, one every `frameDurationTicks` ticks, a keyframe every `gopSize` samples. */
export function makeConstantFrameRateTrack(count: number, frameDurationTicks: number, gopSize: number, options: Partial<MakeVideoTrackOptions> = {}): TrackIndex {
  const pts = Array.from({ length: count }, (_, i) => i * frameDurationTicks);
  const isSync = Array.from({ length: count }, (_, i) => (i % gopSize === 0 ? 1 : 0));
  return makeVideoTrack({ ...options, pts, isSync });
}

/**
 * A track where decode order != presentation order, matching a common IPBBP encoding pattern:
 * within each 4-frame GOP, decode order is [I, P, b, b] but presentation (pts) order is
 * [I, b, b, P] -- decode-order local pts offsets (in frameDuration units) are [0, 3, 1, 2],
 * repeating per GOP. Only the first decode-order sample of each GOP is a sync sample.
 */
export function makeBFrameTrack(gopCount: number, frameDurationTicks: number, options: Partial<MakeVideoTrackOptions> = {}): TrackIndex {
  const pattern = [0, 3, 1, 2];
  const pts: number[] = [];
  const isSync: number[] = [];
  for (let g = 0; g < gopCount; g += 1) {
    const base = g * pattern.length;
    for (let i = 0; i < pattern.length; i += 1) {
      pts.push((base + pattern[i]) * frameDurationTicks);
      isSync.push(i === 0 ? 1 : 0);
    }
  }
  return makeVideoTrack({ ...options, pts, isSync });
}

export function makeSampleIndex(tracks: TrackIndex[]): SampleIndex {
  return new SampleIndex(tracks);
}
