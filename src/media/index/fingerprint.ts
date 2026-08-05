// Cache key material: enough to detect "this is a different file" cheaply, never enough to
// require reading the whole (possibly 27GB) file. size + lastModified alone can't catch a file
// replaced-in-place with the same size and mtime (rare, but real on some sync tools), so a fast
// non-cryptographic hash of the first and last 1MB is added -- and ONLY those two windows, never
// the whole file.

import type { ByteSource } from './byte-source';

const HASH_WINDOW_BYTES = 1024 * 1024;

export interface FileFingerprint {
  readonly size: number;
  readonly lastModified: number;
  readonly headHash: number;
  readonly tailHash: number;
}

/** FNV-1a, 32-bit. Fast and dependency-free; not a security primitive, just a change detector. */
function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export async function computeFingerprint(source: ByteSource, lastModified: number): Promise<FileFingerprint> {
  const size = source.size;
  const headLength = Math.min(HASH_WINDOW_BYTES, size);
  const tailLength = Math.min(HASH_WINDOW_BYTES, size);
  const head = await source.read(0, headLength);
  const tail = await source.read(Math.max(0, size - tailLength), tailLength);
  return { size, lastModified, headHash: fnv1a(head), tailHash: fnv1a(tail) };
}

export function fingerprintsEqual(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.size === b.size && a.lastModified === b.lastModified && a.headHash === b.headHash && a.tailHash === b.tailHash;
}
