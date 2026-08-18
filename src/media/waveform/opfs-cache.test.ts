import { describe, expect, it } from 'vitest';
import { deserializePyramid, serializePyramid, type CachedPyramid } from './opfs-cache';
import { PyramidBuilder } from './pyramid';
import type { FileFingerprint } from '../index/fingerprint';

const fingerprint: FileFingerprint = { size: 123456, lastModified: 789, headHash: 0xdeadbeef, tailHash: 0xfeedface };

function buildTestPyramid(trackId = 2, channelCount = 2, sampleRate = 48000): CachedPyramid {
  const builder = new PyramidBuilder(channelCount, 4, 2);
  for (let i = 0; i < 37; i += 1) {
    for (let ch = 0; ch < channelCount; ch += 1) builder.push(ch, Float32Array.from([Math.sin(i + ch), -Math.sin(i + ch)]));
  }
  return { trackId, channelCount, sampleRate, levels: builder.finish() };
}

// deserializePyramid requires a fresh, zero-offset ArrayBuffer, matching what File/Blob.arrayBuffer() returns.
function toFreshArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function toPlain(levels: CachedPyramid['levels']) {
  return levels.map((l) => ({ samplesPerBucket: l.samplesPerBucket, bucketCount: l.bucketCount, min: l.min.map((a) => Array.from(a)), max: l.max.map((a) => Array.from(a)) }));
}

describe('serializePyramid / deserializePyramid round-trip', () => {
  it('round-trips a multi-level, multi-channel pyramid exactly', () => {
    const pyramid = buildTestPyramid();
    const bytes = serializePyramid(pyramid, fingerprint);
    const result = deserializePyramid(toFreshArrayBuffer(bytes), pyramid.trackId, fingerprint);
    expect(result.kind).toBe('hit');
    if (result.kind !== 'hit') throw new Error('expected hit');
    expect(result.pyramid.trackId).toBe(pyramid.trackId);
    expect(result.pyramid.channelCount).toBe(pyramid.channelCount);
    expect(result.pyramid.sampleRate).toBe(pyramid.sampleRate);
    expect(toPlain(result.pyramid.levels)).toEqual(toPlain(pyramid.levels));
  });

  it('round-trips a single-channel, single-level (terminal) pyramid', () => {
    const builder = new PyramidBuilder(1, 128, 8);
    builder.push(0, Float32Array.from([0.1, 0.2]));
    const tiny: CachedPyramid = { trackId: 7, channelCount: 1, sampleRate: 44100, levels: builder.finish() };
    const bytes = serializePyramid(tiny, fingerprint);
    const result = deserializePyramid(toFreshArrayBuffer(bytes), 7, fingerprint);
    expect(result.kind).toBe('hit');
    if (result.kind !== 'hit') throw new Error('expected hit');
    expect(result.pyramid.levels).toHaveLength(1);
    expect(toPlain(result.pyramid.levels)).toEqual(toPlain(tiny.levels));
  });

  it('round-trips a pyramid with six independent tracks worth of distinct data (fixtures/27gb.mp4-shaped) without cross-contamination', () => {
    const a = buildTestPyramid(1, 2, 48000);
    const b = buildTestPyramid(2, 1, 48000);
    const bytesA = serializePyramid(a, fingerprint);
    const bytesB = serializePyramid(b, fingerprint);
    const resultA = deserializePyramid(toFreshArrayBuffer(bytesA), 1, fingerprint);
    const resultB = deserializePyramid(toFreshArrayBuffer(bytesB), 2, fingerprint);
    expect(resultA.kind).toBe('hit');
    expect(resultB.kind).toBe('hit');
    if (resultA.kind !== 'hit' || resultB.kind !== 'hit') throw new Error('expected hits');
    expect(resultA.pyramid.channelCount).toBe(2);
    expect(resultB.pyramid.channelCount).toBe(1);
  });

  it('rejects a blob with bad magic', () => {
    const pyramid = buildTestPyramid();
    const bytes = serializePyramid(pyramid, fingerprint);
    const corrupted = toFreshArrayBuffer(bytes.slice());
    new DataView(corrupted).setUint32(0, 0, true);
    const result = deserializePyramid(corrupted, pyramid.trackId, fingerprint);
    expect(result.kind).toBe('corrupt');
  });

  it('rejects a blob written at a different schema version', () => {
    const pyramid = buildTestPyramid();
    const bytes = serializePyramid(pyramid, fingerprint);
    const corrupted = toFreshArrayBuffer(bytes.slice());
    new DataView(corrupted).setUint32(4, 999, true);
    const result = deserializePyramid(corrupted, pyramid.trackId, fingerprint);
    expect(result).toEqual({ kind: 'stale-schema', foundVersion: 999 });
  });

  it('rejects on fingerprint mismatch', () => {
    const pyramid = buildTestPyramid();
    const bytes = serializePyramid(pyramid, fingerprint);
    const otherFingerprint: FileFingerprint = { ...fingerprint, size: fingerprint.size + 1 };
    const result = deserializePyramid(toFreshArrayBuffer(bytes), pyramid.trackId, otherFingerprint);
    expect(result.kind).toBe('fingerprint-mismatch');
  });

  it('rejects when the requested trackId does not match the stored one', () => {
    const pyramid = buildTestPyramid(2);
    const bytes = serializePyramid(pyramid, fingerprint);
    const result = deserializePyramid(toFreshArrayBuffer(bytes), 99, fingerprint);
    expect(result.kind).toBe('fingerprint-mismatch');
  });

  it('rejects a truncated blob (level table cut short)', () => {
    const pyramid = buildTestPyramid();
    const bytes = serializePyramid(pyramid, fingerprint);
    const truncated = toFreshArrayBuffer(bytes.slice(0, 40)); // past the fixed header, into the level table
    const result = deserializePyramid(truncated, pyramid.trackId, fingerprint);
    expect(result.kind).toBe('corrupt');
  });

  it('rejects a truncated blob (level data cut short after a valid header/table)', () => {
    const pyramid = buildTestPyramid();
    const bytes = serializePyramid(pyramid, fingerprint);
    const truncated = toFreshArrayBuffer(bytes.slice(0, bytes.byteLength - 4));
    const result = deserializePyramid(truncated, pyramid.trackId, fingerprint);
    expect(result.kind).toBe('corrupt');
  });

  it('rejects a too-small blob outright', () => {
    const result = deserializePyramid(new ArrayBuffer(4), 1, fingerprint);
    expect(result.kind).toBe('corrupt');
  });
});
