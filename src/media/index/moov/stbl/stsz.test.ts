import { describe, expect, it } from 'vitest';
import { readBoxHeaderInView } from '../../box-cursor';
import { MalformedBoxError } from '../../errors';
import { box, fullBoxHeader, u32, u8 } from '../../test-helpers/build-box';
import { parseStsz, parseStz2 } from './stsz';

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe('parseStsz', () => {
  it('fills a uniform size for every sample when sample_size != 0', () => {
    const bytes = box('stsz', [fullBoxHeader(0), u32(512), u32(4)]);
    const view = viewOf(bytes);
    const header = readBoxHeaderInView(view, 0, bytes.byteLength);
    expect(Array.from(parseStsz(view, header))).toEqual([512, 512, 512, 512]);
  });

  it('reads a per-sample table when sample_size == 0', () => {
    const bytes = box('stsz', [fullBoxHeader(0), u32(0), u32(3), u32(10), u32(20), u32(30)]);
    const view = viewOf(bytes);
    const header = readBoxHeaderInView(view, 0, bytes.byteLength);
    expect(Array.from(parseStsz(view, header))).toEqual([10, 20, 30]);
  });
});

describe('parseStz2', () => {
  function stz2Box(fieldSize: number, data: Uint8Array, sampleCount: number): Uint8Array {
    return box('stz2', [fullBoxHeader(0), u8(0), u8(0), u8(0), u8(fieldSize), u32(sampleCount), data]);
  }

  it('reads 16-bit compact sizes', () => {
    const bytes = stz2Box(16, Uint8Array.of(0, 100, 1, 44), 2); // [100, 300]
    const view = viewOf(bytes);
    const header = readBoxHeaderInView(view, 0, bytes.byteLength);
    expect(Array.from(parseStz2(view, header))).toEqual([100, 300]);
  });

  it('reads 8-bit compact sizes', () => {
    const bytes = stz2Box(8, Uint8Array.of(5, 10, 200), 3);
    const view = viewOf(bytes);
    const header = readBoxHeaderInView(view, 0, bytes.byteLength);
    expect(Array.from(parseStz2(view, header))).toEqual([5, 10, 200]);
  });

  it('reads 4-bit (nibble-packed) compact sizes', () => {
    const bytes = stz2Box(4, Uint8Array.of(0x12, 0x34), 4); // samples: 1, 2, 3, 4
    const view = viewOf(bytes);
    const header = readBoxHeaderInView(view, 0, bytes.byteLength);
    expect(Array.from(parseStz2(view, header))).toEqual([1, 2, 3, 4]);
  });

  it('throws MalformedBoxError for an unsupported field_size', () => {
    const bytes = stz2Box(2, Uint8Array.of(0), 1);
    const view = viewOf(bytes);
    const header = readBoxHeaderInView(view, 0, bytes.byteLength);
    expect(() => parseStz2(view, header)).toThrow(MalformedBoxError);
  });
});
