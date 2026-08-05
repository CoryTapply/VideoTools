// Wire format for the real Worker boundary (worker.ts / worker-client.ts). See worker-pool.ts's
// header comment for why jobs cross as plain {offset, size, presentationTime} descriptors rather
// than a shared SampleIndex: each worker reads its own assigned byte ranges from its own File
// clone (File is structured-cloneable, same precedent as src/media/index/worker.ts), so it never
// needs general index query capability.
//
// ImageBitmap is itself transferable (zero-copy) across postMessage, unlike the typed arrays
// index/worker.ts has to choose SAB-vs-copy for -- so results transfer the decoded bitmaps
// directly rather than needing any encoding scheme of their own.

import type { FrameDecodeError, FrameDecoderConfig, ThumbnailSize } from './FrameDecoder';
import type { DecodeJobDescriptor } from './worker-pool';

export type FrameWorkerRequest =
  | { type: 'init'; file: File }
  | { type: 'decode'; requestId: number; config: FrameDecoderConfig; jobs: DecodeJobDescriptor[]; size: ThumbnailSize; batchSize?: number }
  | { type: 'cancel'; requestId: number };

export interface WireThumbnail {
  readonly id: number;
  readonly presentationTime: number;
  readonly bitmap: ImageBitmap;
}

export type FrameWorkerResponse =
  | { type: 'result'; requestId: number; thumbnails: WireThumbnail[]; errors: FrameDecodeError[]; cancelled: boolean }
  | { type: 'worker-error'; requestId: number; message: string };
