// The only WebCodecs-touching implementation of FrameDecoder, mirroring
// src/media/playback/RealVideoElement.ts's "only DOM-touching file in the core path" role.
// Ports spike C's hard-won findings (src/spikes/C-decode/decode-worker.ts) rather than
// rediscovering them:
//   - flush() is required at least once per batch -- this decoder does not emit output for
//     queued decode() calls otherwise.
//   - flush() itself is timeout-raced, not bare-awaited -- it can hang indefinitely on malformed
//     or unexpected input with no error() callback ever firing.
//   - a decoder error() must reject every currently-pending output, not just log -- otherwise a
//     single failed chunk hangs the batch forever (a real 4+ minute hang was observed before this
//     fix existed).
//   - this project's OBS fixture's keyframes carry in-band SPS/PPS/SEI NAL units ahead of the IDR
//     slice, which stalls this decoder when it's already configured with the same parameter sets
//     via `description` -- stripNonVclNals() removes them before decode().
// `hardwareAcceleration: 'prefer-hardware'` per the task prompt; a machine without hardware H.264
// decode measured ~4x slower in spike C, so which path is active is worth surfacing to a caller
// (see `hardwareAccelerationUsed` below) rather than left silent.

import { stripNonVclNals } from '../../spikes/C-decode/nal-strip';
import { withFrameAsync, type FrameLifecycleRegistry } from './frame-lifecycle';
import type { DecodeJob, DecodedThumbnail, FrameDecodeBatchResult, FrameDecodeError, FrameDecoder, FrameDecoderConfig, ThumbnailSize } from './FrameDecoder';

export class RealFrameDecoder implements FrameDecoder {
  /** Set once configure() resolves; reflects which decode path Chrome actually chose, not just what was requested. */
  hardwareAccelerationUsed: 'prefer-hardware' | 'prefer-software' | undefined;

  private decoder: VideoDecoder | undefined;
  private pending: Array<{ resolve: (frame: VideoFrame) => void; reject: (err: Error) => void }> = [];
  private readonly registry: FrameLifecycleRegistry;

  constructor(registry: FrameLifecycleRegistry) {
    this.registry = registry;
  }

  async isConfigSupported(config: FrameDecoderConfig): Promise<boolean> {
    const support = await VideoDecoder.isConfigSupported(this.toVideoDecoderConfig(config));
    return support.supported ?? false;
  }

  configure(config: FrameDecoderConfig): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.pending = [];

    const decoder = new VideoDecoder({
      output: (frame) => {
        const entry = this.pending.shift();
        if (entry) entry.resolve(frame);
        else frame.close(); // shouldn't happen -- output() firing with nothing pending would otherwise leak
      },
      error: (err) => {
        const failed = this.pending;
        this.pending = [];
        for (const entry of failed) entry.reject(err instanceof Error ? err : new Error(String(err)));
      },
    });
    decoder.configure(this.toVideoDecoderConfig(config));
    this.decoder = decoder;
    this.hardwareAccelerationUsed = 'prefer-hardware';
  }

  async decodeBatch(jobs: readonly DecodeJob[], size: ThumbnailSize, batchSize = 16): Promise<FrameDecodeBatchResult> {
    const decoder = this.decoder;
    if (!decoder) throw new Error('RealFrameDecoder: decodeBatch() before configure()');

    const thumbnails: DecodedThumbnail[] = [];
    const errors: FrameDecodeError[] = [];

    outer: for (let batchStart = 0; batchStart < jobs.length; batchStart += batchSize) {
      const batch = jobs.slice(batchStart, batchStart + batchSize);
      const framePromises: Promise<VideoFrame>[] = [];

      for (const job of batch) {
        const { result: bytes } = stripNonVclNals(job.data);
        const chunk = new EncodedVideoChunk({ type: job.type, timestamp: job.presentationTime, data: bytes });
        const framePromise = new Promise<VideoFrame>((resolve, reject) => {
          this.pending.push({ resolve, reject });
        });
        framePromises.push(framePromise);
        decoder.decode(chunk);
      }

      // NEVER flush speculatively mid-batch -- flush() resets the decoder's key-frame-required
      // flag, forcing an unwanted keyframe restart on the very next decode (spike C's "warm
      // decoder" finding). Exactly one flush() per batch, after every decode() in it is queued.
      //
      // Timeout-raced, not a bare await: spike C's decode-worker.ts found flush() itself can hang
      // indefinitely on malformed/unexpected input, with no error() callback ever firing -- ported
      // here rather than assumed safe, since dense-tier delta-frame decoding is a genuinely new
      // code path (every prior use of WebCodecs in this project, coarse tier included, only ever
      // decoded keyframes).
      const timeoutMs = Math.max(10_000, batch.length * 1_000);
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`flush() timed out after ${String(timeoutMs)}ms (batch of ${String(batch.length)}, first jobId=${String(batch[0]?.id ?? -1)}, decoder.state=${decoder.state}, decodeQueueSize=${String(decoder.decodeQueueSize)})`));
        }, timeoutMs);
      });
      try {
        await Promise.race([decoder.flush(), timeout]);
      } catch (err) {
        errors.push({ kind: 'decode-error', message: err instanceof Error ? err.message : String(err), jobId: batch[0]?.id ?? -1 });
        break;
      } finally {
        clearTimeout(timeoutHandle);
      }

      for (const [i, job] of batch.entries()) {
        let frame: VideoFrame;
        try {
          frame = await framePromises[i];
        } catch (err) {
          errors.push({ kind: 'decode-error', message: err instanceof Error ? err.message : String(err), jobId: job.id });
          break outer; // matches real WebCodecs: an error() callback leaves the decoder unusable
        }
        if (!job.keep) {
          frame.close();
          continue;
        }
        const bitmap = await withFrameAsync(this.registry, frame, `keyframe-${String(job.id)}`, (f) => createImageBitmap(f, { resizeWidth: size.width, resizeHeight: size.height }));
        thumbnails.push({ id: job.id, presentationTime: job.presentationTime, bitmap });
      }
    }

    return { thumbnails, errors };
  }

  private toVideoDecoderConfig(config: FrameDecoderConfig): VideoDecoderConfig {
    return {
      codec: config.codec,
      codedWidth: config.codedWidth,
      codedHeight: config.codedHeight,
      description: config.description,
      hardwareAcceleration: 'prefer-hardware',
    };
  }

  close(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = undefined;
  }
}
