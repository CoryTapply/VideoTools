// Differential test against mediabunny (pinned in package.json), per task spec §8. mediabunny's
// CustomSource ({ getSize, read(start,end) }) maps directly onto our own ByteSource, so no Node
// shim is needed -- see toCustomSource below.
//
// Known mediabunny quirks (from src/spikes/B-index/mediabunny-check.ts, Spike B):
//  1. Its default BlobSource `useStreamReader: true` mode balloons Chrome tab memory -- not
//     applicable here (we use CustomSource directly, not BlobSource, and this runs in Node).
//  2. An unbounded full-track metadata walk can crash at scale -- not applicable to tiny.mp4
//     (48 video samples), so no sample cap is needed here.
//  3. mediabunny's packet.timestamp is edit-list-adjusted -- confirmed on tiny.mp4 itself: ffmpeg
//     gives its AAC track (and, to keep tracks aligned, its video track too) a priming-delay edit
//     list, exactly the pattern task spec §"EDIT LISTS" warns about. Every comparison below goes
//     through localTicksToPresentationSeconds (which subtracts editOffsetTicks) rather than a
//     raw pts/timescale division, so this is compared correctly instead of "by luck".

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ALL_FORMATS, CustomSource, EncodedPacketSink, Input } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { buildIndex } from './build-index';
import { BufferByteSource } from './sources/buffer-byte-source';
import { localTicksToPresentationSeconds } from './time';

const FIXTURE_PATH = path.join(__dirname, '__fixtures__', 'tiny.mp4');
const TIME_EPS = 1e-6;

function toCustomSource(bytes: Uint8Array): CustomSource {
  return new CustomSource({
    getSize: () => bytes.byteLength,
    read: (start, end) => bytes.subarray(start, end),
  });
}

describe('differential: rewrite vs mediabunny (tiny.mp4)', () => {
  const bytes = readFileSync(FIXTURE_PATH);
  const uint8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  it('agrees on sample count, timestamps, sync flags, and sample byte content per track', async () => {
    const ours = await buildIndex(new BufferByteSource(uint8));
    expect(ours.ok).toBe(true);
    if (!ours.ok) return;

    const input = new Input({ source: toCustomSource(uint8), formats: ALL_FORMATS });
    const mbTracks = await input.getTracks();

    for (const ourTrack of ours.tracks) {
      if (ourTrack.kind === 'other') continue;

      const mbTrack = mbTracks.find((t) => t.id === ourTrack.trackId);
      expect(mbTrack, `track ${String(ourTrack.trackId)} missing from mediabunny`).toBeDefined();
      if (!mbTrack) continue;

      const sink = new EncodedPacketSink(mbTrack);
      const stats = await mbTrack.computePacketStats();
      const disagreements: string[] = [];

      if (stats.packetCount !== ourTrack.sampleCount) {
        disagreements.push(`sampleCount: ours=${String(ourTrack.sampleCount)} mediabunny=${String(stats.packetCount)}`);
      }

      let i = 0;
      for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
        if (i >= ourTrack.sampleCount) {
          disagreements.push(`extra sample in mediabunny at ${String(i)}: timestamp=${String(packet.timestamp)}`);
          i += 1;
          continue;
        }
        const oursTimestamp = localTicksToPresentationSeconds(ourTrack.pts[i], ourTrack.timescale, ourTrack.editOffsetTicks);
        if (Math.abs(oursTimestamp - packet.timestamp) > TIME_EPS) {
          disagreements.push(`timestamp[${String(i)}]: ours=${String(oursTimestamp)} mediabunny=${String(packet.timestamp)}`);
        }
        const oursSync = ourTrack.isSync[i] === 1;
        const theirsSync = packet.type === 'key';
        if (oursSync !== theirsSync) disagreements.push(`sync[${String(i)}]: ours=${String(oursSync)} mediabunny=${String(theirsSync)}`);
        i += 1;
      }

      const sampleIndicesToCheck = Array.from({ length: Math.min(ourTrack.sampleCount, 1000) }, (_, k) => k);
      for (const idx of sampleIndicesToCheck) {
        const ts = localTicksToPresentationSeconds(ourTrack.pts[idx], ourTrack.timescale, ourTrack.editOffsetTicks);
        const packet = await sink.getPacket(ts, { metadataOnly: false });
        if (!packet) {
          disagreements.push(`byte-check[${String(idx)}]: mediabunny returned no packet at ts=${String(ts)}`);
          continue;
        }
        if (packet.byteLength !== ourTrack.size[idx]) {
          disagreements.push(`size[${String(idx)}]: ours=${String(ourTrack.size[idx])} mediabunny=${String(packet.byteLength)}`);
        }
        const ourBytes = uint8.subarray(ourTrack.offset[idx], ourTrack.offset[idx] + ourTrack.size[idx]);
        const equal = ourBytes.byteLength === packet.data.byteLength && ourBytes.every((b, k) => b === packet.data[k]);
        if (!equal) disagreements.push(`content[${String(idx)}]: byte mismatch (${String(ourBytes.byteLength)}B vs ${String(packet.data.byteLength)}B)`);
      }

      if (disagreements.length > 0) {
        console.warn(`track ${String(ourTrack.trackId)} disagreements:\n${disagreements.join('\n')}`);
      }
      expect(disagreements).toEqual([]);
    }
  });

  it('agrees on the full keyframe timestamp list for the video track', async () => {
    const ours = await buildIndex(new BufferByteSource(uint8));
    expect(ours.ok).toBe(true);
    if (!ours.ok) return;
    const videoTrack = ours.tracks.find((t) => t.kind === 'video');
    expect(videoTrack).toBeDefined();
    if (!videoTrack) return;

    const input = new Input({ source: toCustomSource(uint8), formats: ALL_FORMATS });
    const mbTracks = await input.getTracks();
    const mbTrack = mbTracks.find((t) => t.id === videoTrack.trackId);
    expect(mbTrack).toBeDefined();
    if (!mbTrack) return;
    const sink = new EncodedPacketSink(mbTrack);

    const ourSyncIndices: number[] = [];
    for (let k = 0; k < videoTrack.sampleCount; k += 1) if (videoTrack.isSync[k] === 1) ourSyncIndices.push(k);

    const disagreements: string[] = [];
    let keyPacket = await sink.getFirstKeyPacket();
    let kIdx = 0;
    while (keyPacket) {
      if (kIdx >= ourSyncIndices.length) {
        disagreements.push(`extra keyframe in mediabunny at ${String(kIdx)}: timestamp=${String(keyPacket.timestamp)}`);
      } else {
        const idx = ourSyncIndices[kIdx];
        const oursTs = localTicksToPresentationSeconds(videoTrack.pts[idx], videoTrack.timescale, videoTrack.editOffsetTicks);
        if (Math.abs(oursTs - keyPacket.timestamp) > TIME_EPS) {
          disagreements.push(`keyframe[${String(kIdx)}]: ours=${String(oursTs)} mediabunny=${String(keyPacket.timestamp)}`);
        }
      }
      kIdx += 1;
      keyPacket = await sink.getNextKeyPacket(keyPacket);
    }
    if (kIdx < ourSyncIndices.length) {
      disagreements.push(`missing keyframes in mediabunny: ours=${String(ourSyncIndices.length)} mediabunny=${String(kIdx)}`);
    }

    if (disagreements.length > 0) console.warn(disagreements.join('\n'));
    expect(disagreements).toEqual([]);
  });
});
