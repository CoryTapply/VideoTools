// Wraps showDirectoryPicker(). Must run on the main thread -- File System Access pickers require
// transient user activation, which a worker doesn't have.
//
// This is directory, not file, selection -- see sinks/file-system-sink.ts for why: the safety
// property "cancelling an export never damages an existing file" turned out NOT to be provided by
// createWritable()/abort() on the destination file directly (measured against real Chrome -- see
// README.md's "temp-name-and-rename" section for the full story). Writing to a scratch temp file
// inside the chosen directory and only using FileSystemFileHandle.move() to atomically place it at
// the final name on success is what actually provides that guarantee, and needs a directory
// handle (to create the temp file as a sibling) rather than a single file handle.

export interface DirectoryPickerOptions {
  mode?: 'read' | 'readwrite';
}

declare global {
  interface Window {
    showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;
  }
}

export type PickExportDirectoryResult = { ok: true; handle: FileSystemDirectoryHandle } | { ok: false; kind: 'unsupported' | 'cancelled' };

export async function pickExportDirectory(): Promise<PickExportDirectoryResult> {
  if (typeof window.showDirectoryPicker !== 'function') return { ok: false, kind: 'unsupported' };
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    return { ok: true, handle };
  } catch (err) {
    // showDirectoryPicker rejects with an AbortError DOMException when the user dismisses the
    // dialog -- the only expected rejection reason; anything else is a real, unexpected failure
    // and must not be silently swallowed as a cancel.
    if (err instanceof DOMException && err.name === 'AbortError') return { ok: false, kind: 'cancelled' };
    throw err;
  }
}
