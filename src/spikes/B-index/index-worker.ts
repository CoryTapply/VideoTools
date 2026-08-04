// Spike B / Step 4 -- worker-side handler for the transfer benchmark. See
// prompts/m0.5-spike-prompts.md Step 4. Works identically whether the buffers arrived via the
// transfer list (ArrayBuffer, moved) or as SharedArrayBuffer (shared, not moved) -- typed array
// construction is the same either way.

// tsconfig's lib is DOM (main-thread), not WebWorker, so DedicatedWorkerGlobalScope isn't
// ambiently available -- declare just the shape this file needs.
declare const self: {
  onmessage: ((e: MessageEvent<WorkerTransferPayload>) => void) | null;
  postMessage: (message: unknown) => void;
};

export interface WorkerTransferPayload {
  dts: ArrayBuffer | SharedArrayBuffer;
  cts: ArrayBuffer | SharedArrayBuffer;
  size: ArrayBuffer | SharedArrayBuffer;
  offset: ArrayBuffer | SharedArrayBuffer;
  sync: ArrayBuffer | SharedArrayBuffer;
  sampleCount: number;
}

self.onmessage = (e: MessageEvent<WorkerTransferPayload>) => {
  const { dts, cts, size, offset, sync, sampleCount } = e.data;
  // Actually read the data (not just check byteLength) to prove the worker has a genuinely
  // usable view, not an opaque/detached handle.
  const dtsView = new Float64Array(dts);
  const ctsView = new Float64Array(cts);
  const sizeView = new Uint32Array(size);
  const offsetView = new Float64Array(offset);
  const syncView = new Uint8Array(sync);

  let checksum = 0;
  const n = Math.min(1000, sampleCount);
  for (let i = 0; i < n; i += 1) checksum += dtsView[i]! + ctsView[i]! + sizeView[i]! + offsetView[i]! + syncView[i]!;

  self.postMessage({
    ok: true,
    checksum,
    receivedByteLengths: { dts: dts.byteLength, cts: cts.byteLength, size: size.byteLength, offset: offset.byteLength, sync: sync.byteLength },
  });
};
