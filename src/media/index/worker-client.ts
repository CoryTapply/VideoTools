// Main-thread-safe wrapper. Per task spec §6, the worker API is a single call:
//   index(file) -> TrackIndex[] | IndexError
// with a progress callback -- this class is that call; worker.ts is the thing it talks to.

import type { IndexError, IndexWarning } from './errors';
import type { TrackIndex } from './track-index';
import type { SerializedTrack, WorkerProgressPhase, WorkerResponse } from './worker-protocol';

export type IndexWorkerResult =
  | { ok: true; tracks: TrackIndex[]; mvhdTimescale: number; mvhdDuration: number; warnings: IndexWarning[] }
  | { ok: false; error: IndexError };

function toTypedArray<T extends Float64Array | Uint32Array | Uint8Array>(Ctor: new (buf: ArrayBuffer | SharedArrayBuffer) => T, buf: ArrayBuffer | SharedArrayBuffer): T {
  return new Ctor(buf);
}

function deserializeTrack(t: SerializedTrack): TrackIndex {
  return {
    trackId: t.trackId,
    kind: t.kind,
    handlerType: t.handlerType,
    codec: t.codec,
    timescale: t.timescale,
    duration: t.duration,
    sampleCount: t.sampleCount,
    pts: toTypedArray(Float64Array, t.pts),
    dts: toTypedArray(Float64Array, t.dts),
    offset: toTypedArray(Float64Array, t.offset),
    size: toTypedArray(Uint32Array, t.size),
    isSync: toTypedArray(Uint8Array, t.isSync),
    description: t.description,
    video: t.video,
    audio: t.audio,
    editOffsetTicks: t.editOffsetTicks,
    editList: t.editList,
  };
}

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
