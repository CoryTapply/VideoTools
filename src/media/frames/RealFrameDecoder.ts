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
// Two more findings this module discovered itself (dense-tier delta-frame decoding is a genuinely
// new WebCodecs code path -- every prior use, coarse tier included, only ever decoded keyframes):
//   - batching by a fixed batchSize and flushing after every batch is only safe for INDEPENDENT
//     keyframes. flush() resets the decoder's key-frame-required flag, so slicing a decode chain
//     (a keyframe followed by dependent delta frames) at an arbitrary batchSize boundary
//     eventually starts a batch on a 'delta' job right after a flush -- WebCodecs rejects this
//     outright ("A key frame is required after configure() or flush()"), confirmed by a real
//     harness run. groupIntoFlushBatches() (FrameDecoder.ts) fixes this: a chain is never split,
//     however long it runs.
//   - VideoDecoderConfig.description must be the avcC/hvcC box's CONTENT only, not the same bytes
//     as TrackIndex.description (which deliberately includes the box's own 8-byte header for its
//     other consumers) -- see FrameDecoderConfig.description's doc comment and stripBoxHeader().
// Defaults to `hardwareAcceleration: 'prefer-hardware'` per the task prompt; a machine without
// hardware H.264 decode measured ~4x slower in spike C, so which path is active is worth
// surfacing to a caller (see `hardwareAccelerationUsed` below) rather than left silent. The
// constructor also accepts 'prefer-software' -- worker.ts uses it for a one-shot fallback
// decoder when a hardware decode wedges (see that file's decodeGroup()): a driver-level hang
// during flush() is a real, observed failure mode (some Windows GPU decoders hang rather than
// erroring on specific bitstreams), not something a retry on the SAME hardware path can recover
// from, so the fallback deliberately forces software.


import { stripNonVclNals } from '../../spikes/C-decode/nal-strip';
import { withFrameAsync, type FrameLifecycleRegistry } from './frame-lifecycle';
import { groupIntoFlushBatches, type DecodeJob, type DecodedThumbnail, type FrameDecodeBatchResult, type FrameDecodeError, type FrameDecoder, type FrameDecoderConfig, type ThumbnailSize } from './FrameDecoder';

export class RealFrameDecoder implements FrameDecoder {
  /** Set once configure() resolves; reflects which decode path Chrome actually chose, not just what was requested. */
  hardwareAccelerationUsed: 'prefer-hardware' | 'prefer-software' | undefined;

  private decoder: VideoDecoder | undefined;
  private pending: Array<{ resolve: (frame: VideoFrame) => void; reject: (err: Error) => void }> = [];
  /**
   * The VideoDecoder's error() callback can fire with NOTHING in `pending` -- e.g. when
   * configure() itself is rejected asynchronously, before any decode() has even been called. If
   * that error is only ever delivered by rejecting pending entries, it's silently dropped in that
   * case: the ONLY visible symptom becomes a later, unrelated-looking "Cannot call decode on a
   * closed codec" the moment something does call decode(). Captured here so decodeBatch() can
   * surface the REAL cause instead of that downstream symptom.
   */
  private lastDecoderError: string | undefined;
  private readonly registry: FrameLifecycleRegistry;
  private readonly hardwareAcceleration: 'prefer-hardware' | 'prefer-software';

  /** hardwareAcceleration defaults to 'prefer-hardware' -- worker.ts passes 'prefer-software' explicitly for its post-hang fallback decoder (see that file's decodeGroup()). */
  constructor(registry: FrameLifecycleRegistry, hardwareAcceleration: 'prefer-hardware' | 'prefer-software' = 'prefer-hardware') {
    this.registry = registry;
    this.hardwareAcceleration = hardwareAcceleration;
  }

  async isConfigSupported(config: FrameDecoderConfig): Promise<boolean> {
    const support = await VideoDecoder.isConfigSupported(this.toVideoDecoderConfig(config));
    return support.supported ?? false;
  }

  configure(config: FrameDecoderConfig): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.pending = [];
    this.lastDecoderError = undefined;

    const decoder = new VideoDecoder({
      output: (frame) => {
        const entry = this.pending.shift();
        if (entry) entry.resolve(frame);
        else frame.close(); // shouldn't happen -- output() firing with nothing pending would otherwise leak
      },
      error: (err) => {
        this.lastDecoderError = err instanceof Error ? err.message : String(err);
        const failed = this.pending;
        this.pending = [];
        for (const entry of failed) entry.reject(err instanceof Error ? err : new Error(String(err)));
      },
    });
    decoder.configure(this.toVideoDecoderConfig(config));
    this.decoder = decoder;
    this.hardwareAccelerationUsed = this.hardwareAcceleration;
  }

  async decodeBatch(jobs: readonly DecodeJob[], size: ThumbnailSize, batchSize = 16): Promise<FrameDecodeBatchResult> {
    const decoder = this.decoder;
    if (!decoder) throw new Error('RealFrameDecoder: decodeBatch() before configure()');

    const thumbnails: DecodedThumbnail[] = [];
    const errors: FrameDecodeError[] = [];

    outer: for (const batch of groupIntoFlushBatches(jobs, batchSize)) {
      if (decoder.state === 'closed') {
        // The decoder closed asynchronously (e.g. configure() was rejected, or a prior batch's
        // error() fired) without this call ever seeing it directly -- surface the REAL captured
        // reason rather than letting the next decoder.decode() throw the uninformative "Cannot
        // call decode on a closed codec" and losing the actual cause.
        errors.push({ kind: 'decode-error', message: this.lastDecoderError ?? 'decoder closed before this batch could run (no error() detail captured)', jobId: batch[0]?.id ?? -1 });
        break;
      }

      const framePromises: Promise<VideoFrame>[] = [];

      try {
        for (const job of batch) {
          const { result: bytes } = stripNonVclNals(job.data);
          const chunk = new EncodedVideoChunk({ type: job.type, timestamp: job.presentationTime, data: bytes });
          const framePromise = new Promise<VideoFrame>((resolve, reject) => {
            this.pending.push({ resolve, reject });
          });
          framePromises.push(framePromise);
          decoder.decode(chunk);
        }
      } catch (err) {
        // decode() can throw synchronously (confirmed: "Cannot call 'decode' on a closed codec"
        // when the decoder closed between the state check above and this call) -- prefer the
        // captured async error() reason if one exists, since it's almost always the real cause.
        errors.push({ kind: 'decode-error', message: this.lastDecoderError ?? (err instanceof Error ? err.message : String(err)), jobId: batch[0]?.id ?? -1 });
        // Nothing below this point is going to await framePromises for this batch -- clear
        // `pending` so that if the decoder still emits output() for an already-queued decode()
        // (queued before the throw), output()'s `this.pending.shift()` finds nothing and takes
        // its own `else frame.close()` branch, instead of resolving into a VideoFrame no one will
        // ever close (surfaces later as "A VideoFrame was garbage collected without being
        // closed").
        this.pending = [];
        break;
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
        // A flush() timeout does NOT mean the underlying (often hardware) decoder actually
        // stopped -- confirmed by a real observed hang where decodeQueueSize was still nonzero at
        // timeout, i.e. genuinely in-flight work at the driver level. If that work eventually
        // completes and calls output() after this point, `pending` must no longer hold its entry
        // -- otherwise output()'s `this.pending.shift()` resolves an abandoned promise (nothing
        // here still awaits framePromises for this batch) and the VideoFrame is never closed. See
        // the matching comment above for the sync-throw case; this is the same leak, reached via
        // the timeout path instead.
        this.pending = [];
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
      hardwareAcceleration: this.hardwareAcceleration,
    };
  }

  close(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = undefined;
  }
}
