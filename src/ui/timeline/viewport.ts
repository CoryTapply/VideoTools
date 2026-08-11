// Pure viewport transform math -- px <-> presentation ticks, pan, and cursor-anchored zoom. No
// DOM, no canvas: TimelineController calls these every rAF tick / gesture event and applies the
// result to its TimelineControllerState ref.

import type { Time, Viewport } from './types.ts';

/** design/README.md's zoom clamp: a single frame is never wider than this on screen. */
export const MAX_FRAME_PX = 40;

export function timeToX(t: Time, viewStart: Time, viewSpan: Time, widthPx: number): number {
  if (viewSpan <= 0) return 0;
  return ((t - viewStart) / viewSpan) * widthPx;
}

export function xToTime(x: number, viewStart: Time, viewSpan: Time, widthPx: number): Time {
  if (widthPx <= 0) return viewStart;
  return viewStart + (x / widthPx) * viewSpan;
}

function clampViewStart(viewStart: Time, viewSpan: Time, durationTicks: Time): Time {
  const maxStart = Math.max(0, durationTicks - viewSpan);
  return Math.min(Math.max(0, viewStart), maxStart);
}

/** Clamps to `[minSpanForMaxFramePx, durationTicks]` -- never zoom in past one frame per
 * MAX_FRAME_PX screen pixels, never zoom out past the full file. `ticksPerFrame` is
 * `timescale / nominalFrameRate`; pass 0 (VFR/unknown) to skip the zoom-in clamp. */
export function clampViewSpan(span: Time, widthPx: number, ticksPerFrame: Time, durationTicks: Time): Time {
  const minSpan = ticksPerFrame > 0 && widthPx > 0 ? (widthPx / MAX_FRAME_PX) * ticksPerFrame : 0;
  return Math.min(Math.max(0, durationTicks), Math.max(minSpan, span));
}

export function panByPixels(viewport: Viewport, deltaPx: number, durationTicks: Time): Time {
  if (viewport.widthPx <= 0) return viewport.viewStart;
  const deltaTicks = (deltaPx / viewport.widthPx) * viewport.viewSpan;
  return clampViewStart(viewport.viewStart + deltaTicks, viewport.viewSpan, durationTicks);
}

/** Cursor-anchored zoom: the tick under `cursorX` stays under `cursorX` after the zoom. */
export function zoomAtCursor(
  viewport: Viewport,
  cursorX: number,
  factor: number,
  ticksPerFrame: Time,
  durationTicks: Time,
): { viewStart: Time; viewSpan: Time } {
  const anchorTime = xToTime(cursorX, viewport.viewStart, viewport.viewSpan, viewport.widthPx);
  const nextSpan = clampViewSpan(viewport.viewSpan * factor, viewport.widthPx, ticksPerFrame, durationTicks);
  const anchorFraction = viewport.widthPx <= 0 ? 0 : cursorX / viewport.widthPx;
  const nextViewStart = clampViewStart(anchorTime - anchorFraction * nextSpan, nextSpan, durationTicks);
  return { viewStart: nextViewStart, viewSpan: nextSpan };
}

/** Same as zoomAtCursor, anchored at the playhead's on-screen position instead of the pointer --
 * for keyboard zoom-in/out. */
export function zoomAtPlayhead(
  viewport: Viewport,
  playhead: Time,
  factor: number,
  ticksPerFrame: Time,
  durationTicks: Time,
): { viewStart: Time; viewSpan: Time } {
  const cursorX = timeToX(playhead, viewport.viewStart, viewport.viewSpan, viewport.widthPx);
  return zoomAtCursor(viewport, cursorX, factor, ticksPerFrame, durationTicks);
}

export function fitToDuration(durationTicks: Time): { viewStart: Time; viewSpan: Time } {
  return { viewStart: 0, viewSpan: durationTicks };
}
