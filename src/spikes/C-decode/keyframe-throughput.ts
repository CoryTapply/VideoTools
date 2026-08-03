// Spike C / Step 1 -- main-thread side: pick keyframes spread across the track, report the
// track's real keyframe interval (Step 6), and spawn the decode worker. See
// prompts/m0.5-spike-prompts.md Steps 1 and 6.

import type { TrackIndex } from '../A-remux/mp4-index';
import { localUnitsToPresentationSec } from '../A-remux/select';
import { extractAvcDecoderConfig } from './avc-config';
import type { DecodeTarget, KeyframeThroughputRequest, KeyframeThroughputResult } from './decode-worker';

export interface KeyframeIntervalStats {
  realKeyframeCount: number;
  minIntervalSec: number;
  meanIntervalSec: number;
  maxIntervalSec: number;
}

function syncIndices(track: TrackIndex): number[] {
  const out: number[] = [];
  for (let i = 0; i < track.sampleCount; i += 1) if (track.sync[i] === 1) out.push(i);
  return out;
}

export function keyframeIntervalStats(track: TrackIndex): KeyframeIntervalStats {
  const idx = syncIndices(track);
  if (idx.length < 2) return { realKeyframeCount: idx.length, minIntervalSec: 0, meanIntervalSec: 0, maxIntervalSec: 0 };
  const intervals: number[] = [];
  for (let k = 1; k < idx.length; k += 1) {
    intervals.push(localUnitsToPresentationSec(track, track.cts[idx[k]!]!) - localUnitsToPresentationSec(track, track.cts[idx[k - 1]!]!));
  }
  return {
    realKeyframeCount: idx.length,
    minIntervalSec: Math.min(...intervals),
    meanIntervalSec: intervals.reduce((a, b) => a + b, 0) / intervals.length,
    maxIntervalSec: Math.max(...intervals),
  };
}

/** Picks `count` keyframes evenly spread across the track's real sync-sample list. */
export function pickSpreadKeyframes(track: TrackIndex, count: number): DecodeTarget[] {
  const idx = syncIndices(track);
  const n = Math.min(count, idx.length);
  const targets: DecodeTarget[] = [];
  for (let k = 0; k < n; k += 1) {
    const sampleIdx = idx[Math.floor((k / n) * idx.length)]!;
    targets.push({
      offset: track.offset[sampleIdx]!,
      size: track.size[sampleIdx]!,
      timestampUs: Math.round(localUnitsToPresentationSec(track, track.cts[sampleIdx]!) * 1e6),
    });
  }
  return targets;
}

export async function runKeyframeThroughput(
  file: File,
  track: TrackIndex,
  targets: DecodeTarget[],
  hardwareAcceleration: 'prefer-hardware' | 'prefer-software' | 'no-preference',
  coalesceWindowBytes?: number,
): Promise<KeyframeThroughputResult> {
  const decoderConfig = extractAvcDecoderConfig(track);
  const worker = new Worker(new URL('./decode-worker.ts', import.meta.url), { type: 'module' });
  const request: KeyframeThroughputRequest = { file, decoderConfig, targets, hardwareAcceleration, coalesceWindowBytes };
  const result = await new Promise<KeyframeThroughputResult>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<KeyframeThroughputResult>) => resolve(e.data);
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage(request);
  });
  worker.terminate();
  return result;
}
