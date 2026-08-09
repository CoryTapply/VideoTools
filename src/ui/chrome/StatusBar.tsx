import { WarningTriangleIcon } from '../icons/index.tsx';
import { formatKeyframeShiftMessage, formatNoticeDelta, formatNoticeLabel, formatTimecode } from '../state/snap-notice.ts';
import styles from './StatusBar.module.css';
import type { KeyframeShiftNotice } from '../state/app-state.ts';

export interface StatusBarProps {
  zoomLabel: string;
  thumbLabel: string;
  indexLabel: string;
  notice: KeyframeShiftNotice | null;
  noticeOpen: boolean;
  onNoticeEnter: () => void;
  onNoticeLeave: () => void;
  onKeepExact: () => void;
  onDismissNotice: () => void;
  exactAvailable: boolean;
  fps: number;
}

export function StatusBar({
  zoomLabel,
  thumbLabel,
  indexLabel,
  notice,
  noticeOpen,
  onNoticeEnter,
  onNoticeLeave,
  onKeepExact,
  onDismissNotice,
  exactAvailable,
  fps,
}: StatusBarProps) {
  const timecode = notice !== null ? formatTimecode(notice.at * fps, fps) : '';

  return (
    <div className={styles.root}>
      <span>{zoomLabel}</span>
      <span>{thumbLabel}</span>
      <span>{indexLabel}</span>
      <div className={styles.spacer} />
      {notice !== null && (
        <div className={styles.noticePill} onMouseEnter={onNoticeEnter} onMouseLeave={onNoticeLeave}>
          <WarningTriangleIcon />
          <span className={styles.noticeLabel}>{formatNoticeLabel(notice.which)}</span>
          <span className={styles.noticeDelta}>{formatNoticeDelta(notice.delta)}</span>
          {noticeOpen && (
            <div className={styles.popover}>
              <div className={styles.popoverBody}>{formatKeyframeShiftMessage(notice.which, notice.delta, timecode)}</div>
              <div className={styles.popoverActions}>
                {exactAvailable && (
                  <button type="button" className={styles.keepExactButton} onClick={onKeepExact}>
                    Keep exact frame
                  </button>
                )}
                <button type="button" className={styles.dismissButton} onClick={onDismissNotice}>
                  Dismiss
                </button>
              </div>
              {exactAvailable && <div className={styles.popoverFootnote}>Re-encodes ~4 s at the head of the clip.</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
