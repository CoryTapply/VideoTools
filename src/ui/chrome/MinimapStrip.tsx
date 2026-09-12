import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { RefObject } from 'react';
import { centerViewStart, playheadPct, trimBandPct, zoomCapsulePct } from '../timeline/minimap.ts';
import type { TimelineControllerState } from '../state/timeline-controller-state.ts';
import type { TrackIndex } from '../../media/index/track-index.ts';
import styles from './MinimapStrip.module.css';

export interface MinimapStripProps {
  durationSeconds: number | null;
  tstart: number;
  tend: number;
  /** Ticks -- viewStart/viewSpan/t, read every animation frame, never through React state. See
   * state/timeline-controller-state.ts. */
  controllerStateRef: RefObject<TimelineControllerState>;
  videoTrackRef: RefObject<TrackIndex | null>;
}

/**
 * Always-visible whole-file overview, sitting directly above the timeline splitter: the trim
 * selection (blue), the timeline's current zoom window (outlined capsule), and the playhead (red).
 * Dragging pans the zoom window -- it never edits trim/playhead. See ../timeline/minimap.ts for the
 * pure percentage/clamp math.
 *
 * Two update paths, matching how this app already splits state: the trim band is plain reactive
 * JSX (tstart/tend are low-frequency React state), while the zoom capsule and playhead are written
 * directly onto their DOM nodes by a self-contained rAF loop reading controllerStateRef (a 60Hz
 * ref) -- the same "controller writes DOM directly" precedent as TimelineRegion's START/END chips,
 * kept local to this component rather than extending TimelineController itself.
 */
export function MinimapStrip({ durationSeconds, tstart, tend, controllerStateRef, videoTrackRef }: MinimapStripProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let rafHandle: number;

    function tick() {
      if (cancelled) return;
      rafHandle = requestAnimationFrame(tick);

      const durationTicks = videoTrackRef.current?.duration ?? 0;
      const { viewStart, viewSpan, t } = controllerStateRef.current;

      const zoom = zoomCapsulePct(viewStart, viewSpan, durationTicks);
      if (zoomRef.current !== null) {
        zoomRef.current.style.left = `${zoom.leftPct.toString()}%`;
        zoomRef.current.style.width = `${zoom.widthPct.toString()}%`;
      }

      const playPct = playheadPct(t, durationTicks);
      if (lineRef.current !== null) lineRef.current.style.left = `${playPct.toString()}%`;
      if (dotRef.current !== null) dotRef.current.style.left = `${playPct.toString()}%`;
    }

    rafHandle = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafHandle);
    };
  }, [controllerStateRef, videoTrackRef]);

  function panToClientX(clientX: number) {
    if (trackRef.current === null) return;
    const durationTicks = videoTrackRef.current?.duration ?? 0;
    const viewSpan = controllerStateRef.current.viewSpan;
    if (durationTicks <= 0 || viewSpan <= 0) return;
    const rect = trackRef.current.getBoundingClientRect();
    const clickTicks = ((clientX - rect.left) / Math.max(1, rect.width)) * durationTicks;
    controllerStateRef.current.viewStart = centerViewStart(clickTicks, viewSpan, durationTicks);
  }

  function handlePointerDown(evt: ReactPointerEvent<HTMLDivElement>) {
    draggingRef.current = true;
    evt.currentTarget.setPointerCapture(evt.pointerId);
    panToClientX(evt.clientX);
  }

  function handlePointerMove(evt: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    panToClientX(evt.clientX);
  }

  function handlePointerUp(evt: ReactPointerEvent<HTMLDivElement>) {
    draggingRef.current = false;
    evt.currentTarget.releasePointerCapture(evt.pointerId);
  }

  const trimBand = trimBandPct(tstart, tend, durationSeconds ?? 0);

  return (
    <div
      className={styles.root}
      title="Whole file — drag to move the zoom window"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <div ref={trackRef} className={styles.track}>
        <div className={styles.trimBand} style={{ left: `${trimBand.leftPct.toString()}%`, width: `${trimBand.widthPct.toString()}%` }} />
        <div ref={zoomRef} className={styles.zoomCapsule} />
        <div ref={lineRef} className={styles.playheadLine} />
        <div ref={dotRef} className={styles.playheadDot} />
      </div>
    </div>
  );
}
