import { NextKeyframeIcon, PauseIcon, PlayIcon, PrevKeyframeIcon, StepBackIcon, StepForwardIcon } from '../icons/index.tsx';
import { VolumeControl } from './VolumeControl.tsx';
import styles from './TransportBar.module.css';
import type { RefObject } from 'react';
import type { TrimMode } from '../state/app-state.ts';

export interface TransportBarProps {
  /**
   * The harness/initial fallback value -- state/useTimelineController.ts's TimelineController
   * overwrites `timecodeRef`'s textContent directly from its rAF loop once a real file is open
   * (design/README.md's transport-bar spec), bypassing React so playhead movement never
   * re-renders. `timecode` stays the only source in ui-harness.html, which never opens a file.
   */
  timecode: string;
  timecodeRef?: RefObject<HTMLDivElement | null>;
  playing: boolean;
  onTogglePlay: () => void;
  onStepBack: () => void;
  onStepForward: () => void;
  onPrevKeyframe: () => void;
  onNextKeyframe: () => void;
  inTc: string;
  outTc: string;
  durTc: string;
  trimMode: TrimMode;
  exactAvailable: boolean;
  onSetTrimMode: (mode: TrimMode) => void;
  vol: number;
  muted: boolean;
  onToggleMute: () => void;
  onUnmute: () => void;
  onSetVolume: (vol: number) => void;
  /** design/floating-chrome-changes.md's "5. Auto-hide behaviour". Defaults true so existing
   * callers/tests that don't pass it still render fully visible. */
  chromeVisible?: boolean;
  /** Distance from the timeline's live top edge -- 14px above the splitter. See
   * chrome/floating-offsets.ts. */
  bottomPx: number;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export function TransportBar({
  timecode,
  timecodeRef,
  playing,
  onTogglePlay,
  onStepBack,
  onStepForward,
  onPrevKeyframe,
  onNextKeyframe,
  inTc,
  outTc,
  durTc,
  trimMode,
  exactAvailable,
  onSetTrimMode,
  vol,
  muted,
  onToggleMute,
  onUnmute,
  onSetVolume,
  chromeVisible = true,
  bottomPx,
  onMouseEnter,
  onMouseLeave,
}: TransportBarProps) {
  return (
    <div
      className={chromeVisible ? styles.root : `${styles.root} ${styles.hidden}`}
      style={{ bottom: bottomPx }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div ref={timecodeRef} className={styles.timecode}>
        {timecode}
      </div>
      <div className={styles.buttons}>
        <button type="button" className={styles.button} title="Previous keyframe (↑)" onClick={onPrevKeyframe}>
          <PrevKeyframeIcon />
        </button>
        <button type="button" className={styles.button} title="Step back (←)" onClick={onStepBack}>
          <StepBackIcon />
        </button>
        <button
          type="button"
          className={playing ? `${styles.button} ${styles.buttonActive}` : styles.button}
          title="Play · pause (Space)"
          onClick={onTogglePlay}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button type="button" className={styles.button} title="Step forward (→)" onClick={onStepForward}>
          <StepForwardIcon />
        </button>
        <button type="button" className={styles.button} title="Next keyframe (↓)" onClick={onNextKeyframe}>
          <NextKeyframeIcon />
        </button>
      </div>
      <VolumeControl vol={vol} muted={muted} onToggleMute={onToggleMute} onUnmute={onUnmute} onSetVolume={onSetVolume} />
      <div className={styles.readouts}>
        <div className={styles.readout}>
          <span className={styles.readoutLabel}>in</span>
          <span className={styles.readoutValueAccent}>{inTc}</span>
        </div>
        <div className={styles.readout}>
          <span className={styles.readoutLabel}>out</span>
          <span className={styles.readoutValueAccent}>{outTc}</span>
        </div>
        <div className={styles.readout}>
          <span className={styles.readoutLabel}>dur</span>
          <span className={styles.readoutValue}>{durTc}</span>
        </div>
      </div>
      <div className={styles.trimGroup}>
        <span className={styles.trimLabel}>trim</span>
        <div className={styles.segmented}>
          <button
            type="button"
            className={trimMode === 'copy' ? `${styles.segment} ${styles.segmentActive}` : styles.segment}
            onClick={() => {
              onSetTrimMode('copy');
            }}
          >
            copy
          </button>
          <button
            type="button"
            className={
              !exactAvailable
                ? `${styles.segment} ${styles.segmentDisabled}`
                : trimMode === 'exact'
                  ? `${styles.segment} ${styles.segmentActive}`
                  : styles.segment
            }
            disabled={!exactAvailable}
            title={
              exactAvailable
                ? 'Re-encode the head of the clip for a frame-exact cut'
                : 'Frame-exact trim ships in a later release'
            }
            onClick={() => {
              onSetTrimMode('exact');
            }}
          >
            exact
          </button>
        </div>
      </div>
    </div>
  );
}
