import { TRACKS } from '../fixtures.ts';
import { formatDurationHMS } from '../state/snap-notice.ts';
import { PanelRows } from './PanelRows.tsx';
import { TrackList } from './TrackList.tsx';
import styles from './Panel.module.css';
import type { PanelRowFixture } from '../fixtures.ts';
import type { TrackId, TrackSelection } from '../state/app-state.ts';

export interface ExportPanelProps {
  sel: TrackSelection;
  tin: number;
  tout: number;
  onToggleTrack: (id: TrackId) => void;
}

export function ExportPanel({ sel, tin, tout, onToggleTrack }: ExportPanelProps) {
  const audioSelected = TRACKS.filter((t) => t.kind === 'audio' && sel[t.id]).length;
  const rows: readonly PanelRowFixture[] = [
    { label: 'container', value: 'mp4', tone: 'neutral' },
    { label: 'video', value: 'stream copy', tone: 'informational' },
    {
      label: 'audio',
      value: audioSelected === 0 ? 'none selected' : `stream copy × ${audioSelected.toString()}`,
      tone: audioSelected === 0 ? 'warning' : 'informational',
    },
    { label: 'range', value: formatDurationHMS(tout - tin), tone: 'neutral' },
    { label: 'est. size', value: `${(178 + audioSelected * 29).toString()} MB`, tone: 'muted' },
    { label: 'writer', value: 'file system access', tone: 'good' },
    { label: 'folder', value: '~/Recordings', tone: 'muted' },
    { label: 'name', value: 'session-4_clip.mp4', tone: 'muted' },
  ];

  return (
    <div className={styles.body}>
      <TrackList mode="export" sel={sel} onToggle={onToggleTrack} />
      <PanelRows rows={rows} />
    </div>
  );
}
