import type { DecodedBitmap } from './FrameDecoder';

/**
 * Presentation ticks in the primary video track's own timescale -- same convention as
 * src/media/index/ and src/media/playback/ (both call this `Time = number` too). Redefined
 * locally rather than imported across the module boundary: it's a plain alias with no shared
 * runtime behavior, and index/ and playback/ each keep their own error/result shapes rather than
 * reaching across for the other's -- this module follows the same precedent.
 */
export type Time = number;

export type FrameTier = 'coarse' | 'dense';

export interface CachedFrame {
  /** The actual keyframe/sample time this bitmap represents -- may differ slightly from whatever time was queried. */
  readonly presentationTime: Time;
  readonly bitmap: DecodedBitmap;
  readonly tier: FrameTier;
}
