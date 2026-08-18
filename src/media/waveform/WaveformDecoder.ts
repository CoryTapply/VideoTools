// The testability seam this module is built around, mirroring src/media/frames/FrameDecoder.ts's
// role for video: a real WebCodecs implementation (RealWaveformDecoder.ts) plus a Node-testable
// fake (FakeWaveformDecoder.ts) so everything above this seam -- job building, the pyramid
// reducer, the worker pool, OPFS storage -- is provably correct in Node before any of it touches a
// real AudioDecoder.
//
// Deliberately does not import AudioData or any other DOM/WebCodecs type in this file's public
// surface beyond what TypeScript's ambient DOM lib provides as types (same rule as
// src/media/frames/FrameDecoder.ts): `DecodedAudioChunk` below is a small structural interface a
// real AudioData satisfies without a cast, and that a Node-side fake can implement with a plain
// object.

import type { Closable } from '../frames/frame-lifecycle';

export interface WaveformDecoderConfig {
  /** RFC 6381 string, e.g. 'mp4a.40.2' -- from TrackIndex.codec. */
  readonly codec: string;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  /** The AudioSpecificConfig payload ONLY -- from stsd.ts's extractAudioSpecificConfig(), never TrackIndex.description's raw esds box bytes directly (see that function's doc comment). */
  readonly description: Uint8Array;
}

export interface DecodeAudioJob {
  /** Caller-assigned identity (typically the decode-order sample index) -- echoed back on a decode-error so failures can be attributed. */
  readonly id: number;
  /** Presentation ticks, carried through untouched -- this port does no time-base math. */
  readonly presentationTime: number;
  /** One encoded AAC frame's bytes, already sliced via SampleIndex.byteRange() + a ByteSource read. */
  readonly data: Uint8Array;
}

/** A real AudioData satisfies this without a cast; a Node-side fake implements it directly. */
export interface DecodedAudioChunk extends Closable {
  readonly numberOfChannels: number;
  readonly numberOfFrames: number;
  readonly sampleRate: number;
  /** Planar Float32 copy of one channel's samples -- mirrors AudioData.copyTo({planeIndex}, format: 'f32-planar')'s contract. `destination` must be at least `numberOfFrames` long. */
  copyTo(destination: Float32Array, planeIndex: number): void;
}

export type WaveformDecodeError =
  | { kind: 'unsupported-config'; codec: string }
  /** The underlying decoder errored mid-batch. Per WebCodecs semantics once this happens the decoder instance is unusable -- the caller must close() this WaveformDecoder and construct a fresh one for further work. */
  | { kind: 'decode-error'; message: string; jobId: number };

export interface WaveformDecodeBatchResult {
  /** Non-empty only if the batch was cut short by a decoder error. */
  readonly errors: readonly WaveformDecodeError[];
}

/** An actionable, human-readable message for each WaveformDecodeError kind -- mirrors src/media/frames/FrameDecoder.ts's formatFrameDecodeError. */
export function formatWaveformDecodeError(error: WaveformDecodeError): string {
  switch (error.kind) {
    case 'unsupported-config':
      return `unsupported codec config: ${error.codec}`;
    case 'decode-error':
      return error.message;
  }
}

/** Every `flushEvery` chunks (default below), per src/media/frames/RealFrameDecoder.ts's precedent: NEVER flush speculatively more often than necessary, but audio has no decode-chain to preserve across a flush (unlike video B-frames), so this exists purely for periodic progress/cancellation checkpoints on a long track, not correctness. */
export const DEFAULT_FLUSH_EVERY = 64;

export interface WaveformDecoder {
  isConfigSupported(config: WaveformDecoderConfig): Promise<boolean>;
  /** Must be called once before decodeBatch(). Throws if called after close(). */
  configure(config: WaveformDecoderConfig): void;
  /**
   * Decodes `jobs` in submission order, invoking `onChunk` for each decoded chunk AS IT ARRIVES --
   * never buffering the whole batch -- so callers can fold audio into a reducer incrementally (see
   * this module's README on why buffering decoded audio is the mistake this whole module exists to
   * avoid). `onChunk` must consume/copy out of the chunk synchronously; the chunk is closed
   * immediately after `onChunk` returns, so no reference to it may escape that call.
   */
  decodeBatch(jobs: readonly DecodeAudioJob[], onChunk: (chunk: DecodedAudioChunk) => void, flushEvery?: number): Promise<WaveformDecodeBatchResult>;
  close(): void;
}
