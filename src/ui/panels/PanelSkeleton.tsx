// Empty-state panel bodies (Source/Export/Jobs) -- design/empty-state-changes.md's "Panels show
// skeletons, not fabricated data". Swapped in by Stage.tsx's renderPanelContent when
// screen === 'empty', in place of the real SourcePanel/ExportPanel/JobsPanel, so opening a rail
// panel with no file loaded doesn't show fixtures.ts's TRACKS/SOURCE_PANEL_ROWS as if they were
// live data.

import panelStyles from './Panel.module.css';
import styles from './PanelSkeleton.module.css';

// Cycled through by index so bar widths vary per row without reading as a grid -- design note's
// "widths vary per row (40-70px)".
const KV_LABEL_WIDTHS = [46, 60, 38, 66, 50, 42, 58, 36];
const KV_VALUE_WIDTHS = [54, 40, 62, 48, 58, 44, 36, 66];
const TRACK_NAME_WIDTHS = [72, 58, 84, 50, 66];
const TRACK_META_WIDTHS = [96, 80, 108, 70, 90];

function SkeletonBar({ width, height, tone }: { width: number; height: number; tone: 'label' | 'value' }) {
  const toneClass = tone === 'label' ? styles.barLabel : styles.barValue;
  return <span className={`${styles.bar} ${toneClass}`} style={{ width, height }} />;
}

function KeyValueSkeleton({ rows }: { rows: number }) {
  return (
    <div className={styles.kvSkeleton}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.kvRow}>
          <SkeletonBar width={KV_LABEL_WIDTHS[i % KV_LABEL_WIDTHS.length]} height={7} tone="label" />
          <SkeletonBar width={KV_VALUE_WIDTHS[i % KV_VALUE_WIDTHS.length]} height={7} tone="value" />
        </div>
      ))}
    </div>
  );
}

function TrackListSkeleton({ rows }: { rows: number }) {
  return (
    <div className={panelStyles.trackListWrapper}>
      <div className={panelStyles.trackListHeader}>
        <span className={panelStyles.trackListTitle}>Tracks</span>
        <SkeletonBar width={52} height={7} tone="value" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.trackRow}>
          <div className={styles.checkboxSkeleton} />
          <SkeletonBar width={18} height={8} tone="value" />
          <div className={styles.trackMetaSkeleton}>
            <SkeletonBar width={TRACK_NAME_WIDTHS[i % TRACK_NAME_WIDTHS.length]} height={8} tone="value" />
            <SkeletonBar width={TRACK_META_WIDTHS[i % TRACK_META_WIDTHS.length]} height={6} tone="label" />
          </div>
        </div>
      ))}
    </div>
  );
}

export interface PanelSkeletonProps {
  /** Track-list skeleton row count; omitted (Jobs) means no track list at all. */
  trackRows?: number;
  kvRows: number;
  note: string;
}

export function PanelSkeleton({ trackRows, kvRows, note }: PanelSkeletonProps) {
  return (
    <div className={panelStyles.body}>
      {trackRows !== undefined && <TrackListSkeleton rows={trackRows} />}
      <KeyValueSkeleton rows={kvRows} />
      <div className={styles.note}>{note}</div>
    </div>
  );
}
