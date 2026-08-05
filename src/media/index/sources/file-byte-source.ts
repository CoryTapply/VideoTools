import type { ByteSource } from '../byte-source';

/** Wraps a browser File. The only file in the parsing core that touches a DOM type. */
export class FileByteSource implements ByteSource {
  private readonly file: File;

  constructor(file: File) {
    this.file = file;
  }

  get size(): number {
    return this.file.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const buf = await this.file.slice(offset, offset + length).arrayBuffer();
    return new Uint8Array(buf);
  }
}
