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
import { FileByteSource } from './sources/file-byte-source';
import type { TrackIndex } from './track-index';
import type { SerializedTrack, WorkerRequest, WorkerResponse } from './worker-protocol';

type TypedArrayLike = Float64Array | Uint32Array | Uint8Array;

/**
 * SharedArrayBuffer under crossOriginIsolated (measured in Spike B: 9.03ms posting to 2 workers
 * concurrently beats 25.34ms via transferables to a single worker), transferables otherwise --
 * per task spec §6 and architecture v2 §5.2's COOP/COEP requirement (already configured in
 * vite.config.ts, toggled by `npm run dev:coi`).
 */
function toTransferBuffer(view: TypedArrayLike): ArrayBuffer | SharedArrayBuffer {
  if (typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated) {
    const sab = new SharedArrayBuffer(view.byteLength);
    const Ctor = view.constructor as new (buf: SharedArrayBuffer) => TypedArrayLike;
    new Ctor(sab).set(view);
    return sab;
  }
  // Copy into a fresh, non-shared ArrayBuffer before transferring -- the source TrackIndex's own
  // arrays must not be detached out from under whatever else in this worker might reference them.
  return view.slice().buffer;
}

function serializeTrack(track: TrackIndex): SerializedTrack {
  return {
    trackId: track.trackId,
    kind: track.kind,
    handlerType: track.handlerType,
    codec: track.codec,
    timescale: track.timescale,
    duration: track.duration,
    sampleCount: track.sampleCount,
    pts: toTransferBuffer(track.pts),
    dts: toTransferBuffer(track.dts),
    offset: toTransferBuffer(track.offset),
    size: toTransferBuffer(track.size),
    isSync: toTransferBuffer(track.isSync),
    description: track.description,
    video: track.video,
    audio: track.audio,
    editOffsetTicks: track.editOffsetTicks,
    editList: track.editList,
  };
}

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
    const transferables: Transferable[] = [];
    for (const t of tracks) {
      for (const buf of [t.pts, t.dts, t.offset, t.size, t.isSync]) {
        if (buf instanceof ArrayBuffer) transferables.push(buf);
      }
    }

    self.postMessage(
      { type: 'result', ok: true, mvhdTimescale: result.mvhdTimescale, mvhdDuration: result.mvhdDuration, warnings: result.warnings, tracks },
      transferables,
    );
  })();
};
