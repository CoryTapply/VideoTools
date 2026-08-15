import { useState } from 'react';
import { App } from '../App.tsx';
import { DEFAULT_START_SECONDS, DEFAULT_END_SECONDS } from '../fixtures.ts';
import styles from './Harness.module.css';
import type { AppState, PanelId, Screen, TrimMode } from '../state/app-state.ts';

const SCREENS: readonly Screen[] = ['ready', 'empty', 'opening', 'indexing', 'exporting', 'finalising', 'unsupported', 'degraded'];
const PANELS: readonly (PanelId | 'none')[] = ['none', 'info', 'export', 'queue'];
const TRIM_MODES: readonly TrimMode[] = ['copy', 'exact'];
const NOTICE_WHICH: readonly ('start' | 'end')[] = ['start', 'end'];

/**
 * Renders <App> behind a control panel exposing every variant the design doc lists as
 * screenshot-worthy (design/README.md's "Prototype variants" list), for local dev iteration and
 * for diffing against design/screens/*.png. Every change remounts <App> with a fresh
 * `initialState` -- this harness only needs to reproduce static snapshots, not live transitions.
 */
export function Harness() {
  const [screen, setScreen] = useState<Screen>('ready');
  const [permissionLost, setPermissionLost] = useState(false);
  const [exactAvailable, setExactAvailable] = useState(true);
  const [trimMode, setTrimMode] = useState<TrimMode>('copy');
  const [timelineH, setTimelineH] = useState(236);
  const [panel, setPanel] = useState<PanelId | 'none'>('none');
  const [pinned, setPinned] = useState<PanelId | 'none'>('none');
  const [shortcuts, setShortcuts] = useState(false);
  const [full, setFull] = useState(false);
  const [toast, setToast] = useState(false);
  const [exportPct, setExportPct] = useState(40);
  const [noticeEnabled, setNoticeEnabled] = useState(false);
  const [noticeWhich, setNoticeWhich] = useState<'start' | 'end'>('start');
  const [noticeDelta, setNoticeDelta] = useState(-4.17);
  const [noticeOpen, setNoticeOpen] = useState(false);

  const initialState: Partial<AppState> = {
    screen,
    permissionLost,
    trimMode,
    timelineH,
    panel: panel === 'none' ? null : panel,
    pinned: pinned === 'none' ? null : pinned,
    shortcuts,
    full,
    toast,
    exportPct,
    notice: noticeEnabled ? { which: noticeWhich, delta: noticeDelta, at: DEFAULT_START_SECONDS } : null,
    noticeOpen: noticeEnabled && noticeOpen,
    tstart: DEFAULT_START_SECONDS,
    tend: DEFAULT_END_SECONDS,
  };
  const remountKey = JSON.stringify({ ...initialState, exactAvailable });

  return (
    <div className={styles.root}>
      <div className={styles.controls}>
        <div className={styles.controlsTitle}>State</div>
        <div className={styles.field}>
          <label htmlFor="h-screen">screen</label>
          <select id="h-screen" value={screen} onChange={(e) => { setScreen(e.target.value as Screen); }}>
            {SCREENS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.fieldRow}>
          <input
            id="h-permission-lost"
            type="checkbox"
            checked={permissionLost}
            onChange={(e) => { setPermissionLost(e.target.checked); }}
          />
          <label htmlFor="h-permission-lost">permission lost (reconnect pill)</label>
        </div>

        <div className={styles.controlsTitle}>Milestones</div>
        <div className={styles.fieldRow}>
          <input
            id="h-exact-available"
            type="checkbox"
            checked={exactAvailable}
            onChange={(e) => { setExactAvailable(e.target.checked); }}
          />
          <label htmlFor="h-exact-available">exactAvailable</label>
        </div>

        <div className={styles.controlsTitle}>Behavior</div>
        <div className={styles.field}>
          <label htmlFor="h-trim-mode">trimMode</label>
          <select id="h-trim-mode" value={trimMode} onChange={(e) => { setTrimMode(e.target.value as TrimMode); }}>
            {TRIM_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor="h-timeline-height">timelineHeight (150-520)</label>
          <input
            id="h-timeline-height"
            type="number"
            min={150}
            max={520}
            value={timelineH}
            onChange={(e) => { setTimelineH(Number(e.target.value)); }}
          />
        </div>

        <div className={styles.controlsTitle}>Panels</div>
        <div className={styles.field}>
          <label htmlFor="h-panel">floating panel</label>
          <select id="h-panel" value={panel} onChange={(e) => { setPanel(e.target.value as PanelId | 'none'); }}>
            {PANELS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor="h-pinned">pinned panel</label>
          <select id="h-pinned" value={pinned} onChange={(e) => { setPinned(e.target.value as PanelId | 'none'); }}>
            {PANELS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.fieldRow}>
          <input id="h-shortcuts" type="checkbox" checked={shortcuts} onChange={(e) => { setShortcuts(e.target.checked); }} />
          <label htmlFor="h-shortcuts">keyboard overlay open</label>
        </div>
        <div className={styles.fieldRow}>
          <input id="h-full" type="checkbox" checked={full} onChange={(e) => { setFull(e.target.checked); }} />
          <label htmlFor="h-full">full-screen preview</label>
        </div>

        <div className={styles.controlsTitle}>Export</div>
        <div className={styles.field}>
          <label htmlFor="h-export-pct">exportPct (screen=exporting/finalising)</label>
          <input
            id="h-export-pct"
            type="number"
            min={0}
            max={100}
            value={exportPct}
            onChange={(e) => { setExportPct(Number(e.target.value)); }}
          />
        </div>
        <div className={styles.fieldRow}>
          <input id="h-toast" type="checkbox" checked={toast} onChange={(e) => { setToast(e.target.checked); }} />
          <label htmlFor="h-toast">export toast</label>
        </div>

        <div className={styles.controlsTitle}>Keyframe-shift notice</div>
        <div className={styles.fieldRow}>
          <input
            id="h-notice-enabled"
            type="checkbox"
            checked={noticeEnabled}
            onChange={(e) => { setNoticeEnabled(e.target.checked); }}
          />
          <label htmlFor="h-notice-enabled">show notice</label>
        </div>
        <div className={styles.field}>
          <label htmlFor="h-notice-which">which</label>
          <select
            id="h-notice-which"
            value={noticeWhich}
            onChange={(e) => { setNoticeWhich(e.target.value as 'start' | 'end'); }}
            disabled={!noticeEnabled}
          >
            {NOTICE_WHICH.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor="h-notice-delta">delta (seconds)</label>
          <input
            id="h-notice-delta"
            type="number"
            step={0.01}
            value={noticeDelta}
            disabled={!noticeEnabled}
            onChange={(e) => { setNoticeDelta(Number(e.target.value)); }}
          />
        </div>
        <div className={styles.fieldRow}>
          <input
            id="h-notice-open"
            type="checkbox"
            checked={noticeOpen}
            disabled={!noticeEnabled}
            onChange={(e) => { setNoticeOpen(e.target.checked); }}
          />
          <label htmlFor="h-notice-open">popover open</label>
        </div>
      </div>

      <div className={styles.stage}>
        <div className={styles.viewport}>
          <App key={remountKey} initialState={initialState} exactAvailable={exactAvailable} />
        </div>
      </div>
    </div>
  );
}
