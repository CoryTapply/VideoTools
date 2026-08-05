import { describe, expect, it } from 'vitest';
import { findChild, iterateBoxes, readBoxHeaderInView } from './box-cursor';
import { MalformedBoxError } from './errors';
import { box, concatBytes, largesizeBox, u32 } from './test-helpers/build-box';

function toView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe('iterateBoxes / findChild', () => {
  it('walks sibling boxes and finds a child by type', () => {
    const bytes = concatBytes([box('free', new Uint8Array(4)), box('moov', new Uint8Array(2))]);
    const view = toView(bytes);
    const headers = Array.from(iterateBoxes(view, 0, bytes.byteLength));
    expect(headers.map((h) => h.type)).toEqual(['free', 'moov']);

    const moov = findChild(view, 0, bytes.byteLength, 'moov');
    expect(moov?.offset).toBe(headers[0].boxSize);
  });

  it('handles a 64-bit largesize box', () => {
    const bytes = largesizeBox('mdat', new Uint8Array(10));
    const view = toView(bytes);
    const header = readBoxHeaderInView(view, 0, bytes.byteLength);
    expect(header.headerSize).toBe(16);
    expect(header.boxSize).toBe(26);
    expect(header.type).toBe('mdat');
  });

  it('treats size==0 as "extends to container end"', () => {
    const bytes = concatBytes([u32(0), Uint8Array.from('mdat', (c) => c.charCodeAt(0)), new Uint8Array(20)]);
    const view = toView(bytes);
    const header = readBoxHeaderInView(view, 0, bytes.byteLength);
    expect(header.boxSize).toBe(bytes.byteLength);
  });

  it('throws MalformedBoxError when a box size is smaller than its own header', () => {
    const bytes = concatBytes([u32(4), Uint8Array.from('free', (c) => c.charCodeAt(0))]);
    const view = toView(bytes);
    expect(() => Array.from(iterateBoxes(view, 0, bytes.byteLength))).toThrow(MalformedBoxError);
  });

  it('throws MalformedBoxError when a box claims to extend past its container', () => {
    const bytes = concatBytes([u32(1000), Uint8Array.from('free', (c) => c.charCodeAt(0))]);
    const view = toView(bytes);
    expect(() => Array.from(iterateBoxes(view, 0, bytes.byteLength))).toThrow(MalformedBoxError);
  });
});
