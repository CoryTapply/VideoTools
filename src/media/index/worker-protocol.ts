// Message shapes shared by both sides of the worker boundary (worker.ts / worker-client.ts).
// Typed arrays cross as ArrayBuffer or SharedArrayBuffer -- see worker.ts's toTransferBuffer for
// which one gets used and why. Everything else (scalars, video/audio meta, editList, the small
// codec description blob) is small enough to structured-clone directly.

import type { EditListEntry } from './moov/edit-list';
import type { IndexError, IndexWarning } from './errors';
import type { AudioTrackMeta, VideoTrackMeta } from './track-index';

export interface SerializedTrack {
  trackId: number;
  kind: 'video' | 'audio' | 'other';
  handlerType: string;
  codec: string;
  timescale: number;
  duration: number;
  sampleCount: number;
  pts: ArrayBuffer | SharedArrayBuffer;
  dts: ArrayBuffer | SharedArrayBuffer;
  offset: ArrayBuffer | SharedArrayBuffer;
  size: ArrayBuffer | SharedArrayBuffer;
  isSync: ArrayBuffer | SharedArrayBuffer;
  description: Uint8Array;
  video?: VideoTrackMeta;
  audio?: AudioTrackMeta;
  editOffsetTicks: number;
  editList?: EditListEntry[];
}

export interface WorkerRequest {
  type: 'index';
  file: File;
}

export type WorkerProgressPhase = 'scanning' | 'parsing' | 'transferring';

export type WorkerResponse =
  | { type: 'progress'; phase: WorkerProgressPhase }
  | { type: 'result'; ok: true; mvhdTimescale: number; mvhdDuration: number; warnings: IndexWarning[]; tracks: SerializedTrack[] }
  | { type: 'result'; ok: false; error: IndexError };
