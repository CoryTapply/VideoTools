import styles from './Panel.module.css';
import type { PanelRowFixture, RowTone } from '../fixtures.ts';

const TONE_CLASS: Record<RowTone, string> = {
  neutral: styles.toneNeutral,
  muted: styles.toneMuted,
  informational: styles.toneInformational,
  good: styles.toneGood,
  warning: styles.toneWarning,
};

export function PanelRows({ rows }: { rows: readonly PanelRowFixture[] }) {
  return (
    <>
      {rows.map((row) => (
        <div key={row.label} className={styles.row}>
          <span className={styles.rowLabel}>{row.label}</span>
          <span className={`${styles.rowValue} ${TONE_CLASS[row.tone]}`}>{row.value}</span>
        </div>
      ))}
    </>
  );
}
