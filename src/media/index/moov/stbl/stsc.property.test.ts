// Property test (task spec §8): computeSampleOffsets's run-boundary arithmetic vs a brute-force
// reference that expands stsc into one explicit samplesPerChunk value per physical chunk first,
// then walks chunks in strict order. The two implementations share no code, so agreement across
// many random run structures is real evidence the run-boundary math (in particular "the final
// run extends through the last chunk in the offset table") is correct.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeSampleOffsets, type StscEntry } from './stsc';

function referenceOffsets(chunkOffsets: Float64Array, stsc: StscEntry[], sizes: Uint32Array): Float64Array {
  const perChunkSamples = new Array<number>(chunkOffsets.length).fill(0);
  for (let entryIdx = 0; entryIdx < stsc.length; entryIdx += 1) {
    const entry = stsc[entryIdx];
    const nextFirstChunk = stsc.at(entryIdx + 1)?.firstChunk ?? chunkOffsets.length + 1;
    for (let chunk = entry.firstChunk; chunk < nextFirstChunk && chunk <= chunkOffsets.length; chunk += 1) {
      perChunkSamples[chunk - 1] = entry.samplesPerChunk;
    }
  }

  const offsets = new Float64Array(sizes.length);
  let sampleIdx = 0;
  for (let chunk = 1; chunk <= chunkOffsets.length && sampleIdx < sizes.length; chunk += 1) {
    let pos = chunkOffsets[chunk - 1];
    const count = perChunkSamples[chunk - 1];
    for (let s = 0; s < count && sampleIdx < sizes.length; s += 1, sampleIdx += 1) {
      offsets[sampleIdx] = pos;
      pos += sizes[sampleIdx];
    }
  }
  return offsets;
}

function totalSamplesFor(stsc: StscEntry[], numChunks: number): number {
  let total = 0;
  for (let entryIdx = 0; entryIdx < stsc.length; entryIdx += 1) {
    const entry = stsc[entryIdx];
    const nextFirstChunk = stsc.at(entryIdx + 1)?.firstChunk ?? numChunks + 1;
    const chunkCount = Math.max(0, Math.min(nextFirstChunk, numChunks + 1) - entry.firstChunk);
    total += chunkCount * entry.samplesPerChunk;
  }
  return total;
}

const arbitraryStscStructure = fc.integer({ min: 1, max: 12 }).chain((numChunks) =>
  fc
    .uniqueArray(fc.integer({ min: 1, max: numChunks }), { minLength: 1, maxLength: numChunks })
    .map((breakpoints) => breakpoints.sort((a, b) => a - b))
    .map((breakpoints) => (breakpoints[0] === 1 ? breakpoints : [1, ...breakpoints.filter((b) => b !== 1)]))
    .map((firstChunks) => ({
      numChunks,
      stsc: firstChunks.map((firstChunk): StscEntry => ({ firstChunk, samplesPerChunk: 1 + (firstChunk % 5) })),
    })),
);

describe('computeSampleOffsets -- property test vs brute-force reference', () => {
  it('agrees with a naive per-chunk expansion across arbitrary run structures', () => {
    fc.assert(
      fc.property(arbitraryStscStructure, ({ numChunks, stsc }) => {
        const totalSamples = totalSamplesFor(stsc, numChunks);
        const chunkOffsets = Float64Array.from({ length: numChunks }, (_, i) => (i + 1) * 10_000);
        const sizes = Uint32Array.from({ length: totalSamples }, (_, i) => 100 + (i % 7));

        const ours = computeSampleOffsets(chunkOffsets, stsc, sizes);
        const reference = referenceOffsets(chunkOffsets, stsc, sizes);
        expect(Array.from(ours)).toEqual(Array.from(reference));
      }),
    );
  });
});
