// Static placeholder display data for M1's "renders every state with placeholder content" exit
// criterion. Numbers are design/README.md's own example fixture (a 4-hour, 60fps OBS multi-track
// recording) -- not live data. Once Task 5/media wiring lands, this module goes away and these
// fields come from the real index/track list instead.

import type { TrackId } from './state/app-state.ts';

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

export const SOURCE_PANEL_ROWS: readonly { label: string; value: string }[] = [
  { label: 'container', value: 'mp4' },
  { label: 'codec', value: 'h264 / High' },
  { label: 'resolution', value: '2560 × 1440' },
  { label: 'frame rate', value: '60.00 fps' },
  { label: 'frames', value: '862,401' },
  { label: 'keyframes', value: '3,422' },
  { label: 'GOP', value: '252 frames · 4.2 s' },
  { label: 'bitrate', value: '11.6 Mb/s' },
  { label: 'size', value: '19.4 GB' },
  { label: 'heap', value: '147 MB in use' },
];

export const JOBS_PANEL_ROWS: readonly { label: string; value: string }[] = [
  { label: 'index', value: 'done · 138 ms' },
  { label: 'keyframe map', value: 'done · 41 ms' },
  { label: 'thumbs', value: '68% · running' },
  { label: 'waveform', value: 'queued' },
];

export const ZOOM_LABEL = '1 frame = 5px';
export const THUMB_LABEL = 'thumbs 68%';
export const INDEX_LABEL = 'index 862,401 frames · 3,422 keyframes';

export const PLAYHEAD_SECONDS = 6724.517;
export const DEFAULT_IN_SECONDS = 6690;
export const DEFAULT_OUT_SECONDS = 6812;
