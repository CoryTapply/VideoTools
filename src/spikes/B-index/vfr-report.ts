// Spike B / Step 5 -- VFR characterization. See prompts/m0.5-spike-prompts.md Step 5.
// The point is a hard "no" to "can I assume a fixed frame rate": report whether durations are
// actually constant, their spread, and how far off a naive "most common duration" assumption
// would be from reality.

import type { TrackIndex } from '../A-remux/mp4-index';

export interface VfrReport {
  sampleCount: number;
  constant: boolean;
  distinctDurationCount: number;
  minDurationSec: number;
  maxDurationSec: number;
  medianDurationSec: number;
  /** Most frequent sample duration -- "if you assumed one fixed rate, this is the one you'd guess." */
  modeDurationSec: number;
  impliedNominalFps: number;
  /** sampleCount / total track duration -- the TRUE average rate, for comparison against the naive nominal guess. */
  averageFps: number;
}

function sampleDurations(track: TrackIndex): Float64Array {
  const n = track.sampleCount;
  const durations = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    durations[i] = i + 1 < n ? track.dts[i + 1]! - track.dts[i]! : Math.max(1, track.mediaDuration - track.dts[i]!);
  }
  return durations;
}

export function reportVfr(track: TrackIndex): VfrReport {
  const durations = sampleDurations(track);
  const sorted = Float64Array.from(durations).sort();
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const median = sorted[Math.floor(sorted.length / 2)]!;

  const counts = new Map<number, number>();
  for (const d of durations) counts.set(d, (counts.get(d) ?? 0) + 1);
  let modeDuration = durations[0]!;
  let modeCount = 0;
  for (const [d, c] of counts) {
    if (c > modeCount) {
      modeCount = c;
      modeDuration = d;
    }
  }

  const totalDurationTicks = track.dts[track.sampleCount - 1]! + durations[durations.length - 1]! - track.dts[0]!;
  const totalDurationSec = totalDurationTicks / track.timescale;

  return {
    sampleCount: track.sampleCount,
    constant: min === max,
    distinctDurationCount: counts.size,
    minDurationSec: min / track.timescale,
    maxDurationSec: max / track.timescale,
    medianDurationSec: median / track.timescale,
    modeDurationSec: modeDuration / track.timescale,
    impliedNominalFps: track.timescale / modeDuration,
    averageFps: track.sampleCount / totalDurationSec,
  };
}
