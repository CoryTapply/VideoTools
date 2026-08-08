import styles from './UnsupportedState.module.css';

export function UnsupportedState() {
  return (
    <div className={styles.root}>
      <div className={styles.headline}>This file's codec can't be previewed in your browser, but it can still be trimmed.</div>
      <div className={styles.body}>
        The container index, keyframe map and waveform all read normally — set in and out on the timeline and export with
        stream copy. Preview needs a browser build with HEVC decode.
      </div>
      <div className={styles.facts}>
        <span>hevc / Main 10</span>
        <span>3840 × 2160</span>
        <span>59.94 fps</span>
      </div>
    </div>
  );
}
