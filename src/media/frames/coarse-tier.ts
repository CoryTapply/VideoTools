// Coarse tier build orchestration (Part 1 + Part 7): one independent job per keyframe, chunked
// and dispatched in priority order via PriorityScheduler so the build proceeds outward from the
// current playhead rather than from t=0. Pure dependency-injected logic -- FrameCache.ts owns all
// the actual state (the lookup arrays, the LRU); this function only drives the pool and reports
// results back through callbacks, which is what makes it testable against a fake pool in Node.

import { DEFAULT_BATCH_SIZE, type FrameDecodeError, type FrameDecoderConfig, type ThumbnailSize } from './FrameDecoder';
import { PriorityScheduler } from './scheduler';
import type { Time } from './types';
import type { TimedJob } from './job-builder';
import type { DecodeJobDescriptor, FrameWorkerPool, WorkerDecodeRequest, WorkerDecodedThumbnail } from './worker-pool';

export interface WarmCoarseDeps {
  readonly pool: FrameWorkerPool;
  readonly config: FrameDecoderConfig;
  readonly size: ThumbnailSize;
  readonly jobs: readonly TimedJob[];
  readonly initialCenter: Time;
  readonly chunkSize?: number;
  readonly nextRequestId: () => number;
  /** Checked before applying a chunk's results -- lets a superseded warmCoarse() (a fresh call, or clear()/dispose() firing mid-build) discard late results instead of resurrecting stale state. */
  readonly isCurrentGeneration: () => boolean;
  readonly onChunkDone: (thumbnails: readonly WorkerDecodedThumbnail[]) => void;
  readonly onProgress?: (completed: number, total: number) => void;
  /** Called with any decode errors from a chunk. Defaults to console.warn -- pass this to surface errors somewhere more visible than DevTools (e.g. an on-page log), since a caller watching only onProgress/onChunkDone would otherwise never learn a chunk silently produced zero thumbnails. */
  readonly onError?: (message: string, errors: readonly FrameDecodeError[]) => void;
}

export async function warmCoarse(deps: WarmCoarseDeps): Promise<void> {
  const scheduler = new PriorityScheduler<DecodeJobDescriptor>();
  scheduler.reset(
    deps.jobs.map(({ time, job }) => ({ key: String(job.id), time, payload: job })),
    deps.initialCenter,
  );
  const chunkSize = deps.chunkSize ?? DEFAULT_BATCH_SIZE * 2;

  const requests: WorkerDecodeRequest[] = [];
  while (scheduler.pendingCount > 0) {
    const chunk = scheduler.takeNext(chunkSize);
    requests.push({ requestId: deps.nextRequestId(), config: deps.config, jobs: chunk.map((c) => c.payload), size: deps.size });
  }

  await Promise.all(
    requests.map(async (req) => {
      const result = await deps.pool.submit(req);
      if (!deps.isCurrentGeneration()) {
        for (const t of result.thumbnails) t.bitmap.close();
        return;
      }
      if (!result.cancelled) {
        deps.onChunkDone(result.thumbnails);
        reportErrorsIfAny(result.errors, req.jobs.length, deps.onError);
      }
      scheduler.markCompleted(req.jobs.length);
      deps.onProgress?.(scheduler.progress.completed, scheduler.progress.total);
    }),
  );
}

function reportErrorsIfAny(errors: readonly FrameDecodeError[], jobCount: number, onError: WarmCoarseDeps['onError']): void {
  // Decode errors here are per-worker-instance failures (the offending worker's decoder became
  // unusable and stopped after the first one) -- surfaced for diagnostics, not thrown, since a
  // partial coarse warm (some keyframes missing) is still useful and the rest of the file's
  // chunks are on other, unaffected workers.
  if (errors.length === 0) return;
  const message = `coarse chunk (${String(jobCount)} jobs) had ${String(errors.length)} decode error(s): ${errors.map((e) => (e.kind === 'decode-error' ? e.message : e.kind)).join('; ')}`;
  if (onError) onError(message, errors);
  else console.warn(`frame cache: ${message}`, errors);
}
