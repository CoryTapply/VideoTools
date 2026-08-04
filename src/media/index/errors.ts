import type { EditListEntry } from './moov/edit-list';

/**
 * The public failure surface: a corrupt or unusual recording is an expected
 * condition, never an exception. Internal helpers (box-cursor.ts, the moov/**
 * parsers) may still throw MalformedBoxError as a control-flow shortcut -- but
 * buildIndex() (build-index.ts) is the boundary that catches it and every other
 * expected-failure condition, and returns one of these instead of throwing.
 */
export type IndexError =
  | { kind: 'not-isobmff' }
  | { kind: 'no-moov' }
  | { kind: 'truncated'; expectedBytes: number; actualBytes: number }
  | { kind: 'fragmented-mp4' }
  | { kind: 'encrypted' }
  | { kind: 'unsupported-codec'; codec: string }
  | { kind: 'malformed-box'; box: string; offset: number; detail: string };

export type IndexWarning =
  | { kind: 'non-trivial-edit-list'; trackId: number; entries: EditListEntry[] }
  | { kind: 'multiple-stsd-entries'; trackId: number; entryCount: number };

/** Thrown internally by box-cursor.ts and the moov/** parsers for a structurally malformed
 * box; caught at the buildIndex() boundary and converted to `{ kind: 'malformed-box', ... }`.
 * This is deliberately NOT part of the public IndexError surface -- see the module doc above. */
export class MalformedBoxError extends Error {
  readonly box: string;
  readonly offset: number;
  readonly detail: string;

  constructor(box: string, offset: number, detail: string) {
    super(`malformed box '${box}' at offset ${String(offset)}: ${detail}`);
    this.box = box;
    this.offset = offset;
    this.detail = detail;
    this.name = 'MalformedBoxError';
  }
}

/** An actionable, user-facing message for each IndexError kind. */
export function formatIndexError(error: IndexError): string {
  switch (error.kind) {
    case 'not-isobmff':
      return 'This file does not look like an MP4/MOV file.';
    case 'no-moov':
      return 'This file is missing its movie metadata (moov box) -- it may be truncated or corrupt.';
    case 'truncated':
      return `This file is truncated: expected ${String(error.expectedBytes)} bytes of movie metadata but only ${String(error.actualBytes)} were readable.`;
    case 'fragmented-mp4':
      return 'This file uses fragmented MP4 (common from OBS and some recorders), which is not yet supported.';
    case 'encrypted':
      return 'This file is encrypted (DRM-protected) and cannot be opened.';
    case 'unsupported-codec':
      return `This file uses an unsupported codec (${error.codec}).`;
    case 'malformed-box':
      return `This file has a corrupt '${error.box}' box at offset ${String(error.offset)}: ${error.detail}`;
  }
}
