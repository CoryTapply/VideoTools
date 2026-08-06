// The testability seam this module is built around, mirroring src/media/playback/VideoElementLike.ts
// (real HTMLVideoElement vs. a Node-testable fake). Task 2's experience is the argument for doing
// this here too: its three real bugs were all browser-timing behaviour a fake couldn't reproduce,
// which means everything that ISN'T browser-timing -- batching, scheduling, the LRU, atlas
// packing, the two-tier sampling math -- should be provably correct in Node against FrameDecoder
// before any of it touches a real WebCodecs VideoDecoder.
//
// Deliberately does not import ImageBitmap or any other DOM type (same rule as
// src/media/index/byte-source.ts and src/media/playback/VideoElementLike.ts): `DecodedBitmap`
// below is a small structural interface that a real ImageBitmap satisfies without a cast, and
// that a Node-side fake can implement with a plain object.

import type { Closable } from './frame-lifecycle';

export interface FrameDecoderConfig {
  /** RFC 6381 string, e.g. 'avc1.640034' -- from TrackIndex.codec. */
  readonly codec: string;
  readonly codedWidth: number;
  readonly codedHeight: number;
  /**
   * The AVCDecoderConfigurationRecord/HEVCDecoderConfigurationRecord content ONLY -- starting at
   * `configurationVersion`, NOT the same bytes as `TrackIndex.description`. Task 1's
   * `TrackIndex.description` deliberately includes the avcC/hvcC box's own 8-byte header (4-byte
   * size + 4-byte fourcc), per its own doc comment, because other consumers (remux/export) need
   * the full box. WebCodecs' `VideoDecoderConfig.description` does not: passing the box header
   * along feeds the decoder 8 bogus leading bytes and reliably fails configure() -- confirmed via
   * a real harness run (every single decode failed uniformly with "Cannot call decode on a closed
   * codec", the downstream symptom of configure() itself being silently rejected). Callers
   * building this field from a TrackIndex must slice off the first 8 bytes; see FrameCache.ts's
   * constructor.
   */
  readonly description: Uint8Array;
}

/**
 * Strips an ISOBMFF box's 8-byte header (4-byte size + 4-byte fourcc) from a raw box byte slice,
 * turning `TrackIndex.description` (Task 1's convention: the full box, header included) into the
 * AVCDecoderConfigurationRecord/HEVCDecoderConfigurationRecord content WebCodecs actually wants
 * for `FrameDecoderConfig.description`. See that field's doc comment for why this distinction is
 * load-bearing, not cosmetic.
 */
export function stripBoxHeader(rawBoxBytes: Uint8Array): Uint8Array {
  return rawBoxBytes.slice(8);
}

export interface ThumbnailSize {
  readonly width: number;
  readonly height: number;
}

export interface DecodeJob {
  /** Caller-assigned identity (typically the decode-order sample index) -- echoed back on the matching thumbnail or error so results can be attributed even though this port doesn't guarantee anything about internal ordering beyond "same order as submitted". */
  readonly id: number;
  /** Presentation ticks, carried through untouched -- this port does no time-base math. */
  readonly presentationTime: number;
  /** One encoded sample's bytes, already sliced via SampleIndex.byteRange() + a ByteSource read. */
  readonly data: Uint8Array;
  readonly type: 'key' | 'delta';
  /**
   * Whether this job's decoded output should be downscaled and returned. False for a dependency
   * frame in a decode chain (dense tier: reaching a 2fps target sometimes requires decoding
   * intervening delta frames that are themselves never kept) -- its VideoFrame is still closed,
   * just never turned into a bitmap.
   */
  readonly keep: boolean;
}

/**
 * Groups jobs into units that are each safe to flush() after, WITHOUT ever splitting a decode
 * chain across a flush boundary. Confirmed by a real harness run against longgop.mp4: flush()
 * resets the decoder's key-frame-required flag (already known, see decodeBatch's own comment on
 * never flushing speculatively), so submitting a fixed-size batchSize slice blindly -- ignoring
 * job type -- eventually starts a batch on a 'delta' job right after a flush(), which WebCodecs
 * rejects outright ("A key frame is required after configure() or flush()").
 *
 * Independent keyframes (coarse tier: every job is type 'key', no dependency chain) batch up to
 * `batchSize` per flush, preserving spike C's 3.6x-throughput batching finding. A chain (dense
 * tier: a 'key' job followed by one or more dependent 'delta' jobs) is NEVER split, regardless of
 * its length -- it's submitted and flushed as exactly one unit, since only its first job is safe
 * to follow a flush.
 */
export function groupIntoFlushBatches<T extends { readonly type: 'key' | 'delta' }>(jobs: readonly T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  let i = 0;
  while (i < jobs.length) {
    const batch: T[] = [jobs[i]];
    i += 1;
    if (i < jobs.length && jobs[i].type === 'delta') {
      // jobs[i - 1] starts a chain -- consume every dependent delta frame before the next flush,
      // however long the chain runs.
      while (i < jobs.length && jobs[i].type === 'delta') {
        batch.push(jobs[i]);
        i += 1;
      }
    } else {
      // Independent-keyframe mode: batch up to batchSize consecutive keyframes.
      while (batch.length < batchSize && i < jobs.length && jobs[i].type === 'key') {
        batch.push(jobs[i]);
        i += 1;
      }
    }
    batches.push(batch);
  }
  return batches;
}

/** A real ImageBitmap satisfies this without a cast; a Node-side fake implements it directly. */
export interface DecodedBitmap extends Closable {
  readonly width: number;
  readonly height: number;
}

export interface DecodedThumbnail {
  readonly id: number;
  readonly presentationTime: number;
  readonly bitmap: DecodedBitmap;
}

export type FrameDecodeError =
  | { kind: 'unsupported-config'; codec: string }
  /** The underlying decoder errored mid-batch. Per WebCodecs semantics once this happens the decoder instance is unusable -- the caller must close() this FrameDecoder and construct a fresh one for further work. */
  | { kind: 'decode-error'; message: string; jobId: number };

export interface FrameDecodeBatchResult {
  /** Everything successfully decoded before any error, in submission order. */
  readonly thumbnails: DecodedThumbnail[];
  /** Non-empty only if the batch was cut short by a decoder error. */
  readonly errors: FrameDecodeError[];
}

/** An actionable, human-readable message for each FrameDecodeError kind -- mirrors src/media/index/errors.ts's formatIndexError and src/media/playback/errors.ts's formatPlaybackError. */
export function formatFrameDecodeError(error: FrameDecodeError): string {
  switch (error.kind) {
    case 'unsupported-config':
      return `unsupported codec config: ${error.codec}`;
    case 'decode-error':
      return error.message;
  }
}

/** 3.6x throughput over fully-sequential decoding, per spike C (results/FEASIBILITY.md §4) -- the single highest-leverage batching constant in this module. */
export const DEFAULT_BATCH_SIZE = 16;

export interface FrameDecoder {
  isConfigSupported(config: FrameDecoderConfig): Promise<boolean>;
  /** Must be called once before decodeBatch(). Throws if called after close(). */
  configure(config: FrameDecoderConfig): void;
  /**
   * Decodes `jobs` in submission order, batching internally in groups of `batchSize` decode()
   * calls per flush() (NEVER flushing speculatively mid-batch -- flush() resets the decoder's
   * key-frame-required flag, so checking progress this way forces an unwanted keyframe restart,
   * per spike C's "warm decoder" finding). Every VideoFrame a decoder emits is closed before this
   * resolves, whether or not it was kept.
   */
  decodeBatch(jobs: readonly DecodeJob[], size: ThumbnailSize, batchSize?: number): Promise<FrameDecodeBatchResult>;
  close(): void;
}
