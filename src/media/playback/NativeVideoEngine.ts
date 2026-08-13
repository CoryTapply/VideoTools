// M1 Task 2, Parts 4 + 5: the <video>-element-backed PlaybackEngine implementation. Seek
// coalescing (Part 5) lives here rather than in a separate class -- it's tightly coupled to this
// engine's event wiring, not a standalone concern.
//
// ================================================================================================
// STATE MACHINE -- every transition enumerated. Anything not listed below is a silent no-op.
//
//   idle       --load()-->              loading
//   loading    --no video track-->      error (no-video-track)         [before any object URL]
//   loading    --canPlayType fails-->   error (unsupported-codec)      [before any object URL --
//                                        per architecture v2, a source the browser can't preview
//                                        must still be usable for TRIMMING, so this is a distinct
//                                        recoverable outcome, not treated as a fatal load error by
//                                        callers -- lastError still reports it precisely]
//   loading    --'loadedmetadata'-->    ready
//   loading    --video 'error'-->       error (decode-error | load-failed, from MediaError.code)
//   ready      --play()-->              playing
//   ready      --seek()-->              seeking --(settle)--> ready
//   playing    --pause()-->             ready
//   playing    --seek()-->              seeking --(settle)--> playing
//   playing    --reaches end-->         ended
//   playing    --video 'error'-->       error
//   seeking    --another seek()-->      stays seeking (coalesced -- see issueSeek/handleSeeked)
//   ended      --seek()-->              seeking --(settle)--> ready
//   ended      --play()-->              no-op (must seek(0) first; see this file's README)
//   error      --load()-->              loading (re-entrant load allowed)
//   any        --dispose()-->           terminal, idempotent
//
// stepFrames() called while `playing` implicitly pauses first (a real UI affordance -- stepping
// while shuttling -- rather than a surprising no-op), then behaves like seek() from `ready`.
// ================================================================================================

import type { SampleIndex } from '../index/query';
import { secondsToTicks, ticksToSeconds } from '../index/time';
import type { TrackIndex } from '../index/track-index';
import type { PlaybackError } from './errors';
import { stepTarget } from './frame-stepping';
import type { PlaybackEngine, PlaybackState, Time, Unsubscribe } from './PlaybackEngine';
import type { Result } from './result';
import { MEDIA_ERR_DECODE } from './VideoElementLike';
import type { VideoElementLike } from './VideoElementLike';

/** Well below any real frame duration (16ms+ even at 60fps) -- just enough to treat a seek target as "already there." */
const SEEK_EPSILON_SEC = 0.0005;

type SeekMode = 'accurate' | 'scrub';

interface SeekRequest {
  readonly time: Time;
  readonly mode: SeekMode;
}

function codecToMimeType(codec: string): string {
  return `video/mp4; codecs="${codec}"`;
}

export class NativeVideoEngine implements PlaybackEngine {
  private readonly video: VideoElementLike;

  private _state: PlaybackState = 'idle';
  private _lastError: PlaybackError | undefined;
  private _currentTime: Time = 0;
  private disposed = false;
  private objectUrl: string | undefined;
  private index: SampleIndex | undefined;
  private videoTrack: TrackIndex | undefined;

  private readonly stateListeners = new Set<(s: PlaybackState) => void>();
  private readonly frameListeners = new Set<(t: Time, frameIndex: number) => void>();

  // Sync path (Part 4) -- NativeVideoEngine-specific diagnostics, not part of the portable
  // PlaybackEngine interface, since a future WebCodecs engine isn't obligated to replicate them.
  private _syncPath: 'rvfc' | 'raf' | undefined;
  private _droppedFrameCount: number | undefined;
  private lastPresentedFrames: number | undefined;
  private rvfcHandle: number | undefined;
  private rafHandle: number | undefined;

  // Seek coalescing (Part 5). Option A promise semantics -- see seek-promise-semantics.md: every
  // seek() call's promise resolves together, once the engine reaches a fully-settled state,
  // regardless of whether that particular call's target was the one that landed.
  private pendingSeekTarget: SeekRequest | undefined;
  private seekInFlight: SeekRequest | undefined;
  private seekSettleWaiters: Array<() => void> = [];
  private preSeekState: 'ready' | 'playing' | undefined;

  constructor(video: VideoElementLike) {
    this.video = video;
    this.video.addEventListener('seeked', this.handleSeeked);
    this.video.addEventListener('ended', this.handleEnded);
  }

  get state(): PlaybackState {
    return this._state;
  }

  get currentTime(): Time {
    return this._currentTime;
  }

  get lastError(): PlaybackError | undefined {
    return this._lastError;
  }

  /** Which sync path is active ('rvfc' | 'raf'), or undefined before load() completes. */
  get syncPath(): 'rvfc' | 'raf' | undefined {
    return this._syncPath;
  }

  /** Dropped frames detected via rVFC's presentedFrames gaps. undefined (not 0) on the rAF fallback path, which cannot measure drops -- degrade honestly rather than silently report zero. */
  get droppedFrameCount(): number | undefined {
    return this._droppedFrameCount;
  }

  async load(file: File, index: SampleIndex): Promise<Result<void, PlaybackError>> {
    if (this.disposed) return { ok: false, error: { kind: 'aborted' } };
    this.setState('loading');

    const videoTrack = index.tracks().find((t) => t.kind === 'video');
    if (!videoTrack) return this.fail({ kind: 'no-video-track' });

    const mimeType = codecToMimeType(videoTrack.codec);
    if (this.video.canPlayType(mimeType) === '') {
      return this.fail({ kind: 'unsupported-codec', codec: videoTrack.codec });
    }

    this.index = index;
    this.videoTrack = videoTrack;

    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl); // re-entrant load from `error` state
    const url = URL.createObjectURL(file);
    this.objectUrl = url;
    this.video.src = url;

    const result = await new Promise<Result<void, PlaybackError>>((resolve) => {
      const onLoaded = (): void => {
        cleanup();
        resolve({ ok: true, value: undefined });
      };
      const onError = (): void => {
        cleanup();
        const code = this.video.error?.code;
        const kind: 'decode-error' | 'load-failed' = code === MEDIA_ERR_DECODE ? 'decode-error' : 'load-failed';
        resolve({ ok: false, error: { kind, message: `MediaError code ${code === undefined ? 'unknown' : String(code)}` } });
      };
      const cleanup = (): void => {
        this.video.removeEventListener('loadedmetadata', onLoaded);
        this.video.removeEventListener('error', onError);
      };
      this.video.addEventListener('loadedmetadata', onLoaded);
      this.video.addEventListener('error', onError);
    });

    if (this.isDisposed()) return { ok: false, error: { kind: 'aborted' } };
    if (!result.ok) {
      this._lastError = result.error;
      this.setState('error');
      return result;
    }

    this.startSyncLoop();
    this.setState('ready');
    return result;
  }

  play(): void {
    if (this.disposed || this._state !== 'ready') return;
    this.setState('playing');
    void this.video.play();
  }

  pause(): void {
    if (this.disposed || this._state !== 'playing') return;
    this.video.pause();
    this.setState('ready');
  }

  seek(time: Time, mode: SeekMode): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this._state !== 'ready' && this._state !== 'playing' && this._state !== 'seeking' && this._state !== 'ended') {
      return Promise.resolve();
    }

    if (this._state !== 'seeking') {
      this.preSeekState = this._state === 'playing' ? 'playing' : 'ready';
      this.setState('seeking');
    }

    return new Promise<void>((resolve) => {
      this.seekSettleWaiters.push(resolve);
      this.pendingSeekTarget = { time, mode };
      if (!this.seekInFlight) this.issueSeek();
    });
  }

  async stepFrames(n: number): Promise<void> {
    if (this.disposed || !this.index || !this.videoTrack) return;
    if (this._state === 'playing') this.pause();
    if (this._state !== 'ready' && this._state !== 'seeking' && this._state !== 'ended') return;

    const target = stepTarget(this.index, this.videoTrack.trackId, this._currentTime, n);
    await this.seek(target, 'accurate');
  }

  setPlaybackRate(rate: number): void {
    this.video.playbackRate = rate;
  }

  onFrame(cb: (t: Time, frameIndex: number) => void): Unsubscribe {
    this.frameListeners.add(cb);
    return () => this.frameListeners.delete(cb);
  }

  onStateChange(cb: (s: PlaybackState) => void): Unsubscribe {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopSyncLoop();
    this.video.removeEventListener('seeked', this.handleSeeked);
    this.video.removeEventListener('ended', this.handleEnded);
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = undefined;
    }
    this.stateListeners.clear();
    this.frameListeners.clear();
  }

  // ---- internals ---------------------------------------------------------------------------

  private fail(error: PlaybackError): Result<void, PlaybackError> {
    this._lastError = error;
    this.setState('error');
    return { ok: false, error };
  }

  private setState(next: PlaybackState): void {
    if (this._state === next) return;
    this._state = next;
    for (const cb of this.stateListeners) cb(next);
  }

  /** Non-narrowable read of `disposed`, since a plain `this.disposed` re-check after an `await` (dispose() can run during it) gets incorrectly flagged as an always-false condition by TS's flow analysis. */
  private isDisposed(): boolean {
    return this.disposed;
  }

  private requireVideoTrack(): TrackIndex {
    if (!this.videoTrack) throw new Error('NativeVideoEngine: no track loaded');
    return this.videoTrack;
  }

  private issueSeek(): void {
    const target = this.pendingSeekTarget;
    if (!target) return;
    this.seekInFlight = target;
    this.pendingSeekTarget = undefined;

    const track = this.requireVideoTrack();
    const seconds = ticksToSeconds(target.time, track.timescale);

    // Browsers do not reliably fire 'seeked' when currentTime is assigned a value it's already
    // at (e.g. seeking to 0 right after load, when the element is already sitting at 0) --
    // discovered via a real hang in the Part 1 harness script. Since issueSeek() is only ever
    // re-entered from handleSeeked() (on 'seeked'), waiting for an event that never fires would
    // stall the entire seek pipeline forever, not just this one call. Detect the no-op case and
    // settle on a microtask instead of relying on the event.
    if (Math.abs(this.video.currentTime - seconds) < SEEK_EPSILON_SEC) {
      queueMicrotask(this.handleSeeked);
      return;
    }

    if (target.mode === 'scrub' && typeof this.video.fastSeek === 'function') {
      this.video.fastSeek(seconds);
    } else {
      this.video.currentTime = seconds;
    }
  }

  private readonly handleSeeked = (): void => {
    this.seekInFlight = undefined;
    if (this.pendingSeekTarget) {
      // This 'seeked' landed on an intermediate hop that a newer seek() call already superseded
      // (e.g. a quick second scrub released before the first one settled) -- re-issue toward the
      // latest target without broadcasting the now-stale position. onFrame listeners (playhead,
      // timecode) must only ever see the final settled position, never an intermediate coalescing
      // hop, or they visibly snap back to the superseded target before correcting.
      this.issueSeek();
      return;
    }

    // The video element's currentTime is authoritative the instant 'seeked' fires -- sync it now
    // rather than waiting for the next rVFC/rAF tick, so `this.currentTime` (and thus the
    // convergence property) doesn't depend on a frame callback also having fired.
    this.updateCurrentTimeFromSeconds(this.video.currentTime);

    const waiters = this.seekSettleWaiters;
    this.seekSettleWaiters = [];
    const resumeState = this.preSeekState;
    this.preSeekState = undefined;
    if (resumeState) {
      this.setState(resumeState);
      if (resumeState === 'playing') void this.video.play();
    }
    for (const resolve of waiters) resolve();
  };

  private readonly handleEnded = (): void => {
    this.setState('ended');
  };

  private startSyncLoop(): void {
    this.lastPresentedFrames = undefined;
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      this._syncPath = 'rvfc';
      this._droppedFrameCount = 0;
      this.scheduleRvfc();
    } else {
      this._syncPath = 'raf';
      this._droppedFrameCount = undefined; // unavailable on this path -- degrade honestly, don't report a false zero
      this.scheduleRaf();
    }
  }

  private scheduleRvfc(): void {
    if (this.disposed) return;
    this.rvfcHandle = this.video.requestVideoFrameCallback?.((_now, metadata) => {
      if (this.lastPresentedFrames !== undefined) {
        const gap = metadata.presentedFrames - this.lastPresentedFrames - 1;
        if (gap > 0) this._droppedFrameCount = (this._droppedFrameCount ?? 0) + gap;
      }
      this.lastPresentedFrames = metadata.presentedFrames;
      this.updateCurrentTimeFromSeconds(metadata.mediaTime);
      this.scheduleRvfc();
    });
  }

  private scheduleRaf(): void {
    if (this.disposed) return;
    // Guarded (rather than assumed) so this class stays constructible in Node, where there's no
    // requestAnimationFrame global -- the rVFC path is exercised in tests instead; this fallback
    // is real-browser-only functionality by nature.
    if (typeof requestAnimationFrame !== 'function') return;
    this.rafHandle = requestAnimationFrame(() => {
      this.updateCurrentTimeFromSeconds(this.video.currentTime);
      this.scheduleRaf();
    });
  }

  private stopSyncLoop(): void {
    if (this.rvfcHandle !== undefined) {
      this.video.cancelVideoFrameCallback?.(this.rvfcHandle);
      this.rvfcHandle = undefined;
    }
    if (this.rafHandle !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = undefined;
    }
  }

  private updateCurrentTimeFromSeconds(seconds: number): void {
    if (!this.videoTrack) return;
    const ticks = secondsToTicks(seconds, this.videoTrack.timescale);
    this._currentTime = ticks;
    const frameIndex = this.index ? this.index.frameAtPresentationTime(this.videoTrack.trackId, ticks) : -1;
    for (const cb of this.frameListeners) cb(ticks, frameIndex);
  }
}
