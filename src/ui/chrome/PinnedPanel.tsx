import { PinIcon } from '../icons/index.tsx';
import { rowHeight } from '../tokens.ts';
import styles from './PinnedPanel.module.css';
import type { ReactNode } from 'react';

export interface PinnedPanelProps {
  title: string;
  onUnpin: () => void;
  children: ReactNode;
}

export function PinnedPanel({ title, onUnpin, children }: PinnedPanelProps) {
  return (
    <div className={styles.root} style={{ flexBasis: rowHeight.pinnedPanel }}>
      <div className={styles.header}>
        <span className={styles.title}>{title}</span>
        <button type="button" className={styles.unpinButton} title="Unpin" onClick={onUnpin}>
          <PinIcon />
        </button>
      </div>
      <div className={styles.bodyWrapper}>{children}</div>
    </div>
  );
}
