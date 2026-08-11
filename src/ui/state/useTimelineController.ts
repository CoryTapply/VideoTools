// Constructs one TimelineController per open file and tears it down on close/unmount -- the glue
// between useMediaSession's resource refs and the two canvases it draws onto (the timeline itself,
// and the drag-scrub preview overlaying PreviewSurface's <video>). Mirrors media-session.ts's own
// "resource-shaped state doesn't belong in the reducer" precedent: this hook touches the DOM/canvas
// directly, so it stays out of app-state.ts entirely.

import { useEffect, useRef } from 'react';
import { TimelineController } from '../timeline/TimelineController.ts';
import type { Dispatch, RefObject } from 'react';
import type { AppAction, TrimMode } from './app-state.ts';
import type { MediaSession } from './media-session.ts';
import type { TimelineControllerState } from './timeline-controller-state.ts';

export interface TimelineControllerHandle {
  timelineCanvasRef: RefObject<HTMLCanvasElement | null>;
  scrubOverlayCanvasRef: RefObject<HTMLCanvasElement | null>;
  /** TransportBar's timecode node -- TimelineController writes textContent into it directly from
   * its rAF loop once constructed; see TransportBar.tsx's own doc comment. */
  transportTimecodeRef: RefObject<HTMLDivElement | null>;
}

export function useTimelineController(
  media: MediaSession,
  controllerStateRef: RefObject<TimelineControllerState>,
  dispatch: Dispatch<AppAction>,
  trimMode: TrimMode,
  tin: number,
  tout: number,
): TimelineControllerHandle {
  const timelineCanvasRef = useRef<HTMLCanvasElement>(null);
  const scrubOverlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const transportTimecodeRef = useRef<HTMLDivElement>(null);
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
    if (media.file === null) return;
    let cancelled = false;
    let waitHandle: number | undefined;

    // Both canvases mount around the same time (PreviewSurface's overlay canvas only appears once
    // `videoRef` is defined, same as the timeline's), but not necessarily on the same render --
    // poll rather than assume, same pattern as media-session.ts's waitForVideoElement.
    function tryConstruct() {
      if (cancelled) return;
      const canvas = timelineCanvasRef.current;
      const previewCanvas = scrubOverlayCanvasRef.current;
      if (canvas === null || previewCanvas === null) {
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
    // to be a dependency.)
  }, [media.file]);

  return { timelineCanvasRef, scrubOverlayCanvasRef, transportTimecodeRef };
}
