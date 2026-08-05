import { describe, expect, it } from 'vitest';
import { assertNoStaleFrames, createFrameLifecycleRegistry, StaleFrameError, withFrame, withFrameAsync, type Closable } from './frame-lifecycle';

class FakeClosable implements Closable {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

describe('withFrame', () => {
  it('closes the frame after a normal return and untracks it', () => {
    const registry = createFrameLifecycleRegistry();
    const frame = new FakeClosable();
    const result = withFrame(registry, frame, 'test', (f) => {
      expect(f.closed).toBe(false);
      expect(registry.liveCount).toBe(1);
      return 42;
    });
    expect(result).toBe(42);
    expect(frame.closed).toBe(true);
    expect(registry.liveCount).toBe(0);
  });

  it('closes the frame even when fn throws, and rethrows', () => {
    const registry = createFrameLifecycleRegistry();
    const frame = new FakeClosable();
    expect(() =>
      withFrame(registry, frame, 'test', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(frame.closed).toBe(true);
    expect(registry.liveCount).toBe(0);
  });

  it('N frames through withFrame produce exactly N closes', () => {
    const registry = createFrameLifecycleRegistry();
    const frames = Array.from({ length: 50 }, () => new FakeClosable());
    for (const frame of frames) withFrame(registry, frame, 'batch', () => undefined);
    expect(frames.every((f) => f.closed)).toBe(true);
    expect(registry.liveCount).toBe(0);
  });
});

describe('withFrameAsync', () => {
  it('closes the frame after the async fn resolves', async () => {
    const registry = createFrameLifecycleRegistry();
    const frame = new FakeClosable();
    const result = await withFrameAsync(registry, frame, 'test', async (f) => {
      await Promise.resolve();
      expect(f.closed).toBe(false);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(frame.closed).toBe(true);
    expect(registry.liveCount).toBe(0);
  });

  it('closes the frame when the async fn rejects, and rejects the outer promise', async () => {
    const registry = createFrameLifecycleRegistry();
    const frame = new FakeClosable();
    await expect(
      withFrameAsync(registry, frame, 'test', async () => {
        await Promise.resolve();
        throw new Error('cancelled mid-batch');
      }),
    ).rejects.toThrow('cancelled mid-batch');
    expect(frame.closed).toBe(true);
    expect(registry.liveCount).toBe(0);
  });

  it('closes every frame in a batch even when a later one rejects (cancellation path)', async () => {
    const registry = createFrameLifecycleRegistry();
    const frames = Array.from({ length: 10 }, () => new FakeClosable());
    const results = await Promise.allSettled(
      frames.map((frame, i) =>
        withFrameAsync(registry, frame, `job-${String(i)}`, (f) => {
          if (i === 7) throw new Error('job cancelled');
          return Promise.resolve(f);
        }),
      ),
    );
    expect(results[7]?.status).toBe('rejected');
    expect(frames.every((f) => f.closed)).toBe(true);
    expect(registry.liveCount).toBe(0);
  });
});

describe('FrameLifecycleRegistry', () => {
  it('tracks liveCount and oldestAgeMs while a closable is held', () => {
    const registry = createFrameLifecycleRegistry();
    const frame = new FakeClosable();
    registry.track(frame, 'held');
    expect(registry.liveCount).toBe(1);
    expect(registry.oldestAgeMs(Date.now() + 500)).toBeGreaterThanOrEqual(500);
    registry.untrack(frame);
    expect(registry.liveCount).toBe(0);
    expect(registry.oldestAgeMs()).toBe(0);
  });

  it('labels() surfaces what is currently tracked', () => {
    const registry = createFrameLifecycleRegistry();
    registry.track(new FakeClosable(), 'coarse-tile-3');
    registry.track(new FakeClosable(), 'coarse-tile-9');
    expect(registry.labels().sort()).toEqual(['coarse-tile-3', 'coarse-tile-9']);
  });

  it('reset() clears the ledger without calling close()', () => {
    const registry = createFrameLifecycleRegistry();
    const frame = new FakeClosable();
    registry.track(frame, 'x');
    registry.reset();
    expect(registry.liveCount).toBe(0);
    expect(frame.closed).toBe(false);
  });
});

describe('assertNoStaleFrames', () => {
  it('does not throw when nothing is tracked', () => {
    const registry = createFrameLifecycleRegistry();
    expect(() => {
      assertNoStaleFrames(registry, 100);
    }).not.toThrow();
  });

  it('does not throw when tracked closables are younger than maxAgeMs', () => {
    const registry = createFrameLifecycleRegistry();
    registry.track(new FakeClosable(), 'fresh');
    expect(() => {
      assertNoStaleFrames(registry, 10_000);
    }).not.toThrow();
  });

  it('throws StaleFrameError with diagnostics when a closable outlives maxAgeMs', () => {
    const registry = createFrameLifecycleRegistry();
    registry.track(new FakeClosable(), 'orphaned-tile');
    let caught: unknown;
    try {
      assertNoStaleFrames(registry, -1);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StaleFrameError);
    const err = caught as StaleFrameError;
    expect(err.liveCount).toBe(1);
    expect(err.labels).toContain('orphaned-tile');
  });
});
