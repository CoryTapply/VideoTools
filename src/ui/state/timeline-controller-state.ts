// Type + inert factory only. The real controller -- an imperative object mutated every
// requestAnimationFrame tick and read directly by the canvas draw calls -- is Task 4b's job. This
// file exists so 4b has a settled shape to build against instead of inventing one alongside the
// canvas work; see ../README.md's "React-state / timeline-controller-state split".

import { useRef } from 'react';
import type { RefObject } from 'react';

export type DragTarget = 'in' | 'out' | null;

export interface TimelineControllerState {
  /** Playhead, presentation seconds. */
  t: number;
  /** Left edge of the visible window, seconds. */
  viewStart: number;
  /** Width of the visible window, seconds. */
  viewSpan: number;
  playing: boolean;
  drag: DragTarget;
  /** Timestamp a snap flash started at, or null when none is active. */
  snapFlash: number | null;
  /** Measured canvas width in px, from a ResizeObserver. */
  tlW: number;
}

export function createTimelineControllerState(
  overrides: Partial<TimelineControllerState> = {},
): TimelineControllerState {
  return {
    t: 0,
    viewStart: 0,
    viewSpan: 0,
    playing: false,
    drag: null,
    snapFlash: null,
    tlW: 0,
    ...overrides,
  };
}

/**
 * Returns a mutable ref holding the timeline controller's state, created once per mount. Task 4b
 * reads and writes through this ref from its rAF loop -- never through React state, so playhead
 * movement never triggers a re-render.
 */
export function useTimelineControllerRef(
  initial?: Partial<TimelineControllerState>,
): RefObject<TimelineControllerState> {
  return useRef(createTimelineControllerState(initial));
}
