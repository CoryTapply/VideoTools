import { describe, expect, it } from 'vitest';
import { BufferByteSource } from './sources/buffer-byte-source';
import { scanTopLevel } from './top-level-scan';
import { box, concatBytes, largesizeBox } from './test-helpers/build-box';

describe('scanTopLevel', () => {
  it('finds moov after leading ftyp/free boxes', async () => {
    const bytes = concatBytes([box('ftyp', new Uint8Array(8)), box('free', new Uint8Array(4)), box('moov', new Uint8Array(6)), box('mdat', new Uint8Array(2))]);
    const result = await scanTopLevel(new BufferByteSource(bytes));
    expect(result.kind).toBe('found');
    if (result.kind === 'found') {
      expect(result.moov.type).toBe('moov');
      expect(result.moov.boxSize).toBe(14);
    }
  });

  it('handles a largesize mdat before moov', async () => {
    const bytes = concatBytes([box('ftyp', new Uint8Array(8)), largesizeBox('mdat', new Uint8Array(1000)), box('moov', new Uint8Array(4))]);
    const result = await scanTopLevel(new BufferByteSource(bytes));
    expect(result.kind).toBe('found');
  });

  it('returns fragmented-mp4 when a top-level moof appears before moov', async () => {
    const bytes = concatBytes([box('ftyp', new Uint8Array(8)), box('moof', new Uint8Array(4))]);
    const result = await scanTopLevel(new BufferByteSource(bytes));
    expect(result.kind).toBe('fragmented-mp4');
  });

  it('returns no-moov when the file runs out without one', async () => {
    const bytes = concatBytes([box('ftyp', new Uint8Array(8)), box('free', new Uint8Array(4))]);
    const result = await scanTopLevel(new BufferByteSource(bytes));
    expect(result.kind).toBe('no-moov');
  });

  it('returns not-isobmff for garbage at offset 0', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const result = await scanTopLevel(new BufferByteSource(bytes));
    expect(result.kind).toBe('not-isobmff');
  });

  it('returns not-isobmff for a file smaller than one box header', async () => {
    const result = await scanTopLevel(new BufferByteSource(new Uint8Array(4)));
    expect(result.kind).toBe('not-isobmff');
  });
});
