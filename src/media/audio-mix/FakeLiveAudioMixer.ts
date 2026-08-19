// The Node-testable double for LiveAudioMixerLike, mirroring src/media/playback/FakeVideoElement.ts's
// role: records every call so reconcile-tracks.ts's/AudioMixEngine's own logic (which track ids get
// started/paused/disposed, and when) is provably correct without touching a real AudioContext.

import type { LiveAudioMixerLike } from './LiveAudioMixerLike';

export class FakeLiveAudioMixer implements LiveAudioMixerLike {
  readonly startCalls: number[] = [];
  readonly seekCalls: number[] = [];
  pauseCallCount = 0;
  disposed = false;

  private estimatedPosition: number | undefined;

  start(atSeconds: number): Promise<void> {
    this.startCalls.push(atSeconds);
    return Promise.resolve();
  }

  seek(atSeconds: number): void {
    this.seekCalls.push(atSeconds);
  }

  pause(): void {
    this.pauseCallCount += 1;
  }

  dispose(): void {
    this.disposed = true;
  }

  reportMasterPosition(): void {
    // no-op -- reconcile-tracks.ts/AudioMixEngine's logic doesn't depend on this Fake reacting to
    // drift, only on it recording that the call happened would need a new field; not needed yet.
  }

  estimatedPositionSeconds(): number | undefined {
    return this.estimatedPosition;
  }

  // ---- test-only controls, not part of LiveAudioMixerLike -------------------------------------

  /** Configures what estimatedPositionSeconds() returns. */
  setEstimatedPosition(seconds: number | undefined): void {
    this.estimatedPosition = seconds;
  }
}
