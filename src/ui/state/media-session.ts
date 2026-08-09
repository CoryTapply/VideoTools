// Owns the parts of "open a real file" that are resource-shaped, not reducer-shaped: the File
// itself, the built SampleIndex, the NativeVideoEngine instance, and the <video> ref -- mirroring
// the precedent timeline-controller-state.ts already set for "not everything lives in the big
// reducer." app-state.ts still owns screen/sel/tin/tout/openError; this hook dispatches into it
// at the right points rather than duplicating that state.

import { useCallback, useEffect, useRef, useState } from 'react';
// Direct submodule imports, not the barrel -- see app-state.ts's comment on why.
import { IndexWorkerClient } from '../../media/index/worker-client.ts';
import { SampleIndex } from '../../media/index/query.ts';
import { secondsToTicks, ticksToSeconds } from '../../media/index/time.ts';
import { formatPlaybackError } from '../../media/playback/errors.ts';
import { NativeVideoEngine } from '../../media/playback/NativeVideoEngine.ts';
import { RealVideoElement } from '../../media/playback/RealVideoElement.ts';
import { defaultTrackSelection, deriveFormatChip, deriveSourceRows, deriveTrackSummaries, friendlyCodecName } from '../media/derive-source-info.ts';
import { formatFrameNumber, formatTimecode } from './snap-notice.ts';
import type { Dispatch, RefObject } from 'react';
import type { TrackIndex } from '../../media/index/track-index.ts';
import type { PlaybackState } from '../../media/playback/PlaybackEngine.ts';
import type { PlaybackError } from '../../media/playback/errors.ts';
import type { Result } from '../../media/playback/result.ts';
import type { PanelRowFixture } from '../media/panel-row.ts';
import type { TrackSummary } from '../media/track-summary.ts';
import type { AppAction } from './app-state.ts';

export interface UnsupportedInfo {
  message: string;
  codec: string;
  resolution: string;
  fps: string;
}

export interface MediaSession {
  videoRef: RefObject<HTMLVideoElement | null>;
  file: File | null;
  tracks: TrackSummary[] | null;
  sourceRows: PanelRowFixture[] | null;
  formatChip: string | null;
  durationSeconds: number | null;
  fps: number | null;
  unsupported: UnsupportedInfo | null;
  playing: boolean;
  currentSeconds: number;
  timecode: string;
  frameLabel: string;
  openFile: (file: File) => Promise<void>;
  togglePlay: () => void;
  stepFrame: (n: number) => void;
  jumpToKeyframe: (dir: 1 | -1) => void;
  seekToSeconds: (seconds: number) => void;
}

/** Pure, so it's directly testable without a real engine/video element. */
export function nextScreenForLoadOutcome(result: Result<void, PlaybackError>): 'ready' | 'unsupported' {
  return result.ok ? 'ready' : 'unsupported';
}

async function waitForVideoElement(ref: RefObject<HTMLVideoElement | null>): Promise<HTMLVideoElement> {
  if (ref.current !== null) {
    return ref.current;
  }
  return new Promise((resolve) => {
    function check() {
      if (ref.current !== null) {
        resolve(ref.current);
      } else {
        requestAnimationFrame(check);
      }
    }
    requestAnimationFrame(check);
  });
}

export function useMediaSession(dispatch: Dispatch<AppAction>): MediaSession {
  const videoRef = useRef<HTMLVideoElement>(null);
  const engineRef = useRef<NativeVideoEngine | null>(null);
  const sampleIndexRef = useRef<SampleIndex | null>(null);
  const videoTrackRef = useRef<TrackIndex | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [tracks, setTracks] = useState<TrackSummary[] | null>(null);
  const [sourceRows, setSourceRows] = useState<PanelRowFixture[] | null>(null);
  const [formatChip, setFormatChip] = useState<string | null>(null);
  const [durationSeconds, setDurationSeconds] = useState<number | null>(null);
  const [unsupported, setUnsupported] = useState<UnsupportedInfo | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentSeconds, setCurrentSeconds] = useState(0);

  useEffect(
    () => () => {
      engineRef.current?.dispose();
    },
    [],
  );

  const openFile = useCallback(
    async (selected: File) => {
      dispatch({ type: 'screen/set', screen: 'indexing' });
      dispatch({ type: 'open-error/set', error: null });
      setUnsupported(null);

      const client = new IndexWorkerClient();
      const result = await client.index(selected);
      client.terminate();

      if (!result.ok) {
        dispatch({ type: 'open-error/set', error: result.error });
        dispatch({ type: 'screen/set', screen: 'empty' });
        return;
      }

      const rawTracks = result.tracks;
      const sampleIndex = new SampleIndex(rawTracks);
      const videoTrack = rawTracks.find((t) => t.kind === 'video');
      const summaries = deriveTrackSummaries(rawTracks);
      const rows = deriveSourceRows(rawTracks, selected.size);
      const chip = deriveFormatChip(rawTracks, selected.size);
      const sel = defaultTrackSelection(summaries);
      const durationSecondsValue = videoTrack !== undefined ? ticksToSeconds(videoTrack.duration, videoTrack.timescale) : 0;

      sampleIndexRef.current = sampleIndex;
      videoTrackRef.current = videoTrack ?? null;
      setFile(selected);
      setTracks(summaries);
      setSourceRows(rows);
      setFormatChip(chip);
      setDurationSeconds(durationSecondsValue);
      setCurrentSeconds(0);

      dispatch({ type: 'sel/set', sel });
      dispatch({ type: 'in-out/set', tin: 0, tout: durationSecondsValue });

      engineRef.current?.dispose();
      const videoEl = await waitForVideoElement(videoRef);
      const engine = new NativeVideoEngine(new RealVideoElement(videoEl));
      engineRef.current = engine;
      engine.onStateChange((state: PlaybackState) => {
        setPlaying(state === 'playing');
      });
      engine.onFrame((t) => {
        const track = videoTrackRef.current;
        if (track !== null) {
          setCurrentSeconds(ticksToSeconds(t, track.timescale));
        }
      });

      const loadResult = await engine.load(selected, sampleIndex);
      if (nextScreenForLoadOutcome(loadResult) === 'unsupported' && !loadResult.ok) {
        setUnsupported({
          message: formatPlaybackError(loadResult.error),
          codec: videoTrack !== undefined ? friendlyCodecName(videoTrack.codec) : 'unknown',
          resolution: videoTrack?.video !== undefined ? `${videoTrack.video.displayWidth.toString()} × ${videoTrack.video.displayHeight.toString()}` : 'unknown',
          fps: videoTrack?.video !== undefined ? `${videoTrack.video.nominalFrameRate.toFixed(2)} fps` : 'unknown',
        });
        dispatch({ type: 'screen/set', screen: 'unsupported' });
        return;
      }
      dispatch({ type: 'screen/set', screen: 'ready' });
    },
    [dispatch],
  );

  const togglePlay = useCallback(() => {
    const engine = engineRef.current;
    if (engine === null) return;
    if (engine.state === 'playing') {
      engine.pause();
    } else {
      engine.play();
    }
  }, []);

  const stepFrame = useCallback((n: number) => {
    void engineRef.current?.stepFrames(n);
  }, []);

  const jumpToKeyframe = useCallback((dir: 1 | -1) => {
    const engine = engineRef.current;
    const index = sampleIndexRef.current;
    const videoTrack = videoTrackRef.current;
    if (engine === null || index === null || videoTrack === null) return;
    const currentTicks = engine.currentTime;
    const sampleNumber =
      dir === 1 ? index.nextSyncPresentation(videoTrack.trackId, currentTicks) : index.prevSyncPresentation(videoTrack.trackId, currentTicks);
    if (sampleNumber === -1) return;
    const targetTicks = index.presentationTimeOfSample(videoTrack.trackId, sampleNumber);
    void engine.seek(targetTicks, 'accurate');
  }, []);

  const seekToSeconds = useCallback((seconds: number) => {
    const engine = engineRef.current;
    const track = videoTrackRef.current;
    if (engine === null || track === null) return;
    void engine.seek(secondsToTicks(seconds, track.timescale), 'accurate');
  }, []);

  const trackFps = videoTrackRef.current?.video?.nominalFrameRate ?? null;
  const formattingFps = trackFps ?? 60;

  return {
    videoRef,
    file,
    tracks,
    sourceRows,
    formatChip,
    durationSeconds,
    fps: trackFps,
    unsupported,
    playing,
    currentSeconds,
    timecode: formatTimecode(currentSeconds * formattingFps, formattingFps),
    frameLabel: formatFrameNumber(currentSeconds * formattingFps),
    openFile,
    togglePlay,
    stepFrame,
    jumpToKeyframe,
    seekToSeconds,
  };
}
