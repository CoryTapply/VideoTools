import { describe, expect, it } from 'vitest';
import type { FileFingerprint } from './fingerprint';
import { deserializeIndex, SCHEMA_VERSION, serializeIndex, type CachedIndex } from './opfs-cache';
import type { TrackIndex } from './track-index';

const fingerprint: FileFingerprint = { size: 12345, lastModified: 999, headHash: 111, tailHash: 222 };

function makeTrack(overrides: Partial<TrackIndex> = {}): TrackIndex {
  const pts = Float64Array.from([0, 1000, 2000]);
  return {
    trackId: 1,
    kind: 'video',
    handlerType: 'vide',
    codec: 'avc1.640034',
    timescale: 30000,
    duration: 3000,
    sampleCount: 3,
    pts,
    dts: pts.slice(),
    offset: Float64Array.from([500, 1500, 2500]),
    size: Uint32Array.from([100, 200, 300]),
    isSync: Uint8Array.from([1, 0, 1]),
    description: Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
    video: { codedWidth: 1920, codedHeight: 1080, displayWidth: 1920, displayHeight: 1080, rotationDegrees: 0, nominalFrameRate: 30, constantDuration: true },
    editOffsetTicks: 0,
    ...overrides,
  };
}

// deserializeIndex requires a fresh, zero-offset ArrayBuffer, matching what File/Blob.arrayBuffer() returns.
function toFreshArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

describe('serializeIndex / deserializeIndex', () => {
  it('round-trips a single video track exactly', () => {
    const index: CachedIndex = { mvhdTimescale: 1000, mvhdDuration: 3000, tracks: [makeTrack()] };
    const bytes = serializeIndex(index, fingerprint);
    const result = deserializeIndex(toFreshArrayBuffer(bytes), fingerprint);
    expect(result.kind).toBe('hit');
    if (result.kind !== 'hit') return;

    expect(result.index.mvhdTimescale).toBe(1000);
    const track = result.index.tracks[0];
    expect(track.trackId).toBe(1);
    expect(track.codec).toBe('avc1.640034');
    expect(Array.from(track.pts)).toEqual([0, 1000, 2000]);
    expect(Array.from(track.offset)).toEqual([500, 1500, 2500]);
    expect(Array.from(track.size)).toEqual([100, 200, 300]);
    expect(Array.from(track.isSync)).toEqual([1, 0, 1]);
    expect(Array.from(track.description)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(track.video).toEqual(makeTrack().video);
  });

  it('round-trips multiple tracks, including odd sample counts (alignment stress) and a zero-sample "other" track', () => {
    const video = makeTrack({ trackId: 1 });
    const oddAudio = makeTrack({
      trackId: 2,
      kind: 'audio',
      handlerType: 'soun',
      codec: 'mp4a.40.2',
      video: undefined,
      audio: { channelCount: 2, sampleRate: 48000, language: 'eng', handlerName: 'Mic' },
      sampleCount: 5,
      pts: Float64Array.from([0, 1, 2, 3, 4]),
      dts: Float64Array.from([0, 1, 2, 3, 4]),
      offset: Float64Array.from([10, 20, 30, 40, 50]),
      size: Uint32Array.from([1, 2, 3, 4, 5]),
      isSync: Uint8Array.from([1, 1, 1, 1, 1]),
    });
    const tmcd = makeTrack({
      trackId: 3,
      kind: 'other',
      handlerType: 'tmcd',
      codec: '',
      video: undefined,
      sampleCount: 0,
      pts: new Float64Array(0),
      dts: new Float64Array(0),
      offset: new Float64Array(0),
      size: new Uint32Array(0),
      isSync: new Uint8Array(0),
      description: new Uint8Array(0),
    });

    const index: CachedIndex = { mvhdTimescale: 1000, mvhdDuration: 3000, tracks: [video, oddAudio, tmcd] };
    const bytes = serializeIndex(index, fingerprint);
    const result = deserializeIndex(toFreshArrayBuffer(bytes), fingerprint);
    expect(result.kind).toBe('hit');
    if (result.kind !== 'hit') return;

    expect(result.index.tracks).toHaveLength(3);
    const restoredAudio = result.index.tracks.find((t) => t.trackId === 2);
    expect(Array.from(restoredAudio?.offset ?? [])).toEqual([10, 20, 30, 40, 50]);
    expect(restoredAudio?.audio).toEqual(oddAudio.audio);
    const restoredTmcd = result.index.tracks.find((t) => t.trackId === 3);
    expect(restoredTmcd?.sampleCount).toBe(0);
    expect(restoredTmcd?.kind).toBe('other');
  });

  it('preserves a non-trivial edit list', () => {
    const track = makeTrack({ editOffsetTicks: 1440, editList: [{ segmentDuration: 3000, mediaTime: 1440, mediaRateInteger: 1, mediaRateFraction: 0 }] });
    const index: CachedIndex = { mvhdTimescale: 1000, mvhdDuration: 3000, tracks: [track] };
    const bytes = serializeIndex(index, fingerprint);
    const result = deserializeIndex(toFreshArrayBuffer(bytes), fingerprint);
    expect(result.kind).toBe('hit');
    if (result.kind !== 'hit') return;
    expect(result.index.tracks[0].editOffsetTicks).toBe(1440);
    expect(result.index.tracks[0].editList).toEqual(track.editList);
  });
});

describe('deserializeIndex -- rejection paths', () => {
  const index: CachedIndex = { mvhdTimescale: 1000, mvhdDuration: 3000, tracks: [makeTrack()] };
  const validBytes = serializeIndex(index, fingerprint);

  it('rejects a cache written at a different schema version, without attempting to read it', () => {
    const corrupted = validBytes.slice();
    new DataView(corrupted.buffer).setUint32(4, SCHEMA_VERSION - 1, true);
    const result = deserializeIndex(toFreshArrayBuffer(corrupted), fingerprint);
    expect(result).toEqual({ kind: 'stale-schema', foundVersion: SCHEMA_VERSION - 1 });
  });

  it('rejects a cache whose fingerprint disagrees with the current file', () => {
    const otherFingerprint: FileFingerprint = { ...fingerprint, size: fingerprint.size + 1 };
    const result = deserializeIndex(toFreshArrayBuffer(validBytes), otherFingerprint);
    expect(result.kind).toBe('fingerprint-mismatch');
  });

  it('reports corrupt (not a crash) for a truncated blob', () => {
    const truncated = validBytes.subarray(0, 10);
    const result = deserializeIndex(toFreshArrayBuffer(truncated), fingerprint);
    expect(result.kind).toBe('corrupt');
  });

  it('reports corrupt (not a crash) for a bad magic number', () => {
    const corrupted = validBytes.slice();
    new DataView(corrupted.buffer).setUint32(0, 0, true);
    const result = deserializeIndex(toFreshArrayBuffer(corrupted), fingerprint);
    expect(result.kind).toBe('corrupt');
  });

  it('reports corrupt (not a crash) for garbage metadata JSON', () => {
    const corrupted = validBytes.slice();
    // Metadata JSON starts right after the 20-byte header (magic 4 + version 4 + fingerprint 24
    // - wait: magic4+version4+fingerprint24+jsonLength4 = 36); scribble over its first bytes.
    corrupted.set([0x7b, 0x00, 0x00, 0x00], 36); // '{' followed by NULs -> invalid JSON
    const result = deserializeIndex(toFreshArrayBuffer(corrupted), fingerprint);
    expect(result.kind).toBe('corrupt');
  });
});
