// Spike C / Step 3 -- worker side: builds the 2fps decoded-frame cache. Feeds every sample in
// the window through ONE decoder in decode order (a single continuous pass, exactly one
// trailing flush() -- per the item-2 finding, flush() forces a keyframe restart, so mid-pass
// flushing is avoided entirely here too), and keeps only the frames nearest each 2fps grid
// slot. VideoDecoder emits output() in PRESENTATION order (the codec handles reordering
// internally), so a simple forward sweep over ascending slot boundaries is enough to assign
// each output frame to at most one slot without missing any. See
// prompts/m0.5-spike-prompts.md Step 3.

import { stripNonVclNals } from './nal-strip';

declare const self: {
  onmessage: ((e: MessageEvent<CacheBuildRequest>) => void) | null;
  postMessage: (message: unknown, transfer: Transferable[]) => void;
};

export interface CacheSample {
  offset: number;
  size: number;
  timestampUs: number;
  sync: boolean;
}

export interface CacheBuildRequest {
  file: File;
  decoderConfig: { codec: string; codedWidth: number; codedHeight: number; description: Uint8Array };
  samples: CacheSample[];
  /** Requested slot timestamps (2fps grid), ascending. */
  slotTimestampsUs: number[];
  thumbWidth: number;
  thumbHeight: number;
  hardwareAcceleration: 'prefer-hardware' | 'prefer-software' | 'no-preference';
}

export interface CacheBuildResult {
  bitmaps: ImageBitmap[];
  /** The actual frame timestamp captured for each filled slot, same length as bitmaps. */
  actualTimestampsUs: number[];
  buildMs: number;
  framesDecodedTotal: number;
  errors: string[];
}

self.onmessage = (e: MessageEvent<CacheBuildRequest>) => {
  void run(e.data);
};

async function run(req: CacheBuildRequest): Promise<void> {
  const { file, decoderConfig, samples, slotTimestampsUs, thumbWidth, thumbHeight, hardwareAcceleration } = req;
  const config: VideoDecoderConfig = {
    codec: decoderConfig.codec,
    codedWidth: decoderConfig.codedWidth,
    codedHeight: decoderConfig.codedHeight,
    description: decoderConfig.description,
    hardwareAcceleration,
  };
  const errors: string[] = [];
  const bitmaps: ImageBitmap[] = [];
  const actualTimestampsUs: number[] = [];
  let framesDecodedTotal = 0;
  let nextSlot = 0;
  const pendingBitmapPromises: Promise<void>[] = [];

  const decoder = new VideoDecoder({
    output(frame) {
      framesDecodedTotal += 1;
      if (nextSlot < slotTimestampsUs.length && frame.timestamp >= slotTimestampsUs[nextSlot]!) {
        const slotIdx = nextSlot;
        nextSlot += 1;
        actualTimestampsUs[slotIdx] = frame.timestamp;
        const bitmapPromise = createImageBitmap(frame, { resizeWidth: thumbWidth, resizeHeight: thumbHeight })
          .then((bitmap) => {
            bitmaps[slotIdx] = bitmap;
          })
          .catch((err: unknown) => {
            errors.push(`createImageBitmap failed for slot ${slotIdx}: ${err instanceof Error ? err.message : String(err)}`);
          });
        pendingBitmapPromises.push(bitmapPromise);
      }
      frame.close();
    },
    error(err) {
      errors.push(`decoder error: ${String(err)}`);
    },
  });
  decoder.configure(config);

  const t0 = performance.now();
  try {
    for (const sample of samples) {
      const raw = new Uint8Array(await file.slice(sample.offset, sample.offset + sample.size).arrayBuffer());
      const { result: bytes } = stripNonVclNals(raw);
      const chunk = new EncodedVideoChunk({ type: sample.sync ? 'key' : 'delta', timestamp: sample.timestampUs, data: bytes });
      decoder.decode(chunk);
    }
    const timeoutMs = 15_000 + 50 * samples.length;
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`cache build flush timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      await Promise.race([decoder.flush(), timeout]);
    } finally {
      clearTimeout(timeoutHandle!);
    }
    await Promise.all(pendingBitmapPromises);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
  const buildMs = performance.now() - t0;

  if (nextSlot < slotTimestampsUs.length) {
    errors.push(`only filled ${nextSlot}/${slotTimestampsUs.length} slots (ran out of decoded frames before reaching the last slot timestamps)`);
  }

  // Compact in case some slots were skipped (e.g. content ran out early).
  const filledBitmaps = bitmaps.filter((b): b is ImageBitmap => b !== undefined);
  const filledTimestamps = actualTimestampsUs.filter((_, i) => bitmaps[i] !== undefined);

  const result: CacheBuildResult = { bitmaps: filledBitmaps, actualTimestampsUs: filledTimestamps, buildMs, framesDecodedTotal, errors };
  self.postMessage(result, filledBitmaps);
}
