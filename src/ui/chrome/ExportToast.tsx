import styles from './ExportToast.module.css';

export interface ExportToastProps {
  durationLabel: string;
  outPath: string;
  onShowInFolder: () => void;
  onTrimAnother: () => void;
}

export function ExportToast({ durationLabel, outPath, onShowInFolder, onTrimAnother }: ExportToastProps) {
  return (
    <div className={styles.root}>
      <div className={styles.headerRow}>
        <span className={styles.dot} />
        <span>Clip exported — {durationLabel}</span>
      </div>
      <div className={styles.path}>{outPath}</div>
      <div className={styles.actions}>
        <button type="button" className={styles.showButton} onClick={onShowInFolder}>
          Show in folder
        </button>
        <button type="button" className={styles.trimAnotherButton} onClick={onTrimAnother}>
          Trim another range
        </button>
      </div>
    </div>
  );
}
