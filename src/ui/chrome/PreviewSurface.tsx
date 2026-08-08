import { EmptyState } from './EmptyState.tsx';
import { UnsupportedState } from './UnsupportedState.tsx';
import styles from './PreviewSurface.module.css';
import type { ReactNode } from 'react';

export interface PreviewSurfaceProps {
  screen: 'empty' | 'unsupported' | 'has-video';
  frameLabel: string;
  timecode: string;
  onOpen: () => void;
  /** Export overlay/toast, positioned absolutely inside this surface -- see chrome/Stage.tsx. */
  children?: ReactNode;
}

export function PreviewSurface({ screen, frameLabel, timecode, onOpen, children }: PreviewSurfaceProps) {
  return (
    <div className={styles.root}>
      {screen === 'empty' && <EmptyState onOpen={onOpen} />}
      {screen === 'unsupported' && <UnsupportedState />}
      {screen === 'has-video' && (
        <div className={styles.videoBox}>
          <div className={styles.placeholderTexture} />
          <div className={styles.stageLabel}>decoded frame</div>
          <div className={styles.frameOverlay}>
            <span>{frameLabel}</span>
            <span>{timecode}</span>
          </div>
        </div>
      )}
      {children}
    </div>
  );
}
