// The real controller -- an imperative object mutated every requestAnimationFrame tick and read
// directly by the canvas draw calls -- is Task 4b's job. This file exists so 4b has a settled
// shape to build against instead of inventing one alongside the canvas work; see ../README.md's
// "React-state / timeline-controller-state split".
//
// `t`/`viewStart`/`viewSpan` are presentation ticks, not seconds -- every real API this state feeds
// (FrameCache.setViewport/getNearest/getRange, SampleIndex's presentation-native queries,
// PlaybackEngine.seek/currentTime/onFrame) is tick-native, so converting once at the React
// boundary (app-state.ts's tin/tout, which stay seconds) is cheaper and safer than float-converting
// on every 60Hz cache lookup. See src/media/index/README.md's "never float seconds outside the
// index module" rule and time.ts's ticksToSeconds/secondsToTicks for the two conversion points.

import { useRef } from 'react';
import type { RefObject } from 'react';

/** Same convention as src/media/frames/types.ts and src/media/playback/PlaybackEngine.ts: an
 * integer count of the loaded file's primary video track's own timescale. Redeclared here rather
 * than imported so this module stays import-free and DOM/media-free, matching its "type + inert
 * factory only" scope. */
export type Time = number;

export type DragTarget = 'in' | 'out' | null;

export interface TimelineControllerState {
  /** Playhead, presentation ticks. */
  t: Time;
  /** Left edge of the visible window, presentation ticks. */
  viewStart: Time;
  /** Width of the visible window, presentation ticks. */
  viewSpan: Time;
  playing: boolean;
  drag: DragTarget;
  /** Ghost in/out value while `drag !== null`, presentation ticks; null when not dragging a handle. */
  dragValueTicks: Time | null;
  /** True during a handle drag OR a general playhead drag-scrub -- gates the cache-frame preview
   * overlay in PreviewSurface and suppresses PlaybackEngine.seek() until pointer-up's settle seek. */
  scrubActive: boolean;
  /** Kinetic-pan momentum, ticks/ms; 0 when not coasting. */
  panVelocityTicksPerMs: number;
  /** Timestamp (performance.now()) a snap flash started at, or null when none is active. */
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
    dragValueTicks: null,
    scrubActive: false,
    panVelocityTicksPerMs: 0,
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
