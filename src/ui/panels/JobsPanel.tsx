import { JOBS_PANEL_ROWS } from '../fixtures.ts';
import { PanelRows } from './PanelRows.tsx';
import styles from './Panel.module.css';

export function JobsPanel() {
  return (
    <div className={styles.body}>
      <PanelRows rows={JOBS_PANEL_ROWS} />
    </div>
  );
}
