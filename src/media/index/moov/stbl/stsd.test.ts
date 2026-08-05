import { describe, expect, it } from 'vitest';
import { readBoxHeaderInView } from '../../box-cursor';
import { box, concatBytes, fullBoxHeader, u16, u32, u8 } from '../../test-helpers/build-box';
import { parseStsd } from './stsd';

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function descriptor(tag: number, content: Uint8Array): Uint8Array {
  if (content.byteLength >= 128) throw new Error('test helper only supports single-byte descriptor lengths');
  return concatBytes([u8(tag), u8(content.byteLength), content]);
}

describe('parseStsd (video / avc1)', () => {
  it('computes the RFC 6381 codec string and coded dimensions from avcC', () => {
    const avcC = box('avcC', concatBytes([u8(1), u8(0x64), u8(0x00), u8(0x34), new Uint8Array(2)]));
    const avc1 = box('avc1', [
      new Uint8Array(6), // reserved
      u16(1), // data_reference_index
      u16(0), // pre_defined
      u16(0), // reserved
      new Uint8Array(12), // pre_defined[3]
      u16(1920), // width
      u16(1080), // height
      u32(0x00480000), // horizresolution
      u32(0x00480000), // vertresolution
      u32(0), // reserved
      u16(1), // frame_count
      new Uint8Array(32), // compressorname
      u16(0x0018), // depth
      u16(0xffff), // pre_defined (-1)
      avcC,
    ]);
    const stsd = box('stsd', [fullBoxHeader(0), u32(1), avc1]);
    const view = viewOf(stsd);
    const header = readBoxHeaderInView(view, 0, stsd.byteLength);

    const result = parseStsd(view, header, 'video');
    expect(result.codec).toBe('avc1.640034');
    expect(result.codedWidth).toBe(1920);
    expect(result.codedHeight).toBe(1080);
    expect(result.entryCount).toBe(1);
    expect(result.description.byteLength).toBe(avcC.byteLength);
  });
});

describe('parseStsd (audio / mp4a)', () => {
  it('computes the RFC 6381 codec string and channel/sample-rate metadata from esds', () => {
    const decSpecInfo = descriptor(0x05, Uint8Array.of(0x12, 0x08)); // audioObjectType = 2 (AAC LC)
    const decConfigContent = concatBytes([
      u8(0x40), // objectTypeIndication: MPEG-4 Audio (ISO/IEC 14496-3)
      u8(0x15), // streamType/upstream/reserved
      Uint8Array.of(0, 0, 0), // bufferSizeDB
      u32(0), // maxBitrate
      u32(0), // avgBitrate
      decSpecInfo,
    ]);
    const decConfig = descriptor(0x04, decConfigContent);
    const slConfig = descriptor(0x06, Uint8Array.of(0x02));
    const esContent = concatBytes([u16(1) /* ES_ID */, u8(0x00) /* flags */, decConfig, slConfig]);
    const esDescriptor = descriptor(0x03, esContent);
    const esds = box('esds', [fullBoxHeader(0), esDescriptor]);

    const mp4a = box('mp4a', [
      new Uint8Array(8), // reserved
      u16(2), // channelcount
      u16(16), // samplesize
      u16(0), // pre_defined
      u16(0), // reserved
      u32((44100 << 16) >>> 0), // samplerate, 16.16 fixed point
      esds,
    ]);
    const stsd = box('stsd', [fullBoxHeader(0), u32(1), mp4a]);
    const view = viewOf(stsd);
    const header = readBoxHeaderInView(view, 0, stsd.byteLength);

    const result = parseStsd(view, header, 'audio');
    expect(result.codec).toBe('mp4a.40.2');
    expect(result.channelCount).toBe(2);
    expect(result.sampleRate).toBe(44100);
    expect(result.entryCount).toBe(1);
  });
});

describe('parseStsd (multiple sample entries)', () => {
  it('reports entryCount > 1 while still returning the first entry codec', () => {
    const avcC = box('avcC', concatBytes([u8(1), u8(0x64), u8(0x00), u8(0x1f), new Uint8Array(2)]));
    const avc1 = box('avc1', [new Uint8Array(78), avcC]);
    const stsd = box('stsd', [fullBoxHeader(0), u32(2), avc1, avc1]);
    const view = viewOf(stsd);
    const header = readBoxHeaderInView(view, 0, stsd.byteLength);

    const result = parseStsd(view, header, 'video');
    expect(result.entryCount).toBe(2);
    expect(result.codec).toBe('avc1.64001f');
  });
});
