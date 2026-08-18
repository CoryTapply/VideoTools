// The only WebCodecs-touching implementation of WaveformDecoder, mirroring
// src/media/frames/RealFrameDecoder.ts's role and porting its hard-won defensive pattern rather
// than assuming a fresh WebCodecs code path behaves the same way untested:
//   - flush() is timeout-raced, not bare-awaited -- RealFrameDecoder.ts's header comment documents
//     a real observed VideoDecoder flush() hang with no error() callback ever firing; ported here
//     as cheap insurance, NOT because the same has been observed for AudioDecoder (it hasn't been
//     exercised in a real browser at all yet -- see this module's README's "needs a real browser"
//     list).
//   - a decoder error() must reject every currently-pending output, not just log.
//   - decodeBatch() throws/rejects leave settled-but-unclosed AudioData reachable via
//     closeSettledChunks(), the same leak-prevention shape RealFrameDecoder.ts uses for VideoFrame.
//
// Deliberately simpler than RealFrameDecoder.ts in two ways specific to audio, not oversights:
//   - No hardware/software acceleration toggle -- AudioDecoder has no such option; audio decode is
//     software-only.
//   - No groupIntoFlushBatches decode-chain logic -- audio has no B-frame-style dependency chain
//     (every AAC chunk decodes independently), so batches are just fixed-size slices of `flushEvery`
//     jobs. flush() here exists purely for periodic progress/cancellation checkpoints on a long
//     track, not to preserve chain state across a flush boundary the way video's does.
//
// UNVERIFIED, flagged rather than assumed (see this module's README): whether AudioDecoder
// buffers output until flush() the same way VideoDecoder does (the assumption the flushEvery
// checkpoint design rests on), and whether Chrome's real behavior matches any of the above at all
// -- this file has not been run against a real AudioDecoder yet.

import { withFrame, type FrameLifecycleRegistry } from '../frames/frame-lifecycle';
import { DEFAULT_FLUSH_EVERY, type DecodeAudioJob, type DecodedAudioChunk, type WaveformDecodeBatchResult, type WaveformDecodeError, type WaveformDecoder, type WaveformDecoderConfig } from './WaveformDecoder';

class RealDecodedAudioChunk implements DecodedAudioChunk {
  private readonly data: AudioData;

  constructor(data: AudioData) {
    this.data = data;
  }

  get numberOfChannels(): number {
    return this.data.numberOfChannels;
  }

  get numberOfFrames(): number {
    return this.data.numberOfFrames;
  }

  get sampleRate(): number {
    return this.data.sampleRate;
  }

  copyTo(destination: Float32Array, planeIndex: number): void {
    this.data.copyTo(destination, { planeIndex, format: 'f32-planar' });
  }

  close(): void {
    this.data.close();
  }
}

/** Mirrors RealFrameDecoder.ts's closeSettledFrames(): closes every AudioData among `promises` that has already resolved by the time decodeBatch() bails out of a batch, so a settled-but-never-reached chunk doesn't leak. */
function closeSettledChunks(promises: readonly Promise<AudioData>[]): void {
  for (const p of promises) {
    p.then((chunk) => { chunk.close(); }).catch(() => { /* rejection carries no chunk to close */ });
  }
}

export class RealWaveformDecoder implements WaveformDecoder {
  private decoder: AudioDecoder | undefined;
  private pending: Array<{ resolve: (chunk: AudioData) => void; reject: (err: Error) => void }> = [];
  /** Captures an error() callback that fires with nothing in `pending` (e.g. configure() rejected asynchronously before any decode() call) -- see RealFrameDecoder.ts's identical field for the full reasoning. */
  private lastDecoderError: string | undefined;
  private readonly registry: FrameLifecycleRegistry;

  constructor(registry: FrameLifecycleRegistry) {
    this.registry = registry;
  }

  async isConfigSupported(config: WaveformDecoderConfig): Promise<boolean> {
    const support = await AudioDecoder.isConfigSupported(this.toAudioDecoderConfig(config));
    return support.supported ?? false;
  }

  configure(config: WaveformDecoderConfig): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.pending = [];
    this.lastDecoderError = undefined;

    const decoder = new AudioDecoder({
      output: (chunk) => {
        const entry = this.pending.shift();
        if (entry) entry.resolve(chunk);
        else chunk.close(); // shouldn't happen -- output() firing with nothing pending would otherwise leak
      },
      error: (err) => {
        this.lastDecoderError = err instanceof Error ? err.message : String(err);
        const failed = this.pending;
        this.pending = [];
        for (const entry of failed) entry.reject(err instanceof Error ? err : new Error(String(err)));
      },
    });
    decoder.configure(this.toAudioDecoderConfig(config));
    this.decoder = decoder;
  }

  async decodeBatch(jobs: readonly DecodeAudioJob[], onChunk: (chunk: DecodedAudioChunk) => void, flushEvery = DEFAULT_FLUSH_EVERY): Promise<WaveformDecodeBatchResult> {
    const decoder = this.decoder;
    if (!decoder) throw new Error('RealWaveformDecoder: decodeBatch() before configure()');

    const errors: WaveformDecodeError[] = [];

    outer: for (let start = 0; start < jobs.length; start += flushEvery) {
      const group = jobs.slice(start, start + flushEvery);

      if (decoder.state === 'closed') {
        errors.push({ kind: 'decode-error', message: this.lastDecoderError ?? 'decoder closed before this batch could run (no error() detail captured)', jobId: group[0]?.id ?? -1 });
        break;
      }

      const chunkPromises: Promise<AudioData>[] = [];
      try {
        for (const job of group) {
          const encoded = new EncodedAudioChunk({ type: 'key', timestamp: job.presentationTime, data: job.data });
          const chunkPromise = new Promise<AudioData>((resolve, reject) => {
            this.pending.push({ resolve, reject });
          });
          chunkPromises.push(chunkPromise);
          decoder.decode(encoded);
        }
      } catch (err) {
        errors.push({ kind: 'decode-error', message: this.lastDecoderError ?? (err instanceof Error ? err.message : String(err)), jobId: group[0]?.id ?? -1 });
        this.pending = [];
        closeSettledChunks(chunkPromises);
        break;
      }

      // Timeout-raced, not a bare await -- see this file's header comment on why, ported from
      // RealFrameDecoder.ts as insurance despite not having observed the same hang for AudioDecoder.
      const timeoutMs = Math.max(3_000, group.length * 200);
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`flush() timed out after ${String(timeoutMs)}ms (batch of ${String(group.length)}, first jobId=${String(group[0]?.id ?? -1)}, decoder.state=${decoder.state}, decodeQueueSize=${String(decoder.decodeQueueSize)})`));
        }, timeoutMs);
      });
      try {
        await Promise.race([decoder.flush(), timeout]);
      } catch (err) {
        errors.push({ kind: 'decode-error', message: err instanceof Error ? err.message : String(err), jobId: group[0]?.id ?? -1 });
        this.pending = [];
        closeSettledChunks(chunkPromises);
        break;
      } finally {
        clearTimeout(timeoutHandle);
      }

      for (const [i, job] of group.entries()) {
        let chunk: AudioData;
        try {
          chunk = await chunkPromises[i];
        } catch (err) {
          errors.push({ kind: 'decode-error', message: err instanceof Error ? err.message : String(err), jobId: job.id });
          break outer; // matches real WebCodecs: an error() callback leaves the decoder unusable
        }
        withFrame(this.registry, new RealDecodedAudioChunk(chunk), `audio-chunk-${String(job.id)}`, onChunk);
      }
    }

    return { errors };
  }

  private toAudioDecoderConfig(config: WaveformDecoderConfig): AudioDecoderConfig {
    return { codec: config.codec, sampleRate: config.sampleRate, numberOfChannels: config.numberOfChannels, description: config.description };
  }

  close(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = undefined;
  }
}
