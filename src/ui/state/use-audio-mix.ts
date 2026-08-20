// Phase 2 of the live per-track audio preview feature: owns an AudioMixEngine per open file and
// wires it to the real NativeVideoEngine, mirroring media-session.ts's own "resource-shaped state
// lives in its own hook" precedent (see that file's header comment) rather than growing that
// already-large file further.
//
// Deliberately does NOT hook every individual seek call site (seekToSeconds, jumpToKeyframe,
// drag-scrub settle in useTimelineController, ...) -- engine.onFrame already delivers the
// authoritative position synchronously on the very first tick after ANY seek settles, so forwarding
// EVERY onFrame tick (not media-session.ts's own throttled subscription -- this is a second,
// independent listener on the same engine) to AudioMixEngine.reportMasterPosition() is sufficient:
// a big scrub produces a big one-tick drift reading, which each LiveAudioMixer's own
// drift-correction threshold already reacts to.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AudioMixEngine } from '../../media/audio-mix/AudioMixEngine';
import { ticksToSeconds } from '../../media/index/time';
import { audioRealTrackVolumes, selectedAudioRealTrackIds } from '../media/derive-source-info';
import type { RefObject } from 'react';
import type { SampleIndex } from '../../media/index/query';
import type { TrackIndex } from '../../media/index/track-index';
import type { NativeVideoEngine } from '../../media/playback/NativeVideoEngine';
import type { PlaybackState } from '../../media/playback/PlaybackEngine';
import type { TrackSummary } from '../media/track-summary';
import type { TrackSelection, TrackVolume } from './app-state';

export interface UseAudioMixOptions {
  readonly file: File | null;
  readonly tracks: TrackSummary[] | null;
  readonly sel: TrackSelection;
  readonly trackVol: TrackVolume;
  readonly sampleIndexRef: RefObject<SampleIndex | null>;
  readonly engineRef: RefObject<NativeVideoEngine | null>;
  readonly videoTrackRef: RefObject<TrackIndex | null>;
  /** Forced permanently muted once an AudioMixEngine is active for this file -- its own audio now
   * comes entirely from the Web Audio mix, not the native element, so leaving this unmuted would
   * double up every enabled track. A DIFFERENT, lower-level concern than the user-facing
   * AppState.muted, which now drives the mix's own master gain instead (see Effect C below). */
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  readonly vol: number;
  readonly muted: boolean;
}

export interface AudioMix {
  /** Call from the J/L shuttle handler alongside engine.setPlaybackRate() -- NativeVideoEngine has
   * no rate-change event, so this is the one deliberate exception to "don't hook individual call
   * sites." See AudioMixEngine.setPlaybackRateHint's own doc comment. */
  setPlaybackRateHint: (rate: number) => void;
}

export function useAudioMix(opts: UseAudioMixOptions): AudioMix {
  const { file, tracks, sel, trackVol, sampleIndexRef, engineRef, videoTrackRef, videoRef, vol, muted } = opts;
  const audioMixEngineRef = useRef<AudioMixEngine | null>(null);

  // Effect A -- one AudioMixEngine per open file, mirroring engineRef's own per-file lifecycle in
  // media-session.ts. Safe against openFile()'s file-switch ordering: that function sets
  // engineRef.current to the NEW engine synchronously, before its first real `await`, so by the
  // time [file, tracks] actually changes and this effect re-runs, engineRef.current is already
  // correct -- the same guarantee media-session.ts's own activateWaveformTrack effect relies on.
  useEffect(() => {
    if (!file || !tracks) return;
    const sampleIndex = sampleIndexRef.current;
    const engine = engineRef.current;
    if (!sampleIndex || !engine) return;

    const audioTracks = new Map(sampleIndex.tracks().filter((t) => t.kind === 'audio').map((t) => [t.trackId, t] as const));
    const mixEngine = new AudioMixEngine({ audioTracks, file, index: sampleIndex });
    audioMixEngineRef.current = mixEngine;

    const unsubscribeState = engine.onStateChange((state: PlaybackState) => {
      const track = videoTrackRef.current;
      mixEngine.onEngineStateChange(state, track ? ticksToSeconds(engine.currentTime, track.timescale) : 0);
      // Piggybacks on this subscription rather than a separate poll -- videoRef.current is
      // guaranteed mounted by the time 'ready' first fires (openFile() sets it before calling
      // engine.load() at all).
      if (videoRef.current) videoRef.current.muted = true;
    });
    const unsubscribeFrame = engine.onFrame((t) => {
      const track = videoTrackRef.current;
      if (!track) return;
      mixEngine.reportMasterPosition(ticksToSeconds(t, track.timescale));
    });

    return () => {
      unsubscribeState();
      unsubscribeFrame();
      mixEngine.dispose();
      if (audioMixEngineRef.current === mixEngine) audioMixEngineRef.current = null;
    };
    // sampleIndexRef/engineRef/videoTrackRef/videoRef are refs (stable identity across renders,
    // read via .current) -- only file/tracks changing should rebuild the engine, matching
    // media-session.ts's own activateWaveformTrack effect precedent of omitting ref deps.
  }, [file, tracks]);

  // Effect B -- mirrors media-session.ts's activateWaveformTrack effect precedent exactly: reacts
  // to both the initial file-open (tracks/sel land together) and every later live checkbox toggle.
  useEffect(() => {
    if (!tracks) return;
    audioMixEngineRef.current?.setEnabledTracks(selectedAudioRealTrackIds(tracks, sel));
  }, [tracks, sel]);

  // Effect B.5 -- per-track volume sliders (TrackList.tsx), same "preview-only" scope as Effect C's
  // master volume below. Runs every render trackVol/tracks changes, independent of Effect B's
  // enable/disable reconciliation so toggling one track's checkbox never has to re-touch every
  // other track's gain.
  useEffect(() => {
    if (!tracks) return;
    const engine = audioMixEngineRef.current;
    if (!engine) return;
    for (const [trackId, vol] of audioRealTrackVolumes(tracks, trackVol)) {
      engine.setTrackVolume(trackId, vol);
    }
  }, [tracks, trackVol]);

  // Effect C -- the global volume slider/mute button now drives the mix's master gain instead of
  // the native <video> element's own volume/muted (see media-session.ts's removed setVolume/
  // setMuted). design/volume-slider-prompt.md's "must not affect export output" constraint still
  // holds: export remuxes the original file directly, never touches this preview-only gain.
  useEffect(() => {
    audioMixEngineRef.current?.setMasterVolume(vol);
    audioMixEngineRef.current?.setMasterMuted(muted);
  }, [vol, muted]);

  // useCallback so this has stable identity across renders, matching media-session.ts's own
  // togglePlay/stepFrame/jumpToKeyframe/seekToSeconds precedent -- App.tsx's keydown effect lists
  // the returned object as a dependency, and a fresh function/object identity every render would
  // re-subscribe that effect's window listeners on every render for no reason.
  const setPlaybackRateHint = useCallback((rate: number) => {
    audioMixEngineRef.current?.setPlaybackRateHint(rate);
  }, []);

  return useMemo(() => ({ setPlaybackRateHint }), [setPlaybackRateHint]);
}
