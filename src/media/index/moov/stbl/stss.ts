import type { BoxHeader } from '../../box-cursor';

/** stss: sync (key) sample table. Absent entirely means every sample is a sync sample (audio, or intra-only video). Entries are 1-based sample numbers per the ISOBMFF spec. */
export function parseStss(view: DataView, box: BoxHeader | undefined, sampleCount: number): Uint8Array {
  const sync = new Uint8Array(sampleCount);
  if (!box) {
    sync.fill(1);
    return sync;
  }
  const contentStart = box.offset + box.headerSize;
  const entryCount = view.getUint32(contentStart + 4);
  let p = contentStart + 8;
  for (let e = 0; e < entryCount; e += 1, p += 4) {
    const sampleNumber1Based = view.getUint32(p);
    const idx = sampleNumber1Based - 1;
    if (idx >= 0 && idx < sampleCount) sync[idx] = 1;
  }
  return sync;
}
