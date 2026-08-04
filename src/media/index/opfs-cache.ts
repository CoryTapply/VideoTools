// OPFS index cache. Binary layout, versioned:
//
//   [magic: 4 bytes "MID1"]
//   [schemaVersion: u32]
//   [fingerprint: size f64, lastModified f64, headHash u32, tailHash u32]  (24 bytes)
//   [metadataJsonLength: u32][metadataJson: utf8 bytes]
//   [padding to the next 8-byte boundary]
//   [per-track sample-array sections, back to back, each individually padded to end on an
//    8-byte boundary -- see buildTrackSection's doc comment for why]
//
// Everything EXCEPT the big per-sample typed arrays (pts/dts/offset/size/isSync) goes through
// metadataJson -- those fields are small and constant-size per track, so JSON's overhead there is
// negligible next to the megabyte-scale arrays, and it avoids hand-packing variable-length
// strings (codec, handlerName, language) into a fixed binary layout. This is a deliberate
// deviation from the spike's pure-binary opfs-persist.ts, justified by that cost tradeoff.
//
// SCHEMA_VERSION is a data-integrity control, not housekeeping: bump it on ANY change to what a
// TrackIndex contains or how it's serialized. A stale cache that LOOKS valid but disagrees with
// the current parser feeds wrong byte offsets into an export that then produces a file that
// plays but is subtly wrong -- a bug with a very long fuse. This module refuses to deserialize a
// blob written at a different SCHEMA_VERSION rather than guess.

import type { EditListEntry } from './moov/edit-list';
import type { AudioTrackMeta, TrackIndex, VideoTrackMeta } from './track-index';
import { fingerprintsEqual, type FileFingerprint } from './fingerprint';

export const SCHEMA_VERSION = 1;

const MAGIC = 0x4d494431; // "MID1"

interface TrackMetadata {
  trackId: number;
  kind: 'video' | 'audio' | 'other';
  handlerType: string;
  codec: string;
  timescale: number;
  duration: number;
  sampleCount: number;
  editOffsetTicks: number;
  editList?: EditListEntry[];
  video?: VideoTrackMeta;
  audio?: AudioTrackMeta;
  descriptionBase64: string;
  /** Byte offset of this track's sample-array section, relative to the start of that region. */
  sectionOffset: number;
}

interface CacheMetadata {
  mvhdTimescale: number;
  mvhdDuration: number;
  tracks: TrackMetadata[];
}

export interface CachedIndex {
  readonly mvhdTimescale: number;
  readonly mvhdDuration: number;
  readonly tracks: TrackIndex[];
}

export type CacheReadResult =
  | { kind: 'hit'; index: CachedIndex }
  | { kind: 'miss' }
  | { kind: 'corrupt'; detail: string }
  | { kind: 'stale-schema'; foundVersion: number }
  | { kind: 'fingerprint-mismatch' };

export type CacheWriteResult = { kind: 'ok'; bytesWritten: number } | { kind: 'quota-exceeded' };

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function alignUp8(n: number): number {
  return (n + 7) & ~7;
}

/**
 * One track's sample arrays back to back: pts, dts, offset (all Float64Array, so each of these
 * three sub-sections starts 8-byte aligned automatically -- 8 bytes/element x sampleCount is
 * always a multiple of 8), then size (Uint32Array, still safely 4-byte aligned since it follows
 * a multiple of 8), then isSync (Uint8Array, no alignment constraint). The section's total length
 * is then padded to the next 8-byte boundary so the FOLLOWING track's pts array also starts
 * 8-byte aligned -- required because a TypedArray view throws if its byteOffset isn't a multiple
 * of its own BYTES_PER_ELEMENT.
 */
function buildTrackSection(track: TrackIndex): Uint8Array {
  const n = track.sampleCount;
  const unpadded = n * 8 * 3 + n * 4 + n * 1;
  const out = new Uint8Array(alignUp8(unpadded));
  const view = new DataView(out.buffer);
  let o = 0;
  for (let i = 0; i < n; i += 1, o += 8) view.setFloat64(o, track.pts[i], true);
  for (let i = 0; i < n; i += 1, o += 8) view.setFloat64(o, track.dts[i], true);
  for (let i = 0; i < n; i += 1, o += 8) view.setFloat64(o, track.offset[i], true);
  for (let i = 0; i < n; i += 1, o += 4) view.setUint32(o, track.size[i], true);
  for (let i = 0; i < n; i += 1, o += 1) view.setUint8(o, track.isSync[i]);
  return out;
}

function readTrackArrays(buf: ArrayBuffer, sectionOffset: number, sampleCount: number): Pick<TrackIndex, 'pts' | 'dts' | 'offset' | 'size' | 'isSync'> {
  const n = sampleCount;
  let o = sectionOffset;
  const pts = new Float64Array(buf, o, n);
  o += n * 8;
  const dts = new Float64Array(buf, o, n);
  o += n * 8;
  const offset = new Float64Array(buf, o, n);
  o += n * 8;
  const size = new Uint32Array(buf, o, n);
  o += n * 4;
  const isSync = new Uint8Array(buf, o, n);
  return { pts, dts, offset, size, isSync };
}

export function serializeIndex(index: CachedIndex, fingerprint: FileFingerprint): Uint8Array {
  const trackSections = index.tracks.map(buildTrackSection);
  let sectionOffset = 0;
  const trackMetas: TrackMetadata[] = index.tracks.map((track, i) => {
    const meta: TrackMetadata = {
      trackId: track.trackId,
      kind: track.kind,
      handlerType: track.handlerType,
      codec: track.codec,
      timescale: track.timescale,
      duration: track.duration,
      sampleCount: track.sampleCount,
      editOffsetTicks: track.editOffsetTicks,
      editList: track.editList,
      video: track.video,
      audio: track.audio,
      descriptionBase64: bytesToBase64(track.description),
      sectionOffset,
    };
    sectionOffset += trackSections[i].byteLength;
    return meta;
  });

  const metadata: CacheMetadata = { mvhdTimescale: index.mvhdTimescale, mvhdDuration: index.mvhdDuration, tracks: trackMetas };
  const metadataJson = new TextEncoder().encode(JSON.stringify(metadata));

  const headerSize = 4 + 4 + 24 + 4; // magic, schemaVersion, fingerprint, metadataJsonLength
  const beforePadding = headerSize + metadataJson.byteLength;
  const arraysStart = alignUp8(beforePadding);
  const totalSize = arraysStart + sectionOffset;

  const out = new Uint8Array(totalSize);
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
  view.setUint32(o, metadataJson.byteLength, true);
  o += 4;
  out.set(metadataJson, o);

  let arrayOffset = arraysStart;
  for (const section of trackSections) {
    out.set(section, arrayOffset);
    arrayOffset += section.byteLength;
  }

  return out;
}

/** `buf` must be a fresh, zero-offset ArrayBuffer (e.g. from a File/Blob's own .arrayBuffer()) so the alignment math in buildTrackSection holds. */
export function deserializeIndex(buf: ArrayBuffer, expectedFingerprint: FileFingerprint): CacheReadResult {
  if (buf.byteLength < 12) return { kind: 'corrupt', detail: `blob too small (${String(buf.byteLength)} bytes)` };
  const view = new DataView(buf);
  let o = 0;
  const magic = view.getUint32(o, true);
  o += 4;
  if (magic !== MAGIC) return { kind: 'corrupt', detail: `bad magic 0x${magic.toString(16)}` };

  const schemaVersion = view.getUint32(o, true);
  o += 4;
  if (schemaVersion !== SCHEMA_VERSION) return { kind: 'stale-schema', foundVersion: schemaVersion };

  if (buf.byteLength < o + 24 + 4) return { kind: 'corrupt', detail: 'truncated header' };
  const fingerprint: FileFingerprint = {
    size: view.getFloat64(o, true),
    lastModified: view.getFloat64(o + 8, true),
    headHash: view.getUint32(o + 16, true),
    tailHash: view.getUint32(o + 20, true),
  };
  o += 24;

  if (!fingerprintsEqual(fingerprint, expectedFingerprint)) return { kind: 'fingerprint-mismatch' };

  const metadataJsonLength = view.getUint32(o, true);
  o += 4;
  if (buf.byteLength < o + metadataJsonLength) return { kind: 'corrupt', detail: 'truncated metadata JSON' };

  let metadata: CacheMetadata;
  try {
    const metadataBytes = new Uint8Array(buf, o, metadataJsonLength);
    metadata = JSON.parse(new TextDecoder().decode(metadataBytes)) as CacheMetadata;
  } catch (err) {
    return { kind: 'corrupt', detail: `metadata JSON parse failure: ${err instanceof Error ? err.message : String(err)}` };
  }
  o += metadataJsonLength;

  const arraysStart = alignUp8(o);
  try {
    const tracks: TrackIndex[] = metadata.tracks.map((meta) => {
      const arrays =
        meta.sampleCount > 0
          ? readTrackArrays(buf, arraysStart + meta.sectionOffset, meta.sampleCount)
          : { pts: new Float64Array(0), dts: new Float64Array(0), offset: new Float64Array(0), size: new Uint32Array(0), isSync: new Uint8Array(0) };
      return {
        trackId: meta.trackId,
        kind: meta.kind,
        handlerType: meta.handlerType,
        codec: meta.codec,
        timescale: meta.timescale,
        duration: meta.duration,
        sampleCount: meta.sampleCount,
        ...arrays,
        description: base64ToBytes(meta.descriptionBase64),
        video: meta.video,
        audio: meta.audio,
        editOffsetTicks: meta.editOffsetTicks,
        editList: meta.editList,
      };
    });
    return { kind: 'hit', index: { mvhdTimescale: metadata.mvhdTimescale, mvhdDuration: metadata.mvhdDuration, tracks } };
  } catch (err) {
    return { kind: 'corrupt', detail: `array section read failure: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const OPFS_DIR = 'media-index-cache';

function cacheFileName(cacheKey: string): string {
  // cacheKey is caller-supplied (typically derived from the fingerprint itself); sanitize to a
  // safe filename rather than trusting it directly.
  return `${cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.bin`;
}

export async function readIndexCache(cacheKey: string, expectedFingerprint: FileFingerprint): Promise<CacheReadResult> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create: false }).catch(() => undefined);
    if (!dir) return { kind: 'miss' };
    const fileHandle = await dir.getFileHandle(cacheFileName(cacheKey), { create: false }).catch(() => undefined);
    if (!fileHandle) return { kind: 'miss' };
    const file = await fileHandle.getFile();
    const buf = await file.arrayBuffer();
    return deserializeIndex(buf, expectedFingerprint);
  } catch (err) {
    return { kind: 'corrupt', detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function writeIndexCache(cacheKey: string, index: CachedIndex, fingerprint: FileFingerprint): Promise<CacheWriteResult> {
  const bytes = serializeIndex(index, fingerprint);
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
    const fileHandle = await dir.getFileHandle(cacheFileName(cacheKey), { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(bytes as Uint8Array<ArrayBuffer>);
    await writable.close();
    return { kind: 'ok', bytesWritten: bytes.byteLength };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') return { kind: 'quota-exceeded' };
    throw err;
  }
}
