// Pure geometry helpers for the always-visible whole-file minimap strip (chrome/MinimapStrip.tsx).
// Unlike viewport.ts's px<->ticks transforms (relative to the current zoom window), everything
// here is a percentage of the *entire file's* duration -- no DOM, no canvas.

import { clampViewStart } from './viewport.ts';
import type { Time } from './types.ts';

export interface MinimapBand {
  leftPct: number;
  widthPct: number;
}

function roundPct(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Trim selection band, in seconds (tstart/tend/durationSeconds are all app-state.ts's seconds
 * domain) -- floored at 0.4% so a short trim on a long file stays visible; the DOM's own
 * `min-width: 10px` (MinimapStrip.module.css) is a second, independent floor for very small
 * percentages of a narrow strip. */
export function trimBandPct(tstart: number, tend: number, durationSeconds: number): MinimapBand {
  if (durationSeconds <= 0) return { leftPct: 0, widthPct: 0 };
  return {
    leftPct: roundPct((tstart / durationSeconds) * 100),
    widthPct: roundPct(Math.max(0.4, ((tend - tstart) / durationSeconds) * 100)),
  };
}

/** Zoom window capsule, in presentation ticks -- same domain as TimelineControllerState's
 * viewStart/viewSpan and the video track's own duration, so no seconds conversion is needed.
 * Floored at 0.6% so the capsule never disappears at extreme zoom. */
export function zoomCapsulePct(viewStart: Time, viewSpan: Time, durationTicks: Time): MinimapBand {
  if (durationTicks <= 0) return { leftPct: 0, widthPct: 0 };
  return {
    leftPct: roundPct((viewStart / durationTicks) * 100),
    widthPct: roundPct(Math.max(0.6, (viewSpan / durationTicks) * 100)),
  };
}

/** Playhead position, in presentation ticks. */
export function playheadPct(t: Time, durationTicks: Time): number {
  if (durationTicks <= 0) return 0;
  return roundPct((t / durationTicks) * 100);
}

/** Centers the zoom window on a clicked point (in ticks), clamped to the file's bounds --
 * MinimapStrip.tsx's drag-to-pan gesture. `viewSpan` is unchanged: this only pans, never zooms. */
export function centerViewStart(clickTicks: Time, viewSpan: Time, durationTicks: Time): Time {
  return clampViewStart(clickTicks - viewSpan / 2, viewSpan, durationTicks);
}
