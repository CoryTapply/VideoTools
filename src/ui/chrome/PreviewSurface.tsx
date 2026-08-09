import { EmptyState } from './EmptyState.tsx';
import { UnsupportedState } from './UnsupportedState.tsx';
import styles from './PreviewSurface.module.css';
import type { ReactNode, RefObject } from 'react';
import type { UnsupportedInfo } from '../state/media-session.ts';

export interface PreviewSurfaceProps {
  screen: 'empty' | 'unsupported' | 'has-video';
  frameLabel: string;
  timecode: string;
  onOpen: () => void;
  onFileDrop: (file: File) => void;
  openErrorMessage?: string | null;
  unsupported?: UnsupportedInfo | null;
  /** When provided, a real <video> is mounted instead of the placeholder texture -- see App.tsx. */
  videoRef?: RefObject<HTMLVideoElement | null>;
  /** Export overlay/toast, positioned absolutely inside this surface -- see chrome/Stage.tsx. */
  children?: ReactNode;
}

export function PreviewSurface({
  screen,
  frameLabel,
  timecode,
  onOpen,
  onFileDrop,
  openErrorMessage,
  unsupported,
  videoRef,
  children,
}: PreviewSurfaceProps) {
  return (
    <div className={styles.root}>
      {screen === 'empty' && <EmptyState onOpen={onOpen} onFileDrop={onFileDrop} errorMessage={openErrorMessage} />}
      {screen === 'unsupported' && (
        <UnsupportedState
          message={unsupported?.message}
          codec={unsupported?.codec}
          resolution={unsupported?.resolution}
          fps={unsupported?.fps}
        />
      )}
      {screen === 'has-video' && (
        <div className={styles.videoBox}>
          {videoRef !== undefined ? (
            <video ref={videoRef} className={styles.video} playsInline />
          ) : (
            <>
              <div className={styles.placeholderTexture} />
              <div className={styles.stageLabel}>decoded frame</div>
            </>
          )}
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
