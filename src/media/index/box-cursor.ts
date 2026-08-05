// Ported from src/spikes/A-remux/mp4-boxes.ts's *InView functions, generalized with bounds
// checks: every read that would run past its container throws MalformedBoxError instead of
// letting a DataView RangeError escape as an opaque, un-actionable crash.

import { MalformedBoxError } from './errors';

export interface BoxHeader {
  readonly type: string;
  /** Absolute offset of the box (start of its size field), relative to the buffer's own start. */
  readonly offset: number;
  /** 8 for a normal box, 16 for one using the largesize extension. */
  readonly headerSize: number;
  /** Total box size including its header. */
  readonly boxSize: number;
}

export function boxTypeAt(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7));
}

/** Reads a box header sitting in a buffered view (moov's contents, or any nested table). */
export function readBoxHeaderInView(view: DataView, offset: number, containerEnd: number): BoxHeader {
  if (offset + 8 > containerEnd) {
    throw new MalformedBoxError('(unknown)', offset, `box header would extend past container end ${String(containerEnd)}`);
  }
  const size32 = view.getUint32(offset);
  const type = boxTypeAt(view, offset);
  if (size32 === 1) {
    if (offset + 16 > containerEnd) {
      throw new MalformedBoxError(type, offset, 'largesize extension would extend past container end');
    }
    return { type, offset, headerSize: 16, boxSize: Number(view.getBigUint64(offset + 8)) };
  }
  const boxSize = size32 === 0 ? containerEnd - offset : size32;
  return { type, offset, headerSize: 8, boxSize };
}

/** Iterates the immediate children of a box already sitting in a buffered view. */
export function* iterateBoxes(view: DataView, start: number, end: number): Generator<BoxHeader> {
  let offset = start;
  while (offset + 8 <= end) {
    const header = readBoxHeaderInView(view, offset, end);
    if (header.boxSize < header.headerSize) {
      throw new MalformedBoxError(header.type, offset, `box size ${String(header.boxSize)} is smaller than its own header (${String(header.headerSize)})`);
    }
    if (offset + header.boxSize > end) {
      throw new MalformedBoxError(header.type, offset, `box extends past its container's end ${String(end)}`);
    }
    yield header;
    offset += header.boxSize;
  }
}

/** Finds the first immediate child of the given type, or undefined. */
export function findChild(view: DataView, start: number, end: number, type: string): BoxHeader | undefined {
  for (const box of iterateBoxes(view, start, end)) {
    if (box.type === type) return box;
  }
  return undefined;
}

/** Like findChild, but throws MalformedBoxError (caught at the buildIndex() boundary) if absent -- for children the ISOBMFF spec requires. */
export function requireChild(view: DataView, start: number, end: number, type: string, parentDescription: string): BoxHeader {
  const box = findChild(view, start, end, type);
  if (!box) throw new MalformedBoxError(type, start, `${parentDescription} is missing its required '${type}' child box`);
  return box;
}

/** version(1) + flags(3) header shared by every "full box" (stts, ctts, stsz, stsc, stco, stss, mvhd, tkhd, mdhd, hdlr, elst, esds...). */
export function readFullBoxVersion(view: DataView, contentStart: number): { version: number; flags: number } {
  const versionAndFlags = view.getUint32(contentStart);
  return { version: versionAndFlags >>> 24, flags: versionAndFlags & 0x00ffffff };
}

/** Raw bytes of a box (including its header), copied out of the shared moov buffer. */
export function rawBoxBytes(view: DataView, box: { offset: number; boxSize: number }): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset + box.offset, box.boxSize).slice();
}
