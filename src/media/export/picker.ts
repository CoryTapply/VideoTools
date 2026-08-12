// Wraps showSaveFilePicker(). Must run on the main thread -- File System Access pickers require
// transient user activation, which a worker doesn't have.
//
// A single-file picker, deliberately -- this is the second time this module has used
// showSaveFilePicker (the first version of sinks/file-system-sink.ts used it too, before Task 5's
// real-browser finding). That finding still stands: real Chrome's createWritable() truncates an
// *existing* file at the target name immediately, and abort() does not restore it -- contrary to
// what the spec text implies. See README.md's "Temp-name-and-rename" section for the full story
// and why the app moved to showDirectoryPicker() + an app-level temp-file/rename for a while.
//
// This is a deliberate reversion back to showSaveFilePicker(), at the user's explicit request, in
// exchange for a single native "Save As" dialog that lets them both pick the location and type the
// name in one familiar step -- not an accidental reintroduction of the bug. The tradeoff: cancelling
// or failing an export that overwrites an existing file can still destroy that file. See
// sinks/file-system-sink.ts and README.md for the accepted-risk note.

export interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
}

declare global {
  interface Window {
    showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  }
}

export type PickExportFileResult = { ok: true; handle: FileSystemFileHandle } | { ok: false; kind: 'unsupported' | 'cancelled' };

export async function pickExportFile(suggestedName: string): Promise<PickExportFileResult> {
  if (typeof window.showSaveFilePicker !== 'function') return { ok: false, kind: 'unsupported' };
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
    });
    return { ok: true, handle };
  } catch (err) {
    // showSaveFilePicker rejects with an AbortError DOMException when the user dismisses the
    // dialog -- the only expected rejection reason; anything else is a real, unexpected failure
    // and must not be silently swallowed as a cancel.
    if (err instanceof DOMException && err.name === 'AbortError') return { ok: false, kind: 'cancelled' };
    throw err;
  }
}
