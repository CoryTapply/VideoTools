import { describe, expect, it } from 'vitest';
import { AudioMixEngine } from './AudioMixEngine';
import { FakeLiveAudioMixer } from './FakeLiveAudioMixer';
import type { TrackIndex } from '../index/track-index';

function makeAudioTrack(trackId: number): TrackIndex {
  return {
    trackId,
    kind: 'audio',
    handlerType: 'soun',
    codec: 'mp4a.40.2',
    timescale: 48000,
    duration: 48000,
    sampleCount: 1,
    pts: new Float64Array([0]),
    dts: new Float64Array([0]),
    offset: new Float64Array([0]),
    size: new Uint32Array([1]),
    isSync: new Uint8Array([1]),
    description: new Uint8Array(0),
    audio: { channelCount: 2, sampleRate: 48000, language: 'und', handlerName: '' },
    editOffsetTicks: 0,
  };
}

/** A minimal object satisfying only what AudioMixEngine itself calls (createGain/close) --
 * doesn't need to be a real AudioContext since the createMixer test seam below never dereferences
 * the ctx/destination it's handed either. */
function fakeAudioContext(): AudioContext {
  const gainNode = { gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined };
  return {
    destination: {},
    createGain: () => gainNode,
    close: () => Promise.resolve(),
  } as unknown as AudioContext;
}

function makeEngine(trackIds: number[]): { engine: AudioMixEngine; created: Map<number, FakeLiveAudioMixer> } {
  const audioTracks = new Map(trackIds.map((id) => [id, makeAudioTrack(id)]));
  const created = new Map<number, FakeLiveAudioMixer>();
  const engine = new AudioMixEngine({
    audioTracks,
    file: {} as File,
    index: {} as never,
    ctx: fakeAudioContext(),
    createMixer: (trackId) => {
      const m = new FakeLiveAudioMixer();
      created.set(trackId, m);
      return m;
    },
  });
  return { engine, created };
}

describe('AudioMixEngine', () => {
  it('setEnabledTracks creates a mixer for a newly-enabled track', () => {
    const { engine, created } = makeEngine([1, 2]);
    engine.setEnabledTracks(new Set([1]));
    expect(created.has(1)).toBe(true);
    expect(created.has(2)).toBe(false);
  });

  it('onEngineStateChange(playing) starts every currently-enabled mixer at the given position', () => {
    const { engine, created } = makeEngine([1, 2]);
    engine.setEnabledTracks(new Set([1, 2]));
    engine.onEngineStateChange('playing', 12.5);
    expect(created.get(1)?.startCalls).toEqual([12.5]);
    expect(created.get(2)?.startCalls).toEqual([12.5]);
  });

  it('onEngineStateChange(ready) pauses every enabled mixer', () => {
    const { engine, created } = makeEngine([1]);
    engine.setEnabledTracks(new Set([1]));
    engine.onEngineStateChange('playing', 0);
    engine.onEngineStateChange('ready', 5);
    expect(created.get(1)?.pauseCallCount).toBe(1);
  });

  it('onEngineStateChange(seeking) does nothing -- the regression this whole module exists to prevent', () => {
    const { engine, created } = makeEngine([1]);
    engine.setEnabledTracks(new Set([1]));
    engine.onEngineStateChange('playing', 0);
    created.get(1)?.startCalls.splice(0); // clear the initial start() from entering 'playing'
    engine.onEngineStateChange('seeking', 3);
    expect(created.get(1)?.startCalls).toEqual([]);
    expect(created.get(1)?.pauseCallCount).toBe(0);
  });

  it('a newly-enabled track starts immediately if playback is already playing', () => {
    const { engine, created } = makeEngine([1, 2]);
    engine.setEnabledTracks(new Set([1]));
    engine.onEngineStateChange('playing', 8);
    engine.setEnabledTracks(new Set([1, 2])); // track 2 checked mid-playback
    expect(created.get(2)?.startCalls).toEqual([8]);
  });

  it('a newly-enabled track does not start if playback is paused', () => {
    const { engine, created } = makeEngine([1]);
    engine.onEngineStateChange('ready', 0);
    engine.setEnabledTracks(new Set([1]));
    expect(created.get(1)?.startCalls).toEqual([]);
  });

  it('reportMasterPosition forwards to every enabled mixer', () => {
    const { engine } = makeEngine([1, 2]);
    engine.setEnabledTracks(new Set([1, 2]));
    // FakeLiveAudioMixer's reportMasterPosition is a no-op recorder-less stub, so this just
    // confirms the call doesn't throw when routed through every enabled mixer.
    expect(() => {
      engine.reportMasterPosition(4.2);
    }).not.toThrow();
  });

  it('setPlaybackRateHint pauses all mixers when leaving unity rate, and is idempotent', () => {
    const { engine, created } = makeEngine([1]);
    engine.setEnabledTracks(new Set([1]));
    engine.onEngineStateChange('playing', 0);
    engine.setPlaybackRateHint(2);
    expect(created.get(1)?.pauseCallCount).toBe(1);
    engine.setPlaybackRateHint(2); // repeated shuttle key-repeat -- must not pause again
    expect(created.get(1)?.pauseCallCount).toBe(1);
  });

  it('setPlaybackRateHint resumes all mixers at unity rate if playback is still playing', () => {
    const { engine, created } = makeEngine([1]);
    engine.setEnabledTracks(new Set([1]));
    engine.onEngineStateChange('playing', 10);
    engine.setPlaybackRateHint(2);
    created.get(1)?.startCalls.splice(0);
    engine.setPlaybackRateHint(1);
    expect(created.get(1)?.startCalls).toEqual([10]);
  });

  it('onEngineStateChange(playing) does not start mixers while shuttling at a non-unity rate', () => {
    const { engine, created } = makeEngine([1]);
    engine.setEnabledTracks(new Set([1]));
    engine.setPlaybackRateHint(2);
    created.get(1)?.startCalls.splice(0);
    engine.onEngineStateChange('playing', 3);
    expect(created.get(1)?.startCalls).toEqual([]);
  });

  it('dispose() disposes every mixer', () => {
    const { engine, created } = makeEngine([1, 2]);
    engine.setEnabledTracks(new Set([1, 2]));
    engine.dispose();
    expect(created.get(1)?.disposed).toBe(true);
    expect(created.get(2)?.disposed).toBe(true);
  });

  it('setTrackVolume applies immediately to an already-live mixer', () => {
    const { engine, created } = makeEngine([1]);
    engine.setEnabledTracks(new Set([1]));
    engine.setTrackVolume(1, 0.3);
    expect(created.get(1)?.setVolumeCalls).toEqual([0.3]);
  });

  it('setTrackVolume is remembered and applied to a mixer created later', () => {
    const { engine, created } = makeEngine([1]);
    engine.setTrackVolume(1, 0.3); // set before the track is ever enabled
    engine.setEnabledTracks(new Set([1]));
    expect(created.get(1)?.setVolumeCalls).toEqual([0.3]);
  });

  it('setTrackVolume survives a dispose/recreate cycle (unchecking then rechecking a track)', () => {
    const { engine, created } = makeEngine([1]);
    engine.setEnabledTracks(new Set([1]));
    engine.setTrackVolume(1, 0.3);
    engine.setEnabledTracks(new Set([])); // uncheck -- disposes the mixer
    expect(created.get(1)?.disposed).toBe(true);
    engine.setEnabledTracks(new Set([1])); // recheck -- creates a fresh mixer
    expect(created.get(1)?.setVolumeCalls).toEqual([0.3]);
  });

  it('setEnabledTracks after dispose() is a safe no-op', () => {
    const { engine, created } = makeEngine([1]);
    engine.dispose();
    expect(() => {
      engine.setEnabledTracks(new Set([1]));
    }).not.toThrow();
    expect(created.has(1)).toBe(false);
  });
});
