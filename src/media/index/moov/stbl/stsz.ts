import { MalformedBoxError } from '../../errors';
import type { BoxHeader } from '../../box-cursor';

/** stsz: sample sizes, either one uniform size for every sample, or a per-sample table. */
export function parseStsz(view: DataView, box: BoxHeader): Uint32Array {
  const contentStart = box.offset + box.headerSize;
  const sampleSize = view.getUint32(contentStart + 4);
  const sampleCount = view.getUint32(contentStart + 8);
  const sizes = new Uint32Array(sampleCount);
  if (sampleSize !== 0) {
    sizes.fill(sampleSize);
    return sizes;
  }
  let p = contentStart + 12;
  for (let i = 0; i < sampleCount; i += 1, p += 4) sizes[i] = view.getUint32(p);
  return sizes;
}

/** stz2: compact variant of stsz, with a 4/8/16-bit field size instead of always 32-bit. */
export function parseStz2(view: DataView, box: BoxHeader): Uint32Array {
  const contentStart = box.offset + box.headerSize;
  const fieldSize = view.getUint8(contentStart + 7); // reserved(3 bytes) + field_size(1 byte) packed into bytes 4-7
  const sampleCount = view.getUint32(contentStart + 8);
  const sizes = new Uint32Array(sampleCount);
  const dataStart = contentStart + 12;
  if (fieldSize === 16) {
    for (let i = 0; i < sampleCount; i += 1) sizes[i] = view.getUint16(dataStart + i * 2);
  } else if (fieldSize === 8) {
    for (let i = 0; i < sampleCount; i += 1) sizes[i] = view.getUint8(dataStart + i);
  } else if (fieldSize === 4) {
    for (let i = 0; i < sampleCount; i += 1) {
      const byte = view.getUint8(dataStart + (i >> 1));
      sizes[i] = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
    }
  } else {
    throw new MalformedBoxError('stz2', box.offset, `unsupported field_size ${String(fieldSize)} (expected 4, 8, or 16)`);
  }
  return sizes;
}
