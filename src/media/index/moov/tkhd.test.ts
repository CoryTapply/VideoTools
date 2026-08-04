import { describe, expect, it } from 'vitest';
import { readBoxHeaderInView } from '../box-cursor';
import { box, fullBoxHeader, i32, u16, u32 } from '../test-helpers/build-box';
import { parseTkhd, rotationDegreesFromMatrix } from './tkhd';

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function fixed(n: number): Uint8Array {
  return i32(Math.round(n * 65536));
}

function tkhdBytes(matrix: number[], width: number, height: number): Uint8Array {
  return box('tkhd', [
    fullBoxHeader(0),
    u32(0), // creation_time
    u32(0), // modification_time
    u32(7), // track_ID
    u32(0), // reserved
    u32(1000), // duration
    new Uint8Array(8), // reserved[2]
    u16(0), // layer
    u16(0), // alternate_group
    u16(0), // volume
    u16(0), // reserved
    ...matrix.map((m) => fixed(m)),
    fixed(width),
    fixed(height),
  ]);
}

describe('parseTkhd', () => {
  it('reads trackId, duration, and display width/height', () => {
    const bytes = tkhdBytes([1, 0, 0, 0, 1, 0, 0, 0, 1], 1920, 1080);
    const view = viewOf(bytes);
    const header = readBoxHeaderInView(view, 0, bytes.byteLength);
    const info = parseTkhd(view, header);
    expect(info.trackId).toBe(7);
    expect(info.duration).toBe(1000);
    expect(info.displayWidth).toBe(1920);
    expect(info.displayHeight).toBe(1080);
  });
});

describe('rotationDegreesFromMatrix', () => {
  it('recognizes identity (0deg)', () => {
    expect(rotationDegreesFromMatrix(Int32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1].map((n) => n * 65536)))).toBe(0);
  });

  it('recognizes a 90deg rotation', () => {
    expect(rotationDegreesFromMatrix(Int32Array.from([0, 1, 0, -1, 0, 0, 0, 0, 1].map((n) => n * 65536)))).toBe(90);
  });

  it('recognizes a 180deg rotation', () => {
    expect(rotationDegreesFromMatrix(Int32Array.from([-1, 0, 0, 0, -1, 0, 0, 0, 1].map((n) => n * 65536)))).toBe(180);
  });

  it('recognizes a 270deg rotation', () => {
    expect(rotationDegreesFromMatrix(Int32Array.from([0, -1, 0, 1, 0, 0, 0, 0, 1].map((n) => n * 65536)))).toBe(270);
  });

  it('reports 0 for a non-axis-aligned matrix rather than guessing', () => {
    expect(rotationDegreesFromMatrix(Int32Array.from([0.5, 0.5, 0, -0.5, 0.5, 0, 0, 0, 1].map((n) => Math.round(n * 65536))))).toBe(0);
  });
});
