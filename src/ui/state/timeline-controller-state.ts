// The real controller -- an imperative object mutated every requestAnimationFrame tick and read
// directly by the canvas draw calls -- is Task 4b's job. This file exists so 4b has a settled
// shape to build against instead of inventing one alongside the canvas work; see ../README.md's
// "React-state / timeline-controller-state split".
//
// `t`/`viewStart`/`viewSpan` are presentation ticks, not seconds -- every real API this state feeds
// (FrameCache.setViewport/getNearest/getRange, SampleIndex's presentation-native queries,
// PlaybackEngine.seek/currentTime/onFrame) is tick-native, so converting once at the React
// boundary (app-state.ts's tstart/tend, which stay seconds) is cheaper and safer than float-converting
// on every 60Hz cache lookup. See src/media/index/README.md's "never float seconds outside the
// index module" rule and time.ts's ticksToSeconds/secondsToTicks for the two conversion points.

import { useRef } from 'react';
import type { RefObject } from 'react';
// Type-only -- keeps this module free of any runtime dependency beyond react, matching its
// "type + inert factory only" scope (see the Time/DragTarget comment above). draw/handle-color.ts
// owns resolving these labels to actual colors; this file only carries the timestamp+labels.
import type { BarColorTransition } from '../timeline/draw/handle-color.ts';

/** Same convention as src/media/frames/types.ts and src/media/playback/PlaybackEngine.ts: an
 * integer count of the loaded file's primary video track's own timescale. Redeclared here rather
 * than imported so this module stays import-free and DOM/media-free, matching its "type + inert
 * factory only" scope. */
export type Time = number;

export type DragTarget = 'start' | 'end' | null;

export interface TimelineControllerState {
  /** Playhead, presentation ticks. */
  t: Time;
  /** Left edge of the visible window, presentation ticks. */
  viewStart: Time;
  /** Width of the visible window, presentation ticks. */
  viewSpan: Time;
  playing: boolean;
  drag: DragTarget;
  /** Which handle (if any) the pointer is hovering, while not dragging -- gates the hover bar fill
   * and the START/END chip's visibility. Always null while `drag !== null`: hover is suppressed for
   * the whole duration of a drag, per design/scrub-chip-prompt.md's visibility rules. */
  hover: DragTarget;
  /** Ghost start/end value while `drag !== null`, presentation ticks; null when not dragging a handle. */
  dragValueTicks: Time | null;
  /** Each handle bar's current rest/hover/active color transition -- draw/handle-color.ts resolves
   * these to an animated fill color every frame; TimelineController.draw() advances them whenever
   * the target state (derived from `drag`/`hover`) changes. */
  barTransition: { start: BarColorTransition; end: BarColorTransition };
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
    hover: null,
    dragValueTicks: null,
    barTransition: {
      start: { from: 'rest', to: 'rest', startedAt: -Infinity },
      end: { from: 'rest', to: 'rest', startedAt: -Infinity },
    },
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
