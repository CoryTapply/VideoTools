/**
 * The seam that lets every parser in this module run in Node against hand-built
 * bytes, and in the browser against a real File, without duplicating parsing logic.
 * Nothing below this file (box-cursor.ts through query.ts) may import File, Blob,
 * window, or any other DOM type -- see sources/file-byte-source.ts, opfs-cache.ts,
 * and worker.ts/worker-client.ts for the three deliberate, narrow exceptions.
 */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/**
 * Wraps any ByteSource and accumulates total bytes actually read, so a caller can
 * assert an invariant like "parsing a moov of size N never reads more than N + a
 * small constant" -- the class of bug that cost a 6.5x read amplification in the
 * export copy loop (see results/T0-exportcost.md).
 */
export class CountingByteSource implements ByteSource {
  private readonly inner: ByteSource;
  private total = 0;

  constructor(inner: ByteSource) {
    this.inner = inner;
  }

  get size(): number {
    return this.inner.size;
  }

  get bytesRead(): number {
    return this.total;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const bytes = await this.inner.read(offset, length);
    this.total += bytes.byteLength;
    return bytes;
  }
}
