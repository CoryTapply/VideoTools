// stsd's sample entries carry the codec configuration -- the spike never computed an RFC 6381
// codec string (it only copied stsd verbatim for the remux writer, which doesn't need one), so
// this is new parsing, not a port. Scoped to what the project's actual fixtures produce: H.264
// (avc1/avc3 + avcC) and AAC (mp4a + esds) are fully handled; HEVC (hvcC) gets a best-effort
// RFC 6381 string for the common case (general_profile_space == 0) since a fixture may exist
// that needs it, but it hasn't been differential-tested against a real HEVC file.

import { findChild, rawBoxBytes, readBoxHeaderInView, type BoxHeader } from '../../box-cursor';

export interface StsdResult {
  readonly codec: string;
  /** Raw avcC/hvcC/esds bytes (including box header), copied verbatim for a future decoder/remuxer. */
  readonly description: Uint8Array;
  readonly entryCount: number;
  /** The first sample entry's own box type (e.g. 'avc1', 'mp4a', or 'encv'/'enca' for CENC-encrypted content). */
  readonly sampleEntryType: string;
  readonly codedWidth?: number;
  readonly codedHeight?: number;
  readonly channelCount?: number;
  readonly sampleRate?: number;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

function parseAvcCCodecString(view: DataView, avcC: BoxHeader): string {
  const contentStart = avcC.offset + avcC.headerSize;
  const profileIdc = view.getUint8(contentStart + 1);
  const profileCompat = view.getUint8(contentStart + 2);
  const levelIdc = view.getUint8(contentStart + 3);
  return `avc1.${hex2(profileIdc)}${hex2(profileCompat)}${hex2(levelIdc)}`;
}

/** Best-effort RFC 6381 string for the common general_profile_space == 0 case; see module doc. */
function parseHvcCCodecString(view: DataView, hvcC: BoxHeader): string {
  const c = hvcC.offset + hvcC.headerSize;
  const byte1 = view.getUint8(c + 1);
  const profileSpace = byte1 >> 6;
  const tierFlag = (byte1 >> 5) & 0x1;
  const profileIdc = byte1 & 0x1f;
  const profileCompat = view.getUint32(c + 2);

  const constraintBytes: number[] = [];
  for (let i = 0; i < 6; i += 1) constraintBytes.push(view.getUint8(c + 6 + i));
  while (constraintBytes.length > 0 && constraintBytes[constraintBytes.length - 1] === 0) constraintBytes.pop();

  const levelIdc = view.getUint8(c + 12);
  const spaceChar = profileSpace === 0 ? '' : String.fromCharCode(0x41 + profileSpace - 1);
  const tierChar = tierFlag === 0 ? 'L' : 'H';
  const constraintSuffix = constraintBytes.length > 0 ? `.${constraintBytes.map((b) => b.toString(16).toUpperCase()).join('.')}` : '';
  return `hev1.${spaceChar}${String(profileIdc)}.${profileCompat.toString(16).toUpperCase()}.${tierChar}${String(levelIdc)}${constraintSuffix}`;
}

function readDescriptor(view: DataView, pos: number): { tag: number; length: number; dataStart: number; next: number } {
  const tag = view.getUint8(pos);
  let length = 0;
  let p = pos + 1;
  for (let i = 0; i < 4; i += 1) {
    const b = view.getUint8(p);
    p += 1;
    length = (length << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) break;
  }
  return { tag, length, dataStart: p, next: p + length };
}

interface EsdsDecoderConfig {
  readonly objectTypeIndication: number;
  /** -1 if this esds has no DecSpecificInfo descriptor (a valid, if unusual, esds). */
  readonly decSpecDataStart: number;
  readonly decSpecLength: number;
}

/**
 * Walks the MPEG-4 ES_Descriptor -> DecoderConfigDescriptor -> DecSpecificInfo chain starting at
 * `contentStart` (already past the fullbox version+flags), ending at `boxEnd`. Shared by
 * `parseEsdsCodecString` (below, wants just `objectTypeIndication` and the first
 * AudioSpecificConfig byte for the RFC 6381 string) and `extractAudioSpecificConfig` (wants the
 * DecSpecificInfo descriptor's raw byte range, which the codec-string path parses one byte of and
 * discards the rest of) -- one walk, two consumers. Returns undefined if the ES_Descriptor or
 * DecoderConfigDescriptor tags aren't where expected (a malformed or unusual esds).
 */
function walkEsdsDecoderConfig(view: DataView, contentStart: number, boxEnd: number): EsdsDecoderConfig | undefined {
  const es = readDescriptor(view, contentStart);
  if (es.tag !== 0x03) return undefined;

  let p = es.dataStart + 2; // ES_ID
  const flags = view.getUint8(p);
  p += 1;
  if (flags & 0x80) p += 2; // dependsOn_ES_ID
  if (flags & 0x40) p += 1 + view.getUint8(p); // URLlength + URLstring
  if (flags & 0x20) p += 2; // OCR_ES_Id

  if (p >= boxEnd) return undefined;
  const decConfig = readDescriptor(view, p);
  if (decConfig.tag !== 0x04) return undefined;
  const objectTypeIndication = view.getUint8(decConfig.dataStart);

  const decSpecPos = decConfig.dataStart + 1 + 12; // streamType+upStream+reserved(1) + bufferSizeDB(3) + maxBitrate(4) + avgBitrate(4)
  if (decSpecPos >= decConfig.next) return { objectTypeIndication, decSpecDataStart: -1, decSpecLength: 0 };
  const decSpec = readDescriptor(view, decSpecPos);
  if (decSpec.tag !== 0x05 || decSpec.length < 1) return { objectTypeIndication, decSpecDataStart: -1, decSpecLength: 0 };

  return { objectTypeIndication, decSpecDataStart: decSpec.dataStart, decSpecLength: decSpec.length };
}

/** Object type and (for MPEG-4 Audio) the audioObjectType, per RFC 6381's mp4a.OO[.A] convention. */
function parseEsdsCodecString(view: DataView, esds: BoxHeader): string {
  const contentStart = esds.offset + esds.headerSize + 4; // skip fullbox version+flags
  const boxEnd = esds.offset + esds.boxSize;
  const config = walkEsdsDecoderConfig(view, contentStart, boxEnd);
  if (!config) return 'mp4a';
  if (config.decSpecDataStart < 0) return `mp4a.${hex2(config.objectTypeIndication)}`;

  const audioObjectType = view.getUint8(config.decSpecDataStart) >> 3; // top 5 bits of AudioSpecificConfig
  return `mp4a.${hex2(config.objectTypeIndication)}.${String(audioObjectType)}`;
}

/**
 * Extracts the AudioSpecificConfig payload (the DecSpecificInfo descriptor's raw bytes) from a
 * verbatim esds box -- the same bytes stored as `TrackIndex.description` for an audio track, and
 * exactly what `AudioDecoderConfig.description` wants (see M2's waveform module, the first real
 * consumer). `parseEsdsCodecString` above already walks this same descriptor chain for the RFC
 * 6381 codec string but only reads the payload's first byte and discards the rest -- this is that
 * walk applied to a standalone extracted box (no live file view or BoxHeader available once
 * `description` has been copied out on its own), so `esds` is assumed to start at byte 0 of
 * `esdsBoxBytes` with a standard 8-byte box header (4-byte size + 4-byte 'esds' fourcc) -- esds is
 * always a small box, never the 64-bit largesize form. Returns an empty array if the esds doesn't
 * have the expected descriptor shape.
 */
export function extractAudioSpecificConfig(esdsBoxBytes: Uint8Array): Uint8Array {
  const headerSize = 8;
  const contentStart = headerSize + 4; // skip fullbox version+flags
  if (esdsBoxBytes.byteLength <= contentStart) return new Uint8Array(0);
  const view = new DataView(esdsBoxBytes.buffer, esdsBoxBytes.byteOffset, esdsBoxBytes.byteLength);
  // walkEsdsDecoderConfig assumes a well-formed descriptor chain (same as parseEsdsCodecString,
  // which runs against a live, generously-bounded file view where an odd offset just reads
  // unrelated-but-in-bounds bytes) -- here the view is scoped exactly to this one box, so a
  // truncated or malformed esds can walk past its end and throw a RangeError. Caught rather than
  // guarded field-by-field: this function's contract is "best-effort, empty array for anything
  // unusual," matching parseStsd's own style elsewhere in this file.
  try {
    const config = walkEsdsDecoderConfig(view, contentStart, esdsBoxBytes.byteLength);
    if (!config || config.decSpecDataStart < 0) return new Uint8Array(0);
    return esdsBoxBytes.slice(config.decSpecDataStart, config.decSpecDataStart + config.decSpecLength);
  } catch {
    return new Uint8Array(0);
  }
}

/**
 * Parses only the FIRST sample entry when more than one is present ("parameter set changes
 * mid-stream"), matching the spike's behavior of copying one stsd verbatim regardless of entry
 * count. Per-sample sample_description_index selection is decode-time work and out of scope for
 * this task -- build-track-index.ts attaches a warning when entryCount > 1 so a downstream
 * consumer at least knows the codec/description reported here may not hold for the whole track.
 */
export function parseStsd(view: DataView, box: BoxHeader, kind: 'video' | 'audio' | 'other'): StsdResult {
  const contentStart = box.offset + box.headerSize;
  const entryCount = view.getUint32(contentStart + 4);
  const boxEnd = box.offset + box.boxSize;
  const firstEntryOffset = contentStart + 8;

  if (entryCount === 0 || firstEntryOffset + 8 > boxEnd) {
    return { codec: '', description: new Uint8Array(0), entryCount, sampleEntryType: '' };
  }

  const entry = readBoxHeaderInView(view, firstEntryOffset, boxEnd);
  const entryContentStart = entry.offset + entry.headerSize;
  const entryEnd = entry.offset + entry.boxSize;

  if (kind === 'video') {
    const codedWidth = view.getUint16(entryContentStart + 24);
    const codedHeight = view.getUint16(entryContentStart + 26);
    const childrenStart = entryContentStart + 78; // fixed VisualSampleEntry fields per ISO/IEC 14496-12
    const avcC = findChild(view, childrenStart, entryEnd, 'avcC');
    const hvcC = avcC ? undefined : findChild(view, childrenStart, entryEnd, 'hvcC');
    if (avcC) return { codec: parseAvcCCodecString(view, avcC), description: rawBoxBytes(view, avcC), entryCount, sampleEntryType: entry.type, codedWidth, codedHeight };
    if (hvcC) return { codec: parseHvcCCodecString(view, hvcC), description: rawBoxBytes(view, hvcC), entryCount, sampleEntryType: entry.type, codedWidth, codedHeight };
    return { codec: entry.type, description: new Uint8Array(0), entryCount, sampleEntryType: entry.type, codedWidth, codedHeight };
  }

  if (kind === 'audio') {
    const channelCount = view.getUint16(entryContentStart + 16);
    const sampleRate = view.getUint32(entryContentStart + 24) >>> 16; // 16.16 fixed point; the fraction half is always 0 in practice
    const childrenStart = entryContentStart + 28; // fixed AudioSampleEntry fields per ISO/IEC 14496-12 (8-byte SampleEntry + 8-byte reserved + 12 bytes of audio fields)
    const esds = findChild(view, childrenStart, entryEnd, 'esds');
    if (esds) return { codec: parseEsdsCodecString(view, esds), description: rawBoxBytes(view, esds), entryCount, sampleEntryType: entry.type, channelCount, sampleRate };
    return { codec: entry.type, description: new Uint8Array(0), entryCount, sampleEntryType: entry.type, channelCount, sampleRate };
  }

  return { codec: entry.type, description: new Uint8Array(0), entryCount, sampleEntryType: entry.type };
}
