// Static placeholder display data for M1's "renders every state with placeholder content" exit
// criterion. Numbers are design/README.md's own example fixture (a 4-hour, 60fps OBS multi-track
// recording) -- not live data. Once Task 5/media wiring lands, this module goes away and these
// fields come from the real index/track list instead.

import type { TrackId, TrackSelection } from './state/app-state.ts';

export const FPS = 60;
export const DURATION_SECONDS = 862401 / FPS;

export const FILE_NAME = 'session-4.mp4';
export const FORMAT_CHIP = 'MP4 · H.264 · 19.4 GB';

export interface TrackFixture {
  id: TrackId;
  name: string;
  meta: string;
  kind: 'video' | 'audio';
  locked?: boolean;
}

const FULL_DURATION_LABEL = '4:00:00';

export const TRACKS: readonly TrackFixture[] = [
  { id: 'V1', name: 'Screen Capture', meta: `h264 · 2560×1440 · 60.00 fps · ${FULL_DURATION_LABEL}`, kind: 'video', locked: true },
  { id: 'A1', name: 'Mic — NT-USB', meta: `aac · eng · mono · 48 kHz · ${FULL_DURATION_LABEL}`, kind: 'audio' },
  { id: 'A2', name: 'Desktop Audio', meta: `aac · eng · stereo · 48 kHz · ${FULL_DURATION_LABEL}`, kind: 'audio' },
  { id: 'A3', name: 'Game Capture', meta: `aac · eng · stereo · 48 kHz · ${FULL_DURATION_LABEL}`, kind: 'audio' },
  { id: 'A4', name: 'Voice Chat', meta: 'aac · eng · stereo · 48 kHz · 3:58:12', kind: 'audio' },
  { id: 'A5', name: 'Browser Media', meta: `aac · und · stereo · 48 kHz · ${FULL_DURATION_LABEL}`, kind: 'audio' },
  { id: 'A6', name: 'Alerts', meta: `aac · und · stereo · 44.1 kHz · ${FULL_DURATION_LABEL}`, kind: 'audio' },
];

/** Matches the value colors PanelRows renders -- see panels/PanelRows.tsx. */
export type RowTone = 'neutral' | 'muted' | 'informational' | 'good' | 'warning';

export interface PanelRowFixture {
  label: string;
  value: string;
  tone: RowTone;
}

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

/** SourcePanel's TrackList is read-only and ignores selection, but still needs a value to pass. */
export const ALL_TRACKS_SELECTED: TrackSelection = { V1: true, A1: true, A2: true, A3: true, A4: true, A5: true, A6: true };

export const PLAYHEAD_SECONDS = 6724.517;
export const DEFAULT_IN_SECONDS = 6690;
export const DEFAULT_OUT_SECONDS = 6812;
