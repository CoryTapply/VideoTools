// The only file in this module that touches FileSystemWritableFileStream. Real temp-name-and-
// rename: writes go to a scratch temp file created fresh inside the destination directory (never
// the real target), and only `close()` calls FileSystemFileHandle.move() to atomically place it at
// the final name -- overwriting an existing file of that name in one step. `abort()` never touches
// the final name at all.
//
// This exists because the spec-described "createWritable() writes to a temp file and swaps it in
// on close(), leaving an aborted write's target untouched" guarantee does NOT hold against real
// Chrome (measured directly: createWritable() -- with or without keepExistingData: true -- then
// write() then abort() left an existing target file truncated to 0 bytes, both on the main thread
// and from a worker). FileSystemFileHandle.move(), confirmed to exist and work correctly in the
// same browser, is what actually provides the safety property -- see README.md.

import type { ExportSink } from '../RemuxStrategy';

// Not yet in TS's lib.dom.d.ts, despite existing and working in real Chrome (confirmed directly --
// see README.md). Same-directory rename, overwriting any existing file at `newName`.
declare global {
  interface FileSystemFileHandle {
    move(newName: string): Promise<void>;
  }
}

const TEMP_SUFFIX = '.crswap';

export class FileSystemWritableSink implements ExportSink {
  private readonly writable: FileSystemWritableFileStream;
  private readonly directory: FileSystemDirectoryHandle;
  private readonly tempHandle: FileSystemFileHandle;
  private readonly tempName: string;
  private readonly finalName: string;

  private constructor(writable: FileSystemWritableFileStream, directory: FileSystemDirectoryHandle, tempHandle: FileSystemFileHandle, tempName: string, finalName: string) {
    this.writable = writable;
    this.directory = directory;
    this.tempHandle = tempHandle;
    this.tempName = tempName;
    this.finalName = finalName;
  }

  static async create(directory: FileSystemDirectoryHandle, finalName: string): Promise<FileSystemWritableSink> {
    const tempName = `${finalName}${TEMP_SUFFIX}`;
    const tempHandle = await directory.getFileHandle(tempName, { create: true });
    const writable = await tempHandle.createWritable();
    return new FileSystemWritableSink(writable, directory, tempHandle, tempName, finalName);
  }

  async write(bytes: Uint8Array): Promise<void> {
    await this.writable.write(bytes as Uint8Array<ArrayBuffer>);
  }

  async close(): Promise<void> {
    await this.writable.close();
    // The only step that ever touches the real destination name -- a single atomic rename that
    // overwrites any existing file there.
    await this.tempHandle.move(this.finalName);
  }

  async abort(_reason?: string): Promise<void> {
    await this.writable.abort(_reason);
    // Best-effort cleanup of the scratch file; the real destination was never opened, so this
    // succeeding or failing has no bearing on the safety property itself.
    try {
      await this.directory.removeEntry(this.tempName);
    } catch {
      // ignore -- nothing more to do if this fails, and nothing was ever at risk
    }
  }
}
