import type { BoxHeader } from '../box-cursor';

export interface HdlrInfo {
  /** 'vide', 'soun', 'tmcd', ... */
  readonly handlerType: string;
  /** Human-readable name, e.g. distinguishing a mic track from desktop audio in a multi-track OBS recording. '' if absent/unset. */
  readonly name: string;
}

export function parseHdlr(view: DataView, box: BoxHeader): HdlrInfo {
  const contentStart = box.offset + box.headerSize;
  const handlerType = String.fromCharCode(
    view.getUint8(contentStart + 8),
    view.getUint8(contentStart + 9),
    view.getUint8(contentStart + 10),
    view.getUint8(contentStart + 11),
  );
  const nameStart = contentStart + 8 + 4 + 12; // version+flags(4) + pre_defined(4) + handler_type(4) + reserved(12)
  const boxEnd = box.offset + box.boxSize;
  const bytes: number[] = [];
  for (let p = nameStart; p < boxEnd; p += 1) {
    const b = view.getUint8(p);
    if (b === 0) break;
    bytes.push(b);
  }
  const name = new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
  return { handlerType, name };
}
