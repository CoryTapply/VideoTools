// Spike C / Step 1 -- worker-side keyframe decode throughput (the filmstrip path). See
// prompts/m0.5-spike-prompts.md Step 1. Sequential per-frame pipeline (read -> decode ->
// downscale -> close), matching the spec's literal step-by-step description; a pipelined
// (overlapped) version could be faster but isn't needed unless the sequential number is
// borderline against the ~50 thumbnails/sec fail bar.
//
// File objects are structured-cloneable, so the main thread just clones the File into this
// worker rather than streaming bytes across -- both sides read directly from the same
// underlying file.

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
  let pending: Array<{ resolve: (frame: VideoFrame) => void; reject: (err: Error) => void }> = [];
  const decoder = new VideoDecoder({
    output(frame) {
      const entry = pending.shift();
      if (entry) entry.resolve(frame);
      else frame.close(); // shouldn't happen; don't leak if it does
    },
    error(err) {
      errors.push(String(err));
      const failed = pending;
      pending = [];
      for (const entry of failed) entry.reject(err instanceof Error ? err : new Error(String(err)));
    },
  });
  decoder.configure({
    codec: decoderConfig.codec,
    codedWidth: decoderConfig.codedWidth,
    codedHeight: decoderConfig.codedHeight,
    description: decoderConfig.description,
    hardwareAcceleration,
  });

  const t0 = performance.now();

  try {
    for (const target of targets) {
      const rt0 = performance.now();
      const readEnd = coalesceWindowBytes ? Math.max(target.offset + target.size, target.offset + coalesceWindowBytes) : target.offset + target.size;
      const raw = await file.slice(target.offset, readEnd).arrayBuffer();
      const bytes = coalesceWindowBytes ? new Uint8Array(raw, 0, target.size) : new Uint8Array(raw);
      readMs += performance.now() - rt0;

      const dt0 = performance.now();
      const chunk = new EncodedVideoChunk({ type: 'key', timestamp: target.timestampUs, data: bytes });
      const framePromise = new Promise<VideoFrame>((resolve, reject) => pending.push({ resolve, reject }));
      decoder.decode(chunk);
      // Hard safety net: even if error() never fires (a truly silent stall, not just a
      // reported error), don't hang forever -- surface it as a clear timeout instead. This is
      // what should have caught the real 4+ minute hang instead of leaving it silent.
      const timeoutMs = 10_000;
      let timeoutHandle: ReturnType<typeof setTimeout>;
      const timeout = new Promise<VideoFrame>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`decode timed out after ${timeoutMs}ms (offset=${target.offset}, size=${target.size})`)), timeoutMs);
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
