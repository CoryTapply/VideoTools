// Constructs one TimelineController per open file and tears it down on close/unmount -- the glue
// between useMediaSession's resource refs and the two canvases it draws onto (the timeline itself,
// and the drag-scrub preview overlaying PreviewSurface's <video>). Mirrors media-session.ts's own
// "resource-shaped state doesn't belong in the reducer" precedent: this hook touches the DOM/canvas
// directly, so it stays out of app-state.ts entirely.

import { useCallback, useEffect, useRef, useState } from 'react';
import { TimelineController } from '../timeline/TimelineController.ts';
import type { Dispatch, RefCallback, RefObject } from 'react';
import type { ChipRefs } from '../chrome/TimelineRegion.tsx';
import type { AppAction, TrimMode } from './app-state.ts';
import type { MediaSession } from './media-session.ts';
import type { TimelineControllerState } from './timeline-controller-state.ts';

export interface TimelineControllerHandle {
  /** A callback ref, not a plain RefObject -- App.tsx unmounts/remounts TimelineRegion's canvas
   * across the fullscreen toggle (`state.full`), and the construction effect below needs to know
   * when that happens (a mutated `.current` alone triggers no re-render) so it can rebuild the
   * TimelineController against the fresh node instead of leaving it bound to the detached one. */
  timelineCanvasRef: RefCallback<HTMLCanvasElement>;
  scrubOverlayCanvasRef: RefObject<HTMLCanvasElement | null>;
  /** TransportBar's timecode node -- TimelineController writes textContent into it directly from
   * its rAF loop once constructed; see TransportBar.tsx's own doc comment. */
  transportTimecodeRef: RefObject<HTMLDivElement | null>;
  /** IN/OUT chip DOM refs -- passed straight through to TimelineRegion.tsx's chipInRef/chipOutRef
   * props; TimelineController writes their position/visibility/text directly. */
  chipInRef: ChipRefs;
  chipOutRef: ChipRefs;
}

export function useTimelineController(
  media: MediaSession,
  controllerStateRef: RefObject<TimelineControllerState>,
  dispatch: Dispatch<AppAction>,
  trimMode: TrimMode,
  tin: number,
  tout: number,
): TimelineControllerHandle {
  const [timelineCanvas, setTimelineCanvas] = useState<HTMLCanvasElement | null>(null);
  const timelineCanvasRef = useCallback<RefCallback<HTMLCanvasElement>>((node) => {
    setTimelineCanvas(node);
  }, []);
  const scrubOverlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const transportTimecodeRef = useRef<HTMLDivElement>(null);
  const chipInWrapperRef = useRef<HTMLDivElement>(null);
  const chipInTimeRef = useRef<HTMLSpanElement>(null);
  const chipOutWrapperRef = useRef<HTMLDivElement>(null);
  const chipOutTimeRef = useRef<HTMLSpanElement>(null);
  const chipInRef: ChipRefs = { wrapper: chipInWrapperRef, time: chipInTimeRef };
  const chipOutRef: ChipRefs = { wrapper: chipOutWrapperRef, time: chipOutTimeRef };
  const controllerRef = useRef<TimelineController | null>(null);
  const tinToutRef = useRef({ tin, tout });
  const trimModeRef = useRef(trimMode);

  // Kept fresh every render so pointer handlers deep inside TimelineController -- attached once,
  // at construction, long-lived -- never close over a stale trim mode or in/out pair. Same
  // "latestRef" pattern App.tsx's keydown effect already uses for the same reason.
  useEffect(() => {
    tinToutRef.current = { tin, tout };
    trimModeRef.current = trimMode;
  });

  useEffect(() => {
    // timelineCanvas is null both before TimelineRegion's first mount and for the whole time
    // fullscreen (state.full) has it unmounted -- either way, there's nothing to draw onto, and
    // any previously-built controller was already disposed by this same effect's last cleanup.
    if (media.file === null || timelineCanvas === null) return;
    const canvas = timelineCanvas;
    let cancelled = false;
    let waitHandle: number | undefined;

    // The preview canvas mounts around the same time as the timeline's (PreviewSurface's overlay
    // canvas only appears once `videoRef` is defined), but not necessarily on the same render --
    // poll rather than assume, same pattern as media-session.ts's waitForVideoElement.
    function tryConstruct() {
      if (cancelled) return;
      const previewCanvas = scrubOverlayCanvasRef.current;
      if (previewCanvas === null) {
        waitHandle = requestAnimationFrame(tryConstruct);
        return;
      }
      // jsdom's HTMLCanvasElement.getContext('2d') returns null -- no polyfill exists for it, so
      // component/unit tests exercise everything up to here and TimelineController itself is left
      // to manual/browser verification, per src/ui/README.md's testability-seam pattern.
      if (canvas.getContext('2d') === null || previewCanvas.getContext('2d') === null) return;

      controllerRef.current = new TimelineController({
        canvas,
        previewCanvas,
        transportTimecodeRef,
        chipInWrapperRef,
        chipInTimeRef,
        chipOutWrapperRef,
        chipOutTimeRef,
        stateRef: controllerStateRef,
        frameCacheRef: media.frameCacheRef,
        sampleIndexRef: media.sampleIndexRef,
        videoTrackRef: media.videoTrackRef,
        engineRef: media.engineRef,
        tinToutRef,
        trimModeRef,
        onHandleCommitted: (which, committedSeconds, shift) => {
          const current = tinToutRef.current;
          dispatch({
            type: 'in-out/set',
            tin: which === 'in' ? committedSeconds : current.tin,
            tout: which === 'out' ? committedSeconds : current.tout,
          });
          if (shift !== null) {
            dispatch({ type: 'notice/set', notice: { delta: shift.deltaSeconds, at: shift.atSeconds, which } });
          }
        },
      });
    }
    tryConstruct();

    return () => {
      cancelled = true;
      if (waitHandle !== undefined) cancelAnimationFrame(waitHandle);
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
    // (react-hooks/exhaustive-deps isn't enabled for plain .ts files in this project's eslint
    // config -- only .tsx -- so no disable comment is needed for the intentionally narrow deps.
    // dispatch is useReducer's stable identity; tinToutRef/trimModeRef are refs -- neither needs
    // to be a dependency. timelineCanvas *does* need to be one: it's what makes this effect rerun
    // -- disposing the old controller and building a fresh one -- when fullscreen unmounts and
    // remounts TimelineRegion's canvas, instead of leaving a live controller bound to a detached
    // node forever. All the state that would matter to preserve (playhead, zoom/pan, in/out drag)
    // lives in stateRef, not on the controller instance, so rebuilding here doesn't reset any of
    // it -- see TimelineController.ts's `viewportInitialized` check, which reads state.viewSpan
    // and skips re-fitting once it's already been set.)
  }, [media.file, timelineCanvas]);

  return { timelineCanvasRef, scrubOverlayCanvasRef, transportTimecodeRef, chipInRef, chipOutRef };
}
