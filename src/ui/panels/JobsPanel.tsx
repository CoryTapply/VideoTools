import { PanelRows } from './PanelRows.tsx';
import styles from './Panel.module.css';
import type { PanelRowFixture } from '../media/panel-row.ts';

export interface JobsPanelProps {
  rows: readonly PanelRowFixture[];
}

export function JobsPanel({ rows }: JobsPanelProps) {
  return (
    <div className={styles.body}>
      <PanelRows rows={rows} />
    </div>
  );
}
