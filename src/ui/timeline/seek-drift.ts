// Task 4c: diagnostic for the "seek lands one frame off after heavy decoder activity" behavior
// architecture-v3.md asks to be characterized (see roadmap.md's Task 4c). Pure/DOM-free by
// design, same as kinetic-pan.ts/shuttle.ts, so the frame-index comparison itself is unit
// testable without a real <video> element -- TimelineController.ts wires this to the real
// settle-seek call site and does the DOM-facing logging.

import type { SampleIndex } from '../../media/index/query.ts';
import type { Time } from './types.ts';

export interface SeekDriftReport {
  requestedTicks: Time;
  landedTicks: Time;
  requestedFrame: number;
  landedFrame: number;
  /** landedFrame - requestedFrame. Zero means the settle-seek landed on the requested frame. */
  framesOff: number;
}

/** Compares the settle-seek's requested position against where the engine actually landed, in
 * frame-index space rather than raw ticks -- two tick values can differ while still mapping to
 * the same decode-order sample (e.g. sub-frame rounding), which must NOT be reported as drift. */
export function describeSeekDrift(requestedTicks: Time, landedTicks: Time, index: SampleIndex, trackId: number): SeekDriftReport {
  const requestedFrame = index.frameAtPresentationTime(trackId, requestedTicks);
  const landedFrame = index.frameAtPresentationTime(trackId, landedTicks);
  return { requestedTicks, landedTicks, requestedFrame, landedFrame, framesOff: landedFrame - requestedFrame };
}
