import { describe, expect, it } from 'vitest';
import { createFrameLifecycleRegistry } from './frame-lifecycle';
import { createFrameLru, estimateRgbaBytes } from './lru';
import type { Closable } from './frame-lifecycle';

class FakeBitmap implements Closable {
  closed = false;
  close(): void {
    if (this.closed) throw new Error('double close()');
    this.closed = true;
  }
}

describe('estimateRgbaBytes', () => {
  it('matches the README-quoted coarse-tier arithmetic (160x90 * 4 bytes)', () => {
    expect(estimateRgbaBytes(160, 90)).toBe(160 * 90 * 4);
  });
});

describe('createFrameLru', () => {
  it('rejects a non-positive budget', () => {
    expect(() => createFrameLru<string, FakeBitmap>(0)).toThrow(/positive/);
  });

  it('set() then get() returns the same bitmap and does not evict under budget', () => {
    const lru = createFrameLru<number, FakeBitmap>(1_000_000);
    const bitmap = new FakeBitmap();
    lru.set(1, bitmap, 100);
    expect(lru.get(1)).toBe(bitmap);
    expect(lru.count).toBe(1);
    expect(lru.totalBytes).toBe(100);
  });

  it('get() on a missing key returns undefined and does not throw', () => {
    const lru = createFrameLru<number, FakeBitmap>(1_000_000);
    expect(lru.get(999)).toBeUndefined();
  });

  it('evicts the least-recently-used entry (by insertion order) once the budget is exceeded', () => {
    const lru = createFrameLru<number, FakeBitmap>(250); // room for ~2.5 entries of size 100
    const a = new FakeBitmap();
    const b = new FakeBitmap();
    const c = new FakeBitmap();
    lru.set(1, a, 100);
    lru.set(2, b, 100);
    lru.set(3, c, 100); // pushes total to 300 > 250 -- entry 1 (oldest) evicted

    expect(a.closed).toBe(true);
    expect(lru.has(1)).toBe(false);
    expect(b.closed).toBe(false);
    expect(c.closed).toBe(false);
    expect(lru.totalBytes).toBe(200);
  });

  it('get() promotes an entry to most-recently-used, protecting it from the next eviction', () => {
    const lru = createFrameLru<number, FakeBitmap>(250);
    const a = new FakeBitmap();
    const b = new FakeBitmap();
    const c = new FakeBitmap();
    lru.set(1, a, 100);
    lru.set(2, b, 100);
    lru.get(1); // touch 1 -- now 2 is the oldest
    lru.set(3, c, 100); // should evict 2, not 1

    expect(a.closed).toBe(false);
    expect(b.closed).toBe(true);
    expect(lru.has(1)).toBe(true);
    expect(lru.has(2)).toBe(false);
  });

  it('never evicts the entry just inserted, even if it alone exceeds the budget', () => {
    const lru = createFrameLru<number, FakeBitmap>(50);
    const huge = new FakeBitmap();
    lru.set(1, huge, 1_000_000);
    expect(huge.closed).toBe(false);
    expect(lru.has(1)).toBe(true);
    expect(lru.totalBytes).toBe(1_000_000); // over budget, but the single resident entry is preserved
  });

  it('replacing an existing key closes the old bitmap and accounts bytes correctly', () => {
    const lru = createFrameLru<number, FakeBitmap>(1_000_000);
    const oldBitmap = new FakeBitmap();
    const newBitmap = new FakeBitmap();
    lru.set(1, oldBitmap, 100);
    lru.set(1, newBitmap, 200);

    expect(oldBitmap.closed).toBe(true);
    expect(newBitmap.closed).toBe(false);
    expect(lru.count).toBe(1);
    expect(lru.totalBytes).toBe(200);
  });

  it('delete() closes and removes an entry, returning whether it existed', () => {
    const lru = createFrameLru<number, FakeBitmap>(1_000_000);
    const bitmap = new FakeBitmap();
    lru.set(1, bitmap, 100);
    expect(lru.delete(1)).toBe(true);
    expect(bitmap.closed).toBe(true);
    expect(lru.totalBytes).toBe(0);
    expect(lru.delete(1)).toBe(false);
  });

  it('clear() closes every entry and resets accounting -- the leak check this module exists for', () => {
    const lru = createFrameLru<number, FakeBitmap>(1_000_000);
    const bitmaps = Array.from({ length: 20 }, (_, i) => {
      const b = new FakeBitmap();
      lru.set(i, b, 100);
      return b;
    });
    lru.clear();
    expect(bitmaps.every((b) => b.closed)).toBe(true);
    expect(lru.count).toBe(0);
    expect(lru.totalBytes).toBe(0);
  });

  it('20 warm/clear cycles leave totalBytes and count at 0 every time (Part 9\'s leak check, in miniature)', () => {
    const lru = createFrameLru<number, FakeBitmap>(1_000_000);
    for (let cycle = 0; cycle < 20; cycle += 1) {
      for (let i = 0; i < 50; i += 1) lru.set(i, new FakeBitmap(), 1000);
      expect(lru.count).toBe(50);
      lru.clear();
      expect(lru.count).toBe(0);
      expect(lru.totalBytes).toBe(0);
    }
  });

  it('onRemove fires on eviction, replace, delete, and clear -- so a caller can keep its own lookup in sync', () => {
    const removed: Array<{ key: number; bitmap: FakeBitmap }> = [];
    const lru = createFrameLru<number, FakeBitmap>(250, undefined, (key, bitmap) => {
      removed.push({ key, bitmap });
    });
    const a = new FakeBitmap();
    const b = new FakeBitmap();
    const c = new FakeBitmap();
    lru.set(1, a, 100);
    lru.set(2, b, 100);
    lru.set(3, c, 100); // evicts 1
    expect(removed.map((r) => r.key)).toEqual([1]);

    const replacement = new FakeBitmap();
    lru.set(2, replacement, 100); // replaces 2
    expect(removed.map((r) => r.key)).toEqual([1, 2]);

    lru.delete(3);
    expect(removed.map((r) => r.key)).toEqual([1, 2, 3]);

    lru.clear(); // only key 2 (the replacement bitmap) is still resident at this point
    expect(removed.map((r) => r.key)).toEqual([1, 2, 3, 2]);
    expect(replacement.closed).toBe(true);
  });

  it('tracks and untracks bitmaps in a supplied FrameLifecycleRegistry across set/evict/clear', () => {
    const registry = createFrameLifecycleRegistry();
    const lru = createFrameLru<number, FakeBitmap>(250, registry);
    lru.set(1, new FakeBitmap(), 100);
    lru.set(2, new FakeBitmap(), 100);
    expect(registry.liveCount).toBe(2);
    lru.set(3, new FakeBitmap(), 100); // evicts entry 1
    expect(registry.liveCount).toBe(2);
    lru.clear();
    expect(registry.liveCount).toBe(0);
  });
});
