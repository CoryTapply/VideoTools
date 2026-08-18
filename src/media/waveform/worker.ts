// The worker-side entry point. Assumes at most one 'build' request is ever in flight at a time on
// a given worker instance -- guaranteed by WaveformWorkerPool (worker-pool.ts), which only
// dispatches to a handle once its previous build() has resolved. That's what makes constructing a
// fresh RealWaveformDecoder per request (unlike frames/worker.ts, which reuses one across
// requests) safe and simple: there's no cross-request decoder state to manage here since this
// module has no coarse/dense-tier equivalent that would make reuse worth the complexity.
//
// tsconfig's lib is DOM (main-thread), not WebWorker -- same hand-declared `self` convention as
// src/media/index/worker.ts and src/media/frames/worker.ts.
declare const self: {
  onmessage: ((e: MessageEvent<WaveformWorkerRequest>) => void) | null;
  postMessage: (message: WaveformWorkerResponse, transfer?: Transferable[]) => void;
};

import { createFrameLifecycleRegistry } from '../frames/frame-lifecycle';
import { PyramidBuilder } from './pyramid';
import { RealWaveformDecoder } from './RealWaveformDecoder';
import type { DecodeAudioJob, WaveformDecodeError, WaveformDecoderConfig } from './WaveformDecoder';
import type { WaveformWorkerRequest, WaveformWorkerResponse } from './worker-protocol';
import type { WaveformJobDescriptor, WirePyramidLevel } from './worker-pool';

let file: File | undefined;
const cancelled = new Set<number>();

/** How many jobs' worth of bytes are read and decoded between cancellation checks -- independent of `flushEvery` (RealWaveformDecoder's own internal flush cadence, a much finer-grained concern). Chosen so a cancellation on a long track is noticed promptly without checking after every single sample. */
const CHUNK_GROUP_SIZE = 512;

async function readJobBytes(descriptor: WaveformJobDescriptor): Promise<DecodeAudioJob> {
  if (!file) throw new Error('waveform worker: build requested before init');
  const buf = await file.slice(descriptor.offset, descriptor.offset + descriptor.size).arrayBuffer();
  return { id: descriptor.id, presentationTime: descriptor.presentationTime, data: new Uint8Array(buf) };
}

function cancelledResponse(requestId: number): WaveformWorkerResponse {
  return { type: 'result', requestId, pyramid: [], errors: [], cancelled: true };
}

async function handleBuild(req: Extract<WaveformWorkerRequest, { type: 'build' }>): Promise<void> {
  const registry = createFrameLifecycleRegistry();
  const decoder = new RealWaveformDecoder(registry);
  const config: WaveformDecoderConfig = { codec: req.config.codec, sampleRate: req.config.sampleRate, numberOfChannels: req.config.numberOfChannels, description: req.config.description };

  const supported = await decoder.isConfigSupported(config);
  if (!supported) {
    self.postMessage({ type: 'result', requestId: req.requestId, pyramid: [], errors: [{ kind: 'unsupported-config', codec: config.codec }], cancelled: false });
    return;
  }
  decoder.configure(config);

  const builder = new PyramidBuilder(config.numberOfChannels);
  const errors: WaveformDecodeError[] = [];

  for (let start = 0; start < req.jobs.length; start += CHUNK_GROUP_SIZE) {
    if (cancelled.delete(req.requestId)) {
      decoder.close();
      self.postMessage(cancelledResponse(req.requestId));
      return;
    }

    const group = req.jobs.slice(start, start + CHUNK_GROUP_SIZE);
    const decodeJobs = await Promise.all(group.map(readJobBytes));
    // Fold every decoded chunk into the pyramid builder AS IT ARRIVES (never buffered) -- see
    // pyramid.ts and this module's README for why that's the whole point of this class existing.
    const result = await decoder.decodeBatch(
      decodeJobs,
      (chunk) => {
        for (let ch = 0; ch < chunk.numberOfChannels; ch += 1) {
          const samples = new Float32Array(chunk.numberOfFrames);
          chunk.copyTo(samples, ch);
          builder.push(ch, samples);
        }
      },
      req.flushEvery,
    );
    errors.push(...result.errors);
    if (result.errors.length > 0) break;
  }

  decoder.close();

  if (cancelled.delete(req.requestId)) {
    self.postMessage(cancelledResponse(req.requestId));
    return;
  }

  const pyramid: WirePyramidLevel[] = errors.length > 0 ? [] : builder.finish();
  const transfer = pyramid.flatMap((level) => [...level.min, ...level.max]).map((arr) => arr.buffer);
  self.postMessage({ type: 'result', requestId: req.requestId, pyramid, errors, cancelled: false }, transfer);
}

self.onmessage = (e: MessageEvent<WaveformWorkerRequest>) => {
  const req = e.data;
  if (req.type === 'init') {
    file = req.file;
    return;
  }
  if (req.type === 'cancel') {
    cancelled.add(req.requestId);
    return;
  }
  handleBuild(req).catch((err: unknown) => {
    self.postMessage({ type: 'worker-error', requestId: req.requestId, message: err instanceof Error ? err.message : String(err) });
  });
};
