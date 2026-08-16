// The pool's dispatch/cancellation logic, kept independent of any real Worker so it's fully
// testable in Node (see worker-pool.test.ts) -- the only thing that differs between a test run
// and a browser run is which WorkerHandle implementation gets passed in: FrameWorkerClient
// (worker-client.ts, wraps a real Worker) for real, a fake for tests.
//
// PART 0 DECISION: jobs are plain {offset, size, presentationTime, ...} descriptors, not a
// SharedArrayBuffer-shared SampleIndex. Reasoning: decode workers only ever need byte ranges and
// presentation times for the specific keyframes assigned to them -- never general index query
// capability (frameAtPresentationTime, nearestSyncAtOrBeforePresentation, ...), because the pool
// owner (main thread) does every such query once, up front, when building the job list. That's
// unlike src/media/index/worker.ts, which genuinely needs the full parse+query machinery inside
// the worker because it's building the index itself. Each worker reads its own assigned byte
// ranges via its own FileByteSource(file) clone -- the same "File is structured-cloneable, so
// just clone it into the worker" precedent index/worker.ts already relies on -- so there's no
// need to share a SampleIndex, SAB-backed or otherwise, across this pool at all. This sidesteps
// needing a fresh SAB-vs-transferables measurement for THIS module's own worker boundary; the
// already-recorded numbers in results/FEASIBILITY.md (SAB 9.03ms/2 readers vs. transferables
// 25.34ms/1 reader) describe a different case -- handing a FULL index to a worker that needs to
// query it -- which doesn't apply here. Flagged in results/task-3-frame-cache-summary.md as a
// reasoned decision, not one confirmed by a fresh in-browser run.

import type { DecodedBitmap, FrameDecodeError, FrameDecoderConfig, ThumbnailSize } from './FrameDecoder';

export interface DecodeJobDescriptor {
  /** Decode-order sample index -- the join key back into SampleIndex/byteRange() on the main thread. */
  readonly id: number;
  readonly offset: number;
  readonly size: number;
  readonly presentationTime: number;
  readonly type: 'key' | 'delta';
  /** False for a decode-chain dependency frame (dense tier) that's never turned into a bitmap. */
  readonly keep: boolean;
}

export interface WorkerDecodeRequest {
  readonly requestId: number;
  readonly config: FrameDecoderConfig;
  readonly jobs: readonly DecodeJobDescriptor[];
  readonly size: ThumbnailSize;
  readonly batchSize?: number;
}

export interface WorkerDecodedThumbnail {
  readonly id: number;
  readonly presentationTime: number;
  readonly bitmap: DecodedBitmap;
}

export interface WorkerDecodeResult {
  readonly requestId: number;
  readonly thumbnails: WorkerDecodedThumbnail[];
  readonly errors: FrameDecodeError[];
  readonly cancelled: boolean;
}

/** A single worker's view from the pool's side. Real: FrameWorkerClient (worker-client.ts), wrapping a real Worker. Fake: see worker-pool.test.ts. */
export interface WorkerHandle {
  decode(request: WorkerDecodeRequest): Promise<WorkerDecodeResult>;
  /** Must be real: the target worker stops promptly and closes everything it holds for this request, not just deprioritize it. A no-op if requestId isn't (or is no longer) running on this handle. */
  cancel(requestId: number): void;
  terminate(): void;
}

/** Start with 2, per the task prompt -- 4K hardware decode may already be the bottleneck, so more workers just contend until measured otherwise. Cap at min(4, hardwareConcurrency/2). */
export function defaultWorkerCount(hardwareConcurrency: number): number {
  const cap = Math.max(1, Math.min(4, Math.floor(hardwareConcurrency / 2)));
  return Math.min(2, cap);
}

interface QueuedJob {
  readonly request: WorkerDecodeRequest;
  readonly resolve: (result: WorkerDecodeResult) => void;
}

function cancelledResult(requestId: number): WorkerDecodeResult {
  return { requestId, thumbnails: [], errors: [], cancelled: true };
}

export class FrameWorkerPool {
  private readonly handles: readonly WorkerHandle[];
  private readonly free: WorkerHandle[];
  private readonly queue: QueuedJob[] = [];
  private readonly cancelledBeforeDispatch = new Set<number>();
  private readonly inFlight = new Map<number, WorkerHandle>();
  private disposed = false;

  constructor(handles: readonly WorkerHandle[]) {
    if (handles.length === 0) throw new Error('FrameWorkerPool: at least one worker handle is required');
    this.handles = handles;
    this.free = [...handles];
  }

  get size(): number {
    return this.handles.length;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  submit(request: WorkerDecodeRequest): Promise<WorkerDecodeResult> {
    if (this.disposed) throw new Error('FrameWorkerPool: submit() after dispose()');
    return new Promise((resolve) => {
      this.queue.push({ request, resolve });
      this.pump();
    });
  }

  /**
   * Cancels a request: if still queued, it's removed and resolved as cancelled without ever
   * touching a worker. If already dispatched, the owning worker's cancel() is called -- real
   * cancellation, not deprioritization. If cancel() races ahead of submit() (called before the
   * request has been queued at all), the id is remembered so the request is resolved cancelled
   * the moment it WOULD have been dispatched, instead of running anyway.
   */
  cancel(requestId: number): void {
    const queuedIndex = this.queue.findIndex((q) => q.request.requestId === requestId);
    if (queuedIndex >= 0) {
      const [removed] = this.queue.splice(queuedIndex, 1);
      removed.resolve(cancelledResult(requestId));
      return;
    }
    const handle = this.inFlight.get(requestId);
    if (handle) {
      handle.cancel(requestId);
    } else {
      this.cancelledBeforeDispatch.add(requestId);
    }
  }

  /** Terminates every worker and resolves anything still queued as cancelled. In-flight decodes are abandoned (their promises may never settle) -- callers should have cancelled them first if that matters. */
  dispose(): void {
    this.disposed = true;
    for (const q of this.queue) q.resolve(cancelledResult(q.request.requestId));
    this.queue.length = 0;
    for (const handle of this.handles) handle.terminate();
  }

  private pump(): void {
    while (this.free.length > 0 && this.queue.length > 0) {
      const handle = this.free.shift();
      const queued = this.queue.shift();
      if (!handle || !queued) break;

      if (this.cancelledBeforeDispatch.delete(queued.request.requestId)) {
        queued.resolve(cancelledResult(queued.request.requestId));
        this.free.push(handle);
        continue;
      }

      const requestId = queued.request.requestId;
      this.inFlight.set(requestId, handle);
      handle
        .decode(queued.request)
        .then((result) => {
          this.inFlight.delete(requestId);
          this.free.push(handle);
          queued.resolve(result);
          this.pump();
        })
        .catch((err: unknown) => {
          this.inFlight.delete(requestId);
          this.free.push(handle);
          queued.resolve({ requestId, thumbnails: [], errors: [{ kind: 'decode-error', message: err instanceof Error ? err.message : String(err), jobId: -1 }], cancelled: false });
          this.pump();
        });
    }
  }
}
