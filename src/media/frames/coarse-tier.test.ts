import { describe, expect, it } from 'vitest';
import { warmCoarse } from './coarse-tier';
import { FrameWorkerPool, type WorkerDecodeRequest, type WorkerDecodeResult, type WorkerHandle } from './worker-pool';
import type { FrameDecoderConfig } from './FrameDecoder';
import type { TimedJob } from './job-builder';
import type { Closable } from './frame-lifecycle';

class FakeBitmap implements Closable {
  closed = false;
  readonly width = 160;
  readonly height = 90;
  close(): void {
    this.closed = true;
  }
}

/** Resolves decode() requests immediately, one bitmap per kept job -- realistic enough to exercise warmCoarse's chunking and result-application logic without a real decoder. */
class ImmediateWorkerHandle implements WorkerHandle {
  decodeCalls: WorkerDecodeRequest[] = [];
  terminateCalls = 0;

  decode(request: WorkerDecodeRequest): Promise<WorkerDecodeResult> {
    this.decodeCalls.push(request);
    const thumbnails = request.jobs.filter((j) => j.keep).map((j) => ({ id: j.id, presentationTime: j.presentationTime, bitmap: new FakeBitmap() }));
    return Promise.resolve({ requestId: request.requestId, thumbnails, errors: [], cancelled: false });
  }

  cancel(): void {
    // not exercised here -- cancellation-under-load is covered by worker-pool.test.ts
  }

  terminate(): void {
    this.terminateCalls += 1;
  }
}

const config: FrameDecoderConfig = { codec: 'avc1.640034', codedWidth: 3840, codedHeight: 2160, description: new Uint8Array() };
const size = { width: 160, height: 90 };

function keyframeJobs(count: number, spacingTicks = 4166): TimedJob[] {
  return Array.from({ length: count }, (_, i) => ({
    time: i * spacingTicks,
    job: { id: i, offset: i * 1000, size: 500, presentationTime: i * spacingTicks, type: 'key' as const, keep: true },
  }));
}

describe('warmCoarse', () => {
  it('dispatches every job and delivers all thumbnails via onChunkDone', async () => {
    const handle = new ImmediateWorkerHandle();
    const pool = new FrameWorkerPool([handle]);
    const received: number[] = [];
    let nextId = 1;

    await warmCoarse({
      pool,
      config,
      size,
      jobs: keyframeJobs(10),
      initialCenter: 0,
      chunkSize: 4,
      nextRequestId: () => nextId++,
      isCurrentGeneration: () => true,
      onChunkDone: (thumbnails) => {
        for (const t of thumbnails) received.push(t.id);
      },
    });

    expect(received.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('chunks jobs into requests no larger than chunkSize', async () => {
    const handle = new ImmediateWorkerHandle();
    const pool = new FrameWorkerPool([handle]);
    let nextId = 1;

    await warmCoarse({
      pool,
      config,
      size,
      jobs: keyframeJobs(10),
      initialCenter: 0,
      chunkSize: 4,
      nextRequestId: () => nextId++,
      isCurrentGeneration: () => true,
      onChunkDone: () => undefined,
    });

    expect(handle.decodeCalls.every((req) => req.jobs.length <= 4)).toBe(true);
    expect(handle.decodeCalls.reduce((sum, req) => sum + req.jobs.length, 0)).toBe(10);
  });

  it('dispatches the chunk nearest initialCenter first ("builds outward from the playhead")', async () => {
    const handle = new ImmediateWorkerHandle();
    const pool = new FrameWorkerPool([handle]); // pool size 1 -- chunks dispatch strictly in submission order
    let nextId = 1;

    await warmCoarse({
      pool,
      config,
      size,
      jobs: keyframeJobs(12, 1000), // times 0..11000
      initialCenter: 6000,
      chunkSize: 3,
      nextRequestId: () => nextId++,
      isCurrentGeneration: () => true,
      onChunkDone: () => undefined,
    });

    const firstChunkIds = handle.decodeCalls[0]?.jobs.map((j) => j.id) ?? [];
    expect(firstChunkIds).toContain(6); // job at t=6000, nearest the center
  });

  it('reports progress as chunks complete', async () => {
    const handle = new ImmediateWorkerHandle();
    const pool = new FrameWorkerPool([handle]);
    const progressCalls: Array<[number, number]> = [];
    let nextId = 1;

    await warmCoarse({
      pool,
      config,
      size,
      jobs: keyframeJobs(10),
      initialCenter: 0,
      chunkSize: 4,
      nextRequestId: () => nextId++,
      isCurrentGeneration: () => true,
      onChunkDone: () => undefined,
      onProgress: (completed, total) => progressCalls.push([completed, total]),
    });

    expect(progressCalls.at(-1)).toEqual([10, 10]);
  });

  it('discards (closes) results from a superseded generation instead of applying them', async () => {
    const handle = new ImmediateWorkerHandle();
    const pool = new FrameWorkerPool([handle]);
    let currentGeneration = 1;
    const applied: number[] = [];
    let nextId = 1;

    await warmCoarse({
      pool,
      config,
      size,
      jobs: keyframeJobs(4),
      initialCenter: 0,
      chunkSize: 4,
      nextRequestId: () => nextId++,
      isCurrentGeneration: () => currentGeneration === 1,
      onChunkDone: (thumbnails) => {
        for (const t of thumbnails) applied.push(t.id);
      },
    });
    expect(applied).toHaveLength(4);

    // A second, "superseded" warm: bump the generation before results land.
    currentGeneration = 2;
    const secondApplied: number[] = [];
    let closedCount = 0;
    const trackingHandle: WorkerHandle = {
      decode: (request) => {
        const thumbnails = request.jobs.map((j) => {
          const bitmap = new FakeBitmap();
          const originalClose = bitmap.close.bind(bitmap);
          bitmap.close = () => {
            closedCount += 1;
            originalClose();
          };
          return { id: j.id, presentationTime: j.presentationTime, bitmap };
        });
        return Promise.resolve({ requestId: request.requestId, thumbnails, errors: [], cancelled: false });
      },
      cancel: () => undefined,
      terminate: () => undefined,
    };
    const pool2 = new FrameWorkerPool([trackingHandle]);

    await warmCoarse({
      pool: pool2,
      config,
      size,
      jobs: keyframeJobs(3),
      initialCenter: 0,
      chunkSize: 4,
      nextRequestId: () => nextId++,
      isCurrentGeneration: () => currentGeneration === 999, // never current
      onChunkDone: (thumbnails) => {
        for (const t of thumbnails) secondApplied.push(t.id);
      },
    });

    expect(secondApplied).toHaveLength(0);
    expect(closedCount).toBe(3);
  });
});
