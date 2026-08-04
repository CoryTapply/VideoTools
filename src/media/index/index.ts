// Public barrel for src/media/index/. See README.md for the module's design rationale.

export type { ByteSource } from './byte-source';
export { CountingByteSource } from './byte-source';
export { BufferByteSource } from './sources/buffer-byte-source';
export { FileByteSource } from './sources/file-byte-source';
export { NodeByteSource } from './sources/node-byte-source';

export type { IndexError, IndexWarning } from './errors';
export { formatIndexError } from './errors';

export { ticksToSeconds, secondsToTicks, localTicksToPresentationSeconds } from './time';

export type { TrackIndex, VideoTrackMeta, AudioTrackMeta } from './track-index';
export type { EditListEntry } from './moov/edit-list';

export type { IndexResult, IndexSuccess, IndexFailure } from './build-index';
export { buildIndex } from './build-index';

export { SampleIndex } from './query';

export type { FileFingerprint } from './fingerprint';
export { computeFingerprint, fingerprintsEqual } from './fingerprint';

export type { CachedIndex, CacheReadResult, CacheWriteResult } from './opfs-cache';
export { SCHEMA_VERSION, readIndexCache, writeIndexCache } from './opfs-cache';

export type { IndexWorkerResult } from './worker-client';
export { IndexWorkerClient } from './worker-client';
export type { WorkerProgressPhase } from './worker-protocol';
