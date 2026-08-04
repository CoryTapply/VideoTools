// Ported from src/spikes/A-remux/mp4-boxes.ts's findTopLevelBox, generalized: reads only top-
// level box headers through the ByteSource seam (8, or 16 for largesize, bytes at a time) --
// never buffers mdat -- and stops early with a specific result the moment it can tell the file
// isn't a plain ISOBMFF file with a moov: garbage at offset 0, a top-level moof (fragmented MP4),
// or running off the end of the file without ever finding moov.

import type { ByteSource } from './byte-source';
import { boxTypeAt, type BoxHeader } from './box-cursor';

export type TopLevelScanResult =
  | { kind: 'found'; moov: BoxHeader }
  | { kind: 'not-isobmff' }
  | { kind: 'no-moov' }
  | { kind: 'fragmented-mp4' };

function isPlausibleBoxType(type: string): boolean {
  return /^[\x20-\x7e]{4}$/.test(type);
}

export async function scanTopLevel(source: ByteSource): Promise<TopLevelScanResult> {
  if (source.size < 8) return { kind: 'not-isobmff' };

  let offset = 0;
  while (offset + 8 <= source.size) {
    const head = await source.read(offset, 8);
    if (head.byteLength < 8) break; // short read: file is smaller than its own declared size

    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const size32 = view.getUint32(0);
    const type = boxTypeAt(view, 0);

    if (offset === 0 && !isPlausibleBoxType(type)) return { kind: 'not-isobmff' };

    let boxSize: number;
    let headerSize = 8;
    if (size32 === 1) {
      const largeHead = await source.read(offset + 8, 8);
      if (largeHead.byteLength < 8) break;
      const largeView = new DataView(largeHead.buffer, largeHead.byteOffset, largeHead.byteLength);
      boxSize = Number(largeView.getBigUint64(0));
      headerSize = 16;
    } else {
      boxSize = size32 === 0 ? source.size - offset : size32;
    }

    if (boxSize < headerSize) return offset === 0 ? { kind: 'not-isobmff' } : { kind: 'no-moov' };

    if (type === 'moof') return { kind: 'fragmented-mp4' };
    if (type === 'moov') return { kind: 'found', moov: { type, offset, headerSize, boxSize } };

    offset += boxSize;
  }

  return { kind: 'no-moov' };
}
