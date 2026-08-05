// Self-test of FakeVideoElement -- so a bug in the fake doesn't first surface as a confusing
// failure in NativeVideoEngine's seek-coalescing / frame-stepping tests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeVideoElement } from './FakeVideoElement';

describe('FakeVideoElement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires seeked after the configured latency, with the assigned time', () => {
    const video = new FakeVideoElement({ seekLatencyMs: 50 });
    const seeked = vi.fn();
    video.addEventListener('seeked', seeked);

    video.currentTime = 10;
    expect(seeked).not.toHaveBeenCalled();
    vi.advanceTimersByTime(49);
    expect(seeked).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(seeked).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBe(10);
  });

  it('supports a variable latency function', () => {
    let latency = 10;
    const video = new FakeVideoElement({ seekLatencyMs: () => latency });
    const seeked = vi.fn();
    video.addEventListener('seeked', seeked);

    video.currentTime = 1;
    vi.advanceTimersByTime(10);
    expect(seeked).toHaveBeenCalledTimes(1);

    latency = 100;
    video.currentTime = 2;
    vi.advanceTimersByTime(10);
    expect(seeked).toHaveBeenCalledTimes(1); // not yet -- latency is now 100
    vi.advanceTimersByTime(90);
    expect(seeked).toHaveBeenCalledTimes(2);
  });

  it('neverResolveNextSeek suppresses the seeked event for exactly one seek', () => {
    const video = new FakeVideoElement({ seekLatencyMs: 10 });
    const seeked = vi.fn();
    video.addEventListener('seeked', seeked);

    video.neverResolveNextSeek();
    video.currentTime = 5;
    vi.advanceTimersByTime(10_000);
    expect(seeked).not.toHaveBeenCalled();
    expect(video.currentTime).toBe(0); // never actually settled

    // the NEXT seek behaves normally again
    video.currentTime = 7;
    vi.advanceTimersByTime(10);
    expect(seeked).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBe(7);
  });

  it('fireSeeked fires immediately, out of order, bypassing the latency timer', () => {
    const video = new FakeVideoElement({ seekLatencyMs: 1000 });
    const seeked = vi.fn();
    video.addEventListener('seeked', seeked);

    video.currentTime = 99; // scheduled for 1000ms from now
    video.fireSeeked(42); // fires immediately with an unrelated value
    expect(seeked).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBe(42);
  });

  it('fastSeek is present by default and behaves like currentTime=', () => {
    const video = new FakeVideoElement({ seekLatencyMs: 5 });
    const seeked = vi.fn();
    video.addEventListener('seeked', seeked);
    expect(typeof video.fastSeek).toBe('function');
    video.fastSeek?.(3);
    vi.advanceTimersByTime(5);
    expect(seeked).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBe(3);
  });

  it('fastSeek can be feature-detected as absent', () => {
    const video = new FakeVideoElement({ hasFastSeek: false });
    expect(video.fastSeek).toBeUndefined();
  });

  it('requestVideoFrameCallback can be feature-detected as absent', () => {
    const video = new FakeVideoElement({ hasRequestVideoFrameCallback: false });
    expect(video.requestVideoFrameCallback).toBeUndefined();
  });

  it('fireFrameCallback fires all registered callbacks once, then clears them (one-shot contract)', () => {
    const video = new FakeVideoElement();
    const cb = vi.fn();
    video.requestVideoFrameCallback?.(cb);
    video.fireFrameCallback(1.5, 10);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][1]).toEqual({ mediaTime: 1.5, presentedFrames: 10 });

    // a second fire with nothing re-registered calls nothing
    video.fireFrameCallback(2.5, 11);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('simulatePlayRejection rejects exactly the next play() call', async () => {
    const video = new FakeVideoElement();
    video.simulatePlayRejection(new Error('boom'));
    await expect(video.play()).rejects.toThrow('boom');
    await expect(video.play()).resolves.toBeUndefined();
  });

  it('src assignment fires loadedmetadata after loadLatencyMs', () => {
    const video = new FakeVideoElement({ loadLatencyMs: 20 });
    const loaded = vi.fn();
    video.addEventListener('loadedmetadata', loaded);
    video.src = 'blob:fake';
    expect(loaded).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(loaded).toHaveBeenCalledTimes(1);
  });

  it('src assignment fires error instead, when simulateLoadError is configured', () => {
    const video = new FakeVideoElement({ simulateLoadError: { code: 3 } });
    const errored = vi.fn();
    const loaded = vi.fn();
    video.addEventListener('error', errored);
    video.addEventListener('loadedmetadata', loaded);
    video.src = 'blob:fake';
    vi.advanceTimersByTime(0);
    expect(errored).toHaveBeenCalledTimes(1);
    expect(loaded).not.toHaveBeenCalled();
    expect(video.error).toEqual({ code: 3 });
  });

  it('removeEventListener stops further delivery', () => {
    const video = new FakeVideoElement({ seekLatencyMs: 1 });
    const seeked = vi.fn();
    video.addEventListener('seeked', seeked);
    video.removeEventListener('seeked', seeked);
    video.currentTime = 1;
    vi.advanceTimersByTime(1);
    expect(seeked).not.toHaveBeenCalled();
  });
});
