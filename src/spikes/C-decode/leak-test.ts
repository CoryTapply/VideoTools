// Spike C / Step 4 -- main-thread side: spawns the leak-test worker against 100 keyframes
// spread across the track. See prompts/m0.5-spike-prompts.md Step 4.

import type { TrackIndex } from '../A-remux/mp4-index';
import { pickSpreadKeyframes } from './keyframe-throughput';
import { extractAvcDecoderConfig } from './avc-config';
import type { LeakTestRequest, LeakTestResult, LeakTestTarget } from './leak-test-worker';

/** Cycles through the track's real keyframes to reach `count`, re-assigning strictly increasing synthetic timestamps -- needed once `count` exceeds the file's actual number of keyframes, since this test cares about decoder resource exhaustion, not distinct frame content. */
function pickRepeatingKeyframes(track: TrackIndex, count: number): LeakTestTarget[] {
  const base = pickSpreadKeyframes(track, count);
  if (base.length === 0) return [];
  const targets: LeakTestTarget[] = [];
  for (let i = 0; i < count; i += 1) {
    const src = base[i % base.length]!;
    targets.push({ offset: src.offset, size: src.size, timestampUs: i * 1_000_000 });
  }
  return targets;
}

export async function runLeakTest(
  file: File,
  track: TrackIndex,
  count: number,
  hardwareAcceleration: 'prefer-hardware' | 'prefer-software' | 'no-preference',
): Promise<LeakTestResult> {
  const targets = pickRepeatingKeyframes(track, count);
  const decoderConfig = extractAvcDecoderConfig(track);

  const worker = new Worker(new URL('./leak-test-worker.ts', import.meta.url), { type: 'module' });
  const request: LeakTestRequest = { file, decoderConfig, targets, hardwareAcceleration };
  const result = await new Promise<LeakTestResult>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<LeakTestResult>) => resolve(e.data);
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage(request);
  });
  worker.terminate();
  return result;
}
