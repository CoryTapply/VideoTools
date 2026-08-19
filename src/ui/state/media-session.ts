// Owns the parts of "open a real file" that are resource-shaped, not reducer-shaped: the File
// itself, the built SampleIndex, the NativeVideoEngine instance, and the <video> ref -- mirroring
// the precedent timeline-controller-state.ts already set for "not everything lives in the big
// reducer." app-state.ts still owns screen/sel/tstart/tend/openError; this hook dispatches into it
// at the right points rather than duplicating that state.

import { useCallback, useEffect, useRef, useState } from 'react';
// Direct submodule imports, not the barrel -- see app-state.ts's comment on why.
import { IndexWorkerClient } from '../../media/index/worker-client.ts';
import { computeFingerprint } from '../../media/index/fingerprint.ts';
import { SampleIndex } from '../../media/index/query.ts';
import { FileByteSource } from '../../media/index/sources/file-byte-source.ts';
import { secondsToTicks, ticksToSeconds } from '../../media/index/time.ts';
import { FrameCache, defaultWorkerCount } from '../../media/frames/FrameCache.ts';
import { FrameWorkerClient } from '../../media/frames/worker-client.ts';
import { FrameWorkerPool } from '../../media/frames/worker-pool.ts';
import { formatPlaybackError } from '../../media/playback/errors.ts';
import { NativeVideoEngine } from '../../media/playback/NativeVideoEngine.ts';
import { RealVideoElement } from '../../media/playback/RealVideoElement.ts';
import { WaveformCache } from '../../media/waveform/WaveformCache.ts';
import { WaveformWorkerClient } from '../../media/waveform/worker-client.ts';
import { WaveformWorkerPool } from '../../media/waveform/worker-pool.ts';
import { defaultTrackSelection, deriveFormatChip, deriveSourceRows, deriveTrackSummaries, firstSelectedAudioTrackId, friendlyCodecName } from '../media/derive-source-info.ts';
import type { IndexJobStatus, ThumbsJobStatus, WaveformJobStatus } from '../media/derive-source-info.ts';
import { recordRecentFile } from './recent-files.ts';
import { formatDurationCompact, formatFrameNumber } from './snap-notice.ts';
import type { Dispatch, RefObject } from 'react';
import type { TrackIndex } from '../../media/index/track-index.ts';
import type { PlaybackState } from '../../media/playback/PlaybackEngine.ts';
import type { PlaybackError } from '../../media/playback/errors.ts';
import type { Result } from '../../media/playback/result.ts';
import type { PanelRowFixture } from '../media/panel-row.ts';
import type { TrackSummary } from '../media/track-summary.ts';
import type { AppAction, TrackSelection } from './app-state.ts';

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
  /** The waveform lane's ACTIVE cache -- repointed by activateWaveformTrack whenever `sel`'s first
   * selected audio track changes, not fixed to whatever was selected at file-open. Null until a
   * file with at least one audio track is open and one is selected. */
  waveformCacheRef: RefObject<WaveformCache | null>;
  /** The audio TrackIndex backing waveformCacheRef -- TimelineController needs its OWN timescale
   * (never the video track's) to convert WaveformCache.getRange()'s ticks correctly. */
  waveformTrackRef: RefObject<TrackIndex | null>;
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
  /** Real timing for the Jobs panel's "waveform" row -- reflects the CURRENTLY ACTIVE track (see
   * waveformCacheRef), not every audio track's build status. Null when there's no active track
   * (no audio tracks, or none selected). */
  waveformJob: WaveformJobStatus | null;
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

export function useMediaSession(dispatch: Dispatch<AppAction>, sel: TrackSelection): MediaSession {
  const videoRef = useRef<HTMLVideoElement>(null);
  const engineRef = useRef<NativeVideoEngine | null>(null);
  const sampleIndexRef = useRef<SampleIndex | null>(null);
  const videoTrackRef = useRef<TrackIndex | null>(null);
  const frameCacheRef = useRef<FrameCache | null>(null);
  const lastCurrentSecondsUpdateMsRef = useRef(0);

  // Live-reactive waveform lane state -- one WaveformCache per audio track (constructed, not
  // built, at file-open), sharing one WaveformWorkerPool per file. activateWaveformTrack below
  // repoints waveformCacheRef/waveformTrackRef (the pair TimelineController actually reads) to
  // whichever track is currently active, lazily build()-ing it the first time it becomes active.
  const waveformCachesRef = useRef<Map<number, WaveformCache>>(new Map());
  const audioTracksRef = useRef<Map<number, TrackIndex>>(new Map());
  const waveformPoolRef = useRef<WaveformWorkerPool | null>(null);
  // Real build duration per track, recorded the first time each one resolves -- so re-activating
  // an already-built track can show its real recorded time rather than fabricating one.
  const waveformBuildMsRef = useRef<Map<number, number>>(new Map());
  const waveformCacheRef = useRef<WaveformCache | null>(null);
  const waveformTrackRef = useRef<TrackIndex | null>(null);
  const activeWaveformTrackIdRef = useRef<number | undefined>(undefined);

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
  const [waveformJob, setWaveformJob] = useState<WaveformJobStatus | null>(null);

  /** Repoints the single ref pair TimelineController reads to whichever audio track (by real
   * trackId) should currently be active, lazily build()-ing it the first time -- safe to call
   * again on an already-building/already-built cache, per WaveformCache.build()'s own idempotency.
   * No-ops if `trackId` already matches the current active track (e.g. `sel` changed for an
   * unrelated reason, like the video track's own checkbox).
   *
   * Only records `trackId` into activeWaveformTrackIdRef once it's actually been resolved to a
   * real cache (or is `undefined`, a real "nothing selected" state) -- NOT when a lookup finds
   * nothing in waveformCachesRef/audioTracksRef. openFile() populates those maps before the
   * setTracks/dispatch(sel/set) that trigger this function, specifically so that gap can't happen
   * in practice -- but recording a failed lookup as "handled" would make a real occurrence of it
   * (a future refactor reordering openFile(), an unanticipated interleaving) permanently un-retriable,
   * since nothing else re-invokes this once [sel, tracks] stop changing. Leaving the ref alone on
   * failure means a later call with the same trackId (if one ever comes) isn't a silent no-op. */
  const activateWaveformTrack = useCallback((trackId: number | undefined) => {
    if (trackId === activeWaveformTrackIdRef.current) return;

    if (trackId === undefined) {
      activeWaveformTrackIdRef.current = undefined;
      waveformCacheRef.current = null;
      waveformTrackRef.current = null;
      setWaveformJob(null);
      return;
    }
    const cache = waveformCachesRef.current.get(trackId);
    const track = audioTracksRef.current.get(trackId);
    if (cache === undefined || track === undefined) {
      waveformCacheRef.current = null;
      waveformTrackRef.current = null;
      setWaveformJob(null);
      return;
    }
    activeWaveformTrackIdRef.current = trackId;
    waveformCacheRef.current = cache;
    waveformTrackRef.current = track;

    if (cache.isBuilt) {
      setWaveformJob({ status: 'done', ms: waveformBuildMsRef.current.get(trackId) ?? 0 });
      return;
    }
    setWaveformJob({ status: 'running' });
    const startMs = performance.now();
    void cache.build().then(() => {
      const elapsedMs = Math.round(performance.now() - startMs);
      waveformBuildMsRef.current.set(trackId, elapsedMs);
      // A superseded activation (the user switched away, or opened a different file) must not
      // clobber a newer track's job status with this stale one's -- same staleness-guard pattern
      // thumbsJob's warmCoarse callback already uses.
      if (waveformCacheRef.current !== cache) return;
      setWaveformJob({ status: 'done', ms: elapsedMs });
    });
  }, []);

  // Drives both the INITIAL waveform activation (openFile()'s dispatch({type:'sel/set'}) and
  // setTracks(...) land together in the same render, so this effect picks up the fresh sel/tracks
  // right after a file opens) and every later live change when the user toggles which audio track
  // is selected in the Export panel -- one effect handles both, no separate call needed in
  // openFile() itself.
  useEffect(() => {
    if (tracks === null) return;
    activateWaveformTrack(firstSelectedAudioTrackId(tracks, sel));
  }, [sel, tracks, activateWaveformTrack]);

  useEffect(
    () => () => {
      engineRef.current?.dispose();
      frameCacheRef.current?.dispose();
      waveformPoolRef.current?.dispose();
      for (const cache of waveformCachesRef.current.values()) cache.dispose();
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
      // Named to avoid colliding with the hook's own `sel` parameter (the PREVIOUS file's
      // selection, still current until the dispatch below flows through a re-render) -- this is
      // the freshly computed default for the file being opened right now.
      const initialSel = defaultTrackSelection(summaries);
      const durationSecondsValue = videoTrack !== undefined ? ticksToSeconds(videoTrack.duration, videoTrack.timescale) : 0;

      // Dispose the previous file's waveform resources and construct this file's before setTracks/
      // dispatch(sel/set) below -- NOT after, unlike frameCache's own construction further down.
      // setTracks/dispatch land in the same render and immediately trigger the activateWaveformTrack
      // effect (keyed on [sel, tracks]); if waveformCachesRef weren't already fully populated by
      // then, that effect could look up a trackId, find nothing yet (the await below hasn't
      // resolved), and record it as "already handled" -- permanently skipping it, since nothing
      // else re-triggers the effect once the map is populated a moment later. Awaiting the
      // (cheap -- first/last 1MB only, fingerprint.ts's own doc comment) fingerprint here instead
      // closes that gap entirely rather than working around it with a retry mechanism.
      waveformPoolRef.current?.dispose();
      waveformPoolRef.current = null;
      for (const cache of waveformCachesRef.current.values()) cache.dispose();
      waveformCachesRef.current = new Map();
      audioTracksRef.current = new Map();
      waveformBuildMsRef.current = new Map();
      waveformCacheRef.current = null;
      waveformTrackRef.current = null;
      activeWaveformTrackIdRef.current = undefined;
      setWaveformJob(null);

      const audioTracks = rawTracks.filter((t) => t.kind === 'audio' && t.audio !== undefined);
      if (audioTracks.length > 0) {
        // The index worker computes an equivalent fingerprint internally but never surfaces it
        // here, so this is a deliberate, acceptable duplication rather than plumbing a new return
        // value through IndexWorkerClient's protocol.
        const fingerprint = await computeFingerprint(new FileByteSource(selected), selected.lastModified);
        const pool = new WaveformWorkerPool([new WaveformWorkerClient(selected)]);
        waveformPoolRef.current = pool;
        const cachesMap = new Map<number, WaveformCache>();
        const tracksMap = new Map<number, TrackIndex>();
        for (const audioTrack of audioTracks) {
          cachesMap.set(audioTrack.trackId, new WaveformCache({ sampleIndex, audioTrackId: audioTrack.trackId, pool, fingerprint }));
          tracksMap.set(audioTrack.trackId, audioTrack);
        }
        waveformCachesRef.current = cachesMap;
        audioTracksRef.current = tracksMap;
      }

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

      dispatch({ type: 'sel/set', sel: initialSel });
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

  const trackFps = videoTrackRef.current?.video?.nominalFrameRate ?? null;
  const formattingFps = trackFps ?? 60;

  return {
    videoRef,
    engineRef,
    sampleIndexRef,
    videoTrackRef,
    frameCacheRef,
    waveformCacheRef,
    waveformTrackRef,
    file,
    tracks,
    sourceRows,
    formatChip,
    durationSeconds,
    fps: trackFps,
    unsupported,
    indexJob,
    thumbsJob,
    waveformJob,
    playing,
    currentSeconds,
    timecode: formatDurationCompact(currentSeconds),
    frameLabel: formatFrameNumber(currentSeconds * formattingFps),
    openFile,
    togglePlay,
    stepFrame,
    jumpToKeyframe,
    seekToSeconds,
  };
}
