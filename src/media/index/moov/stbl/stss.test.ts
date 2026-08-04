import { describe, expect, it } from 'vitest';
import { readBoxHeaderInView } from '../../box-cursor';
import { box, fullBoxHeader, u32 } from '../../test-helpers/build-box';
import { parseStss } from './stss';

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe('parseStss', () => {
  it('marks every sample sync when the box is absent', () => {
    const sync = parseStss(new DataView(new ArrayBuffer(0)), undefined, 5);
    expect(Array.from(sync)).toEqual([1, 1, 1, 1, 1]);
  });

  it('marks only the listed (1-based) sample numbers sync when present', () => {
    const bytes = box('stss', [fullBoxHeader(0), u32(2), u32(1), u32(4)]); // samples #1 and #4
    const view = viewOf(bytes);
    const header = readBoxHeaderInView(view, 0, bytes.byteLength);
    expect(Array.from(parseStss(view, header, 5))).toEqual([1, 0, 0, 1, 0]);
  });

  it('ignores out-of-range sample numbers rather than crashing', () => {
    const bytes = box('stss', [fullBoxHeader(0), u32(1), u32(999)]);
    const view = viewOf(bytes);
    const header = readBoxHeaderInView(view, 0, bytes.byteLength);
    expect(Array.from(parseStss(view, header, 3))).toEqual([0, 0, 0]);
  });
});
