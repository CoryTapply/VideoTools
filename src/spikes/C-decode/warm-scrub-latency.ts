// Spike C / Step 2 (warm-decoder sub-experiment) -- main-thread side: spawns the warm-decoder
// forward-scrub worker and separates out the unavoidable cold first stop from the incremental
// (warm) latency distribution over the remaining stops. See prompts/m0.5-spike-prompts.md Step
// 2: "test whether keeping a warm decoder and decoding forward from the CURRENT position
// (rather than restarting from a keyframe) makes sequential forward scrubbing cheap."

import type { TrackIndex } from '../A-remux/mp4-index';
import { extractAvcDecoderConfig } from './avc-config';
import { pickForwardScrubTargets, buildWarmScrubSegments } from './warm-scrub-chain';
import type { WarmScrubRequest, WarmScrubResult } from './warm-scrub-worker';
import { summarizeLatencies, type LatencyDistribution } from './arbitrary-frame-latency';

export interface WarmScrubReport {
  firstStopLatencyMs: number;
  incremental: LatencyDistribution;
  /** How many of the incremental (non-first) stops had their frame arrive progressively, before the single trailing flush -- vs. only released by that final drain. */
  incrementalArrivedProgressivelyCount: number;
  incrementalTotalCount: number;
  raw: WarmScrubResult;
}

export async function runWarmScrubLatency(
  file: File,
  track: TrackIndex,
  stepCount: number,
  hardwareAcceleration: 'prefer-hardware' | 'prefer-software' | 'no-preference',
): Promise<WarmScrubReport> {
  const targets = pickForwardScrubTargets(track, stepCount);
  const segments = buildWarmScrubSegments(track, targets);
  const decoderConfig = extractAvcDecoderConfig(track);

  const worker = new Worker(new URL('./warm-scrub-worker.ts', import.meta.url), { type: 'module' });
  const request: WarmScrubRequest = { file, decoderConfig, segments, hardwareAcceleration };
  const raw = await new Promise<WarmScrubResult>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<WarmScrubResult>) => resolve(e.data);
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage(request);
  });
  worker.terminate();

  const firstStopLatencyMs = raw.latenciesMs[0] ?? 0;
  // -1 means that target's frame never arrived at all (a genuine failure, not just "slow") --
  // exclude those from the latency distribution so they don't corrupt percentile ordering, but
  // still count them via errorCount (the worker already pushed a message per one into errors).
  const incrementalIndices = raw.latenciesMs.map((_, i) => i).slice(1).filter((i) => raw.latenciesMs[i]! !== -1);
  const incrementalLatencies = incrementalIndices.map((i) => raw.latenciesMs[i]!);
  const incrementalFrames = incrementalIndices.map((i) => raw.frameCounts[i]!);
  const incremental = summarizeLatencies(incrementalLatencies, incrementalFrames);
  incremental.errorCount = raw.errors.length;

  const incrementalArrivedProgressivelyCount = incrementalIndices.filter((i) => raw.arrivedBeforeFinalFlush[i]).length;

  return { firstStopLatencyMs, incremental, incrementalArrivedProgressivelyCount, incrementalTotalCount: incrementalIndices.length, raw };
}
