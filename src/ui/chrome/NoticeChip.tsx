import { WarningTriangleIcon } from '../icons/index.tsx';
import { formatKeyframeShiftMessage, formatNoticeDelta, formatNoticeLabel, formatTimecode } from '../state/snap-notice.ts';
import styles from './NoticeChip.module.css';
import type { KeyframeShiftNotice } from '../state/app-state.ts';

export interface NoticeChipProps {
  notice: KeyframeShiftNotice | null;
  noticeOpen: boolean;
  onNoticeEnter: () => void;
  onNoticeLeave: () => void;
  onKeepExact: () => void;
  onDismissNotice: () => void;
  exactAvailable: boolean;
  fps: number;
  /** Distance from the preview area's right edge -- clears the icon rail, plus a pinned panel's
   * width when one is docked. See chrome/floating-offsets.ts. */
  rightPx: number;
  marginRightPx: number;
  /** Distance from the timeline's live top edge -- the same value passed to TransportBar's own
   * bottomPx, so this chip sits at the bottom of the video region by default. NoticeChip.module.css
   * adds extra lift above that on narrow windows, where it would otherwise conflict with the pill.
   * See chrome/floating-offsets.ts. */
  bottomPx: number;
}

/**
 * design/floating-chrome-changes.md's "3. Status bar removed" -- the zoom/thumbs/index readouts
 * are dropped entirely; only the keyframe-shift notice survives, as this standalone floating chip.
 * Unlike TitleBar/TransportBar it does not cross-fade with chromeVisible (per the target
 * screenshots, it stays put through the idle fade).
 */
export function NoticeChip({
  notice,
  noticeOpen,
  onNoticeEnter,
  onNoticeLeave,
  onKeepExact,
  onDismissNotice,
  exactAvailable,
  fps,
  rightPx,
  marginRightPx,
  bottomPx,
}: NoticeChipProps) {
  if (notice === null) return null;
  const timecode = formatTimecode(notice.at * fps, fps);

  return (
    <div className={styles.root} style={{ right: rightPx, marginRight: marginRightPx, bottom: bottomPx }}>
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
    </div>
  );
}
