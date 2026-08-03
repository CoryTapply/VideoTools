// Spike C / Step 3 -- main-thread side: picks a 5-minute window, spawns the cache-build worker,
// measures heap before/after the cache exists, simulates a 60Hz drag sweeping across the whole
// cached window for 5 seconds (nearest-slot lookup + an actual canvas draw, since that's the
// real per-frame cost a scrub UI pays), then closes every cached ImageBitmap and re-checks
// whether the heap returns to baseline. See prompts/m0.5-spike-prompts.md Step 3: "This is the
// interaction I want to ship. Tell me whether it works."

import type { TrackIndex } from '../A-remux/mp4-index';
import { localUnitsToPresentationSec } from '../A-remux/select';
import { precedingSyncSampleIndex } from './gop-chain';
import { extractAvcDecoderConfig } from './avc-config';
import type { CacheBuildRequest, CacheBuildResult, CacheSample } from './cache-build-worker';

const TARGET_FPS = 2;
const WINDOW_SECONDS = 300;
const THUMB_WIDTH = 320;
const THUMB_HEIGHT = 180;
const DRAG_HZ = 60;
const DRAG_SECONDS = 5;

export interface CacheStats {
  requestedSlotCount: number;
  filledSlotCount: number;
  buildMs: number;
  framesDecodedTotal: number;
  windowStartSec: number;
  windowEndSec: number;
  heapBeforeBuildBytes: number | null;
  heapAfterBuildBytes: number | null;
  errors: string[];
}

export interface DragStats {
  iterations: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  totalMs: number;
  sustainable60Hz: boolean;
  hitCount: number;
  missCount: number;
}

export interface CloseStats {
  heapAfterCloseBytes: number | null;
  heapAfterGcDelayBytes: number | null;
  heapReturnedToBaseline: boolean | null;
}

function heapBytes(): number | null {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? mem.usedJSHeapSize : null;
}

function sampleIndexAtDtsSeconds(track: TrackIndex, targetSec: number): number {
  let lo = 0;
  let hi = track.sampleCount - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const sec = track.dts[mid]! / track.timescale;
    if (sec < targetSec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function buildCacheSamples(track: TrackIndex, startIdx: number, endIdx: number): CacheSample[] {
  const samples: CacheSample[] = [];
  for (let i = startIdx; i <= endIdx; i += 1) {
    samples.push({
      offset: track.offset[i]!,
      size: track.size[i]!,
      timestampUs: Math.round(localUnitsToPresentationSec(track, track.cts[i]!) * 1e6),
      sync: track.sync[i] === 1,
    });
  }
  return samples;
}

export async function buildScrubCache(
  file: File,
  track: TrackIndex,
  hardwareAcceleration: 'prefer-hardware' | 'prefer-software' | 'no-preference',
): Promise<{ stats: CacheStats; bitmaps: ImageBitmap[]; slotTimestampsUs: number[] }> {
  const totalDurationSec = track.dts[track.sampleCount - 1]! / track.timescale;
  const windowDurationSec = Math.min(WINDOW_SECONDS, totalDurationSec * 0.6);
  const windowStartSec = totalDurationSec * 0.2;
  const windowEndSec = windowStartSec + windowDurationSec;

  const approxStartIdx = sampleIndexAtDtsSeconds(track, windowStartSec);
  const startIdx = precedingSyncSampleIndex(track, approxStartIdx);
  const endIdx = Math.min(track.sampleCount - 1, sampleIndexAtDtsSeconds(track, windowEndSec));

  const samples = buildCacheSamples(track, startIdx, endIdx);
  const slotCount = Math.min(Math.round(windowDurationSec * TARGET_FPS), 600);
  const gridStepUs = Math.round(1e6 / TARGET_FPS);
  const windowStartUs = Math.round(windowStartSec * 1e6);
  const slotTimestampsUs = Array.from({ length: slotCount }, (_, i) => windowStartUs + i * gridStepUs);

  const decoderConfig = extractAvcDecoderConfig(track);
  const heapBeforeBuildBytes = heapBytes();

  const worker = new Worker(new URL('./cache-build-worker.ts', import.meta.url), { type: 'module' });
  const request: CacheBuildRequest = { file, decoderConfig, samples, slotTimestampsUs, thumbWidth: THUMB_WIDTH, thumbHeight: THUMB_HEIGHT, hardwareAcceleration };
  const result = await new Promise<CacheBuildResult>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<CacheBuildResult>) => resolve(e.data);
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage(request);
  });
  worker.terminate();

  const heapAfterBuildBytes = heapBytes();

  const stats: CacheStats = {
    requestedSlotCount: slotCount,
    filledSlotCount: result.bitmaps.length,
    buildMs: result.buildMs,
    framesDecodedTotal: result.framesDecodedTotal,
    windowStartSec,
    windowEndSec,
    heapBeforeBuildBytes,
    heapAfterBuildBytes,
    errors: result.errors,
  };

  return { stats, bitmaps: result.bitmaps, slotTimestampsUs: result.actualTimestampsUs };
}

/** Sweeps a virtual playhead across the ENTIRE cached window in DRAG_SECONDS real seconds, at DRAG_HZ, looking up the nearest cached bitmap and drawing it -- the real per-event cost a pointermove-driven scrub UI would pay. */
export function simulateDrag(bitmaps: ImageBitmap[]): DragStats {
  const canvas = new OffscreenCanvas(THUMB_WIDTH, THUMB_HEIGHT);
  const ctx = canvas.getContext('2d')!;
  const iterations = DRAG_HZ * DRAG_SECONDS;
  const latenciesMs: number[] = [];
  let hitCount = 0;
  let missCount = 0;

  const t0 = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    const frac = i / (iterations - 1);
    const idx = Math.min(bitmaps.length - 1, Math.round(frac * (bitmaps.length - 1)));
    const it0 = performance.now();
    const bitmap = bitmaps[idx];
    if (bitmap) {
      ctx.drawImage(bitmap, 0, 0);
      hitCount += 1;
    } else {
      missCount += 1;
    }
    latenciesMs.push(performance.now() - it0);
  }
  const totalMs = performance.now() - t0;

  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
  const budgetMs = 1000 / DRAG_HZ;

  return {
    iterations,
    p50Ms: pct(50),
    p95Ms: pct(95),
    maxMs: sorted[sorted.length - 1] ?? 0,
    totalMs,
    sustainable60Hz: (sorted[sorted.length - 1] ?? Infinity) < budgetMs,
    hitCount,
    missCount,
  };
}

export function closeAllBitmaps(bitmaps: ImageBitmap[]): void {
  for (const b of bitmaps) b.close();
}

/** baselineBytes should be the heap reading from BEFORE the cache was built (CacheStats.heapBeforeBuildBytes), not right before closing -- that's what "returns to baseline" is measured against. */
export async function measureHeapAfterClose(baselineBytes: number | null): Promise<CloseStats> {
  const heapAfterCloseBytes = heapBytes();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const heapAfterGcDelayBytes = heapBytes();
  const heapReturnedToBaseline =
    baselineBytes !== null && heapAfterGcDelayBytes !== null ? heapAfterGcDelayBytes < baselineBytes * 1.2 : null;
  return { heapAfterCloseBytes, heapAfterGcDelayBytes, heapReturnedToBaseline };
}
