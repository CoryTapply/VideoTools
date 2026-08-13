import { CheckIcon } from '../icons/index.tsx';
import styles from './Panel.module.css';
import type { TrackId, TrackSelection } from '../state/app-state.ts';
import type { TrackSummary } from '../media/track-summary.ts';

export interface TrackListProps {
  mode: 'source' | 'export';
  tracks: readonly TrackSummary[];
  sel: TrackSelection;
  onToggle?: (id: TrackId) => void;
}

export function TrackList({ mode, tracks, sel, onToggle }: TrackListProps) {
  const count =
    mode === 'source'
      ? `${tracks.filter((t) => t.kind === 'video').length.toString()} video · ${tracks
          .filter((t) => t.kind === 'audio')
          .length.toString()} audio`
      : `${tracks.filter((t) => sel[t.id]).length.toString()} of ${tracks.length.toString()} selected`;

  return (
    <div className={styles.trackListWrapper}>
      <div className={styles.trackListHeader}>
        <span className={styles.trackListTitle}>Tracks</span>
        <span className={styles.trackListCount}>{count}</span>
      </div>
      {tracks.map((track) => {
        // The Source panel is read-only: it never shows a checkmark, regardless of selection
        // state -- design/reference/Video Trimmer.dc.html's trackRows('source') forces `on: false`.
        const on = mode === 'export' && sel[track.id];
        const interactive = mode === 'export';

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
