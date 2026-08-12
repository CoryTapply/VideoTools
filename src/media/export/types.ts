// Shared types for the export pipeline. Node-testable -- no File/Worker/FSA types anywhere in
// this module's core (see README.md for the seam boundary).

export interface ExportRange {
  readonly trackId: number;
  /** inclusive, decode-order sample index */
  readonly first: number;
  /** inclusive, decode-order sample index */
  readonly last: number;
}

export interface ExportSelection {
  readonly ranges: ExportRange[];
  /** Presentation ticks, primary video track's own timescale -- the canonical time base (see
   * architecture-v3.md §2). Keyframe-snapped: this is the actually-chosen in-point, not
   * necessarily the requested one. */
  readonly actualInTicks: number;
  /** Presentation ticks, primary video track's own timescale. Unsnapped -- sampleRange's
   * half-open upper bound already excludes the sample at or after this instant, so no keyframe
   * search is needed for the out-point. */
  readonly actualOutTicks: number;
  /** Signed ticks the in-point moved by (actualInTicks - requested); negative means earlier. 0 if
   * the requested in-point was already on a keyframe. */
  readonly keyframeShiftTicks: number;
}

export type ExportPhase = 'copy' | 'finalising';

export interface ExportProgress {
  readonly phase: ExportPhase;
  readonly percent: number;
  readonly bytesWritten: number;
  readonly totalBytesEstimate: number;
}

export type ExportError =
  | { kind: 'no-video-track' }
  | { kind: 'empty-selection' }
  | { kind: 'malformed-source'; detail: string }
  | { kind: 'picker-cancelled' }
  | { kind: 'write-failed'; message: string }
  | { kind: 'close-failed'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'unsupported'; reason: string };

export type ExportResult = { ok: true; bytesWritten: number; wallMs: number } | { ok: false; error: ExportError };

/** An actionable, user-facing message for each ExportError kind -- mirrors src/media/index/errors.ts's formatIndexError. */
export function formatExportError(error: ExportError): string {
  switch (error.kind) {
    case 'no-video-track':
      return 'This file has no video track to export.';
    case 'empty-selection':
      return 'The selected range and tracks produced nothing to export.';
    case 'malformed-source':
      return `The source file could not be re-read for export: ${error.detail}`;
    case 'picker-cancelled':
      return 'Export cancelled.';
    case 'write-failed':
      return `Writing the export failed: ${error.message}`;
    case 'close-failed':
      return `Finishing the export failed: ${error.message}`;
    case 'cancelled':
      return 'Export cancelled.';
    case 'unsupported':
      return error.reason;
  }
}
