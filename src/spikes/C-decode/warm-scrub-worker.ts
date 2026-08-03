// Spike C / Step 2 (warm-decoder sub-experiment) -- worker side: a SINGLE VideoDecoder stays
// configured across the whole sequence, fed continuously forward in decode order. Unlike
// gop-decode-worker.ts (a fresh decoder per target, restarting from the preceding sync sample
// every time), this measures whether NOT restarting -- just continuing to feed forward from
// wherever the decoder already is -- makes sequential forward-scrubbing stops cheap after the
// first (unavoidably cold) one. See prompts/m0.5-spike-prompts.md Step 2.

import { stripNonVclNals } from './nal-strip';
import type { WarmScrubSegment } from './warm-scrub-chain';

declare const self: {
  onmessage: ((e: MessageEvent<WarmScrubRequest>) => void) | null;
  postMessage: (message: unknown) => void;
};

export interface WarmScrubRequest {
  file: File;
  decoderConfig: { codec: string; codedWidth: number; codedHeight: number; description: Uint8Array };
  segments: WarmScrubSegment[];
  hardwareAcceleration: 'prefer-hardware' | 'prefer-software' | 'no-preference';
}

export interface WarmScrubResult {
  /** One entry per segment, in order; index 0 is the cold first stop. */
  latenciesMs: number[];
  frameCounts: number[];
  errors: string[];
}

self.onmessage = (e: MessageEvent<WarmScrubRequest>) => {
  void run(e.data);
};

async function run(req: WarmScrubRequest): Promise<void> {
  const { file, decoderConfig, segments, hardwareAcceleration } = req;
  const config: VideoDecoderConfig = {
    codec: decoderConfig.codec,
    codedWidth: decoderConfig.codedWidth,
    codedHeight: decoderConfig.codedHeight,
    description: decoderConfig.description,
    hardwareAcceleration,
  };
  const errors: string[] = [];
  const latenciesMs: number[] = [];
  const frameCounts: number[] = [];

  let currentTargetTimestampUs = -1;
  let currentSegmentStart = 0;
  let resolveTarget: (() => void) | undefined;

  const decoder = new VideoDecoder({
    output(frame) {
      if (frame.timestamp === currentTargetTimestampUs && latenciesMs[latenciesMs.length - 1] === -1) {
        latenciesMs[latenciesMs.length - 1] = performance.now() - currentSegmentStart;
        resolveTarget?.();
      }
      frame.close();
    },
    error(err) {
      errors.push(`decoder error: ${String(err)}`);
      resolveTarget?.();
    },
  });
  decoder.configure(config);

  try {
    for (const segment of segments) {
      currentSegmentStart = performance.now();
      currentTargetTimestampUs = segment.targetTimestampUs;
      latenciesMs.push(-1);
      frameCounts.push(segment.samples.length);

      const targetSeen = new Promise<void>((resolve) => {
        resolveTarget = resolve;
      });

      for (const sample of segment.samples) {
        const raw = new Uint8Array(await file.slice(sample.offset, sample.offset + sample.size).arrayBuffer());
        const { result: bytes } = stripNonVclNals(raw);
        // The chunk's `type` reflects whether THIS sample is a real sync sample, not merely
        // whether it's the first one ever fed -- forward-scrubbing sequences routinely cross
        // GOP boundaries mid-sequence, and those keyframes are still real keyframes.
        const chunk = new EncodedVideoChunk({ type: sample.sync ? 'key' : 'delta', timestamp: sample.timestampUs, data: bytes });
        decoder.decode(chunk);
      }

      const flushPromise = decoder.flush().catch((err: unknown) => {
        errors.push(`flush error at target ts=${segment.targetTimestampUs}: ${err instanceof Error ? err.message : String(err)}`);
      });
      const timeoutMs = 10_000;
      await Promise.race([targetSeen, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
      await flushPromise;
      if (latenciesMs[latenciesMs.length - 1] === -1) {
        errors.push(`segment target (ts=${segment.targetTimestampUs}) never arrived within ${timeoutMs}ms`);
        latenciesMs[latenciesMs.length - 1] = timeoutMs;
      }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }

  const result: WarmScrubResult = { latenciesMs, frameCounts, errors };
  self.postMessage(result);
}
