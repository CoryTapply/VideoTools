// OPFS storage for packed atlases. Reuses src/media/index/fingerprint.ts's FileFingerprint
// directly (per the task prompt: "the same file fingerprint the index cache uses") rather than
// reimplementing it.
//
// Unlike src/media/index/opfs-cache.ts, which embeds the fingerprint INSIDE a self-describing
// binary blob and compares on read (needed there because a stale-but-structurally-valid index
// blob is a subtle, long-fuse correctness bug -- wrong byte offsets feeding an export), an atlas
// is an opaque WebP image with nothing meaningful to embed a header into. Folding the fingerprint,
// schema version, tier, and tile dimensions directly into the cache KEY is simpler and just as
// safe here: any of those changing produces a different key, which is a plain cache miss (a
// slower first load), never a wrong-but-plausible atlas silently served.

import type { FileFingerprint } from '../index/fingerprint';

/** Bump on any change to packing (grid size, encode quality) or the pixel format a caller assumes -- a change to thumbnail dimensions alone is already covered by tileWidth/tileHeight in the key. */
export const ATLAS_SCHEMA_VERSION = 1;

export type AtlasTier = 'coarse' | 'dense';

export interface AtlasCacheKeyInput {
  readonly fingerprint: FileFingerprint;
  readonly tier: AtlasTier;
  readonly atlasId: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
}

export function atlasCacheKey(input: AtlasCacheKeyInput): string {
  const fp = input.fingerprint;
  return `${String(fp.size)}-${String(fp.lastModified)}-${String(fp.headHash)}-${String(fp.tailHash)}-v${String(ATLAS_SCHEMA_VERSION)}-${input.tier}-${String(input.tileWidth)}x${String(input.tileHeight)}-${String(input.atlasId)}`;
}

export type AtlasReadResult = { kind: 'hit'; blob: Blob } | { kind: 'miss' } | { kind: 'corrupt'; detail: string };
export type AtlasWriteResult = { kind: 'ok'; bytesWritten: number } | { kind: 'quota-exceeded' };

const OPFS_DIR = 'frame-cache-atlases';

function fileNameFor(cacheKey: string): string {
  return `${cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.webp`;
}

export async function readAtlas(cacheKey: string): Promise<AtlasReadResult> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create: false }).catch(() => undefined);
    if (!dir) return { kind: 'miss' };
    const fileHandle = await dir.getFileHandle(fileNameFor(cacheKey), { create: false }).catch(() => undefined);
    if (!fileHandle) return { kind: 'miss' };
    const file = await fileHandle.getFile();
    if (file.size === 0) return { kind: 'corrupt', detail: 'zero-byte atlas file' };
    return { kind: 'hit', blob: file };
  } catch (err) {
    return { kind: 'corrupt', detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Never throws for a quota failure -- degrades to `{ kind: 'quota-exceeded' }` so a caller can fall back to memory-only atlases instead of the whole warm pass failing. */
export async function writeAtlas(cacheKey: string, blob: Blob): Promise<AtlasWriteResult> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
    const fileHandle = await dir.getFileHandle(fileNameFor(cacheKey), { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return { kind: 'ok', bytesWritten: blob.size };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') return { kind: 'quota-exceeded' };
    throw err;
  }
}
