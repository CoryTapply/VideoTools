// A synthetic, byte-self-consistent MP4 for export round-trip testing. Unlike
// src/media/index/test-helpers/synthetic-mp4.ts (whose mdat is a meaningless placeholder -- fine
// for testing the index PARSER's table logic, which never reads mdat), this helper's mdat contains
// real, deterministic bytes at every sample's declared offset. That's necessary to prove the
// export COPY path moves the right bytes, not just that the rewritten moov's tables parse.
//
// Tracks are laid out back-to-back in mdat (video block, then each audio block in order) --
// interleaved placement is already covered by schedule.test.ts/copy-loop.test.ts, so this helper
// keeps offset arithmetic simple rather than re-proving that.

import { box, concatBytes, fourcc, u32 } from '../../index/test-helpers/build-box';
import { buildSyntheticMoov, buildSyntheticTrak } from '../../index/test-helpers/synthetic-mp4';

export interface SyntheticSourceTrackSpec {
  trackId: number;
  handlerType: 'vide' | 'soun';
  name?: string;
  timescale: number;
  sampleDurations: number[];
  syncFlags?: number[];
  cttsOffsets?: number[];
  sampleEntryBoxes: Uint8Array[];
}

export interface SyntheticSource {
  bytes: Uint8Array;
  /** trackId -> that track's sample content, decode-order indexed -- for asserting round-tripped bytes. */
  sampleContent: Map<number, Uint8Array[]>;
}

const SAMPLE_SIZE = 40;

function markedSample(trackId: number, sampleIdx: number): Uint8Array {
  const b = new Uint8Array(SAMPLE_SIZE);
  for (let i = 0; i < SAMPLE_SIZE; i += 1) b[i] = (trackId * 31 + sampleIdx * 7 + i) & 0xff;
  return b;
}

function buildFtyp(): Uint8Array {
  return box('ftyp', concatBytes([fourcc('isom'), u32(0), fourcc('isom'), fourcc('mp42')]));
}

export function buildSyntheticSource(tracks: SyntheticSourceTrackSpec[], movieTimescale: number): SyntheticSource {
  const sampleContent = new Map<number, Uint8Array[]>();
  for (const t of tracks) sampleContent.set(t.trackId, t.sampleDurations.map((_, i) => markedSample(t.trackId, i)));

  function assemblePrefix(chunkOffsets: Map<number, number>): Uint8Array {
    const traks = tracks.map((t) => {
      const mediaDuration = t.sampleDurations.reduce((a, b) => a + b, 0);
      return buildSyntheticTrak({
        trackId: t.trackId,
        handlerType: t.handlerType,
        name: t.name,
        timescale: t.timescale,
        mediaDuration,
        tkhdDuration: Math.round((mediaDuration / t.timescale) * movieTimescale),
        sampleDurations: t.sampleDurations,
        sampleSizes: t.sampleDurations.map(() => SAMPLE_SIZE),
        syncFlags: t.syncFlags,
        cttsOffsets: t.cttsOffsets,
        chunkOffset: chunkOffsets.get(t.trackId) ?? 0,
        sampleEntryBoxes: t.sampleEntryBoxes,
      });
    });
    const movieDuration = Math.max(
      ...tracks.map((t) => Math.round((t.sampleDurations.reduce((a, b) => a + b, 0) / t.timescale) * movieTimescale)),
    );
    const moov = buildSyntheticMoov(traks, movieTimescale, movieDuration);
    return concatBytes([buildFtyp(), moov]);
  }

  // stco's per-chunk-offset encoding is a fixed-width u32 for every value these tiny fixtures use,
  // so ftyp+moov's byte length doesn't depend on which chunk offsets are plugged in -- one sizing
  // pass with placeholders, then one real pass, is enough (no fixed-point convergence needed).
  const zeroOffsets = new Map(tracks.map((t) => [t.trackId, 0]));
  const sizingPrefix = assemblePrefix(zeroOffsets);
  const mdatContentStart = sizingPrefix.byteLength + 8;

  const chunkOffsets = new Map<number, number>();
  let pos = mdatContentStart;
  for (const t of tracks) {
    chunkOffsets.set(t.trackId, pos);
    pos += t.sampleDurations.length * SAMPLE_SIZE;
  }
  const mdatContentBytes = pos - mdatContentStart;

  const finalPrefix = assemblePrefix(chunkOffsets);
  if (finalPrefix.byteLength !== sizingPrefix.byteLength) {
    throw new Error('synthetic source: ftyp+moov size changed between the sizing and final passes');
  }

  const mdatHeader = concatBytes([u32(8 + mdatContentBytes), fourcc('mdat')]);
  const mdatContent = concatBytes(tracks.flatMap((t) => sampleContent.get(t.trackId) ?? []));
  const bytes = concatBytes([finalPrefix, mdatHeader, mdatContent]);
  return { bytes, sampleContent };
}
