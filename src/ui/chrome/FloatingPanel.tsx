import { useEffect, useRef } from 'react';
import { PinIcon } from '../icons/index.tsx';
import { PanelTimers } from '../state/panel-timers.ts';
import { rowHeight } from '../tokens.ts';
import styles from './FloatingPanel.module.css';
import type { ReactNode } from 'react';

export interface FloatingPanelProps {
  title: string;
  onPin: () => void;
  onClose: () => void;
  children: ReactNode;
}

/** Closes 220ms after the pointer leaves, cancelled on re-entry -- design/README.md's Panels section. */
export function FloatingPanel({ title, onPin, onClose, children }: FloatingPanelProps) {
  const timers = useRef(new PanelTimers());

  useEffect(() => {
    const timersAtMount = timers.current;
    return () => {
      timersAtMount.dispose();
    };
  }, []);

  return (
    <div
      className={styles.root}
      style={{ width: rowHeight.floatingPanel }}
      onMouseEnter={() => {
        timers.current.cancelClose();
      }}
      onMouseLeave={() => {
        timers.current.scheduleClose(onClose);
      }}
    >
      <div className={styles.header}>
        <span className={styles.title}>{title}</span>
        <button type="button" className={styles.pinButton} title="Pin panel" onClick={onPin}>
          <PinIcon />
        </button>
      </div>
      {children}
    </div>
  );
}
