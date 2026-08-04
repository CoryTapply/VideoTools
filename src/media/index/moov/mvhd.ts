import { readFullBoxVersion, type BoxHeader } from '../box-cursor';

export interface MvhdInfo {
  readonly timescale: number;
  readonly duration: number;
}

export function parseMvhd(view: DataView, box: BoxHeader): MvhdInfo {
  const contentStart = box.offset + box.headerSize;
  const { version } = readFullBoxVersion(view, contentStart);
  if (version === 1) {
    return {
      timescale: view.getUint32(contentStart + 4 + 8 + 8),
      duration: Number(view.getBigUint64(contentStart + 4 + 8 + 8 + 4)),
    };
  }
  return {
    timescale: view.getUint32(contentStart + 4 + 4 + 4),
    duration: view.getUint32(contentStart + 4 + 4 + 4 + 4),
  };
}
