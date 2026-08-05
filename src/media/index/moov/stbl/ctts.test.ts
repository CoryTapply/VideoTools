import { describe, expect, it } from 'vitest';
import { readBoxHeaderInView } from '../../box-cursor';
import { box, fullBoxHeader, i32, u32 } from '../../test-helpers/build-box';
import { parseCtts } from './ctts';

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe('parseCtts', () => {
  it('expands version 0 (unsigned) offsets', () => {
    const bytes = box('ctts', [fullBoxHeader(0), u32(2), u32(2), u32(100), u32(1), u32(50)]);
    const view = viewOf(bytes);
    const header = readBoxHeaderInView(view, 0, bytes.byteLength);
    const { offsets, version } = parseCtts(view, header, 3);
    expect(version).toBe(0);
    expect(Array.from(offsets)).toEqual([100, 100, 50]);
  });

  it('expands version 1 (signed) offsets, including negative values (B-frame reordering)', () => {
    const bytes = box('ctts', [fullBoxHeader(1), u32(2), u32(1), i32(-50), u32(2), i32(30)]);
    const view = viewOf(bytes);
    const header = readBoxHeaderInView(view, 0, bytes.byteLength);
    const { offsets, version } = parseCtts(view, header, 3);
    expect(version).toBe(1);
    expect(Array.from(offsets)).toEqual([-50, 30, 30]);
  });
});
