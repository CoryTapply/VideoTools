// Low-level MP4 (ISO BMFF) box reading, shared by the index builder and the
// remux writer. Extends the box-header handling proven out in spike2: any
// box may use the 64-bit "largesize" extension (32-bit size field == 1,
// followed by an 8-byte real size) when it's bigger than ~4.29GB -- true for
// this project's mdat, never (in practice) for moov's children, but handled
// uniformly here rather than assumed away.

export interface BoxHeader {
  type: string;
  /** Absolute offset of the box (start of its size field). */
  offset: number;
  /** 8 for a normal box, 16 for one using the largesize extension. */
  headerSize: number;
  /** Total box size including its header. */
  boxSize: number;
}

export function boxTypeAt(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset + 4),
    view.getUint8(offset + 5),
    view.getUint8(offset + 6),
    view.getUint8(offset + 7),
  );
}

/** Reads a box header already sitting in a buffered view (moov's contents, or any nested table). */
export function readBoxHeaderInView(view: DataView, offset: number, containerEnd: number): BoxHeader {
  const size32 = view.getUint32(offset);
  const type = boxTypeAt(view, offset);
  if (size32 === 1) {
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
    if (header.boxSize < header.headerSize) throw new Error(`corrupt box at ${offset}: size ${header.boxSize} < header ${header.headerSize}`);
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

/**
 * Reads only top-level box headers from disk until a box of `type` is found --
 * never buffers mdat. Same approach as spike2's findMoov, generalized.
 */
export async function findTopLevelBox(file: File, type: string): Promise<BoxHeader> {
  let offset = 0;
  while (offset + 8 <= file.size) {
    const head = new DataView(await file.slice(offset, offset + 8).arrayBuffer());
    const size32 = head.getUint32(0);
    const boxType = boxTypeAt(head, 0);
    let boxSize: number;
    let headerSize = 8;
    if (size32 === 1) {
      const largeView = new DataView(await file.slice(offset + 8, offset + 16).arrayBuffer());
      boxSize = Number(largeView.getBigUint64(0));
      headerSize = 16;
    } else {
      boxSize = size32 === 0 ? file.size - offset : size32;
    }
    if (boxType === type) return { type: boxType, offset, headerSize, boxSize };
    if (boxSize <= 0) throw new Error(`corrupt top-level box at ${offset}: size ${boxSize}`);
    offset += boxSize;
  }
  throw new Error(`no top-level '${type}' box found`);
}

/** version(1) + flags(3) header shared by every "full box" (stts, ctts, stsz, stsc, stco, stss, mvhd, tkhd, mdhd, hdlr, elst...). */
export function readFullBoxVersion(view: DataView, contentStart: number): { version: number; flags: number } {
  const versionAndFlags = view.getUint32(contentStart);
  return { version: versionAndFlags >>> 24, flags: versionAndFlags & 0x00ffffff };
}
