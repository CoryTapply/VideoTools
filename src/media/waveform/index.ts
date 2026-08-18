// Public barrel for src/media/waveform/. See README.md for the module's design rationale.

export { WaveformCache } from './WaveformCache';
export type { WaveformCacheOptions, WaveformCacheStats } from './WaveformCache';

export type { PeakColumn, Time } from './types';

export type { DecodeAudioJob, DecodedAudioChunk, WaveformDecodeBatchResult, WaveformDecodeError, WaveformDecoder, WaveformDecoderConfig } from './WaveformDecoder';
export { DEFAULT_FLUSH_EVERY, formatWaveformDecodeError } from './WaveformDecoder';
export { RealWaveformDecoder } from './RealWaveformDecoder';
export { FakeWaveformDecoder } from './FakeWaveformDecoder';
export type { FakeWaveformDecoderOptions, SampleGenerator } from './FakeWaveformDecoder';

export type { WaveformDecoderConfigWire, WaveformJobDescriptor, WirePyramidLevel, WorkerBuildRequest, WorkerBuildResult, WorkerHandle } from './worker-pool';
export { WaveformWorkerPool } from './worker-pool';
export { WaveformWorkerClient } from './worker-client';

export type { WaveformSampleDescriptor } from './job-builder';
export { buildWaveformJobs } from './job-builder';

export type { PyramidLevel, PyramidLevelSpec } from './pyramid';
export { buildLevelSpecs, DEFAULT_L0_SAMPLES_PER_BUCKET, DEFAULT_RATIO, estimatePyramidBytes, PEAK_INT16_MAX, PyramidBuilder } from './pyramid';

export type { CachedPyramid, PyramidCacheReadResult, PyramidCacheWriteResult } from './opfs-cache';
export { deserializePyramid, readPyramidCache, SCHEMA_VERSION, serializePyramid, writePyramidCache } from './opfs-cache';
