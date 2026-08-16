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
import { DEFAULT_BATCH_SIZE, formatFrameDecodeError, groupIntoFlushBatches, type DecodeJob, type DecodedBitmap, type FrameDecodeError, type FrameDecoderConfig } from './FrameDecoder';
import { RealFrameDecoder } from './RealFrameDecoder';
import type { FrameWorkerRequest, FrameWorkerResponse, WireThumbnail } from './worker-protocol';
import type { DecodeJobDescriptor } from './worker-pool';

let file: File | undefined;
let decoder: RealFrameDecoder | undefined;
let configuredCodec = '';
/**
 * Sticky per-worker, set once a hardware decode wedges and a software retry (see the
 * `!preferSoftware` branch in handleDecode()) recovers it. A hardware flush() hang observed on
 * one batch is a driver-level problem, not a property of that one batch's bytes -- every later
 * batch this worker decodes would otherwise pay the same ~16s hardware timeout again before
 * falling back. A fresh worker (a new file, or the pool respawning one) always starts on hardware
 * again.
 */
let preferSoftware = false;
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
    const candidate = new RealFrameDecoder(createFrameLifecycleRegistry(), preferSoftware ? 'prefer-software' : 'prefer-hardware');
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

  // Chunked by groupIntoFlushBatches, NOT a naive fixed-size slice: this loop exists so
  // `cancelled` can be checked between chunks, but req.jobs may contain a decode chain (a
  // keyframe followed by dependent delta frames, dense tier) that must never be split at an
  // arbitrary boundary -- slicing it here and calling decodeBatch() once per slice would flush
  // (and reset the key-frame-required flag) at the end of every slice regardless of chain state,
  // reintroducing exactly the bug groupIntoFlushBatches exists to prevent, just one layer up.
  // Each group is passed to decodeBatch() with batchSize = group.length so its OWN internal
  // grouping is a single-batch passthrough, not a second, redundant re-split.
  for (const group of groupIntoFlushBatches(req.jobs, batchSize)) {
    if (cancelled.delete(req.requestId)) {
      closeAll(thumbnails.map((t) => t.bitmap));
      self.postMessage({ type: 'result', requestId: req.requestId, thumbnails: [], errors: [], cancelled: true });
      return;
    }

    const decodeJobs = await Promise.all(group.map(readJobBytes));
    let result = await decoder.decodeBatch(decodeJobs, req.size, decodeJobs.length);

    if (result.errors.length > 0 && !preferSoftware) {
      // A hardware decode failure is very often a driver-level flush() hang (RealFrameDecoder's
      // timeout-raced flush() exists precisely because this happens -- see that file's header
      // comment on a real observed Windows GPU decoder wedge), not a fault in this batch's bytes.
      // Retry the SAME batch once on a fresh software decoder before giving up on it: if software
      // succeeds, the file itself is fine, so stick with software for the rest of this worker's
      // life instead of re-paying a ~16s hardware timeout on every later batch too.
      closeAll(result.thumbnails.map((t) => t.bitmap));
      decoder.close();
      const failedErrors = result.errors;
      const fallback = new RealFrameDecoder(createFrameLifecycleRegistry(), 'prefer-software');
      if (await fallback.isConfigSupported(req.config)) {
        fallback.configure(req.config);
        const retryStartMs = performance.now();
        const retryResult = await fallback.decodeBatch(decodeJobs, req.size, decodeJobs.length);
        if (retryResult.errors.length === 0) {
          preferSoftware = true;
          decoder = fallback;
          configuredCodec = configKey(req.config);
          result = retryResult;
          // A successful fallback leaves `errors` empty below (correctly -- the batch DID
          // eventually succeed), which would otherwise make this recovery invisible: no exception,
          // no rejected promise, nothing in the result the main thread ever sees. Log it
          // explicitly so "why did this batch take 16+ seconds" has an answer in DevTools instead
          // of silently costing time on every file open with zero trace of why.
          console.info(`frame worker: hardware decode failed (${failedErrors.map(formatFrameDecodeError).join('; ')}) -- recovered on software in ${String(Math.round(performance.now() - retryStartMs))}ms, switching this worker to software for the rest of this file`);
        } else {
          fallback.close();
        }
      }
    }

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
