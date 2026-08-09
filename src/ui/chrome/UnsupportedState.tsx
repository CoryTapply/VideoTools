import styles from './UnsupportedState.module.css';

export interface UnsupportedStateProps {
  message?: string;
  codec?: string;
  resolution?: string;
  fps?: string;
}

const DEFAULT_MESSAGE = "This file's codec can't be previewed in your browser, but it can still be trimmed.";

export function UnsupportedState({ message = DEFAULT_MESSAGE, codec = 'hevc / Main 10', resolution = '3840 × 2160', fps = '59.94 fps' }: UnsupportedStateProps) {
  return (
    <div className={styles.root}>
      <div className={styles.headline}>{message}</div>
      <div className={styles.body}>
        The container index, keyframe map and waveform all read normally — set in and out on the timeline and export with
        stream copy.
      </div>
      <div className={styles.facts}>
        <span>{codec}</span>
        <span>{resolution}</span>
        <span>{fps}</span>
      </div>
    </div>
  );
}
