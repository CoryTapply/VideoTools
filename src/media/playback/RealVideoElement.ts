// Thin adapter over a real HTMLVideoElement -- the only DOM-touching file in the playback
// module's core path, mirroring src/media/index/sources/file-byte-source.ts's precedent
// ("only DOM-touching implementation in the core parsing path"). Deliberately trivial: no logic
// beyond adapting HTMLVideoElement's richer event/callback shapes down to VideoElementLike's.

import type { VideoElementLike, VideoElementLikeEventType, VideoFrameRequestCallback } from './VideoElementLike';

export class RealVideoElement implements VideoElementLike {
  private readonly video: HTMLVideoElement;

  /**
   * Feature-detected, not assumed -- Chrome does not implement fastSeek despite lib.dom.d.ts
   * declaring it unconditionally on HTMLMediaElement. Left undefined (rather than defined as a
   * method that would throw at call time) so `typeof engine.fastSeek === 'function'` at the
   * NativeVideoEngine call site is an accurate runtime check, not just a type-level one.
   */
  readonly fastSeek?: (time: number) => void;
  readonly requestVideoFrameCallback?: (cb: VideoFrameRequestCallback) => number;
  readonly cancelVideoFrameCallback?: (handle: number) => void;

  constructor(video: HTMLVideoElement = document.createElement('video')) {
    this.video = video;
    if (typeof video.fastSeek === 'function') {
      this.fastSeek = (time: number) => {
        video.fastSeek(time);
      };
    }
    if (typeof video.requestVideoFrameCallback === 'function') {
      this.requestVideoFrameCallback = (cb: VideoFrameRequestCallback) =>
        video.requestVideoFrameCallback((now, metadata) => {
          cb(now, { mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames });
        });
      this.cancelVideoFrameCallback = (handle: number) => {
        video.cancelVideoFrameCallback(handle);
      };
    }
  }

  get currentTime(): number {
    return this.video.currentTime;
  }

  set currentTime(value: number) {
    this.video.currentTime = value;
  }

  get duration(): number {
    return this.video.duration;
  }

  get paused(): boolean {
    return this.video.paused;
  }

  get playbackRate(): number {
    return this.video.playbackRate;
  }

  set playbackRate(value: number) {
    this.video.playbackRate = value;
  }

  get error(): { code: number } | null {
    return this.video.error ? { code: this.video.error.code } : null;
  }

  get src(): string {
    return this.video.src;
  }

  set src(value: string) {
    this.video.src = value;
  }

  canPlayType(mimeType: string): string {
    return this.video.canPlayType(mimeType);
  }

  play(): Promise<void> {
    return this.video.play();
  }

  pause(): void {
    this.video.pause();
  }

  addEventListener(type: VideoElementLikeEventType, cb: () => void): void {
    this.video.addEventListener(type, cb);
  }

  removeEventListener(type: VideoElementLikeEventType, cb: () => void): void {
    this.video.removeEventListener(type, cb);
  }

  /** For NativeVideoEngine.dispose(): revoking an un-revoked object URL pins the entire File for the document's lifetime. */
  get element(): HTMLVideoElement {
    return this.video;
  }
}
