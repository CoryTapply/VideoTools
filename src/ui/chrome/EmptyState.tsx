import { useState } from 'react';
import type { DragEvent } from 'react';
import { FileDropIcon } from '../icons/index.tsx';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  onOpen: () => void;
  onFileDrop: (file: File) => void;
  errorMessage?: string | null;
}

export function EmptyState({ onOpen, onFileDrop, errorMessage }: EmptyStateProps) {
  const [dragActive, setDragActive] = useState(false);

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

  return (
    <div
      className={dragActive ? `${styles.root} ${styles.rootDragActive}` : styles.root}
      onClick={onOpen}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className={styles.iconTile}>
        <FileDropIcon />
      </div>
      <div className={styles.title}>Drop an MP4 or MOV file, or open one</div>
      {errorMessage !== null && errorMessage !== undefined ? (
        <div className={styles.errorSubtitle}>{errorMessage}</div>
      ) : (
        <div className={styles.subtitle}>Files stay on your machine. 20 GB and up is fine.</div>
      )}
    </div>
  );
}
