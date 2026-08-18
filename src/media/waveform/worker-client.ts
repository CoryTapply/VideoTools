// Main-thread wrapper for one build worker, implementing worker-pool.ts's WorkerHandle so
// WaveformWorkerPool can't tell it apart from a fake in tests. Sends 'init' once at construction
// (File is structured-cloneable, same precedent as src/media/index/worker-client.ts and
// src/media/frames/worker-client.ts) so every build() call after that only needs to carry job
// descriptors, not the file itself.

import type { WaveformWorkerRequest, WaveformWorkerResponse } from './worker-protocol';
import type { WorkerBuildRequest, WorkerBuildResult, WorkerHandle } from './worker-pool';

export class WaveformWorkerClient implements WorkerHandle {
  private readonly worker: Worker;
  private readonly pending = new Map<number, (result: WorkerBuildResult) => void>();

  constructor(file: File) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WaveformWorkerResponse>) => {
      this.handleMessage(e.data);
    };
    this.worker.onerror = (e: ErrorEvent) => {
      // A worker-level error (e.g. a syntax error, an uncaught throw outside handleBuild's own
      // try/catch) with no requestId to attribute it to -- fail every request currently pending
      // rather than let them hang forever, mirroring RealWaveformDecoder's own error() handling.
      const failed = Array.from(this.pending.values());
      this.pending.clear();
      for (const resolve of failed) resolve({ requestId: -1, pyramid: [], errors: [{ kind: 'decode-error', message: e.message, jobId: -1 }], cancelled: false });
    };
    const initMessage: WaveformWorkerRequest = { type: 'init', file };
    this.worker.postMessage(initMessage);
  }

  build(request: WorkerBuildRequest): Promise<WorkerBuildResult> {
    return new Promise((resolve) => {
      this.pending.set(request.requestId, resolve);
      const message: WaveformWorkerRequest = { type: 'build', requestId: request.requestId, config: request.config, jobs: [...request.jobs], flushEvery: request.flushEvery };
      this.worker.postMessage(message);
    });
  }

  cancel(requestId: number): void {
    const message: WaveformWorkerRequest = { type: 'cancel', requestId };
    this.worker.postMessage(message);
  }

  terminate(): void {
    this.worker.terminate();
  }

  private handleMessage(msg: WaveformWorkerResponse): void {
    const resolve = this.pending.get(msg.requestId);
    if (!resolve) return; // response for a request we're no longer tracking (already handled, or from before a stale message)
    this.pending.delete(msg.requestId);
    if (msg.type === 'worker-error') {
      resolve({ requestId: msg.requestId, pyramid: [], errors: [{ kind: 'decode-error', message: msg.message, jobId: -1 }], cancelled: false });
      return;
    }
    resolve({ requestId: msg.requestId, pyramid: msg.pyramid, errors: msg.errors, cancelled: msg.cancelled });
  }
}
