// Orchestrates one <trak>: mirrors src/spikes/A-remux/mp4-index.ts's buildTrackIndex, but
// classifies the track first and skips sample-table parsing entirely for non-media ('other')
// tracks (tmcd timecode tracks, chapter tracks, ...) instead of assuming every track has a
// conventional stbl.

import { findChild, requireChild, type BoxHeader } from '../box-cursor';
import { MalformedBoxError, type IndexWarning } from '../errors';
import type { AudioTrackMeta, TrackIndex, VideoTrackMeta } from '../track-index';
import { computeEditOffset, findEditList } from './edit-list';
import { parseHdlr } from './hdlr';
import { parseMdhd } from './mdhd';
import { parseTkhd, rotationDegreesFromMatrix } from './tkhd';
import { parseCtts } from './stbl/ctts';
import { computeSampleOffsets, parseStsc } from './stbl/stsc';
import { parseChunkOffsets } from './stbl/stco';
import { parseStsd } from './stbl/stsd';
import { parseStss } from './stbl/stss';
import { parseStsz, parseStz2 } from './stbl/stsz';
import { parseStts } from './stbl/stts';

export interface BuildTrackResult {
  readonly track: TrackIndex;
  readonly warnings: IndexWarning[];
}

export type BuildTrackOutcome = { kind: 'ok'; result: BuildTrackResult } | { kind: 'encrypted' };

const ENCRYPTED_SAMPLE_ENTRY_TYPES = new Set(['encv', 'enca', 'encs', 'enct']);

function classifyKind(handlerType: string): 'video' | 'audio' | 'other' {
  if (handlerType === 'vide') return 'video';
  if (handlerType === 'soun') return 'audio';
  return 'other';
}

/** Distinct-run-values check over stts's already-expanded per-sample durations -- a track is CFR (constant frame rate) iff every sample has the same duration. */
function computeFrameRateInfo(durations: Float64Array, timescale: number): { nominalFrameRate: number; constantDuration: boolean } {
  if (durations.length === 0) return { nominalFrameRate: 0, constantDuration: true };
  const first = durations[0];
  let constantDuration = true;
  for (let i = 1; i < durations.length; i += 1) {
    if (durations[i] !== first) {
      constantDuration = false;
      break;
    }
  }
  if (constantDuration) return { nominalFrameRate: first > 0 ? timescale / first : 0, constantDuration: true };

  const sorted = Float64Array.from(durations).sort();
  const median = sorted[Math.floor(sorted.length / 2)];
  return { nominalFrameRate: median > 0 ? timescale / median : 0, constantDuration: false };
}

export function buildTrackIndex(view: DataView, trak: BoxHeader, movieTimescale: number, movieDuration: number): BuildTrackOutcome {
  const trakStart = trak.offset + trak.headerSize;
  const trakEnd = trak.offset + trak.boxSize;

  const tkhdBox = requireChild(view, trakStart, trakEnd, 'tkhd', 'trak');
  const tkhd = parseTkhd(view, tkhdBox);

  const mdiaBox = requireChild(view, trakStart, trakEnd, 'mdia', 'trak');
  const mdiaStart = mdiaBox.offset + mdiaBox.headerSize;
  const mdiaEnd = mdiaBox.offset + mdiaBox.boxSize;

  const mdhdBox = requireChild(view, mdiaStart, mdiaEnd, 'mdhd', 'mdia');
  const mdhd = parseMdhd(view, mdhdBox);

  const hdlrBox = requireChild(view, mdiaStart, mdiaEnd, 'hdlr', 'mdia');
  const hdlr = parseHdlr(view, hdlrBox);
  const kind = classifyKind(hdlr.handlerType);

  const warnings: IndexWarning[] = [];
  const editList = findEditList(view, trakStart, trakEnd);
  let editOffsetTicks = 0;
  if (editList && editList.length > 0) {
    const editResult = computeEditOffset(editList, movieTimescale, mdhd.timescale, movieDuration);
    editOffsetTicks = editResult.editOffsetTicks;
    if (editResult.isNonTrivial) warnings.push({ kind: 'non-trivial-edit-list', trackId: tkhd.trackId, entries: editList });
  }

  if (kind === 'other') {
    const track: TrackIndex = {
      trackId: tkhd.trackId,
      kind,
      handlerType: hdlr.handlerType,
      codec: '',
      timescale: mdhd.timescale,
      duration: mdhd.duration,
      sampleCount: 0,
      pts: new Float64Array(0),
      dts: new Float64Array(0),
      offset: new Float64Array(0),
      size: new Uint32Array(0),
      isSync: new Uint8Array(0),
      description: new Uint8Array(0),
      editOffsetTicks,
      editList,
    };
    return { kind: 'ok', result: { track, warnings } };
  }

  const minfBox = requireChild(view, mdiaStart, mdiaEnd, 'minf', 'mdia');
  const stblBox = requireChild(view, minfBox.offset + minfBox.headerSize, minfBox.offset + minfBox.boxSize, 'stbl', 'minf');
  const stblStart = stblBox.offset + stblBox.headerSize;
  const stblEnd = stblBox.offset + stblBox.boxSize;

  const sttsBox = requireChild(view, stblStart, stblEnd, 'stts', 'stbl');
  const { durations, sampleCount } = parseStts(view, sttsBox);

  const dts = new Float64Array(sampleCount);
  for (let i = 1; i < sampleCount; i += 1) dts[i] = dts[i - 1] + durations[i - 1];

  const cttsBox = findChild(view, stblStart, stblEnd, 'ctts');
  let pts: Float64Array;
  if (cttsBox) {
    const { offsets } = parseCtts(view, cttsBox, sampleCount);
    pts = new Float64Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) pts[i] = dts[i] + offsets[i];
  } else {
    pts = dts.slice();
  }

  const stszBox = findChild(view, stblStart, stblEnd, 'stsz');
  const stz2Box = stszBox ? undefined : findChild(view, stblStart, stblEnd, 'stz2');
  let size: Uint32Array;
  if (stszBox) size = parseStsz(view, stszBox);
  else if (stz2Box) size = parseStz2(view, stz2Box);
  else throw new MalformedBoxError('stsz', stblStart, "stbl is missing both 'stsz' and 'stz2'");
  if (size.length !== sampleCount) {
    throw new MalformedBoxError('stsz', stblStart, `sample count ${String(size.length)} disagrees with stts's ${String(sampleCount)}`);
  }

  const stscBox = requireChild(view, stblStart, stblEnd, 'stsc', 'stbl');
  const stsc = parseStsc(view, stscBox);

  const stcoBox = findChild(view, stblStart, stblEnd, 'stco');
  const co64Box = stcoBox ? undefined : findChild(view, stblStart, stblEnd, 'co64');
  const chunkBox = stcoBox ?? co64Box;
  if (!chunkBox) throw new MalformedBoxError('stco', stblStart, "stbl is missing both 'stco' and 'co64'");
  const chunkOffsets = parseChunkOffsets(view, chunkBox);
  const offset = computeSampleOffsets(chunkOffsets, stsc, size);

  const stssBox = findChild(view, stblStart, stblEnd, 'stss');
  const isSync = parseStss(view, stssBox, sampleCount);

  const stsdBox = requireChild(view, stblStart, stblEnd, 'stsd', 'stbl');
  const stsd = parseStsd(view, stsdBox, kind);
  if (ENCRYPTED_SAMPLE_ENTRY_TYPES.has(stsd.sampleEntryType)) return { kind: 'encrypted' };
  if (stsd.entryCount > 1) warnings.push({ kind: 'multiple-stsd-entries', trackId: tkhd.trackId, entryCount: stsd.entryCount });

  let video: VideoTrackMeta | undefined;
  let audio: AudioTrackMeta | undefined;
  if (kind === 'video') {
    const { nominalFrameRate, constantDuration } = computeFrameRateInfo(durations, mdhd.timescale);
    video = {
      codedWidth: stsd.codedWidth ?? tkhd.displayWidth,
      codedHeight: stsd.codedHeight ?? tkhd.displayHeight,
      displayWidth: tkhd.displayWidth,
      displayHeight: tkhd.displayHeight,
      rotationDegrees: rotationDegreesFromMatrix(tkhd.matrix),
      nominalFrameRate,
      constantDuration,
    };
  } else {
    audio = {
      channelCount: stsd.channelCount ?? 0,
      sampleRate: stsd.sampleRate ?? mdhd.timescale,
      language: mdhd.language,
      handlerName: hdlr.name,
    };
  }

  const track: TrackIndex = {
    trackId: tkhd.trackId,
    kind,
    handlerType: hdlr.handlerType,
    codec: stsd.codec,
    timescale: mdhd.timescale,
    duration: mdhd.duration,
    sampleCount,
    pts,
    dts,
    offset,
    size,
    isSync,
    description: stsd.description,
    video,
    audio,
    editOffsetTicks,
    editList,
  };

  return { kind: 'ok', result: { track, warnings } };
}
