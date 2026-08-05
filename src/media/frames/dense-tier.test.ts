import { describe, expect, it } from 'vitest';
import { rebuildDense } from './dense-tier';
import { FrameWorkerPool, type WorkerDecodeRequest, type WorkerDecodeResult, type WorkerHandle } from './worker-pool';
import type { FrameDecoderConfig } from './FrameDecoder';
import type { TimedJob } from './job-builder';
import type { Closable } from './frame-lifecycle';

class FakeBitmap implements Closable {
  closed = false;
  readonly width = 320;
  readonly height = 180;
  close(): void {
    this.closed = true;
  }
}

class ImmediateWorkerHandle implements WorkerHandle {
  decodeCalls: WorkerDecodeRequest[] = [];

  decode(request: WorkerDecodeRequest): Promise<WorkerDecodeResult> {
    this.decodeCalls.push(request);
    const thumbnails = request.jobs.filter((j) => j.keep).map((j) => ({ id: j.id, presentationTime: j.presentationTime, bitmap: new FakeBitmap() }));
    return Promise.resolve({ requestId: request.requestId, thumbnails, errors: [], cancelled: false });
  }

  cancel(): void {}
  terminate(): void {}
}

const config: FrameDecoderConfig = { codec: 'avc1.640034', codedWidth: 3840, codedHeight: 2160, description: new Uint8Array() };
const size = { width: 320, height: 180 };

function chain(...entries: Array<{ id: number; time: number; keep: boolean; type: 'key' | 'delta' }>): TimedJob[] {
  return entries.map((e) => ({ time: e.time, job: { id: e.id, offset: e.id * 100, size: 50, presentationTime: e.time, type: e.type, keep: e.keep } }));
}

describe('rebuildDense', () => {
  it('submits the whole chain as a single ordered request and returns only the kept thumbnails', async () => {
    const handle = new ImmediateWorkerHandle();
    const pool = new FrameWorkerPool([handle]);
    const jobs = chain({ id: 0, time: 0, keep: false, type: 'key' }, { id: 1, time: 500, keep: true, type: 'delta' }, { id: 2, time: 1000, keep: false, type: 'delta' }, { id: 3, time: 1500, keep: true, type: 'delta' });

    const result = await rebuildDense({ pool, config, size, jobs, requestId: 1 });

    expect(handle.decodeCalls).toHaveLength(1);
    expect(handle.decodeCalls[0]?.jobs.map((j) => j.id)).toEqual([0, 1, 2, 3]); // full chain, in order, not just the kept ones
    expect(result.thumbnails.map((t) => t.id)).toEqual([1, 3]);
    expect(result.cancelled).toBe(false);
  });

  it('returns an empty, non-cancelled result for an empty job list without touching the pool', async () => {
    const handle = new ImmediateWorkerHandle();
    const pool = new FrameWorkerPool([handle]);
    const result = await rebuildDense({ pool, config, size, jobs: [], requestId: 1 });
    expect(result).toEqual({ thumbnails: [], errors: [], cancelled: false });
    expect(handle.decodeCalls).toHaveLength(0);
  });

  it('propagates cancellation from the pool', async () => {
    const handle: WorkerHandle = {
      decode: (request) => Promise.resolve({ requestId: request.requestId, thumbnails: [], errors: [], cancelled: true }),
      cancel: () => undefined,
      terminate: () => undefined,
    };
    const pool = new FrameWorkerPool([handle]);
    const jobs = chain({ id: 0, time: 0, keep: true, type: 'key' });
    const result = await rebuildDense({ pool, config, size, jobs, requestId: 1 });
    expect(result.cancelled).toBe(true);
    expect(result.thumbnails).toEqual([]);
  });
});
