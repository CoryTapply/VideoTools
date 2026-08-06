import { describe, expect, it } from 'vitest';
import { formatFrameDecodeError, stripBoxHeader } from './FrameDecoder';

describe('stripBoxHeader', () => {
  it('drops the first 8 bytes (4-byte size + 4-byte fourcc), leaving only the box content', () => {
    // A synthetic avcC box: size=16 (0x00000010), fourcc='avcC', then 8 bytes of "content".
    const box = new Uint8Array([0x00, 0x00, 0x00, 0x10, 0x61, 0x76, 0x63, 0x43, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Array.from(stripBoxHeader(box))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('does not mutate the input', () => {
    const box = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 42]);
    const copy = box.slice();
    stripBoxHeader(box);
    expect(box).toEqual(copy);
  });
});

describe('formatFrameDecodeError', () => {
  it('formats an unsupported-config error with the codec string', () => {
    expect(formatFrameDecodeError({ kind: 'unsupported-config', codec: 'avc1.640034' })).toContain('avc1.640034');
  });

  it('formats a decode-error as its own message', () => {
    expect(formatFrameDecodeError({ kind: 'decode-error', message: 'boom', jobId: 5 })).toBe('boom');
  });
});
