// Spike A / Step 3 -- two-pass streamed faststart write. See
// prompts/m0.5-spike-prompts.md Step 3.
//
// Pass 1 (buildMoov below) needs no media bytes: every rewritten table's
// size and content is fully determined by the sample INDEX (counts, sizes,
// timing), not by mdat's actual bytes. So "pass 1" is simply: build the
// complete new moov (and ftyp) in memory, which gives us both its exact
// byte size AND its content in one step.
// Pass 2 (streamExport) does the only work that touches media bytes: write
// ftyp+moov (now that mdat's start offset is known), then copy each
// scheduled chunk's bytes from the source File straight to the output
// stream, in physical write order.

import type { Mp4Index, TrackIndex } from './mp4-index';
import type { SampleRange, SelectionResult } from './select';
import { concatBytes, fourcc, fullBoxHeader, makeBox, u32, u64 } from './box-writer';

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

// --- sample table rewriting ---

function sampleDuration(track: TrackIndex, i: number): number {
  if (i + 1 < track.sampleCount) return track.dts[i + 1]! - track.dts[i]!;
  return Math.max(1, track.mediaDuration - track.dts[i]!);
}

function runLengthEncode(values: number[]): Array<[count: number, value: number]> {
  const runs: Array<[number, number]> = [];
  for (const v of values) {
    const last = runs[runs.length - 1];
    if (last && last[1] === v) last[0] += 1;
    else runs.push([1, v]);
  }
  return runs;
}

function buildStts(track: TrackIndex, startIdx: number, endIdx: number): Uint8Array {
  const durations: number[] = [];
  for (let i = startIdx; i <= endIdx; i += 1) durations.push(sampleDuration(track, i));
  const runs = runLengthEncode(durations);
  const parts = [fullBoxHeader(0), u32(runs.length)];
  for (const [count, value] of runs) parts.push(u32(count), u32(value));
  return makeBox('stts', concatBytes(parts));
}

function buildCtts(track: TrackIndex, startIdx: number, endIdx: number): Uint8Array | undefined {
  if (!track.hasCtts) return undefined;
  const offsets: number[] = [];
  for (let i = startIdx; i <= endIdx; i += 1) offsets.push(track.cts[i]! - track.dts[i]!);
  const runs = runLengthEncode(offsets);
  const parts = [fullBoxHeader(track.cttsVersion), u32(runs.length)];
  for (const [count, value] of runs) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, value); // safe for both versions: v0 offsets are always >= 0
    parts.push(u32(count), b);
  }
  return makeBox('ctts', concatBytes(parts));
}

function buildStsz(track: TrackIndex, startIdx: number, endIdx: number): Uint8Array {
  const n = endIdx - startIdx + 1;
  const parts = [fullBoxHeader(0), u32(0) /* sampleSize=0 -> explicit per-sample sizes follow */, u32(n)];
  for (let i = startIdx; i <= endIdx; i += 1) parts.push(u32(track.size[i]!));
  return makeBox('stsz', concatBytes(parts));
}

function buildStss(track: TrackIndex, startIdx: number, endIdx: number): Uint8Array | undefined {
  const syncNumbers: number[] = [];
  for (let i = startIdx; i <= endIdx; i += 1) if (track.sync[i] === 1) syncNumbers.push(i - startIdx + 1);
  // All samples sync (e.g. audio, or an intra-only video track) -> omit stss entirely,
  // matching the spec convention that absent stss means every sample is a sync sample.
  if (syncNumbers.length === endIdx - startIdx + 1) return undefined;
  const parts = [fullBoxHeader(0), u32(syncNumbers.length)];
  for (const n of syncNumbers) parts.push(u32(n));
  return makeBox('stss', concatBytes(parts));
}

// --- chunk planning: interleave tracks in ~1s groups, per spec Step 3 ---

export interface WriteChunk {
  track: TrackIndex;
  startIdx: number;
  endIdx: number;
}

function planTrackChunks(range: SampleRange): WriteChunk[] {
  const { track } = range;
  const chunks: WriteChunk[] = [];
  let chunkStart = range.startIdx;
  let accum = 0;
  for (let i = range.startIdx; i <= range.endIdx; i += 1) {
    accum += sampleDuration(track, i);
    const isLast = i === range.endIdx;
    if (accum >= track.timescale || isLast) {
      chunks.push({ track, startIdx: chunkStart, endIdx: i });
      chunkStart = i + 1;
      accum = 0;
    }
  }
  return chunks;
}

/** Round-robins each track's own ~1s chunks so mdat interleaves video and every audio track, not video-then-audio. */
export function planWriteSchedule(ranges: SampleRange[]): WriteChunk[] {
  const perTrack = ranges.map(planTrackChunks);
  const maxLen = Math.max(0, ...perTrack.map((c) => c.length));
  const schedule: WriteChunk[] = [];
  for (let round = 0; round < maxLen; round += 1) {
    for (const chunks of perTrack) if (round < chunks.length) schedule.push(chunks[round]!);
  }
  return schedule;
}

interface MdatLayout {
  /** Per-track list of that track's own chunks (in schedule order) with their absolute byte offset in the OUTPUT file. */
  perTrack: Map<TrackIndex, Array<{ chunk: WriteChunk; byteOffset: number }>>;
  mdatContentBytes: number;
}

function computeMdatLayout(schedule: WriteChunk[], mdatContentStart: number): MdatLayout {
  const perTrack = new Map<TrackIndex, Array<{ chunk: WriteChunk; byteOffset: number }>>();
  let pos = mdatContentStart;
  for (const chunk of schedule) {
    const list = perTrack.get(chunk.track) ?? [];
    list.push({ chunk, byteOffset: pos });
    perTrack.set(chunk.track, list);
    for (let i = chunk.startIdx; i <= chunk.endIdx; i += 1) pos += chunk.track.size[i]!;
  }
  return { perTrack, mdatContentBytes: pos - mdatContentStart };
}

function buildStcoAndStsc(entries: Array<{ chunk: WriteChunk; byteOffset: number }>): { stco: Uint8Array; stsc: Uint8Array } {
  const use64 = entries.length > 0 && entries[entries.length - 1]!.byteOffset > 0xffffffff;
  const stcoParts = [fullBoxHeader(0), u32(entries.length)];
  for (const e of entries) stcoParts.push(use64 ? u64(e.byteOffset) : u32(e.byteOffset));
  const stco = makeBox(use64 ? 'co64' : 'stco', concatBytes(stcoParts));

  const runs: Array<[firstChunk: number, samplesPerChunk: number]> = [];
  entries.forEach((e, idx) => {
    const count = e.chunk.endIdx - e.chunk.startIdx + 1;
    const chunkNum = idx + 1; // 1-based, LOCAL to this track (stco/stsc numbering is per-track, not global)
    const last = runs[runs.length - 1];
    if (!last || last[1] !== count) runs.push([chunkNum, count]);
  });
  const stscParts = [fullBoxHeader(0), u32(runs.length)];
  for (const [firstChunk, count] of runs) stscParts.push(u32(firstChunk), u32(count), u32(1) /* sample_description_index */);
  const stsc = makeBox('stsc', concatBytes(stscParts));
  return { stco, stsc };
}

// --- top-level assembly ---

export interface BuiltMoov {
  bytes: Uint8Array;
  mdatContentBytes: number;
  schedule: WriteChunk[];
  layout: MdatLayout;
  newDurationMovieUnits: number;
}

/** Pass 1: builds ftyp+moov entirely in memory. Touches only the index -- never reads mdat bytes. */
export function buildMoov(index: Mp4Index, selection: SelectionResult, ftypBytes: Uint8Array): BuiltMoov {
  const schedule = planWriteSchedule(selection.ranges);
  // mdat's content starts right after ftyp + moov -- moov's size depends on this function's own
  // output, so we build moov TWICE: once to learn its size (using a placeholder mdat start of 0,
  // which affects nothing since stco offsets are relative to a mdatContentStart parameter we
  // pass in explicitly below), then once for real once that start is known.
  const newDurationMovieUnits = Math.round((selection.actualOutSec - selection.actualInSec) * index.mvhdTimescale);

  function assembleMoov(mdatContentStart: number): { bytes: Uint8Array; layout: MdatLayout } {
    const layout = computeMdatLayout(schedule, mdatContentStart);
    const mvhd = patchMvhdOrMdhdDuration(index.rawMvhd, newDurationMovieUnits);

    const trakBoxes = selection.ranges.map((range) => {
      const { track, startIdx, endIdx } = range;
      const tkhd = patchTkhdDuration(track.rawTkhd, newDurationMovieUnits);
      const trackDurationLocal = track.dts[endIdx]! + sampleDuration(track, endIdx) - track.dts[startIdx]!;
      const mdhd = patchMvhdOrMdhdDuration(track.rawMdhd, trackDurationLocal);

      const stts = buildStts(track, startIdx, endIdx);
      const ctts = buildCtts(track, startIdx, endIdx);
      const stsz = buildStsz(track, startIdx, endIdx);
      const stss = buildStss(track, startIdx, endIdx);
      const entries = layout.perTrack.get(track) ?? [];
      const { stco, stsc } = buildStcoAndStsc(entries);

      const stblParts = [track.rawStsd, stts];
      if (ctts) stblParts.push(ctts);
      stblParts.push(stsc, stsz, stco);
      if (stss) stblParts.push(stss);
      const stbl = makeBox('stbl', concatBytes(stblParts));

      const minf = makeBox('minf', concatBytes([track.rawMinfPrefix, stbl]));
      const mdia = makeBox('mdia', concatBytes([mdhd, track.rawHdlr, minf]));
      return makeBox('trak', concatBytes([tkhd, mdia]));
    });

    const moov = makeBox('moov', concatBytes([mvhd, ...trakBoxes]));
    return { bytes: concatBytes([ftypBytes, moov]), layout };
  }

  // First pass: assemble with a placeholder mdat start to learn ftyp+moov's total size.
  const sizingPass = assembleMoov(0);
  const mdatContentStart = sizingPass.bytes.byteLength + 8; // + mdat's own 8-byte header (upgraded to 16 below if needed)
  const finalPass = assembleMoov(mdatContentStart);
  // If mdat needs the 64-bit largesize form, its header grows from 8 to 16 bytes, which shifts
  // every byte offset we just computed -- redo once more with the corrected start. Two redos
  // max: mdatContentBytes doesn't change between passes (only depends on sample sizes), so this
  // converges immediately once the header-size guess is right.
  const needsLarge = finalPass.layout.mdatContentBytes + 8 > 0xffffffff;
  const correctedStart = sizingPass.bytes.byteLength + (needsLarge ? 16 : 8);
  const trulyFinal = correctedStart === mdatContentStart ? finalPass : assembleMoov(correctedStart);

  return {
    bytes: trulyFinal.bytes,
    mdatContentBytes: trulyFinal.layout.mdatContentBytes,
    schedule,
    layout: trulyFinal.layout,
    newDurationMovieUnits,
  };
}

/** mdat's header only (size+type[+largesize]), sized to match `contentBytes`. */
export function buildMdatHeader(contentBytes: number): Uint8Array {
  const normalSize = 8 + contentBytes;
  if (normalSize <= 0xffffffff) return concatBytes([u32(normalSize), fourcc('mdat')]);
  return concatBytes([u32(1), fourcc('mdat'), u64(16 + contentBytes)]);
}

// --- Step 5 finding: per-sample File.slice()/arrayBuffer() calls are dominated by browser
// per-call overhead (measured ~84 MB/s in Chrome vs. 300-600+ MB/s in Node for the same file),
// because this source interleaves tracks far more finely than our own ~1s output chunking, so a
// track's own consecutive samples are NOT close together in the file. Reading a bigger WINDOW
// per call and slicing the needed sample(s) out of it in memory trades some wasted over-read
// bytes for far fewer, larger calls -- a clear net win in the sweep (1MB windows: ~1230 MB/s
// vs. ~84 MB/s per-sample, at a ~5.8x over-read ratio). Shared here so the real export path and
// the diagnostic sweep use identical windowing logic rather than two implementations drifting.

export interface CoalescedReadStats {
  windowReads: number;
  windowBytesRead: number;
}

/**
 * Walks `chunks` in schedule order, grouping each track's consecutive selected samples into
 * windows up to `windowBytes`, fetching each window in one read, and invoking `onSample` with
 * just that sample's own bytes (sliced out of the window, not the whole window).
 */
export async function forEachSampleCoalesced(
  file: File,
  chunks: WriteChunk[],
  windowBytes: number,
  onSample: (track: TrackIndex, sampleIdx: number, bytes: Uint8Array) => Promise<void>,
): Promise<CoalescedReadStats> {
  let windowReads = 0;
  let windowBytesRead = 0;
  for (const chunk of chunks) {
    const { track } = chunk;
    let i = chunk.startIdx;
    while (i <= chunk.endIdx) {
      const windowStart = track.offset[i]!;
      let windowEnd = windowStart;
      let j = i;
      while (j <= chunk.endIdx && track.offset[j]! + track.size[j]! - windowStart <= windowBytes) {
        windowEnd = track.offset[j]! + track.size[j]!;
        j += 1;
      }
      if (j === i) {
        // a single sample bigger than the window -- read it directly, can't coalesce further
        windowEnd = track.offset[i]! + track.size[i]!;
        j = i + 1;
      }
      const windowBuf = new Uint8Array(await file.slice(windowStart, windowEnd).arrayBuffer());
      windowReads += 1;
      windowBytesRead += windowEnd - windowStart;
      for (let k = i; k < j; k += 1) {
        const relOffset = track.offset[k]! - windowStart;
        const len = track.size[k]!;
        await onSample(track, k, windowBuf.subarray(relOffset, relOffset + len));
      }
      i = j;
    }
  }
  return { windowReads, windowBytesRead };
}
