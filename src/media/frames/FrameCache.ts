// Public API (Part 8) and the two-tier design (Part 1) tying every other module together:
//   - COARSE: whole file, one entry per keyframe, 160x90, built eagerly by warmCoarse(). This is
//     both the filmstrip source and the default scrub source -- at full-file zoom on a ~1400px
//     timeline, a ~4.17s keyframe interval is about 5px, finer than the pointer, so coarse alone
//     is sufficient for the large majority of scrubbing.
//   - DENSE: +/-30s around the viewport, 2fps, 320x180, built lazily only once zoom exceeds
//     roughly one keyframe per 40px, cancelled and rebuilt as the viewport moves. Spike C's
//     originally validated path, now scoped to only the case coarse is genuinely too sparse for.
//
// getNearest() is a pure binary-search lookup (binary-search.ts) -- no promises, no allocation,
// no triggering of decodes -- because it's called at 60Hz inside a pointermove handler. That
// constraint is the entire reason the coarse tier is built eagerly rather than on demand.
//
// Atlas persistence (Part 5) is wired through an optional onCoarseAtlasReady callback rather than
// hardcoded here: packing needs a real OffscreenCanvas (atlas-pack.ts), which doesn't exist in
// Node, so keeping FrameCache itself decoupled from it is what keeps this file fully testable
// against a fake pool. A browser-side caller wires onCoarseAtlasReady to packAtlas + writeAtlas.

import { createFrameLifecycleRegistry, type FrameLifecycleRegistry } from './frame-lifecycle';
import { binarySearchNearest } from './binary-search';
import { ATLAS_CAPACITY, atlasSlotFor } from './atlas-layout';
import { warmCoarse as warmCoarseTier } from './coarse-tier';
import { rebuildDense } from './dense-tier';
import type { DecodedBitmap, FrameDecoderConfig } from './FrameDecoder';
import { buildCoarseJobs, buildDenseWindowJobs } from './job-builder';
import { createFrameLru, estimateRgbaBytes, type FrameLru } from './lru';
import type { SampleIndex } from '../index/query';
import type { CachedFrame, Time } from './types';
import { defaultWorkerCount, type FrameWorkerPool } from './worker-pool';

export type Unsubscribe = () => void;

const COARSE_KEY_PREFIX = 'coarse-';
const DENSE_KEY_PREFIX = 'dense-';

/** ~96MB: the full coarse tier resident at all times (~58MB for 1,015 entries at 160x90 RGBA on the 27GB fixture) plus headroom for a realistic dense window, comfortably under the ~190MB "everything resident" worst case. See README.md for the full justification. */
export const DEFAULT_BUDGET_BYTES = 96 * 1024 * 1024;
export const DEFAULT_COARSE_SIZE = { width: 160, height: 90 };
export const DEFAULT_DENSE_SIZE = { width: 320, height: 180 };
const DEFAULT_DENSE_WINDOW_SECONDS = 30;
const DEFAULT_DENSE_FPS = 2;
const DEFAULT_DENSE_TRIGGER_PX_PER_KEYFRAME = 40;

export interface FrameCacheOptions {
  readonly sampleIndex: SampleIndex;
  readonly videoTrackId: number;
  readonly pool: FrameWorkerPool;
  readonly budgetBytes?: number;
  readonly coarseSize?: { width: number; height: number };
  readonly denseSize?: { width: number; height: number };
  readonly denseWindowSeconds?: number;
  readonly denseFps?: number;
  readonly denseTriggerPxPerKeyframe?: number;
  readonly registry?: FrameLifecycleRegistry;
  /** Fires once every one of an atlas's 100 coarse-tier slots has a resident bitmap. Browser-only integration point -- see this file's header comment. */
  readonly onCoarseAtlasReady?: (atlasId: number, bitmaps: readonly DecodedBitmap[]) => void;
}

export class FrameCache {
  private readonly sampleIndex: SampleIndex;
  private readonly trackId: number;
  private readonly pool: FrameWorkerPool;
  private readonly config: FrameDecoderConfig;
  private readonly timescale: number;
  private readonly coarseSize: { width: number; height: number };
  private readonly denseSize: { width: number; height: number };
  private readonly denseWindowTicks: number;
  private readonly denseStepTicks: number;
  private readonly denseTriggerPxPerKeyframe: number;
  private readonly registry: FrameLifecycleRegistry;
  private readonly lru: FrameLru<string, DecodedBitmap>;
  private readonly listeners = new Set<(time: Time) => void>();
  private readonly onCoarseAtlasReady: ((atlasId: number, bitmaps: readonly DecodedBitmap[]) => void) | undefined;

  private coarseTimes = new Float64Array(0);
  private coarseFrames: (CachedFrame | null)[] = [];
  private coarseGeneration = 0;
  private averageKeyframeIntervalTicks = 0;

  private denseTimes = new Float64Array(0);
  private denseFrames: (CachedFrame | null)[] = [];
  private denseLruKeys: string[] = [];
  private denseGeneration = 0;
  private denseInFlightRequestId: number | undefined;
  private activeDenseWindowStart: Time | undefined;
  private activeDenseWindowEnd: Time | undefined;

  private lastViewportCenter: Time = 0;
  private nextRequestIdValue = 1;
  private disposed = false;

  constructor(options: FrameCacheOptions) {
    const track = options.sampleIndex.tracks().find((t) => t.trackId === options.videoTrackId);
    if (!track?.video) throw new Error(`FrameCache: track ${String(options.videoTrackId)} is not a video track with decodable metadata`);

    this.sampleIndex = options.sampleIndex;
    this.trackId = options.videoTrackId;
    this.pool = options.pool;
    this.config = { codec: track.codec, codedWidth: track.video.codedWidth, codedHeight: track.video.codedHeight, description: track.description };
    this.timescale = track.timescale;
    this.coarseSize = options.coarseSize ?? DEFAULT_COARSE_SIZE;
    this.denseSize = options.denseSize ?? DEFAULT_DENSE_SIZE;
    this.denseWindowTicks = (options.denseWindowSeconds ?? DEFAULT_DENSE_WINDOW_SECONDS) * this.timescale;
    this.denseStepTicks = this.timescale / (options.denseFps ?? DEFAULT_DENSE_FPS);
    this.denseTriggerPxPerKeyframe = options.denseTriggerPxPerKeyframe ?? DEFAULT_DENSE_TRIGGER_PX_PER_KEYFRAME;
    this.registry = options.registry ?? createFrameLifecycleRegistry();
    this.onCoarseAtlasReady = options.onCoarseAtlasReady;
    this.lru = createFrameLru<string, DecodedBitmap>(options.budgetBytes ?? DEFAULT_BUDGET_BYTES, this.registry, (key) => {
      this.handleLruRemoval(key);
    });
  }

  async warmCoarse(onProgress?: (completed: number, total: number) => void): Promise<void> {
    if (this.disposed) return;
    this.coarseGeneration += 1;
    const generation = this.coarseGeneration;

    const jobs = buildCoarseJobs(this.sampleIndex, this.trackId);
    this.coarseTimes = Float64Array.from(jobs, (j) => j.time);
    this.coarseFrames = new Array<CachedFrame | null>(jobs.length).fill(null);
    if (jobs.length > 1) {
      this.averageKeyframeIntervalTicks = (jobs[jobs.length - 1].time - jobs[0].time) / (jobs.length - 1);
    }

    await warmCoarseTier({
      pool: this.pool,
      config: this.config,
      size: this.coarseSize,
      jobs,
      initialCenter: this.lastViewportCenter,
      nextRequestId: () => this.nextRequestId(),
      isCurrentGeneration: () => generation === this.coarseGeneration && !this.disposed,
      onChunkDone: (thumbnails) => {
        for (const t of thumbnails) this.applyCoarseThumbnail(t.presentationTime, t.bitmap);
      },
      onProgress,
    });
  }

  setViewport(start: Time, end: Time, pixelsPerSecond: number): void {
    if (this.disposed) return;
    const center = (start + end) / 2;
    this.lastViewportCenter = center;

    if (this.coarseTimes.length < 2 || this.averageKeyframeIntervalTicks <= 0) return;

    const keyframeIntervalSeconds = this.averageKeyframeIntervalTicks / this.timescale;
    const pxPerKeyframe = keyframeIntervalSeconds * pixelsPerSecond;
    if (pxPerKeyframe <= this.denseTriggerPxPerKeyframe) {
      this.retireDenseTier();
      return;
    }

    // Clamp only the start to >= 0: the coarse tier's keyframe extent (coarseTimes[0..last]) is
    // NOT the same as the file's actual duration (the last keyframe is rarely the last sample),
    // so clamping windowEnd against it would silently exclude the tail of the file past the last
    // keyframe. An over-long windowEnd is harmless -- buildDenseWindowJobs's
    // frameAtPresentationTime() naturally saturates at the last real sample.
    const windowStart = Math.max(0, center - this.denseWindowTicks);
    const windowEnd = center + this.denseWindowTicks;
    if (windowStart === this.activeDenseWindowStart && windowEnd === this.activeDenseWindowEnd) return;

    this.rebuildDenseWindow(windowStart, windowEnd);
  }

  /** Pure lookup: no promises, no allocation, no triggering of decodes. Prefers whichever tier has a resident (already-decoded) frame closer to `time`; null if neither does yet. */
  getNearest(time: Time): CachedFrame | null {
    let best: CachedFrame | null = null;
    let bestDist = Infinity;

    if (this.coarseTimes.length > 0) {
      const frame = this.coarseFrames[binarySearchNearest(this.coarseTimes, time)];
      if (frame) {
        best = frame;
        bestDist = Math.abs(frame.presentationTime - time);
      }
    }
    if (this.denseTimes.length > 0) {
      const frame = this.denseFrames[binarySearchNearest(this.denseTimes, time)];
      if (frame) {
        const dist = Math.abs(frame.presentationTime - time);
        if (dist < bestDist) best = frame;
      }
    }
    return best;
  }

  getRange(from: Time, to: Time, count: number): (CachedFrame | null)[] {
    if (count <= 0) return [];
    const step = count === 1 ? 0 : (to - from) / (count - 1);
    return Array.from({ length: count }, (_, i) => this.getNearest(from + step * i));
  }

  onFrameAvailable(cb: (time: Time) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  clear(): void {
    this.coarseGeneration += 1;
    this.denseGeneration += 1;
    if (this.denseInFlightRequestId !== undefined) {
      this.pool.cancel(this.denseInFlightRequestId);
      this.denseInFlightRequestId = undefined;
    }
    this.lru.clear();
    this.coarseTimes = new Float64Array(0);
    this.coarseFrames = [];
    this.averageKeyframeIntervalTicks = 0;
    this.denseTimes = new Float64Array(0);
    this.denseFrames = [];
    this.denseLruKeys = [];
    this.activeDenseWindowStart = undefined;
    this.activeDenseWindowEnd = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.listeners.clear();
    this.pool.dispose();
  }

  private nextRequestId(): number {
    const id = this.nextRequestIdValue;
    this.nextRequestIdValue += 1;
    return id;
  }

  private notifyFrameAvailable(time: Time): void {
    for (const cb of this.listeners) cb(time);
  }

  private applyCoarseThumbnail(presentationTime: Time, bitmap: DecodedBitmap): void {
    const idx = binarySearchNearest(this.coarseTimes, presentationTime);
    if (idx < 0 || this.coarseTimes[idx] !== presentationTime) {
      bitmap.close(); // shouldn't happen -- a decoded time that doesn't match any coarse slot
      return;
    }
    this.lru.set(`${COARSE_KEY_PREFIX}${String(idx)}`, bitmap, estimateRgbaBytes(this.coarseSize.width, this.coarseSize.height));
    this.coarseFrames[idx] = { presentationTime, bitmap, tier: 'coarse' };
    this.notifyFrameAvailable(presentationTime);
    this.maybeReportCompleteAtlas(idx);
  }

  private maybeReportCompleteAtlas(justFilledIdx: number): void {
    if (!this.onCoarseAtlasReady) return;
    const { atlasId } = atlasSlotFor(justFilledIdx);
    const atlasStart = atlasId * ATLAS_CAPACITY;
    const atlasEnd = Math.min(atlasStart + ATLAS_CAPACITY, this.coarseFrames.length);
    const bitmaps: DecodedBitmap[] = [];
    for (let i = atlasStart; i < atlasEnd; i += 1) {
      const frame = this.coarseFrames[i];
      if (!frame) return; // not every slot in this atlas is filled yet
      bitmaps.push(frame.bitmap);
    }
    this.onCoarseAtlasReady(atlasId, bitmaps);
  }

  private retireDenseTier(): void {
    if (this.denseInFlightRequestId !== undefined) {
      this.pool.cancel(this.denseInFlightRequestId);
      this.denseInFlightRequestId = undefined;
    }
    this.denseGeneration += 1; // discard any in-flight rebuild's late result
    for (const key of this.denseLruKeys) this.lru.delete(key);
    this.denseLruKeys = [];
    this.denseTimes = new Float64Array(0);
    this.denseFrames = [];
    this.activeDenseWindowStart = undefined;
    this.activeDenseWindowEnd = undefined;
  }

  private rebuildDenseWindow(windowStart: Time, windowEnd: Time): void {
    if (this.denseInFlightRequestId !== undefined) this.pool.cancel(this.denseInFlightRequestId);
    this.denseGeneration += 1;
    const generation = this.denseGeneration;
    this.activeDenseWindowStart = windowStart;
    this.activeDenseWindowEnd = windowEnd;

    const jobs = buildDenseWindowJobs(this.sampleIndex, this.trackId, windowStart, windowEnd, this.denseStepTicks);
    const requestId = this.nextRequestId();
    this.denseInFlightRequestId = requestId;

    rebuildDense({ pool: this.pool, config: this.config, size: this.denseSize, jobs, requestId })
      .then((result) => {
        if (this.denseInFlightRequestId === requestId) this.denseInFlightRequestId = undefined;
        if (generation !== this.denseGeneration || this.disposed || result.cancelled) {
          for (const t of result.thumbnails) t.bitmap.close();
          return;
        }

        for (const key of this.denseLruKeys) this.lru.delete(key);
        this.denseLruKeys = [];

        const sorted = [...result.thumbnails].sort((a, b) => a.presentationTime - b.presentationTime);
        this.denseTimes = Float64Array.from(sorted, (t) => t.presentationTime);
        this.denseFrames = sorted.map((t) => {
          const key = `${DENSE_KEY_PREFIX}${String(t.id)}`;
          this.denseLruKeys.push(key);
          this.lru.set(key, t.bitmap, estimateRgbaBytes(this.denseSize.width, this.denseSize.height));
          this.notifyFrameAvailable(t.presentationTime);
          return { presentationTime: t.presentationTime, bitmap: t.bitmap, tier: 'dense' as const };
        });

        if (result.errors.length > 0) console.warn(`frame cache: dense window had ${String(result.errors.length)} decode error(s)`, result.errors);
      })
      .catch((err: unknown) => {
        console.warn('frame cache: dense window rebuild failed', err);
      });
  }

  private handleLruRemoval(key: string): void {
    if (key.startsWith(COARSE_KEY_PREFIX)) {
      const idx = Number(key.slice(COARSE_KEY_PREFIX.length));
      if (Number.isInteger(idx) && idx >= 0 && idx < this.coarseFrames.length) this.coarseFrames[idx] = null;
      return;
    }
    if (key.startsWith(DENSE_KEY_PREFIX)) {
      const idx = this.denseLruKeys.indexOf(key);
      if (idx >= 0) this.denseFrames[idx] = null;
    }
  }
}

/** min(4, hardwareConcurrency/2), starting at 2 -- see worker-pool.ts's defaultWorkerCount for the reasoning. Re-exported here since FrameCache is the module's main entry point. */
export { defaultWorkerCount };
