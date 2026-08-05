import type { BoxHeader } from '../../box-cursor';
import { expandRunLength } from './run-length';

/** stts: decode-time-to-sample. Run-length encoded; doesn't store total sample count directly, so it's derived as the sum of every run's count. */
export function parseStts(view: DataView, box: BoxHeader): { durations: Float64Array; sampleCount: number } {
  const contentStart = box.offset + box.headerSize;
  const entryCount = view.getUint32(contentStart + 4);
  let total = 0;
  let p = contentStart + 8;
  for (let e = 0; e < entryCount; e += 1) {
    total += view.getUint32(p);
    p += 8;
  }
  const durations = expandRunLength(view, contentStart + 8, entryCount, total, false);
  return { durations, sampleCount: total };
}
