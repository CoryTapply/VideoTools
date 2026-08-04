// Spike C / Step 2 -- builds decode chains for the arbitrary-frame-latency measurement (the
// scrub-settle path). See prompts/m0.5-spike-prompts.md Step 2.
//
// Finding "the preceding sync sample" here is a DECODE-ORDER concept (a GOP starts at a sync
// sample and runs, in decode order, until the next one) -- deliberately NOT Spike B's
// `nearestPrecedingSyncSample` query, which answers a different question (nearest sync sample
// by PRESENTATION time, useful for seek UI). Building a correct decode chain needs the former.

import type { TrackIndex } from '../A-remux/mp4-index';
import { localUnitsToPresentationSec } from '../A-remux/select';

export interface ChainSample {
  sampleIndex: number;
  offset: number;
  size: number;
  timestampUs: number;
  isTarget: boolean;
}

export interface DecodeChain {
  targetSampleIndex: number;
  syncSampleIndex: number;
  targetTimestampUs: number;
  chain: ChainSample[];
}

export function precedingSyncSampleIndex(track: TrackIndex, targetIdx: number): number {
  for (let i = targetIdx; i >= 0; i -= 1) if (track.sync[i] === 1) return i;
  return 0; // sample 0 is always sync in every fixture seen so far; falls back defensively
}

export function pickRandomNonKeyframeTargets(track: TrackIndex, count: number): number[] {
  const candidates: number[] = [];
  for (let i = 0; i < track.sampleCount; i += 1) if (track.sync[i] !== 1) candidates.push(i);
  const picked = new Set<number>();
  const n = Math.min(count, candidates.length);
  while (picked.size < n) picked.add(candidates[Math.floor(Math.random() * candidates.length)]!);
  return Array.from(picked);
}

export function buildDecodeChain(track: TrackIndex, targetSampleIndex: number): DecodeChain {
  const syncSampleIndex = precedingSyncSampleIndex(track, targetSampleIndex);
  const chain: ChainSample[] = [];
  for (let i = syncSampleIndex; i <= targetSampleIndex; i += 1) {
    chain.push({
      sampleIndex: i,
      offset: track.offset[i]!,
      size: track.size[i]!,
      timestampUs: Math.round(localUnitsToPresentationSec(track, track.cts[i]!) * 1e6),
      isTarget: i === targetSampleIndex,
    });
  }
  return {
    targetSampleIndex,
    syncSampleIndex,
    targetTimestampUs: chain[chain.length - 1]!.timestampUs,
    chain,
  };
}
