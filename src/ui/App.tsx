import { useEffect, useReducer } from 'react';
import styles from './App.module.css';
import { DegradedStrip } from './chrome/DegradedStrip.tsx';
import { Splitter } from './chrome/Splitter.tsx';
import { StatusBar } from './chrome/StatusBar.tsx';
import { TimelineRegion } from './chrome/TimelineRegion.tsx';
import { TitleBar } from './chrome/TitleBar.tsx';
import { TransportBar } from './chrome/TransportBar.tsx';
import { DEFAULT_IN_SECONDS, DEFAULT_OUT_SECONDS, FILE_NAME, FORMAT_CHIP, FPS, INDEX_LABEL, PLAYHEAD_SECONDS, THUMB_LABEL, ZOOM_LABEL } from './fixtures.ts';
import { matchShortcut } from './state/keyboard-map.ts';
import { formatTimecode } from './state/snap-notice.ts';
import { appReducer, createInitialAppState } from './state/app-state.ts';
import type { AppState } from './state/app-state.ts';

export interface AppProps {
  initialState?: Partial<AppState>;
  exactAvailable?: boolean;
}

const FULLSCREEN_TIMELINE_CAP_PX = 140;

export function App({ initialState, exactAvailable = true }: AppProps) {
  const [state, dispatch] = useReducer(
    appReducer,
    initialState,
    (overrides) => createInitialAppState({ tin: DEFAULT_IN_SECONDS, tout: DEFAULT_OUT_SECONDS, ...overrides }),
  );

  useEffect(() => {
    function handleKeyDown(evt: KeyboardEvent) {
      const action = matchShortcut(evt);
      if (action === null) {
        return;
      }
      // Only the shell-level actions have a real handler this task -- playback stepping, zoom,
      // in/out, keyframe nav, and undo are matched but wait on later tasks' state to act on.
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
  }, [state.shortcuts, state.panel, state.full]);

  const hasFile = state.screen !== 'empty' && state.screen !== 'degraded';
  const canExport = hasFile && state.screen !== 'exporting' && state.screen !== 'finalising';
  const showChrome = !state.full;
  const timelineHeight = state.full ? Math.min(state.timelineH, FULLSCREEN_TIMELINE_CAP_PX) : state.timelineH;

  const timecode = formatTimecode(PLAYHEAD_SECONDS * FPS, FPS);
  const inTc = formatTimecode(state.tin * FPS, FPS);
  const outTc = formatTimecode(state.tout * FPS, FPS);
  const durTc = formatTimecode((state.tout - state.tin) * FPS, FPS);

  return (
    <div className={styles.root}>
      {showChrome && (
        <TitleBar
          fileName={hasFile ? FILE_NAME : null}
          formatChip={hasFile ? FORMAT_CHIP : null}
          permissionLost={state.permissionLost}
          canExport={canExport}
          onOpen={() => {
            dispatch({ type: 'screen/set', screen: 'opening' });
          }}
          onExport={() => {
            dispatch({ type: 'screen/set', screen: 'exporting' });
          }}
          onReconnect={() => {
            dispatch({ type: 'permission-lost/set', lost: false });
          }}
        />
      )}
      {showChrome && state.screen === 'degraded' && <DegradedStrip />}

      <div className={styles.stage} />

      <TransportBar
        timecode={timecode}
        playing={false}
        onTogglePlay={() => {}}
        onStepBack={() => {}}
        onStepForward={() => {}}
        onPrevKeyframe={() => {}}
        onNextKeyframe={() => {}}
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
    </div>
  );
}
