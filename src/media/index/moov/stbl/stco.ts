import type { BoxHeader } from '../../box-cursor';

/** stco (32-bit) or co64 (64-bit) chunk offset table. */
export function parseChunkOffsets(view: DataView, box: BoxHeader): Float64Array {
  const contentStart = box.offset + box.headerSize;
  const entryCount = view.getUint32(contentStart + 4);
  const offsets = new Float64Array(entryCount);
  let p = contentStart + 8;
  if (box.type === 'co64') {
    for (let i = 0; i < entryCount; i += 1, p += 8) offsets[i] = Number(view.getBigUint64(p));
  } else {
    for (let i = 0; i < entryCount; i += 1, p += 4) offsets[i] = view.getUint32(p);
  }
  return offsets;
}
