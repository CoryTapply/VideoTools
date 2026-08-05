// Public barrel for src/media/frames/. See README.md for the module's design rationale.

export { FrameCache, DEFAULT_BUDGET_BYTES, DEFAULT_COARSE_SIZE, DEFAULT_DENSE_SIZE } from './FrameCache';
export type { FrameCacheOptions, Unsubscribe } from './FrameCache';

export type { CachedFrame, FrameTier, Time } from './types';

export type { Closable, FrameLifecycleRegistry } from './frame-lifecycle';
export { createFrameLifecycleRegistry, withFrame, withFrameAsync, assertNoStaleFrames, StaleFrameError } from './frame-lifecycle';

export type { DecodeJob, DecodedBitmap, DecodedThumbnail, FrameDecodeBatchResult, FrameDecodeError, FrameDecoder, FrameDecoderConfig, ThumbnailSize } from './FrameDecoder';
export { DEFAULT_BATCH_SIZE } from './FrameDecoder';
export { RealFrameDecoder } from './RealFrameDecoder';
export { FakeFrameDecoder } from './FakeFrameDecoder';
export type { FakeFrameDecoderOptions } from './FakeFrameDecoder';

export type { DecodeJobDescriptor, WorkerDecodeRequest, WorkerDecodedThumbnail, WorkerDecodeResult, WorkerHandle } from './worker-pool';
export { FrameWorkerPool, defaultWorkerCount } from './worker-pool';
export { FrameWorkerClient } from './worker-client';

export type { AtlasSlot, TileRect } from './atlas-layout';
export { ATLAS_CAPACITY, ATLAS_GRID, atlasSlotFor, tileRect } from './atlas-layout';
export type { AtlasCacheKeyInput, AtlasReadResult, AtlasTier, AtlasWriteResult } from './atlas-cache';
export { ATLAS_SCHEMA_VERSION, atlasCacheKey, readAtlas, writeAtlas } from './atlas-cache';
export type { PackedAtlas } from './atlas-pack';
export { ATLAS_WEBP_QUALITY, cropTile, decodeAtlas, packAtlas } from './atlas-pack';

export type { FrameLru, FrameLruRemovalListener } from './lru';
export { createFrameLru, estimateRgbaBytes } from './lru';

export type { ScheduledItem, SchedulerProgress } from './scheduler';
export { PriorityScheduler } from './scheduler';

export type { TimedJob } from './job-builder';
export { buildCoarseJobs, buildDenseWindowJobs } from './job-builder';

export { binarySearchNearest } from './binary-search';
