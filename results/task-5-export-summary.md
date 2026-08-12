# M1 Task 5 — export: summary

Status: implemented, Node-tested (a new `src/media/export/` module, differential-tested by
exporting a synthetic multi-track file and reparsing it through the production parser), and
**manually verified in a real, non-automated browser session against `fixtures/27gb.mp4`**. `npm
run typecheck`, `npm run lint`, `npm test` (516 tests) all clean. Shipped via PR #17.

This is the last M1 task. This file is a handoff/context summary for a future session; module
rationale lives in `src/media/export/README.md`.

---

## What was built

New module at `src/media/export/`, mirroring `src/media/index/`, `src/media/playback/`,
`src/media/frames/`'s pattern: a Node-testable core with no `File`/`Worker`/File-System-Access
types, plus a narrow, explicit browser-only boundary.

- **`select.ts`** — `resolveExportSelection`: keyframe-snaps the in-point off the video track
  (`nearestSyncAtOrBeforePresentation`), then calls `SampleIndex.sampleRange` per selected track. A
  **deliberate rewrite** of the spike's `src/spikes/A-remux/select.ts`, not a port — that file's
  `lastSampleAtOrBefore` does a decode-order forward scan for both the in- and out-point, which is
  exactly the B-frame-reordering bug `query.ts`'s `sampleRange` already fixed once, in Task 1.
  `select.test.ts` reuses `query.test.ts`'s own B-frame regression fixture to prove this inherits
  the fix for free.
- **`raw-boxes.ts`** — an independent walk of the source file's `moov` at export time, using
  `box-cursor.ts`'s existing (previously unused) `findChild`/`iterateBoxes`/`rawBoxBytes`
  primitives, to recover the raw `mvhd`/`tkhd`/`mdhd`/`hdlr`/`stsd`/minf-prefix bytes a remux
  writer needs. Kept independent of production `TrackIndex` (a pure query/display model that two
  already-shipped modules depend on) rather than extending it.
- **`box-writer.ts`, `moov-builder.ts`, `schedule.ts`, `copy-loop.ts`** — ported from
  `src/spikes/A-remux/remux-write.ts`, retyped against production `TrackIndex` field names. Only
  the **merged** schedule/copy path is promoted (flattens every selected track's samples into one
  list sorted by source byte offset — the fix for the 6.5x read-amplification the spike found from
  windowing tracks separately); the original per-track path is not carried forward.
  `copy-loop.ts`'s `forEachWindowMerged` is the one real rewrite, not just a port: it reads through
  the `ByteSource` seam instead of a hard-coded `File.slice()`, which is what makes it
  Node-testable, and polls a cancellation signal once per window.
- **`RemuxStrategy.ts`** — `runRemuxExport`, the orchestrator. Sink-injected (`ExportSink`) so it
  stays Node-testable against a fake sink — see `RemuxStrategy.test.ts`'s differential round-trip
  test below. Callback-based `onProgress`, not an async generator, matching `IndexWorkerClient`'s
  existing precedent in this codebase.
- **`progress.ts`** — the T0 cost-model constants (`copy_ms ≈ 9.5 + size_MB/245.6`, `close_ms ≈
  26.6 + size_MB/734.1`) driving the explicit `finalising` phase.
- Browser boundary: **`sinks/file-system-sink.ts`**, **`picker.ts`**, **`worker.ts`** /
  **`worker-client.ts`** / **`worker-protocol.ts`** — see "What was found" below for why the sink
  isn't what was originally planned.
- **UI wiring**: real per-track ids threaded through `TrackSummary` (new `trackId: number` field),
  a live no-I/O "est. size" estimate in the Export panel, a new `useExportSession` hook
  (`src/ui/state/export-session.ts`) driving the existing progress overlay/toast from Task 4a, and
  a new `ExportErrorToast` for failures.
- Folded `src/media/index/worker.ts`/`worker-client.ts`'s serialize/deserialize helpers into a
  shared `src/media/index/serialize-track.ts`, reused by the new export worker.

## What was found

**The `createWritable()`/`abort()` safety guarantee the original plan relied on does not hold
against real Chrome.** The WHATWG File System Access spec reads as though `createWritable()`
writes to a hidden temp file and only swaps it into the visible destination on `close()`, leaving
an aborted write's target completely untouched — this was checked directly against the spec text
during planning, and the original "temp-name-and-rename" design decision was: no app-level
directory-handle-plus-manual-rename needed, `createWritable()` already gives this for free.

Real-browser verification proved this wrong. During the M1 exit-criteria pass, a checksum
comparison immediately after cancelling an overwrite-export appeared to confirm the target file was
untouched — but the file was unplayable a few minutes later. Investigation found: **`abort()`
does not restore a truncated file.** Isolated repro (`createWritable()` → `write()` → `abort()`),
tested four ways — main thread and from inside a Worker, with and without
`{keepExistingData: true}` — left an existing target file at 0 bytes every single time.
`createWritable()` truncates the destination immediately, not lazily at `close()` time, and
`abort()` only stops further writes; it does not undo the truncation.

**The fix**: real, application-level temp-name-and-rename, which doesn't depend on that guarantee
at all.
- `picker.ts` now asks for a destination **directory** (`showDirectoryPicker`), not a single file
  (`showSaveFilePicker`, the first version) — a temp file needs a directory to be created as a
  sibling in, and `FileSystemFileHandle` has no reverse-navigation-to-parent API by design.
- `sinks/file-system-sink.ts` creates a scratch `<name>.crswap` file fresh inside that directory
  and writes there — the real destination is never opened at all during the copy.
- Only a successful `close()` calls `FileSystemFileHandle.prototype.move(finalName)` (confirmed to
  exist and work correctly in this browser — not yet in TS's `lib.dom.d.ts`, so it's ambiently
  declared), a single atomic rename that overwrites any existing file at that name.
- `abort()` never touches the final name; it just discards the temp file (best-effort cleanup —
  nothing was ever at risk regardless of whether the cleanup itself succeeds).

Cancelling now leaves the real destination undamaged **by construction** — there's no browser
behavior left to trust for that property. `src/media/export/README.md`'s "Temp-name-and-rename"
section documents the finding and the fix so it doesn't get relitigated.

## Real-browser verification against `fixtures/27gb.mp4`

Session notes, in the order run:

1. **Trim + playback.** A ~30-minute range (accidental — ruler ticks read as minutes, not seconds,
   at full-timeline zoom) exported to a real ~10.6GB file. Played correctly in QuickTime and
   Chrome. **VLC is not installed on this machine — untested**, a real gap in this M1 exit
   criterion, not something to silently claim.
2. **Memory.** Activity Monitor peak during that export: **460MB**, under the 500MB ceiling.
3. **Multi-track selection.** Exported with the default selection (video + only the first of 6
   audio tracks). `ffprobe` (an independent demuxer from this project's own parser) confirmed
   exactly 2 streams (h264 3840×2160, aac 48kHz stereo) and the correct ~30s duration.
   **Caveat**: the primary video track is locked in `TrackList` (a Task 4a UI decision, unchanged
   by this task) and can't be deselected via the checkboxes, so a literal video-free export isn't
   reachable through the product UI today — only through the pipeline directly (unit-tested in
   `select.test.ts`'s "video excluded from selection but still supplies the cut grid" case). Worth
   a product decision later on whether the roadmap's "only the mic track" should mean this.
4. **Cancel safety**, found broken then fixed (see "What was found"):
   - New filename, cancelled mid-copy: real 0-byte placeholder left behind, never a partial file.
   - Overwriting an existing file, cancelled mid-copy: **checksum-verified** byte-for-byte
     untouched, both in isolation (a small synthetic target) and at real scale (the 10.6GB
     `27gb_clip.mp4`, `2ba14d4f...` before and after).
   - A real export completed successfully post-fix, atomically replacing the target (`ffprobe`:
     correct duration, valid streams, no leftover `.crswap`).

## Where things stand

M1 is now 8 of 8 tasks done. Exit criteria are met with the VLC and video-track-lock caveats above
flagged, not silently passed over — see `roadmap.md`'s M1 exit criteria section for the per-item
status.
