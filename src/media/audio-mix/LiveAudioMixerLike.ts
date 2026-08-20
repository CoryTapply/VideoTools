// The testability seam for src/media/audio-mix/'s multi-track orchestration (AudioMixEngine,
// reconcile-tracks.ts), mirroring src/media/playback/VideoElementLike.ts's role: a narrow
// interface capturing exactly what those callers need from a LiveAudioMixer, so their own logic
// (which tracks should be playing/paused/disposed, given a Set of enabled track ids) is provably
// correct in Node against a Fake before any of it touches a real AudioContext/AudioDecoder.

export interface LiveAudioMixerLike {
  start(atSeconds: number): Promise<void>;
  seek(atSeconds: number): void;
  pause(): void;
  dispose(): void;
  reportMasterPosition(masterSeconds: number): void;
  estimatedPositionSeconds(): number | undefined;
  /** Sets this track's own gain (1 = unity), independent of the shared master gain. */
  setVolume(vol: number): void;
}
