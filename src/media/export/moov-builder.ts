// Pass 1: builds the complete output ftyp+moov entirely in memory from a pre-built schedule --
// touches only the index (sample sizes/timing/sync flags), never mdat bytes, so it needs no I/O.
// Ported from src/spikes/A-remux/remux-write.ts's box-building half, retyped against production
// TrackIndex field names (.dts/.pts/.size/.isSync) and RawMoovBoxes. Only the merged schedule path
// is carried forward -- the spike's original per-track ~1s round-robin schedule (kept there only
// for A/B comparison against the merged fix) is not promoted.
//
// ctts is always built as version 1 (signed offsets) when any in-range sample has pts !== dts,
// since production TrackIndex doesn't carry a source ctts version flag -- v1 is a strict superset
// of v0 for reading, so this is safe.

import { concatBytes, fourcc, fullBoxHeader, i32, makeBox, u32, u64 } from './box-writer';
import { planMergedSchedule, type WriteChunk } from './schedule';
import type { TrackIndex } from '../index/track-index';
import type { RawMoovBoxes } from './raw-boxes';
import type { ExportSelection } from './types';

// --- duration patching (tkhd/mdhd/mvhd share two distinct v0/v1 layouts) ---

function patchMvhdOrMdhdDuration(raw: Uint8Array, newDuration: number): Uint8Array {
  const out = raw.slice();
  const view = new DataView(out.buffer);
  const version = view.getUint8(8);
  if (version === 1) view.setBigUint64(8 + 4 + 8 + 8 + 4, BigInt(Math.round(newDuration)));
  else view.setUint32(8 + 4 + 4 + 4 + 4, Math.round(newDuration));
  return out;
}

function patchTkhdDuration(raw: Uint8Array, newDuration: number): Uint8Array {
  const out = raw.slice();
  const view = new DataView(out.buffer);
  const version = view.getUint8(8);
  if (version === 1) view.setBigUint64(8 + 4 + 8 + 8 + 4 + 4, BigInt(Math.round(newDuration)));
  else view.setUint32(8 + 4 + 4 + 4 + 4 + 4, Math.round(newDuration));
  return out;
}

/** timescale sits one u32 before duration in both mvhd layouts -- see patchMvhdOrMdhdDuration. */
function readMvhdTimescale(raw: Uint8Array): number {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const version = view.getUint8(8);
  const p = version === 1 ? 8 + 4 + 8 + 8 : 8 + 4 + 4 + 4;
  return view.getUint32(p);
}

// --- sample table rewriting ---

function sampleDuration(track: TrackIndex, i: number): number {
  if (i + 1 < track.sampleCount) return track.dts[i + 1] - track.dts[i];
  return Math.max(1, track.duration - track.dts[i]);
}

function runLengthEncode(values: number[]): Array<[count: number, value: number]> {
  const runs: Array<[number, number]> = [];
  for (const v of values) {
    if (runs.length > 0 && runs[runs.length - 1][1] === v) runs[runs.length - 1][0] += 1;
    else runs.push([1, v]);
  }
  return runs;
}

function buildStts(track: TrackIndex, first: number, last: number): Uint8Array {
  const durations: number[] = [];
  for (let i = first; i <= last; i += 1) durations.push(sampleDuration(track, i));
  const runs = runLengthEncode(durations);
  const parts = [fullBoxHeader(0), u32(runs.length)];
  for (const [count, value] of runs) parts.push(u32(count), u32(value));
  return makeBox('stts', concatBytes(parts));
}

function buildCtts(track: TrackIndex, first: number, last: number): Uint8Array | undefined {
  const offsets: number[] = [];
  let anyNonZero = false;
  for (let i = first; i <= last; i += 1) {
    const off = track.pts[i] - track.dts[i];
    if (off !== 0) anyNonZero = true;
    offsets.push(off);
  }
  if (!anyNonZero) return undefined;
  const runs = runLengthEncode(offsets);
  const parts = [fullBoxHeader(1), u32(runs.length)];
  for (const [count, value] of runs) parts.push(u32(count), i32(value));
  return makeBox('ctts', concatBytes(parts));
}

function buildStsz(track: TrackIndex, first: number, last: number): Uint8Array {
  const n = last - first + 1;
  const parts = [fullBoxHeader(0), u32(0) /* sampleSize=0 -> explicit per-sample sizes follow */, u32(n)];
  for (let i = first; i <= last; i += 1) parts.push(u32(track.size[i]));
  return makeBox('stsz', concatBytes(parts));
}

function buildStss(track: TrackIndex, first: number, last: number): Uint8Array | undefined {
  const syncNumbers: number[] = [];
  for (let i = first; i <= last; i += 1) if (track.isSync[i] === 1) syncNumbers.push(i - first + 1);
  // All samples sync (audio, or an intra-only video track) -> omit stss entirely, matching the
  // spec convention that absent stss means every sample is a sync sample.
  if (syncNumbers.length === last - first + 1) return undefined;
  const parts = [fullBoxHeader(0), u32(syncNumbers.length)];
  for (const n of syncNumbers) parts.push(u32(n));
  return makeBox('stss', concatBytes(parts));
}

function buildStcoAndStsc(entries: Array<{ chunk: WriteChunk; byteOffset: number }>): { stco: Uint8Array; stsc: Uint8Array } {
  const use64 = entries.length > 0 && entries[entries.length - 1].byteOffset > 0xffffffff;
  const stcoParts = [fullBoxHeader(0), u32(entries.length)];
  for (const e of entries) stcoParts.push(use64 ? u64(e.byteOffset) : u32(e.byteOffset));
  const stco = makeBox(use64 ? 'co64' : 'stco', concatBytes(stcoParts));

  const runs: Array<[firstChunk: number, samplesPerChunk: number]> = [];
  entries.forEach((e, idx) => {
    const count = e.chunk.last - e.chunk.first + 1;
    const chunkNum = idx + 1; // 1-based, LOCAL to this track (stco/stsc numbering is per-track, not global)
    if (runs.length === 0 || runs[runs.length - 1][1] !== count) runs.push([chunkNum, count]);
  });
  const stscParts = [fullBoxHeader(0), u32(runs.length)];
  for (const [firstChunk, count] of runs) stscParts.push(u32(firstChunk), u32(count), u32(1) /* sample_description_index */);
  const stsc = makeBox('stsc', concatBytes(stscParts));
  return { stco, stsc };
}

function buildFtyp(): Uint8Array {
  // Not copied from the source -- see README.md. isom/mp42 is the same conventional brand set
  // src/media/index/test-helpers/synthetic-mp4.ts uses, and build-index.ts never inspects ftyp's
  // content at all (only that a top-level moov exists).
  return makeBox('ftyp', concatBytes([fourcc('isom'), u32(0), fourcc('isom'), fourcc('mp42')]));
}

// --- mdat layout ---

interface MdatLayout {
  /** Per-track list of that track's own chunks (in schedule order) with their absolute byte offset in the OUTPUT file. */
  perTrack: Map<number, Array<{ chunk: WriteChunk; byteOffset: number }>>;
  mdatContentBytes: number;
}

function computeMdatLayout(schedule: WriteChunk[], tracksById: ReadonlyMap<number, TrackIndex>, mdatContentStart: number): MdatLayout {
  const perTrack = new Map<number, Array<{ chunk: WriteChunk; byteOffset: number }>>();
  let pos = mdatContentStart;
  for (const chunk of schedule) {
    const list = perTrack.get(chunk.trackId) ?? [];
    list.push({ chunk, byteOffset: pos });
    perTrack.set(chunk.trackId, list);
    const track = tracksById.get(chunk.trackId);
    if (!track) throw new Error(`export: no track for trackId ${String(chunk.trackId)}`);
    for (let i = chunk.first; i <= chunk.last; i += 1) pos += track.size[i];
  }
  return { perTrack, mdatContentBytes: pos - mdatContentStart };
}

// --- top-level assembly ---

export interface BuiltMoov {
  readonly bytes: Uint8Array;
  readonly mdatContentBytes: number;
  readonly schedule: WriteChunk[];
}

function assembleMoov(input: {
  raw: RawMoovBoxes;
  tracksById: ReadonlyMap<number, TrackIndex>;
  selection: ExportSelection;
  schedule: WriteChunk[];
  newDurationMovieUnits: number;
  ftyp: Uint8Array;
}) {
  const { raw, tracksById, selection, schedule, newDurationMovieUnits, ftyp } = input;
  const rawByTrackId = new Map(raw.tracks.map((t) => [t.trackId, t]));

  return (mdatContentStart: number): { bytes: Uint8Array; layout: MdatLayout } => {
    const layout = computeMdatLayout(schedule, tracksById, mdatContentStart);
    const mvhd = patchMvhdOrMdhdDuration(raw.mvhd, newDurationMovieUnits);

    const trakBoxes = selection.ranges.map((range) => {
      const track = tracksById.get(range.trackId);
      const rawTrack = rawByTrackId.get(range.trackId);
      if (!track || !rawTrack) throw new Error(`export: no track/raw-boxes for trackId ${String(range.trackId)}`);
      const { first, last } = range;

      const tkhd = patchTkhdDuration(rawTrack.tkhd, newDurationMovieUnits);
      const trackDurationLocal = track.dts[last] + sampleDuration(track, last) - track.dts[first];
      const mdhd = patchMvhdOrMdhdDuration(rawTrack.mdhd, trackDurationLocal);

      const stts = buildStts(track, first, last);
      const ctts = buildCtts(track, first, last);
      const stsz = buildStsz(track, first, last);
      const stss = buildStss(track, first, last);
      const entries = layout.perTrack.get(range.trackId) ?? [];
      const { stco, stsc } = buildStcoAndStsc(entries);

      const stblParts = [rawTrack.stsd, stts];
      if (ctts) stblParts.push(ctts);
      stblParts.push(stsc, stsz, stco);
      if (stss) stblParts.push(stss);
      const stbl = makeBox('stbl', concatBytes(stblParts));

      const minf = makeBox('minf', concatBytes([rawTrack.minfPrefix, stbl]));
      const mdia = makeBox('mdia', concatBytes([mdhd, rawTrack.hdlr, minf]));
      return makeBox('trak', concatBytes([tkhd, mdia]));
    });

    const moov = makeBox('moov', concatBytes([mvhd, ...trakBoxes]));
    return { bytes: concatBytes([ftyp, moov]), layout };
  };
}

function buildMoovFromSchedule(input: {
  raw: RawMoovBoxes;
  tracksById: ReadonlyMap<number, TrackIndex>;
  selection: ExportSelection;
  schedule: WriteChunk[];
  /** Primary video track's own timescale -- selection.actualIn/OutTicks are presentation ticks in
   * this timescale (see architecture-v3.md §2). Needed to convert to seconds, then to
   * mvhd's (movie) timescale for the patched duration fields. */
  videoTimescale: number;
}): BuiltMoov {
  const { raw, tracksById, selection, schedule, videoTimescale } = input;
  const mvhdTimescale = readMvhdTimescale(raw.mvhd);
  const actualInSec = selection.actualInTicks / videoTimescale;
  const actualOutSec = selection.actualOutTicks / videoTimescale;
  const newDurationMovieUnits = Math.round((actualOutSec - actualInSec) * mvhdTimescale);
  const ftyp = buildFtyp();

  const build = assembleMoov({ raw, tracksById, selection, schedule, newDurationMovieUnits, ftyp });

  // mdat's content starts right after ftyp + moov -- moov's size depends on this function's own
  // output, so build moov twice: once to learn its size (a placeholder mdat start of 0 affects
  // nothing, since stco offsets are relative to an explicit mdatContentStart parameter), then once
  // for real once that start is known.
  const sizingPass = build(0);
  const mdatContentStart = sizingPass.bytes.byteLength + 8; // + mdat's own 8-byte header (upgraded to 16 below if needed)
  const finalPass = build(mdatContentStart);
  // If mdat needs the 64-bit largesize form, its header grows from 8 to 16 bytes, shifting every
  // byte offset just computed -- redo once more with the corrected start. Two redos max:
  // mdatContentBytes doesn't change between passes (only depends on sample sizes), so this
  // converges immediately once the header-size guess is right.
  const needsLarge = finalPass.layout.mdatContentBytes + 8 > 0xffffffff;
  const correctedStart = sizingPass.bytes.byteLength + (needsLarge ? 16 : 8);
  const trulyFinal = correctedStart === mdatContentStart ? finalPass : build(correctedStart);

  return { bytes: trulyFinal.bytes, mdatContentBytes: trulyFinal.layout.mdatContentBytes, schedule };
}

/** Pass 1, source-offset-order schedule -- see schedule.ts's planMergedSchedule / copy-loop.ts's forEachWindowMerged. */
export function buildMoovMerged(
  raw: RawMoovBoxes,
  tracksById: ReadonlyMap<number, TrackIndex>,
  selection: ExportSelection,
  videoTimescale: number,
): BuiltMoov {
  const schedule = planMergedSchedule(selection.ranges, tracksById);
  return buildMoovFromSchedule({ raw, tracksById, selection, schedule, videoTimescale });
}

/** mdat's header only (size+type[+largesize]), sized to match `contentBytes`. */
export function buildMdatHeader(contentBytes: number): Uint8Array {
  const normalSize = 8 + contentBytes;
  if (normalSize <= 0xffffffff) return concatBytes([u32(normalSize), fourcc('mdat')]);
  return concatBytes([u32(1), fourcc('mdat'), u64(16 + contentBytes)]);
}
