// Shared by src/media/index/worker.ts + worker-client.ts AND src/media/export/worker.ts +
// worker-client.ts: crossing a TrackIndex across the main-thread <-> worker boundary. Only
// actually executed from real worker/main-thread code paths (never from a Node-tested call site),
// same constraint the original single-module version had before this file existed.

import type { SerializedTrack } from './worker-protocol';
import type { TrackIndex } from './track-index';

type TypedArrayLike = Float64Array | Uint32Array | Uint8Array;

// tsconfig's lib is DOM (main-thread), not WebWorker, so DedicatedWorkerGlobalScope isn't
// ambiently available -- declare just the shape this file needs (same convention worker.ts used
// before this file existed). `self.crossOriginIsolated` is defined on both Window and
// WorkerGlobalScope per spec, so this same declaration serves both call sites below.
declare const self: { crossOriginIsolated: boolean };

/**
 * SharedArrayBuffer under crossOriginIsolated (measured in Spike B: 9.03ms posting to 2 workers
 * concurrently beats 25.34ms via transferables to a single worker), transferables otherwise --
 * per task spec §6 and architecture v2 §5.2's COOP/COEP requirement (already configured in
 * vite.config.ts, toggled by `npm run dev:coi`).
 */
export function toTransferBuffer(view: TypedArrayLike): ArrayBuffer | SharedArrayBuffer {
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

export function serializeTrack(track: TrackIndex): SerializedTrack {
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

/** Every ArrayBuffer among a batch of serialized tracks' typed-array fields, for postMessage's transfer list. SharedArrayBuffers aren't transferable and are silently skipped, as intended. */
export function collectTransferables(tracks: SerializedTrack[]): Transferable[] {
  const transferables: Transferable[] = [];
  for (const t of tracks) {
    for (const buf of [t.pts, t.dts, t.offset, t.size, t.isSync]) {
      if (buf instanceof ArrayBuffer) transferables.push(buf);
    }
  }
  return transferables;
}

function toTypedArray<T extends Float64Array | Uint32Array | Uint8Array>(Ctor: new (buf: ArrayBuffer | SharedArrayBuffer) => T, buf: ArrayBuffer | SharedArrayBuffer): T {
  return new Ctor(buf);
}

export function deserializeTrack(t: SerializedTrack): TrackIndex {
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
