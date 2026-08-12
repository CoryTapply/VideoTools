// The imperative controller Task 4b's seam (state/timeline-controller-state.ts) was pre-built
// for: a requestAnimationFrame loop that reads/writes TimelineControllerState directly and draws
// the canvas layer stack, so playhead movement and (once later stages land) pan/zoom/drag never
// touch React. Stage 2 (this file, initially): fixed-viewport static draw of ruler, keyframe row,
// filmstrip, and playhead. Wheel/pointer gesture handling lands in later stages on top of this
// same class.

import { secondsToTicks, ticksToSeconds } from '../../media/index/time.ts';
import { formatTimecode } from '../state/snap-notice.ts';
import { color } from '../tokens.ts';
import { wrapCanvasContext } from './canvas-like.ts';
import { clampHandleDrag, edgeX, hitTestHandle, scrubTimeFromPointer } from './drag-gesture.ts';
import { drawFilmstrip, FILMSTRIP_TILE_WIDTH_PX } from './draw/filmstrip.ts';
import { drawHandles } from './draw/handles.ts';
import { drawKeyframeRow, KEYFRAME_ROW_HEIGHT, KEYFRAME_ROW_TOP } from './draw/keyframe-row.ts';
import { drawPlayhead } from './draw/playhead.ts';
import { drawRuler } from './draw/ruler.ts';
import { drawScrubPreview } from './draw/scrub-preview.ts';
import { drawSnapFlash, snapFlashOpacity } from './draw/snap-flash.ts';
import { decayVelocity, isCoastingDone, updateVelocity } from './kinetic-pan.ts';
import { describeSeekDrift } from './seek-drift.ts';
import { snapToViewport } from './snap.ts';
import { fitToDuration, panByPixels, timeToX, zoomAtCursor } from './viewport.ts';
import { isZoomGesture, wheelPanDeltaPx, wheelZoomFactor } from './wheel-gesture.ts';
import type { CanvasLike } from './canvas-like.ts';
import type { FrameCache } from '../../media/frames/FrameCache.ts';
import type { SampleIndex } from '../../media/index/query.ts';
import type { TrackIndex } from '../../media/index/track-index.ts';
import type { NativeVideoEngine } from '../../media/playback/NativeVideoEngine.ts';
import type { Unsubscribe } from '../../media/playback/PlaybackEngine.ts';
import type { RefObject } from 'react';
import type { TrimMode } from '../state/app-state.ts';
import type { TimelineControllerState } from '../state/timeline-controller-state.ts';
import type { SeekDriftReport } from './seek-drift.ts';
import type { Time, Viewport } from './types.ts';

/** In/out points, seconds -- the same shape app-state.ts's tin/tout live in. */
export interface TinTout {
  tin: number;
  tout: number;
}

/** Non-null only when keyframe enforcement actually moved the released edge -- design/README.md's
 * "If that moves the edge at all, state records {delta, at, which}." */
export interface KeyframeShift {
  deltaSeconds: number;
  atSeconds: number;
}

export interface TimelineControllerDeps {
  canvas: HTMLCanvasElement;
  /** The drag-scrub preview surface, overlaying the real <video> -- see
   * chrome/PreviewSurface.tsx's scrubOverlayRef and design/README.md's cache-only-scrub note. */
  previewCanvas: HTMLCanvasElement;
  /** TransportBar's timecode node -- written to directly every tick, bypassing React. */
  transportTimecodeRef: RefObject<HTMLDivElement | null>;
  stateRef: RefObject<TimelineControllerState>;
  frameCacheRef: RefObject<FrameCache | null>;
  sampleIndexRef: RefObject<SampleIndex | null>;
  videoTrackRef: RefObject<TrackIndex | null>;
  engineRef: RefObject<NativeVideoEngine | null>;
  /** Seconds -- read live on every handle-drag pointer event, so this must always reflect the
   * latest app-state.ts tin/tout, not a value captured at construction time. */
  tinToutRef: RefObject<TinTout>;
  trimModeRef: RefObject<TrimMode>;
  /** Fired once per handle release with the (possibly keyframe-enforced) committed value.
   * `shift` is non-null only when enforcement moved the edge, matching the status-bar notice's
   * own gating. The hook turns this into an `in-out/set` (+ `notice/set` when shift !== null)
   * dispatch -- this class never dispatches directly, only reports outcomes. */
  onHandleCommitted: (which: 'in' | 'out', committedSeconds: number, shift: KeyframeShift | null) => void;
}

export class TimelineController {
  private readonly canvas: HTMLCanvasElement;
  private readonly rawCtx: CanvasRenderingContext2D;
  private readonly ctx: CanvasLike;
  private readonly previewCanvas: HTMLCanvasElement;
  private readonly previewRawCtx: CanvasRenderingContext2D;
  private readonly previewCtx: CanvasLike;
  private readonly transportTimecodeRef: RefObject<HTMLDivElement | null>;
  private readonly stateRef: RefObject<TimelineControllerState>;
  private readonly frameCacheRef: RefObject<FrameCache | null>;
  private readonly sampleIndexRef: RefObject<SampleIndex | null>;
  private readonly videoTrackRef: RefObject<TrackIndex | null>;
  private readonly engineRef: RefObject<NativeVideoEngine | null>;
  private readonly tinToutRef: RefObject<TinTout>;
  private readonly trimModeRef: RefObject<TrimMode>;
  private readonly onHandleCommitted: (which: 'in' | 'out', committedSeconds: number, shift: KeyframeShift | null) => void;
  private readonly resizeObserver: ResizeObserver | undefined;
  private readonly previewResizeObserver: ResizeObserver | undefined;

  private rafHandle: number | undefined;
  private engineWaitHandle: number | undefined;
  private unsubscribeFrame: Unsubscribe | undefined;
  private disposed = false;
  private viewportInitialized = false;
  private cachedTrackId: number | undefined;
  private cachedKeyframeTimes: Float64Array = new Float64Array(0);
  private lastWheelPanTime: number | undefined;
  private lastCoastTickTime: number | undefined;

  constructor(deps: TimelineControllerDeps) {
    const ctx2d = deps.canvas.getContext('2d');
    if (ctx2d === null) throw new Error('TimelineController: 2D canvas context unavailable');
    const previewCtx2d = deps.previewCanvas.getContext('2d');
    if (previewCtx2d === null) throw new Error('TimelineController: preview canvas 2D context unavailable');
    this.canvas = deps.canvas;
    this.rawCtx = ctx2d;
    this.ctx = wrapCanvasContext(ctx2d);
    this.previewCanvas = deps.previewCanvas;
    this.previewRawCtx = previewCtx2d;
    this.previewCtx = wrapCanvasContext(previewCtx2d);
    this.transportTimecodeRef = deps.transportTimecodeRef;
    this.stateRef = deps.stateRef;
    this.frameCacheRef = deps.frameCacheRef;
    this.sampleIndexRef = deps.sampleIndexRef;
    this.videoTrackRef = deps.videoTrackRef;
    this.engineRef = deps.engineRef;
    this.tinToutRef = deps.tinToutRef;
    this.trimModeRef = deps.trimModeRef;
    this.onHandleCommitted = deps.onHandleCommitted;

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.resizeBackingStore();
      });
      this.resizeObserver.observe(this.canvas);
      this.previewResizeObserver = new ResizeObserver(() => {
        this.resizePreviewBackingStore();
      });
      this.previewResizeObserver.observe(this.previewCanvas);
    }
    this.resizeBackingStore();
    this.resizePreviewBackingStore();
    this.rafHandle = requestAnimationFrame(this.tick);
    this.waitForEngine();
    // React's synthetic onWheel is passive and can't preventDefault() -- design/README.md's
    // Pointer/zoom semantics note. Bound imperatively here instead.
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafHandle !== undefined) cancelAnimationFrame(this.rafHandle);
    if (this.engineWaitHandle !== undefined) cancelAnimationFrame(this.engineWaitHandle);
    this.unsubscribeFrame?.();
    this.resizeObserver?.disconnect();
    this.previewResizeObserver?.disconnect();
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
  }

  /** pointerdown hit-tests the in/out handles first (32px zones -- design/README.md); a miss
   * falls back to a general playhead drag-scrub. Both kinds of drag only move the cache/controller
   * state while active -- PlaybackEngine.seek() is never called mid-drag (a real <video> seek is
   * 281ms p50, 17x too slow for 60Hz). onPointerUp settles: one seek for a scrub, one commit
   * (with keyframe enforcement in copy mode) for a handle. */
  private onPointerDown = (evt: PointerEvent): void => {
    const videoTrack = this.videoTrackRef.current;
    const widthPx = this.canvas.clientWidth;
    if (videoTrack === null || widthPx <= 0) return;
    this.canvas.setPointerCapture(evt.pointerId);
    const state = this.stateRef.current;
    // Any new gesture pre-empts a kinetic coast in progress -- design intent carried over from
    // onWheel's own zoom-gesture handling.
    state.panVelocityTicksPerMs = 0;
    const rect = this.canvas.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const viewport: Viewport = { viewStart: state.viewStart, viewSpan: state.viewSpan, widthPx };
    const tinTout = this.tinToutRef.current;
    const inTicks = secondsToTicks(tinTout.tin, videoTrack.timescale);
    const outTicks = secondsToTicks(tinTout.tout, videoTrack.timescale);
    const hit = hitTestHandle(x, edgeX(inTicks, viewport), edgeX(outTicks, viewport));

    if (hit !== null) {
      state.drag = hit;
      state.dragValueTicks = hit === 'in' ? inTicks : outTicks;
      return;
    }
    state.scrubActive = true;
    this.updateScrubTime(evt);
  };

  private onPointerMove = (evt: PointerEvent): void => {
    const state = this.stateRef.current;
    if (state.drag !== null) {
      this.updateHandleDrag(evt, state.drag, evt.altKey);
      return;
    }
    if (!state.scrubActive) return;
    this.updateScrubTime(evt);
  };

  private onPointerUp = (evt: PointerEvent): void => {
    if (this.canvas.hasPointerCapture(evt.pointerId)) this.canvas.releasePointerCapture(evt.pointerId);
    const state = this.stateRef.current;
    if (state.drag !== null) {
      this.commitHandleDrag(state.drag);
      return;
    }
    if (!state.scrubActive) return;
    state.scrubActive = false;
    const engine = this.engineRef.current;
    if (engine === null) return;
    const requestedTicks = state.t;
    void engine.seek(requestedTicks, 'accurate').then(() => {
      this.logSeekDrift(requestedTicks, engine.currentTime);
    });
  };

  /** Task 4c diagnostic: architecture-v3.md flags settle-seeks occasionally landing one frame off
   * "after heavy decoder activity" but it was never conclusively reproduced (roadmap.md's Task 4c)
   * -- automation throttles rAF and the committed tiny fixture never finishes loading in a real
   * <video>. Rather than eyeball it, every real settle-seek self-reports here. Dev-only: Vite
   * dead-code-eliminates the whole block (and this.seekDriftLog's cost) from production builds. */
  private logSeekDrift(requestedTicks: Time, landedTicks: Time): void {
    if (!import.meta.env.DEV) return;
    const index = this.sampleIndexRef.current;
    const videoTrack = this.videoTrackRef.current;
    if (index === null || videoTrack === null) return;
    const report = describeSeekDrift(requestedTicks, landedTicks, index, videoTrack.trackId);
    const w = window as unknown as { __seekDriftLog?: SeekDriftReport[] };
    w.__seekDriftLog ??= [];
    w.__seekDriftLog.push(report);
    if (report.framesOff !== 0) {
      console.warn(
        `[seek-drift] settle-seek landed ${String(report.framesOff)} frame(s) off -- requested frame ${String(report.requestedFrame)} (${String(requestedTicks)} ticks), landed frame ${String(report.landedFrame)} (${String(landedTicks)} ticks)`,
      );
    }
  }

  private updateScrubTime(evt: PointerEvent): void {
    const videoTrack = this.videoTrackRef.current;
    const widthPx = this.canvas.clientWidth;
    if (videoTrack === null || widthPx <= 0) return;
    const state = this.stateRef.current;
    const rect = this.canvas.getBoundingClientRect();
    const viewport: Viewport = { viewStart: state.viewStart, viewSpan: state.viewSpan, widthPx };
    state.t = scrubTimeFromPointer(evt.clientX - rect.left, viewport, videoTrack.duration);
  }

  private updateHandleDrag(evt: PointerEvent, which: 'in' | 'out', altKey: boolean): void {
    const videoTrack = this.videoTrackRef.current;
    const widthPx = this.canvas.clientWidth;
    if (videoTrack === null || widthPx <= 0) return;
    const state = this.stateRef.current;
    const rect = this.canvas.getBoundingClientRect();
    const viewport: Viewport = { viewStart: state.viewStart, viewSpan: state.viewSpan, widthPx };
    const tinTout = this.tinToutRef.current;
    const oppositeTicks = which === 'in' ? secondsToTicks(tinTout.tout, videoTrack.timescale) : secondsToTicks(tinTout.tin, videoTrack.timescale);

    const raw = scrubTimeFromPointer(evt.clientX - rect.left, viewport, videoTrack.duration);
    const clamped = clampHandleDrag(which, raw, oppositeTicks, videoTrack.duration, videoTrack.timescale);

    let finalTicks = clamped;
    if (!altKey) {
      const snapped = snapToViewport(
        clamped,
        { keyframeTimes: this.keyframeTimesFor(videoTrack), playhead: state.t, duration: videoTrack.duration, oppositeHandle: oppositeTicks },
        viewport,
      );
      if (snapped !== clamped) state.snapFlash = performance.now();
      finalTicks = snapped;
    }
    state.dragValueTicks = finalTicks;
  }

  /** design/README.md's "core interaction": on release in copy mode, the edge is forced outward
   * to a real keyframe (in floors, out ceils) so the exported range never loses content. */
  private commitHandleDrag(which: 'in' | 'out'): void {
    const state = this.stateRef.current;
    const videoTrack = this.videoTrackRef.current;
    const draggedTicks = state.dragValueTicks;
    state.drag = null;
    state.dragValueTicks = null;
    if (videoTrack === null || draggedTicks === null) return;

    const committedTicks = this.trimModeRef.current === 'copy' ? this.enforceKeyframe(which, draggedTicks, videoTrack) : draggedTicks;
    const committedSeconds = ticksToSeconds(committedTicks, videoTrack.timescale);
    let shift: KeyframeShift | null = null;
    if (committedTicks !== draggedTicks) {
      shift = { deltaSeconds: committedSeconds - ticksToSeconds(draggedTicks, videoTrack.timescale), atSeconds: committedSeconds };
    }
    this.onHandleCommitted(which, committedSeconds, shift);
  }

  private enforceKeyframe(which: 'in' | 'out', t: Time, videoTrack: TrackIndex): Time {
    const sampleIndex = this.sampleIndexRef.current;
    if (sampleIndex === null) return t;
    const trackId = videoTrack.trackId;
    if (which === 'in') {
      const sample = sampleIndex.nearestSyncAtOrBeforePresentation(trackId, t);
      return sample === -1 ? t : sampleIndex.presentationTimeOfSample(trackId, sample);
    }
    const atOrBefore = sampleIndex.nearestSyncAtOrBeforePresentation(trackId, t);
    if (atOrBefore !== -1 && sampleIndex.presentationTimeOfSample(trackId, atOrBefore) === t) return t;
    const sample = sampleIndex.nextSyncPresentation(trackId, t);
    return sample === -1 ? t : sampleIndex.presentationTimeOfSample(trackId, sample);
  }

  private onWheel = (evt: WheelEvent): void => {
    evt.preventDefault();
    const videoTrack = this.videoTrackRef.current;
    if (videoTrack?.video === undefined) return;
    const widthPx = this.canvas.clientWidth;
    if (widthPx <= 0) return;

    const state = this.stateRef.current;
    const viewport: Viewport = { viewStart: state.viewStart, viewSpan: state.viewSpan, widthPx };
    const timescale = videoTrack.timescale;
    const durationTicks = videoTrack.duration;
    const nominalFrameRate = videoTrack.video.nominalFrameRate;
    const ticksPerFrame = nominalFrameRate > 0 ? timescale / nominalFrameRate : 0;

    if (isZoomGesture(evt)) {
      const cursorX = evt.offsetX;
      const zoomed = zoomAtCursor(viewport, cursorX, wheelZoomFactor(evt.deltaY), ticksPerFrame, durationTicks);
      state.viewStart = zoomed.viewStart;
      state.viewSpan = zoomed.viewSpan;
      state.panVelocityTicksPerMs = 0;
    } else {
      const deltaPx = wheelPanDeltaPx(evt.deltaX, evt.deltaY);
      state.viewStart = panByPixels(viewport, deltaPx, durationTicks);
      const now = performance.now();
      const dtMs = this.lastWheelPanTime !== undefined ? now - this.lastWheelPanTime : 0;
      const deltaTicks = (deltaPx / widthPx) * viewport.viewSpan;
      state.panVelocityTicksPerMs = dtMs > 0 ? updateVelocity(state.panVelocityTicksPerMs, deltaTicks, dtMs) : state.panVelocityTicksPerMs;
      this.lastWheelPanTime = now;
    }

    const frameCache = this.frameCacheRef.current;
    if (frameCache !== null && state.viewSpan > 0) {
      const pixelsPerSecond = (widthPx * timescale) / state.viewSpan;
      frameCache.setViewport(state.viewStart, state.viewStart + state.viewSpan, pixelsPerSecond);
    }
  };

  /** The engine is constructed asynchronously, after this controller (see media-session.ts's
   * openFile: engineRef.current is set only once waitForVideoElement resolves). Poll rather than
   * assume it's already there by construction time -- same pattern as waitForVideoElement itself. */
  private waitForEngine(): void {
    const engine = this.engineRef.current;
    if (engine !== null) {
      this.unsubscribeFrame = engine.onFrame((t) => {
        this.stateRef.current.t = t;
      });
      return;
    }
    this.engineWaitHandle = requestAnimationFrame(() => {
      this.waitForEngine();
    });
  }

  private resizeBackingStore(): void {
    const dpr = window.devicePixelRatio || 1;
    const widthPx = this.canvas.clientWidth;
    const heightPx = this.canvas.clientHeight;
    const backingWidth = Math.max(1, Math.round(widthPx * dpr));
    const backingHeight = Math.max(1, Math.round(heightPx * dpr));
    if (this.canvas.width !== backingWidth) this.canvas.width = backingWidth;
    if (this.canvas.height !== backingHeight) this.canvas.height = backingHeight;
    // Resizing the backing store resets any prior transform, so this is always a fresh scale.
    this.rawCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const state = this.stateRef.current;
    state.tlW = widthPx;
  }

  private resizePreviewBackingStore(): void {
    const dpr = window.devicePixelRatio || 1;
    const widthPx = this.previewCanvas.clientWidth;
    const heightPx = this.previewCanvas.clientHeight;
    const backingWidth = Math.max(1, Math.round(widthPx * dpr));
    const backingHeight = Math.max(1, Math.round(heightPx * dpr));
    if (this.previewCanvas.width !== backingWidth) this.previewCanvas.width = backingWidth;
    if (this.previewCanvas.height !== backingHeight) this.previewCanvas.height = backingHeight;
    this.previewRawCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private tick = (): void => {
    if (this.disposed) return;
    this.draw();
    this.rafHandle = requestAnimationFrame(this.tick);
  };

  private keyframeTimesFor(videoTrack: TrackIndex): Float64Array {
    if (this.cachedTrackId === videoTrack.trackId) return this.cachedKeyframeTimes;
    const sampleIndex = this.sampleIndexRef.current;
    this.cachedTrackId = videoTrack.trackId;
    this.cachedKeyframeTimes = sampleIndex !== null ? sampleIndex.keyframePresentationTimes(videoTrack.trackId) : new Float64Array(0);
    return this.cachedKeyframeTimes;
  }

  /** Coasts the viewport once a pan gesture ends -- see ./kinetic-pan.ts. No-ops while a wheel
   * gesture is still actively updating panVelocityTicksPerMs itself (that's onWheel's job), and
   * self-terminates once velocity decays below a per-zoom-level stop threshold or the viewport
   * hits either duration clamp. */
  private applyKineticCoast(state: TimelineControllerState, durationTicks: Time, widthPx: number, timescale: Time): void {
    const now = performance.now();
    const lastCoastTime = this.lastCoastTickTime;
    this.lastCoastTickTime = now;
    if (lastCoastTime === undefined || state.panVelocityTicksPerMs === 0) return;

    const wheelActive = this.lastWheelPanTime !== undefined && now - this.lastWheelPanTime < 120;
    if (wheelActive) return;

    const stopThresholdTicksPerMs = widthPx > 0 ? (0.02 / widthPx) * state.viewSpan : 0;
    if (isCoastingDone(state.panVelocityTicksPerMs, stopThresholdTicksPerMs)) {
      state.panVelocityTicksPerMs = 0;
      return;
    }

    const frameDtMs = now - lastCoastTime;
    const maxStart = Math.max(0, durationTicks - state.viewSpan);
    const nextViewStart = Math.min(Math.max(0, state.viewStart + state.panVelocityTicksPerMs * frameDtMs), maxStart);
    state.viewStart = nextViewStart;
    state.panVelocityTicksPerMs = nextViewStart === 0 || nextViewStart === maxStart ? 0 : decayVelocity(state.panVelocityTicksPerMs, frameDtMs);

    const frameCache = this.frameCacheRef.current;
    if (frameCache !== null && state.viewSpan > 0) {
      const pixelsPerSecond = (widthPx * timescale) / state.viewSpan;
      frameCache.setViewport(state.viewStart, state.viewStart + state.viewSpan, pixelsPerSecond);
    }
  }

  private draw(): void {
    const widthPx = this.canvas.clientWidth;
    const heightPx = this.canvas.clientHeight;
    if (widthPx <= 0 || heightPx <= 0) return;

    this.ctx.fillStyle = color.bgBase;
    this.ctx.fillRect(0, 0, widthPx, heightPx);

    const videoTrack = this.videoTrackRef.current;
    if (videoTrack?.video === undefined) return;
    const state = this.stateRef.current;
    state.tlW = widthPx;

    const timescale = videoTrack.timescale;
    const durationTicks = videoTrack.duration;
    this.applyKineticCoast(state, durationTicks, widthPx, timescale);
    if (!this.viewportInitialized || state.viewSpan <= 0) {
      const fit = fitToDuration(durationTicks);
      state.viewStart = fit.viewStart;
      state.viewSpan = fit.viewSpan;
      this.viewportInitialized = true;
    }

    const viewport: Viewport = { viewStart: state.viewStart, viewSpan: state.viewSpan, widthPx };
    const nominalFrameRate = videoTrack.video.nominalFrameRate;
    const ticksPerFrame = nominalFrameRate > 0 ? timescale / nominalFrameRate : 0;
    const fps = nominalFrameRate > 0 ? nominalFrameRate : 60;

    const tinTout = this.tinToutRef.current;
    const inTicks = state.drag === 'in' && state.dragValueTicks !== null ? state.dragValueTicks : secondsToTicks(tinTout.tin, timescale);
    const outTicks = state.drag === 'out' && state.dragValueTicks !== null ? state.dragValueTicks : secondsToTicks(tinTout.tout, timescale);

    drawRuler(this.ctx, widthPx, viewport, timescale, ticksPerFrame, fps);
    drawKeyframeRow(this.ctx, widthPx, viewport, this.keyframeTimesFor(videoTrack), { accentTimes: [inTicks, outTicks] });

    const filmstripTop = KEYFRAME_ROW_TOP + KEYFRAME_ROW_HEIGHT;
    const filmstripHeight = Math.max(0, heightPx - filmstripTop);
    const tileCount = Math.max(1, Math.ceil(widthPx / FILMSTRIP_TILE_WIDTH_PX) + 1);
    const frameCache = this.frameCacheRef.current;
    const tiles =
      frameCache !== null
        ? frameCache.getRange(viewport.viewStart, viewport.viewStart + viewport.viewSpan, tileCount).map((f) => f?.bitmap ?? null)
        : new Array<null>(tileCount).fill(null);
    drawFilmstrip(this.ctx, widthPx, filmstripTop, filmstripHeight, tiles);

    const inX = timeToX(inTicks, viewport.viewStart, viewport.viewSpan, widthPx);
    const outX = timeToX(outTicks, viewport.viewStart, viewport.viewSpan, widthPx);
    const chipLabel = state.drag !== null ? formatTimecode(ticksToSeconds(state.drag === 'in' ? inTicks : outTicks, timescale) * fps, fps) : null;
    drawHandles(this.ctx, widthPx, { inX, outX, heightPx, drag: state.drag }, chipLabel);

    if (state.snapFlash !== null) {
      const opacity = snapFlashOpacity(state.snapFlash, performance.now());
      if (opacity === null) {
        state.snapFlash = null;
      } else {
        const flashX = state.drag === 'out' ? outX : inX;
        drawSnapFlash(this.ctx, flashX, heightPx, opacity);
      }
    }

    const playheadX = timeToX(state.t, viewport.viewStart, viewport.viewSpan, widthPx);
    drawPlayhead(this.ctx, playheadX, 0, heightPx);

    this.drawPreviewOverlay(state.scrubActive ? state.t : null);

    // Bypasses React entirely -- TransportBar.tsx's own doc comment; playhead movement must never
    // trigger a re-render.
    const timecodeEl = this.transportTimecodeRef.current;
    if (timecodeEl !== null) {
      timecodeEl.textContent = formatTimecode(ticksToSeconds(state.t, timescale) * fps, fps);
    }
  }

  /** Draws the cached frame nearest `scrubTime` over the real <video>, or clears the overlay
   * (letting the video show through) when not scrubbing. */
  private drawPreviewOverlay(scrubTime: number | null): void {
    const widthPx = this.previewCanvas.clientWidth;
    const heightPx = this.previewCanvas.clientHeight;
    if (widthPx <= 0 || heightPx <= 0) return;
    if (scrubTime === null) {
      this.previewCtx.clearRect(0, 0, widthPx, heightPx);
      return;
    }
    const frame = this.frameCacheRef.current?.getNearest(scrubTime) ?? null;
    drawScrubPreview(this.previewCtx, widthPx, heightPx, frame?.bitmap ?? null);
  }
}
