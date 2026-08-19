import { describe, expect, it } from 'vitest';
import { mixerActionForStateChange } from './state-action';
import type { PlaybackState } from '../playback/PlaybackEngine';

describe('mixerActionForStateChange', () => {
  it('maps playing to start', () => {
    expect(mixerActionForStateChange('playing')).toBe('start');
  });

  it('maps ready, ended, and error to pause', () => {
    expect(mixerActionForStateChange('ready')).toBe('pause');
    expect(mixerActionForStateChange('ended')).toBe('pause');
    expect(mixerActionForStateChange('error')).toBe('pause');
  });

  it('maps seeking to none -- the regression guard: a seek while already playing must not stop audio', () => {
    expect(mixerActionForStateChange('seeking')).toBe('none');
  });

  it('maps loading and idle to none', () => {
    expect(mixerActionForStateChange('loading')).toBe('none');
    expect(mixerActionForStateChange('idle')).toBe('none');
  });

  it('covers every PlaybackState value', () => {
    const allStates: PlaybackState[] = ['idle', 'loading', 'ready', 'playing', 'seeking', 'ended', 'error'];
    for (const state of allStates) {
      expect(() => mixerActionForStateChange(state)).not.toThrow();
    }
  });
});
