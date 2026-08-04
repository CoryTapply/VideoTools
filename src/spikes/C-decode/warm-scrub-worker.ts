// Spike C / Step 2 (warm-decoder sub-experiment) -- worker side: a SINGLE VideoDecoder stays
// configured across the whole sequence, fed continuously forward in decode order. Unlike
// gop-decode-worker.ts (a fresh decoder per target, restarting from the preceding sync sample
// every time), this measures whether NOT restarting -- just continuing to feed forward from
// wherever the decoder already is -- makes sequential forward-scrubbing stops cheap after the
// first (unavoidably cold) one. See prompts/m0.5-spike-prompts.md Step 2.
//
// Real finding, confirmed via a first attempt at this that called flush() after every stop
// (to force each target's frame out promptly, the same pattern used in gop-decode-worker.ts):
// Chrome's WebCodecs flush() does not just drain the pipeline -- it also sets the decoder's
// internal "key frame required" flag, exactly like configure()/reset() do. The very next
// decode() after a flush() throws "A key frame is required after configure() or flush()." if
// it isn't a real keyframe. So flushing per stop silently defeats the entire premise of a warm
// decoder: every flush() forces the next stop back into a cold-start-equivalent restart. There
// is no per-stop drain-and-continue available.
//
// Fixed by never flushing mid-sequence: every sample for every stop is decode()'d back-to-back
// with NO intervening flush(), and each target's frame is picked off via the output() callback
// (matched by timestamp) whenever the decoder gets around to emitting it -- exactly like a real
// player continuously decoding forward. A single flush() is called once at the very end, purely
// to drain whatever the decoder is still internally holding so every target's output eventually
// fires (and so the decoder can be closed cleanly). `arrivedBeforeFinalFlush` records, per
// target, whether its frame actually came out progressively during normal decoding, or only
// appeared once the trailing flush forced it -- if it's the latter for most/all targets, that
// means this decoder implementation buffers far more than expected and doesn't emit
// progressively at all, which would be an important negative finding in itself.

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
  /** outputTimeMs - submitTimeMs, per target, in order; index 0 is the cold first stop. -1 if never arrived. */
  latenciesMs: number[];
  frameCounts: number[];
  /** True if the target's frame arrived from output() during normal decoding, before the single trailing flush() was even called -- i.e., genuinely progressive, not just released by the final drain. */
  arrivedBeforeFinalFlush: boolean[];
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
  const n = segments.length;
  const frameCounts = segments.map((s) => s.samples.length);
  const submitTimeMs = new Array<number>(n).fill(-1);
  const outputTimeMs = new Array<number>(n).fill(-1);
  const arrivedBeforeFinalFlush = new Array<boolean>(n).fill(false);
  let flushCalled = false;

  const targetIndexByTimestamp = new Map<number, number>(segments.map((s, i) => [s.targetTimestampUs, i]));

  const decoder = new VideoDecoder({
    output(frame) {
      const idx = targetIndexByTimestamp.get(frame.timestamp);
      if (idx !== undefined && outputTimeMs[idx] === -1) {
        outputTimeMs[idx] = performance.now();
        arrivedBeforeFinalFlush[idx] = !flushCalled;
      }
      frame.close();
    },
    error(err) {
      errors.push(`decoder error: ${String(err)}`);
    },
  });
  decoder.configure(config);

  try {
    for (let s = 0; s < n; s += 1) {
      const segment = segments[s]!;
      for (const sample of segment.samples) {
        const raw = new Uint8Array(await file.slice(sample.offset, sample.offset + sample.size).arrayBuffer());
        const { result: bytes } = stripNonVclNals(raw);
        // Reflects whether THIS sample is a real sync sample, not merely whether it's the
        // first one ever fed -- forward-scrubbing sequences routinely cross GOP boundaries
        // mid-sequence, and those keyframes are still real keyframes.
        const chunk = new EncodedVideoChunk({ type: sample.sync ? 'key' : 'delta', timestamp: sample.timestampUs, data: bytes });
        decoder.decode(chunk);
      }
      submitTimeMs[s] = performance.now();
    }

    flushCalled = true;
    const timeoutMs = 10_000 + 200 * frameCounts.reduce((a, b) => a + b, 0);
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`trailing flush timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      await Promise.race([decoder.flush(), timeout]);
    } finally {
      clearTimeout(timeoutHandle!);
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }

  const latenciesMs = outputTimeMs.map((t, i) => {
    if (t === -1) {
      errors.push(`target ${i} (ts=${segments[i]!.targetTimestampUs}) never arrived`);
      return -1;
    }
    return t - submitTimeMs[i]!;
  });

  const result: WarmScrubResult = { latenciesMs, frameCounts, arrivedBeforeFinalFlush, errors };
  self.postMessage(result);
}
