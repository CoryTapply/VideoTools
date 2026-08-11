import { useEffect, useReducer, useRef } from 'react';
import styles from './App.module.css';
// Direct submodule import, not the barrel -- see state/app-state.ts's comment on why.
import { formatIndexError } from '../media/index/errors.ts';
import { DegradedStrip } from './chrome/DegradedStrip.tsx';
import { ExportOverlay } from './chrome/ExportOverlay.tsx';
import { ExportToast } from './chrome/ExportToast.tsx';
import { KeyboardOverlay } from './chrome/KeyboardOverlay.tsx';
import { Splitter } from './chrome/Splitter.tsx';
import { Stage } from './chrome/Stage.tsx';
import { StatusBar } from './chrome/StatusBar.tsx';
import { TimelineRegion } from './chrome/TimelineRegion.tsx';
import { TitleBar } from './chrome/TitleBar.tsx';
import { TransportBar } from './chrome/TransportBar.tsx';
import {
  DEFAULT_IN_SECONDS,
  DEFAULT_OUT_SECONDS,
  EXPORT_DURATION_LABEL,
  EXPORT_OUT_PATH,
  FILE_NAME,
  FORMAT_CHIP,
  FPS,
  INDEX_LABEL,
  PLAYHEAD_SECONDS,
  SOURCE_PANEL_ROWS,
  THUMB_LABEL,
  TRACKS,
  ZOOM_LABEL,
  formatExportLine,
} from './fixtures.ts';
import { matchShortcut } from './state/keyboard-map.ts';
import { useMediaSession } from './state/media-session.ts';
import { nextShuttleRate } from './state/shuttle.ts';
import { formatFrameNumber, formatTimecode } from './state/snap-notice.ts';
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

export function App({ initialState, exactAvailable = true }: AppProps) {
  const [state, dispatch] = useReducer(
    appReducer,
    initialState,
    (overrides) => createInitialAppState({ tin: DEFAULT_IN_SECONDS, tout: DEFAULT_OUT_SECONDS, ...overrides }),
  );
  const media = useMediaSession(dispatch);
  const { togglePlay, stepFrame, jumpToKeyframe, seekToSeconds } = media;
  const timelineControllerRef = useTimelineControllerRef();
  const { timelineCanvasRef, scrubOverlayCanvasRef, transportTimecodeRef } = useTimelineController(
    media,
    timelineControllerRef,
    dispatch,
    state.trimMode,
    state.tin,
    state.tout,
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

  function triggerOpen() {
    fileInputRef.current?.click();
  }

  // Computed here (rather than with the rest of the derived render values below) so the keydown
  // effect's 'export' case can guard on it without re-deriving screen logic inline.
  const hasFile = state.screen !== 'empty' && state.screen !== 'degraded';
  const canExport = hasFile && state.screen !== 'exporting' && state.screen !== 'finalising';

  // Kept fresh every render so the keydown handler below never closes over a stale tin/tout/
  // currentSeconds -- without this, either the effect would need those in its deps (re-subscribing
  // on every playhead tick) or set-in/set-out would silently use whatever values were current when
  // the listener was first attached.
  const latestRef = useRef({
    tin: state.tin,
    tout: state.tout,
    currentSeconds: media.currentSeconds,
    durationSeconds: media.durationSeconds,
  });
  useEffect(() => {
    latestRef.current = {
      tin: state.tin,
      tout: state.tout,
      currentSeconds: media.currentSeconds,
      durationSeconds: media.durationSeconds,
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
        case 'export':
          evt.preventDefault();
          if (canExport) {
            dispatch({ type: 'screen/set', screen: 'exporting' });
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
        case 'set-in': {
          evt.preventDefault();
          const { tout, currentSeconds } = latestRef.current;
          if (currentSeconds < tout) {
            dispatch({ type: 'in-out/set', tin: currentSeconds, tout });
          }
          break;
        }
        case 'set-out': {
          evt.preventDefault();
          const { tin, currentSeconds } = latestRef.current;
          if (currentSeconds > tin) {
            dispatch({ type: 'in-out/set', tin, tout: currentSeconds });
          }
          break;
        }
        case 'jump-to-in':
          evt.preventDefault();
          seekToSeconds(latestRef.current.tin);
          break;
        case 'jump-to-out':
          evt.preventDefault();
          seekToSeconds(latestRef.current.tout);
          break;
        case 'clear-in':
          evt.preventDefault();
          dispatch({ type: 'in-out/set', tin: 0, tout: latestRef.current.tout });
          break;
        case 'clear-out': {
          evt.preventDefault();
          const { tin, durationSeconds } = latestRef.current;
          if (durationSeconds !== null) {
            dispatch({ type: 'in-out/set', tin, tout: durationSeconds });
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
  }, [state.shortcuts, state.panel, state.full, canExport, togglePlay, stepFrame, jumpToKeyframe, seekToSeconds, media.videoTrackRef, media.engineRef, timelineControllerRef]);

  const showChrome = !state.full;
  // Title bar, status bar, transport bar, splitter, and timeline all have nothing to report with
  // no file open -- design/empty-state-changes.md's "Top bar and status bar are hidden" section
  // (extended to the transport/timeline row per the design screenshot). The rail stays under
  // `showChrome` alone: it's the explanation surface for what the app is about to do.
  const showFileChrome = showChrome && state.screen !== 'empty';
  const timelineHeight = state.full ? Math.min(state.timelineH, FULLSCREEN_TIMELINE_CAP_PX) : state.timelineH;
  const displayFps = media.fps ?? FPS;

  // Real once a file is open; otherwise the design fixture, used both by ui-harness.html's
  // variant switcher (which never opens a real file) and by App before anything is opened.
  const fileName = media.file?.name ?? (hasFile ? FILE_NAME : null);
  const formatChip = media.formatChip ?? (hasFile ? FORMAT_CHIP : null);
  const tracks = media.tracks ?? TRACKS;
  const sourceRows = media.sourceRows ?? SOURCE_PANEL_ROWS;
  const sourceFileName = media.file?.name ?? FILE_NAME;
  const openErrorMessage = state.openError !== null ? formatIndexError(state.openError) : null;

  const timecode = media.file !== null ? media.timecode : formatTimecode(PLAYHEAD_SECONDS * FPS, FPS);
  const frameLabel = media.file !== null ? media.frameLabel : formatFrameNumber(PLAYHEAD_SECONDS * FPS);
  const inTc = formatTimecode(state.tin * displayFps, displayFps);
  const outTc = formatTimecode(state.tout * displayFps, displayFps);
  const durTc = formatTimecode((state.tout - state.tin) * displayFps, displayFps);

  function handleFileInputChange(evt: ChangeEvent<HTMLInputElement>) {
    const file = evt.target.files?.[0];
    evt.target.value = '';
    if (file !== undefined) {
      void media.openFile(file);
    }
  }

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
            dispatch({ type: 'screen/set', screen: 'exporting' });
          }}
          onReconnect={() => {
            dispatch({ type: 'permission-lost/set', lost: false });
          }}
        />
      )}
      {showChrome && state.screen === 'degraded' && <DegradedStrip />}

      <Stage
        screen={state.screen}
        showChrome={showChrome}
        panel={state.panel}
        pinned={state.pinned}
        shortcuts={state.shortcuts}
        tracks={tracks}
        sourceRows={sourceRows}
        sourceFileName={sourceFileName}
        sel={state.sel}
        tin={state.tin}
        tout={state.tout}
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
              line={formatExportLine(state.exportPct)}
              onCancel={() => {
                dispatch({ type: 'screen/set', screen: 'ready' });
              }}
            />
          )
        }
        toast={
          state.toast && (
            <ExportToast
              durationLabel={EXPORT_DURATION_LABEL}
              outPath={EXPORT_OUT_PATH}
              onShowInFolder={() => {}}
              onTrimAnother={() => {
                dispatch({ type: 'toast/set', show: false });
              }}
            />
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
          inTc={inTc}
          outTc={outTc}
          durTc={durTc}
          trimMode={state.trimMode}
          exactAvailable={exactAvailable}
          onSetTrimMode={(mode) => {
            dispatch({ type: 'trim-mode/set', mode });
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
        />
      )}

      {showFileChrome && (
        <StatusBar
          zoomLabel={ZOOM_LABEL}
          thumbLabel={THUMB_LABEL}
          indexLabel={INDEX_LABEL}
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
                type: 'in-out/set',
                tin: state.notice.which === 'in' ? restoredSeconds : state.tin,
                tout: state.notice.which === 'out' ? restoredSeconds : state.tout,
              });
            }
            dispatch({ type: 'notice/keep-exact' });
          }}
          onDismissNotice={() => {
            dispatch({ type: 'notice/set', notice: null });
          }}
          exactAvailable={exactAvailable}
          fps={FPS}
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
