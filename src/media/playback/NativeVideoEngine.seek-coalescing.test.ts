// Part 5: seek coalescing. THE CORRECTNESS PROPERTY, per the task: after input stops, the engine
// MUST converge on the final requested position. Dropping intermediate seeks is the point;
// dropping the last one is a bug. This is the test suite the task names as the one to test
// hardest, so it gets its own file.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ticksToSeconds } from '../index/time';
import { FakeVideoElement } from './FakeVideoElement';
import { NativeVideoEngine } from './NativeVideoEngine';
import { makeConstantFrameRateTrack, makeSampleIndex } from './test-helpers';

const TIMESCALE = 30_000;

function makeFile(): File {
  return new File([new Uint8Array(16)], 'test.mp4', { type: 'video/mp4' });
}

async function loadedEngine(videoOptions: ConstructorParameters<typeof FakeVideoElement>[0] = {}): Promise<{ engine: NativeVideoEngine; video: FakeVideoElement }> {
  const video = new FakeVideoElement(videoOptions);
  const engine = new NativeVideoEngine(video);
  const index = makeSampleIndex([makeConstantFrameRateTrack(100_000, 1000, 30, { timescale: TIMESCALE })]);
  // Fake timers are active for these tests (beforeEach), so `src`'s 'loadedmetadata' setTimeout
  // needs an explicit flush -- it won't fire on its own the way it would with real timers.
  const loadPromise = engine.load(makeFile(), index);
  await vi.advanceTimersByTimeAsync(0);
  await loadPromise;
  return { engine, video };
}

describe('seek coalescing: convergence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('200 rapid seek() calls converge on the LAST requested position, issuing the video element seek only twice', async () => {
    const { engine, video } = await loadedEngine({ seekLatencyMs: 15 });
    const currentTimeSetter = vi.spyOn(video, 'currentTime', 'set');

    const promises: Promise<void>[] = [];
    let lastTarget = 0;
    for (let i = 0; i < 200; i += 1) {
      lastTarget = (i + 1) * 1000;
      promises.push(engine.seek(lastTarget, 'accurate'));
    }

    expect(engine.state).toBe('seeking');
    // only the FIRST request should have reached the video element synchronously -- the other 199
    // are coalesced into pendingSeekTarget without ever calling the setter.
    expect(currentTimeSetter).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15); // first seek settles -> the coalesced (last) target is issued
    expect(currentTimeSetter).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15); // second (final) seek settles -> fully idle
    await Promise.all(promises);

    expect(engine.state).toBe('ready');
    expect(engine.currentTime).toBe(lastTarget);
    // still exactly 2 real seeks issued for 200 requests -- the coalescing invariant.
    expect(currentTimeSetter).toHaveBeenCalledTimes(2);
  });

  it('converges correctly even when the last request arrives while a seek is already in flight', async () => {
    const { engine } = await loadedEngine({ seekLatencyMs: 20 });

    const p1 = engine.seek(1000, 'accurate'); // issued immediately, in flight
    await vi.advanceTimersByTimeAsync(5); // still in flight
    const p2 = engine.seek(2000, 'accurate'); // coalesced target, arrives mid-flight

    await vi.advanceTimersByTimeAsync(15); // first seek (1000) settles -> issues 2000 immediately
    await vi.advanceTimersByTimeAsync(20); // 2000 settles -> fully idle

    await Promise.all([p1, p2]);
    expect(engine.currentTime).toBe(2000);
    expect(engine.state).toBe('ready');
  });

  it('a never-resolving seek does not cause a double-issue, and the engine stays in seeking', async () => {
    const { engine, video } = await loadedEngine({ seekLatencyMs: 10 });
    const currentTimeSetter = vi.spyOn(video, 'currentTime', 'set');

    video.neverResolveNextSeek();
    void engine.seek(500, 'accurate'); // this one will never settle
    await vi.advanceTimersByTimeAsync(10_000);
    expect(engine.state).toBe('seeking'); // stuck, as expected -- no timeout/watchdog in M1

    // further seeks while stuck must not cause a second real issue -- they just update
    // pendingSeekTarget, which the (never-arriving) 'seeked' would have picked up.
    void engine.seek(600, 'accurate');
    void engine.seek(700, 'accurate');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(currentTimeSetter).toHaveBeenCalledTimes(1); // only the original stuck seek was ever issued
    expect(engine.state).toBe('seeking');
  });

  it('fastSeek is used in scrub mode only when the underlying element supports it', async () => {
    const { engine, video } = await loadedEngine({ seekLatencyMs: 5, hasFastSeek: true });
    const fastSeekSpy = vi.spyOn(video, 'fastSeek');
    const currentTimeSetter = vi.spyOn(video, 'currentTime', 'set');

    const p = engine.seek(3000, 'scrub');
    expect(fastSeekSpy).toHaveBeenCalledTimes(1);
    expect(currentTimeSetter).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5);
    await p;
  });

  it('scrub mode falls back to currentTime= when fastSeek is absent (feature-detected, not assumed -- Chrome has none)', async () => {
    const { engine, video } = await loadedEngine({ seekLatencyMs: 5, hasFastSeek: false });
    const currentTimeSetter = vi.spyOn(video, 'currentTime', 'set');
    expect(video.fastSeek).toBeUndefined();

    const p = engine.seek(3000, 'scrub');
    expect(currentTimeSetter).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5);
    await p;
  });

  it('accurate mode always uses currentTime=, even when fastSeek is available', async () => {
    const { engine, video } = await loadedEngine({ seekLatencyMs: 5, hasFastSeek: true });
    const fastSeekSpy = vi.spyOn(video, 'fastSeek');
    const currentTimeSetter = vi.spyOn(video, 'currentTime', 'set');

    const p = engine.seek(3000, 'accurate');
    expect(currentTimeSetter).toHaveBeenCalledTimes(1);
    expect(fastSeekSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5);
    await p;
  });

  it('out-of-order seeked firing (via fireSeeked, bypassing the latency timer) still converges on the last coalesced target', async () => {
    const { engine, video } = await loadedEngine({ seekLatencyMs: 1000 }); // long latency -- automatic timer won't fire during this test

    const p1 = engine.seek(1000, 'accurate'); // in flight
    const p2 = engine.seek(2000, 'accurate'); // coalesced (supersedes 1000 before it ever settles)
    const p3 = engine.seek(3000, 'accurate'); // coalesces again (supersedes 2000)

    // Manually fire 'seeked' out of order relative to when the automatic timers WOULD have fired --
    // the engine must not be confused by this; it only ever tracks one seekInFlight slot, so
    // whatever 'seeked' arrives next is attributed to that slot, and pendingSeekTarget (3000) is
    // issued next regardless.
    video.fireSeeked(ticksToSeconds(1000, TIMESCALE)); // settles the in-flight 1000 request
    video.fireSeeked(ticksToSeconds(3000, TIMESCALE)); // settles the just-issued 3000 request

    await Promise.all([p1, p2, p3]);
    expect(engine.currentTime).toBe(3000);
    expect(engine.state).toBe('ready');
  });
});
