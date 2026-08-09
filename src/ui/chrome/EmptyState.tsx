import { useState } from 'react';
import type { DragEvent, MouseEvent } from 'react';
import { FileDropIcon } from '../icons/index.tsx';
import { formatRecentWhen, loadRecentFiles } from '../state/recent-files.ts';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  onOpen: () => void;
  onFileDrop: (file: File) => void;
  errorMessage?: string | null;
}

export function EmptyState({ onOpen, onFileDrop, errorMessage }: EmptyStateProps) {
  const [dragActive, setDragActive] = useState(false);
  // Lazy-init only: EmptyState is conditionally rendered (screen === 'empty'), so it remounts --
  // and re-reads localStorage -- every time the empty screen reappears.
  const [recentFiles] = useState(() => loadRecentFiles());

  function handleDragOver(evt: DragEvent<HTMLDivElement>) {
    evt.preventDefault();
    setDragActive(true);
  }

  function handleDragLeave() {
    setDragActive(false);
  }

  function handleDrop(evt: DragEvent<HTMLDivElement>) {
    evt.preventDefault();
    setDragActive(false);
    if (evt.dataTransfer.files.length > 0) {
      onFileDrop(evt.dataTransfer.files[0]);
    }
  }

  function handleChooseFileClick(evt: MouseEvent<HTMLButtonElement>) {
    // The button sits inside the card, which is itself onClick={onOpen} -- stop the bubble so a
    // button click doesn't fire onOpen twice.
    evt.stopPropagation();
    onOpen();
  }

  return (
    <div className={styles.container}>
      <div
        className={dragActive ? `${styles.card} ${styles.cardDragActive}` : styles.card}
        onClick={onOpen}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className={styles.iconTile}>
          <FileDropIcon />
        </div>
        <div className={styles.title}>Drop a video file to start trimming</div>
        {errorMessage !== null && errorMessage !== undefined ? (
          <div className={styles.errorSubtitle}>{errorMessage}</div>
        ) : (
          <div className={styles.subtitle}>Nothing uploads — the file is read from disk in this tab.</div>
        )}
        <div className={styles.buttonRow}>
          <button type="button" className={styles.chooseButton} onClick={handleChooseFileClick}>
            Choose file
          </button>
          <span className={styles.chooseHint}>⌘O</span>
        </div>
      </div>

      {recentFiles.length > 0 && (
        <div className={styles.recent}>
          <div className={styles.recentHeader}>Recent</div>
          {recentFiles.map((entry) => (
            <div key={entry.name} className={styles.recentRow} onClick={onOpen}>
              <span className={styles.recentName}>{entry.name}</span>
              <span className={styles.recentWhen}>{formatRecentWhen(entry.openedAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
