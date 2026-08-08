import styles from './TimelineRegion.module.css';

export interface TimelineRegionProps {
  heightPx: number;
  /** True while `screen` is 'indexing' or 'opening' -- see design/README.md's Indexing state. */
  indexing: boolean;
}

/**
 * Placeholder only -- correctly-sized rows (ruler / keyframe row / filmstrip, no waveform row per
 * the M1 default) with no drawing. The canvas layer stack, viewport math, and drag-scrub are Task
 * 4b's job; this component exists so the shell reserves the right space at the right height.
 */
export function TimelineRegion({ heightPx, indexing }: TimelineRegionProps) {
  return (
    <div className={styles.root} style={{ flex: `0 0 ${heightPx.toString()}px`, height: heightPx }}>
      <div className={styles.ruler} />
      <div className={styles.keyframes} />
      <div className={styles.filmstrip}>{indexing && <div className={styles.indexingOverlay} />}</div>
    </div>
  );
}
