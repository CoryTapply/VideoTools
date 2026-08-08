import { KEY_ROWS } from '../fixtures.ts';
import styles from './KeyboardOverlay.module.css';

export function KeyboardOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className={styles.scrim} onClick={onClose}>
      <div className={styles.card}>
        <div className={styles.header}>
          <span className={styles.title}>Keyboard</span>
          <span className={styles.escHint}>Esc to close</span>
        </div>
        <div className={styles.grid}>
          {KEY_ROWS.map((row) => (
            <div key={row.chord} className={styles.row}>
              <span className={styles.chord}>{row.chord}</span>
              <span className={styles.description}>{row.description}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
