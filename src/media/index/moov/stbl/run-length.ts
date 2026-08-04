/** Shared by stts and ctts: both are run-length-encoded (count, value) pairs expanded to one entry per sample. */
export function expandRunLength(view: DataView, entriesStart: number, entryCount: number, sampleCount: number, signed: boolean): Float64Array {
  const out = new Float64Array(sampleCount);
  let i = 0;
  let p = entriesStart;
  for (let e = 0; e < entryCount && i < sampleCount; e += 1) {
    const count = view.getUint32(p);
    const value = signed ? view.getInt32(p + 4) : view.getUint32(p + 4);
    p += 8;
    for (let k = 0; k < count && i < sampleCount; k += 1, i += 1) out[i] = value;
  }
  return out;
}
