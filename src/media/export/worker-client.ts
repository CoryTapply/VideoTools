// Main-thread-safe wrapper for the export worker. One client instance per export attempt (like
// src/media/frames/worker-client.ts's FrameWorkerClient, not pooled/reused) -- simpler lifecycle,
// no stale-state risk across exports.

import { collectTransferables, serializeTrack } from '../index/serialize-track';
import type { TrackIndex } from '../index/track-index';
import type { ExportProgress, ExportResult } from './types';
import type { ExportWorkerRequest, ExportWorkerResponse } from './worker-protocol';

export interface ExportJob {
  file: File;
  fileHandle: FileSystemFileHandle;
  tracks: readonly TrackIndex[];
  selectedTrackIds: ReadonlySet<number>;
  requestedInSec: number;
  requestedOutSec: number;
}

let nextRequestId = 1;

export class ExportWorkerClient {
  private readonly worker: Worker;
  private requestId: number | null = null;

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  }

  export(job: ExportJob, onProgress?: (progress: ExportProgress) => void): Promise<ExportResult> {
    const requestId = nextRequestId;
    nextRequestId += 1;
    this.requestId = requestId;

    return new Promise((resolve, reject) => {
      this.worker.onmessage = (e: MessageEvent<ExportWorkerResponse>) => {
        const msg = e.data;
        if (msg.requestId !== requestId) return; // a stale message from a previous export
        if (msg.type === 'progress') {
          onProgress?.(msg.progress);
          return;
        }
        resolve(msg.result);
      };
      this.worker.onerror = (e: ErrorEvent) => {
        reject(new Error(e.message));
      };

      const serialized = job.tracks.map(serializeTrack);
      const transferables = collectTransferables(serialized);
      const message: ExportWorkerRequest = {
        type: 'start',
        requestId,
        file: job.file,
        fileHandle: job.fileHandle,
        tracks: serialized,
        selectedTrackIds: [...job.selectedTrackIds],
        requestedInSec: job.requestedInSec,
        requestedOutSec: job.requestedOutSec,
      };
      this.worker.postMessage(message, transferables);
    });
  }

  /** Fire-and-forget -- the pending export()'s promise resolves once the worker reports the
   * cancelled result, it isn't resolved directly by this call. */
  cancel(): void {
    if (this.requestId === null) return;
    const message: ExportWorkerRequest = { type: 'cancel', requestId: this.requestId };
    this.worker.postMessage(message);
  }

  terminate(): void {
    this.worker.terminate();
  }
}
