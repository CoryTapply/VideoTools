import styles from './DegradedStrip.module.css';

/** Only rendered when `screen === 'degraded'` -- see ../README.md's state-table reconciliation. */
export function DegradedStrip() {
  return <div className={styles.root}>Saves via download — capped at 2 GB in this browser</div>;
}
