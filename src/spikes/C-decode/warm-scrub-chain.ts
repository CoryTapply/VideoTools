// Spike C / Step 2 (warm-decoder sub-experiment) -- builds a forward-scrubbing sequence of
// targets and the sample segments needed to feed a SINGLE decoder continuously from one target
// to the next, instead of restarting from a keyframe at every stop. Simulates a user dragging
// the scrub bar forward: after the first (unavoidably cold) stop, does keeping the decoder warm
// and feeding forward from the CURRENT position make subsequent stops cheap? See
// prompts/m0.5-spike-prompts.md Step 2.

import type { TrackIndex } from '../A-remux/mp4-index';
import { localUnitsToPresentationSec } from '../A-remux/select';
import { precedingSyncSampleIndex } from './gop-chain';

export interface WarmScrubSample {
  sampleIndex: number;
  offset: number;
  size: number;
  timestampUs: number;
  /** True if this sample is itself a sync sample -- needed so the worker can submit the correct EncodedVideoChunk `type`, since later GOP boundaries crossed mid-sequence are still real keyframes, not just the very first sample fed overall. */
  sync: boolean;
  isTarget: boolean;
}

export interface WarmScrubSegment {
  samples: WarmScrubSample[];
  targetTimestampUs: number;
}

/** Picks a forward-moving sequence of non-keyframe targets, spaced by a random minStep..maxStep sample step, simulating a scrub drag at varying speed. */
export function pickForwardScrubTargets(track: TrackIndex, stepCount: number, minStep = 3, maxStep = 30): number[] {
  const targets: number[] = [];
  const maxStart = Math.max(1, track.sampleCount - stepCount * maxStep - 1);
  let idx = 1 + Math.floor(Math.random() * maxStart);
  for (let i = 0; i < stepCount && idx < track.sampleCount - 1; i += 1) {
    idx += minStep + Math.floor(Math.random() * (maxStep - minStep + 1));
    if (idx >= track.sampleCount) break;
    targets.push(idx);
  }
  return targets;
}

function sampleAt(track: TrackIndex, i: number, isTarget: boolean): WarmScrubSample {
  return {
    sampleIndex: i,
    offset: track.offset[i]!,
    size: track.size[i]!,
    timestampUs: Math.round(localUnitsToPresentationSec(track, track.cts[i]!) * 1e6),
    sync: track.sync[i] === 1,
    isTarget,
  };
}

/** Segment 0 starts at the preceding sync sample of the FIRST target (an unavoidable cold start, matching gop-chain.ts's cold-start chain); every subsequent segment starts right after the previous target, feeding forward without restarting the decoder. */
export function buildWarmScrubSegments(track: TrackIndex, targetSampleIndices: number[]): WarmScrubSegment[] {
  if (targetSampleIndices.length === 0) return [];
  const segments: WarmScrubSegment[] = [];
  let start = precedingSyncSampleIndex(track, targetSampleIndices[0]!);
  for (const target of targetSampleIndices) {
    const samples: WarmScrubSample[] = [];
    for (let i = start; i <= target; i += 1) samples.push(sampleAt(track, i, i === target));
    segments.push({ samples, targetTimestampUs: samples[samples.length - 1]!.timestampUs });
    start = target + 1;
  }
  return segments;
}
