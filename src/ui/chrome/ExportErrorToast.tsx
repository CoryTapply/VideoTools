import styles from './ExportErrorToast.module.css';

export interface ExportErrorToastProps {
  message: string;
  onDismiss: () => void;
}

export function ExportErrorToast({ message, onDismiss }: ExportErrorToastProps) {
  return (
    <div className={styles.root}>
      <div className={styles.headerRow}>
        <span className={styles.dot} />
        <span>Export failed</span>
      </div>
      <div className={styles.message}>{message}</div>
      <div className={styles.actions}>
        <button type="button" className={styles.dismissButton} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
