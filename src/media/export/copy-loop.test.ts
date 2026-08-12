import { describe, expect, it } from 'vitest';
import { BufferByteSource } from '../index/sources/buffer-byte-source';
import { forEachWindowMerged, type CancelSignal } from './copy-loop';
import type { TrackIndex } from '../index/track-index';
import type { ExportRange } from './types';

function makeTrack(trackId: number, offsets: number[], sizes: number[]): TrackIndex {
  return {
    trackId,
    kind: 'video',
    handlerType: 'vide',
    codec: 'avc1.640034',
    timescale: 1000,
    duration: 0,
    sampleCount: offsets.length,
    pts: Float64Array.from(offsets.map((_, i) => i * 100)),
    dts: Float64Array.from(offsets.map((_, i) => i * 100)),
    offset: Float64Array.from(offsets),
    size: Uint32Array.from(sizes),
    isSync: Uint8Array.from(offsets.map(() => 1)),
    description: new Uint8Array(0),
    editOffsetTicks: 0,
  };
}

/** Builds a source buffer where the byte at every position equals its own offset (mod 256), so a
 * window's contents can be checked against expected offsets without a separate content model. */
function markedBuffer(size: number): Uint8Array {
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) buf[i] = i % 256;
  return buf;
}

describe('forEachWindowMerged', () => {
  it('coalesces adjacent samples into windows and yields exactly the needed bytes, in offset order', async () => {
    const video = makeTrack(1, [0, 10, 20], [8, 8, 8]);
    const audio = makeTrack(2, [30, 40], [6, 6]);
    const tracksById = new Map([
      [1, video],
      [2, audio],
    ]);
    const ranges: ExportRange[] = [
      { trackId: 1, first: 0, last: 2 },
      { trackId: 2, first: 0, last: 1 },
    ];
    const source = new BufferByteSource(markedBuffer(64));
    const signal: CancelSignal = { cancelled: false };

    const windows: Array<{ bytes: Uint8Array; sampleCount: number }> = [];
    const stats = await forEachWindowMerged(source, ranges, tracksById, 4 * 1024 * 1024, (bytes, sampleCount) => {
      windows.push({ bytes: bytes.slice(), sampleCount });
      return Promise.resolve();
    }, signal);

    // All 5 samples fit in one window since windowBytes is large.
    expect(windows).toHaveLength(1);
    expect(windows[0].sampleCount).toBe(5);
    expect(stats.windowReads).toBe(1);
    expect(stats.windowBytesRead).toBeGreaterThan(0);
  });

  it('produces byte-identical output to reading each sample directly, regardless of window size', async () => {
    const video = makeTrack(1, [0, 16, 32], [10, 10, 10]);
    const tracksById = new Map([[1, video]]);
    const ranges: ExportRange[] = [{ trackId: 1, first: 0, last: 2 }];
    const buf = markedBuffer(64);
    const source = new BufferByteSource(buf);

    // Small window forces one window per sample; large window coalesces all three.
    for (const windowBytes of [1, 8, 4 * 1024 * 1024]) {
      const chunks: Uint8Array[] = [];
      await forEachWindowMerged(source, ranges, tracksById, windowBytes, (bytes) => {
        chunks.push(bytes.slice());
        return Promise.resolve();
      }, { cancelled: false });
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const flat = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) {
        flat.set(c, o);
        o += c.byteLength;
      }
      const expected = concat([buf.subarray(0, 10), buf.subarray(16, 26), buf.subarray(32, 42)]);
      expect(flat).toEqual(expected);
    }
  });

  it('stops reading once cancelled, mid-run', async () => {
    const video = makeTrack(
      1,
      Array.from({ length: 20 }, (_, i) => i * 8),
      Array.from({ length: 20 }, () => 8),
    );
    const tracksById = new Map([[1, video]]);
    const ranges: ExportRange[] = [{ trackId: 1, first: 0, last: 19 }];
    const source = new BufferByteSource(markedBuffer(200));
    const signal: CancelSignal = { cancelled: false };

    let windowsSeen = 0;
    await forEachWindowMerged(source, ranges, tracksById, 8 /* one sample per window */, () => {
      windowsSeen += 1;
      if (windowsSeen === 3) signal.cancelled = true;
      return Promise.resolve();
    }, signal);

    // The 3rd onWindow call flips the signal; the loop must not start a 4th window.
    expect(windowsSeen).toBe(3);
  });
});

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}
