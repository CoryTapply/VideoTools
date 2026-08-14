// The React half of the state split described in ../README.md: low-frequency, drives the DOM
// shell. Never holds anything that changes at 60Hz -- see timeline-controller-state.ts for that.

// Direct submodule import, not the barrel -- src/media/index/index.ts re-exports NodeByteSource,
// which top-level-imports node:fs/promises and crashes when bundled for the browser.
import type { IndexError } from '../../media/index/errors.ts';
import type { ExportError } from '../../media/export/types.ts';

export type Screen =
  | 'ready'
  | 'empty'
  | 'opening'
  | 'indexing'
  | 'exporting'
  | 'finalising'
  | 'unsupported'
  | 'degraded';

export type TrimMode = 'copy' | 'exact';

export type PanelId = 'info' | 'export' | 'queue';

/**
 * Synthesized display id (e.g. "V1", "A1", "A2", ...), not an MP4 track id -- real files have an
 * arbitrary number of tracks, so this can no longer be the closed 7-value union the design
 * fixture used. See ../media/track-summary.ts.
 */
export type TrackId = string;

export type TrackSelection = Record<TrackId, boolean>;

export interface KeyframeShiftNotice {
  /** Signed seconds the edge moved by; negative means it moved earlier. */
  delta: number;
  /** Resulting timecode position, in seconds. */
  at: number;
  which: 'in' | 'out';
}

export interface AppState {
  screen: Screen;
  tin: number;
  tout: number;
  trimMode: TrimMode;
  /** Preview-only monitoring gain -- design/volume-slider-prompt.md. Never affects export output. */
  vol: number;
  muted: boolean;
  panel: PanelId | null;
  pinned: PanelId | null;
  sel: TrackSelection;
  notice: KeyframeShiftNotice | null;
  noticeOpen: boolean;
  shortcuts: boolean;
  full: boolean;
  timelineH: number;
  exportPct: number;
  toast: boolean;
  /** Orthogonal to `screen` -- see ../README.md's "Reconciling the state table". */
  permissionLost: boolean;
  /** Set when the last real `openFile()` attempt failed to parse; cleared on the next attempt. */
  openError: IndexError | null;
  /** Set when the last real export attempt failed (not on a user-initiated cancel -- see
   * useExportSession's `startExport`). Cleared on the next attempt. */
  exportError: ExportError | null;
}

export const DEFAULT_TIMELINE_HEIGHT = 236;

export function createInitialAppState(overrides: Partial<AppState> = {}): AppState {
  return {
    screen: 'empty',
    tin: 0,
    tout: 0,
    trimMode: 'copy',
    vol: 0.7,
    muted: false,
    panel: null,
    pinned: null,
    sel: { V1: true, A1: true, A2: false, A3: false, A4: false, A5: false, A6: false },
    notice: null,
    noticeOpen: false,
    shortcuts: false,
    full: false,
    timelineH: DEFAULT_TIMELINE_HEIGHT,
    exportPct: 0,
    toast: false,
    permissionLost: false,
    openError: null,
    exportError: null,
    ...overrides,
  };
}

export type AppAction =
  | { type: 'screen/set'; screen: Screen }
  | { type: 'panel/open'; panel: PanelId }
  | { type: 'panel/close' }
  | { type: 'panel/pin'; panel: PanelId }
  | { type: 'panel/unpin' }
  | { type: 'trim-mode/set'; mode: TrimMode }
  | { type: 'volume/set'; vol: number }
  | { type: 'mute/toggle' }
  | { type: 'mute/set'; muted: boolean }
  | { type: 'track/toggle'; track: TrackId }
  | { type: 'sel/set'; sel: TrackSelection }
  | { type: 'in-out/set'; tin: number; tout: number }
  | { type: 'open-error/set'; error: IndexError | null }
  | { type: 'export-error/set'; error: ExportError | null }
  | { type: 'notice/set'; notice: KeyframeShiftNotice | null }
  | { type: 'notice/open-set'; open: boolean }
  | { type: 'notice/keep-exact' }
  | { type: 'shortcuts/toggle' }
  | { type: 'full/toggle' }
  | { type: 'timeline-height/set'; height: number }
  | { type: 'export/progress'; pct: number }
  | { type: 'toast/set'; show: boolean }
  | { type: 'permission-lost/set'; lost: boolean };

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'screen/set':
      return { ...state, screen: action.screen };
    case 'panel/open':
      // Opening a rail panel closes the keyboard overlay, and vice versa (shortcuts/toggle
      // below) -- design/reference/Video Trimmer.dc.html's rail button and keys-button handlers.
      return { ...state, panel: action.panel, shortcuts: false };
    case 'panel/close':
      return { ...state, panel: null };
    case 'panel/pin':
      return { ...state, pinned: action.panel, panel: null };
    case 'panel/unpin':
      return { ...state, pinned: null };
    case 'trim-mode/set':
      // Manually switching modes clears any pending notice, per design/README.md's Keyframe
      // enforcement section: "Switching manually to `exact` clears the notice."
      return { ...state, trimMode: action.mode, notice: null, noticeOpen: false };
    case 'volume/set':
      return { ...state, vol: Math.min(1, Math.max(0, action.vol)) };
    case 'mute/toggle':
      return { ...state, muted: !state.muted };
    case 'mute/set':
      return { ...state, muted: action.muted };
    case 'track/toggle':
      // Any track (including the primary video track) can be deselected -- e.g. to export an
      // audio-only clip. resolveExportSelection still requires a video track to exist in the
      // source file for the timeline/keyframe reference, but it doesn't need to be selected.
      return { ...state, sel: { ...state.sel, [action.track]: !state.sel[action.track] } };
    case 'sel/set':
      return { ...state, sel: action.sel };
    case 'in-out/set':
      return { ...state, tin: action.tin, tout: action.tout };
    case 'open-error/set':
      return { ...state, openError: action.error };
    case 'export-error/set':
      return { ...state, exportError: action.error };
    case 'notice/set':
      return { ...state, notice: action.notice, noticeOpen: action.notice === null ? false : state.noticeOpen };
    case 'notice/open-set':
      return { ...state, noticeOpen: action.open };
    case 'notice/keep-exact':
      return { ...state, trimMode: 'exact', notice: null, noticeOpen: false };
    case 'shortcuts/toggle':
      return { ...state, shortcuts: !state.shortcuts, panel: null };
    case 'full/toggle':
      return { ...state, full: !state.full };
    case 'timeline-height/set':
      return { ...state, timelineH: action.height };
    case 'export/progress':
      return { ...state, exportPct: action.pct };
    case 'toast/set':
      return { ...state, toast: action.show };
    case 'permission-lost/set':
      return { ...state, permissionLost: action.lost };
    default:
      return state;
  }
}
