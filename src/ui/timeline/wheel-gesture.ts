// Wheel gesture math -- design/README.md's Pointer/zoom semantics: plain wheel pans horizontally
// (the larger of deltaX/deltaY), Ctrl/Cmd+wheel zooms anchored at the cursor's timestamp via
// `Math.pow(1.0025, deltaY)`. Pure: the imperative `{passive:false}` listener binding and the
// actual FrameCache.setViewport()/state mutation live in TimelineController, per design/README.md's
// note that React's synthetic onWheel can't preventDefault (so the page would zoom/scroll).

/** design/README.md's literal formula. A positive deltaY (scroll down / pinch out on most
 * trackpads) is conventionally "zoom out," so this is the factor to multiply viewSpan by --
 * ctx: viewSpan growing means zooming out. */
export function wheelZoomFactor(deltaY: number): number {
  return Math.pow(1.0025, deltaY);
}

/** design/README.md: "wheel = horizontal pan (`max(deltaX,deltaY)`)". */
export function wheelPanDeltaPx(deltaX: number, deltaY: number): number {
  return Math.abs(deltaX) >= Math.abs(deltaY) ? deltaX : deltaY;
}

export function isZoomGesture(evt: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return evt.ctrlKey || evt.metaKey;
}
