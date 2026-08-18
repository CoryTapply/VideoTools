// The Node-testable double for WaveformDecoder -- same trick src/media/frames/FakeFrameDecoder.ts
// plays, for the same reason: job dispatch, the worker pool, and (most importantly) the pyramid
// reduction wiring need to be provably correct without a real AudioDecoder. Configurable latency
// and failure injection so the pool/cache's cancellation and error-recovery paths can be exercised
// deterministically, and a configurable sample generator so a test can assert exact pyramid output
// end to end without depending on real decoder internals.

import type { DecodeAudioJob, DecodedAudioChunk, WaveformDecodeBatchResult, WaveformDecodeError, WaveformDecoder, WaveformDecoderConfig } from './WaveformDecoder';

export type SampleGenerator = (job: DecodeAudioJob, channelIndex: number, frameIndex: number) => number;

/** A simple, deterministic default: channel 0 ramps with job.id, channel 1 (if present) is its negation -- distinct enough per job/channel that a test can assert exact pyramid buckets without hand-picking values. */
const defaultGenerateSample: SampleGenerator = (job, channelIndex) => {
  const magnitude = ((job.id % 10) + 1) / 10; // 0.1..1.0, deterministic and in-range
  return channelIndex % 2 === 0 ? magnitude : -magnitude;
};

export interface FakeWaveformDecoderOptions {
  supported?: boolean | ((config: WaveformDecoderConfig) => boolean);
  /** Fixed delay, or a function called once per decodeBatch() invocation, before it resolves. Default 0. */
  latencyMs?: number | (() => number);
  /**
   * If set, the job with this id fails: every job before it in the batch still calls onChunk (if
   * kept), the failing job produces a decode-error and nothing after it in the batch runs --
   * matching real WebCodecs, where an error() callback leaves the decoder unusable. Only fires
   * once (matches "the decoder instance is unusable after this").
   */
  failOnJobId?: number;
  /** Samples (frames) per decoded chunk. Default 4. */
  framesPerJob?: number;
  generateSample?: SampleGenerator;
}

class FakeAudioChunk implements DecodedAudioChunk {
  closed = false;
  readonly numberOfChannels: number;
  readonly numberOfFrames: number;
  readonly sampleRate: number;
  private readonly samples: readonly Float32Array[]; // per channel

  constructor(numberOfChannels: number, numberOfFrames: number, sampleRate: number, samples: readonly Float32Array[]) {
    this.numberOfChannels = numberOfChannels;
    this.numberOfFrames = numberOfFrames;
    this.sampleRate = sampleRate;
    this.samples = samples;
  }

  copyTo(destination: Float32Array, planeIndex: number): void {
    if (this.closed) throw new Error('FakeAudioChunk: copyTo() after close()');
    destination.set(this.samples[planeIndex].subarray(0, this.numberOfFrames));
  }

  close(): void {
    if (this.closed) throw new Error('FakeAudioChunk: double close()');
    this.closed = true;
  }
}

export class FakeWaveformDecoder implements WaveformDecoder {
  decodeCount = 0;
  closeCount = 0;
  configureCount = 0;
  closed = false;
  readonly producedChunks: FakeAudioChunk[] = [];

  private readonly supported: boolean | ((config: WaveformDecoderConfig) => boolean);
  private readonly latencyMs: number | (() => number);
  private failOnJobId: number | undefined;
  private readonly framesPerJob: number;
  private readonly generateSample: SampleGenerator;
  private configured = false;
  private numberOfChannels = 0;
  private sampleRate = 0;

  constructor(options: FakeWaveformDecoderOptions = {}) {
    this.supported = options.supported ?? true;
    this.latencyMs = options.latencyMs ?? 0;
    this.failOnJobId = options.failOnJobId;
    this.framesPerJob = options.framesPerJob ?? 4;
    this.generateSample = options.generateSample ?? defaultGenerateSample;
  }

  isConfigSupported(config: WaveformDecoderConfig): Promise<boolean> {
    return Promise.resolve(typeof this.supported === 'function' ? this.supported(config) : this.supported);
  }

  configure(config: WaveformDecoderConfig): void {
    if (this.closed) throw new Error('FakeWaveformDecoder: configure() after close()');
    this.configureCount += 1;
    this.configured = true;
    this.numberOfChannels = config.numberOfChannels;
    this.sampleRate = config.sampleRate;
  }

  async decodeBatch(jobs: readonly DecodeAudioJob[], onChunk: (chunk: DecodedAudioChunk) => void, flushEvery?: number): Promise<WaveformDecodeBatchResult> {
    if (this.closed) throw new Error('FakeWaveformDecoder: decodeBatch() after close()');
    if (!this.configured) throw new Error('FakeWaveformDecoder: decodeBatch() before configure()');
    void flushEvery; // the fake has no real flush() to amortize -- only a real decoder's throughput cares

    const latency = typeof this.latencyMs === 'function' ? this.latencyMs() : this.latencyMs;
    if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));

    const errors: WaveformDecodeError[] = [];

    for (const job of jobs) {
      this.decodeCount += 1;
      if (this.failOnJobId !== undefined && job.id === this.failOnJobId) {
        errors.push({ kind: 'decode-error', message: 'FakeWaveformDecoder: simulated decode failure', jobId: job.id });
        this.closed = true; // mirrors real WebCodecs: an error() callback leaves the decoder unusable
        this.failOnJobId = undefined;
        break;
      }

      const samples = Array.from({ length: this.numberOfChannels }, (_unused, ch) => Float32Array.from({ length: this.framesPerJob }, (_frame, i) => this.generateSample(job, ch, i)));
      const chunk = new FakeAudioChunk(this.numberOfChannels, this.framesPerJob, this.sampleRate, samples);
      this.producedChunks.push(chunk);
      // Mirrors RealWaveformDecoder's contract: onChunk() must consume synchronously, and the
      // chunk is closed immediately after onChunk() returns -- no reference may escape.
      onChunk(chunk);
      chunk.close();
    }

    return { errors };
  }

  close(): void {
    this.closeCount += 1;
    this.closed = true;
  }
}
