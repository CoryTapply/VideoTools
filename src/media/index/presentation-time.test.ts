// Part 1 regression test (M1 Task 2): asserts SampleIndex's presentation-time-native methods
// (frameAtPresentationTime, presentationTimeOfSample, ...) are internally consistent with the raw
// pts / editOffsetTicks arithmetic they wrap. tiny.mp4 has a real priming-delay edit list (see
// differential-mediabunny.test.ts's header comment), so this is not a degenerate editOffsetTicks=0
// check.
//
// This test can only confirm the index's OWN edit-adjustment arithmetic is self-consistent -- it
// cannot verify the actual ground truth against a real <video> element (no browser in Vitest). That
// verification lives exclusively in src/media/playback/harness.ts's empirical check; see
// src/media/index/README.md's "Edit lists" section for the resolved finding.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIndex } from './build-index';
import { SampleIndex } from './query';
import { BufferByteSource } from './sources/buffer-byte-source';

const FIXTURE_PATH = path.join(__dirname, '__fixtures__', 'tiny.mp4');

describe('SampleIndex presentation-time methods (tiny.mp4, real priming-delay edit list)', () => {
  it('presentationTimeOfSample matches raw pts minus editOffsetTicks, and frameAtPresentationTime(0) resolves to sample 0', async () => {
    const bytes = readFileSync(FIXTURE_PATH);
    const uint8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = await buildIndex(new BufferByteSource(uint8));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const videoTrack = result.tracks.find((t) => t.kind === 'video');
    expect(videoTrack).toBeDefined();
    if (!videoTrack) return;

    // A real edit list should produce a non-trivial offset -- otherwise this test would pass
    // vacuously (indistinguishable from editOffsetTicks === 0).
    expect(videoTrack.editOffsetTicks).toBeGreaterThan(0);

    const index = new SampleIndex(result.tracks);

    for (const n of [0, 1, 2, Math.floor(videoTrack.sampleCount / 2), videoTrack.sampleCount - 1]) {
      const expected = videoTrack.pts[n] - videoTrack.editOffsetTicks;
      expect(index.presentationTimeOfSample(videoTrack.trackId, n)).toBe(expected);
    }

    // The sharpest possible regression check for "silently offset by the priming delay": asking
    // for presentation time 0 must resolve to decode-order sample 0, exactly the case that would
    // be wrong by editOffsetTicks if a caller passed raw ticks into a presentation-time query (or
    // vice versa).
    expect(index.frameAtPresentationTime(videoTrack.trackId, 0)).toBe(0);
  });

  it('keyframePresentationTimes and frameAtTime/frameAtPresentationTime differ by exactly editOffsetTicks', async () => {
    const bytes = readFileSync(FIXTURE_PATH);
    const uint8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = await buildIndex(new BufferByteSource(uint8));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const videoTrack = result.tracks.find((t) => t.kind === 'video');
    expect(videoTrack).toBeDefined();
    if (!videoTrack) return;

    const index = new SampleIndex(result.tracks);
    const rawKeyframes = index.keyframeTimes(videoTrack.trackId);
    const presentationKeyframes = index.keyframePresentationTimes(videoTrack.trackId);
    expect(presentationKeyframes.length).toBe(rawKeyframes.length);
    for (let i = 0; i < rawKeyframes.length; i += 1) {
      expect(rawKeyframes[i] - presentationKeyframes[i]).toBe(videoTrack.editOffsetTicks);
    }

    // frameAtTime(raw) and frameAtPresentationTime(same nominal value) must diverge by the offset,
    // not agree by coincidence -- pick a target squarely inside the track's range.
    const midRaw = videoTrack.pts[Math.floor(videoTrack.sampleCount / 2)];
    const viaRaw = index.frameAtTime(videoTrack.trackId, midRaw);
    const viaPresentation = index.frameAtPresentationTime(videoTrack.trackId, midRaw - videoTrack.editOffsetTicks);
    expect(viaPresentation).toBe(viaRaw);
  });
});
