import { describe, expect, it, vi } from 'vitest';
import { SampleIndex } from '../index/query';
import type { TrackIndex } from '../index/track-index';
import { PyramidBuilder } from './pyramid';
import { WaveformCache } from './WaveformCache';
import { WaveformWorkerPool, type WorkerBuildRequest, type WorkerBuildResult, type WorkerHandle } from './worker-pool';

function quantize(sample: number): number {
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return Math.round(clamped * 32767);
}

/** Builds a real pyramid from each request's jobs deterministically (magnitude = (job.id%10 + 1)/10, ch0 positive / ch1 negative, `framesPerJob` identical samples per job) -- realistic enough to drive WaveformCache's real getRange/stats logic without a real AudioDecoder, mirroring frames/FrameCache.test.ts's ImmediateWorkerHandle pattern. */
class ImmediateWorkerHandle implements WorkerHandle {
  buildCalls: WorkerBuildRequest[] = [];
  cancelledIds = new Set<number>();
  private readonly held = new Map<number, { resolve: (result: WorkerBuildResult) => void }>();
  private readonly holdRequestIds: Set<number>;
  private readonly framesPerJob: number;
  private readonly l0: number;
  private readonly ratio: number;
  private readonly errorOnRequestId: number | undefined;

  constructor(options: { holdRequestIds?: Set<number>; framesPerJob?: number; l0?: number; ratio?: number; errorOnRequestId?: number } = {}) {
    this.holdRequestIds = options.holdRequestIds ?? new Set();
    this.framesPerJob = options.framesPerJob ?? 4;
    this.l0 = options.l0 ?? 4;
    this.ratio = options.ratio ?? 2;
    this.errorOnRequestId = options.errorOnRequestId;
  }

  build(request: WorkerBuildRequest): Promise<WorkerBuildResult> {
    this.buildCalls.push(request);
    const doBuild = (): WorkerBuildResult => {
      if (this.cancelledIds.has(request.requestId)) return { requestId: request.requestId, pyramid: [], errors: [], cancelled: true };
      if (this.errorOnRequestId === request.requestId) return { requestId: request.requestId, pyramid: [], errors: [{ kind: 'decode-error', message: 'simulated', jobId: request.jobs[0]?.id ?? -1 }], cancelled: false };
      const builder = new PyramidBuilder(request.config.numberOfChannels, this.l0, this.ratio);
      for (const job of request.jobs) {
        for (let ch = 0; ch < request.config.numberOfChannels; ch += 1) {
          const magnitude = ((job.id % 10) + 1) / 10;
          const value = ch % 2 === 0 ? magnitude : -magnitude;
          builder.push(ch, Float32Array.from({ length: this.framesPerJob }, () => value));
        }
      }
      return { requestId: request.requestId, pyramid: builder.finish(), errors: [], cancelled: false };
    };
    if (this.holdRequestIds.has(request.requestId)) {
      return new Promise((resolve) => {
        this.held.set(request.requestId, { resolve: () => { resolve(doBuild()); } });
      });
    }
    return Promise.resolve(doBuild());
  }

  release(requestId: number): void {
    this.held.get(requestId)?.resolve({ requestId, pyramid: [], errors: [], cancelled: false });
  }

  cancel(requestId: number): void {
    this.cancelledIds.add(requestId);
    const entry = this.held.get(requestId);
    if (entry) {
      this.held.delete(requestId);
      entry.resolve({ requestId, pyramid: [], errors: [], cancelled: true });
    }
  }

  terminate(): void {}
}

/** 5 samples, 1024-tick-spaced presentation times, timescale === sampleRate (ticksPerRawSample === 1), no edit list. */
function makeAudioTrack(overrides: Partial<TrackIndex> = {}): TrackIndex {
  const sampleCount = 5;
  const pts = Float64Array.from({ length: sampleCount }, (_, i) => i * 1024);
  return {
    trackId: 2,
    kind: 'audio',
    handlerType: 'soun',
    codec: 'mp4a.40.2',
    timescale: 48000,
    duration: sampleCount * 1024,
    sampleCount,
    pts,
    dts: pts.slice(),
    offset: Float64Array.from({ length: sampleCount }, (_, i) => i * 500),
    size: Uint32Array.from({ length: sampleCount }, () => 200),
    isSync: new Uint8Array(sampleCount).fill(1),
    description: new Uint8Array([1, 2, 3]),
    audio: { channelCount: 2, sampleRate: 48000, language: 'und', handlerName: '' },
    editOffsetTicks: 0,
    ...overrides,
  };
}

function makeCache(pool: WaveformWorkerPool, overrides: Partial<ConstructorParameters<typeof WaveformCache>[0]> = {}): WaveformCache {
  const sampleIndex = new SampleIndex([makeAudioTrack()]);
  return new WaveformCache({ sampleIndex, audioTrackId: 2, pool, ...overrides });
}

describe('WaveformCache construction', () => {
  it('throws if the given trackId is not an audio track', () => {
    const sampleIndex = new SampleIndex([makeAudioTrack({ trackId: 1, kind: 'video', audio: undefined, video: { codedWidth: 1, codedHeight: 1, displayWidth: 1, displayHeight: 1, rotationDegrees: 0, nominalFrameRate: 30, constantDuration: true } })]);
    const pool = new WaveformWorkerPool([new ImmediateWorkerHandle()]);
    expect(() => new WaveformCache({ sampleIndex, audioTrackId: 1, pool })).toThrow(/audio track/);
  });
});

describe('WaveformCache.build / isBuilt / stats', () => {
  it('is not built before build() resolves', () => {
    const pool = new WaveformWorkerPool([new ImmediateWorkerHandle()]);
    const cache = makeCache(pool);
    expect(cache.isBuilt).toBe(false);
    expect(cache.stats()).toEqual({ built: false, levelCount: 0, l0BucketCount: 0, channelCount: 0 });
  });

  it('builds a real multi-level pyramid from the track (5 samples, l0=4/ratio=2 -> levels of 5,3,2,1 buckets)', async () => {
    const pool = new WaveformWorkerPool([new ImmediateWorkerHandle()]);
    const cache = makeCache(pool);
    await cache.build();
    expect(cache.isBuilt).toBe(true);
    expect(cache.stats()).toEqual({ built: true, levelCount: 4, l0BucketCount: 5, channelCount: 2 });
  });

  it('build() is idempotent: a second call after completion does not dispatch another request', async () => {
    const handle = new ImmediateWorkerHandle();
    const pool = new WaveformWorkerPool([handle]);
    const cache = makeCache(pool);
    await cache.build();
    await cache.build();
    expect(handle.buildCalls).toHaveLength(1);
  });

  it('concurrent build() calls share the same in-flight request', async () => {
    const handle = new ImmediateWorkerHandle({ holdRequestIds: new Set([1]) });
    const pool = new WaveformWorkerPool([handle]);
    const cache = makeCache(pool);
    const p1 = cache.build();
    const p2 = cache.build();
    handle.release(1);
    await Promise.all([p1, p2]);
    expect(handle.buildCalls).toHaveLength(1);
    expect(cache.isBuilt).toBe(true);
  });

  it('a decode error leaves isBuilt false and calls onError, without throwing', async () => {
    const handle = new ImmediateWorkerHandle({ errorOnRequestId: 1 });
    const pool = new WaveformWorkerPool([handle]);
    const onError = vi.fn();
    const cache = makeCache(pool, { onError });
    await expect(cache.build()).resolves.toBeUndefined();
    expect(cache.isBuilt).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('WaveformCache.getRange', () => {
  it('returns an all-null array before build() has resolved', () => {
    const pool = new WaveformWorkerPool([new ImmediateWorkerHandle()]);
    const cache = makeCache(pool);
    expect(cache.getRange(0, 20, 3)).toEqual([null, null, null]);
  });

  it('returns [] for a non-positive count', async () => {
    const pool = new WaveformWorkerPool([new ImmediateWorkerHandle()]);
    const cache = makeCache(pool);
    await cache.build();
    expect(cache.getRange(0, 20, 0)).toEqual([]);
  });

  it('picks the finest level dense enough to cover the request, returning exact de-quantized job-magnitude columns', async () => {
    const pool = new WaveformWorkerPool([new ImmediateWorkerHandle()]);
    const cache = makeCache(pool);
    await cache.build();

    // count=5 over [0,16): step=4, times=[0,4,8,12,16] -- desiredSamplesPerBucket = 16/1/5 = 3.2,
    // so L0 (samplesPerBucket=4) is chosen, landing exactly on L0 buckets [0..4], one per job.
    // Each job pushed 4 IDENTICAL samples, so its L0 bucket has min === max === that job's value.
    const columns = cache.getRange(0, 16, 5);
    expect(columns.every((c) => c !== null)).toBe(true);
    for (const [i, col] of columns.entries()) {
      const magnitude = (i + 1) / 10; // job i's ch0 value; ch1 is its negation
      expect(col?.time).toBe(i * 4);
      expect(col?.channels[0]).toEqual({ min: quantize(magnitude) / 32767, max: quantize(magnitude) / 32767 });
      expect(col?.channels[1]).toEqual({ min: quantize(-magnitude) / 32767, max: quantize(-magnitude) / 32767 });
    }
  });

  it('picks a coarser level when the requested density is lower, aggregating multiple jobs into one column', async () => {
    const pool = new WaveformWorkerPool([new ImmediateWorkerHandle()]);
    const cache = makeCache(pool);
    await cache.build();

    // count=1 over the full span [0,20) forces the coarsest (top) level -- exactly one bucket
    // covering every job, so min/max span the full range of magnitudes 0.1..0.5. Ch0 is always
    // positive (0.1..0.5), ch1 is its negation (-0.1..-0.5).
    const columns = cache.getRange(0, 20, 1);
    expect(columns).toHaveLength(1);
    const col = columns[0];
    expect(col?.channels[0]).toEqual({ min: quantize(0.1) / 32767, max: quantize(0.5) / 32767 });
    expect(col?.channels[1]).toEqual({ min: quantize(-0.5) / 32767, max: quantize(-0.1) / 32767 });
  });

  it('returns null for a column outside the pyramid-covered sample range', async () => {
    const pool = new WaveformWorkerPool([new ImmediateWorkerHandle()]);
    const cache = makeCache(pool);
    await cache.build();
    const columns = cache.getRange(-100, -50, 2);
    expect(columns).toEqual([null, null]);
  });
});

describe('WaveformCache.dispose', () => {
  it('cancels an in-flight build via the pool', async () => {
    const handle = new ImmediateWorkerHandle({ holdRequestIds: new Set([1]) });
    const pool = new WaveformWorkerPool([handle]);
    const cache = makeCache(pool);
    const buildPromise = cache.build();
    cache.dispose();
    await buildPromise;
    expect(handle.cancelledIds.has(1)).toBe(true);
    expect(cache.isBuilt).toBe(false);
  });
});
