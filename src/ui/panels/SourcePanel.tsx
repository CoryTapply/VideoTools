import { ALL_TRACKS_SELECTED, SOURCE_PANEL_ROWS } from '../fixtures.ts';
import { PanelRows } from './PanelRows.tsx';
import { TrackList } from './TrackList.tsx';
import styles from './Panel.module.css';

export function SourcePanel() {
  return (
    <div className={styles.body}>
      <TrackList mode="source" sel={ALL_TRACKS_SELECTED} />
      <PanelRows rows={SOURCE_PANEL_ROWS} />
    </div>
  );
}
