// Wire format for the real Worker boundary (worker.ts / worker-client.ts). Mirrors
// src/media/frames/worker-protocol.ts: jobs cross as plain job descriptors (see worker-pool.ts's
// header comment), File is posted once at init (structured-cloneable, same precedent as
// src/media/index/worker.ts), and every subsequent message only carries small descriptors.
//
// Int16Array is itself transferable (zero-copy) across postMessage, so the completed pyramid
// transfers directly -- no encoding scheme needed, unlike ImageBitmap which frames/ handles
// specially.

import type { WaveformDecodeError } from './WaveformDecoder';
import type { WaveformDecoderConfigWire, WaveformJobDescriptor, WirePyramidLevel } from './worker-pool';

export type WaveformWorkerRequest =
  | { type: 'init'; file: File }
  | { type: 'build'; requestId: number; config: WaveformDecoderConfigWire; jobs: WaveformJobDescriptor[]; flushEvery?: number }
  | { type: 'cancel'; requestId: number };

export type WaveformWorkerResponse =
  | { type: 'result'; requestId: number; pyramid: WirePyramidLevel[]; errors: WaveformDecodeError[]; cancelled: boolean }
  | { type: 'worker-error'; requestId: number; message: string };
