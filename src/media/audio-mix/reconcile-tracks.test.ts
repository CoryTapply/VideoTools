import { describe, expect, it } from 'vitest';
import { FakeLiveAudioMixer } from './FakeLiveAudioMixer';
import { reconcileEnabledTracks } from './reconcile-tracks';

describe('reconcileEnabledTracks', () => {
  it('creates a mixer for a newly-enabled track and starts it if playback is playing', () => {
    const created: FakeLiveAudioMixer[] = [];
    const createMixer = (): FakeLiveAudioMixer => {
      const m = new FakeLiveAudioMixer();
      created.push(m);
      return m;
    };
    const next = reconcileEnabledTracks(new Map(), new Set([1]), createMixer, { playing: true, atSeconds: 12.5 });
    expect(next.size).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0]?.startCalls).toEqual([12.5]);
  });

  it('creates a mixer but does not start it when playback is paused', () => {
    const createMixer = (): FakeLiveAudioMixer => new FakeLiveAudioMixer();
    const next = reconcileEnabledTracks(new Map(), new Set([1]), createMixer, { playing: false, atSeconds: 0 });
    const mixer = next.get(1);
    expect(mixer).toBeInstanceOf(FakeLiveAudioMixer);
    expect((mixer as FakeLiveAudioMixer).startCalls).toEqual([]);
  });

  it('disposes a mixer for a track no longer enabled', () => {
    const mixer = new FakeLiveAudioMixer();
    const current = new Map([[1, mixer]]);
    const next = reconcileEnabledTracks(current, new Set(), () => new FakeLiveAudioMixer(), { playing: true, atSeconds: 0 });
    expect(mixer.disposed).toBe(true);
    expect(next.size).toBe(0);
  });

  it('leaves an already-enabled track untouched -- no dispose, no recreate, no restart', () => {
    const mixer = new FakeLiveAudioMixer();
    const current = new Map([[1, mixer]]);
    const createMixer = (): FakeLiveAudioMixer => {
      throw new Error('should not be called -- track 1 is already enabled');
    };
    const next = reconcileEnabledTracks(current, new Set([1]), createMixer, { playing: true, atSeconds: 5 });
    expect(next.get(1)).toBe(mixer);
    expect(mixer.disposed).toBe(false);
    expect(mixer.startCalls).toEqual([]);
  });

  it('handles a mixed change: track 1 stays, track 2 is removed, track 3 is added', () => {
    const mixer1 = new FakeLiveAudioMixer();
    const mixer2 = new FakeLiveAudioMixer();
    const current = new Map([
      [1, mixer1],
      [2, mixer2],
    ]);
    const created: FakeLiveAudioMixer[] = [];
    const createMixer = (): FakeLiveAudioMixer => {
      const m = new FakeLiveAudioMixer();
      created.push(m);
      return m;
    };
    const next = reconcileEnabledTracks(current, new Set([1, 3]), createMixer, { playing: true, atSeconds: 7 });
    expect(next.get(1)).toBe(mixer1);
    expect(mixer1.startCalls).toEqual([]);
    expect(mixer2.disposed).toBe(true);
    expect(next.has(2)).toBe(false);
    expect(created).toHaveLength(1);
    expect(next.get(3)).toBe(created[0]);
    expect(created[0]?.startCalls).toEqual([7]);
  });

  it('is idempotent: calling again with the same enabled set changes nothing', () => {
    const mixer = new FakeLiveAudioMixer();
    const current = new Map([[1, mixer]]);
    const createMixer = (): FakeLiveAudioMixer => {
      throw new Error('should not be called');
    };
    const next = reconcileEnabledTracks(current, new Set([1]), createMixer, { playing: true, atSeconds: 3 });
    expect(next).toEqual(current);
    expect(mixer.disposed).toBe(false);
  });

  it('returns an empty map when nothing is enabled and nothing was current', () => {
    const next = reconcileEnabledTracks(new Map(), new Set(), () => new FakeLiveAudioMixer(), { playing: true, atSeconds: 0 });
    expect(next.size).toBe(0);
  });
});
