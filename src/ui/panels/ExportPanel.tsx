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
  /** Real, no-I/O sum of selected sample sizes over [tin, tout) -- null when no real file/index is
   * open yet (deriveExportRows falls back to an illustrative formula). */
  estimatedBytes: number | null;
  onToggleTrack: (id: TrackId) => void;
}

export function ExportPanel({ tracks, sel, tin, tout, sourceFileName, estimatedBytes, onToggleTrack }: ExportPanelProps) {
  const rows = deriveExportRows(tracks, sel, tin, tout, sourceFileName, estimatedBytes);

  return (
    <div className={styles.body}>
      <TrackList mode="export" tracks={tracks} sel={sel} onToggle={onToggleTrack} />
      <PanelRows rows={rows} />
    </div>
  );
}
