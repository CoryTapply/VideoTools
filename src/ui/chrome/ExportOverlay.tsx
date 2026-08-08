import styles from './ExportOverlay.module.css';

export interface ExportOverlayProps {
  percent: number;
  /** design/README.md: "swap the status line to `finalising…`... throughput and ETA dropped." */
  phase: 'copy' | 'finalising';
  line: string;
  onCancel: () => void;
}

export function ExportOverlay({ percent, phase, line, onCancel }: ExportOverlayProps) {
  return (
    <div className={styles.root}>
      <div className={styles.track}>
        <div className={styles.fill} style={{ width: `${percent.toString()}%` }} />
      </div>
      <div className={styles.line}>{phase === 'finalising' ? 'finalising…' : line}</div>
      <button type="button" className={styles.cancelButton} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
