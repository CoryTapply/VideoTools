// The testability seam for src/media/playback/, mirroring src/media/index/byte-source.ts's
// ByteSource: a narrow interface capturing exactly the HTMLVideoElement surface
// NativeVideoEngine.ts actually uses, so seek-coalescing and frame-stepping logic (the interesting
// bugs, per that module's own README) can run in Node against a fake, never a real browser.
//
// One necessary addition beyond the task's originally quoted shape: a settable `src`, since
// nothing in the quoted interface provided any way to point the element at a file at all.

export type VideoElementLikeEventType = 'loadedmetadata' | 'seeked' | 'error' | 'ended' | 'play' | 'pause';

/** Minimal shape of what NativeVideoEngine reads off a failed load/decode -- see MediaError's `code` constants. */
export interface VideoElementLikeError {
  readonly code: number;
}

export interface VideoFrameCallbackMetadata {
  readonly mediaTime: number;
  readonly presentedFrames: number;
}

export type VideoFrameRequestCallback = (now: number, metadata: VideoFrameCallbackMetadata) => void;

export interface VideoElementLike {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  playbackRate: number;
  readonly error: VideoElementLikeError | null;
  src: string;
  /** Empty string means "cannot play" -- see the MediaElement spec's CanPlayTypeResult ('' | 'maybe' | 'probably'). */
  canPlayType(mimeType: string): string;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: VideoElementLikeEventType, cb: () => void): void;
  removeEventListener(type: VideoElementLikeEventType, cb: () => void): void;
  fastSeek?(time: number): void;
  requestVideoFrameCallback?(cb: VideoFrameRequestCallback): number;
  cancelVideoFrameCallback?(handle: number): void;
}

/** MediaError code constants (from the DOM spec) NativeVideoEngine distinguishes 'decode-error' from 'load-failed' with. */
export const MEDIA_ERR_NETWORK = 2;
export const MEDIA_ERR_DECODE = 3;
export const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;
