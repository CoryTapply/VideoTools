// Waveform row draw: background, border-top, and quiet peak bars. design/README.md's "4.
// Waveform" -- 26px fixed, deliberately quiet ("reference, not the primary target"). Pure function,
// no cache/viewport access -- mirrors filmstrip.ts's shape: the caller resolves a viewport range
// into an already-fetched array before calling this.
//
// Bars are bottom-anchored (VU-meter style), not centered -- prompts/waveform-bars-prompt.md's
// change request, applied here since the request's own target (Video Trimmer.dc.html) isn't
// checked into this repo. Top corners only are chamfered, matching handles.ts's drawRoundedBar
// technique (CanvasLike has no arcTo) but asymmetric -- square at the bottom so a bar reads as
// flush against the row's floor, not floating.

import { color, rowHeight } from '../../tokens.ts';
import type { PeakColumn } from '../../../media/waveform/types.ts';
import type { CanvasLike } from '../canvas-like.ts';

/** Content band height only -- design/README.md's "4. Waveform -- 26px fixed." */
export const WAVEFORM_HEIGHT = rowHeight.waveform;

/** What a caller must actually reserve: the 26px content band plus a 1px border-top rule drawn
 * ABOVE it, as its own line -- not folded into the 26px the way ruler.ts's border-bottom is folded
 * into RULER_HEIGHT. This isn't an inconsistency to fix: design/README.md's own M1-vs-M2 filmstrip
 * arithmetic is explicit that the waveform row is "27px (26px row + 1px rule)" absorbed by the
 * filmstrip when this row isn't shown, so 27 (not 26) is the number a caller's height math needs. */
export const WAVEFORM_TOTAL_HEIGHT = WAVEFORM_HEIGHT + 1;

const BAR_WIDTH_PX = 2;
const BAR_PITCH_PX = 5;
const BAR_MIN_HEIGHT_PX = 3;
const BAR_MAX_HEIGHT_PX = 20;
const BAR_RADIUS_PX = 1;
/** Applied to the min/max-derived height, after the fact, so the tallest peaks don't touch the
 * row's top edge -- prompts/waveform-bars-prompt.md's explicit ask, not a change to BAR_MIN/MAX
 * themselves. */
const BAR_HEIGHT_SCALE = 0.9;

/** How many columns a caller should ask a WaveformCache.getRange() for to fill `widthPx` at the
 * bar pitch below -- exported so TimelineController computes the same count it draws, never a
 * second hardcoded copy of BAR_PITCH_PX. */
export function waveformBarCount(widthPx: number): number {
  return Math.max(1, Math.ceil(widthPx / BAR_PITCH_PX));
}

/** Chamfered top corners, square bottom corners -- matches handles.ts's drawRoundedBar chamfer
 * technique (CanvasLike has no arcTo) but only cuts the two top corners, so the bar's bottom edge
 * stays a flush straight line against `bottom`. */
function drawBottomAnchoredBar(ctx: CanvasLike, x: number, bottom: number, width: number, height: number, radius: number): void {
  const top = bottom - height;
  const right = x + width;
  const r = Math.min(radius, height, width / 2);
  ctx.beginPath();
  ctx.moveTo(x, bottom);
  ctx.lineTo(x, top + r);
  ctx.lineTo(x + r, top);
  ctx.lineTo(right - r, top);
  ctx.lineTo(right, top + r);
  ctx.lineTo(right, bottom);
  ctx.lineTo(x, bottom);
  ctx.fill();
}

/** A column's height-relevant amplitude: loudest channel's peak, not an average -- nothing in the
 * design or WaveformCache's own README dictates a combining rule for a single lane representing
 * possibly-stereo-or-more data, so this is a judgment call, not a spec-derived fact. `0` for a
 * channelless column (shouldn't happen in practice, but keeps the caller's null-safety simple). */
function columnPeak(col: PeakColumn): number {
  let peak = 0;
  for (const ch of col.channels) peak = Math.max(peak, Math.abs(ch.min), Math.abs(ch.max));
  return peak;
}

/**
 * `top`/`height` are the content band only (WAVEFORM_HEIGHT) -- the border-top rule is drawn at
 * `top - 0.5`, one px above it, matching WAVEFORM_TOTAL_HEIGHT's accounting. `columns[i]` is the
 * peak data for the bar at `i * BAR_PITCH_PX`; `null` (not yet built, or past the track's end)
 * draws no bar, just the background showing through. `accent` decides a non-null column's fill --
 * the caller resolves in/out-range membership (a seconds comparison against StartEnd, sidestepping
 * the video-vs-audio timescale mismatch entirely) rather than this function knowing about ticks at
 * all. Bars grow up from the row's bottom edge (VU-meter style), not out from the middle -- see
 * this file's header comment.
 *
 * Heights are normalized to the LOUDEST bar in `columns` (the current viewport, not the whole
 * track) -- that bar always reaches BAR_MAX_HEIGHT_PX regardless of its absolute amplitude, and
 * every other bar scales relative to it. This is a deliberate trade-off, not a bug: a quiet
 * passage now visually fills the row the same as a loud one (there's no longer a fixed absolute
 * amplitude-to-height mapping), in exchange for the lane always showing visible variation
 * regardless of zoom level or how quiet the visible span actually is -- the "deliberately quiet,
 * reference not primary target" framing this row was designed under is about visual weight
 * (color, size), not about being a calibrated loudness meter.
 */
export function drawWaveform(ctx: CanvasLike, widthPx: number, top: number, height: number, columns: readonly (PeakColumn | null)[], accent: (col: PeakColumn) => boolean): void {
  ctx.strokeStyle = color.borderSubtle;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, top - 0.5);
  ctx.lineTo(widthPx, top - 0.5);
  ctx.stroke();

  ctx.fillStyle = color.bgWaveform;
  ctx.fillRect(0, top, widthPx, height);

  const rowBottom = top + height;
  const barCount = waveformBarCount(widthPx);

  let maxPeak = 0;
  for (let i = 0; i < barCount; i += 1) {
    const col = columns[i] ?? null;
    if (col === null) continue;
    maxPeak = Math.max(maxPeak, columnPeak(col));
  }

  for (let i = 0; i < barCount; i += 1) {
    const col = columns[i] ?? null;
    if (col === null || col.channels.length === 0) continue;

    // maxPeak === 0 means every visible column is exactly silent -- every bar falls out to the
    // floor rather than dividing by zero (which would otherwise produce NaN, not "loud").
    const normalizedPeak = maxPeak > 0 ? columnPeak(col) / maxPeak : 0;
    const barHeight = (BAR_MIN_HEIGHT_PX + normalizedPeak * (BAR_MAX_HEIGHT_PX - BAR_MIN_HEIGHT_PX)) * BAR_HEIGHT_SCALE;
    ctx.fillStyle = accent(col) ? color.waveformAccent : color.waveformOutOfRange;
    drawBottomAnchoredBar(ctx, i * BAR_PITCH_PX, rowBottom, BAR_WIDTH_PX, barHeight, BAR_RADIUS_PX);
  }
}
