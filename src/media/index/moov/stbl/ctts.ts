import { readFullBoxVersion, type BoxHeader } from '../../box-cursor';
import { expandRunLength } from './run-length';

/** ctts: composition-time-to-sample (dts -> cts offset). Version 0 offsets are unsigned; version 1 (added to allow B-frames with a negative offset relative to the first sample) are signed. */
export function parseCtts(view: DataView, box: BoxHeader, sampleCount: number): { offsets: Float64Array; version: number } {
  const contentStart = box.offset + box.headerSize;
  const { version } = readFullBoxVersion(view, contentStart);
  const entryCount = view.getUint32(contentStart + 4);
  const offsets = expandRunLength(view, contentStart + 8, entryCount, sampleCount, version === 1);
  return { offsets, version };
}
