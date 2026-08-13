import styles from './ExportToast.module.css';

export interface ExportToastProps {
  durationLabel: string;
  outPath: string;
  onDismiss: () => void;
}

export function ExportToast({ durationLabel, outPath, onDismiss }: ExportToastProps) {
  return (
    <div className={styles.root} onClick={onDismiss} role="button" tabIndex={0}>
      <div className={styles.headerRow}>
        <span className={styles.dot} />
        <span>Clip exported — {durationLabel}</span>
      </div>
      <div className={styles.path}>{outPath}</div>
    </div>
  );
}
