// Spike B / Step 6 -- persist the index to OPFS as raw typed-array bytes, then read it back,
// compared against the cost of rebuilding from the file. See prompts/m0.5-spike-prompts.md
// Step 6. This determines whether index caching is worth building in M1.
//
// Byte layout: [header: sampleCount as Uint32, padded to 8 bytes][dts][cts][offset][size][sync].
// The three Float64Arrays (dts/cts/offset, 8 bytes/element) are grouped FIRST and right after an
// 8-byte header so every one of them starts at an offset that's a multiple of 8 -- required,
// since a TypedArray view throws if its byteOffset isn't a multiple of its BYTES_PER_ELEMENT.
// size (Uint32Array, 4-byte elements) and sync (Uint8Array, 1-byte elements) come last because
// their alignment requirements are looser and are automatically satisfied by this ordering
// regardless of whether sampleCount is odd or even (a real risk that was worth designing
// around rather than special-casing at read time).

import type { TrackIndex } from '../A-remux/mp4-index';

function toBytes(view: Float64Array | Uint32Array | Uint8Array): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

export function serializeTrack(track: TrackIndex): Uint8Array {
  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, track.sampleCount, true);

  const parts = [header, toBytes(track.dts), toBytes(track.cts), toBytes(track.offset), toBytes(track.size), toBytes(track.sync)];
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

export interface RestoredTrackArrays {
  sampleCount: number;
  dts: Float64Array;
  cts: Float64Array;
  offset: Float64Array;
  size: Uint32Array;
  sync: Uint8Array;
}

/** `buf` must be a fresh, zero-offset ArrayBuffer (as returned by e.g. Blob.arrayBuffer()) so the alignment math in serializeTrack's layout holds. */
export function deserializeTrack(buf: ArrayBuffer): RestoredTrackArrays {
  const sampleCount = new DataView(buf).getUint32(0, true);
  let o = 8;
  const dts = new Float64Array(buf, o, sampleCount);
  o += sampleCount * 8;
  const cts = new Float64Array(buf, o, sampleCount);
  o += sampleCount * 8;
  const offset = new Float64Array(buf, o, sampleCount);
  o += sampleCount * 8;
  const size = new Uint32Array(buf, o, sampleCount);
  o += sampleCount * 4;
  const sync = new Uint8Array(buf, o, sampleCount);
  return { sampleCount, dts, cts, offset, size, sync };
}

export function arraysEqual(a: { [i: number]: number; length: number }, b: { [i: number]: number; length: number }): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

const OPFS_FILENAME = 'spike-b-index-cache.bin';

export interface OpfsPersistResult {
  writeMs: number;
  readMs: number;
  bytesWritten: number;
  roundTripCorrect: boolean;
}

export async function persistAndReload(track: TrackIndex): Promise<OpfsPersistResult> {
  const bytes = serializeTrack(track);

  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle(OPFS_FILENAME, { create: true });

  const t0 = performance.now();
  const writable = await fileHandle.createWritable();
  // bytes is always backed by a plain (never shared) ArrayBuffer; TS's generic
  // ArrayBufferView<T> can't express that statically here.
  await writable.write(bytes as Uint8Array<ArrayBuffer>);
  await writable.close();
  const writeMs = performance.now() - t0;

  const t1 = performance.now();
  const file = await fileHandle.getFile();
  const buf = await file.arrayBuffer();
  const readMs = performance.now() - t1;

  const restored = deserializeTrack(buf);
  const roundTripCorrect =
    restored.sampleCount === track.sampleCount &&
    arraysEqual(restored.dts, track.dts) &&
    arraysEqual(restored.cts, track.cts) &&
    arraysEqual(restored.offset, track.offset) &&
    arraysEqual(restored.size, track.size) &&
    arraysEqual(restored.sync, track.sync);

  return { writeMs, readMs, bytesWritten: bytes.byteLength, roundTripCorrect };
}
