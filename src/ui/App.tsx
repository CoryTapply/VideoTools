import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import styles from './App.module.css';
// Direct submodule imports, not the barrel -- see state/app-state.ts's comment on why.
import { formatIndexError } from '../media/index/errors.ts';
import { ticksToSeconds } from '../media/index/time.ts';
import { estimateExportBytes } from '../media/export/estimate.ts';
import { resolveExportSelection } from '../media/export/select.ts';
import { formatExportError } from '../media/export/types.ts';
import { DegradedStrip } from './chrome/DegradedStrip.tsx';
import { ExportErrorToast } from './chrome/ExportErrorToast.tsx';
import { ExportOverlay } from './chrome/ExportOverlay.tsx';
import { ExportToast } from './chrome/ExportToast.tsx';
import { railClearancePx, transportPillBottomPx } from './chrome/floating-offsets.ts';
import { KeyboardOverlay } from './chrome/KeyboardOverlay.tsx';
import { NoticeChip } from './chrome/NoticeChip.tsx';
import { Splitter } from './chrome/Splitter.tsx';
import { Stage } from './chrome/Stage.tsx';
import { TimelineRegion } from './chrome/TimelineRegion.tsx';
import { TitleBar } from './chrome/TitleBar.tsx';
import { TransportBar } from './chrome/TransportBar.tsx';
import {
  DEFAULT_START_SECONDS,
  DEFAULT_END_SECONDS,
  EXPORT_DURATION_LABEL,
  EXPORT_OUT_PATH,
  FILE_NAME,
  FORMAT_CHIP,
  FPS,
  JOBS_PANEL_ROWS,
  PLAYHEAD_SECONDS,
  SOURCE_PANEL_ROWS,
  TRACKS,
  formatExportLine,
} from './fixtures.ts';
import { deriveJobsRows, selectedRealTrackIds } from './media/derive-source-info.ts';
import type { ExportJobStatus } from './media/derive-source-info.ts';
import { useChromeVisibility } from './state/useChromeVisibility.ts';
import { useExportSession } from './state/export-session.ts';
import { matchShortcut } from './state/keyboard-map.ts';
import { useMediaSession } from './state/media-session.ts';
import { useAudioMix } from './state/use-audio-mix.ts';
import { nextShuttleRate } from './state/shuttle.ts';
import { formatDurationCompact, formatFrameNumber } from './state/snap-notice.ts';
import { useTimelineControllerRef } from './state/timeline-controller-state.ts';
import { useTimelineController } from './state/useTimelineController.ts';
import { fitToDuration, zoomAtPlayhead } from './timeline/viewport.ts';
import { appReducer, createInitialAppState } from './state/app-state.ts';
import type { ChangeEvent } from 'react';
import type { AppState } from './state/app-state.ts';

export interface AppProps {
  initialState?: Partial<AppState>;
  exactAvailable?: boolean;
}

const FULLSCREEN_TIMELINE_CAP_PX = 140;
const OPEN_FILE_ACCEPT = 'video/mp4,video/quicktime,.mp4,.mov';
// Not specified by design/README.md (which only names the "+"/"-"/Shift+Z chords, not a step
// size) -- 20% per keypress is a reasonable default, isolated here so it's a one-line tune.
const KEYBOARD_ZOOM_IN_FACTOR = 0.8;

/** Real progress line once a real estimate is available -- deliberately doesn't fabricate
 * throughput/ETA the way fixtures.ts's formatExportLine does; "N / M MB" is exactly what's known. */
function formatExportProgressLine(percent: number, totalBytesEstimate: number): string {
  if (totalBytesEstimate <= 0) return `${percent.toString()}%`;
  const writtenMb = Math.round((totalBytesEstimate * percent) / 100 / (1024 * 1024));
  const totalMb = Math.round(totalBytesEstimate / (1024 * 1024));
  return `${writtenMb.toString()} / ${totalMb.toString()} MB`;
}

export function App({ initialState, exactAvailable = true }: AppProps) {
  const [state, dispatch] = useReducer(
    appReducer,
    initialState,
    (overrides) => createInitialAppState({ tstart: DEFAULT_START_SECONDS, tend: DEFAULT_END_SECONDS, ...overrides }),
  );
  const media = useMediaSession(dispatch, state.sel);
  const audioMix = useAudioMix({
    file: media.file,
    tracks: media.tracks,
    sel: state.sel,
    sampleIndexRef: media.sampleIndexRef,
    engineRef: media.engineRef,
    videoTrackRef: media.videoTrackRef,
    videoRef: media.videoRef,
    vol: state.vol,
    muted: state.muted,
  });
  const exportSession = useExportSession(dispatch, media);
  const { togglePlay, stepFrame, jumpToKeyframe, seekToSeconds } = media;
  // Real once a file is open; otherwise the design fixture -- moved up from the other derived
  // render values below so latestRef (just below) can keep the keydown handler's 'export' case
  // fresh without a stale closure.
  const tracks = media.tracks ?? TRACKS;
  const sourceFileName = media.file?.name ?? FILE_NAME;
  const timelineControllerRef = useTimelineControllerRef();
  const { timelineCanvasRef, scrubOverlayCanvasRef, transportTimecodeRef, chipStartRef, chipEndRef } = useTimelineController(
    media,
    timelineControllerRef,
    dispatch,
    state.trimMode,
    state.tstart,
    state.tend,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  // J/L shuttle rate, ticks/sec-multiplier-style (see state/shuttle.ts) -- a plain ref, not React
  // state, since it changes on every OS key-repeat and never needs to trigger a render.
  const shuttleRateRef = useRef(0);
  // Reverse shuttle (J) can't use <video>.playbackRate the way forward shuttle (L) does --
  // browsers don't support negative playback rates, so the video element just sits frozen. This
  // drives reverse manually: an rAF loop tracks a "virtual" position and repeatedly calls
  // engine.seek(), relying on NativeVideoEngine's own seek-coalescing (the same mechanism
  // drag-scrub's settle-seek uses) rather than fighting it.
  const reverseShuttleHandleRef = useRef<number | undefined>(undefined);
  const reverseShuttleVirtualTicksRef = useRef(0);
  const reverseShuttleLastTimeRef = useRef(0);

  // design/floating-chrome-changes.md's "5. Auto-hide behaviour": hovering either floating overlay
  // pins it, alongside a rail panel being open/pinned or the shortcut sheet being open (all three
  // of the latter already live in `state`).
  const [titleHovered, setTitleHovered] = useState(false);
  const [transportHovered, setTransportHovered] = useState(false);
  const suppressChromeHide = titleHovered || transportHovered || state.panel !== null || state.pinned !== null || state.shortcuts;
  const chromeVisible = useChromeVisibility(suppressChromeHide);

  function triggerOpen() {
    fileInputRef.current?.click();
  }

  // Computed here (rather than with the rest of the derived render values below) so the keydown
  // effect's 'export' case can guard on it without re-deriving screen logic inline.
  const hasFile = state.screen !== 'empty' && state.screen !== 'degraded';
  const canExport = hasFile && state.screen !== 'exporting' && state.screen !== 'finalising';

  // Kept fresh every render so the keydown handler below never closes over a stale tstart/tend/
  // currentSeconds -- without this, either the effect would need those in its deps (re-subscribing
  // on every playhead tick) or set-start/set-end would silently use whatever values were current
  // when the listener was first attached.
  const latestRef = useRef({
    tstart: state.tstart,
    tend: state.tend,
    currentSeconds: media.currentSeconds,
    durationSeconds: media.durationSeconds,
    sel: state.sel,
    tracks,
    sourceFileName,
    startExport: exportSession.startExport,
  });
  useEffect(() => {
    latestRef.current = {
      tstart: state.tstart,
      tend: state.tend,
      currentSeconds: media.currentSeconds,
      durationSeconds: media.durationSeconds,
      sel: state.sel,
      tracks,
      sourceFileName,
      startExport: exportSession.startExport,
    };
  });

  useEffect(() => {
    function stopReverseShuttle() {
      if (reverseShuttleHandleRef.current !== undefined) {
        cancelAnimationFrame(reverseShuttleHandleRef.current);
        reverseShuttleHandleRef.current = undefined;
      }
    }

    function reverseShuttleTick() {
      const engine = media.engineRef.current;
      const videoTrack = media.videoTrackRef.current;
      if (engine === null || videoTrack === null || shuttleRateRef.current >= 0) {
        stopReverseShuttle();
        return;
      }
      const now = performance.now();
      const dtSeconds = (now - reverseShuttleLastTimeRef.current) / 1000;
      reverseShuttleLastTimeRef.current = now;
      const deltaTicks = Math.abs(shuttleRateRef.current) * dtSeconds * videoTrack.timescale;
      reverseShuttleVirtualTicksRef.current = Math.max(0, reverseShuttleVirtualTicksRef.current - deltaTicks);
      timelineControllerRef.current.t = reverseShuttleVirtualTicksRef.current;
      void engine.seek(reverseShuttleVirtualTicksRef.current, 'accurate');
      reverseShuttleHandleRef.current = requestAnimationFrame(reverseShuttleTick);
    }

    function handleKeyDown(evt: KeyboardEvent) {
      const action = matchShortcut(evt);
      if (action === null) {
        return;
      }
      // undo has no real handler yet -- it needs Task 5/M5's command stack.
      switch (action) {
        case 'shuttle-back': {
          evt.preventDefault();
          const engine = media.engineRef.current;
          if (engine === null) return;
          const alreadyRunning = reverseShuttleHandleRef.current !== undefined;
          shuttleRateRef.current = nextShuttleRate(shuttleRateRef.current, -1);
          // <video>.playbackRate can't go negative in any browser, so L's native-rate approach
          // doesn't work for reverse -- see reverseShuttleTick's own comment above.
          engine.setPlaybackRate(1);
          if (!alreadyRunning) {
            engine.pause();
            reverseShuttleVirtualTicksRef.current = engine.currentTime;
            reverseShuttleLastTimeRef.current = performance.now();
            reverseShuttleHandleRef.current = requestAnimationFrame(reverseShuttleTick);
          }
          break;
        }
        case 'shuttle-forward': {
          evt.preventDefault();
          const engine = media.engineRef.current;
          if (engine === null) return;
          stopReverseShuttle();
          shuttleRateRef.current = nextShuttleRate(shuttleRateRef.current, 1);
          // Ahead of engine.play() below -- if that call synchronously fires onStateChange
          //('playing'), the mixers must already know they're at a non-1x rate so they don't start
          // only to be immediately paused again by this same hint a moment later.
          audioMix.setPlaybackRateHint(shuttleRateRef.current);
          engine.setPlaybackRate(shuttleRateRef.current);
          if (engine.state !== 'playing') engine.play();
          break;
        }
        case 'toggle-shortcuts':
          evt.preventDefault();
          dispatch({ type: 'shortcuts/toggle' });
          break;
        case 'toggle-fullscreen':
          evt.preventDefault();
          dispatch({ type: 'full/toggle' });
          break;
        case 'toggle-mute':
          evt.preventDefault();
          dispatch({ type: 'mute/toggle' });
          break;
        case 'volume-up':
          evt.preventDefault();
          dispatch({ type: 'volume/set', vol: Math.round((state.vol + 0.05) * 100) / 100 });
          break;
        case 'volume-down':
          evt.preventDefault();
          dispatch({ type: 'volume/set', vol: Math.round((state.vol - 0.05) * 100) / 100 });
          break;
        case 'export':
          evt.preventDefault();
          if (canExport) {
            const { tstart, tend, sel, tracks: latestTracks, sourceFileName: latestSourceFileName, startExport } = latestRef.current;
            void startExport({ tstart, tend, sel, tracks: latestTracks, sourceFileName: latestSourceFileName });
          }
          break;
        case 'open-file':
          evt.preventDefault();
          // fileInputRef is a stable ref object, so calling through it directly here (rather than
          // via the `triggerOpen` closure) keeps this out of the effect's dependency array.
          fileInputRef.current?.click();
          break;
        case 'play-pause':
          evt.preventDefault();
          togglePlay();
          break;
        case 'step-back-frame':
          evt.preventDefault();
          stepFrame(-1);
          break;
        case 'step-forward-frame':
          evt.preventDefault();
          stepFrame(1);
          break;
        case 'prev-keyframe':
          evt.preventDefault();
          jumpToKeyframe(-1);
          break;
        case 'next-keyframe':
          evt.preventDefault();
          jumpToKeyframe(1);
          break;
        case 'step-back-second':
          evt.preventDefault();
          seekToSeconds(Math.max(0, latestRef.current.currentSeconds - 1));
          break;
        case 'step-forward-second': {
          evt.preventDefault();
          const { currentSeconds, durationSeconds } = latestRef.current;
          const target = currentSeconds + 1;
          seekToSeconds(durationSeconds !== null ? Math.min(target, durationSeconds) : target);
          break;
        }
        case 'set-start': {
          evt.preventDefault();
          const videoTrack = media.videoTrackRef.current;
          if (videoTrack === null) break;
          const { tend } = latestRef.current;
          // Reads the timeline controller's live playhead ref rather than media.currentSeconds --
          // that React state lags behind a scrub (it only updates once the async settle-seek's
          // 'seeked' event lands, see TimelineController.ts's onPointerUp), so a quick scrub-then-I
          // would otherwise set the start point at the pre-scrub position.
          const currentSeconds = ticksToSeconds(timelineControllerRef.current.t, videoTrack.timescale);
          if (currentSeconds < tend) {
            dispatch({ type: 'start-end/set', tstart: currentSeconds, tend });
          }
          break;
        }
        case 'set-end': {
          evt.preventDefault();
          const videoTrack = media.videoTrackRef.current;
          if (videoTrack === null) break;
          const { tstart } = latestRef.current;
          const currentSeconds = ticksToSeconds(timelineControllerRef.current.t, videoTrack.timescale);
          if (currentSeconds > tstart) {
            dispatch({ type: 'start-end/set', tstart, tend: currentSeconds });
          }
          break;
        }
        case 'jump-to-start':
          evt.preventDefault();
          seekToSeconds(latestRef.current.tstart);
          break;
        case 'jump-to-end':
          evt.preventDefault();
          seekToSeconds(latestRef.current.tend);
          break;
        case 'clear-start':
          evt.preventDefault();
          dispatch({ type: 'start-end/set', tstart: 0, tend: latestRef.current.tend });
          break;
        case 'clear-end': {
          evt.preventDefault();
          const { tstart, durationSeconds } = latestRef.current;
          if (durationSeconds !== null) {
            dispatch({ type: 'start-end/set', tstart, tend: durationSeconds });
          }
          break;
        }
        case 'jump-start':
          evt.preventDefault();
          seekToSeconds(0);
          break;
        case 'jump-end':
          evt.preventDefault();
          if (latestRef.current.durationSeconds !== null) {
            seekToSeconds(latestRef.current.durationSeconds);
          }
          break;
        case 'zoom-in':
        case 'zoom-out': {
          evt.preventDefault();
          const videoTrack = media.videoTrackRef.current;
          const controller = timelineControllerRef.current;
          if (videoTrack?.video === undefined || controller.viewSpan <= 0) break;
          const ticksPerFrame = videoTrack.video.nominalFrameRate > 0 ? videoTrack.timescale / videoTrack.video.nominalFrameRate : 0;
          const factor = action === 'zoom-in' ? KEYBOARD_ZOOM_IN_FACTOR : 1 / KEYBOARD_ZOOM_IN_FACTOR;
          const zoomed = zoomAtPlayhead(
            { viewStart: controller.viewStart, viewSpan: controller.viewSpan, widthPx: controller.tlW },
            controller.t,
            factor,
            ticksPerFrame,
            videoTrack.duration,
          );
          controller.viewStart = zoomed.viewStart;
          controller.viewSpan = zoomed.viewSpan;
          controller.panVelocityTicksPerMs = 0;
          break;
        }
        case 'zoom-fit': {
          evt.preventDefault();
          const videoTrack = media.videoTrackRef.current;
          if (videoTrack === null) break;
          const fit = fitToDuration(videoTrack.duration);
          timelineControllerRef.current.viewStart = fit.viewStart;
          timelineControllerRef.current.viewSpan = fit.viewSpan;
          timelineControllerRef.current.panVelocityTicksPerMs = 0;
          break;
        }
        case 'close':
          evt.preventDefault();
          if (state.shortcuts) {
            dispatch({ type: 'shortcuts/toggle' });
          } else if (state.panel !== null) {
            dispatch({ type: 'panel/close' });
          } else if (state.full) {
            dispatch({ type: 'full/toggle' });
          }
          break;
        default:
          break;
      }
    }
    // J/L don't repeat via keydown's own evt.repeat forever without a release signal -- keyup is
    // the only place that knows the shuttle key stopped being held, so it's the only place that
    // can reset the rate and pause. matchShortcut has no keyup counterpart (it's keydown-chord
    // shaped), so this checks the raw key directly rather than routing through it.
    function handleKeyUp(evt: KeyboardEvent) {
      const key = evt.key.toLowerCase();
      if (key !== 'j' && key !== 'l') return;
      shuttleRateRef.current = 0;
      stopReverseShuttle();
      audioMix.setPlaybackRateHint(1);
      const engine = media.engineRef.current;
      if (engine === null) return;
      engine.setPlaybackRate(1);
      engine.pause();
    }
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      stopReverseShuttle();
    };
  }, [state.shortcuts, state.panel, state.full, state.vol, canExport, togglePlay, stepFrame, jumpToKeyframe, seekToSeconds, media.videoTrackRef, media.engineRef, timelineControllerRef, audioMix]);

  // Monitoring-only gain now lives in useAudioMix's own Effect C, driving the Web Audio mix's
  // master GainNode instead of the native <video> element directly -- see that hook's header
  // comment. design/volume-slider-prompt.md's "must not affect export output" constraint still
  // holds either way (export remuxes the source file directly, never touches this preview gain).

  const showChrome = !state.full;
  // Title bar, status bar, transport bar, splitter, and timeline all have nothing to report with
  // no file open -- design/empty-state-changes.md's "Top bar and status bar are hidden" section
  // (extended to the transport/timeline row per the design screenshot). The rail stays under
  // `showChrome` alone: it's the explanation surface for what the app is about to do. Fullscreen
  // (`state.full`) unmounts the timeline's canvas along with the rest of this chrome; the canvas
  // remount is handled by useTimelineController.ts, which rebuilds the TimelineController against
  // the fresh node instead of leaving it bound to the detached one.
  const showFileChrome = showChrome && state.screen !== 'empty';
  const timelineHeight = state.full ? Math.min(state.timelineH, FULLSCREEN_TIMELINE_CAP_PX) : state.timelineH;

  // Real once a file is open; otherwise the design fixture, used both by ui-harness.html's
  // variant switcher (which never opens a real file) and by App before anything is opened.
  // (tracks/sourceFileName themselves are computed earlier, alongside latestRef.)
  const fileName = media.file?.name ?? (hasFile ? FILE_NAME : null);
  const formatChip = media.formatChip ?? (hasFile ? FORMAT_CHIP : null);
  const sourceRows = media.sourceRows ?? SOURCE_PANEL_ROWS;
  // Real once a file's been opened (index/thumbs jobs) or an export has been attempted; otherwise
  // the design fixture -- same `media.X ?? fixtureX` pattern as sourceRows above.
  const exportJobStatus: ExportJobStatus | null =
    exportSession.job === null
      ? null
      : exportSession.job.status === 'running'
        ? { status: 'running', fileName: exportSession.job.fileName, percent: state.exportPct }
        : exportSession.job;
  const realJobsRows = deriveJobsRows(media.indexJob, media.thumbsJob, media.waveformJob, exportJobStatus);
  const jobsRows = realJobsRows.length > 0 ? realJobsRows : JOBS_PANEL_ROWS;
  const openErrorMessage = state.openError !== null ? formatIndexError(state.openError) : null;
  const exportErrorMessage = state.exportError !== null ? formatExportError(state.exportError) : null;

  // Cheap, no-I/O real estimate for the Export panel's "est. size" row -- null (falls back to an
  // illustrative formula) until a real file/index is open.
  const estimatedExportBytes = useMemo(() => {
    const sampleIndex = media.sampleIndexRef.current;
    if (sampleIndex === null) return null;
    const tracksRaw = sampleIndex.tracks();
    const selection = resolveExportSelection(sampleIndex, tracksRaw, selectedRealTrackIds(tracks, state.sel), state.tstart, state.tend);
    if ('error' in selection) return null;
    const tracksById = new Map(tracksRaw.map((t) => [t.trackId, t]));
    return estimateExportBytes(selection, tracksById);
    // media.sampleIndexRef is a stable ref object; its `.current` mutation always coincides with
    // one of these other deps changing (openFile dispatches sel/start-end right after setting it),
    // so it doesn't need to be listed itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.file, tracks, state.sel, state.tstart, state.tend]);

  const timecode = media.file !== null ? media.timecode : formatDurationCompact(PLAYHEAD_SECONDS);
  const frameLabel = media.file !== null ? media.frameLabel : formatFrameNumber(PLAYHEAD_SECONDS * FPS);
  const startTc = formatDurationCompact(state.tstart);
  const endTc = formatDurationCompact(state.tend);
  const durTc = formatDurationCompact(state.tend - state.tstart);

  function handleFileInputChange(evt: ChangeEvent<HTMLInputElement>) {
    const file = evt.target.files?.[0];
    evt.target.value = '';
    if (file !== undefined) {
      void media.openFile(file);
    }
  }

  const rightClearancePx = railClearancePx(state.pinned);

  return (
    <div className={styles.root}>
      <input
        ref={fileInputRef}
        type="file"
        accept={OPEN_FILE_ACCEPT}
        style={{ display: 'none' }}
        onChange={handleFileInputChange}
      />
      {showFileChrome && (
        <TitleBar
          fileName={fileName}
          formatChip={formatChip}
          permissionLost={state.permissionLost}
          canExport={canExport}
          onOpen={triggerOpen}
          onExport={() => {
            void exportSession.startExport({ tstart: state.tstart, tend: state.tend, sel: state.sel, tracks, sourceFileName });
          }}
          onReconnect={() => {
            dispatch({ type: 'permission-lost/set', lost: false });
          }}
          chromeVisible={chromeVisible}
          rightPx={rightClearancePx}
          onMouseEnter={() => {
            setTitleHovered(true);
          }}
          onMouseLeave={() => {
            setTitleHovered(false);
          }}
        />
      )}
      {showChrome && state.screen === 'degraded' && <DegradedStrip rightPx={rightClearancePx} />}

      <Stage
        screen={state.screen}
        showChrome={showChrome}
        panel={state.panel}
        pinned={state.pinned}
        shortcuts={state.shortcuts}
        tracks={tracks}
        sourceRows={sourceRows}
        jobsRows={jobsRows}
        sourceFileName={sourceFileName}
        sel={state.sel}
        tstart={state.tstart}
        tend={state.tend}
        estimatedExportBytes={estimatedExportBytes}
        frameLabel={frameLabel}
        timecode={timecode}
        openErrorMessage={openErrorMessage}
        unsupported={media.unsupported}
        videoRef={media.file !== null ? media.videoRef : undefined}
        scrubOverlayRef={media.file !== null ? scrubOverlayCanvasRef : undefined}
        onOpenFile={triggerOpen}
        onFileDrop={(file) => {
          void media.openFile(file);
        }}
        onOpenPanel={(panel) => {
          dispatch({ type: 'panel/open', panel });
        }}
        onClosePanel={() => {
          dispatch({ type: 'panel/close' });
        }}
        onPinPanel={(panel) => {
          dispatch({ type: 'panel/pin', panel });
        }}
        onUnpinPanel={() => {
          dispatch({ type: 'panel/unpin' });
        }}
        onToggleShortcuts={() => {
          dispatch({ type: 'shortcuts/toggle' });
        }}
        onToggleTrack={(track) => {
          dispatch({ type: 'track/toggle', track });
        }}
        overlay={
          (state.screen === 'exporting' || state.screen === 'finalising') && (
            <ExportOverlay
              percent={state.exportPct}
              phase={state.screen === 'finalising' ? 'finalising' : 'copy'}
              line={
                estimatedExportBytes !== null
                  ? formatExportProgressLine(state.exportPct, estimatedExportBytes)
                  : formatExportLine(state.exportPct)
              }
              onCancel={() => {
                exportSession.cancelExport();
              }}
            />
          )
        }
        toast={
          state.toast ? (
            <ExportToast
              durationLabel={exportSession.lastResult?.durationLabel ?? EXPORT_DURATION_LABEL}
              outPath={exportSession.lastResult?.outPath ?? EXPORT_OUT_PATH}
              onDismiss={() => {
                dispatch({ type: 'toast/set', show: false });
              }}
            />
          ) : (
            exportErrorMessage !== null && (
              <ExportErrorToast
                message={exportErrorMessage}
                onDismiss={() => {
                  dispatch({ type: 'export-error/set', error: null });
                }}
              />
            )
          )
        }
      />

      {showFileChrome && (
        <TransportBar
          timecode={timecode}
          timecodeRef={transportTimecodeRef}
          playing={media.playing}
          onTogglePlay={togglePlay}
          onStepBack={() => {
            stepFrame(-1);
          }}
          onStepForward={() => {
            stepFrame(1);
          }}
          onPrevKeyframe={() => {
            jumpToKeyframe(-1);
          }}
          onNextKeyframe={() => {
            jumpToKeyframe(1);
          }}
          startTc={startTc}
          endTc={endTc}
          durTc={durTc}
          trimMode={state.trimMode}
          exactAvailable={exactAvailable}
          onSetTrimMode={(mode) => {
            dispatch({ type: 'trim-mode/set', mode });
          }}
          vol={state.vol}
          muted={state.muted}
          onToggleMute={() => {
            dispatch({ type: 'mute/toggle' });
          }}
          onUnmute={() => {
            dispatch({ type: 'mute/set', muted: false });
          }}
          onSetVolume={(vol) => {
            dispatch({ type: 'volume/set', vol });
          }}
          chromeVisible={chromeVisible}
          bottomPx={transportPillBottomPx(timelineHeight)}
          onMouseEnter={() => {
            setTransportHovered(true);
          }}
          onMouseLeave={() => {
            setTransportHovered(false);
          }}
        />
      )}

      {showFileChrome && (
        <Splitter
          timelineHeight={state.timelineH}
          onResize={(height) => {
            dispatch({ type: 'timeline-height/set', height });
          }}
        />
      )}

      {showFileChrome && (
        <TimelineRegion
          heightPx={timelineHeight}
          indexing={state.screen === 'indexing' || state.screen === 'opening'}
          canvasRef={timelineCanvasRef}
          chipStartRef={chipStartRef}
          chipEndRef={chipEndRef}
        />
      )}

      {showFileChrome && (
        <NoticeChip
          notice={state.notice}
          noticeOpen={state.noticeOpen}
          onNoticeEnter={() => {
            dispatch({ type: 'notice/open-set', open: true });
          }}
          onNoticeLeave={() => {
            dispatch({ type: 'notice/open-set', open: false });
          }}
          onKeepExact={() => {
            // design/README.md: "Keep exact frame restores the user's original position and
            // switches the mode to exact." The pre-enforcement value is recoverable from the
            // notice itself: notice.at is the enforced (keyframe-snapped) seconds, notice.delta
            // is enforced-minus-original, so original = at - delta.
            if (state.notice !== null) {
              const restoredSeconds = state.notice.at - state.notice.delta;
              dispatch({
                type: 'start-end/set',
                tstart: state.notice.which === 'start' ? restoredSeconds : state.tstart,
                tend: state.notice.which === 'end' ? restoredSeconds : state.tend,
              });
            }
            dispatch({ type: 'notice/keep-exact' });
          }}
          onDismissNotice={() => {
            dispatch({ type: 'notice/set', notice: null });
          }}
          exactAvailable={exactAvailable}
          fps={FPS}
          rightPx={14}
          marginRightPx={rightClearancePx}
          bottomPx={transportPillBottomPx(timelineHeight)}
        />
      )}

      {state.shortcuts && (
        <KeyboardOverlay
          onClose={() => {
            dispatch({ type: 'shortcuts/toggle' });
          }}
        />
      )}
    </div>
  );
}
