import type { BoxHeader } from '../../box-cursor';

export interface StscEntry {
  readonly firstChunk: number;
  readonly samplesPerChunk: number;
}

/** stsc: sample-to-chunk, run-length encoded by chunk range. `sample_description_index` (the third field per entry) is intentionally not read here -- see stsd.ts's doc comment on multiple sample entries. */
export function parseStsc(view: DataView, box: BoxHeader): StscEntry[] {
  const contentStart = box.offset + box.headerSize;
  const entryCount = view.getUint32(contentStart + 4);
  const entries: StscEntry[] = [];
  let p = contentStart + 8;
  for (let e = 0; e < entryCount; e += 1, p += 12) {
    entries.push({ firstChunk: view.getUint32(p), samplesPerChunk: view.getUint32(p + 4) });
  }
  return entries;
}

/** Expands stsc's chunk ranges against the chunk offset table, accumulating per-sample size within each chunk, to get each sample's absolute byte offset. The last run implicitly extends through the final chunk in the offset table. */
export function computeSampleOffsets(chunkOffsets: Float64Array, stsc: StscEntry[], sizes: Uint32Array): Float64Array {
  const offsets = new Float64Array(sizes.length);
  let sampleIdx = 0;
  for (let entryIdx = 0; entryIdx < stsc.length; entryIdx += 1) {
    const { firstChunk, samplesPerChunk } = stsc[entryIdx];
    const nextEntry = stsc.at(entryIdx + 1);
    const lastChunk = nextEntry ? nextEntry.firstChunk - 1 : chunkOffsets.length;
    for (let chunk = firstChunk; chunk <= lastChunk; chunk += 1) {
      // A malformed stsc/stco pair could disagree on chunk count; fall back to 0 rather than
      // let an out-of-range read silently propagate NaN through every following offset.
      let pos = chunkOffsets.at(chunk - 1) ?? 0; // chunk numbers are 1-based
      for (let s = 0; s < samplesPerChunk && sampleIdx < sizes.length; s += 1, sampleIdx += 1) {
        offsets[sampleIdx] = pos;
        pos += sizes[sampleIdx];
      }
    }
  }
  return offsets;
}
