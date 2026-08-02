import { mountSpikeHarness } from './harness';

const CONTAINER_TYPES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

interface BoxInfo {
  type: string;
  offset: number;
  size: number;
}

function boxTypeAt(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset + 4),
    view.getUint8(offset + 5),
    view.getUint8(offset + 6),
    view.getUint8(offset + 7),
  );
}

/** Recursively walks boxes within an already-buffered ArrayBuffer (used for moov's contents). */
function walkBoxes(view: DataView, start: number, end: number): BoxInfo[] {
  const boxes: BoxInfo[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size = view.getUint32(offset);
    const type = boxTypeAt(view, offset);
    const boxSize = size === 0 ? end - offset : size;
    boxes.push({ type, offset, size: boxSize });
    if (CONTAINER_TYPES.has(type)) boxes.push(...walkBoxes(view, offset + 8, offset + boxSize));
    offset += boxSize;
  }
  return boxes;
}

/** Reads only top-level box headers from disk (8 bytes at a time) until moov is found -- never touches mdat. */
async function findMoov(file: File): Promise<BoxInfo> {
  let offset = 0;
  while (offset + 8 <= file.size) {
    const view = new DataView(await file.slice(offset, offset + 8).arrayBuffer());
    const size = view.getUint32(0);
    const type = boxTypeAt(view, 0);
    const boxSize = size === 0 ? file.size - offset : size;
    if (type === 'moov') return { type, offset, size: boxSize };
    offset += boxSize;
  }
  throw new Error('no moov box found');
}

mountSpikeHarness(
  document.getElementById('app')!,
  'spike2-mp4-parse',
  "Locate moov by reading only top-level box headers (never touching mdat), then fully buffer moov to build a keyframe (stss) index. Compares faststart (moov near front) vs moov-at-end layouts, and stresses parsing a genuinely large moov atom.",
  async (file, log) => {
    const moov = await findMoov(file);
    log(`moov at byte ${moov.offset} (${((moov.offset / file.size) * 100).toFixed(1)}% into file), size ${moov.size} bytes`);

    const moovBuf = await file.slice(moov.offset, moov.offset + moov.size).arrayBuffer();
    const view = new DataView(moovBuf);
    const boxes = walkBoxes(view, 8, moovBuf.byteLength); // skip moov's own 8-byte header

    let keyframeCount = 0;
    for (const box of boxes) {
      if (box.type === 'stss') keyframeCount += view.getUint32(box.offset + 12); // entry_count field
    }

    return {
      metrics: {
        moovOffsetBytes: moov.offset,
        moovSizeBytes: moov.size,
        moovOffsetPct: (moov.offset / file.size) * 100,
        boxCount: boxes.length,
        keyframeCount,
      },
      notes: keyframeCount === 0 ? 'no stss box found -- check container/track structure' : undefined,
    };
  },
);
