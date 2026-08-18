import { describe, expect, it, vi } from 'vitest';
import { WaveformWorkerPool, type WaveformDecoderConfigWire, type WaveformJobDescriptor, type WorkerBuildRequest, type WorkerBuildResult, type WorkerHandle } from './worker-pool';

const config: WaveformDecoderConfigWire = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array([0x12, 0x08]) };

function jobs(...ids: number[]): WaveformJobDescriptor[] {
  return ids.map((id) => ({ id, offset: id * 500, size: 200, presentationTime: id * 1024 }));
}

function request(requestId: number, ids: number[] = [0]): WorkerBuildRequest {
  return { requestId, config, jobs: jobs(...ids) };
}

/** A controllable fake worker: build() doesn't resolve until release() is called for that requestId, so tests can observe pool state mid-flight. */
class FakeWorkerHandle implements WorkerHandle {
  buildCalls: WorkerBuildRequest[] = [];
  cancelCalls: number[] = [];
  terminateCalls = 0;
  private readonly pending = new Map<number, { resolve: (result: WorkerBuildResult) => void }>();

  build(request: WorkerBuildRequest): Promise<WorkerBuildResult> {
    this.buildCalls.push(request);
    return new Promise((resolve) => {
      this.pending.set(request.requestId, { resolve });
    });
  }

  cancel(requestId: number): void {
    this.cancelCalls.push(requestId);
    const entry = this.pending.get(requestId);
    if (entry) {
      this.pending.delete(requestId);
      entry.resolve({ requestId, pyramid: [], errors: [], cancelled: true });
    }
  }

  terminate(): void {
    this.terminateCalls += 1;
  }

  /** Test control: completes an in-flight build() as if the worker finished normally. */
  release(requestId: number, result: Omit<WorkerBuildResult, 'requestId'> = { pyramid: [], errors: [], cancelled: false }): void {
    const entry = this.pending.get(requestId);
    if (!entry) throw new Error(`no pending build for requestId ${String(requestId)}`);
    this.pending.delete(requestId);
    entry.resolve({ requestId, ...result });
  }
}

describe('WaveformWorkerPool', () => {
  it('dispatches a submitted job to a free handle', async () => {
    const handle = new FakeWorkerHandle();
    const pool = new WaveformWorkerPool([handle]);
    const resultPromise = pool.submit(request(1));
    expect(handle.buildCalls).toHaveLength(1);
    handle.release(1);
    const result = await resultPromise;
    expect(result.requestId).toBe(1);
  });

  it('queues jobs beyond pool size and dispatches them as handles free up', async () => {
    const handleA = new FakeWorkerHandle();
    const handleB = new FakeWorkerHandle();
    const pool = new WaveformWorkerPool([handleA, handleB]);

    const p1 = pool.submit(request(1));
    const p2 = pool.submit(request(2));
    const p3 = pool.submit(request(3));

    expect(pool.inFlightCount).toBe(2);
    expect(pool.queuedCount).toBe(1);

    handleA.release(1);
    await p1;
    expect(pool.queuedCount).toBe(0);
    expect(handleA.buildCalls.map((r) => r.requestId)).toEqual([1, 3]);

    handleA.release(3);
    handleB.release(2);
    await Promise.all([p2, p3]);
  });

  it('cancelling a queued job resolves it as cancelled without touching any handle', async () => {
    const handle = new FakeWorkerHandle(); // pool size 1, so job 2 stays queued behind job 1
    const pool = new WaveformWorkerPool([handle]);
    const p1 = pool.submit(request(1));
    const p2 = pool.submit(request(2));

    pool.cancel(2);
    const result2 = await p2;
    expect(result2.cancelled).toBe(true);
    expect(handle.buildCalls.map((r) => r.requestId)).toEqual([1]); // job 2 never dispatched
    expect(pool.queuedCount).toBe(0);

    handle.release(1);
    await p1;
  });

  it('cancelling an in-flight job calls the owning handle.cancel(), not deprioritization', async () => {
    const handle = new FakeWorkerHandle();
    const pool = new WaveformWorkerPool([handle]);
    const p1 = pool.submit(request(1));

    pool.cancel(1);
    expect(handle.cancelCalls).toEqual([1]);
    const result = await p1;
    expect(result.cancelled).toBe(true);
  });

  it('a cancel() racing ahead of submit() still results in a cancelled job that never dispatches', async () => {
    const handle = new FakeWorkerHandle();
    const otherHandle = new FakeWorkerHandle(); // free, so job 2 would dispatch to it immediately if not for the race
    const pool = new WaveformWorkerPool([handle, otherHandle]);
    const p1 = pool.submit(request(1)); // occupies `handle`

    pool.cancel(2); // arrives before job 2 is ever submitted
    const p2 = pool.submit(request(2));
    const result2 = await p2;

    expect(result2.cancelled).toBe(true);
    expect(handle.buildCalls.map((r) => r.requestId)).toEqual([1]);
    expect(otherHandle.buildCalls).toHaveLength(0);

    handle.release(1);
    await p1;
  });

  it('dispose() resolves everything still queued as cancelled and terminates every handle', async () => {
    const handleA = new FakeWorkerHandle();
    const handleB = new FakeWorkerHandle();
    const pool = new WaveformWorkerPool([handleA, handleB]);
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
    const pool = new WaveformWorkerPool([new FakeWorkerHandle()]);
    pool.dispose();
    expect(() => pool.submit(request(1))).toThrow(/after dispose/);
  });

  it('a build() rejection is turned into an error result instead of an unhandled rejection', async () => {
    const handle: WorkerHandle = {
      build: vi.fn(() => Promise.reject(new Error('worker crashed'))),
      cancel: vi.fn(),
      terminate: vi.fn(),
    };
    const pool = new WaveformWorkerPool([handle]);
    const result = await pool.submit(request(1));
    expect(result.cancelled).toBe(false);
    const error = result.errors[0];
    expect(error.kind === 'decode-error' && error.message).toBe('worker crashed');
  });

  it('constructing a pool with zero handles throws', () => {
    expect(() => new WaveformWorkerPool([])).toThrow(/at least one/);
  });
});
