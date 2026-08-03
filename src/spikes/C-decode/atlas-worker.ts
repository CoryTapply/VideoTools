// Spike C / Step 5 -- worker side: decodes a batch of keyframes into thumbnail ImageBitmaps for
// atlas packing. Reuses the batched decode()-then-flush() pattern from decode-worker.ts (per
// the item-1 finding that per-frame flush() is the real throughput bottleneck), but keeps every
// bitmap instead of discarding it. See prompts/m0.5-spike-prompts.md Step 5.

import { stripNonVclNals } from './nal-strip';

declare const self: {
  onmessage: ((e: MessageEvent<AtlasThumbnailRequest>) => void) | null;
  postMessage: (message: unknown, transfer: Transferable[]) => void;
};

export interface AtlasThumbnailTarget {
  offset: number;
  size: number;
  timestampUs: number;
}

export interface AtlasThumbnailRequest {
  file: File;
  decoderConfig: { codec: string; codedWidth: number; codedHeight: number; description: Uint8Array };
  targets: AtlasThumbnailTarget[];
  thumbWidth: number;
  thumbHeight: number;
  hardwareAcceleration: 'prefer-hardware' | 'prefer-software' | 'no-preference';
  batchSize: number;
}

export interface AtlasThumbnailResult {
  /** Same order as targets. */
  bitmaps: ImageBitmap[];
  decodeMs: number;
  errors: string[];
}

self.onmessage = (e: MessageEvent<AtlasThumbnailRequest>) => {
  void run(e.data);
};

async function run(req: AtlasThumbnailRequest): Promise<void> {
  const { file, decoderConfig, targets, thumbWidth, thumbHeight, hardwareAcceleration, batchSize } = req;
  const config: VideoDecoderConfig = {
    codec: decoderConfig.codec,
    codedWidth: decoderConfig.codedWidth,
    codedHeight: decoderConfig.codedHeight,
    description: decoderConfig.description,
    hardwareAcceleration,
  };
  const errors: string[] = [];
  const bitmaps: ImageBitmap[] = [];

  let pending: Array<{ resolve: (frame: VideoFrame) => void; reject: (err: Error) => void }> = [];
  const decoder = new VideoDecoder({
    output(frame) {
      const entry = pending.shift();
      if (entry) entry.resolve(frame);
      else frame.close();
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
      for (const target of batch) {
        const raw = new Uint8Array(await file.slice(target.offset, target.offset + target.size).arrayBuffer());
        const { result: bytes } = stripNonVclNals(raw);
        const chunk = new EncodedVideoChunk({ type: 'key', timestamp: target.timestampUs, data: bytes });
        const framePromise = new Promise<VideoFrame>((resolve, reject) => pending.push({ resolve, reject }));
        framePromises.push(framePromise);
        decoder.decode(chunk);
      }
      await decoder.flush();
      for (const framePromise of framePromises) {
        const frame = await framePromise;
        const bitmap = await createImageBitmap(frame, { resizeWidth: thumbWidth, resizeHeight: thumbHeight });
        frame.close();
        bitmaps.push(bitmap);
      }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
  const decodeMs = performance.now() - t0;

  const result: AtlasThumbnailResult = { bitmaps, decodeMs, errors };
  self.postMessage(result, bitmaps);
}
