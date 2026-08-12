// A narrow, independent walk of the source file's moov, run at export time, to recover the raw
// box bytes (mvhd, and per-track tkhd/mdhd/hdlr/stsd/minf-prefix) the moov writer needs to
// reproduce untouched. Deliberately NOT retained on the shared, query-only production TrackIndex
// (src/media/index/track-index.ts) -- two already-shipped modules (playback, frame cache) depend
// on that type and don't need this payload. See README.md for the reasoning.
//
// ftyp is NOT copied from the source here -- a fresh standard ftyp is synthesized in
// moov-builder.ts instead, matching how stream-copy muxers (ffmpeg -c copy included)
// conventionally handle it: ftyp only declares compatible brands, it doesn't describe the sample
// data this module rewrites.
//
// This module only runs after src/media/index/build-index.ts has already successfully parsed the
// same file (export is only reachable once a file is open), so it doesn't re-derive
// fragmented/encrypted detection -- a non-'found' scan result here is defensive, not expected.

import { findChild, iterateBoxes, rawBoxBytes, requireChild } from '../index/box-cursor';
import { MalformedBoxError } from '../index/errors';
import { scanTopLevel } from '../index/top-level-scan';
import { concatBytes } from './box-writer';
import type { ByteSource } from '../index/byte-source';

export interface RawTrackBoxes {
  readonly trackId: number;
  readonly tkhd: Uint8Array;
  readonly mdhd: Uint8Array;
  readonly hdlr: Uint8Array;
  readonly stsd: Uint8Array;
  /** minf's children other than stbl (vmhd/smhd, dinf, ...), concatenated verbatim in original order. */
  readonly minfPrefix: Uint8Array;
}

export interface RawMoovBoxes {
  readonly mvhd: Uint8Array;
  readonly tracks: RawTrackBoxes[];
}

export type RawBoxesError = { kind: 'no-moov' } | { kind: 'malformed'; detail: string };

/** Only needs track_ID, not the full tkhd parse -- see src/media/index/moov/tkhd.ts for the
 * production equivalent, which also decodes duration/matrix that this module has no use for
 * (the raw bytes are copied verbatim; only the key to file them under is needed here). */
function readTkhdTrackId(view: DataView, tkhd: { offset: number; headerSize: number }): number {
  const contentStart = tkhd.offset + tkhd.headerSize;
  const version = view.getUint8(contentStart);
  const p = version === 1 ? contentStart + 4 + 8 + 8 : contentStart + 4 + 4 + 4;
  return view.getUint32(p);
}

export async function readRawMoovBoxes(source: ByteSource): Promise<RawMoovBoxes | { error: RawBoxesError }> {
  const scan = await scanTopLevel(source);
  if (scan.kind !== 'found') return { error: { kind: 'no-moov' } };

  const moovHeader = scan.moov;
  const moovBytes = await source.read(moovHeader.offset, moovHeader.boxSize);
  const view = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
  const moovContentStart = moovHeader.headerSize;
  const moovContentEnd = moovBytes.byteLength;

  try {
    const mvhdBox = requireChild(view, moovContentStart, moovContentEnd, 'mvhd', 'moov');
    const mvhd = rawBoxBytes(view, mvhdBox);

    const tracks: RawTrackBoxes[] = [];
    for (const trak of iterateBoxes(view, moovContentStart, moovContentEnd)) {
      if (trak.type !== 'trak') continue;
      const trakStart = trak.offset + trak.headerSize;
      const trakEnd = trak.offset + trak.boxSize;

      const tkhdBox = requireChild(view, trakStart, trakEnd, 'tkhd', 'trak');
      const trackId = readTkhdTrackId(view, tkhdBox);

      const mdiaBox = requireChild(view, trakStart, trakEnd, 'mdia', 'trak');
      const mdiaStart = mdiaBox.offset + mdiaBox.headerSize;
      const mdiaEnd = mdiaBox.offset + mdiaBox.boxSize;

      const mdhdBox = requireChild(view, mdiaStart, mdiaEnd, 'mdhd', 'mdia');
      const hdlrBox = requireChild(view, mdiaStart, mdiaEnd, 'hdlr', 'mdia');
      const minfBox = requireChild(view, mdiaStart, mdiaEnd, 'minf', 'mdia');
      const minfStart = minfBox.offset + minfBox.headerSize;
      const minfEnd = minfBox.offset + minfBox.boxSize;

      const minfPrefixParts: Uint8Array[] = [];
      let stsd: Uint8Array | undefined;
      for (const child of iterateBoxes(view, minfStart, minfEnd)) {
        if (child.type === 'stbl') {
          const stblStart = child.offset + child.headerSize;
          const stblEnd = child.offset + child.boxSize;
          const stsdBox = findChild(view, stblStart, stblEnd, 'stsd');
          if (stsdBox) stsd = rawBoxBytes(view, stsdBox);
        } else {
          minfPrefixParts.push(rawBoxBytes(view, child));
        }
      }
      if (!stsd) throw new MalformedBoxError('stsd', minfStart, "stbl is missing its required 'stsd' child box");

      tracks.push({
        trackId,
        tkhd: rawBoxBytes(view, tkhdBox),
        mdhd: rawBoxBytes(view, mdhdBox),
        hdlr: rawBoxBytes(view, hdlrBox),
        stsd,
        minfPrefix: concatBytes(minfPrefixParts),
      });
    }

    return { mvhd, tracks };
  } catch (err) {
    if (err instanceof MalformedBoxError) return { error: { kind: 'malformed', detail: err.message } };
    throw err;
  }
}
