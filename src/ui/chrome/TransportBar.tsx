import { NextKeyframeIcon, PauseIcon, PlayIcon, PrevKeyframeIcon, StepBackIcon, StepForwardIcon } from '../icons/index.tsx';
import styles from './TransportBar.module.css';
import type { TrimMode } from '../state/app-state.ts';

export interface TransportBarProps {
  /**
   * Static for now -- design/README.md's transport-bar spec has this written directly to the DOM
   * from the 4b rAF loop, bypassing React. 4a just reserves the slot.
   */
  timecode: string;
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
}

export function TransportBar({
  timecode,
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
}: TransportBarProps) {
  return (
    <div className={styles.root}>
      <div className={styles.timecode}>{timecode}</div>
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
      <div className={styles.spacer} />
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
