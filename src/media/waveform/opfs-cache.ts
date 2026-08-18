// OPFS peak-pyramid cache. Self-describing versioned binary blob, following
// src/media/index/opfs-cache.ts's convention (embed the fingerprint INSIDE the blob and compare
// on read) rather than src/media/frames/atlas-cache.ts's key-only-folding model: this data needs
// more parameters than an atlas's `tier + dims` (fingerprint, trackId, channelCount, sampleRate,
// a *variable-length* level table), and a truncated/corrupt raw Int16Array region doesn't
// self-detect the way a broken WebP blob does inside its own decoder -- a header with explicit
// bounds is what makes deserializePyramid() able to refuse a bad blob instead of silently reading
// garbage past the end. Unlike opfs-cache.ts, no JSON metadata layer: that existed there for
// variable-length strings (codec, handlerName, language) this format doesn't have -- every field
// here is a fixed-size number, so a plain packed binary header is simpler.
//
//   [magic: 4 bytes "WFP1"]
//   [schemaVersion: u32]
//   [fingerprint: size f64, lastModified f64, headHash u32, tailHash u32]  (24 bytes)
//   [trackId: u32][channelCount: u32][sampleRate: u32]
//   [levelCount: u32][level table: levelCount x {samplesPerBucket: u32, bucketCount: u32}]
//   [padding to the next 8-byte boundary]
//   [per level, per channel, back to back: Int16Array min[bucketCount], Int16Array max[bucketCount]]
//
// SCHEMA_VERSION: bump on any change to the pyramid layout above, the level-0/ratio convention, or
// the quantization scheme (pyramid.ts). Lower stakes than the index cache's schema version (a
// stale peak pyramid is a cosmetic regression, not silent export corruption), but the same
// "refuse rather than guess" discipline still applies for consistency.

import { fingerprintsEqual, type FileFingerprint } from '../index/fingerprint';
import type { PyramidLevel } from './pyramid';

export const SCHEMA_VERSION = 1;
const MAGIC = 0x57465031; // "WFP1"

export interface CachedPyramid {
  readonly trackId: number;
  readonly channelCount: number;
  readonly sampleRate: number;
  readonly levels: readonly PyramidLevel[];
}

export type PyramidCacheReadResult =
  | { kind: 'hit'; pyramid: CachedPyramid }
  | { kind: 'miss' }
  | { kind: 'corrupt'; detail: string }
  | { kind: 'stale-schema'; foundVersion: number }
  | { kind: 'fingerprint-mismatch' };

export type PyramidCacheWriteResult = { kind: 'ok'; bytesWritten: number } | { kind: 'quota-exceeded' };

function alignUp8(n: number): number {
  return (n + 7) & ~7;
}

const HEADER_SIZE = 4 + 4 + 24 + 4 + 4 + 4 + 4; // magic, schemaVersion, fingerprint, trackId, channelCount, sampleRate, levelCount
const LEVEL_TABLE_ENTRY_SIZE = 8; // samplesPerBucket u32, bucketCount u32

export function serializePyramid(pyramid: CachedPyramid, fingerprint: FileFingerprint): Uint8Array {
  const levelCount = pyramid.levels.length;
  const dataStart = alignUp8(HEADER_SIZE + levelCount * LEVEL_TABLE_ENTRY_SIZE);

  let dataSize = 0;
  for (const level of pyramid.levels) dataSize += level.bucketCount * pyramid.channelCount * 2 * 2; // min + max, 2 bytes/Int16 each

  const out = new Uint8Array(dataStart + dataSize);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint32(o, MAGIC, true);
  o += 4;
  view.setUint32(o, SCHEMA_VERSION, true);
  o += 4;
  view.setFloat64(o, fingerprint.size, true);
  o += 8;
  view.setFloat64(o, fingerprint.lastModified, true);
  o += 8;
  view.setUint32(o, fingerprint.headHash, true);
  o += 4;
  view.setUint32(o, fingerprint.tailHash, true);
  o += 4;
  view.setUint32(o, pyramid.trackId, true);
  o += 4;
  view.setUint32(o, pyramid.channelCount, true);
  o += 4;
  view.setUint32(o, pyramid.sampleRate, true);
  o += 4;
  view.setUint32(o, levelCount, true);
  o += 4;
  for (const level of pyramid.levels) {
    view.setUint32(o, level.samplesPerBucket, true);
    o += 4;
    view.setUint32(o, level.bucketCount, true);
    o += 4;
  }

  let dataOffset = dataStart;
  for (const level of pyramid.levels) {
    for (let ch = 0; ch < pyramid.channelCount; ch += 1) {
      for (let i = 0; i < level.bucketCount; i += 1, dataOffset += 2) view.setInt16(dataOffset, level.min[ch][i], true);
      for (let i = 0; i < level.bucketCount; i += 1, dataOffset += 2) view.setInt16(dataOffset, level.max[ch][i], true);
    }
  }

  return out;
}

/** `buf` must be a fresh, zero-offset ArrayBuffer (e.g. from a File/Blob's own .arrayBuffer()) so the Int16Array views below land on real element boundaries -- same requirement as src/media/index/opfs-cache.ts's deserializeIndex(). */
export function deserializePyramid(buf: ArrayBuffer, expectedTrackId: number, expectedFingerprint: FileFingerprint): PyramidCacheReadResult {
  if (buf.byteLength < 8) return { kind: 'corrupt', detail: `blob too small (${String(buf.byteLength)} bytes)` };
  const view = new DataView(buf);
  let o = 0;
  const magic = view.getUint32(o, true);
  o += 4;
  if (magic !== MAGIC) return { kind: 'corrupt', detail: `bad magic 0x${magic.toString(16)}` };

  const schemaVersion = view.getUint32(o, true);
  o += 4;
  if (schemaVersion !== SCHEMA_VERSION) return { kind: 'stale-schema', foundVersion: schemaVersion };

  if (buf.byteLength < HEADER_SIZE) return { kind: 'corrupt', detail: 'truncated header' };
  const fingerprint: FileFingerprint = {
    size: view.getFloat64(o, true),
    lastModified: view.getFloat64(o + 8, true),
    headHash: view.getUint32(o + 16, true),
    tailHash: view.getUint32(o + 20, true),
  };
  o += 24;
  if (!fingerprintsEqual(fingerprint, expectedFingerprint)) return { kind: 'fingerprint-mismatch' };

  const trackId = view.getUint32(o, true);
  o += 4;
  if (trackId !== expectedTrackId) return { kind: 'fingerprint-mismatch' }; // a same-fingerprint file with a different track id requested -- treat like a miss-shaped mismatch, forces a rebuild for this track
  const channelCount = view.getUint32(o, true);
  o += 4;
  const sampleRate = view.getUint32(o, true);
  o += 4;
  const levelCount = view.getUint32(o, true);
  o += 4;

  if (buf.byteLength < o + levelCount * LEVEL_TABLE_ENTRY_SIZE) return { kind: 'corrupt', detail: 'truncated level table' };
  const levelSpecs: { samplesPerBucket: number; bucketCount: number }[] = [];
  for (let i = 0; i < levelCount; i += 1) {
    const samplesPerBucket = view.getUint32(o, true);
    o += 4;
    const bucketCount = view.getUint32(o, true);
    o += 4;
    levelSpecs.push({ samplesPerBucket, bucketCount });
  }

  try {
    let offset = alignUp8(o);
    const levels: PyramidLevel[] = levelSpecs.map((spec) => {
      const min: Int16Array[] = [];
      const max: Int16Array[] = [];
      for (let ch = 0; ch < channelCount; ch += 1) {
        const arrayBytes = spec.bucketCount * 2;
        if (offset + arrayBytes > buf.byteLength) throw new Error('truncated level data (min)');
        min.push(new Int16Array(buf, offset, spec.bucketCount));
        offset += arrayBytes;
        if (offset + arrayBytes > buf.byteLength) throw new Error('truncated level data (max)');
        max.push(new Int16Array(buf, offset, spec.bucketCount));
        offset += arrayBytes;
      }
      return { samplesPerBucket: spec.samplesPerBucket, bucketCount: spec.bucketCount, min, max };
    });
    return { kind: 'hit', pyramid: { trackId, channelCount, sampleRate, levels } };
  } catch (err) {
    return { kind: 'corrupt', detail: `level data read failure: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const OPFS_DIR = 'waveform-peak-cache';

function cacheFileName(fingerprint: FileFingerprint, trackId: number): string {
  const key = `${String(fingerprint.size)}-${String(fingerprint.lastModified)}-${String(fingerprint.headHash)}-${String(fingerprint.tailHash)}-audio${String(trackId)}`;
  return `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.wfp`;
}

export async function readPyramidCache(fingerprint: FileFingerprint, trackId: number): Promise<PyramidCacheReadResult> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create: false }).catch(() => undefined);
    if (!dir) return { kind: 'miss' };
    const fileHandle = await dir.getFileHandle(cacheFileName(fingerprint, trackId), { create: false }).catch(() => undefined);
    if (!fileHandle) return { kind: 'miss' };
    const file = await fileHandle.getFile();
    const buf = await file.arrayBuffer();
    return deserializePyramid(buf, trackId, fingerprint);
  } catch (err) {
    return { kind: 'corrupt', detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Never throws for a quota failure -- degrades to `{ kind: 'quota-exceeded' }` so a caller can keep the in-memory pyramid usable for the session instead of failing the whole build, same pattern as src/media/index/opfs-cache.ts and src/media/frames/atlas-cache.ts. */
export async function writePyramidCache(pyramid: CachedPyramid, fingerprint: FileFingerprint): Promise<PyramidCacheWriteResult> {
  const bytes = serializePyramid(pyramid, fingerprint);
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
    const fileHandle = await dir.getFileHandle(cacheFileName(fingerprint, pyramid.trackId), { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(bytes as Uint8Array<ArrayBuffer>);
    await writable.close();
    return { kind: 'ok', bytesWritten: bytes.byteLength };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') return { kind: 'quota-exceeded' };
    throw err;
  }
}
