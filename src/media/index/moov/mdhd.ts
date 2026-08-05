import { readFullBoxVersion, type BoxHeader } from '../box-cursor';

export interface MdhdInfo {
  readonly timescale: number;
  readonly duration: number;
  /** ISO-639-2/T language code (e.g. 'eng'), or '' if unset (all-zero packed field). */
  readonly language: string;
}

function decodeLanguage(packed: number): string {
  const c1 = (packed >> 10) & 0x1f;
  const c2 = (packed >> 5) & 0x1f;
  const c3 = packed & 0x1f;
  if (c1 === 0 && c2 === 0 && c3 === 0) return '';
  return String.fromCharCode(c1 + 0x60, c2 + 0x60, c3 + 0x60);
}

export function parseMdhd(view: DataView, box: BoxHeader): MdhdInfo {
  const contentStart = box.offset + box.headerSize;
  const { version } = readFullBoxVersion(view, contentStart);
  let p = contentStart + 4;
  let timescale: number;
  let duration: number;
  if (version === 1) {
    p += 8 + 8;
    timescale = view.getUint32(p);
    p += 4;
    duration = Number(view.getBigUint64(p));
    p += 8;
  } else {
    p += 4 + 4;
    timescale = view.getUint32(p);
    p += 4;
    duration = view.getUint32(p);
    p += 4;
  }
  const language = decodeLanguage(view.getUint16(p));
  return { timescale, duration, language };
}
