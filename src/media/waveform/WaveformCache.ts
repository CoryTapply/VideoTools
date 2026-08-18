// Public API and top-level orchestrator, mirroring src/media/frames/FrameCache.ts's role as this
// module's entry point -- but structurally simpler in two ways specific to audio (see this
// module's README for the full reasoning, not repeated here):
//   - No coarse/dense tier split. Every AAC frame decodes independently regardless of target
//     resolution -- there's no keyframe-style shortcut the way video has, so there's nothing to
//     split a "cheap whole-file pass" from a "targeted expensive pass" around.
//   - No LRU/eviction. The whole pyramid for a realistic file is a handful of plain Int16Arrays
//     (tens of MB even at 4hr/stereo, see pyramid.ts's size math) -- nothing GPU-backed, nothing
//     worth budgeting against.
//
// One WaveformCache serves exactly one audio track. A file with multiple audio tracks (e.g.
// fixtures/27gb.mp4's six) needs one instance per track a caller actually wants a waveform for --
// build() is never called eagerly for every track at file-open, mirroring the frame cache's dense
// tier's own "only warm what's needed" precedent. Unlike FrameCache, this class does NOT own or
// dispose() the WorkerPool passed into it: a single-worker pool (this module's MVP scope, see
// worker-pool.ts's header comment) is a natural resource to SHARE across several WaveformCache
// instances for the same file, so pool lifecycle is the caller's responsibility.

import { extractAudioSpecificConfig } from '../index/moov/stbl/stsd';
import type { FileFingerprint } from '../index/fingerprint';
import type { SampleIndex } from '../index/query';
import { buildWaveformJobs } from './job-builder';
import { readPyramidCache, writePyramidCache, type CachedPyramid } from './opfs-cache';
import { PEAK_INT16_MAX, type PyramidLevel } from './pyramid';
import type { PeakColumn, Time } from './types';
import { formatWaveformDecodeError } from './WaveformDecoder';
import type { WaveformWorkerPool } from './worker-pool';

export interface WaveformCacheOptions {
  readonly sampleIndex: SampleIndex;
  readonly audioTrackId: number;
  readonly pool: WaveformWorkerPool;
  /** Forwarded to the decoder -- see WaveformDecoder.decodeBatch()'s doc comment. */
  readonly flushEvery?: number;
  /**
   * Read before building (a hit skips decode entirely) and written after a successful build --
   * both optional. A caller without a real fingerprint (e.g. a Node test, or a file whose
   * fingerprint hasn't been computed yet) just gets no caching, not an error.
   */
  readonly fingerprint?: FileFingerprint;
  /** Decode errors and OPFS cache degradation. Defaults to console.warn, matching FrameCacheOptions.onError's precedent. */
  readonly onError?: (message: string, detail: unknown) => void;
}

export interface WaveformCacheStats {
  readonly built: boolean;
  readonly levelCount: number;
  readonly l0BucketCount: number;
  readonly channelCount: number;
}

export class WaveformCache {
  private readonly sampleIndex: SampleIndex;
  private readonly trackId: number;
  private readonly pool: WaveformWorkerPool;
  private readonly flushEvery: number | undefined;
  private readonly fingerprint: FileFingerprint | undefined;
  private readonly onError: (message: string, detail: unknown) => void;
  private readonly startTime: Time;
  /**
   * Ticks per raw PCM sample -- `timescale / sampleRate`, assumed to be exactly 1 (i.e.
   * timescale === sampleRate) for essentially every real MP4 audio track, but computed rather than
   * hardcoded in case a file doesn't follow that convention. NOT verified against a real file with
   * a mismatched timescale/sampleRate -- flagged in this module's README as an assumption, not a
   * confirmed invariant.
   */
  private readonly ticksPerRawSample: number;

  private levels: readonly PyramidLevel[] = [];
  private channelCount = 0;
  private buildPromise: Promise<void> | undefined;
  private disposed = false;
  private nextRequestIdValue = 1;
  private inFlightRequestId: number | undefined;

  constructor(options: WaveformCacheOptions) {
    const track = options.sampleIndex.tracks().find((t) => t.trackId === options.audioTrackId);
    if (!track?.audio) throw new Error(`WaveformCache: track ${String(options.audioTrackId)} is not an audio track with decodable metadata`);

    this.sampleIndex = options.sampleIndex;
    this.trackId = options.audioTrackId;
    this.pool = options.pool;
    this.flushEvery = options.flushEvery;
    this.fingerprint = options.fingerprint;
    this.onError = options.onError ?? ((message, detail) => { console.warn(`waveform cache: ${message}`, detail); });
    this.ticksPerRawSample = track.timescale / track.audio.sampleRate;

    const firstN = options.sampleIndex.sampleAtPresentationRank(this.trackId, 0);
    this.startTime = firstN < 0 ? 0 : options.sampleIndex.presentationTimeOfSample(this.trackId, firstN);
  }

  get isBuilt(): boolean {
    return this.levels.length > 0;
  }

  /** Idempotent: concurrent/duplicate calls share the same in-flight build. Tries the OPFS cache first (if a fingerprint was provided); on a miss, decodes for real and writes the result back. Resolves without throwing on a decode error or a cancellation -- check isBuilt/stats() and the onError callback, mirroring FrameCache.warmCoarse()'s "errors are reported, not thrown" convention. */
  async build(): Promise<void> {
    if (this.disposed || this.isBuilt) return;
    if (this.buildPromise) {
      await this.buildPromise;
      return;
    }
    this.buildPromise = this.doBuild();
    try {
      await this.buildPromise;
    } finally {
      this.buildPromise = undefined;
    }
  }

  private async doBuild(): Promise<void> {
    if (this.fingerprint) {
      const cached = await readPyramidCache(this.fingerprint, this.trackId);
      if (cached.kind === 'hit') {
        this.levels = cached.pyramid.levels;
        this.channelCount = cached.pyramid.channelCount;
        return;
      }
      if (cached.kind === 'corrupt' || cached.kind === 'stale-schema') {
        this.onError(`waveform OPFS cache ${cached.kind}, rebuilding`, cached);
      }
    }

    const track = this.sampleIndex.tracks().find((t) => t.trackId === this.trackId);
    if (!track?.audio) return; // constructor already validated this -- defensive only, e.g. a future mutation of the underlying index

    const jobs = buildWaveformJobs(this.sampleIndex, this.trackId);
    const requestId = this.nextRequestId();
    this.inFlightRequestId = requestId;

    const result = await this.pool.submit({
      requestId,
      config: { codec: track.codec, sampleRate: track.audio.sampleRate, numberOfChannels: track.audio.channelCount, description: extractAudioSpecificConfig(track.description) },
      jobs: jobs.map((j, i) => ({ id: i, offset: j.offset, size: j.size, presentationTime: j.presentationTime })),
      flushEvery: this.flushEvery,
    });

    if (this.inFlightRequestId === requestId) this.inFlightRequestId = undefined;
    if (this.disposed || result.cancelled) return;

    if (result.errors.length > 0) {
      this.onError(`waveform build (${String(jobs.length)} jobs) had ${String(result.errors.length)} decode error(s): ${result.errors.map(formatWaveformDecodeError).join('; ')}`, result.errors);
      return;
    }

    this.levels = result.pyramid;
    this.channelCount = track.audio.channelCount;

    if (this.fingerprint) {
      const cachedPyramid: CachedPyramid = { trackId: this.trackId, channelCount: this.channelCount, sampleRate: track.audio.sampleRate, levels: this.levels };
      const writeResult = await writePyramidCache(cachedPyramid, this.fingerprint);
      if (writeResult.kind === 'quota-exceeded') this.onError('waveform OPFS cache write degraded to quota-exceeded (memory-only)', writeResult);
    }
  }

  /**
   * `count` evenly-spaced columns across [from, to), picking the finest pyramid level whose
   * density still covers the requested span without over-fetching (mipmap-style LOD selection),
   * per-column bucket lookup by direct index math (no binary search needed -- unlike FrameCache's
   * getNearest, bucket boundaries here are exact multiples of samplesPerBucket, not irregularly
   * spaced keyframe times). Null for a column outside the pyramid's covered range, or before
   * build() has resolved. No 60Hz zero-allocation constraint (unlike FrameCache.getNearest) -- a
   * waveform repaint is once per viewport tick, not per pointermove.
   */
  getRange(from: Time, to: Time, count: number): (PeakColumn | null)[] {
    if (count <= 0) return [];
    if (!this.isBuilt) return new Array<PeakColumn | null>(count).fill(null);
    const level = this.pickLevel(from, to, count);
    const step = count === 1 ? 0 : (to - from) / (count - 1);
    return Array.from({ length: count }, (_unused, i) => this.columnAt(level, from + step * i));
  }

  stats(): WaveformCacheStats {
    return {
      built: this.isBuilt,
      levelCount: this.levels.length,
      l0BucketCount: this.levels[0]?.bucketCount ?? 0,
      channelCount: this.channelCount,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.inFlightRequestId !== undefined) {
      this.pool.cancel(this.inFlightRequestId);
      this.inFlightRequestId = undefined;
    }
    this.levels = [];
    this.channelCount = 0;
  }

  private pickLevel(from: Time, to: Time, count: number): PyramidLevel {
    const spanTicks = Math.max(1, to - from);
    const desiredSamplesPerBucket = spanTicks / this.ticksPerRawSample / count;
    for (const level of this.levels) {
      if (level.samplesPerBucket >= desiredSamplesPerBucket) return level;
    }
    return this.levels[this.levels.length - 1];
  }

  private columnAt(level: PyramidLevel, time: Time): PeakColumn | null {
    const samplePos = (time - this.startTime) / this.ticksPerRawSample;
    const bucketIndex = Math.floor(samplePos / level.samplesPerBucket);
    if (bucketIndex < 0 || bucketIndex >= level.bucketCount) return null;
    const channels = Array.from({ length: this.channelCount }, (_unused, ch) => ({
      min: level.min[ch][bucketIndex] / PEAK_INT16_MAX,
      max: level.max[ch][bucketIndex] / PEAK_INT16_MAX,
    }));
    return { time, channels };
  }

  private nextRequestId(): number {
    const id = this.nextRequestIdValue;
    this.nextRequestIdValue += 1;
    return id;
  }
}
