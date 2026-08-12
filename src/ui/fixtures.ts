// Static placeholder display data, used two ways: (1) `ui-harness.html`'s dev-only variant
// switcher, which never has a real file; (2) App.tsx's fallback when no real file is open yet.
// Numbers are design/README.md's own example fixture (a 4-hour, 60fps OBS multi-track recording)
// -- not live data. Real data (once a file is actually opened) comes from media/derive-source-info.ts
// instead -- see App.tsx's `media.X ?? fixtureX` pattern.

import type { PanelRowFixture } from './media/panel-row.ts';
import type { TrackSummary } from './media/track-summary.ts';

export const FPS = 60;
export const DURATION_SECONDS = 862401 / FPS;

export const FILE_NAME = 'session-4.mp4';
export const FORMAT_CHIP = 'MP4 · H.264 · 19.4 GB';

const FULL_DURATION_LABEL = '4:00:00';

export const TRACKS: readonly TrackSummary[] = [
  { id: 'V1', trackId: 1, name: 'Screen Capture', meta: `h264 · 2560×1440 · 60.00 fps · ${FULL_DURATION_LABEL}`, kind: 'video', locked: true },
  { id: 'A1', trackId: 2, name: 'Mic — NT-USB', meta: `aac · eng · mono · 48 kHz · ${FULL_DURATION_LABEL}`, kind: 'audio' },
  { id: 'A2', trackId: 3, name: 'Desktop Audio', meta: `aac · eng · stereo · 48 kHz · ${FULL_DURATION_LABEL}`, kind: 'audio' },
  { id: 'A3', trackId: 4, name: 'Game Capture', meta: `aac · eng · stereo · 48 kHz · ${FULL_DURATION_LABEL}`, kind: 'audio' },
  { id: 'A4', trackId: 5, name: 'Voice Chat', meta: 'aac · eng · stereo · 48 kHz · 3:58:12', kind: 'audio' },
  { id: 'A5', trackId: 6, name: 'Browser Media', meta: `aac · und · stereo · 48 kHz · ${FULL_DURATION_LABEL}`, kind: 'audio' },
  { id: 'A6', trackId: 7, name: 'Alerts', meta: `aac · und · stereo · 44.1 kHz · ${FULL_DURATION_LABEL}`, kind: 'audio' },
];

export const SOURCE_PANEL_ROWS: readonly PanelRowFixture[] = [
  { label: 'container', value: 'mp4', tone: 'neutral' },
  { label: 'codec', value: 'h264 / High', tone: 'muted' },
  { label: 'resolution', value: '2560 × 1440', tone: 'muted' },
  { label: 'frame rate', value: '60.00 fps', tone: 'muted' },
  { label: 'frames', value: '862,401', tone: 'muted' },
  { label: 'keyframes', value: '3,422', tone: 'muted' },
  { label: 'GOP', value: '252 frames · 4.2 s', tone: 'muted' },
  { label: 'bitrate', value: '11.6 Mb/s', tone: 'muted' },
  { label: 'size', value: '19.4 GB', tone: 'muted' },
  { label: 'heap', value: '147 MB in use', tone: 'good' },
];

export const JOBS_PANEL_ROWS: readonly PanelRowFixture[] = [
  { label: 'index', value: 'done · 138 ms', tone: 'good' },
  { label: 'keyframe map', value: 'done · 41 ms', tone: 'good' },
  { label: 'thumbs', value: '68% · running', tone: 'informational' },
  { label: 'waveform', value: 'queued', tone: 'muted' },
  { label: 'clip_03.mp4', value: 'done · 212 MB', tone: 'good' },
  { label: 'clip_02.mp4', value: 'canceled', tone: 'warning' },
];

export const ZOOM_LABEL = '1 frame = 5px';
export const THUMB_LABEL = 'thumbs 68%';
export const INDEX_LABEL = 'index 862,401 frames · 3,422 keyframes';

export interface KeyRowFixture {
  chord: string;
  description: string;
}

export const KEY_ROWS: readonly KeyRowFixture[] = [
  { chord: 'Space / K', description: 'play · pause' },
  { chord: 'J / L', description: 'shuttle (accelerates)' },
  { chord: '← / →', description: 'step frame' },
  { chord: 'Shift + ← / →', description: 'step second' },
  { chord: 'I / O', description: 'set in · out' },
  { chord: 'Shift + I / O', description: 'jump to in · out' },
  { chord: 'Alt + I / O', description: 'clear in · out' },
  { chord: '↑ / ↓', description: 'previous · next keyframe' },
  { chord: '+ / −', description: 'zoom' },
  { chord: 'Shift + Z', description: 'zoom to fit' },
  { chord: 'Home / End', description: 'start · end' },
  { chord: 'F', description: 'full-screen preview' },
  { chord: '⌘ / Ctrl + E', description: 'export clip' },
  { chord: '⌘ / Ctrl + Z', description: 'undo' },
  { chord: 'Alt (drag)', description: 'disable snapping' },
  { chord: '?', description: 'this overlay' },
];

/**
 * Illustrative copy-phase export line, matching design/reference/Video Trimmer.dc.html's own
 * synthetic formula so a screenshot taken mid-export lines up with the design references.
 */
export function formatExportLine(percent: number): string {
  const mbWritten = Math.round((178.48 * percent) / 100);
  const secondsLeft = Math.max(1, Math.round((100 - percent) / 12));
  return `${mbWritten.toString()} MB written · 214 MB/s · ${secondsLeft.toString()} s left`;
}

export const EXPORT_OUT_PATH = '~/Recordings/session-4_clip.mp4';
export const EXPORT_DURATION_LABEL = '2 m 02 s';

export const PLAYHEAD_SECONDS = 6724.517;
export const DEFAULT_IN_SECONDS = 6690;
export const DEFAULT_OUT_SECONDS = 6812;
