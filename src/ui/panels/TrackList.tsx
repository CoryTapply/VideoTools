import { CheckIcon } from '../icons/index.tsx';
import { TRACKS } from '../fixtures.ts';
import styles from './Panel.module.css';
import type { TrackId, TrackSelection } from '../state/app-state.ts';

export interface TrackListProps {
  mode: 'source' | 'export';
  sel: TrackSelection;
  onToggle?: (id: TrackId) => void;
}

export function TrackList({ mode, sel, onToggle }: TrackListProps) {
  const count =
    mode === 'source'
      ? '1 video · 6 audio'
      : `${TRACKS.filter((t) => sel[t.id]).length.toString()} of ${TRACKS.length.toString()} selected`;

  return (
    <div className={styles.trackListWrapper}>
      <div className={styles.trackListHeader}>
        <span className={styles.trackListTitle}>Tracks</span>
        <span className={styles.trackListCount}>{count}</span>
      </div>
      {TRACKS.map((track) => {
        // The Source panel is read-only: it never shows a checkmark, even for the always-on V1
        // track -- design/reference/Video Trimmer.dc.html's trackRows('source') forces `on: false`
        // regardless of selection state.
        const on = mode === 'export' && sel[track.id];
        const interactive = mode === 'export' && !track.locked;

        const checkboxClass = [styles.checkbox, mode === 'export' ? (on ? styles.checkboxOn : styles.checkboxOff) : '']
          .filter(Boolean)
          .join(' ');
        const rowClass = [
          styles.trackRow,
          mode === 'export' && on ? styles.trackRowSelected : '',
          interactive ? styles.trackRowInteractive : styles.trackRowInert,
        ]
          .filter(Boolean)
          .join(' ');
        const nameClass = `${styles.trackName} ${mode === 'export' && !on ? styles.trackNameOff : styles.trackNameOn}`;

        return (
          <div
            key={track.id}
            className={rowClass}
            onClick={interactive && onToggle ? () => { onToggle(track.id); } : undefined}
          >
            <div className={checkboxClass}>{on && <CheckIcon />}</div>
            <span className={`${styles.trackId} ${track.kind === 'video' ? styles.trackIdVideo : styles.trackIdAudio}`}>
              {track.id}
            </span>
            <div className={styles.trackMeta}>
              <span className={nameClass}>{track.name}</span>
              <span className={styles.trackMetaLine}>{track.meta}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
