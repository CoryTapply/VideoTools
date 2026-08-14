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
  /** Cache-only drag-scrub preview -- design/README.md: "the preview shows the nearest cached
   * filmstrip tile" while dragging, since a real <video> seek is 281ms p50, 17x too slow for 60Hz.
   * Task 4b's TimelineController draws onto this canvas only while scrubActive; otherwise it's
   * cleared so the real <video> shows through. See state/useTimelineController.ts. */
  scrubOverlayRef?: RefObject<HTMLCanvasElement | null>;
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
  scrubOverlayRef,
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
          {videoRef !== undefined && <canvas ref={scrubOverlayRef} className={styles.scrubOverlay} />}
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
