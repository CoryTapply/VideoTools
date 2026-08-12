// Message shapes shared by both sides of the export worker boundary (worker.ts / worker-client.ts).
// Cancellation is message-based, not AbortSignal-based -- AbortSignal isn't structured-cloneable,
// mirroring src/media/frames/worker-client.ts's FrameWorkerClient.cancel(requestId) pattern.
// FileSystemFileHandle is [Serializable] per spec and crosses postMessage directly, same as File --
// see sinks/file-system-sink.ts for why a single file handle (not a directory handle) crosses the
// boundary.

import type { SerializedTrack } from '../index/worker-protocol';
import type { ExportProgress, ExportResult } from './types';

export interface ExportWorkerStartRequest {
  type: 'start';
  requestId: number;
  file: File;
  fileHandle: FileSystemFileHandle;
  tracks: SerializedTrack[];
  selectedTrackIds: number[];
  requestedInSec: number;
  requestedOutSec: number;
}

export interface ExportWorkerCancelRequest {
  type: 'cancel';
  requestId: number;
}

export type ExportWorkerRequest = ExportWorkerStartRequest | ExportWorkerCancelRequest;

export type ExportWorkerResponse =
  | { type: 'progress'; requestId: number; progress: ExportProgress }
  | { type: 'result'; requestId: number; result: ExportResult };
