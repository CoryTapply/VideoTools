// The playback engine port (M1 Task 2, Part 2). Exists so a WebCodecs compositing engine (M6)
// can replace src/media/playback/NativeVideoEngine.ts without the timeline noticing -- every
// method here is written against what a timeline UI actually needs, not against <video>'s API
// shape.
//
// Time base: `Time` is always an integer count of the LOADED FILE'S PRIMARY VIDEO TRACK's own
// timescale units, established once at load() and fixed for the engine's lifetime -- same
// ticks-not-seconds rule as src/media/index/ (see that module's README "Time representation"
// section). It is always PRESENTATION time (edit-adjusted) -- see query.ts's `*Presentation*`
// methods and src/media/index/README.md's "Presentation time vs. media time" section for why
// that boundary matters. Never a float second.

import type { SampleIndex } from '../index/query';
import type { PlaybackError } from './errors';
import type { Result } from './result';

export type Time = number;

export type Unsubscribe = () => void;

export type PlaybackState = 'idle' | 'loading' | 'ready' | 'playing' | 'seeking' | 'ended' | 'error';

export interface PlaybackEngine {
  load(file: File, index: SampleIndex): Promise<Result<void, PlaybackError>>;
  play(): void;
  pause(): void;
  seek(time: Time, mode: 'accurate' | 'scrub'): Promise<void>;
  stepFrames(n: number): Promise<void>;
  /** J/K/L shuttle needs this. */
  setPlaybackRate(rate: number): void;
  readonly state: PlaybackState;
  /** Presentation time, integer timescale units -- see this file's header comment. */
  readonly currentTime: Time;
  /**
   * The most recent PlaybackError, if any -- `state === 'error'` alone carries no detail (e.g.
   * which of several possible mid-playback decode failures occurred). Every engine implementation
   * (including a future WebCodecs one) must expose this, not just NativeVideoEngine-specific
   * diagnostics, since a timeline UI needs error detail through the portable interface.
   */
  readonly lastError: PlaybackError | undefined;
  onFrame(cb: (t: Time, frameIndex: number) => void): Unsubscribe;
  onStateChange(cb: (s: PlaybackState) => void): Unsubscribe;
  dispose(): void;
}
