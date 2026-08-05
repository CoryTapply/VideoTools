import { describe, expect, it } from 'vitest';
import { readBoxHeaderInView } from '../../box-cursor';
import { box, fullBoxHeader, u32, u64 } from '../../test-helpers/build-box';
import { parseChunkOffsets } from './stco';

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe('parseChunkOffsets', () => {
  it('parses stco (32-bit offsets)', () => {
    const bytes = box('stco', [fullBoxHeader(0), u32(3), u32(100), u32(5000), u32(123456)]);
    const view = viewOf(bytes);
    const header = readBoxHeaderInView(view, 0, bytes.byteLength);
    expect(Array.from(parseChunkOffsets(view, header))).toEqual([100, 5000, 123456]);
  });

  it('parses co64 (64-bit offsets, needed past ~4.29GB)', () => {
    const bigOffset = 5_000_000_000;
    const bytes = box('co64', [fullBoxHeader(0), u32(2), u64(bigOffset), u64(bigOffset + 1000)]);
    const view = viewOf(bytes);
    const header = readBoxHeaderInView(view, 0, bytes.byteLength);
    expect(Array.from(parseChunkOffsets(view, header))).toEqual([bigOffset, bigOffset + 1000]);
  });
});
