// The pool's dispatch/cancellation logic, independent of any real Worker so it's fully testable in
// Node -- mirrors src/media/frames/worker-pool.ts's shape and Part 0 decision exactly: jobs cross
// as plain {offset, size, presentationTime} descriptors, never a shared SampleIndex, because a
// decode worker only ever needs byte ranges for the samples it's assigned -- the main thread does
// every index query once, up front, building the job list via job-builder.ts.
//
// Deliberately a single-worker pool for the MVP (see this module's README): whole-track video
// decode is prohibitively expensive, which is WHY the frame cache's coarse tier only decodes
// keyframes at all -- audio has no such shortcut (every AAC frame decodes regardless), but is also
// expected to be dramatically cheaper per second of content than 4K H.264 decode (no GPU/driver
// hazards, software-only). A single sequential worker is this module's first, unmeasured attempt;
// splitting into parallel segments is a natural follow-up if real throughput against a large
// multi-track file (fixtures/27gb.mp4's six audio tracks) proves too slow -- see README's "needs a
// real browser" list. This class still supports multiple handles structurally (same dispatch code
// as frames/worker-pool.ts) so that follow-up doesn't require rewriting this file.

import type { WaveformDecodeError } from './WaveformDecoder';

export interface WaveformJobDescriptor {
  /** Decode-order sample index -- the join key back into SampleIndex/byteRange() on the main thread. */
  readonly id: number;
  readonly offset: number;
  readonly size: number;
  readonly presentationTime: number;
}

export interface WaveformDecoderConfigWire {
  readonly codec: string;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly description: Uint8Array;
}

export interface WorkerBuildRequest {
  readonly requestId: number;
  readonly config: WaveformDecoderConfigWire;
  readonly jobs: readonly WaveformJobDescriptor[];
  readonly flushEvery?: number;
}

/** One pyramid level, wire-shaped for postMessage (Int16Array is itself transferable). */
export interface WirePyramidLevel {
  readonly samplesPerBucket: number;
  readonly bucketCount: number;
  readonly min: readonly Int16Array[]; // per channel
  readonly max: readonly Int16Array[]; // per channel
}

export interface WorkerBuildResult {
  readonly requestId: number;
  readonly pyramid: readonly WirePyramidLevel[];
  readonly errors: readonly WaveformDecodeError[];
  readonly cancelled: boolean;
}

/** A single worker's view from the pool's side. Real: WaveformWorkerClient (worker-client.ts), wrapping a real Worker. Fake: see worker-pool.test.ts. */
export interface WorkerHandle {
  build(request: WorkerBuildRequest): Promise<WorkerBuildResult>;
  /** Must be real: the target worker stops promptly and closes everything it holds for this request, not just deprioritize it. A no-op if requestId isn't (or is no longer) running on this handle. */
  cancel(requestId: number): void;
  terminate(): void;
}

interface QueuedJob {
  readonly request: WorkerBuildRequest;
  readonly resolve: (result: WorkerBuildResult) => void;
}

function cancelledResult(requestId: number): WorkerBuildResult {
  return { requestId, pyramid: [], errors: [], cancelled: true };
}

export class WaveformWorkerPool {
  private readonly handles: readonly WorkerHandle[];
  private readonly free: WorkerHandle[];
  private readonly queue: QueuedJob[] = [];
  private readonly cancelledBeforeDispatch = new Set<number>();
  private readonly inFlight = new Map<number, WorkerHandle>();
  private disposed = false;

  constructor(handles: readonly WorkerHandle[]) {
    if (handles.length === 0) throw new Error('WaveformWorkerPool: at least one worker handle is required');
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

  submit(request: WorkerBuildRequest): Promise<WorkerBuildResult> {
    if (this.disposed) throw new Error('WaveformWorkerPool: submit() after dispose()');
    return new Promise((resolve) => {
      this.queue.push({ request, resolve });
      this.pump();
    });
  }

  /** Cancels a request: if still queued, resolved as cancelled without ever touching a worker. If already dispatched, the owning worker's cancel() is called. If cancel() races ahead of submit(), the id is remembered so the request resolves cancelled the moment it would have been dispatched. */
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

  /** Terminates every worker and resolves anything still queued as cancelled. In-flight builds are abandoned (their promises may never settle) -- callers should have cancelled them first if that matters. */
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
        .build(queued.request)
        .then((result) => {
          this.inFlight.delete(requestId);
          this.free.push(handle);
          queued.resolve(result);
          this.pump();
        })
        .catch((err: unknown) => {
          this.inFlight.delete(requestId);
          this.free.push(handle);
          queued.resolve({ requestId, pyramid: [], errors: [{ kind: 'decode-error', message: err instanceof Error ? err.message : String(err), jobId: -1 }], cancelled: false });
          this.pump();
        });
    }
  }
}
