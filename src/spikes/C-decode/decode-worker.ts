// Spike C / Step 1 -- worker-side keyframe decode throughput (the filmstrip path). See
// prompts/m0.5-spike-prompts.md Step 1. Sequential per-frame pipeline (read -> decode ->
// downscale -> close), matching the spec's literal step-by-step description; a pipelined
// (overlapped) version could be faster but isn't needed unless the sequential number is
// borderline against the ~50 thumbnails/sec fail bar.
//
// File objects are structured-cloneable, so the main thread just clones the File into this
// worker rather than streaming bytes across -- both sides read directly from the same
// underlying file.

import { stripNonVclNals } from './nal-strip';

declare const self: {
  onmessage: ((e: MessageEvent<KeyframeThroughputRequest>) => void) | null;
  postMessage: (message: unknown) => void;
};

export interface DecodeTarget {
  offset: number;
  size: number;
  timestampUs: number;
}

export interface KeyframeThroughputRequest {
  file: File;
  decoderConfig: { codec: string; codedWidth: number; codedHeight: number; description: Uint8Array };
  targets: DecodeTarget[];
  hardwareAcceleration: 'prefer-hardware' | 'prefer-software' | 'no-preference';
  /** If set, each read is widened to at least this many bytes (starting at the target's offset) instead of reading exactly target.size, to test whether rounder/bigger reads change per-call I/O overhead. */
  coalesceWindowBytes?: number;
  /**
   * Number of decode() calls submitted before a single flush() drains the batch, instead of
   * flushing after every individual decode (default 1 -- fully serialized, matches the spec's
   * literal step-by-step description). flush() is REQUIRED at least once per batch: this
   * decoder implementation does not emit output for a queued decode() otherwise (confirmed via
   * a from-scratch main-thread test -- a single decode() with no flush() hung indefinitely,
   * no output(), no error(), despite a config independently confirmed valid via
   * isConfigSupported). A batchSize > 1 tests whether letting the decoder work on several
   * independent keyframes concurrently before forcing drainage improves real throughput over
   * full per-frame serialization.
   */
  batchSize?: number;
}

export interface KeyframeThroughputResult {
  count: number;
  totalMs: number;
  readMs: number;
  decodeMs: number;
  downscaleMs: number;
  thumbnailsPerSecond: number;
  errors: string[];
}

self.onmessage = (e: MessageEvent<KeyframeThroughputRequest>) => {
  void run(e.data);
};

async function run(req: KeyframeThroughputRequest): Promise<void> {
  const { file, decoderConfig, targets, hardwareAcceleration, coalesceWindowBytes, batchSize = 1 } = req;
  const errors: string[] = [];
  let readMs = 0;
  let decodeMs = 0;
  let downscaleMs = 0;
  let completed = 0;

  // Bug fixed here: the error() callback used to only log to `errors`, never reject the
  // pending frame's promise -- so a single decode error left `await framePromise` hanging
  // FOREVER (a real 4+ minute hang was observed, not just slowness). Per the WebCodecs spec,
  // once error() fires the decoder is closed and nothing pending will ever get output, so
  // reject everything currently queued, not just the one that failed.
  const config: VideoDecoderConfig = {
    codec: decoderConfig.codec,
    codedWidth: decoderConfig.codedWidth,
    codedHeight: decoderConfig.codedHeight,
    description: decoderConfig.description,
    hardwareAcceleration,
  };
  // Diagnostic: ask the browser directly whether it accepts this exact config, BEFORE any
  // decode-queue complexity, since a real 4+ minute silent stall (fixed to a 10s timeout, but
  // still failing identically on frame 0 in both hardware and software modes) points at
  // something wrong with the config or the first chunk's data rather than decoder scheduling.
  // NOTE: JSON.stringify on an ArrayBuffer/TypedArray-as-received-here can misleadingly print
  // "{}" regardless of actual content (ArrayBuffer has no enumerable own properties for JSON to
  // see) -- log byteLength explicitly instead of trusting a JSON dump of the config.
  errors.push(
    `description received by worker: byteLength=${decoderConfig.description.byteLength}, ` +
      `first 8 bytes=${Array.from(decoderConfig.description.slice(0, 8))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ')}`,
  );
  try {
    const support = await VideoDecoder.isConfigSupported(config);
    errors.push(`isConfigSupported: supported=${support.supported}, description.byteLength=${support.config?.description?.byteLength}`);
  } catch (err) {
    errors.push(`isConfigSupported threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  let pending: Array<{ resolve: (frame: VideoFrame) => void; reject: (err: Error) => void }> = [];
  const decoder = new VideoDecoder({
    output(frame) {
      const entry = pending.shift();
      if (entry) entry.resolve(frame);
      else frame.close(); // shouldn't happen; don't leak if it does
    },
    error(err) {
      errors.push(`decoder error: ${String(err)}`);
      const failed = pending;
      pending = [];
      for (const entry of failed) entry.reject(err instanceof Error ? err : new Error(String(err)));
    },
  });
  decoder.configure(config);

  const t0 = performance.now();

  try {
    for (let batchStart = 0; batchStart < targets.length; batchStart += batchSize) {
      const batch = targets.slice(batchStart, batchStart + batchSize);
      const framePromises: Promise<VideoFrame>[] = [];

      // Submit every decode() in the batch WITHOUT waiting for individual output, so the
      // decoder can work on them concurrently if it's able to -- only flush() once per batch.
      for (const target of batch) {
        const rt0 = performance.now();
        const readEnd = coalesceWindowBytes ? Math.max(target.offset + target.size, target.offset + coalesceWindowBytes) : target.offset + target.size;
        const raw = await file.slice(target.offset, readEnd).arrayBuffer();
        const rawBytes = coalesceWindowBytes ? new Uint8Array(raw, 0, target.size) : new Uint8Array(raw);
        readMs += performance.now() - rt0;

        // Real finding: this file's keyframes carry in-band SPS/PPS/SEI NAL units ahead of the
        // IDR slice (confirmed by manually parsing sample 0's raw bytes), which appears to
        // stall this decoder when it was already configured with the same parameter sets via
        // `description`. Strip them, keeping only the actual VCL slice data.
        const { result: bytes, nalTypesSeen, stripped } = stripNonVclNals(rawBytes);
        if (completed === 0) errors.push(`first chunk NAL types seen: [${nalTypesSeen.join(', ')}], stripped=${stripped}, resulting size=${bytes.byteLength} (was ${rawBytes.byteLength})`);

        const chunk = new EncodedVideoChunk({ type: 'key', timestamp: target.timestampUs, data: bytes });
        const framePromise = new Promise<VideoFrame>((resolve, reject) => pending.push({ resolve, reject }));
        framePromises.push(framePromise);
        decoder.decode(chunk);
      }

      // Real finding: this VideoDecoder implementation does not emit output for queued
      // decode() calls until flush() explicitly forces drainage -- confirmed via a
      // from-scratch main-thread test where a single decode() with no flush() hung
      // indefinitely (no output(), no error()) despite a config independently confirmed valid
      // by isConfigSupported. flush() is required at least once per batch.
      const dt0 = performance.now();
      const timeoutMs = 10_000 * batch.length;
      let timeoutHandle: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`batch flush timed out after ${timeoutMs}ms (batchStart=${batchStart}, batchSize=${batch.length}, decoder.state=${decoder.state}, decodeQueueSize=${decoder.decodeQueueSize})`));
        }, timeoutMs);
      });
      try {
        await Promise.race([decoder.flush(), timeout]);
      } finally {
        clearTimeout(timeoutHandle!);
      }
      decodeMs += performance.now() - dt0;

      // By the time flush() resolves, output() (or error(), already handled above) has fired
      // for every chunk in the batch, so these awaits resolve immediately.
      for (const framePromise of framePromises) {
        const frame = await framePromise;
        const st0 = performance.now();
        const bitmapPromise = createImageBitmap(frame, { resizeWidth: 160, resizeHeight: 90 });
        frame.close();
        const bitmap = await bitmapPromise;
        bitmap.close();
        downscaleMs += performance.now() - st0;
        completed += 1;
      }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }

  const totalMs = performance.now() - t0;
  const result: KeyframeThroughputResult = {
    count: completed,
    totalMs,
    readMs,
    decodeMs,
    downscaleMs,
    thumbnailsPerSecond: (completed / totalMs) * 1000,
    errors,
  };
  self.postMessage(result);
}
