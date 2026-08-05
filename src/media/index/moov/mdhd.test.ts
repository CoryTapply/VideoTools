import { describe, expect, it } from 'vitest';
import { readBoxHeaderInView } from '../box-cursor';
import { box, fullBoxHeader, u16, u32 } from '../test-helpers/build-box';
import { parseMdhd } from './mdhd';

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function packLanguage(code: string): number {
  return ((code.charCodeAt(0) - 0x60) << 10) | ((code.charCodeAt(1) - 0x60) << 5) | (code.charCodeAt(2) - 0x60);
}

describe('parseMdhd', () => {
  it('reads version 0 timescale/duration and decodes the packed language code', () => {
    const bytes = box('mdhd', [fullBoxHeader(0), u32(0), u32(0), u32(48000), u32(96000), u16(packLanguage('eng')), u16(0)]);
    const view = viewOf(bytes);
    const header = readBoxHeaderInView(view, 0, bytes.byteLength);
    const info = parseMdhd(view, header);
    expect(info.timescale).toBe(48000);
    expect(info.duration).toBe(96000);
    expect(info.language).toBe('eng');
  });

  it('treats an all-zero packed language as unset', () => {
    const bytes = box('mdhd', [fullBoxHeader(0), u32(0), u32(0), u32(48000), u32(96000), u16(0), u16(0)]);
    const view = viewOf(bytes);
    const header = readBoxHeaderInView(view, 0, bytes.byteLength);
    expect(parseMdhd(view, header).language).toBe('');
  });
});
