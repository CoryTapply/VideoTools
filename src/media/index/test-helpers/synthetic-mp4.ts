// Assembles a minimal, complete ftyp+moov+mdat buffer for build-index.test.ts's end-to-end
// tests. Each track is simplified to a single stsc run / single chunk (stsc/stco run expansion
// itself already has dedicated unit tests in moov/stbl/stsc.test.ts and stco.test.ts) -- this
// helper is about exercising the orchestration in build-index.ts/build-track-index.ts, not
// re-proving each table parser.

import { box, concatBytes, fourcc, fullBoxHeader, i16, i32, u16, u32 } from './build-box';

export interface SyntheticEditListEntry {
  segmentDuration: number;
  mediaTime: number;
  mediaRateInteger: number;
  mediaRateFraction: number;
}

export interface SyntheticTrackSpec {
  trackId: number;
  handlerType: string;
  /** hdlr's human-readable name field. */
  name?: string;
  timescale: number;
  mediaDuration: number;
  tkhdDuration: number;
  sampleDurations: number[];
  sampleSizes: number[];
  /** Omit for "no stss" (every sample is sync). */
  syncFlags?: number[];
  cttsOffsets?: number[];
  cttsVersion?: 0 | 1;
  chunkOffset: number;
  sampleEntryBoxes: Uint8Array[];
  editList?: SyntheticEditListEntry[];
  matrix?: number[];
  width?: number;
  height?: number;
}

function collapseRuns(values: number[]): { count: number; value: number }[] {
  const runs: { count: number; value: number }[] = [];
  for (const v of values) {
    const last = runs.at(-1);
    if (last && last.value === v) last.count += 1;
    else runs.push({ count: 1, value: v });
  }
  return runs;
}

function buildStts(durations: number[]): Uint8Array {
  const runs = collapseRuns(durations);
  const entries = runs.flatMap((r) => [u32(r.count), u32(r.value)]);
  return box('stts', [fullBoxHeader(0), u32(runs.length), ...entries]);
}

function buildCtts(offsets: number[], version: 0 | 1): Uint8Array {
  const runs = collapseRuns(offsets);
  const entries = runs.flatMap((r) => [u32(r.count), version === 1 ? i32(r.value) : u32(r.value)]);
  return box('ctts', [fullBoxHeader(version), u32(runs.length), ...entries]);
}

function buildStsz(sizes: number[]): Uint8Array {
  if (sizes.length > 0 && sizes.every((s) => s === sizes[0])) {
    return box('stsz', [fullBoxHeader(0), u32(sizes[0]), u32(sizes.length)]);
  }
  return box('stsz', [fullBoxHeader(0), u32(0), u32(sizes.length), ...sizes.map((s) => u32(s))]);
}

function buildStsc(sampleCount: number): Uint8Array {
  return box('stsc', [fullBoxHeader(0), u32(1), u32(1), u32(sampleCount), u32(1)]);
}

function buildStco(chunkOffset: number): Uint8Array {
  return box('stco', [fullBoxHeader(0), u32(1), u32(chunkOffset)]);
}

function buildStss(syncFlags: number[]): Uint8Array {
  const syncSampleNumbers = syncFlags.flatMap((v, i) => (v === 1 ? [i + 1] : []));
  return box('stss', [fullBoxHeader(0), u32(syncSampleNumbers.length), ...syncSampleNumbers.map((n) => u32(n))]);
}

function buildStsd(sampleEntryBoxes: Uint8Array[]): Uint8Array {
  return box('stsd', [fullBoxHeader(0), u32(sampleEntryBoxes.length), ...sampleEntryBoxes]);
}

function buildTkhd(trackId: number, duration: number, matrix: number[], width: number, height: number): Uint8Array {
  const fixed = (n: number): Uint8Array => i32(Math.round(n * 65536));
  return box('tkhd', [
    fullBoxHeader(0, 7),
    u32(0),
    u32(0), // creation_time, modification_time
    u32(trackId),
    u32(0), // reserved
    u32(duration),
    new Uint8Array(8), // reserved[2]
    u16(0),
    u16(0),
    u16(0),
    u16(0), // layer, alternate_group, volume, reserved
    ...matrix.map(fixed),
    fixed(width),
    fixed(height),
  ]);
}

function buildMdhd(timescale: number, duration: number): Uint8Array {
  return box('mdhd', [fullBoxHeader(0), u32(0), u32(0), u32(timescale), u32(duration), u16(0), u16(0)]);
}

function buildHdlr(handlerType: string, name = ''): Uint8Array {
  const nameBytes = concatBytes([Uint8Array.from(Array.from(name, (c) => c.charCodeAt(0))), Uint8Array.of(0)]);
  return box('hdlr', [fullBoxHeader(0), u32(0), fourcc(handlerType), new Uint8Array(12), nameBytes]);
}

function buildEdts(entries: SyntheticEditListEntry[]): Uint8Array {
  const parts = entries.flatMap((e) => [u32(e.segmentDuration), i32(e.mediaTime), i16(e.mediaRateInteger), i16(e.mediaRateFraction)]);
  return box('edts', box('elst', [fullBoxHeader(0), u32(entries.length), ...parts]));
}

export function buildSyntheticTrak(spec: SyntheticTrackSpec): Uint8Array {
  const sampleCount = spec.sampleDurations.length;
  const stblChildren: Uint8Array[] = [buildStts(spec.sampleDurations)];
  if (spec.cttsOffsets) stblChildren.push(buildCtts(spec.cttsOffsets, spec.cttsVersion ?? 0));
  stblChildren.push(buildStsz(spec.sampleSizes), buildStsc(sampleCount), buildStco(spec.chunkOffset));
  if (spec.syncFlags) stblChildren.push(buildStss(spec.syncFlags));
  stblChildren.push(buildStsd(spec.sampleEntryBoxes));

  const minf = box('minf', box('stbl', stblChildren));
  const mdia = box('mdia', [buildMdhd(spec.timescale, spec.mediaDuration), buildHdlr(spec.handlerType, spec.name ?? ''), minf]);

  const trakChildren: Uint8Array[] = [buildTkhd(spec.trackId, spec.tkhdDuration, spec.matrix ?? [1, 0, 0, 0, 1, 0, 0, 0, 1], spec.width ?? 0, spec.height ?? 0)];
  if (spec.editList) trakChildren.push(buildEdts(spec.editList));
  trakChildren.push(mdia);

  return box('trak', trakChildren);
}

export function buildSyntheticMoov(tracks: Uint8Array[], movieTimescale: number, movieDuration: number, extraChildren: Uint8Array[] = []): Uint8Array {
  const mvhd = box('mvhd', [
    fullBoxHeader(0),
    u32(0),
    u32(0), // creation_time, modification_time
    u32(movieTimescale),
    u32(movieDuration),
    u32(0x00010000), // rate, 16.16 fixed = 1.0
    u16(0x0100), // volume, 8.8 fixed = 1.0
    u16(0), // reserved
    u32(0),
    u32(0), // reserved[2]
    ...[1, 0, 0, 0, 1, 0, 0, 0, 1].map((n) => i32(n * 65536)),
    new Uint8Array(24), // pre_defined[6]
    u32(tracks.length + 1), // next_track_ID
  ]);
  return box('moov', [mvhd, ...tracks, ...extraChildren]);
}

export function buildSyntheticFile(moov: Uint8Array, mdatSize = 16): Uint8Array {
  const ftyp = box('ftyp', concatBytes([fourcc('isom'), u32(0), fourcc('isom'), fourcc('mp42')]));
  const mdat = box('mdat', new Uint8Array(mdatSize));
  return concatBytes([ftyp, moov, mdat]);
}
