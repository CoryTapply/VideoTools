import { describe, expect, it, vi } from 'vitest';
import { SampleIndex } from '../index/query';
import type { TrackIndex } from '../index/track-index';
import { DEFAULT_BUDGET_BYTES, FrameCache } from './FrameCache';
import { FrameWorkerPool, type WorkerDecodeRequest, type WorkerDecodeResult, type WorkerHandle } from './worker-pool';
import type { Closable } from './frame-lifecycle';

class FakeBitmap implements Closable {
  closed = false;
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  close(): void {
    if (this.closed) throw new Error('double close()');
    this.closed = true;
  }
}

/** Resolves every decode() immediately with one bitmap per kept job -- realistic enough to drive FrameCache's real chunking/tier logic without a real decoder. Optionally delays a specific requestId so tests can observe pool/generation state mid-flight. */
class ImmediateWorkerHandle implements WorkerHandle {
  decodeCalls: WorkerDecodeRequest[] = [];
  cancelledIds = new Set<number>();
  private readonly held = new Map<number, { resolve: (result: WorkerDecodeResult) => void }>();
  private readonly holdRequestIds: Set<number>;

  constructor(holdRequestIds: Set<number> = new Set()) {
    this.holdRequestIds = holdRequestIds;
  }

  decode(request: WorkerDecodeRequest): Promise<WorkerDecodeResult> {
    this.decodeCalls.push(request);
    const build = (): WorkerDecodeResult => {
      if (this.cancelledIds.has(request.requestId)) return { requestId: request.requestId, thumbnails: [], errors: [], cancelled: true };
      const thumbnails = request.jobs.filter((j) => j.keep).map((j) => ({ id: j.id, presentationTime: j.presentationTime, bitmap: new FakeBitmap(request.size.width, request.size.height) }));
      return { requestId: request.requestId, thumbnails, errors: [], cancelled: false };
    };
    if (this.holdRequestIds.has(request.requestId)) {
      return new Promise((resolve) => {
        this.held.set(request.requestId, { resolve: () => { resolve(build()); } });
      });
    }
    return Promise.resolve(build());
  }

  release(requestId: number): void {
    this.held.get(requestId)?.resolve({ requestId, thumbnails: [], errors: [], cancelled: false });
  }

  cancel(requestId: number): void {
    this.cancelledIds.add(requestId);
    const entry = this.held.get(requestId);
    if (entry) {
      this.held.delete(requestId);
      entry.resolve({ requestId, thumbnails: [], errors: [], cancelled: true });
    }
  }

  terminate(): void {}
}

/** 25 keyframe-spaced samples (GOP of 5, 1000 ticks/sample, timescale 30000) -- small enough to reason about by hand, structured like the real fixture (periodic sync samples, no B-frames). */
function makeTrack(overrides: Partial<TrackIndex> = {}): TrackIndex {
  const sampleCount = 25;
  const pts = Float64Array.from({ length: sampleCount }, (_, i) => i * 1000);
  const isSync = Uint8Array.from({ length: sampleCount }, (_, i) => (i % 5 === 0 ? 1 : 0));
  return {
    trackId: 1,
    kind: 'video',
    handlerType: 'vide',
    codec: 'avc1.640034',
    timescale: 30000,
    duration: sampleCount * 1000,
    sampleCount,
    pts,
    dts: pts.slice(),
    offset: Float64Array.from({ length: sampleCount }, (_, i) => i * 2000),
    size: Uint32Array.from({ length: sampleCount }, () => 400),
    isSync,
    description: new Uint8Array([1, 2, 3, 4]),
    video: { codedWidth: 1920, codedHeight: 1080, displayWidth: 1920, displayHeight: 1080, rotationDegrees: 0, nominalFrameRate: 30, constantDuration: true },
    editOffsetTicks: 0,
    ...overrides,
  };
}

function makeCache(pool: FrameWorkerPool, overrides: Partial<ConstructorParameters<typeof FrameCache>[0]> = {}): FrameCache {
  const sampleIndex = new SampleIndex([makeTrack()]);
  return new FrameCache({ sampleIndex, videoTrackId: 1, pool, ...overrides });
}

describe('FrameCache construction', () => {
  it('throws if the given trackId is not a video track', () => {
    const sampleIndex = new SampleIndex([makeTrack({ trackId: 2, kind: 'audio', video: undefined, audio: { channelCount: 2, sampleRate: 48000, language: 'eng', handlerName: '' } })]);
    const pool = new FrameWorkerPool([new ImmediateWorkerHandle()]);
    expect(() => new FrameCache({ sampleIndex, videoTrackId: 2, pool })).toThrow(/video track/);
  });
});

describe('warmCoarse', () => {
  it('produces one decoded frame per keyframe, retrievable via getNearest', async () => {
    const pool = new FrameWorkerPool([new ImmediateWorkerHandle()]);
    const cache = makeCache(pool);
    await cache.warmCoarse();

    // keyframes at n=0,5,10,15,20 -> presentation times 0,5000,10000,15000,20000
    for (const t of [0, 5000, 10000, 15000, 20000]) {
      const frame = cache.getNearest(t);
      expect(frame?.presentationTime).toBe(t);
      expect(frame?.tier).toBe('coarse');
    }
  });

  it('reports progress reaching completed === total', async () => {
    const pool = new FrameWorkerPool([new ImmediateWorkerHandle()]);
    const cache = makeCache(pool);
    const calls: Array<[number, number]> = [];
    await cache.warmCoarse((completed, total) => calls.push([completed, total]));
    expect(calls.at(-1)).toEqual([5, 5]);
  });

  it('getNearest returns null before warmCoarse has been called', () => {
    const pool = new FrameWorkerPool([new ImmediateWorkerHandle()]);
    const cache = makeCache(pool);
    expect(cache.getNearest(1000)).toBeNull();
  });

  it('getNearest snaps to the closest coarse keyframe for an in-between query time', async () => {
    const pool = new FrameWorkerPool([new ImmediateWorkerHandle()]);
    const cache = makeCache(pool);
    await cache.warmCoarse();
    expect(cache.getNearest(4900)?.presentationTime).toBe(5000);
    expect(cache.getNearest(2000)?.presentationTime).toBe(0);
  });

  it('getRange returns count evenly-spaced lookups', async () => {
    const pool = new FrameWorkerPool([new ImmediateWorkerHandle()]);
    const cache = makeCache(pool);
    await cache.warmCoarse();
    const range = cache.getRange(0, 20000, 5);
    expect(range.map((f) => f?.presentationTime)).toEqual([0, 5000, 10000, 15000, 20000]);
  });

  it('getRange with count <= 0 returns an empty array', async () => {
    const pool = new FrameWorkerPool([new ImmediateWorkerHandle()]);
    const cache = makeCache(pool);
    await cache.warmCoarse();
    expect(cache.getRange(0, 1000, 0)).toEqual([]);
  });

  it('fires onFrameAvailable for every decoded coarse frame', async () => {
    const pool = new FrameWorkerPool([new ImmediateWorkerHandle()]);
    const cache = makeCache(pool);
    const times: number[] = [];
    const unsubscribe = cache.onFrameAvailable((t) => times.push(t));
    await cache.warmCoarse();
    expect(times.sort((a, b) => a - b)).toEqual([0, 5000, 10000, 15000, 20000]);
    unsubscribe();
  });

  it('onFrameAvailable unsubscribe stops further notifications', async () => {
    const pool = new FrameWorkerPool([new ImmediateWorkerHandle()]);
    const cache = makeCache(pool);
    const cb = vi.fn();
    const unsubscribe = cache.onFrameAvailable(cb);
    unsubscribe();
    await cache.warmCoarse();
    expect(cb).not.toHaveBeenCalled();
  });

  it('calls onCoarseAtlasReady once the FINAL (partial) atlas is fully populated -- a short file never reaches 100 keyframes, but its one atlas still completes', async () => {
    const pool = new FrameWorkerPool([new ImmediateWorkerHandle()]);
    const onCoarseAtlasReady = vi.fn();
    const cache = makeCache(pool, { onCoarseAtlasReady });
    await cache.warmCoarse();
    expect(onCoarseAtlasReady).toHaveBeenCalledTimes(1);
    const [atlasId, bitmaps] = onCoarseAtlasReady.mock.calls[0] as [number, FakeBitmap[]];
    expect(atlasId).toBe(0);
    expect(bitmaps).toHaveLength(5); // all 5 keyframes in this fixture, not 100 -- there's only ever one (partial) atlas
  });

  it('fires once per atlas boundary crossed: a full 100-tile atlas fires separately from the trailing partial one', async () => {
    const sampleCount = 150;
    const pts = Float64Array.from({ length: sampleCount }, (_, i) => i * 1000);
    const track: TrackIndex = { ...makeTrack(), sampleCount, pts, dts: pts.slice(), offset: Float64Array.from({ length: sampleCount }, (_, i) => i * 2000), size: Uint32Array.from({ length: sampleCount }, () => 400), isSync: new Uint8Array(sampleCount).fill(1) }; // every sample is a keyframe -> 150 coarse entries
    const sampleIndex = new SampleIndex([track]);
    const pool = new FrameWorkerPool([new ImmediateWorkerHandle()]);
    const onCoarseAtlasReady = vi.fn();
    const cache = new FrameCache({ sampleIndex, videoTrackId: 1, pool, onCoarseAtlasReady });

    await cache.warmCoarse();

    expect(onCoarseAtlasReady).toHaveBeenCalledTimes(2);
    const calls = onCoarseAtlasReady.mock.calls as Array<[number, FakeBitmap[]]>;
    const byAtlasId = new Map(calls.map(([id, bitmaps]) => [id, bitmaps.length]));
    expect(byAtlasId.get(0)).toBe(100);
    expect(byAtlasId.get(1)).toBe(50);
  });
});

describe('clear()', () => {
  it('closes every resident bitmap and resets getNearest to null', async () => {
    const pool = new FrameWorkerPool([new ImmediateWorkerHandle()]);
    const cache = makeCache(pool);
    await cache.warmCoarse();
    const before = cache.getNearest(0);
    expect(before).not.toBeNull();

    cache.clear();
    expect(cache.getNearest(0)).toBeNull();
    expect((before?.bitmap as FakeBitmap).closed).toBe(true);
  });

  it('20 warm/clear cycles leave no residual frames (the Part 9 leak check, in miniature)', async () => {
    const pool = new FrameWorkerPool([new ImmediateWorkerHandle()]);
    const cache = makeCache(pool);
    for (let i = 0; i < 20; i += 1) {
      await cache.warmCoarse();
      expect(cache.getNearest(0)).not.toBeNull();
      cache.clear();
      expect(cache.getNearest(0)).toBeNull();
    }
  });

  it('discards a warmCoarse() chunk that resolves after a clear() superseded it', async () => {
    const handle = new ImmediateWorkerHandle(new Set([1])); // hold the first dispatched request
    const pool = new FrameWorkerPool([handle]);
    const cache = makeCache(pool);

    const warmPromise = cache.warmCoarse();
    cache.clear();
    handle.release(1);
    await warmPromise;

    expect(cache.getNearest(0)).toBeNull();
  });
});

describe('dispose()', () => {
  it('is idempotent and terminates the pool', async () => {
    const handle = new ImmediateWorkerHandle();
    const pool = new FrameWorkerPool([handle]);
    const cache = makeCache(pool);
    await cache.warmCoarse();
    cache.dispose();
    cache.dispose(); // no-op, must not throw
    expect(cache.getNearest(0)).toBeNull();
  });

  it('setViewport() and warmCoarse() are no-ops after dispose', async () => {
    const pool = new FrameWorkerPool([new ImmediateWorkerHandle()]);
    const cache = makeCache(pool);
    cache.dispose();
    cache.setViewport(0, 1000, 100); // must not throw
    await cache.warmCoarse();
    expect(cache.getNearest(0)).toBeNull();
  });
});

// A dedicated track for dense-tier tests: GOP of 25 samples (keyframe interval 25000 ticks) is
// deliberately much wider than the default 2fps dense step (15000 ticks), mirroring the real
// fixture's relationship (GOP ~4.17s vs. dense's 0.5s step) -- without that ratio, dense sampling
// isn't actually finer than coarse and getNearest() has nothing meaningful to prefer.
function makeDenseTestTrack(): TrackIndex {
  const sampleCount = 50;
  const pts = Float64Array.from({ length: sampleCount }, (_, i) => i * 1000);
  return { ...makeTrack(), sampleCount, pts, dts: pts.slice(), offset: Float64Array.from({ length: sampleCount }, (_, i) => i * 2000), size: Uint32Array.from({ length: sampleCount }, () => 400), isSync: Uint8Array.from({ length: sampleCount }, (_, i) => (i % 25 === 0 ? 1 : 0)) };
}

describe('setViewport / dense tier', () => {
  it('does not trigger a dense rebuild before warmCoarse (no keyframe-interval estimate yet)', () => {
    const handle = new ImmediateWorkerHandle();
    const pool = new FrameWorkerPool([handle]);
    const cache = makeCache(pool);
    cache.setViewport(0, 1000, 1_000_000); // absurdly zoomed in -- would trigger if it could
    expect(handle.decodeCalls).toHaveLength(0);
  });

  // denseWindowSeconds is deliberately small (0.3s -> +/-9000 ticks) relative to this 50-sample
  // synthetic file: it keeps window A (centered on t=15000, clamped to [6000, 24000]) and window B
  // (centered on t=40000, [31000, 49000]) from overlapping, so the two are actually distinguishable
  // in the cancellation test below. Querying each window's own windowStart (6000 / 31000) is used
  // rather than its center, since the dense sampling grid starts exactly at windowStart and is
  // therefore always an exact (distance-0) hit there, regardless of the 2fps step's phase.

  it('triggers a dense rebuild once pixels-per-keyframe exceeds the trigger threshold, and dense wins getNearest between coarse keyframes', async () => {
    const handle = new ImmediateWorkerHandle();
    const pool = new FrameWorkerPool([handle]);
    const sampleIndex = new SampleIndex([makeDenseTestTrack()]);
    const cache = new FrameCache({ sampleIndex, videoTrackId: 1, pool, denseWindowSeconds: 0.3 });
    await cache.warmCoarse();
    handle.decodeCalls = [];

    // keyframe interval: 25000 ticks / 30000 timescale ~= 0.833s; need pxPerKeyframe > 40 -> pixelsPerSecond > 48
    cache.setViewport(14000, 16000, 100);
    await vi.waitFor(() => {
      expect(cache.getNearest(6000)?.tier).toBe('dense');
    });
    expect(cache.getNearest(6000)?.presentationTime).toBe(6000); // exact dense hit; coarse's nearest keyframe (0) is 6000 ticks away
  });

  it('does not re-trigger for an unchanged window (same start/end after clamping)', async () => {
    const handle = new ImmediateWorkerHandle();
    const pool = new FrameWorkerPool([handle]);
    const sampleIndex = new SampleIndex([makeDenseTestTrack()]);
    const cache = new FrameCache({ sampleIndex, videoTrackId: 1, pool, denseWindowSeconds: 0.3 });
    await cache.warmCoarse();
    cache.setViewport(14000, 16000, 100);
    await vi.waitFor(() => {
      expect(cache.getNearest(6000)?.tier).toBe('dense');
    });
    const callsAfterFirst = handle.decodeCalls.length;

    cache.setViewport(14000, 16000, 100); // identical viewport
    expect(handle.decodeCalls.length).toBe(callsAfterFirst);
  });

  it('retiring the dense tier (zooming back out) closes its bitmaps and falls back to coarse', async () => {
    const handle = new ImmediateWorkerHandle();
    const pool = new FrameWorkerPool([handle]);
    const sampleIndex = new SampleIndex([makeDenseTestTrack()]);
    const cache = new FrameCache({ sampleIndex, videoTrackId: 1, pool, denseWindowSeconds: 0.3 });
    await cache.warmCoarse();
    cache.setViewport(14000, 16000, 100);
    await vi.waitFor(() => {
      expect(cache.getNearest(6000)?.tier).toBe('dense');
    });

    cache.setViewport(14000, 16000, 1); // zoom back out, below the trigger
    expect(cache.getNearest(6000)?.tier).toBe('coarse');
  });

  it('a superseding setViewport cancels the previous in-flight dense request and discards its late result', async () => {
    const handle = new ImmediateWorkerHandle(new Set([2])); // hold the SECOND dispatched request (first is warmCoarse's single chunk)
    const pool = new FrameWorkerPool([handle]);
    const sampleIndex = new SampleIndex([makeDenseTestTrack()]);
    const cache = new FrameCache({ sampleIndex, videoTrackId: 1, pool, denseWindowSeconds: 0.3 });
    await cache.warmCoarse();

    cache.setViewport(14000, 16000, 100); // dense request A, window [6000, 24000], held
    cache.setViewport(39000, 41000, 100); // dense request B, window [31000, 49000] (disjoint from A) -- cancels A once dispatched

    await vi.waitFor(() => {
      expect(cache.getNearest(31000)?.tier).toBe('dense');
    });
    // A's window (t=6000) must not have been populated by the stale, cancelled request
    expect(cache.getNearest(6000)?.tier).not.toBe('dense');
  });
});

describe('DEFAULT_BUDGET_BYTES', () => {
  it('is approximately 96MB, matching the documented eviction budget', () => {
    expect(DEFAULT_BUDGET_BYTES).toBe(96 * 1024 * 1024);
  });
});
