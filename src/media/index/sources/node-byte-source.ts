import { open, type FileHandle } from 'node:fs/promises';
import type { ByteSource } from '../byte-source';

/** Wraps a Node file descriptor. Test-only import surface -- never used from the browser bundle. */
export class NodeByteSource implements ByteSource {
  private readonly handle: FileHandle;
  readonly size: number;

  private constructor(handle: FileHandle, size: number) {
    this.handle = handle;
    this.size = size;
  }

  static async open(path: string): Promise<NodeByteSource> {
    const handle = await open(path, 'r');
    const stats = await handle.stat();
    return new NodeByteSource(handle, stats.size);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const clampedLength = Math.max(0, Math.min(length, this.size - offset));
    if (clampedLength === 0) return new Uint8Array(0);
    const buffer = new Uint8Array(clampedLength);
    const { bytesRead } = await this.handle.read(buffer, 0, clampedLength, offset);
    return bytesRead === clampedLength ? buffer : buffer.subarray(0, bytesRead);
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}
