// Spike C -- extracts a WebCodecs VideoDecoderConfig from an H.264 (avc1/avc3) track's stsd box.
// VideoDecoder.configure() requires a codec string derived from the AVCDecoderConfigurationRecord
// (avcC) and, for the common length-prefixed ("avc1"-in-MP4", not Annex-B) case, that same
// record's raw bytes as `description`. See prompts/m0.5-spike-prompts.md Step 1.

import type { TrackIndex } from '../A-remux/mp4-index';

export interface DecoderConfigInfo {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description: Uint8Array;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/**
 * rawStsd layout (VisualSampleEntry, e.g. avc1, per ISO 14496-12/14496-15):
 *   stsd full-box header: size(4)+type(4)+version/flags(4)+entry_count(4) = 16 bytes
 *   sample entry: size(4)+type(4)+reserved(6)+data_reference_index(2)+pre_defined(2)+
 *     reserved(2)+pre_defined(12)+width(2)+height(2)+horizresolution(4)+vertresolution(4)+
 *     reserved(4)+frame_count(2)+compressorname(32)+depth(2)+pre_defined(2) = 86 bytes,
 *     followed by child boxes (avcC, ...)
 */
export function extractAvcDecoderConfig(track: TrackIndex): DecoderConfigInfo {
  const buf = track.rawStsd;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const entryStart = 16;
  const entrySize = view.getUint32(entryStart);
  const entryType = String.fromCharCode(
    view.getUint8(entryStart + 4),
    view.getUint8(entryStart + 5),
    view.getUint8(entryStart + 6),
    view.getUint8(entryStart + 7),
  );
  if (entryType !== 'avc1' && entryType !== 'avc3') {
    throw new Error(`unsupported sample entry type '${entryType}' -- only avc1/avc3 (H.264) is handled`);
  }

  const codedWidth = view.getUint16(entryStart + 32);
  const codedHeight = view.getUint16(entryStart + 34);

  const entryEnd = entryStart + entrySize;
  let childOffset = entryStart + 86;
  let avcCBox: { offset: number; size: number } | undefined;
  while (childOffset + 8 <= entryEnd) {
    const size = view.getUint32(childOffset);
    const type = String.fromCharCode(
      view.getUint8(childOffset + 4),
      view.getUint8(childOffset + 5),
      view.getUint8(childOffset + 6),
      view.getUint8(childOffset + 7),
    );
    if (type === 'avcC') {
      avcCBox = { offset: childOffset, size };
      break;
    }
    childOffset += size;
  }
  if (!avcCBox) throw new Error('no avcC box found in stsd -- not an H.264 avc1/avc3 track');

  const avcCContentStart = avcCBox.offset + 8;
  const profileIdc = view.getUint8(avcCContentStart + 1);
  const profileCompat = view.getUint8(avcCContentStart + 2);
  const levelIdc = view.getUint8(avcCContentStart + 3);
  const codec = `avc1.${hex2(profileIdc)}${hex2(profileCompat)}${hex2(levelIdc)}`;

  const description = buf.slice(avcCContentStart, avcCBox.offset + avcCBox.size);

  return { codec, codedWidth, codedHeight, description };
}
