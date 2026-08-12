// The only file in this module that touches FileSystemWritableFileStream. Writes go straight to
// the real destination handle picker.ts's showSaveFilePicker() returns -- there's no app-level
// temp-file/rename here.
//
// That's a deliberate, accepted tradeoff, not an oversight: real Chrome's createWritable()
// truncates an *existing* file at the target name immediately, and abort() does not restore it --
// confirmed directly (with and without `keepExistingData: true`, on the main thread and from a
// worker), contrary to what the WHATWG spec text implies. So cancelling or failing an export that
// overwrites an existing file can destroy that file. See README.md's "Temp-name-and-rename" section
// for the full history -- this module used to guard against exactly that by writing to a scratch
// temp file in a chosen directory and only `FileSystemFileHandle.move()`-ing it onto the final name
// on success. It moved back to a single-file picker (picker.ts) at the user's explicit request, in
// exchange for a native one-step "Save As" dialog, accepting this risk.

import type { ExportSink } from '../RemuxStrategy';

export class FileSystemWritableSink implements ExportSink {
  private readonly writable: FileSystemWritableFileStream;

  private constructor(writable: FileSystemWritableFileStream) {
    this.writable = writable;
  }

  static async create(handle: FileSystemFileHandle): Promise<FileSystemWritableSink> {
    return new FileSystemWritableSink(await handle.createWritable());
  }

  async write(bytes: Uint8Array): Promise<void> {
    await this.writable.write(bytes as Uint8Array<ArrayBuffer>);
  }

  async close(): Promise<void> {
    await this.writable.close();
  }

  async abort(reason?: string): Promise<void> {
    await this.writable.abort(reason);
  }
}
