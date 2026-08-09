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
import { formatFrameNumber, formatTimecode } from './state/snap-notice.ts';
import { appReducer, createInitialAppState } from './state/app-state.ts';
import type { ChangeEvent } from 'react';
import type { AppState } from './state/app-state.ts';

export interface AppProps {
  initialState?: Partial<AppState>;
  exactAvailable?: boolean;
}

const FULLSCREEN_TIMELINE_CAP_PX = 140;
const OPEN_FILE_ACCEPT = 'video/mp4,video/quicktime,.mp4,.mov';

export function App({ initialState, exactAvailable = true }: AppProps) {
  const [state, dispatch] = useReducer(
    appReducer,
    initialState,
    (overrides) => createInitialAppState({ tin: DEFAULT_IN_SECONDS, tout: DEFAULT_OUT_SECONDS, ...overrides }),
  );
  const media = useMediaSession(dispatch);
  const { togglePlay, stepFrame, jumpToKeyframe, seekToSeconds } = media;
  const fileInputRef = useRef<HTMLInputElement>(null);

  function triggerOpen() {
    fileInputRef.current?.click();
  }

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
    function handleKeyDown(evt: KeyboardEvent) {
      const action = matchShortcut(evt);
      if (action === null) {
        return;
      }
      // shuttle, clear-in/out, zoom/zoom-fit, jump-start/end, and undo have no real handler yet --
      // they need the timeline (Task 4b) or export (Task 5).
      switch (action) {
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
          dispatch({ type: 'screen/set', screen: 'exporting' });
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
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [state.shortcuts, state.panel, state.full, togglePlay, stepFrame, jumpToKeyframe, seekToSeconds]);

  const hasFile = state.screen !== 'empty' && state.screen !== 'degraded';
  const canExport = hasFile && state.screen !== 'exporting' && state.screen !== 'finalising';
  const showChrome = !state.full;
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
      {showChrome && (
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

      <TransportBar
        timecode={timecode}
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

      <Splitter
        timelineHeight={state.timelineH}
        onResize={(height) => {
          dispatch({ type: 'timeline-height/set', height });
        }}
      />

      <TimelineRegion heightPx={timelineHeight} indexing={state.screen === 'indexing' || state.screen === 'opening'} />

      {showChrome && (
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
