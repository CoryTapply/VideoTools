// Spike A / Step 1 -- full per-sample index from an MP4's moov, extending
// spike2's box parser (which only located moov and counted stss entries).
//
// Every table here is walked exactly once into preallocated typed arrays;
// no per-sample objects. Reported build time and retained bytes are the
// spike's headline measurements -- see prompts/m0.5-spike-prompts.md Step 1.

import { findChild, findTopLevelBox, iterateBoxes, readFullBoxVersion } from './mp4-boxes';

export interface EditListEntry {
  segmentDuration: number;
  mediaTime: number;
  mediaRateInteger: number;
  mediaRateFraction: number;
}

export interface TrackIndex {
  trackId: number;
  handlerType: string; // 'vide', 'soun', or whatever hdlr reports
  timescale: number; // mdhd timescale -- all dts/cts/durations below are in THIS track's units, not seconds
  mediaDuration: number; // mdhd duration, track timescale units
  tkhdDuration: number; // tkhd duration, MOVIE timescale units (per spec, tkhd durations are in the movie timescale)
  matrix: Int32Array; // tkhd's 9 raw int32 display-matrix entries (fixed 16.16 / 2.30, left un-decoded -- copied verbatim on write)
  sampleCount: number;
  /** decode timestamp, track timescale units, cumulative from stts */
  dts: Float64Array;
  /** composition timestamp = dts + ctts offset (or dts if no ctts) */
  cts: Float64Array;
  size: Uint32Array;
  /** absolute byte offset of each sample in the SOURCE file */
  offset: Float64Array;
  /** 1 = sync sample, 0 = not. All-1 if the track has no stss (audio, or intra-only video). */
  sync: Uint8Array;
  hasCtts: boolean;
  cttsVersion: number; // 0 (unsigned) or 1 (signed) -- only meaningful if hasCtts
  /** Raw bytes of the original tkhd/mdhd/stsd boxes (full box incl. header), for the writer to copy/patch verbatim. */
  rawTkhd: Uint8Array;
  rawMdhd: Uint8Array;
  rawStsd: Uint8Array;
  rawHdlr: Uint8Array;
  /** minf's children other than stbl (vmhd/smhd, dinf, ...), concatenated verbatim in original order. */
  rawMinfPrefix: Uint8Array;
  /**
   * Edit list entries (edts/elst), if present -- e.g. encoder priming-delay
   * offsets. `mediaTime` is in THIS track's timescale; `segmentDuration` is
   * in the movie (mvhd) timescale. Honored during Step 2 sample selection:
   * presentation time 0 maps to track-local media time `mediaTime`, not 0.
   * Multi-entry edit lists (edit-based cuts, not just a priming offset) are
   * rare and NOT specially handled here -- only the first entry's mediaTime
   * is used as the presentation-to-media offset.
   */
  editList?: EditListEntry[];
}

export interface Mp4Index {
  mvhdTimescale: number;
  mvhdDuration: number;
  /** Raw bytes of the original mvhd box (full box incl. header), for the writer to copy/patch verbatim. */
  rawMvhd: Uint8Array;
  tracks: TrackIndex[];
  moovOffset: number;
  moovSize: number;
  buildMs: number;
  retainedBytes: number;
}

function rawBoxBytes(view: DataView, box: { offset: number; boxSize: number }): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset + box.offset, box.boxSize).slice();
}

function concatBytesLocal(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

function expandRunLength(view: DataView, entriesStart: number, entryCount: number, sampleCount: number, signed: boolean): Float64Array {
  const out = new Float64Array(sampleCount);
  let i = 0;
  let p = entriesStart;
  for (let e = 0; e < entryCount && i < sampleCount; e += 1) {
    const count = view.getUint32(p);
    const value = signed ? view.getInt32(p + 4) : view.getUint32(p + 4);
    p += 8;
    for (let k = 0; k < count && i < sampleCount; k += 1, i += 1) out[i] = value;
  }
  return out;
}

function parseStts(view: DataView, box: { offset: number; headerSize: number }): { durations: Float64Array; sampleCount: number } {
  const contentStart = box.offset + box.headerSize;
  const entryCount = view.getUint32(contentStart + 4);
  // First pass: total sample count (sum of sample_count fields) -- stts doesn't store it directly.
  let total = 0;
  let p = contentStart + 8;
  for (let e = 0; e < entryCount; e += 1) {
    total += view.getUint32(p);
    p += 8;
  }
  const durations = expandRunLength(view, contentStart + 8, entryCount, total, false);
  return { durations, sampleCount: total };
}

function parseCtts(view: DataView, box: { offset: number; headerSize: number }, sampleCount: number): { offsets: Float64Array; version: number } {
  const contentStart = box.offset + box.headerSize;
  const { version } = readFullBoxVersion(view, contentStart);
  const entryCount = view.getUint32(contentStart + 4);
  const offsets = expandRunLength(view, contentStart + 8, entryCount, sampleCount, version === 1);
  return { offsets, version };
}

function parseStsz(view: DataView, box: { offset: number; headerSize: number }): Uint32Array {
  const contentStart = box.offset + box.headerSize;
  const sampleSize = view.getUint32(contentStart + 4);
  const sampleCount = view.getUint32(contentStart + 8);
  const sizes = new Uint32Array(sampleCount);
  if (sampleSize !== 0) {
    sizes.fill(sampleSize);
    return sizes;
  }
  let p = contentStart + 12;
  for (let i = 0; i < sampleCount; i += 1, p += 4) sizes[i] = view.getUint32(p);
  return sizes;
}

function parseStz2(view: DataView, box: { offset: number; headerSize: number }): Uint32Array {
  const contentStart = box.offset + box.headerSize;
  const fieldSize = view.getUint8(contentStart + 7); // reserved(3) + field_size(1) packed into bytes 4-7
  const sampleCount = view.getUint32(contentStart + 8);
  const sizes = new Uint32Array(sampleCount);
  const dataStart = contentStart + 12;
  if (fieldSize === 16) {
    for (let i = 0; i < sampleCount; i += 1) sizes[i] = view.getUint16(dataStart + i * 2);
  } else if (fieldSize === 8) {
    for (let i = 0; i < sampleCount; i += 1) sizes[i] = view.getUint8(dataStart + i);
  } else if (fieldSize === 4) {
    for (let i = 0; i < sampleCount; i += 1) {
      const byte = view.getUint8(dataStart + (i >> 1));
      sizes[i] = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
    }
  } else {
    throw new Error(`stz2 field_size ${fieldSize} not supported`);
  }
  return sizes;
}

/** Returns undefined if stss is absent (meaning: every sample is a sync sample). */
function parseStss(view: DataView, box: { offset: number; headerSize: number } | undefined, sampleCount: number): Uint8Array {
  const sync = new Uint8Array(sampleCount);
  if (!box) {
    sync.fill(1);
    return sync;
  }
  const contentStart = box.offset + box.headerSize;
  const entryCount = view.getUint32(contentStart + 4);
  let p = contentStart + 8;
  for (let e = 0; e < entryCount; e += 1, p += 4) {
    const sampleNumber1Based = view.getUint32(p); // STSS IS 1-BASED
    const idx = sampleNumber1Based - 1;
    if (idx >= 0 && idx < sampleCount) sync[idx] = 1;
  }
  return sync;
}

interface StscEntry {
  firstChunk: number;
  samplesPerChunk: number;
}

function parseStsc(view: DataView, box: { offset: number; headerSize: number }): StscEntry[] {
  const contentStart = box.offset + box.headerSize;
  const entryCount = view.getUint32(contentStart + 4);
  const entries: StscEntry[] = [];
  let p = contentStart + 8;
  for (let e = 0; e < entryCount; e += 1, p += 12) {
    entries.push({ firstChunk: view.getUint32(p), samplesPerChunk: view.getUint32(p + 4) });
    // sample_description_index at p+8 is unused here; every sample copies stsd verbatim regardless.
  }
  return entries;
}

function parseChunkOffsets(view: DataView, box: { type: string; offset: number; headerSize: number }): Float64Array {
  const contentStart = box.offset + box.headerSize;
  const entryCount = view.getUint32(contentStart + 4);
  const offsets = new Float64Array(entryCount);
  let p = contentStart + 8;
  if (box.type === 'co64') {
    for (let i = 0; i < entryCount; i += 1, p += 8) offsets[i] = Number(view.getBigUint64(p));
  } else {
    for (let i = 0; i < entryCount; i += 1, p += 4) offsets[i] = view.getUint32(p);
  }
  return offsets;
}

/** Walks stsc + chunk offsets, accumulating per-sample size within each chunk to get absolute byte offsets. */
function computeSampleOffsets(chunkOffsets: Float64Array, stsc: StscEntry[], sizes: Uint32Array): Float64Array {
  const offsets = new Float64Array(sizes.length);
  let sampleIdx = 0;
  for (let entryIdx = 0; entryIdx < stsc.length; entryIdx += 1) {
    const firstChunk = stsc[entryIdx]!.firstChunk;
    const samplesPerChunk = stsc[entryIdx]!.samplesPerChunk;
    const lastChunk = entryIdx + 1 < stsc.length ? stsc[entryIdx + 1]!.firstChunk - 1 : chunkOffsets.length;
    for (let chunk = firstChunk; chunk <= lastChunk; chunk += 1) {
      let pos = chunkOffsets[chunk - 1]!; // chunk numbers are 1-based
      for (let s = 0; s < samplesPerChunk && sampleIdx < sizes.length; s += 1, sampleIdx += 1) {
        offsets[sampleIdx] = pos;
        pos += sizes[sampleIdx]!;
      }
    }
  }
  return offsets;
}

function checkForEditList(view: DataView, trakStart: number, trakEnd: number): EditListEntry[] | undefined {
  const edts = findChild(view, trakStart, trakEnd, 'edts');
  if (!edts) return undefined;
  const edtsStart = edts.offset + edts.headerSize;
  const elst = findChild(view, edtsStart, edts.offset + edts.boxSize, 'elst');
  if (!elst) return undefined;
  const contentStart = elst.offset + elst.headerSize;
  const { version } = readFullBoxVersion(view, contentStart);
  const entryCount = view.getUint32(contentStart + 4);
  const entries: EditListEntry[] = [];
  let p = contentStart + 8;
  for (let e = 0; e < entryCount; e += 1) {
    if (version === 1) {
      entries.push({
        segmentDuration: Number(view.getBigUint64(p)),
        mediaTime: Number(view.getBigInt64(p + 8)),
        mediaRateInteger: view.getInt16(p + 16),
        mediaRateFraction: view.getInt16(p + 18),
      });
      p += 20;
    } else {
      entries.push({
        segmentDuration: view.getUint32(p),
        mediaTime: view.getInt32(p + 4),
        mediaRateInteger: view.getInt16(p + 8),
        mediaRateFraction: view.getInt16(p + 10),
      });
      p += 12;
    }
  }
  return entries;
}

function parseTkhd(view: DataView, box: { offset: number; headerSize: number }): { trackId: number; duration: number; matrix: Int32Array } {
  const contentStart = box.offset + box.headerSize;
  const { version } = readFullBoxVersion(view, contentStart);
  let p = contentStart + 4;
  let trackId: number;
  let duration: number;
  if (version === 1) {
    p += 8 + 8; // creation_time, modification_time
    trackId = view.getUint32(p);
    p += 4 + 4; // track_ID, reserved
    duration = Number(view.getBigUint64(p));
    p += 8;
  } else {
    p += 4 + 4;
    trackId = view.getUint32(p);
    p += 4 + 4;
    duration = view.getUint32(p);
    p += 4;
  }
  p += 8 + 2 + 2 + 2 + 2; // reserved(8), layer(2), alt_group(2), volume(2), reserved(2)
  const matrix = new Int32Array(9);
  for (let i = 0; i < 9; i += 1) matrix[i] = view.getInt32(p + i * 4);
  return { trackId, duration, matrix };
}

function parseMdhd(view: DataView, box: { offset: number; headerSize: number }): { timescale: number; duration: number } {
  const contentStart = box.offset + box.headerSize;
  const { version } = readFullBoxVersion(view, contentStart);
  let p = contentStart + 4;
  if (version === 1) {
    p += 8 + 8;
    const timescale = view.getUint32(p);
    p += 4;
    const duration = Number(view.getBigUint64(p));
    return { timescale, duration };
  }
  p += 4 + 4;
  const timescale = view.getUint32(p);
  p += 4;
  const duration = view.getUint32(p);
  return { timescale, duration };
}

function readHandlerType(view: DataView, box: { offset: number; headerSize: number }): string {
  const contentStart = box.offset + box.headerSize;
  const handlerOffset = contentStart + 4 /* version+flags */ + 4 /* pre_defined */;
  return String.fromCharCode(
    view.getUint8(handlerOffset),
    view.getUint8(handlerOffset + 1),
    view.getUint8(handlerOffset + 2),
    view.getUint8(handlerOffset + 3),
  );
}

function buildTrackIndex(view: DataView, trak: { offset: number; headerSize: number; boxSize: number }): TrackIndex {
  const trakStart = trak.offset + trak.headerSize;
  const trakEnd = trak.offset + trak.boxSize;

  const editList = checkForEditList(view, trakStart, trakEnd);
  if (editList && editList.length > 1) {
    // A single-entry edit list is the common priming-delay case, handled in Step 2.
    // Multiple entries mean real edit-based cuts, which this spike doesn't attempt to honor.
    throw new Error(
      `track has a multi-entry edts/elst edit list (${editList.length} entries) -- ` +
        `only single-entry (priming-delay) edit lists are handled. Entries: ${JSON.stringify(editList)}`,
    );
  }
  if (editList) {
    // eslint-disable-next-line no-console
    console.log('edit list found (will be honored as a presentation-time offset):', editList);
  }

  const tkhdBox = findChild(view, trakStart, trakEnd, 'tkhd');
  if (!tkhdBox) throw new Error('trak missing tkhd');
  const tkhd = parseTkhd(view, tkhdBox);

  const mdiaBox = findChild(view, trakStart, trakEnd, 'mdia');
  if (!mdiaBox) throw new Error('trak missing mdia');
  const mdiaStart = mdiaBox.offset + mdiaBox.headerSize;
  const mdiaEnd = mdiaBox.offset + mdiaBox.boxSize;

  const mdhdBox = findChild(view, mdiaStart, mdiaEnd, 'mdhd');
  if (!mdhdBox) throw new Error('mdia missing mdhd');
  const mdhd = parseMdhd(view, mdhdBox);

  const hdlrBox = findChild(view, mdiaStart, mdiaEnd, 'hdlr');
  if (!hdlrBox) throw new Error('mdia missing hdlr');
  const handlerType = readHandlerType(view, hdlrBox);

  const minfBox = findChild(view, mdiaStart, mdiaEnd, 'minf');
  if (!minfBox) throw new Error('mdia missing minf');
  const minfContentStart = minfBox.offset + minfBox.headerSize;
  const minfContentEnd = minfBox.offset + minfBox.boxSize;
  // Everything in minf other than stbl (vmhd/smhd, dinf, ...) -- copied verbatim, in original
  // order, rather than reconstructed field-by-field. stbl is the only part that changes.
  const minfNonStblParts: Uint8Array[] = [];
  for (const child of iterateBoxes(view, minfContentStart, minfContentEnd)) {
    if (child.type !== 'stbl') minfNonStblParts.push(rawBoxBytes(view, child));
  }
  const rawMinfPrefix = concatBytesLocal(minfNonStblParts);

  const stblBox = findChild(view, minfBox.offset + minfBox.headerSize, minfBox.offset + minfBox.boxSize, 'stbl');
  if (!stblBox) throw new Error('minf missing stbl');
  const stblStart = stblBox.offset + stblBox.headerSize;
  const stblEnd = stblBox.offset + stblBox.boxSize;

  const sttsBox = findChild(view, stblStart, stblEnd, 'stts');
  if (!sttsBox) throw new Error('stbl missing stts');
  const { durations, sampleCount } = parseStts(view, sttsBox);

  const dts = new Float64Array(sampleCount);
  for (let i = 1; i < sampleCount; i += 1) dts[i] = dts[i - 1]! + durations[i - 1]!;

  const cttsBox = findChild(view, stblStart, stblEnd, 'ctts');
  let cts: Float64Array;
  let hasCtts = false;
  let cttsVersion = 0;
  if (cttsBox) {
    const { offsets, version } = parseCtts(view, cttsBox, sampleCount);
    cts = new Float64Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) cts[i] = dts[i]! + offsets[i]!;
    hasCtts = true;
    cttsVersion = version;
  } else {
    cts = dts.slice();
  }

  const stszBox = findChild(view, stblStart, stblEnd, 'stsz');
  const stz2Box = stszBox ? undefined : findChild(view, stblStart, stblEnd, 'stz2');
  let size: Uint32Array;
  if (stszBox) size = parseStsz(view, stszBox);
  else if (stz2Box) size = parseStz2(view, stz2Box);
  else throw new Error('stbl missing stsz/stz2');
  if (size.length !== sampleCount) throw new Error(`stsz sample count ${size.length} != stts sample count ${sampleCount}`);

  const stscBox = findChild(view, stblStart, stblEnd, 'stsc');
  if (!stscBox) throw new Error('stbl missing stsc');
  const stsc = parseStsc(view, stscBox);

  const stcoBox = findChild(view, stblStart, stblEnd, 'stco');
  const co64Box = stcoBox ? undefined : findChild(view, stblStart, stblEnd, 'co64');
  const chunkBox = stcoBox ?? co64Box;
  if (!chunkBox) throw new Error('stbl missing stco/co64');
  const chunkOffsets = parseChunkOffsets(view, chunkBox);
  const offset = computeSampleOffsets(chunkOffsets, stsc, size);

  const stssBox = findChild(view, stblStart, stblEnd, 'stss');
  const sync = parseStss(view, stssBox, sampleCount);

  const stsdBox = findChild(view, stblStart, stblEnd, 'stsd');
  if (!stsdBox) throw new Error('stbl missing stsd');

  return {
    trackId: tkhd.trackId,
    handlerType,
    timescale: mdhd.timescale,
    mediaDuration: mdhd.duration,
    tkhdDuration: tkhd.duration,
    matrix: tkhd.matrix,
    sampleCount,
    dts,
    cts,
    size,
    offset,
    sync,
    hasCtts,
    cttsVersion,
    rawTkhd: rawBoxBytes(view, tkhdBox),
    rawMdhd: rawBoxBytes(view, mdhdBox),
    rawStsd: rawBoxBytes(view, stsdBox),
    rawHdlr: rawBoxBytes(view, hdlrBox),
    rawMinfPrefix,
    editList,
  };
}

function trackRetainedBytes(t: TrackIndex): number {
  return t.dts.byteLength + t.cts.byteLength + t.size.byteLength + t.offset.byteLength + t.sync.byteLength;
}

export async function buildMp4Index(file: File): Promise<Mp4Index> {
  const t0 = performance.now();

  const moovHeader = await findTopLevelBox(file, 'moov');
  const moovBuf = await file.slice(moovHeader.offset, moovHeader.offset + moovHeader.boxSize).arrayBuffer();
  const view = new DataView(moovBuf);
  // Rebase: within `view`, moov starts at 0, so all offsets below are relative to moovHeader.offset.
  const moovContentStart = moovHeader.headerSize;
  const moovContentEnd = moovBuf.byteLength;

  const mvhdBox = findChild(view, moovContentStart, moovContentEnd, 'mvhd');
  if (!mvhdBox) throw new Error('moov missing mvhd');
  const mvhdContentStart = mvhdBox.offset + mvhdBox.headerSize;
  const { version: mvhdVersion } = readFullBoxVersion(view, mvhdContentStart);
  let mvhdTimescale: number;
  let mvhdDuration: number;
  if (mvhdVersion === 1) {
    mvhdTimescale = view.getUint32(mvhdContentStart + 4 + 8 + 8);
    mvhdDuration = Number(view.getBigUint64(mvhdContentStart + 4 + 8 + 8 + 4));
  } else {
    mvhdTimescale = view.getUint32(mvhdContentStart + 4 + 4 + 4);
    mvhdDuration = view.getUint32(mvhdContentStart + 4 + 4 + 4 + 4);
  }

  const tracks: TrackIndex[] = [];
  for (const box of iterateBoxes(view, moovContentStart, moovContentEnd)) {
    if (box.type !== 'trak') continue;
    tracks.push(buildTrackIndex(view, box));
  }

  const buildMs = performance.now() - t0;
  const retainedBytes = tracks.reduce((sum, t) => sum + trackRetainedBytes(t), 0);

  return {
    mvhdTimescale,
    mvhdDuration,
    rawMvhd: rawBoxBytes(view, mvhdBox),
    tracks,
    moovOffset: moovHeader.offset,
    moovSize: moovHeader.boxSize,
    buildMs,
    retainedBytes,
  };
}
