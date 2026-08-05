// The Node-testable double for VideoElementLike -- same trick src/media/index/ played with
// BufferByteSource for ByteSource, and for the same reason: the interesting bugs (seek
// coalescing, frame stepping) live in edge cases, and edge cases need to be cheap to construct.
//
// Supports exactly what src/media/playback/NativeVideoEngine.seek-coalescing.test.ts and
// frame-stepping tests need: configurable seek latency (via real timers -- tests drive them with
// vi.useFakeTimers()), seeks that never resolve, and manual out-of-order 'seeked' firing that
// bypasses the latency machinery entirely, so a test can prove the coalescing logic isn't
// confused by an event that doesn't correspond to whatever it thinks is in flight.

import type { VideoElementLike, VideoElementLikeError, VideoElementLikeEventType, VideoFrameRequestCallback } from './VideoElementLike';

export interface FakeVideoElementOptions {
  duration?: number;
  /** Fixed delay, or a function called per-seek (e.g. to vary latency), before 'seeked' fires automatically. Default 0. */
  seekLatencyMs?: number | (() => number);
  /** Delay before 'loadedmetadata' (or 'error', if simulateLoadError is set) fires after `src` is assigned. Default 0. */
  loadLatencyMs?: number;
  /** If set, assigning `src` fires 'error' with this code instead of 'loadedmetadata'. */
  simulateLoadError?: VideoElementLikeError;
  hasFastSeek?: boolean;
  hasRequestVideoFrameCallback?: boolean;
  /** Default: always "probably" (can play). Set to '' (or a function returning '') to simulate an unsupported codec. */
  canPlayTypeResult?: string | ((mimeType: string) => string);
}

export class FakeVideoElement implements VideoElementLike {
  readonly duration: number;
  paused = true;
  playbackRate = 1;
  error: VideoElementLikeError | null = null;

  readonly fastSeek?: (time: number) => void;
  readonly requestVideoFrameCallback?: (cb: VideoFrameRequestCallback) => number;
  readonly cancelVideoFrameCallback?: (handle: number) => void;

  private _currentTime = 0;
  private _src = '';
  private readonly seekLatencyMs: number | (() => number);
  private readonly loadLatencyMs: number;
  private readonly simulateLoadError: VideoElementLikeError | undefined;
  private readonly canPlayTypeResult: string | ((mimeType: string) => string);
  private readonly listeners = new Map<VideoElementLikeEventType, Set<() => void>>();
  private readonly rvfcCallbacks = new Map<number, VideoFrameRequestCallback>();
  private nextRvfcHandle = 1;
  private neverResolveArmed = false;
  private playRejectionArmed: Error | undefined;
  private frameCounter = 0;

  constructor(options: FakeVideoElementOptions = {}) {
    this.duration = options.duration ?? 100;
    this.seekLatencyMs = options.seekLatencyMs ?? 0;
    this.loadLatencyMs = options.loadLatencyMs ?? 0;
    this.simulateLoadError = options.simulateLoadError;
    this.canPlayTypeResult = options.canPlayTypeResult ?? 'probably';

    if (options.hasFastSeek ?? true) {
      this.fastSeek = (time: number) => {
        this.beginSeek(time);
      };
    }
    if (options.hasRequestVideoFrameCallback ?? true) {
      this.requestVideoFrameCallback = (cb: VideoFrameRequestCallback): number => {
        const handle = this.nextRvfcHandle;
        this.nextRvfcHandle += 1;
        this.rvfcCallbacks.set(handle, cb);
        return handle;
      };
      this.cancelVideoFrameCallback = (handle: number): void => {
        this.rvfcCallbacks.delete(handle);
      };
    }
  }

  get currentTime(): number {
    return this._currentTime;
  }

  set currentTime(value: number) {
    this.beginSeek(value);
  }

  get src(): string {
    return this._src;
  }

  set src(value: string) {
    this._src = value;
    const latency = this.loadLatencyMs;
    setTimeout(() => {
      if (this.simulateLoadError) {
        this.error = this.simulateLoadError;
        this.emit('error');
      } else {
        this.emit('loadedmetadata');
      }
    }, latency);
  }

  canPlayType(mimeType: string): string {
    return typeof this.canPlayTypeResult === 'function' ? this.canPlayTypeResult(mimeType) : this.canPlayTypeResult;
  }

  play(): Promise<void> {
    this.paused = false;
    this.emit('play');
    if (this.playRejectionArmed) {
      const err = this.playRejectionArmed;
      this.playRejectionArmed = undefined;
      return Promise.reject(err);
    }
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
    this.emit('pause');
  }

  addEventListener(type: VideoElementLikeEventType, cb: () => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: VideoElementLikeEventType, cb: () => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  // ---- test-only controls, not part of VideoElementLike --------------------------------------

  /** Arms the NEXT seek (currentTime= or fastSeek()) to never fire 'seeked' -- simulates a stuck seek. */
  neverResolveNextSeek(): void {
    this.neverResolveArmed = true;
  }

  /** Manually fires 'seeked' with the given resulting time, bypassing the latency timer entirely -- for out-of-order simulation. */
  fireSeeked(currentTime: number): void {
    this._currentTime = currentTime;
    this.emit('seeked');
  }

  /** Arms the next play() call to reject with `err` (default: a generic Error) instead of resolving. */
  simulatePlayRejection(err: Error = new Error('play() was interrupted')): void {
    this.playRejectionArmed = err;
  }

  /** Manually fires ALL currently-registered rVFC callbacks once (matching the real API's one-shot-per-registration contract), then clears them. */
  fireFrameCallback(mediaTime: number, presentedFrames?: number): void {
    this.frameCounter = presentedFrames ?? this.frameCounter + 1;
    const callbacks = Array.from(this.rvfcCallbacks.values());
    this.rvfcCallbacks.clear();
    for (const cb of callbacks) cb(performance.now(), { mediaTime, presentedFrames: this.frameCounter });
  }

  fireEnded(): void {
    this.emit('ended');
  }

  private beginSeek(target: number): void {
    if (this.neverResolveArmed) {
      this.neverResolveArmed = false;
      return;
    }
    const latency = typeof this.seekLatencyMs === 'function' ? this.seekLatencyMs() : this.seekLatencyMs;
    setTimeout(() => {
      this._currentTime = target;
      this.emit('seeked');
    }, latency);
  }

  private emit(type: VideoElementLikeEventType): void {
    for (const cb of this.listeners.get(type) ?? []) cb();
  }
}
