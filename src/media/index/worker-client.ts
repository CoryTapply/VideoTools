// Main-thread-safe wrapper. Per task spec §6, the worker API is a single call:
//   index(file) -> TrackIndex[] | IndexError
// with a progress callback -- this class is that call; worker.ts is the thing it talks to.

import { deserializeTrack } from './serialize-track';
import type { IndexError, IndexWarning } from './errors';
import type { TrackIndex } from './track-index';
import type { WorkerProgressPhase, WorkerResponse } from './worker-protocol';

export type IndexWorkerResult =
  | { ok: true; tracks: TrackIndex[]; mvhdTimescale: number; mvhdDuration: number; warnings: IndexWarning[] }
  | { ok: false; error: IndexError };

export class IndexWorkerClient {
  private readonly worker: Worker;

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  }

  index(file: File, onProgress?: (phase: WorkerProgressPhase) => void): Promise<IndexWorkerResult> {
    return new Promise((resolve, reject) => {
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        if (msg.type === 'progress') {
          onProgress?.(msg.phase);
          return;
        }
        if (!msg.ok) {
          resolve({ ok: false, error: msg.error });
          return;
        }
        resolve({ ok: true, tracks: msg.tracks.map(deserializeTrack), mvhdTimescale: msg.mvhdTimescale, mvhdDuration: msg.mvhdDuration, warnings: msg.warnings });
      };
      this.worker.onerror = (e: ErrorEvent) => {
        reject(new Error(e.message));
      };
      this.worker.postMessage({ type: 'index', file });
    });
  }

  terminate(): void {
    this.worker.terminate();
  }
}
