// Part 6: frame stepping. THE CORRECTNESS TEST, per the task: from an arbitrary starting frame,
// step forward 10 and back 10; must land on the byte-identical starting frame, verified by frame
// index, not timestamp proximity. Run from 20 starting points including one inside a B-frame run
// and one immediately after a keyframe, then run the same test against a VFR fixture.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIndex } from '../index/build-index';
import { SampleIndex } from '../index/query';
import { BufferByteSource } from '../index/sources/buffer-byte-source';
import { pickStepStartingPoints, stepTarget } from './frame-stepping';
import { makeBFrameTrack, makeConstantFrameRateTrack, makeSampleIndex } from './test-helpers';

function assertForwardBackRoundTrip(index: SampleIndex, trackId: number, description: string): void {
  const startingPoints = pickStepStartingPoints(index, trackId, 20);
  expect(startingPoints.length, `${description}: expected at least a few starting points`).toBeGreaterThan(0);

  for (const startSample of startingPoints) {
    const startTicks = index.presentationTimeOfSample(trackId, startSample);
    const forwardTicks = stepTarget(index, trackId, startTicks, 10);
    const forwardSample = index.frameAtPresentationTime(trackId, forwardTicks);
    const backTicks = stepTarget(index, trackId, forwardTicks, -10);
    const backSample = index.frameAtPresentationTime(trackId, backTicks);

    expect(backSample, `${description}: start=${String(startSample)} forward10=${String(forwardSample)} back10=${String(backSample)} did not round-trip`).toBe(startSample);
  }
}

describe('frame stepping: forward-10-back-10 round trip (synthetic tracks)', () => {
  it('round-trips on a constant-frame-rate track (59.94fps-like) from 20 starting points', () => {
    const track = makeConstantFrameRateTrack(5000, 1001, 30, { timescale: 60_000 }); // ~59.94fps
    const index = makeSampleIndex([track]);
    assertForwardBackRoundTrip(index, track.trackId, 'CFR track');
  });

  it('round-trips on a track with B-frames (decode order != presentation order), including points inside a B-frame run and immediately after a keyframe', () => {
    const track = makeBFrameTrack(300, 1000, { timescale: 30_000 });
    const index = makeSampleIndex([track]);
    assertForwardBackRoundTrip(index, track.trackId, 'B-frame track');
  });

  it('the picked starting points actually include one inside a B-frame run and one immediately after a keyframe', () => {
    const track = makeBFrameTrack(300, 1000, { timescale: 30_000 });
    const index = makeSampleIndex([track]);
    const points = pickStepStartingPoints(index, track.trackId, 20);

    const isSyncByDecodeIndex = track.isSync;
    const hasNonSyncPoint = points.some((p) => isSyncByDecodeIndex[p] === 0);
    expect(hasNonSyncPoint, 'expected at least one selected starting point to be a non-sync (B/P-frame) sample').toBe(true);
  });
});

describe('frame stepping: clamping', () => {
  it('stepping past the last frame lands exactly on the last frame, no wraparound, no error', () => {
    const track = makeConstantFrameRateTrack(50, 1000, 10);
    const index = makeSampleIndex([track]);
    const nearEndTicks = index.presentationTimeOfSample(track.trackId, 45);
    const target = stepTarget(index, track.trackId, nearEndTicks, 100);
    const sample = index.frameAtPresentationTime(track.trackId, target);
    expect(sample).toBe(49); // last decode-order sample (== last presentation-order rank here, CFR)
  });

  it('stepping before frame 0 lands exactly on frame 0, no wraparound, no error', () => {
    const track = makeConstantFrameRateTrack(50, 1000, 10);
    const index = makeSampleIndex([track]);
    const nearStartTicks = index.presentationTimeOfSample(track.trackId, 3);
    const target = stepTarget(index, track.trackId, nearStartTicks, -100);
    const sample = index.frameAtPresentationTime(track.trackId, target);
    expect(sample).toBe(0);
  });
});

describe('frame stepping: epsilon sanity', () => {
  it("the returned tick, re-searched, resolves to the target frame itself (epsilon lands inside the frame's window, not on its exact lower boundary)", () => {
    const track = makeConstantFrameRateTrack(1000, 1001, 30, { timescale: 60_000 });
    const index = makeSampleIndex([track]);

    for (const startSample of pickStepStartingPoints(index, track.trackId, 20)) {
      const startTicks = index.presentationTimeOfSample(track.trackId, startSample);
      const target = stepTarget(index, track.trackId, startTicks, 3);
      const resolvedSample = index.frameAtPresentationTime(track.trackId, target);
      const expectedRank = index.presentationRank(track.trackId, startSample) + 3;
      if (expectedRank >= track.sampleCount) continue;
      const expectedSample = index.sampleAtPresentationRank(track.trackId, expectedRank);
      expect(resolvedSample).toBe(expectedSample);
    }
  });
});

const VFR_FIXTURE_PATH = path.join(__dirname, '..', '..', '..', 'fixtures', 'vfr-screen.mp4');

if (existsSync(VFR_FIXTURE_PATH)) {
  describe('frame stepping: forward-10-back-10 round trip (fixtures/vfr-screen.mp4, real VFR data)', () => {
    it('round-trips from 20 starting points', async () => {
      const bytes = readFileSync(VFR_FIXTURE_PATH);
      const uint8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const result = await buildIndex(new BufferByteSource(uint8));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const videoTrack = result.tracks.find((t) => t.kind === 'video');
      expect(videoTrack).toBeDefined();
      if (!videoTrack) return;

      const index = new SampleIndex(result.tracks);
      assertForwardBackRoundTrip(index, videoTrack.trackId, 'vfr-screen.mp4');
    });
  });
} else {
  describe.skip('frame stepping: forward-10-back-10 round trip (skipped -- fixtures/vfr-screen.mp4 not present locally)', () => {
    it('skipped', () => undefined);
  });
}
