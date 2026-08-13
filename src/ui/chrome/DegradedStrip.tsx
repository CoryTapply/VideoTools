import styles from './DegradedStrip.module.css';

export interface DegradedStripProps {
  /** Distance from the preview area's right edge, matching TitleBar's own rightPx -- see
   * chrome/floating-offsets.ts. Not part of design/floating-chrome-changes.md (it doesn't mention
   * this strip), but the title bar becoming a floating, z-indexed scrim would otherwise paint over
   * this row if it stayed an in-flow column item, so it floats too, directly below the title bar. */
  rightPx: number;
}

/** Only rendered when `screen === 'degraded'` -- see ../README.md's state-table reconciliation. */
export function DegradedStrip({ rightPx }: DegradedStripProps) {
  return (
    <div className={styles.root} style={{ right: rightPx }}>
      Saves via download — capped at 2 GB in this browser
    </div>
  );
}
