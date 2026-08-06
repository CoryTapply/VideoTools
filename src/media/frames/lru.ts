// Byte-budgeted LRU over live decoded bitmaps (Part 6). The only rule that matters here:
// eviction ALWAYS calls close() -- this is exactly the kind of long-lived, deliberately-retained
// closable that frame-lifecycle.ts's registry exists to audit (short-lived decode-site frames go
// through withFrame/withFrameAsync instead; this is the other half of "same close() discipline
// for ImageBitmap").
//
// Budget: ~96MB total (see src/media/frames/README.md for the full justification) -- covers the
// entire coarse tier resident at all times (~58MB for 1,015 entries at 160x90 RGBA) plus headroom
// for a realistic dense window, comfortably under the ~190MB "everything resident" worst case.

import type { Closable } from './frame-lifecycle';
import type { FrameLifecycleRegistry } from './frame-lifecycle';

/** RGBA byte estimate for one tile -- the unit this module's budget is denominated in. */
export function estimateRgbaBytes(width: number, height: number): number {
  return width * height * 4;
}

interface Entry<B extends Closable> {
  readonly bitmap: B;
  readonly byteSize: number;
}

export interface FrameLru<K, B extends Closable> {
  readonly totalBytes: number;
  readonly count: number;
  readonly budgetBytes: number;
  has(key: K): boolean;
  /** Marks `key` as most-recently-used. Returns undefined on a miss (does not count as a touch). */
  get(key: K): B | undefined;
  /** Inserts or replaces `key`. If `key` was already present, the OLD bitmap is closed. May evict other entries (oldest-first) to stay within budget; never evicts the entry just inserted, even if its own byteSize alone exceeds the budget. */
  set(key: K, bitmap: B, byteSize: number): void;
  /** Closes and removes `key` if present. Returns whether anything was removed. */
  delete(key: K): boolean;
  /** Closes everything and empties the cache. */
  clear(): void;
}

/**
 * Called whenever a bitmap is closed by the cache itself -- eviction, an overwritten key, an
 * explicit delete(), or clear(). A caller that keeps its OWN lookup structure pointing at these
 * bitmaps (FrameCache's coarse/dense slot arrays) MUST use this to null out that slot; otherwise
 * a lookup can hand back a CachedFrame wrapping an already-closed bitmap.
 */
export type FrameLruRemovalListener<K, B> = (key: K, bitmap: B) => void;

export function createFrameLru<K, B extends Closable>(budgetBytes: number, registry?: FrameLifecycleRegistry, onRemove?: FrameLruRemovalListener<K, B>): FrameLru<K, B> {
  if (budgetBytes <= 0) throw new Error(`createFrameLru: budgetBytes must be positive, got ${String(budgetBytes)}`);

  // Map iteration order is insertion order; re-inserting a key on touch moves it to the end,
  // which is exactly "most recently used" without a separate linked-list structure.
  const entries = new Map<K, Entry<B>>();
  let totalBytes = 0;

  function evictOne(): void {
    const oldestKey = entries.keys().next();
    if (oldestKey.done) return;
    const entry = entries.get(oldestKey.value);
    entries.delete(oldestKey.value);
    if (entry) {
      totalBytes -= entry.byteSize;
      entry.bitmap.close();
      registry?.untrack(entry.bitmap);
      onRemove?.(oldestKey.value, entry.bitmap);
    }
  }

  function evictUntilWithinBudget(protectedKey: K): void {
    while (totalBytes > budgetBytes && entries.size > 1) {
      const oldestKey = entries.keys().next();
      if (oldestKey.done || oldestKey.value === protectedKey) break; // only entry left is the one just inserted -- allow going over budget rather than evict what was just asked for
      evictOne();
    }
  }

  return {
    get totalBytes() {
      return totalBytes;
    },
    get count() {
      return entries.size;
    },
    budgetBytes,

    has(key) {
      return entries.has(key);
    },

    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry); // move to most-recently-used position
      return entry.bitmap;
    },

    set(key, bitmap, byteSize) {
      const existing = entries.get(key);
      if (existing) {
        totalBytes -= existing.byteSize;
        existing.bitmap.close();
        registry?.untrack(existing.bitmap);
        onRemove?.(key, existing.bitmap);
        entries.delete(key);
      }
      entries.set(key, { bitmap, byteSize });
      totalBytes += byteSize;
      registry?.track(bitmap, `lru:${String(key)}`);
      evictUntilWithinBudget(key);
    },

    delete(key) {
      const entry = entries.get(key);
      if (!entry) return false;
      entries.delete(key);
      totalBytes -= entry.byteSize;
      entry.bitmap.close();
      registry?.untrack(entry.bitmap);
      onRemove?.(key, entry.bitmap);
      return true;
    },

    clear() {
      for (const [key, entry] of entries) {
        entry.bitmap.close();
        registry?.untrack(entry.bitmap);
        onRemove?.(key, entry.bitmap);
      }
      entries.clear();
      totalBytes = 0;
    },
  };
}
