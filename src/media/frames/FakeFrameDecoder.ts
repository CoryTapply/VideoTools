// The Node-testable double for FrameDecoder -- same trick src/media/playback/FakeVideoElement.ts
// and src/media/index/sources/buffer-byte-source.ts play, for the same reason: batching,
// scheduling, LRU and atlas logic need to be provably correct without a real WebCodecs decoder.
// Configurable latency and failure injection so the scheduler/pool's cancellation and
// error-recovery paths (the two places frames get orphaned, per the task prompt's repeated
// warning) can be exercised deterministically.

import type { DecodeJob, DecodedBitmap, DecodedThumbnail, FrameDecodeBatchResult, FrameDecodeError, FrameDecoder, FrameDecoderConfig, ThumbnailSize } from './FrameDecoder';

export interface FakeFrameDecoderOptions {
  supported?: boolean | ((config: FrameDecoderConfig) => boolean);
  /** Fixed delay, or a function called once per decodeBatch() invocation, before it resolves. Default 0. */
  latencyMs?: number | (() => number);
  /**
   * If set, the job with this id fails: every job before it in the batch still produces a
   * thumbnail (if kept), the failing job produces a decode-error and nothing after it in the
   * batch runs -- matching real WebCodecs, where an error() callback leaves the decoder
   * unusable. Only fires once (matches "the decoder instance is unusable after this").
   */
  failOnJobId?: number;
}

class FakeBitmap implements DecodedBitmap {
  closed = false;
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  close(): void {
    if (this.closed) throw new Error('FakeBitmap: double close()');
    this.closed = true;
  }
}

export class FakeFrameDecoder implements FrameDecoder {
  decodeCount = 0;
  closeCount = 0;
  configureCount = 0;
  closed = false;
  readonly producedBitmaps: FakeBitmap[] = [];

  private readonly supported: boolean | ((config: FrameDecoderConfig) => boolean);
  private readonly latencyMs: number | (() => number);
  private failOnJobId: number | undefined;
  private configured = false;

  constructor(options: FakeFrameDecoderOptions = {}) {
    this.supported = options.supported ?? true;
    this.latencyMs = options.latencyMs ?? 0;
    this.failOnJobId = options.failOnJobId;
  }

  isConfigSupported(config: FrameDecoderConfig): Promise<boolean> {
    return Promise.resolve(typeof this.supported === 'function' ? this.supported(config) : this.supported);
  }

  configure(config: FrameDecoderConfig): void {
    void config; // the fake doesn't need the real values, just that configure() was called before decodeBatch()
    if (this.closed) throw new Error('FakeFrameDecoder: configure() after close()');
    this.configureCount += 1;
    this.configured = true;
  }

  async decodeBatch(jobs: readonly DecodeJob[], size: ThumbnailSize, batchSize = 16): Promise<FrameDecodeBatchResult> {
    if (this.closed) throw new Error('FakeFrameDecoder: decodeBatch() after close()');
    if (!this.configured) throw new Error('FakeFrameDecoder: decodeBatch() before configure()');
    void batchSize; // the fake has no real flush() to amortize -- batchSize only matters to a real decoder's throughput

    const latency = typeof this.latencyMs === 'function' ? this.latencyMs() : this.latencyMs;
    if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));

    const thumbnails: DecodedThumbnail[] = [];
    const errors: FrameDecodeError[] = [];

    for (const job of jobs) {
      this.decodeCount += 1;
      if (this.failOnJobId !== undefined && job.id === this.failOnJobId) {
        errors.push({ kind: 'decode-error', message: 'FakeFrameDecoder: simulated decode failure', jobId: job.id });
        this.closed = true; // mirrors real WebCodecs: an error() callback leaves the decoder unusable
        this.failOnJobId = undefined;
        break;
      }
      if (job.keep) {
        const bitmap = new FakeBitmap(size.width, size.height);
        this.producedBitmaps.push(bitmap);
        thumbnails.push({ id: job.id, presentationTime: job.presentationTime, bitmap });
      }
    }

    return { thumbnails, errors };
  }

  close(): void {
    this.closeCount += 1;
    this.closed = true;
  }
}
