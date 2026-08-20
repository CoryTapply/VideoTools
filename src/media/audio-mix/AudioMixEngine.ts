// Phase 2's multi-track orchestrator: owns the ONE AudioContext/master GainNode every enabled
// track's LiveAudioMixer shares (independent AudioContexts can't be mixed together), and reconciles
// which tracks should currently be decoding+playing against the Export panel's checkbox selection.
//
// Deliberately does NOT hook every individual seek call site (seekToSeconds, jumpToKeyframe,
// drag-scrub settle, ...) -- NativeVideoEngine's own onFrame already delivers the authoritative
// position on the very first tick after ANY seek settles (synchronously, per that class's
// handleSeeked), so forwarding every onFrame tick to reportMasterPosition() via the owning hook is
// sufficient: a big scrub produces a big one-tick drift reading, which LiveAudioMixer's own
// drift-correction threshold already reacts to. See src/ui/state/use-audio-mix.ts.
//
// onEngineStateChange()'s state->action mapping is NOT "start on entering playing, pause on
// leaving" -- see state-action.ts's header comment for why 'seeking' must map to no-op, not pause.

import { mixerActionForStateChange } from './state-action';
import { reconcileEnabledTracks } from './reconcile-tracks';
import { LiveAudioMixer } from './LiveAudioMixer';
import type { LiveAudioMixerLike } from './LiveAudioMixerLike';
import type { PlaybackState } from '../playback/PlaybackEngine';
import type { SampleIndex } from '../index/query';
import type { TrackIndex } from '../index/track-index';

export interface AudioMixEngineOptions {
  /** Real MP4 track id -> TrackIndex, audio-kind tracks only. */
  readonly audioTracks: ReadonlyMap<number, TrackIndex>;
  readonly file: File;
  readonly index: SampleIndex;
  readonly onError?: (trackId: number, message: string) => void;
  /** Test seam -- defaults to constructing a real LiveAudioMixer. */
  readonly createMixer?: (trackId: number, track: TrackIndex, ctx: AudioContext, destination: AudioNode) => LiveAudioMixerLike;
  /** Test seam -- defaults to constructing a real AudioContext, which doesn't exist in Node. A test
   * providing both this and `createMixer` never needs the object to be a REAL AudioContext, since
   * the fake createMixer never dereferences it either -- only AudioMixEngine's own
   * createGain()/connect()/close() calls need to be satisfied. */
  readonly ctx?: AudioContext;
}

export class AudioMixEngine {
  readonly ctx: AudioContext;
  private readonly masterGain: GainNode;
  private readonly audioTracks: ReadonlyMap<number, TrackIndex>;
  private readonly file: File;
  private readonly index: SampleIndex;
  private readonly onError: (trackId: number, message: string) => void;
  private readonly createMixerFn: (trackId: number, track: TrackIndex, ctx: AudioContext, destination: AudioNode) => LiveAudioMixerLike;

  private mixers: Map<number, LiveAudioMixerLike> = new Map();
  private lastState: PlaybackState = 'idle';
  private lastSeconds = 0;
  private atUnityRate = true;
  private vol = 1;
  private muted = false;
  private disposed = false;
  /** Per-track volume, keyed by real MP4 track id -- survives a mixer's dispose/recreate cycle
   * (e.g. unchecking then rechecking a track's export selection), since a fresh LiveAudioMixer
   * would otherwise reset to unity gain. */
  private readonly trackVolumes = new Map<number, number>();

  constructor(opts: AudioMixEngineOptions) {
    this.audioTracks = opts.audioTracks;
    this.file = opts.file;
    this.index = opts.index;
    this.onError = opts.onError ?? (() => undefined);
    this.createMixerFn =
      opts.createMixer ??
      ((trackId, track, ctx, destination) =>
        new LiveAudioMixer({
          file: this.file,
          index: this.index,
          track,
          ctx,
          destination,
          onError: (message) => {
            this.onError(trackId, message);
          },
        }));

    this.ctx = opts.ctx ?? new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.connect(this.ctx.destination);
    this.applyGain();
  }

  /** Reconciles currently-live mixers against the newly-desired set of enabled real track ids --
   * disposes ones no longer enabled, creates+starts ones newly enabled, leaves the rest untouched. */
  setEnabledTracks(trackIds: ReadonlySet<number>): void {
    if (this.disposed) return;
    this.mixers = reconcileEnabledTracks(
      this.mixers,
      trackIds,
      (trackId) => {
        const track = this.audioTracks.get(trackId);
        if (!track) throw new Error(`AudioMixEngine: no audio track with real id ${String(trackId)}`);
        const mixer = this.createMixerFn(trackId, track, this.ctx, this.masterGain);
        const vol = this.trackVolumes.get(trackId);
        if (vol !== undefined) mixer.setVolume(vol);
        return mixer;
      },
      { playing: this.lastState === 'playing' && this.atUnityRate, atSeconds: this.lastSeconds },
    );
  }

  /** Drives every enabled mixer's start/pause from NativeVideoEngine's own state transitions --
   * see state-action.ts for the exact mapping and why 'seeking' is a no-op here. */
  onEngineStateChange(state: PlaybackState, atSeconds: number): void {
    if (this.disposed) return;
    this.lastState = state;
    this.lastSeconds = atSeconds;
    const action = mixerActionForStateChange(state);
    if (action === 'none') return;
    if (action === 'pause') {
      for (const mixer of this.mixers.values()) mixer.pause();
      return;
    }
    // action === 'start' -- but not while shuttling at a non-1x rate; setPlaybackRateHint() owns
    // start/pause for that case (see its own doc comment).
    if (!this.atUnityRate) return;
    for (const mixer of this.mixers.values()) void mixer.start(atSeconds);
  }

  /** Call on every onFrame tick (unthrottled) -- forwards to every enabled mixer's own
   * drift-correction check. This alone is what keeps every track in sync through every seek. */
  reportMasterPosition(atSeconds: number): void {
    if (this.disposed) return;
    this.lastSeconds = atSeconds;
    for (const mixer of this.mixers.values()) mixer.reportMasterPosition(atSeconds);
  }

  /** Sets one track's own gain (1 = unity), independent of the shared master gain. Applied
   * immediately if the track currently has a live mixer, and remembered for whenever it next
   * gets one (see setEnabledTracks's createMixer callback above). */
  setTrackVolume(trackId: number, vol: number): void {
    this.trackVolumes.set(trackId, vol);
    this.mixers.get(trackId)?.setVolume(vol);
  }

  setMasterVolume(vol: number): void {
    this.vol = vol;
    this.applyGain();
  }

  setMasterMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
  }

  /** J/L shuttle runs the engine at a non-1x rate while staying in the 'playing' state, which
   * onEngineStateChange alone can't detect (NativeVideoEngine has no rate-change event) -- called
   * directly from the shuttle key handler. Pauses every mixer while shuttling (no rate-synced audio
   * yet -- explicitly out of scope, see the plan doc) and resumes them at 1x if playback is still
   * (or became) active. Idempotent: repeated calls with the same unity-ness are no-ops, so this is
   * safe to call on every shuttle key-repeat. */
  setPlaybackRateHint(rate: number): void {
    if (this.disposed) return;
    const atUnity = rate === 1;
    if (this.atUnityRate === atUnity) return;
    this.atUnityRate = atUnity;
    if (!atUnity) {
      for (const mixer of this.mixers.values()) mixer.pause();
    } else if (this.lastState === 'playing') {
      for (const mixer of this.mixers.values()) void mixer.start(this.lastSeconds);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const mixer of this.mixers.values()) mixer.dispose();
    this.mixers = new Map();
    void this.ctx.close();
  }

  private applyGain(): void {
    this.masterGain.gain.value = this.muted ? 0 : this.vol;
  }
}
