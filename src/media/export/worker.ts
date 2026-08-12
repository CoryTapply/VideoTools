// The worker-side entry point for export. Mirrors src/media/index/worker.ts's shape: thin, the
// real logic (RemuxStrategy.ts through copy-loop.ts) stays pure and worker-agnostic.
//
// Deliberately re-derives the selection itself (resolveExportSelection, inside runRemuxExport)
// from the raw ingredients (tracks, selectedTrackIds, requested in/out) rather than trusting a
// pre-computed plan shipped over postMessage -- the same function the main thread calls for its
// live "est. size" estimate is invoked here independently, so nothing correctness-critical crosses
// the worker boundary as a pre-trusted value.
declare const self: {
  onmessage: ((e: MessageEvent<ExportWorkerRequest>) => void) | null;
  postMessage: (message: ExportWorkerResponse) => void;
};

import { SampleIndex } from '../index/query';
import { deserializeTrack } from '../index/serialize-track';
import { FileByteSource } from '../index/sources/file-byte-source';
import { runRemuxExport } from './RemuxStrategy';
import { FileSystemWritableSink } from './sinks/file-system-sink';
import type { CancelSignal } from './copy-loop';
import type { ExportWorkerRequest, ExportWorkerResponse, ExportWorkerStartRequest } from './worker-protocol';

const signals = new Map<number, CancelSignal>();

self.onmessage = (e: MessageEvent<ExportWorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    const signal = signals.get(msg.requestId);
    if (signal) signal.cancelled = true;
    return;
  }
  void handleStart(msg);
};

async function handleStart(req: ExportWorkerStartRequest): Promise<void> {
  const { requestId, file, fileHandle, tracks: serializedTracks, selectedTrackIds, requestedInSec, requestedOutSec } = req;
  const signal: CancelSignal = { cancelled: false };
  signals.set(requestId, signal);

  try {
    const tracks = serializedTracks.map(deserializeTrack);
    const sampleIndex = new SampleIndex(tracks);
    const sink = await FileSystemWritableSink.create(fileHandle);

    const result = await runRemuxExport({
      source: new FileByteSource(file),
      sink,
      tracks,
      sampleIndex,
      selectedTrackIds: new Set(selectedTrackIds),
      requestedInSec,
      requestedOutSec,
      signal,
      onProgress: (progress) => {
        self.postMessage({ type: 'progress', requestId, progress });
      },
    });
    self.postMessage({ type: 'result', requestId, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: 'result', requestId, result: { ok: false, error: { kind: 'write-failed', message } } });
  } finally {
    signals.delete(requestId);
  }
}
