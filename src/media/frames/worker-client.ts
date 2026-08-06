// Main-thread wrapper for one decode worker, implementing worker-pool.ts's WorkerHandle so
// FrameWorkerPool can't tell it apart from a fake in tests. Sends 'init' once at construction
// (File is structured-cloneable, same precedent as src/media/index/worker-client.ts) so every
// decode() call after that only needs to carry job descriptors, not the file itself.

import type { FrameWorkerRequest, FrameWorkerResponse } from './worker-protocol';
import type { WorkerDecodeRequest, WorkerDecodeResult, WorkerHandle } from './worker-pool';

export class FrameWorkerClient implements WorkerHandle {
  private readonly worker: Worker;
  private readonly pending = new Map<number, (result: WorkerDecodeResult) => void>();

  constructor(file: File, workerUrl: URL = new URL('./worker.ts', import.meta.url)) {
    this.worker = new Worker(workerUrl, { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FrameWorkerResponse>) => {
      this.handleMessage(e.data);
    };
    this.worker.onerror = (e: ErrorEvent) => {
      // A worker-level error (e.g. a syntax error, an uncaught throw outside handleDecode's own
      // try/catch) with no requestId to attribute it to -- fail every request currently pending
      // rather than let them hang forever, mirroring RealFrameDecoder's own error() handling.
      const failed = Array.from(this.pending.values());
      this.pending.clear();
      for (const resolve of failed) resolve({ requestId: -1, thumbnails: [], errors: [{ kind: 'decode-error', message: e.message, jobId: -1 }], cancelled: false });
    };
    const initMessage: FrameWorkerRequest = { type: 'init', file };
    this.worker.postMessage(initMessage);
  }

  decode(request: WorkerDecodeRequest): Promise<WorkerDecodeResult> {
    return new Promise((resolve) => {
      this.pending.set(request.requestId, resolve);
      const message: FrameWorkerRequest = { type: 'decode', requestId: request.requestId, config: request.config, jobs: [...request.jobs], size: request.size, batchSize: request.batchSize };
      this.worker.postMessage(message);
    });
  }

  cancel(requestId: number): void {
    const message: FrameWorkerRequest = { type: 'cancel', requestId };
    this.worker.postMessage(message);
  }

  terminate(): void {
    this.worker.terminate();
  }

  private handleMessage(msg: FrameWorkerResponse): void {
    const resolve = this.pending.get(msg.requestId);
    if (!resolve) return; // response for a request we're no longer tracking (already handled, or from before a stale message)
    this.pending.delete(msg.requestId);
    if (msg.type === 'worker-error') {
      resolve({ requestId: msg.requestId, thumbnails: [], errors: [{ kind: 'decode-error', message: msg.message, jobId: -1 }], cancelled: false });
      return;
    }
    resolve({ requestId: msg.requestId, thumbnails: msg.thumbnails, errors: msg.errors, cancelled: msg.cancelled });
  }
}
