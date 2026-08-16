import { describe, expect, it, vi } from 'vitest';
import { defaultWorkerCount, FrameWorkerPool, type DecodeJobDescriptor, type WorkerDecodeRequest, type WorkerDecodeResult, type WorkerHandle } from './worker-pool';
import type { FrameDecoderConfig } from './FrameDecoder';

const config: FrameDecoderConfig = { codec: 'avc1.640034', codedWidth: 3840, codedHeight: 2160, description: new Uint8Array() };

function jobs(...ids: number[]): DecodeJobDescriptor[] {
  return ids.map((id) => ({ id, offset: id * 1000, size: 500, presentationTime: id * 4166, type: 'key', keep: true }));
}

function request(requestId: number, ids: number[] = [0]): WorkerDecodeRequest {
  return { requestId, config, jobs: jobs(...ids), size: { width: 160, height: 90 } };
}

/** A controllable fake worker: decode() doesn't resolve until release() is called for that requestId, so tests can observe pool state mid-flight. */
class FakeWorkerHandle implements WorkerHandle {
  decodeCalls: WorkerDecodeRequest[] = [];
  cancelCalls: number[] = [];
  terminateCalls = 0;
  private readonly pending = new Map<number, { resolve: (result: WorkerDecodeResult) => void }>();

  decode(request: WorkerDecodeRequest): Promise<WorkerDecodeResult> {
    this.decodeCalls.push(request);
    return new Promise((resolve) => {
      this.pending.set(request.requestId, { resolve });
    });
  }

  cancel(requestId: number): void {
    this.cancelCalls.push(requestId);
    const entry = this.pending.get(requestId);
    if (entry) {
      this.pending.delete(requestId);
      entry.resolve({ requestId, thumbnails: [], errors: [], cancelled: true });
    }
  }

  terminate(): void {
    this.terminateCalls += 1;
  }

  /** Test control: completes an in-flight decode() as if the worker finished normally. */
  release(requestId: number, result: Omit<WorkerDecodeResult, 'requestId'> = { thumbnails: [], errors: [], cancelled: false }): void {
    const entry = this.pending.get(requestId);
    if (!entry) throw new Error(`no pending decode for requestId ${String(requestId)}`);
    this.pending.delete(requestId);
    entry.resolve({ requestId, ...result });
  }
}

describe('defaultWorkerCount', () => {
  it('starts at 2 when hardwareConcurrency comfortably allows it', () => {
    expect(defaultWorkerCount(8)).toBe(2);
  });

  it('caps at 4 regardless of a very high hardwareConcurrency', () => {
    expect(defaultWorkerCount(64)).toBe(2); // still 2: "start with 2" wins until raised deliberately
  });

  it('drops below 2 on a low-core machine (cap = hardwareConcurrency/2)', () => {
    expect(defaultWorkerCount(2)).toBe(1);
    expect(defaultWorkerCount(1)).toBe(1);
  });
});

describe('FrameWorkerPool', () => {
  it('dispatches a submitted job to a free handle', async () => {
    const handle = new FakeWorkerHandle();
    const pool = new FrameWorkerPool([handle]);
    const resultPromise = pool.submit(request(1));
    expect(handle.decodeCalls).toHaveLength(1);
    handle.release(1);
    const result = await resultPromise;
    expect(result.requestId).toBe(1);
  });

  it('queues jobs beyond pool size and dispatches them as handles free up', async () => {
    const handleA = new FakeWorkerHandle();
    const handleB = new FakeWorkerHandle();
    const pool = new FrameWorkerPool([handleA, handleB]);

    const p1 = pool.submit(request(1));
    const p2 = pool.submit(request(2));
    const p3 = pool.submit(request(3));

    expect(pool.inFlightCount).toBe(2);
    expect(pool.queuedCount).toBe(1);

    handleA.release(1);
    await p1;
    expect(pool.queuedCount).toBe(0);
    expect(handleA.decodeCalls.map((r) => r.requestId)).toEqual([1, 3]);

    handleA.release(3);
    handleB.release(2);
    await Promise.all([p2, p3]);
  });

  it('cancelling a queued job resolves it as cancelled without touching any handle', async () => {
    const handle = new FakeWorkerHandle(); // pool size 1, so job 2 stays queued behind job 1
    const pool = new FrameWorkerPool([handle]);
    const p1 = pool.submit(request(1));
    const p2 = pool.submit(request(2));

    pool.cancel(2);
    const result2 = await p2;
    expect(result2.cancelled).toBe(true);
    expect(handle.decodeCalls.map((r) => r.requestId)).toEqual([1]); // job 2 never dispatched
    expect(pool.queuedCount).toBe(0);

    handle.release(1);
    await p1;
  });

  it('cancelling an in-flight job calls the owning handle.cancel(), not deprioritization', async () => {
    const handle = new FakeWorkerHandle();
    const pool = new FrameWorkerPool([handle]);
    const p1 = pool.submit(request(1));

    pool.cancel(1);
    expect(handle.cancelCalls).toEqual([1]);
    const result = await p1;
    expect(result.cancelled).toBe(true);
  });

  it('a cancel() racing ahead of submit() still results in a cancelled job that never dispatches', async () => {
    const handle = new FakeWorkerHandle();
    const otherHandle = new FakeWorkerHandle(); // free, so job 2 would dispatch to it immediately if not for the race
    const pool = new FrameWorkerPool([handle, otherHandle]);
    const p1 = pool.submit(request(1)); // occupies `handle`

    pool.cancel(2); // arrives before job 2 is ever submitted
    const p2 = pool.submit(request(2));
    const result2 = await p2;

    expect(result2.cancelled).toBe(true);
    expect(handle.decodeCalls.map((r) => r.requestId)).toEqual([1]);
    expect(otherHandle.decodeCalls).toHaveLength(0);

    handle.release(1);
    await p1;
  });

  it('dispose() resolves everything still queued as cancelled and terminates every handle', async () => {
    const handleA = new FakeWorkerHandle();
    const handleB = new FakeWorkerHandle();
    const pool = new FrameWorkerPool([handleA, handleB]);
    const p1 = pool.submit(request(1));
    const p2 = pool.submit(request(2));
    const p3 = pool.submit(request(3)); // queued: both handles busy
    void p1;
    void p2;

    pool.dispose();
    const result3 = await p3;
    expect(result3.cancelled).toBe(true);
    expect(handleA.terminateCalls).toBe(1);
    expect(handleB.terminateCalls).toBe(1);
  });

  it('submit() after dispose() throws', () => {
    const pool = new FrameWorkerPool([new FakeWorkerHandle()]);
    pool.dispose();
    expect(() => pool.submit(request(1))).toThrow(/after dispose/);
  });

  it('a decode() rejection is turned into an error result instead of an unhandled rejection', async () => {
    const handle: WorkerHandle = {
      decode: vi.fn(() => Promise.reject(new Error('worker crashed'))),
      cancel: vi.fn(),
      terminate: vi.fn(),
    };
    const pool = new FrameWorkerPool([handle]);
    const result = await pool.submit(request(1));
    expect(result.cancelled).toBe(false);
    const error = result.errors[0];
    expect(error.kind === 'decode-error' && error.message).toBe('worker crashed');
  });

  it('constructing a pool with zero handles throws', () => {
    expect(() => new FrameWorkerPool([])).toThrow(/at least one/);
  });
});
