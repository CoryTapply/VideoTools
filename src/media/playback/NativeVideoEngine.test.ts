// Part 4 tests: load sequence, state machine, sync-path feature detection, dispose. Seek
// coalescing has its own dedicated test file (NativeVideoEngine.seek-coalescing.test.ts) per the
// task's instruction to test that property hardest.

import { describe, expect, it, vi } from 'vitest';
import { FakeVideoElement } from './FakeVideoElement';
import { NativeVideoEngine } from './NativeVideoEngine';
import { makeConstantFrameRateTrack, makeSampleIndex } from './test-helpers';

function makeFile(): File {
  return new File([new Uint8Array(16)], 'test.mp4', { type: 'video/mp4' });
}

describe('NativeVideoEngine.load', () => {
  it('goes idle -> loading -> ready on a normal load, and picks the rVFC sync path when available', async () => {
    const video = new FakeVideoElement({ loadLatencyMs: 0, hasRequestVideoFrameCallback: true });
    const engine = new NativeVideoEngine(video);
    const states: string[] = [];
    engine.onStateChange((s) => states.push(s));

    const index = makeSampleIndex([makeConstantFrameRateTrack(10, 1000, 5)]);
    const result = await engine.load(makeFile(), index);

    expect(result.ok).toBe(true);
    expect(engine.state).toBe('ready');
    expect(states).toEqual(['loading', 'ready']);
    expect(engine.syncPath).toBe('rvfc');
    expect(engine.lastError).toBeUndefined();
  });

  it('falls back to the raf sync path when requestVideoFrameCallback is absent, and reports dropped-frame count as unavailable', async () => {
    const video = new FakeVideoElement({ hasRequestVideoFrameCallback: false });
    const engine = new NativeVideoEngine(video);
    const index = makeSampleIndex([makeConstantFrameRateTrack(10, 1000, 5)]);

    await engine.load(makeFile(), index);

    expect(engine.syncPath).toBe('raf');
    expect(engine.droppedFrameCount).toBeUndefined();
  });

  it('fails with no-video-track for an audio-only index, before ever touching the video element source', async () => {
    const video = new FakeVideoElement();
    const srcSetter = vi.spyOn(video, 'src', 'set');
    const engine = new NativeVideoEngine(video);

    const audioTrack = { ...makeConstantFrameRateTrack(5, 1000, 5), kind: 'audio' as const };
    const index = makeSampleIndex([audioTrack]);
    const result = await engine.load(makeFile(), index);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual({ kind: 'no-video-track' });
    expect(engine.state).toBe('error');
    expect(engine.lastError).toEqual({ kind: 'no-video-track' });
    expect(srcSetter).not.toHaveBeenCalled();
  });

  it('fails with unsupported-codec, checked BEFORE any object URL is created', async () => {
    const video = new FakeVideoElement({ canPlayTypeResult: '' });
    const srcSetter = vi.spyOn(video, 'src', 'set');
    const engine = new NativeVideoEngine(video);
    const index = makeSampleIndex([makeConstantFrameRateTrack(10, 1000, 5, { codec: 'av01.unsupported' })]);

    const result = await engine.load(makeFile(), index);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual({ kind: 'unsupported-codec', codec: 'av01.unsupported' });
    expect(engine.state).toBe('error');
    expect(srcSetter).not.toHaveBeenCalled();
  });

  it('distinguishes decode-error from load-failed via MediaError.code on a video error event', async () => {
    const video = new FakeVideoElement({ simulateLoadError: { code: 3 /* MEDIA_ERR_DECODE */ } });
    const engine = new NativeVideoEngine(video);
    const index = makeSampleIndex([makeConstantFrameRateTrack(10, 1000, 5)]);

    const result = await engine.load(makeFile(), index);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('decode-error');
    expect(engine.state).toBe('error');
  });

  it('re-entrant load() on the same engine revokes the previous object URL before creating the next one', async () => {
    const video = new FakeVideoElement();
    const engine = new NativeVideoEngine(video);
    const index = makeSampleIndex([makeConstantFrameRateTrack(5, 1000, 5)]);

    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');

    const firstResult = await engine.load(makeFile(), index);
    expect(firstResult.ok).toBe(true);
    expect(revokeSpy).not.toHaveBeenCalled();

    const secondResult = await engine.load(makeFile(), index);
    expect(secondResult.ok).toBe(true);
    expect(revokeSpy).toHaveBeenCalledTimes(1); // the FIRST load's URL, revoked before the second one is created

    revokeSpy.mockRestore();
  });
});

describe('NativeVideoEngine play/pause/dispose state machine', () => {
  async function loadedEngine(): Promise<{ engine: NativeVideoEngine; video: FakeVideoElement }> {
    const video = new FakeVideoElement();
    const engine = new NativeVideoEngine(video);
    const index = makeSampleIndex([makeConstantFrameRateTrack(10, 1000, 5)]);
    await engine.load(makeFile(), index);
    return { engine, video };
  }

  it('ready -> playing -> ready via play()/pause()', async () => {
    const { engine } = await loadedEngine();
    expect(engine.state).toBe('ready');
    engine.play();
    expect(engine.state).toBe('playing');
    engine.pause();
    expect(engine.state).toBe('ready');
  });

  it('play() is a no-op outside ready (e.g. already playing, or before load)', async () => {
    const { engine } = await loadedEngine();
    engine.play();
    const states: string[] = [];
    engine.onStateChange((s) => states.push(s));
    engine.play(); // already playing -- no-op, no duplicate 'playing' notification
    expect(states).toEqual([]);
  });

  it('playing -> ended on the video element ended event', async () => {
    const { engine, video } = await loadedEngine();
    engine.play();
    video.fireEnded();
    expect(engine.state).toBe('ended');
  });

  it('dispose() is idempotent and revokes the object URL exactly once', async () => {
    const { engine } = await loadedEngine();
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    engine.dispose();
    engine.dispose();
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    revokeSpy.mockRestore();
  });

  it('stepFrames() while playing implicitly pauses first', async () => {
    const { engine, video } = await loadedEngine();
    engine.play();
    expect(engine.state).toBe('playing');
    const stepPromise = engine.stepFrames(1);
    expect(engine.state).toBe('seeking'); // paused, then immediately entered seeking for the step
    video.fireSeeked(0.001);
    await stepPromise;
  });
});
