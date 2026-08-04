// Spike C / Step 2 -- main-thread side: pick random non-keyframe targets, build decode chains,
// spawn the worker, and compute the latency distribution. Also runs a <video>-element seek
// baseline on the exact same targets, for a directly comparable number against M0's ~220ms
// average (which used different random targets on the same file). See
// prompts/m0.5-spike-prompts.md Step 2.

import type { TrackIndex } from '../A-remux/mp4-index';
import { localUnitsToPresentationSec } from '../A-remux/select';
import { extractAvcDecoderConfig } from './avc-config';
import { pickRandomNonKeyframeTargets, buildDecodeChain } from './gop-chain';
import type { ChainSampleMsg, GopLatencyRequest, GopLatencyResult } from './gop-decode-worker';

export interface LatencyDistribution {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  meanFramesDecoded: number;
  count: number;
  errorCount: number;
}

export function summarizeLatencies(latenciesMs: number[], framesDecoded: number[]): LatencyDistribution {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
  return {
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
    max: sorted[sorted.length - 1] ?? 0,
    meanFramesDecoded: framesDecoded.reduce((a, b) => a + b, 0) / Math.max(1, framesDecoded.length),
    count: latenciesMs.length,
    errorCount: 0,
  };
}

export async function runArbitraryFrameLatency(
  file: File,
  track: TrackIndex,
  targetCount: number,
  hardwareAcceleration: 'prefer-hardware' | 'prefer-software' | 'no-preference',
  renderTarget: boolean,
): Promise<{ result: GopLatencyResult; distribution: LatencyDistribution; targetSampleIndices: number[] }> {
  const targetSampleIndices = pickRandomNonKeyframeTargets(track, targetCount);
  const decoderConfig = extractAvcDecoderConfig(track);
  const chains: ChainSampleMsg[][] = targetSampleIndices.map((idx) =>
    buildDecodeChain(track, idx).chain.map((s) => ({ offset: s.offset, size: s.size, timestampUs: s.timestampUs, isTarget: s.isTarget })),
  );

  const worker = new Worker(new URL('./gop-decode-worker.ts', import.meta.url), { type: 'module' });
  const request: GopLatencyRequest = { file, decoderConfig, chains, hardwareAcceleration, renderTarget };
  const result = await new Promise<GopLatencyResult>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<GopLatencyResult>) => resolve(e.data);
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage(request);
  });
  worker.terminate();

  const successful = result.results.filter((r) => !r.error);
  const distribution = summarizeLatencies(
    successful.map((r) => r.latencyMs),
    successful.map((r) => r.framesDecoded),
  );
  distribution.errorCount = result.results.length - successful.length;

  return { result, distribution, targetSampleIndices };
}

/** Seeks a <video> element to the SAME target sample indices' presentation times, for a directly comparable baseline. */
export async function runVideoSeekBaseline(file: File, track: TrackIndex, targetSampleIndices: number[]): Promise<LatencyDistribution> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  await new Promise<void>((resolve, reject) => {
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
    video.addEventListener('error', () => reject(video.error), { once: true });
  });

  const latencies: number[] = [];
  for (const idx of targetSampleIndices) {
    const targetSec = localUnitsToPresentationSec(track, track.cts[idx]!);
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      video.addEventListener('seeked', () => resolve(), { once: true });
      video.currentTime = targetSec;
    });
    latencies.push(performance.now() - t0);
  }

  URL.revokeObjectURL(url);
  return summarizeLatencies(
    latencies,
    latencies.map(() => 0),
  );
}
