// Pure clamp math for the timeline-height splitter. design/README.md: "150px to 55vh".

export const SPLITTER_MIN_HEIGHT_PX = 150;
export const SPLITTER_MAX_HEIGHT_VH_FRACTION = 0.55;

export function clampTimelineHeight(heightPx: number, viewportHeightPx: number): number {
  const max = viewportHeightPx * SPLITTER_MAX_HEIGHT_VH_FRACTION;
  return Math.min(Math.max(heightPx, SPLITTER_MIN_HEIGHT_PX), max);
}

/**
 * The splitter sits above the timeline, so dragging the pointer down shrinks it and dragging up
 * grows it -- `deltaY` is the pointer's Y movement since the drag started (positive = down).
 */
export function nextTimelineHeight(startHeightPx: number, deltaY: number, viewportHeightPx: number): number {
  return clampTimelineHeight(startHeightPx - deltaY, viewportHeightPx);
}
