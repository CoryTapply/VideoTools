// The worker-side entry point. Assumes at most one 'decode' request is ever in flight at a time
// on a given worker instance -- guaranteed by FrameWorkerPool (worker-pool.ts), which only
// dispatches to a handle once its previous decode() has resolved. That's what makes reusing a
// single RealFrameDecoder (and its underlying VideoDecoder) across requests on this worker safe.
//
// tsconfig's lib is DOM (main-thread), not WebWorker -- same hand-declared `self` convention as
// src/media/index/worker.ts.
declare const self: {
  onmessage: ((e: MessageEvent<FrameWorkerRequest>) => void) | null;
  postMessage: (message: FrameWorkerResponse, transfer?: Transferable[]) => void;
};

import { createFrameLifecycleRegistry } from './frame-lifecycle';
import { DEFAULT_BATCH_SIZE, type DecodeJob, type DecodedBitmap, type FrameDecodeError, type FrameDecoderConfig } from './FrameDecoder';
import { RealFrameDecoder } from './RealFrameDecoder';
import type { FrameWorkerRequest, FrameWorkerResponse, WireThumbnail } from './worker-protocol';
import type { DecodeJobDescriptor } from './worker-pool';

let file: File | undefined;
let decoder: RealFrameDecoder | undefined;
let configuredCodec = '';
const cancelled = new Set<number>();

function configKey(config: FrameDecoderConfig): string {
  return `${config.codec}|${String(config.codedWidth)}x${String(config.codedHeight)}|${String(config.description.byteLength)}`;
}

async function readJobBytes(descriptor: DecodeJobDescriptor): Promise<DecodeJob> {
  if (!file) throw new Error('frame worker: decode requested before init');
  const buf = await file.slice(descriptor.offset, descriptor.offset + descriptor.size).arrayBuffer();
  return { id: descriptor.id, presentationTime: descriptor.presentationTime, type: descriptor.type, keep: descriptor.keep, data: new Uint8Array(buf) };
}

function closeAll(bitmaps: DecodedBitmap[]): void {
  for (const b of bitmaps) b.close();
}

async function handleDecode(req: Extract<FrameWorkerRequest, { type: 'decode' }>): Promise<void> {
  if (!decoder || configKey(req.config) !== configuredCodec) {
    decoder?.close();
    const candidate = new RealFrameDecoder(createFrameLifecycleRegistry());
    // Checked first, per the task spec -- a clean, specific "unsupported config" result beats
    // discovering the same fact indirectly via a cascade of opaque "closed codec" decode errors.
    const supported = await candidate.isConfigSupported(req.config);
    if (!supported) {
      self.postMessage({ type: 'result', requestId: req.requestId, thumbnails: [], errors: [{ kind: 'unsupported-config', codec: req.config.codec }], cancelled: false });
      return;
    }
    candidate.configure(req.config);
    decoder = candidate;
    configuredCodec = configKey(req.config);
  }

  const batchSize = req.batchSize ?? DEFAULT_BATCH_SIZE;
  const thumbnails: WireThumbnail[] = [];
  const errors: FrameDecodeError[] = [];

  for (let i = 0; i < req.jobs.length; i += batchSize) {
    if (cancelled.delete(req.requestId)) {
      closeAll(thumbnails.map((t) => t.bitmap));
      self.postMessage({ type: 'result', requestId: req.requestId, thumbnails: [], errors: [], cancelled: true });
      return;
    }

    const batch = req.jobs.slice(i, i + batchSize);
    const decodeJobs = await Promise.all(batch.map(readJobBytes));
    const result = await decoder.decodeBatch(decodeJobs, req.size, batchSize);
    for (const t of result.thumbnails) thumbnails.push({ id: t.id, presentationTime: t.presentationTime, bitmap: t.bitmap });
    errors.push(...result.errors);
    if (result.errors.length > 0) {
      // Per FrameDecoder's contract, any decode error leaves the underlying VideoDecoder
      // unusable -- close it and clear configuredCodec so the NEXT handleDecode() call (even one
      // requesting the identical config) constructs a genuinely fresh decoder, instead of
      // silently reusing a wedged instance for every request that follows this worker forever.
      decoder.close();
      decoder = undefined;
      configuredCodec = '';
      break;
    }
  }

  if (cancelled.delete(req.requestId)) {
    closeAll(thumbnails.map((t) => t.bitmap));
    self.postMessage({ type: 'result', requestId: req.requestId, thumbnails: [], errors: [], cancelled: true });
    return;
  }

  self.postMessage(
    { type: 'result', requestId: req.requestId, thumbnails, errors, cancelled: false },
    thumbnails.map((t) => t.bitmap),
  );
}

self.onmessage = (e: MessageEvent<FrameWorkerRequest>) => {
  const req = e.data;
  if (req.type === 'init') {
    file = req.file;
    return;
  }
  if (req.type === 'cancel') {
    cancelled.add(req.requestId);
    return;
  }
  handleDecode(req).catch((err: unknown) => {
    self.postMessage({ type: 'worker-error', requestId: req.requestId, message: err instanceof Error ? err.message : String(err) });
  });
};
