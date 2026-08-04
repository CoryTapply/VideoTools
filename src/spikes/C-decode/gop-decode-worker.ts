// Spike C / Step 2 -- worker-side arbitrary-frame decode: for each target, restart from a FRESH
// decoder at the preceding sync sample (a cold-start restart-from-keyframe, matching what a
// real random scrub click experiences) and decode forward through the chain, discarding every
// output except the target frame. See prompts/m0.5-spike-prompts.md Step 2.
//
// Output for B-frame content can arrive in a different order than decode() calls were
// submitted (confirmed present in this content: cts is non-monotonic in decode order -- see
// Spike B). Since the target is always the LAST sample in its chain, matching by TIMESTAMP
// (not queue position/FIFO order, which was fine for Step 1's independent keyframes but isn't
// valid here) correctly identifies the target's output regardless of any internal reordering.
//
// Per the flush() finding from Step 1: submitting the whole chain's decode() calls before a
// single flush() is both correct (decode ORDER, not flush timing, is what the codec uses to
// maintain reference-frame dependencies) and necessary (this decoder does not emit output for
// queued decodes otherwise).

import { stripNonVclNals } from './nal-strip';

declare const self: {
  onmessage: ((e: MessageEvent<GopLatencyRequest>) => void) | null;
  postMessage: (message: unknown) => void;
};

export interface ChainSampleMsg {
  offset: number;
  size: number;
  timestampUs: number;
  isTarget: boolean;
}

export interface GopLatencyRequest {
  file: File;
  decoderConfig: { codec: string; codedWidth: number; codedHeight: number; description: Uint8Array };
  chains: ChainSampleMsg[][];
  hardwareAcceleration: 'prefer-hardware' | 'prefer-software' | 'no-preference';
  /** If true, render the target frame via createImageBitmap (as the spec's "then render it" describes) before closing it; adds a little time, measured separately from decode latency. */
  renderTarget: boolean;
}

export interface ChainLatencyResult {
  framesDecoded: number;
  latencyMs: number;
  renderMs: number;
  error?: string;
}

export interface GopLatencyResult {
  results: ChainLatencyResult[];
  errors: string[];
}

self.onmessage = (e: MessageEvent<GopLatencyRequest>) => {
  void run(e.data);
};

async function decodeOneChain(file: File, config: VideoDecoderConfig, chain: ChainSampleMsg[], renderTarget: boolean): Promise<ChainLatencyResult> {
  const targetTimestampUs = chain[chain.length - 1]!.timestampUs;
  let latencyMs = -1;
  let renderMs = 0;
  let sawError: string | undefined;
  let resolveTarget: (() => void) | undefined;
  const targetSeen = new Promise<void>((resolve) => {
    resolveTarget = resolve;
  });

  const t0 = performance.now();
  const decoder = new VideoDecoder({
    output(frame) {
      if (frame.timestamp === targetTimestampUs && latencyMs < 0) {
        latencyMs = performance.now() - t0;
        if (renderTarget) {
          const st0 = performance.now();
          // createImageBitmap's promise isn't awaited here deliberately: per the WebCodecs +
          // createImageBitmap pattern, the frame's pixel data is captured synchronously enough
          // that closing immediately after starting the bitmap creation is safe, and awaiting
          // would incorrectly inflate the DECODE latency being measured. Its own cost is timed
          // separately, right after this synchronous block, using the resolved bitmap.
          void createImageBitmap(frame, { resizeWidth: 160, resizeHeight: 90 }).then((bitmap) => {
            renderMs = performance.now() - st0;
            bitmap.close();
          });
        }
      }
      frame.close();
      resolveTarget?.();
    },
    error(err) {
      sawError = String(err);
      resolveTarget?.();
    },
  });
  decoder.configure(config);

  for (let i = 0; i < chain.length; i += 1) {
    const sample = chain[i]!;
    const raw = new Uint8Array(await file.slice(sample.offset, sample.offset + sample.size).arrayBuffer());
    const { result: bytes } = stripNonVclNals(raw);
    const chunk = new EncodedVideoChunk({ type: i === 0 ? 'key' : 'delta', timestamp: sample.timestampUs, data: bytes });
    decoder.decode(chunk);
  }
  const flushPromise = decoder.flush().catch((err: unknown) => {
    sawError = sawError ?? String(err);
  });

  const timeoutMs = 15_000;
  await Promise.race([targetSeen, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  await flushPromise;
  if (decoder.state !== 'closed') decoder.close();

  return {
    framesDecoded: chain.length,
    latencyMs: latencyMs < 0 ? timeoutMs : latencyMs,
    renderMs,
    error: latencyMs < 0 ? (sawError ?? 'target frame never arrived within timeout') : sawError,
  };
}

async function run(req: GopLatencyRequest): Promise<void> {
  const { file, decoderConfig, chains, hardwareAcceleration, renderTarget } = req;
  const config: VideoDecoderConfig = {
    codec: decoderConfig.codec,
    codedWidth: decoderConfig.codedWidth,
    codedHeight: decoderConfig.codedHeight,
    description: decoderConfig.description,
    hardwareAcceleration,
  };
  const errors: string[] = [];
  const results: ChainLatencyResult[] = [];

  for (const chain of chains) {
    try {
      results.push(await decodeOneChain(file, config, chain, renderTarget));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      results.push({ framesDecoded: chain.length, latencyMs: -1, renderMs: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const result: GopLatencyResult = { results, errors };
  self.postMessage(result);
}
