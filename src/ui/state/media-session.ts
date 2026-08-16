// Owns the parts of "open a real file" that are resource-shaped, not reducer-shaped: the File
// itself, the built SampleIndex, the NativeVideoEngine instance, and the <video> ref -- mirroring
// the precedent timeline-controller-state.ts already set for "not everything lives in the big
// reducer." app-state.ts still owns screen/sel/tstart/tend/openError; this hook dispatches into it
// at the right points rather than duplicating that state.

import { useCallback, useEffect, useRef, useState } from 'react';
// Direct submodule imports, not the barrel -- see app-state.ts's comment on why.
import { IndexWorkerClient } from '../../media/index/worker-client.ts';
import { SampleIndex } from '../../media/index/query.ts';
import { secondsToTicks, ticksToSeconds } from '../../media/index/time.ts';
import { FrameCache, defaultWorkerCount } from '../../media/frames/FrameCache.ts';
import { FrameWorkerClient } from '../../media/frames/worker-client.ts';
import { FrameWorkerPool } from '../../media/frames/worker-pool.ts';
import { formatPlaybackError } from '../../media/playback/errors.ts';
import { NativeVideoEngine } from '../../media/playback/NativeVideoEngine.ts';
import { RealVideoElement } from '../../media/playback/RealVideoElement.ts';
import { defaultTrackSelection, deriveFormatChip, deriveSourceRows, deriveTrackSummaries, friendlyCodecName } from '../media/derive-source-info.ts';
import type { IndexJobStatus, ThumbsJobStatus } from '../media/derive-source-info.ts';
import { recordRecentFile } from './recent-files.ts';
import { formatDurationCompact, formatFrameNumber } from './snap-notice.ts';
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
  /** The live playback engine, exposed so useTimelineController (Task 4b) can subscribe to
   * onFrame at 60Hz via a ref write and issue the drag-scrub settle seek directly -- see
   * timeline-controller-state.ts's ticks-vs-seconds note. Null until a file is loaded. */
  engineRef: RefObject<NativeVideoEngine | null>;
  /** Same reasoning as engineRef: the timeline needs direct, synchronous access for keyframe
   * queries (keyframePresentationTimes, nearestSyncAtOrBeforePresentation, ...), not just the
   * derived display fields below. */
  sampleIndexRef: RefObject<SampleIndex | null>;
  videoTrackRef: RefObject<TrackIndex | null>;
  /** The two-tier frame cache backing the filmstrip and cache-only drag-scrub preview. Built and
   * warmCoarse()'d once per file open; null until then. */
  frameCacheRef: RefObject<FrameCache | null>;
  file: File | null;
  tracks: TrackSummary[] | null;
  sourceRows: PanelRowFixture[] | null;
  formatChip: string | null;
  durationSeconds: number | null;
  fps: number | null;
  unsupported: UnsupportedInfo | null;
  /** Real timing for the Jobs panel's "index" row -- see derive-source-info.ts's deriveJobsRows. */
  indexJob: IndexJobStatus | null;
  /** Real progress for the Jobs panel's "thumbs" row, driven by FrameCache.warmCoarse()'s
   * onProgress -- null when the current file has no video track to warm thumbnails for. */
  thumbsJob: ThumbsJobStatus | null;
  playing: boolean;
  currentSeconds: number;
  timecode: string;
  frameLabel: string;
  openFile: (file: File) => Promise<void>;
  togglePlay: () => void;
  stepFrame: (n: number) => void;
  jumpToKeyframe: (dir: 1 | -1) => void;
  seekToSeconds: (seconds: number) => void;
  /** Preview-only monitoring gain -- design/volume-slider-prompt.md. A no-op until the <video>
   * element mounts; the caller re-applies once it does (see App.tsx's effect keyed on media.file). */
  setVolume: (vol: number) => void;
  setMuted: (muted: boolean) => void;
}

/** setCurrentSeconds only needs to be fresh enough for the transport bar's fallback text and the
 * harness -- the real 60Hz playhead reader is useTimelineController's ref-based onFrame
 * subscription (Task 4b), added on top of this one. Gating this one to ~4Hz keeps the existing
 * per-frame onFrame callback from re-rendering the whole App tree during playback, which
 * architecture-v3.md's "React re-renders only on discrete state changes, never on playhead
 * movement" rule forbids. */
const CURRENT_SECONDS_UPDATE_INTERVAL_MS = 250;

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
  const frameCacheRef = useRef<FrameCache | null>(null);
  const lastCurrentSecondsUpdateMsRef = useRef(0);

  const [file, setFile] = useState<File | null>(null);
  const [tracks, setTracks] = useState<TrackSummary[] | null>(null);
  const [sourceRows, setSourceRows] = useState<PanelRowFixture[] | null>(null);
  const [formatChip, setFormatChip] = useState<string | null>(null);
  const [durationSeconds, setDurationSeconds] = useState<number | null>(null);
  const [unsupported, setUnsupported] = useState<UnsupportedInfo | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const [indexJob, setIndexJob] = useState<IndexJobStatus | null>(null);
  const [thumbsJob, setThumbsJob] = useState<ThumbsJobStatus | null>(null);

  useEffect(
    () => () => {
      engineRef.current?.dispose();
      frameCacheRef.current?.dispose();
    },
    [],
  );

  const openFile = useCallback(
    async (selected: File) => {
      dispatch({ type: 'screen/set', screen: 'indexing' });
      dispatch({ type: 'open-error/set', error: null });
      setUnsupported(null);
      setIndexJob({ status: 'running' });
      setThumbsJob(null);

      const client = new IndexWorkerClient();
      const indexStartMs = performance.now();
      const result = await client.index(selected);
      const indexMs = Math.round(performance.now() - indexStartMs);
      client.terminate();

      if (!result.ok) {
        dispatch({ type: 'open-error/set', error: result.error });
        dispatch({ type: 'screen/set', screen: 'empty' });
        setIndexJob(null);
        return;
      }
      setIndexJob({ status: 'done', ms: indexMs });

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
      recordRecentFile(selected.name);
      setFile(selected);
      setTracks(summaries);
      setSourceRows(rows);
      setFormatChip(chip);
      setDurationSeconds(durationSecondsValue);
      setCurrentSeconds(0);
      lastCurrentSecondsUpdateMsRef.current = 0;

      dispatch({ type: 'sel/set', sel });
      dispatch({ type: 'start-end/set', tstart: 0, tend: durationSecondsValue });

      frameCacheRef.current?.dispose();
      frameCacheRef.current = null;
      if (videoTrack?.video !== undefined) {
        const workerCount = defaultWorkerCount(navigator.hardwareConcurrency);
        const pool = new FrameWorkerPool(Array.from({ length: workerCount }, () => new FrameWorkerClient(selected)));
        const frameCache = new FrameCache({ sampleIndex, videoTrackId: videoTrack.trackId, pool });
        frameCacheRef.current = frameCache;
        setThumbsJob({ status: 'running', percent: 0 });
        const thumbsStartMs = performance.now();
        void frameCache
          .warmCoarse((completed, total) => {
            // Guards against a stale progress/completion callback from a since-superseded file's
            // warmCoarse landing after the user has already opened another file.
            if (frameCacheRef.current !== frameCache) return;
            setThumbsJob({ status: 'running', percent: total > 0 ? Math.round((completed / total) * 100) : 0 });
          })
          .then(() => {
            if (frameCacheRef.current !== frameCache) return;
            setThumbsJob({ status: 'done', ms: Math.round(performance.now() - thumbsStartMs) });
          });
      }

      engineRef.current?.dispose();
      const videoEl = await waitForVideoElement(videoRef);
      const engine = new NativeVideoEngine(new RealVideoElement(videoEl));
      engineRef.current = engine;
      engine.onStateChange((state: PlaybackState) => {
        setPlaying(state === 'playing');
      });
      engine.onFrame((t) => {
        const track = videoTrackRef.current;
        if (track === null) return;
        // Only throttle while actively playing -- that's the 60Hz case this guards against. A
        // single seek/step's onFrame (the common case while paused) must update immediately, or
        // frame-stepping and jump-to-keyframe would look laggy by up to the throttle interval.
        if (engineRef.current?.state === 'playing') {
          const now = performance.now();
          if (now - lastCurrentSecondsUpdateMsRef.current < CURRENT_SECONDS_UPDATE_INTERVAL_MS) return;
          lastCurrentSecondsUpdateMsRef.current = now;
        }
        setCurrentSeconds(ticksToSeconds(t, track.timescale));
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
    // Only the backward jump pauses first. While playing, currentTicks keeps advancing forward on
    // its own, so nextSyncPresentation naturally lands on a later keyframe each key-repeat -- but
    // prevSyncPresentation would keep recomputing from a playhead barely past the last target,
    // returning that same keyframe every time, unless playback is stopped first.
    if (dir === -1 && engine.state === 'playing') engine.pause();
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

  const setVolume = useCallback((vol: number) => {
    const el = videoRef.current;
    if (el !== null) el.volume = vol;
  }, []);

  const setMuted = useCallback((muted: boolean) => {
    const el = videoRef.current;
    if (el !== null) el.muted = muted;
  }, []);

  const trackFps = videoTrackRef.current?.video?.nominalFrameRate ?? null;
  const formattingFps = trackFps ?? 60;

  return {
    videoRef,
    engineRef,
    sampleIndexRef,
    videoTrackRef,
    frameCacheRef,
    file,
    tracks,
    sourceRows,
    formatChip,
    durationSeconds,
    fps: trackFps,
    unsupported,
    indexJob,
    thumbsJob,
    playing,
    currentSeconds,
    timecode: formatDurationCompact(currentSeconds),
    frameLabel: formatFrameNumber(currentSeconds * formattingFps),
    openFile,
    togglePlay,
    stepFrame,
    jumpToKeyframe,
    seekToSeconds,
    setVolume,
    setMuted,
  };
}
