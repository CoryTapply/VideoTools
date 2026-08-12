// The orchestrator. Sequence: resolve the selection -> read the source's raw moov boxes -> build
// the output moov (pass 1, no I/O) -> write moov+mdat-header -> the merged copy loop (pass 2,
// bytes) -> close. Sink-injected (ExportSink) so this stays Node-testable against a fake sink --
// see RemuxStrategy.test.ts's differential round-trip test, which feeds a fake sink's accumulated
// output back through the production parser (build-index.ts) to prove structural validity without
// a browser.
//
// Deliberately a callback-based `onProgress`, not an async generator -- matches this codebase's
// existing worker-client precedent (IndexWorkerClient.index(file, onProgress)) rather than
// introducing a second progress-reporting shape. yielding from *inside* the copy loop's nested
// onWindow callback isn't possible with a generator's own yield anyway (different call stack).
//
// Cancel safety is structural, not disciplinary: sink.close() is only ever reached on the
// non-cancelled path. Every other exit -- a write failure, or signal.cancelled observed after the
// copy loop -- goes through sink.abort() instead. See README.md's "temp-name-and-rename" section
// for why that's sufficient (no app-level temp-file/rename bookkeeping needed).

import { COALESCE_WINDOW_BYTES, forEachWindowMerged, type CancelSignal } from './copy-loop';
import { estimateExportBytes } from './estimate';
import { buildMdatHeader, buildMoovMerged } from './moov-builder';
import { shouldShowFinalisingPhase } from './progress';
import { readRawMoovBoxes } from './raw-boxes';
import { resolveExportSelection } from './select';
import type { ByteSource } from '../index/byte-source';
import type { SampleIndex } from '../index/query';
import type { TrackIndex } from '../index/track-index';
import type { ExportError, ExportProgress, ExportResult } from './types';

export interface ExportSink {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: string): Promise<void>;
}

export interface RunRemuxExportInput {
  source: ByteSource;
  sink: ExportSink;
  tracks: readonly TrackIndex[];
  sampleIndex: SampleIndex;
  selectedTrackIds: ReadonlySet<number>;
  requestedInSec: number;
  requestedOutSec: number;
  signal: CancelSignal;
  onProgress?: (progress: ExportProgress) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runRemuxExport(input: RunRemuxExportInput): Promise<ExportResult> {
  const t0 = Date.now();
  const { source, sink, tracks, sampleIndex, selectedTrackIds, requestedInSec, requestedOutSec, signal, onProgress } = input;

  const videoTrack = tracks.find((t) => t.kind === 'video');
  if (!videoTrack) return { ok: false, error: { kind: 'no-video-track' } };

  const selectionResult = resolveExportSelection(sampleIndex, tracks, selectedTrackIds, requestedInSec, requestedOutSec);
  if ('error' in selectionResult) return { ok: false, error: selectionResult.error };
  const selection = selectionResult;

  const rawResult = await readRawMoovBoxes(source);
  if ('error' in rawResult) {
    const detail = rawResult.error.kind === 'no-moov' ? 'source has no moov box' : rawResult.error.detail;
    return { ok: false, error: { kind: 'malformed-source', detail } };
  }

  const tracksById = new Map(tracks.map((t) => [t.trackId, t]));
  // Pass 1: builds ftyp+moov entirely from the index -- no I/O, never touches mdat bytes.
  const built = buildMoovMerged(rawResult, tracksById, selection, videoTrack.timescale);
  const totalBytesEstimate = estimateExportBytes(selection, tracksById);
  const showFinalising = shouldShowFinalisingPhase(totalBytesEstimate);

  const abortWith = async (error: ExportError): Promise<ExportResult> => {
    await sink.abort(error.kind);
    return { ok: false, error };
  };

  try {
    await sink.write(built.bytes);
    await sink.write(buildMdatHeader(built.mdatContentBytes));
  } catch (err) {
    return abortWith({ kind: 'write-failed', message: errorMessage(err) });
  }

  let bytesWritten = 0;
  let lastReportedPercent = -1;
  onProgress?.({ phase: 'copy', percent: 0, bytesWritten, totalBytesEstimate });

  try {
    await forEachWindowMerged(
      source,
      selection.ranges,
      tracksById,
      COALESCE_WINDOW_BYTES,
      async (bytes) => {
        await sink.write(bytes);
        bytesWritten += bytes.byteLength;
        const percent = totalBytesEstimate > 0 ? Math.min(99, Math.floor((bytesWritten / totalBytesEstimate) * 100)) : 0;
        if (percent !== lastReportedPercent) {
          lastReportedPercent = percent;
          onProgress?.({ phase: 'copy', percent, bytesWritten, totalBytesEstimate });
        }
      },
      signal,
    );
  } catch (err) {
    return abortWith({ kind: 'write-failed', message: errorMessage(err) });
  }

  // Checked after the copy loop, not just inside it -- cancelling on the very last window must
  // still take the abort path, never close(), even though every byte happened to be written.
  if (signal.cancelled) return abortWith({ kind: 'cancelled' });

  if (showFinalising) onProgress?.({ phase: 'finalising', percent: 99, bytesWritten, totalBytesEstimate });

  try {
    await sink.close();
  } catch (err) {
    // Per the File System Access spec, a rejected close() never applies the swap -- the
    // destination (new or pre-existing) is left untouched. Nothing to undo here; just report it
    // honestly instead of a false success.
    return { ok: false, error: { kind: 'close-failed', message: errorMessage(err) } };
  }

  onProgress?.({ phase: 'finalising', percent: 100, bytesWritten, totalBytesEstimate });
  return { ok: true, bytesWritten, wallMs: Date.now() - t0 };
}
