import { defaultExportFileName, deriveExportRows } from '../media/derive-source-info.ts';
import { PanelRows } from './PanelRows.tsx';
import { TrackList } from './TrackList.tsx';
import styles from './Panel.module.css';
import type { ChangeEvent } from 'react';
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
  /** User-typed override; null means the field shows defaultExportFileName(sourceFileName) as a
   * placeholder rather than a committed value -- see state/app-state.ts's exportFileName. */
  exportFileName: string | null;
  onToggleTrack: (id: TrackId) => void;
  onChangeExportFileName: (name: string) => void;
}

// getFileHandle() takes a single path segment -- these would either throw or (for '..') attempt
// to escape the chosen directory, so they're stripped as the user types rather than surfaced as
// an error later.
const ILLEGAL_FILENAME_CHARS = /[/\\:*?"<>|]/g;

export function ExportPanel({ tracks, sel, tin, tout, sourceFileName, estimatedBytes, exportFileName, onToggleTrack, onChangeExportFileName }: ExportPanelProps) {
  const rows = deriveExportRows(tracks, sel, tin, tout, estimatedBytes);

  function handleNameChange(evt: ChangeEvent<HTMLInputElement>) {
    onChangeExportFileName(evt.target.value.replace(ILLEGAL_FILENAME_CHARS, ''));
  }

  return (
    <div className={styles.body}>
      <TrackList mode="export" tracks={tracks} sel={sel} onToggle={onToggleTrack} />
      <label className={styles.row}>
        <span className={styles.rowLabel}>name</span>
        <input
          className={styles.nameInput}
          type="text"
          value={exportFileName ?? ''}
          placeholder={defaultExportFileName(sourceFileName)}
          onChange={handleNameChange}
          spellCheck={false}
        />
      </label>
      <PanelRows rows={rows} />
    </div>
  );
}
