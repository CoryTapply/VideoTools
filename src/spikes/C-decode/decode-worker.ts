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
  const { file, decoderConfig, targets, hardwareAcceleration, coalesceWindowBytes } = req;
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
    for (const target of targets) {
      const rt0 = performance.now();
      const readEnd = coalesceWindowBytes ? Math.max(target.offset + target.size, target.offset + coalesceWindowBytes) : target.offset + target.size;
      const raw = await file.slice(target.offset, readEnd).arrayBuffer();
      const rawBytes = coalesceWindowBytes ? new Uint8Array(raw, 0, target.size) : new Uint8Array(raw);
      readMs += performance.now() - rt0;

      // Real finding: this file's keyframes carry in-band SPS/PPS/SEI NAL units ahead of the
      // IDR slice (confirmed by manually parsing sample 0's raw bytes), which appears to stall
      // Chrome's VideoDecoder when it was already configured with the same parameter sets via
      // `description`. Strip them, keeping only the actual VCL slice data.
      const { result: bytes, nalTypesSeen, stripped } = stripNonVclNals(rawBytes);
      if (completed === 0) errors.push(`first chunk NAL types seen: [${nalTypesSeen.join(', ')}], stripped=${stripped}, resulting size=${bytes.byteLength} (was ${rawBytes.byteLength})`);

      const dt0 = performance.now();
      const chunk = new EncodedVideoChunk({ type: 'key', timestamp: target.timestampUs, data: bytes });
      const framePromise = new Promise<VideoFrame>((resolve, reject) => pending.push({ resolve, reject }));
      decoder.decode(chunk);
      // Real finding (confirmed via a from-scratch main-thread diagnostic, not just this worker):
      // this VideoDecoder implementation does not emit output for a queued decode() until
      // flush() explicitly forces drainage -- a single decode() with no flush() hung
      // indefinitely (no output(), no error()) even with a config independently confirmed valid
      // by isConfigSupported. Since every keyframe here is fully independent (no benefit to
      // cross-frame pipelining for this measurement), flushing after each decode is the correct
      // fix, not just a workaround.
      void decoder.flush();
      const stateAfterDecode = decoder.state;
      const queueSizeAfterDecode = decoder.decodeQueueSize;
      // Hard safety net: even if error() never fires (a truly silent stall, not just a
      // reported error), don't hang forever -- surface it as a clear timeout instead. This is
      // what should have caught the real 4+ minute hang instead of leaving it silent.
      const timeoutMs = 10_000;
      let timeoutHandle: ReturnType<typeof setTimeout>;
      const timeout = new Promise<VideoFrame>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new Error(
              `decode timed out after ${timeoutMs}ms (offset=${target.offset}, size=${target.size}, ` +
                `decoder.state right after decode()=${stateAfterDecode}, decodeQueueSize right after=${queueSizeAfterDecode}, ` +
                `decoder.state now=${decoder.state}, decodeQueueSize now=${decoder.decodeQueueSize})`,
            ),
          );
        }, timeoutMs);
      });
      let frame: VideoFrame;
      try {
        frame = await Promise.race([framePromise, timeout]);
      } finally {
        clearTimeout(timeoutHandle!);
      }
      decodeMs += performance.now() - dt0;

      const st0 = performance.now();
      const bitmapPromise = createImageBitmap(frame, { resizeWidth: 160, resizeHeight: 90 });
      frame.close();
      const bitmap = await bitmapPromise;
      bitmap.close();
      downscaleMs += performance.now() - st0;

      completed += 1;
    }
    await decoder.flush();
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
