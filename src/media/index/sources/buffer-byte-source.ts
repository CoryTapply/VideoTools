import type { ByteSource } from '../byte-source';

/** Wraps an in-memory Uint8Array. Pure, synchronous under the hood -- used by every unit and property test in this module. */
export class BufferByteSource implements ByteSource {
  private readonly buf: Uint8Array;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  get size(): number {
    return this.buf.byteLength;
  }

  read(offset: number, length: number): Promise<Uint8Array> {
    const start = Math.max(0, Math.min(offset, this.buf.byteLength));
    const end = Math.max(start, Math.min(offset + length, this.buf.byteLength));
    return Promise.resolve(this.buf.subarray(start, end));
  }
}
