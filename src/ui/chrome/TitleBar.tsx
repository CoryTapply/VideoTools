import styles from './TitleBar.module.css';

export interface TitleBarProps {
  fileName: string | null;
  formatChip: string | null;
  permissionLost: boolean;
  canExport: boolean;
  onOpen: () => void;
  onExport: () => void;
  onReconnect: () => void;
}

export function TitleBar({ fileName, formatChip, permissionLost, canExport, onOpen, onExport, onReconnect }: TitleBarProps) {
  return (
    <div className={styles.root}>
      <div className={styles.identity}>
        <div className={styles.dot} />
        <div className={styles.fileName}>{fileName ?? 'No file open'}</div>
      </div>
      {formatChip !== null && <div className={styles.formatChip}>{formatChip}</div>}
      {permissionLost && (
        <div className={styles.reconnectPill}>
          <span>Reconnect file — access to this file was lost</span>
          <button type="button" className={styles.reconnectButton} onClick={onReconnect}>
            Reconnect
          </button>
        </div>
      )}
      <div className={styles.spacer} />
      <button type="button" className={styles.openButton} onClick={onOpen}>
        Open
      </button>
      <button type="button" className={styles.exportButton} onClick={onExport} disabled={!canExport}>
        <span>Export clip</span>
        <span className={styles.exportHint}>⌘E</span>
      </button>
    </div>
  );
}
