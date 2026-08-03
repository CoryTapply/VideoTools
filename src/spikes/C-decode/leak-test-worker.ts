// Spike C / Step 4 -- worker side: decode keyframes WITHOUT ever calling frame.close(), to
// observe the real failure mode when a caller forgets to release frames (a realistic bug class
// for anything juggling VideoFrame objects across callbacks). See
// prompts/m0.5-spike-prompts.md Step 4: "I want to see the failure mode so I recognise it in
// production."
//
// flush() is still required after each decode() to get output() to fire at all (per the item-1
// finding) -- that's orthogonal to the leak itself, so it's kept exactly as in decode-worker.ts.
// The only change from decode-worker.ts is the deliberately omitted frame.close().

import { stripNonVclNals } from './nal-strip';

declare const self: {
  onmessage: ((e: MessageEvent<LeakTestRequest>) => void) | null;
  postMessage: (message: unknown) => void;
};

export interface LeakTestTarget {
  offset: number;
  size: number;
  timestampUs: number;
}

export interface LeakTestRequest {
  file: File;
  decoderConfig: { codec: string; codedWidth: number; codedHeight: number; description: Uint8Array };
  targets: LeakTestTarget[];
  hardwareAcceleration: 'prefer-hardware' | 'prefer-software' | 'no-preference';
}

export interface LeakTestResult {
  requested: number;
  completedBeforeStall: number;
  exactError: string | null;
  totalMs: number;
}

self.onmessage = (e: MessageEvent<LeakTestRequest>) => {
  void run(e.data);
};

async function run(req: LeakTestRequest): Promise<void> {
  const { file, decoderConfig, targets, hardwareAcceleration } = req;
  const config: VideoDecoderConfig = {
    codec: decoderConfig.codec,
    codedWidth: decoderConfig.codedWidth,
    codedHeight: decoderConfig.codedHeight,
    description: decoderConfig.description,
    hardwareAcceleration,
  };

  let completedBeforeStall = 0;
  let exactError: string | null = null;
  let pendingResolve: (() => void) | undefined;
  let pendingReject: ((err: Error) => void) | undefined;

  // Real bug caught here during a live run: an earlier version of this callback took no `frame`
  // parameter at all, so the VideoFrame was never referenced by anything -- it became eligible
  // for garbage collection the instant output() returned, regardless of never calling
  // .close() explicitly. That's NOT what "forgetting to close a frame" means in production (a
  // cache array or in-flight callback that holds a real reference and just never releases it):
  // GC can still reclaim an unreferenced object, and if VideoFrame's backing resource is tied to
  // a finalizer, that reclaims it too, silently defeating the entire point of this test. This is
  // why a 10,000-frame run showed flat memory and no stall: nothing was actually being leaked.
  // Fixed by pushing every frame into `leaked`, keeping it genuinely reachable and un-closeable
  // for the rest of the run, matching the real bug class being tested.
  const leaked: VideoFrame[] = [];
  const decoder = new VideoDecoder({
    output(frame) {
      leaked.push(frame);
      completedBeforeStall += 1;
      pendingResolve?.();
    },
    error(err) {
      exactError = exactError ?? `decoder error callback: ${err.name}: ${err.message}`;
      pendingReject?.(err instanceof Error ? err : new Error(String(err)));
    },
  });
  decoder.configure(config);

  const t0 = performance.now();
  try {
    for (const target of targets) {
      const raw = new Uint8Array(await file.slice(target.offset, target.offset + target.size).arrayBuffer());
      const { result: bytes } = stripNonVclNals(raw);
      const chunk = new EncodedVideoChunk({ type: 'key', timestamp: target.timestampUs, data: bytes });

      const outputSeen = new Promise<void>((resolve, reject) => {
        pendingResolve = resolve;
        pendingReject = reject;
      });

      decoder.decode(chunk);
      const flushPromise = decoder.flush();

      const timeoutMs = 10_000;
      await Promise.race([
        Promise.all([outputSeen, flushPromise]),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)).then(() => {
          throw new Error(`stalled: no output/error within ${timeoutMs}ms (decoder.state=${decoder.state}, decodeQueueSize=${decoder.decodeQueueSize})`);
        }),
      ]);
    }
  } catch (err) {
    exactError = exactError ?? (err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  } finally {
    if (decoder.state !== 'closed') {
      try {
        decoder.close();
      } catch {
        // decoder may already be in a broken state after the failure above; ignore
      }
    }
  }

  const result: LeakTestResult = {
    requested: targets.length,
    completedBeforeStall,
    exactError,
    totalMs: performance.now() - t0,
  };
  self.postMessage(result);
}
