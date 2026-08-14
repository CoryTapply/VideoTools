// Adaptive ruler tick generation -- design/README.md's Ruler row: step chosen from a fixed
// candidate list (frames, then seconds) by on-screen width, minor ticks at step/5 drawn only when
// they'd be legible. Major labels use formatDurationCompact's "1h 23m 04s" unit style at every
// zoom band (this deviates from design/README.md's HH:MM/HH:MM:SS/MM:SS:FF spec, which is now
// stale). Pure: no canvas, no DOM.

import { formatDurationCompact } from '../state/snap-notice.ts';
import { timeToX } from './viewport.ts';
import type { Time, Viewport } from './types.ts';

interface TickCandidate {
  kind: 'frames' | 'seconds';
  amount: number;
}

/** design/README.md's Ruler section, verbatim: [1f, 2f, 5f, 10f, 0.5s, 1s, 2s, 5s, 10s, 30s, 1m, 2m, 5m, 10m, 30m, 1h]. */
const TICK_CANDIDATES: readonly TickCandidate[] = [
  { kind: 'frames', amount: 1 },
  { kind: 'frames', amount: 2 },
  { kind: 'frames', amount: 5 },
  { kind: 'frames', amount: 10 },
  { kind: 'seconds', amount: 0.5 },
  { kind: 'seconds', amount: 1 },
  { kind: 'seconds', amount: 2 },
  { kind: 'seconds', amount: 5 },
  { kind: 'seconds', amount: 10 },
  { kind: 'seconds', amount: 30 },
  { kind: 'seconds', amount: 60 },
  { kind: 'seconds', amount: 120 },
  { kind: 'seconds', amount: 300 },
  { kind: 'seconds', amount: 600 },
  { kind: 'seconds', amount: 1800 },
  { kind: 'seconds', amount: 3600 },
];

/** The first candidate whose on-screen width is >= this is chosen. */
export const MIN_MAJOR_TICK_PX = 90;
/** Minor ticks (step/5) are only drawn when at least this far apart on screen. */
export const MIN_MINOR_TICK_PX = 13;

function candidateTicks(candidate: TickCandidate, timescale: number, ticksPerFrame: Time): Time {
  return candidate.kind === 'frames' ? candidate.amount * ticksPerFrame : candidate.amount * timescale;
}

/** Ticks-per-major-tick, chosen so the major tick spacing is >= MIN_MAJOR_TICK_PX on screen. */
export function chooseTickStep(viewport: Viewport, timescale: number, ticksPerFrame: Time): Time {
  if (viewport.viewSpan <= 0 || viewport.widthPx <= 0) return timescale;
  for (const candidate of TICK_CANDIDATES) {
    const stepTicks = candidateTicks(candidate, timescale, ticksPerFrame);
    const px = (stepTicks / viewport.viewSpan) * viewport.widthPx;
    if (px >= MIN_MAJOR_TICK_PX) return stepTicks;
  }
  const last = TICK_CANDIDATES[TICK_CANDIDATES.length - 1];
  return candidateTicks(last, timescale, ticksPerFrame);
}

export interface RulerTick {
  time: Time;
  x: number;
  major: boolean;
  /** Only set on major ticks -- the label text to draw, already truncated for the current zoom band. */
  label: string | null;
}

/** All ruler ticks currently on screen, major and minor, with labels pre-formatted on majors. */
export function generateRulerTicks(viewport: Viewport, timescale: number, ticksPerFrame: Time): RulerTick[] {
  if (viewport.viewSpan <= 0 || viewport.widthPx <= 0) return [];
  const stepTicks = chooseTickStep(viewport, timescale, ticksPerFrame);
  const minorStepTicks = stepTicks / 5;
  const minorPx = (minorStepTicks / viewport.viewSpan) * viewport.widthPx;
  const drawMinor = minorPx >= MIN_MINOR_TICK_PX;
  const end = viewport.viewStart + viewport.viewSpan;

  const ticks: RulerTick[] = [];
  const step = drawMinor ? minorStepTicks : stepTicks;
  const first = Math.floor(viewport.viewStart / step) * step;
  for (let t = first; t <= end; t += step) {
    const majorIndex = t / stepTicks;
    const isMajor = Math.abs(majorIndex - Math.round(majorIndex)) < 1e-6;
    ticks.push({
      time: t,
      x: timeToX(t, viewport.viewStart, viewport.viewSpan, viewport.widthPx),
      major: isMajor,
      label: isMajor ? formatDurationCompact(t / timescale) : null,
    });
  }
  return ticks;
}
