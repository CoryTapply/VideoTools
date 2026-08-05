// Top-level orchestrator. Ported from src/spikes/A-remux/mp4-index.ts's buildMp4Index, but:
// - reads through the ByteSource seam (async top-level scan, then one buffered moov read)
// - never throws on malformed/unusual input -- MalformedBoxError from the moov/** parsers is
//   caught here and converted into the public IndexError union
// - detects fMP4 (mvex-in-moov) and encrypted (top-level pssh, or an encv/enca sample entry)
//   content BEFORE trusting any track's stbl, per task spec §3/§4

import { CountingByteSource, type ByteSource } from './byte-source';
import { findChild, iterateBoxes, requireChild } from './box-cursor';
import { MalformedBoxError, type IndexError, type IndexWarning } from './errors';
import { parseMvhd } from './moov/mvhd';
import { buildTrackIndex } from './moov/build-track-index';
import { scanTopLevel } from './top-level-scan';
import type { TrackIndex } from './track-index';

export interface IndexSuccess {
  readonly ok: true;
  readonly tracks: TrackIndex[];
  readonly mvhdTimescale: number;
  readonly mvhdDuration: number;
  readonly warnings: IndexWarning[];
  readonly bytesRead: number;
  readonly buildMs: number;
}

export interface IndexFailure {
  readonly ok: false;
  readonly error: IndexError;
}

export type IndexResult = IndexSuccess | IndexFailure;

export async function buildIndex(source: ByteSource): Promise<IndexResult> {
  const t0 = performance.now();
  const counting = new CountingByteSource(source);

  const scan = await scanTopLevel(counting);
  if (scan.kind === 'not-isobmff') return { ok: false, error: { kind: 'not-isobmff' } };
  if (scan.kind === 'no-moov') return { ok: false, error: { kind: 'no-moov' } };
  if (scan.kind === 'fragmented-mp4') return { ok: false, error: { kind: 'fragmented-mp4' } };

  const moovHeader = scan.moov;
  const moovBytes = await counting.read(moovHeader.offset, moovHeader.boxSize);
  if (moovBytes.byteLength < moovHeader.boxSize) {
    return { ok: false, error: { kind: 'truncated', expectedBytes: moovHeader.boxSize, actualBytes: moovBytes.byteLength } };
  }

  const view = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
  // Rebase: within `view`, moov starts at offset 0.
  const moovContentStart = moovHeader.headerSize;
  const moovContentEnd = moovBytes.byteLength;

  try {
    if (findChild(view, moovContentStart, moovContentEnd, 'mvex')) {
      return { ok: false, error: { kind: 'fragmented-mp4' } };
    }
    if (findChild(view, moovContentStart, moovContentEnd, 'pssh')) {
      return { ok: false, error: { kind: 'encrypted' } };
    }

    const mvhdBox = requireChild(view, moovContentStart, moovContentEnd, 'mvhd', 'moov');
    const mvhd = parseMvhd(view, mvhdBox);

    const tracks: TrackIndex[] = [];
    const warnings: IndexWarning[] = [];
    for (const child of iterateBoxes(view, moovContentStart, moovContentEnd)) {
      if (child.type !== 'trak') continue;
      const outcome = buildTrackIndex(view, child, mvhd.timescale, mvhd.duration);
      if (outcome.kind === 'encrypted') return { ok: false, error: { kind: 'encrypted' } };
      tracks.push(outcome.result.track);
      warnings.push(...outcome.result.warnings);
    }

    return {
      ok: true,
      tracks,
      mvhdTimescale: mvhd.timescale,
      mvhdDuration: mvhd.duration,
      warnings,
      bytesRead: counting.bytesRead,
      buildMs: performance.now() - t0,
    };
  } catch (err) {
    if (err instanceof MalformedBoxError) {
      return { ok: false, error: { kind: 'malformed-box', box: err.box, offset: err.offset, detail: err.detail } };
    }
    throw err;
  }
}
