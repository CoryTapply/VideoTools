// Spike B / Step 4 -- transfer the index to a Worker as transferables (zero-copy, but
// ownership moves -- only one worker can hold a given ArrayBuffer), then compare against a
// SharedArrayBuffer-backed copy (not zero-copy to set up, but the SAME memory can be posted to
// MULTIPLE workers simultaneously, which is the point of the comparison). See
// prompts/m0.5-spike-prompts.md Step 4.

import type { TrackIndex } from '../A-remux/mp4-index';
import type { WorkerTransferPayload } from './index-worker';

interface WorkerReply {
  ok: boolean;
  checksum: number;
  receivedByteLengths: Record<string, number>;
}

function makeWorker(): Worker {
  return new Worker(new URL('./index-worker.ts', import.meta.url), { type: 'module' });
}

async function roundTrip(worker: Worker, payload: WorkerTransferPayload, transferList?: Transferable[]): Promise<WorkerReply> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<WorkerReply>) => resolve(e.data);
    worker.onerror = (e) => reject(new Error(e.message));
    if (transferList) worker.postMessage(payload, transferList);
    else worker.postMessage(payload);
  });
}

export interface TransferableBenchResult {
  ms: number;
  zeroCopyConfirmed: boolean;
  reply: WorkerReply;
}

/** Copies the track's arrays first (so the caller's original TrackIndex is untouched), then transfers the copies. */
export async function benchTransferables(track: TrackIndex): Promise<TransferableBenchResult> {
  const dts = track.dts.slice().buffer;
  const cts = track.cts.slice().buffer;
  const size = track.size.slice().buffer;
  const offset = track.offset.slice().buffer;
  const sync = track.sync.slice().buffer;

  const worker = makeWorker();
  const t0 = performance.now();
  const reply = await roundTrip(worker, { dts, cts, size, offset, sync, sampleCount: track.sampleCount }, [dts, cts, size, offset, sync]);
  const ms = performance.now() - t0;
  worker.terminate();

  // A transferred ArrayBuffer is detached: its byteLength reads back as 0 in this (the sending) context.
  const zeroCopyConfirmed = dts.byteLength === 0 && cts.byteLength === 0 && size.byteLength === 0 && offset.byteLength === 0 && sync.byteLength === 0;
  return { ms, zeroCopyConfirmed, reply };
}

export interface SharedBenchResult {
  ms: number;
  reply: WorkerReply;
  secondWorkerReply: WorkerReply;
}

function toSAB(arr: Float64Array | Uint32Array | Uint8Array): SharedArrayBuffer {
  const sab = new SharedArrayBuffer(arr.byteLength);
  new (arr.constructor as { new (buf: SharedArrayBuffer): typeof arr })(sab).set(arr as never);
  return sab;
}

/** Copies into SharedArrayBuffers (not zero-copy, unlike transfer), then posts the SAME buffers to two separate workers to confirm both can read them concurrently. */
export async function benchSharedArrayBuffer(track: TrackIndex): Promise<SharedBenchResult> {
  const dts = toSAB(track.dts);
  const cts = toSAB(track.cts);
  const size = toSAB(track.size);
  const offset = toSAB(track.offset);
  const sync = toSAB(track.sync);
  const payload: WorkerTransferPayload = { dts, cts, size, offset, sync, sampleCount: track.sampleCount };

  const workerA = makeWorker();
  const workerB = makeWorker();
  const t0 = performance.now();
  const [reply, secondWorkerReply] = await Promise.all([roundTrip(workerA, payload), roundTrip(workerB, payload)]);
  const ms = performance.now() - t0;
  workerA.terminate();
  workerB.terminate();

  return { ms, reply, secondWorkerReply };
}
