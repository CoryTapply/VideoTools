// Spike C / Step 5 -- main-thread side: packs 100 decoded thumbnails into a 10x10 WebP sprite,
// writes it to OPFS, and times the read-back + decode of a single thumbnail from the atlas. See
// prompts/m0.5-spike-prompts.md Step 5.

import type { TrackIndex } from '../A-remux/mp4-index';
import { pickSpreadKeyframes } from './keyframe-throughput';
import { extractAvcDecoderConfig } from './avc-config';
import type { AtlasThumbnailRequest, AtlasThumbnailResult } from './atlas-worker';

const GRID = 10;
export const ATLAS_THUMB_WIDTH = 160;
export const ATLAS_THUMB_HEIGHT = 90;
const WEBP_QUALITY = 0.6;

export interface AtlasReport {
  thumbnailCount: number;
  decodeMs: number;
  encodeMs: number;
  atlasBytes: number;
  opfsWriteMs: number;
  /** getFile() + createImageBitmap() for ONE thumbnail cropped straight from the atlas -- exactly what the spec asks for, timed as a single combined span. */
  singleThumbReadAndDecodeMs: number;
  errors: string[];
}

export async function buildThumbnailAtlas(
  file: File,
  track: TrackIndex,
  hardwareAcceleration: 'prefer-hardware' | 'prefer-software' | 'no-preference',
): Promise<AtlasReport> {
  const targets = pickSpreadKeyframes(track, GRID * GRID);
  const decoderConfig = extractAvcDecoderConfig(track);

  const worker = new Worker(new URL('./atlas-worker.ts', import.meta.url), { type: 'module' });
  const request: AtlasThumbnailRequest = {
    file,
    decoderConfig,
    targets,
    thumbWidth: ATLAS_THUMB_WIDTH,
    thumbHeight: ATLAS_THUMB_HEIGHT,
    hardwareAcceleration,
    batchSize: 16,
  };
  const thumbResult = await new Promise<AtlasThumbnailResult>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<AtlasThumbnailResult>) => resolve(e.data);
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage(request);
  });
  worker.terminate();

  const errors = [...thumbResult.errors];

  const atlasCanvas = new OffscreenCanvas(GRID * ATLAS_THUMB_WIDTH, GRID * ATLAS_THUMB_HEIGHT);
  const ctx = atlasCanvas.getContext('2d')!;
  for (let i = 0; i < thumbResult.bitmaps.length; i += 1) {
    const col = i % GRID;
    const row = Math.floor(i / GRID);
    ctx.drawImage(thumbResult.bitmaps[i]!, col * ATLAS_THUMB_WIDTH, row * ATLAS_THUMB_HEIGHT);
  }
  for (const b of thumbResult.bitmaps) b.close();

  const et0 = performance.now();
  const atlasBlob = await atlasCanvas.convertToBlob({ type: 'image/webp', quality: WEBP_QUALITY });
  const encodeMs = performance.now() - et0;

  const opfsRoot = await navigator.storage.getDirectory();
  const fileHandle = await opfsRoot.getFileHandle('thumbnail-atlas.webp', { create: true });

  const wt0 = performance.now();
  const writable = await fileHandle.createWritable();
  await writable.write(atlasBlob);
  await writable.close();
  const opfsWriteMs = performance.now() - wt0;

  const rt0 = performance.now();
  const readFile = await fileHandle.getFile();
  const singleThumbBitmap = await createImageBitmap(readFile, 0, 0, ATLAS_THUMB_WIDTH, ATLAS_THUMB_HEIGHT);
  const singleThumbReadAndDecodeMs = performance.now() - rt0;
  singleThumbBitmap.close();

  return {
    thumbnailCount: thumbResult.bitmaps.length,
    decodeMs: thumbResult.decodeMs,
    encodeMs,
    atlasBytes: atlasBlob.size,
    opfsWriteMs,
    singleThumbReadAndDecodeMs,
    errors,
  };
}
