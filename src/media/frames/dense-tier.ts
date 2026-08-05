// Dense tier rebuild orchestration (Part 1 + Part 7): unlike the coarse tier's many independent
// keyframe jobs, one dense window is a SINGLE decode chain that must be submitted and decoded as
// one ordered unit (see job-builder.ts's buildDenseWindowJobs) -- so there's no priority queue
// here, just submit-and-await-one-request, with real cancellation (via FrameWorkerPool.cancel())
// when a newer viewport supersedes an in-flight build before it finishes.

import type { FrameDecodeError, FrameDecoderConfig, ThumbnailSize } from './FrameDecoder';
import type { TimedJob } from './job-builder';
import type { FrameWorkerPool, WorkerDecodedThumbnail } from './worker-pool';

export interface RebuildDenseDeps {
  readonly pool: FrameWorkerPool;
  readonly config: FrameDecoderConfig;
  readonly size: ThumbnailSize;
  readonly jobs: readonly TimedJob[];
  readonly requestId: number;
}

export interface RebuildDenseResult {
  readonly thumbnails: readonly WorkerDecodedThumbnail[];
  readonly errors: readonly FrameDecodeError[];
  readonly cancelled: boolean;
}

export async function rebuildDense(deps: RebuildDenseDeps): Promise<RebuildDenseResult> {
  if (deps.jobs.length === 0) return { thumbnails: [], errors: [], cancelled: false };
  const result = await deps.pool.submit({
    requestId: deps.requestId,
    config: deps.config,
    jobs: deps.jobs.map((j) => j.job),
    size: deps.size,
  });
  return { thumbnails: result.thumbnails, errors: result.errors, cancelled: result.cancelled };
}
