import { deriveExportRows } from '../media/derive-source-info.ts';
import { PanelRows } from './PanelRows.tsx';
import { TrackList } from './TrackList.tsx';
import styles from './Panel.module.css';
import type { TrackId, TrackSelection } from '../state/app-state.ts';
import type { TrackSummary } from '../media/track-summary.ts';

export interface ExportPanelProps {
  tracks: readonly TrackSummary[];
  sel: TrackSelection;
  tin: number;
  tout: number;
  sourceFileName: string;
  onToggleTrack: (id: TrackId) => void;
}

export function ExportPanel({ tracks, sel, tin, tout, sourceFileName, onToggleTrack }: ExportPanelProps) {
  const rows = deriveExportRows(tracks, sel, tin, tout, sourceFileName);

  return (
    <div className={styles.body}>
      <TrackList mode="export" tracks={tracks} sel={sel} onToggle={onToggleTrack} />
      <PanelRows rows={rows} />
    </div>
  );
}
