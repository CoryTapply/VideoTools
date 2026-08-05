import { describe, expect, it } from 'vitest';
import { readBoxHeaderInView } from '../../box-cursor';
import { box, fullBoxHeader, u32 } from '../../test-helpers/build-box';
import { computeSampleOffsets, parseStsc } from './stsc';

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe('parseStsc', () => {
  it('parses each (first_chunk, samples_per_chunk) run', () => {
    const bytes = box('stsc', [fullBoxHeader(0), u32(2), u32(1), u32(2), u32(1), u32(3), u32(1), u32(1)]);
    const view = viewOf(bytes);
    const header = readBoxHeaderInView(view, 0, bytes.byteLength);
    expect(parseStsc(view, header)).toEqual([
      { firstChunk: 1, samplesPerChunk: 2 },
      { firstChunk: 3, samplesPerChunk: 1 },
    ]);
  });
});

describe('computeSampleOffsets', () => {
  it('expands runs into per-sample offsets, with the final run extending through the last chunk', () => {
    // Entry 1: chunks 1-2 have 2 samples/chunk. Entry 2 (final): chunks 3+ have 3 samples/chunk,
    // extending through however many chunks the offset table actually has (4, here) -- not just
    // one more chunk.
    const stsc = [
      { firstChunk: 1, samplesPerChunk: 2 },
      { firstChunk: 3, samplesPerChunk: 3 },
    ];
    const chunkOffsets = Float64Array.from([1000, 2000, 3000, 4000]);
    const sizes = Uint32Array.from(new Array<number>(10).fill(100)); // 2+2+3+3 = 10 samples total

    const offsets = computeSampleOffsets(chunkOffsets, stsc, sizes);
    expect(Array.from(offsets)).toEqual([1000, 1100, 2000, 2100, 3000, 3100, 3200, 4000, 4100, 4200]);
  });
});
