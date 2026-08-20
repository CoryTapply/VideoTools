import { deriveExportRows } from '../media/derive-source-info.ts';
import { PanelRows } from './PanelRows.tsx';
import { TrackList } from './TrackList.tsx';
import styles from './Panel.module.css';
import type { TrackId, TrackSelection, TrackVolume } from '../state/app-state.ts';
import type { TrackSummary } from '../media/track-summary.ts';

export interface ExportPanelProps {
  tracks: readonly TrackSummary[];
  sel: TrackSelection;
  tstart: number;
  tend: number;
  sourceFileName: string;
  /** Real, no-I/O sum of selected sample sizes over [tstart, tend) -- null when no real file/index
   * is open yet (deriveExportRows falls back to an illustrative formula). */
  estimatedBytes: number | null;
  onToggleTrack: (id: TrackId) => void;
  trackVol: TrackVolume;
  onSetTrackVolume: (id: TrackId, vol: number) => void;
}

export function ExportPanel({ tracks, sel, tstart, tend, sourceFileName, estimatedBytes, onToggleTrack, trackVol, onSetTrackVolume }: ExportPanelProps) {
  const rows = deriveExportRows(tracks, sel, tstart, tend, sourceFileName, estimatedBytes);

  return (
    <div className={styles.body}>
      <TrackList mode="export" tracks={tracks} sel={sel} onToggle={onToggleTrack} trackVol={trackVol} onSetTrackVolume={onSetTrackVolume} />
      <PanelRows rows={rows} />
    </div>
  );
}
