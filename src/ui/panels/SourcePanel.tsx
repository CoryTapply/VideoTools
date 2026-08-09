import { PanelRows } from './PanelRows.tsx';
import { TrackList } from './TrackList.tsx';
import styles from './Panel.module.css';
import type { PanelRowFixture } from '../media/panel-row.ts';
import type { TrackSummary } from '../media/track-summary.ts';

export interface SourcePanelProps {
  tracks: readonly TrackSummary[];
  rows: readonly PanelRowFixture[];
}

export function SourcePanel({ tracks, rows }: SourcePanelProps) {
  return (
    <div className={styles.body}>
      {/* Read-only: TrackList never shows a checkmark in 'source' mode, so `sel` goes unused. */}
      <TrackList mode="source" tracks={tracks} sel={{}} />
      <PanelRows rows={rows} />
    </div>
  );
}
