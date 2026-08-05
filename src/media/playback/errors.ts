/**
 * The playback engine's public failure surface, mirroring src/media/index/errors.ts's
 * IndexError -- an expected, discriminated-union condition, never an exception. `load()` returns
 * one of these as `Result.error`; `PlaybackEngine.lastError` surfaces one for a failure that
 * happens after load (e.g. a mid-playback decode error), since `state === 'error'` alone carries
 * no detail.
 */
export type PlaybackError =
  | { kind: 'unsupported-codec'; codec: string }
  | { kind: 'decode-error'; message: string }
  | { kind: 'load-failed'; message: string }
  | { kind: 'aborted' }
  /** load() was given a SampleIndex with no video track (e.g. an audio-only file). */
  | { kind: 'no-video-track' };

/** An actionable, user-facing message for each PlaybackError kind. */
export function formatPlaybackError(error: PlaybackError): string {
  switch (error.kind) {
    case 'unsupported-codec':
      return `This browser cannot play back this file's video codec (${error.codec}). It can still be trimmed, just not previewed.`;
    case 'decode-error':
      return `The video failed to decode: ${error.message}`;
    case 'load-failed':
      return `The video failed to load: ${error.message}`;
    case 'aborted':
      return 'Loading was aborted.';
    case 'no-video-track':
      return 'This file has no video track to play back.';
  }
}
