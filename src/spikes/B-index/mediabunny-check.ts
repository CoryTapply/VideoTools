// Spike B / Step 1 -- correctness cross-check against mediabunny, an independent demuxer.
// See prompts/m0.5-spike-prompts.md Step 1.
//
// mediabunny's packet API doesn't expose raw container byte offsets (it's deliberately
// container-agnostic), so "byte offset" correctness is checked differently than the other
// fields: instead of comparing offset numbers, we read the exact bytes OUR index says live at
// [offset, offset+size) and compare them byte-for-byte against mediabunny's own independently
// read packet data for the same sample. Content equality is a stronger proof that offset+size
// are correct than comparing two numbers that could coincidentally agree while both being wrong.
//
// mediabunny's exposed packet.timestamp is edit-list-adjusted (verified empirically: the 27GB
// fixture's video track reports firstPacket.timestamp=0 despite a raw cts of 1440 at a 1440
// mediaTime edit-list offset), so it's compared against our own edit-list-adjusted
// localUnitsToPresentationSec, not raw cts/timescale.

import { Input, ALL_FORMATS, EncodedPacketSink, type Source } from 'mediabunny';
import type { Mp4Index } from '../A-remux/mp4-index';
import { localUnitsToPresentationSec } from '../A-remux/select';

export interface Mismatch {
  category: string;
  trackId: number;
  sampleIndex: number;
  field: string;
  ours: unknown;
  theirs: unknown;
}

export interface CorrectnessReport {
  mismatches: Mismatch[];
  perTrackSampleCounts: Array<{ trackId: number; ours: number; theirs: number }>;
  fullMetadataSamplesChecked: number;
  byteComparisonsChecked: number;
  keyframesChecked: number;
  elapsedMs: number;
}

/** Matches the subset of File's API this module needs -- satisfied by both a real browser File and a Node FileLike shim. */
export interface ByteReader {
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

const TIME_EPS = 1e-6; // seconds; floating point tolerance for timestamp comparisons

function reportMismatch(
  mismatches: Mismatch[],
  category: string,
  trackId: number,
  sampleIndex: number,
  field: string,
  ours: unknown,
  theirs: unknown,
): void {
  mismatches.push({ category, trackId, sampleIndex, field, ours, theirs });
  // eslint-disable-next-line no-console
  console.warn(`MISMATCH [${category}] track ${trackId} sample ${sampleIndex} ${field}: ours=${String(ours)} theirs=${String(theirs)}`);
}

export async function checkCorrectness(
  index: Mp4Index,
  mediabunnySource: Source,
  byteReader: ByteReader,
  randomSampleCount = 1000,
): Promise<CorrectnessReport> {
  const t0 = performance.now();
  const mismatches: Mismatch[] = [];
  const input = new Input({ source: mediabunnySource, formats: ALL_FORMATS });
  const mbTracks = await input.getTracks();

  const perTrackSampleCounts: Array<{ trackId: number; ours: number; theirs: number }> = [];
  let fullMetadataSamplesChecked = 0;
  let byteComparisonsChecked = 0;
  let keyframesChecked = 0;

  for (const ourTrack of index.tracks) {
    const mbTrack = mbTracks.find((t) => t.id === ourTrack.trackId);
    if (!mbTrack) {
      reportMismatch(mismatches, 'track-presence', ourTrack.trackId, -1, 'track', 'present', 'missing in mediabunny');
      continue;
    }
    const sink = new EncodedPacketSink(mbTrack);

    // 1. total sample count
    const stats = await mbTrack.computePacketStats();
    perTrackSampleCounts.push({ trackId: ourTrack.trackId, ours: ourTrack.sampleCount, theirs: stats.packetCount });
    if (stats.packetCount !== ourTrack.sampleCount) {
      reportMismatch(mismatches, 'sample-count', ourTrack.trackId, -1, 'sampleCount', ourTrack.sampleCount, stats.packetCount);
    }

    // 2. full metadata walk: timestamp and sync (type) for every sample, in decode order
    let i = 0;
    for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
      if (i >= ourTrack.sampleCount) {
        reportMismatch(mismatches, 'metadata-walk', ourTrack.trackId, i, 'extra-sample-in-theirs', undefined, packet.timestamp);
        i += 1;
        continue;
      }
      const oursTimestamp = localUnitsToPresentationSec(ourTrack, ourTrack.cts[i]!);
      if (Math.abs(oursTimestamp - packet.timestamp) > TIME_EPS) {
        reportMismatch(mismatches, 'metadata-walk', ourTrack.trackId, i, 'timestamp', oursTimestamp, packet.timestamp);
      }
      const oursSync = ourTrack.sync[i] === 1;
      const theirsSync = packet.type === 'key';
      if (oursSync !== theirsSync) {
        reportMismatch(mismatches, 'metadata-walk', ourTrack.trackId, i, 'sync', oursSync, theirsSync);
      }
      fullMetadataSamplesChecked += 1;
      i += 1;
    }
    if (i < ourTrack.sampleCount) {
      reportMismatch(mismatches, 'metadata-walk', ourTrack.trackId, i, 'missing-samples-in-theirs', ourTrack.sampleCount, i);
    }

    // 3. random samples: byte-content comparison (proves offset+size correctness)
    const indices = new Set<number>();
    const target = Math.min(randomSampleCount, ourTrack.sampleCount);
    while (indices.size < target) indices.add(Math.floor(Math.random() * ourTrack.sampleCount));
    for (const idx of indices) {
      const ts = localUnitsToPresentationSec(ourTrack, ourTrack.cts[idx]!);
      const packet = await sink.getPacket(ts, { metadataOnly: false });
      if (!packet) {
        reportMismatch(mismatches, 'byte-check', ourTrack.trackId, idx, 'packet', 'present', 'null from mediabunny');
        continue;
      }
      if (packet.byteLength !== ourTrack.size[idx]) {
        reportMismatch(mismatches, 'byte-check', ourTrack.trackId, idx, 'size', ourTrack.size[idx], packet.byteLength);
      }
      const ourBytes = new Uint8Array(await byteReader.slice(ourTrack.offset[idx]!, ourTrack.offset[idx]! + ourTrack.size[idx]!).arrayBuffer());
      const equal = ourBytes.byteLength === packet.data.byteLength && ourBytes.every((b, k) => b === packet.data[k]);
      if (!equal) {
        reportMismatch(mismatches, 'byte-check', ourTrack.trackId, idx, 'data', `${ourBytes.byteLength}B`, `${packet.data.byteLength}B, content differs`);
      }
      byteComparisonsChecked += 1;
    }

    // 4. full keyframe timestamp list
    const ourSyncIndices: number[] = [];
    for (let k = 0; k < ourTrack.sampleCount; k += 1) if (ourTrack.sync[k] === 1) ourSyncIndices.push(k);
    let keyPacket = await sink.getFirstKeyPacket();
    let kIdx = 0;
    while (keyPacket) {
      if (kIdx >= ourSyncIndices.length) {
        reportMismatch(mismatches, 'keyframe-list', ourTrack.trackId, kIdx, 'extra-keyframe-in-theirs', undefined, keyPacket.timestamp);
      } else {
        const oursTs = localUnitsToPresentationSec(ourTrack, ourTrack.cts[ourSyncIndices[kIdx]!]!);
        if (Math.abs(oursTs - keyPacket.timestamp) > TIME_EPS) {
          reportMismatch(mismatches, 'keyframe-list', ourTrack.trackId, ourSyncIndices[kIdx]!, 'keyframe-timestamp', oursTs, keyPacket.timestamp);
        }
      }
      keyframesChecked += 1;
      keyPacket = await sink.getNextKeyPacket(keyPacket);
      kIdx += 1;
    }
    if (kIdx < ourSyncIndices.length) {
      reportMismatch(mismatches, 'keyframe-list', ourTrack.trackId, kIdx, 'missing-keyframes-in-theirs', ourSyncIndices.length, kIdx);
    }
  }

  return {
    mismatches,
    perTrackSampleCounts,
    fullMetadataSamplesChecked,
    byteComparisonsChecked,
    keyframesChecked,
    elapsedMs: performance.now() - t0,
  };
}
