// The worker-side entry point. Thin on purpose: the parser (build-index.ts through query.ts)
// stays pure and worker-agnostic -- this file's only job is running it off the main thread and
// choosing how to hand the result back.
//
// tsconfig's lib is DOM (main-thread), not WebWorker, so DedicatedWorkerGlobalScope isn't
// ambiently available -- declare just the shape this file needs (same convention as the spike's
// src/spikes/B-index/index-worker.ts).
declare const self: {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse, transfer?: Transferable[]) => void;
  crossOriginIsolated: boolean;
};

import { buildIndex } from './build-index';
import { collectTransferables, serializeTrack } from './serialize-track';
import { FileByteSource } from './sources/file-byte-source';
import type { WorkerRequest, WorkerResponse } from './worker-protocol';

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  void (async () => {
    const { file } = e.data;
    self.postMessage({ type: 'progress', phase: 'scanning' });

    const result = await buildIndex(new FileByteSource(file));
    if (!result.ok) {
      self.postMessage({ type: 'result', ok: false, error: result.error });
      return;
    }

    self.postMessage({ type: 'progress', phase: 'transferring' });
    const tracks = result.tracks.map(serializeTrack);
    const transferables = collectTransferables(tracks);

    self.postMessage(
      { type: 'result', ok: true, mvhdTimescale: result.mvhdTimescale, mvhdDuration: result.mvhdDuration, warnings: result.warnings, tracks },
      transferables,
    );
  })();
};
