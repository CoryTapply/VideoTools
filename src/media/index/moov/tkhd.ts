import { readFullBoxVersion, type BoxHeader } from '../box-cursor';

export interface TkhdInfo {
  readonly trackId: number;
  readonly duration: number;
  /** The 9 raw int32 display-matrix entries (16.16 fixed point for a/b/c/d, 2.30 for u/v/w), left un-decoded here -- see rotationDegreesFromMatrix. */
  readonly matrix: Int32Array;
  readonly displayWidth: number;
  readonly displayHeight: number;
}

function fixed16_16(raw: number): number {
  return raw / 65536;
}

export function parseTkhd(view: DataView, box: BoxHeader): TkhdInfo {
  const contentStart = box.offset + box.headerSize;
  const { version } = readFullBoxVersion(view, contentStart);
  let p = contentStart + 4;
  let trackId: number;
  let duration: number;
  if (version === 1) {
    p += 8 + 8;
    trackId = view.getUint32(p);
    p += 4 + 4;
    duration = Number(view.getBigUint64(p));
    p += 8;
  } else {
    p += 4 + 4;
    trackId = view.getUint32(p);
    p += 4 + 4;
    duration = view.getUint32(p);
    p += 4;
  }
  p += 8 + 2 + 2 + 2 + 2; // reserved(8), layer(2), alternate_group(2), volume(2), reserved(2)
  const matrix = new Int32Array(9);
  for (let i = 0; i < 9; i += 1) matrix[i] = view.getInt32(p + i * 4);
  p += 36;
  const displayWidth = fixed16_16(view.getUint32(p));
  const displayHeight = fixed16_16(view.getUint32(p + 4));
  return { trackId, duration, matrix, displayWidth, displayHeight };
}

/**
 * Decodes the tkhd display matrix into a quarter-turn rotation. Only the four axis-aligned
 * cases (0/90/180/270) are recognized -- an arbitrary rotation or skew matrix is reported as 0,
 * since the export UI only ever applies quarter-turn rotations and a general affine transform
 * is out of scope for this task.
 */
export function rotationDegreesFromMatrix(matrix: Int32Array): 0 | 90 | 180 | 270 {
  const a = Math.round(matrix[0] / 65536);
  const b = Math.round(matrix[1] / 65536);
  const c = Math.round(matrix[3] / 65536);
  const d = Math.round(matrix[4] / 65536);
  if (a === 1 && d === 1 && b === 0 && c === 0) return 0;
  if (a === 0 && d === 0 && b === 1 && c === -1) return 90;
  if (a === -1 && d === -1 && b === 0 && c === 0) return 180;
  if (a === 0 && d === 0 && b === -1 && c === 1) return 270;
  return 0;
}
