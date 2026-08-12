import { describe, expect, it } from 'vitest';
import { BufferByteSource } from '../index/sources/buffer-byte-source';
import { box, fourcc } from '../index/test-helpers/build-box';
import { buildSyntheticFile, buildSyntheticMoov, buildSyntheticTrak } from '../index/test-helpers/synthetic-mp4';
import { readRawMoovBoxes, type RawMoovBoxes } from './raw-boxes';

function boxType(bytes: Uint8Array): string {
  return String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
}

function boxSize(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
}

const videoSampleEntry = box('avc1', new Uint8Array(78));
const audioSampleEntry = box('mp4a', new Uint8Array(28));

function buildTwoTrackFile(): Uint8Array {
  const video = buildSyntheticTrak({
    trackId: 1,
    handlerType: 'vide',
    timescale: 30000,
    mediaDuration: 300,
    tkhdDuration: 10,
    sampleDurations: [3000, 3000, 3000],
    sampleSizes: [1000, 500, 500],
    syncFlags: [1, 0, 0],
    chunkOffset: 999, // overwritten by build-index once real offsets matter; irrelevant here
    sampleEntryBoxes: [videoSampleEntry],
  });
  const audio = buildSyntheticTrak({
    trackId: 2,
    handlerType: 'soun',
    name: 'Mic/Aux',
    timescale: 48000,
    mediaDuration: 480,
    tkhdDuration: 10,
    sampleDurations: [16000, 16000],
    sampleSizes: [200, 200],
    chunkOffset: 999,
    sampleEntryBoxes: [audioSampleEntry],
  });
  const moov = buildSyntheticMoov([video, audio], 1000, 10);
  return buildSyntheticFile(moov);
}

describe('readRawMoovBoxes', () => {
  it('extracts mvhd and per-track raw boxes, keyed by real track id', async () => {
    const source = new BufferByteSource(buildTwoTrackFile());
    const result = await readRawMoovBoxes(source);
    if ('error' in result) throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
    const raw: RawMoovBoxes = result;

    expect(boxType(raw.mvhd)).toBe('mvhd');
    expect(boxSize(raw.mvhd)).toBe(raw.mvhd.byteLength);

    expect(raw.tracks).toHaveLength(2);
    const byId = new Map(raw.tracks.map((t) => [t.trackId, t]));
    expect([...byId.keys()].sort()).toEqual([1, 2]);

    for (const t of raw.tracks) {
      expect(boxType(t.tkhd)).toBe('tkhd');
      expect(boxType(t.mdhd)).toBe('mdhd');
      expect(boxType(t.hdlr)).toBe('hdlr');
      expect(boxType(t.stsd)).toBe('stsd');
      expect(boxSize(t.tkhd)).toBe(t.tkhd.byteLength);
      expect(boxSize(t.mdhd)).toBe(t.mdhd.byteLength);
    }
  });

  it('returns an error for a file with no moov', async () => {
    const source = new BufferByteSource(box('ftyp', fourcc('isom')));
    const result = await readRawMoovBoxes(source);
    expect(result).toEqual({ error: { kind: 'no-moov' } });
  });
});
