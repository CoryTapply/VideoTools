# `src/media/export/`

Task 5 (`roadmap.md`): stream-copy (remux) export of the trimmed range, with multi-track selection,
a merged single-pass copy loop, and cancel-safe writes. No decode/encode anywhere in this module --
that's M3's job (smart render), not this one.

Mirrors `src/media/index/`, `src/media/playback/`, `src/media/frames/`'s pattern: a Node-testable
core with no `File`/`Blob`/`Worker`/File System Access types, plus a narrow, explicit browser-only
boundary.

## Why this module doesn't port `src/spikes/A-remux/select.ts`

That file's `lastSampleAtOrBefore` does a decode-order forward scan for both the in- and out-point
of a trim -- silently wrong under B-frame reordering (see `src/media/index/query.ts`'s §7 header
comment for the exact counter-example, which was a real 1-frame discrepancy found and fixed once
already in Task 1). `select.ts` in this module is a deliberate rewrite built on
`SampleIndex.sampleRange` (presentation-order binary search) instead, so that class of bug is
impossible here by construction. `select.test.ts` reuses `query.test.ts`'s exact B-frame regression
fixture to prove it.

## Why raw `moov` box bytes are read independently, not added to `TrackIndex`

Writing a valid output file needs the source's raw `mvhd`/`tkhd`/`mdhd`/`hdlr`/`stsd`/minf-prefix
bytes verbatim (or lightly patched, for duration fields). Production `TrackIndex`
(`src/media/index/track-index.ts`) is a pure query/display model and doesn't retain these -- two
already-shipped modules (playback, frame cache) depend on that type and have no use for this
payload. Rather than extending the shared index, `raw-boxes.ts` does its own narrow walk of the
source file's `moov` at export time, using `box-cursor.ts`'s existing (previously unused)
`findChild`/`iterateBoxes`/`rawBoxBytes` primitives. Small, self-contained, zero blast radius on
playback/frame-cache.

`ftyp` is *not* copied from the source -- a fresh standard `ftyp` is synthesized when building the
output moov instead, matching how stream-copy muxers (`ffmpeg -c copy` included) conventionally
handle it: `ftyp` only declares compatible brands, it doesn't describe the sample data this module
rewrites.

## The merged single-pass copy loop

`src/spikes/T0-exportcost/`'s A/B harness found that windowing each track's samples *separately*
(the original per-track ~1s round-robin schedule) causes read amplification proportional to track
count -- a 7-track fixture measured 6.5x, near the 7x ceiling, because each ~1s span of physically
interleaved source bytes gets read once per track. `schedule.ts`/`copy-loop.ts` instead flatten
every selected track's samples into one list sorted by *source byte offset*, so a single sequential
read maps to a single sequential write with no reordering buffer -- read amplification 1.00x.
Dropping tracks (e.g. exporting only the mic track) needs no special case: the merged list simply
has fewer entries.

## Progress model

`progress.ts` implements the measured cost model from `results/T0-EXPORT-COST.md`:
`copy_ms ≈ 9.5 + size_MB/245.6`, `close_ms ≈ 26.6 + size_MB/734.1`. `close()` is not O(1) -- it's a
real, size-proportional operation (the File System Access spec requires `createWritable()` to write
to a temp file and atomically swap it in on `close()`), so a naive "bytes written / total" progress
bar would sit at 100% for up to ~5.5s on a 4GB export while the file isn't yet committed. An
explicit `finalising` phase covers this. `measure/timing.ts` (used by the spikes) is
diagnostic-harness-only and is deliberately not reused here.

## "Temp-name-and-rename"

**Revised after real-browser testing found the original plan wrong.** The WHATWG spec text reads
as though `createWritable()` writes to a hidden temp file and only swaps it in on `close()`,
leaving an aborted write's target untouched. That is not what real Chrome does: measured directly
(`createWritable()` -- with and without `{keepExistingData: true}` -- then `write()` then
`abort()`, both on the main thread and from inside a Worker), an *existing* target file was left
truncated to 0 bytes every time. `abort()` does not restore it.

So this module does real, app-level temp-name-and-rename instead of relying on that guarantee:
`sinks/file-system-sink.ts` creates a scratch temp file (`<name>.crswap`) fresh inside the
destination *directory* (confirmed via `FileSystemFileHandle.prototype.move`, which exists and
works in the same browser) and writes there -- never opening the real destination at all. Only
`close()` calls `tempHandle.move(finalName)`, a single atomic rename that overwrites any existing
file at that name. `abort()` never touches the final name; it just discards the temp file. This is
why `picker.ts` asks for a *directory* (`showDirectoryPicker`), not a single file
(`showSaveFilePicker` as the first version of this module used) -- a temp file needs a directory to
be created as a sibling in, and `FileSystemFileHandle` has no reverse-navigation-to-parent API by
design.

## Worker split and cancellation

The bulk copy runs in a worker (`worker.ts`/`worker-client.ts`), mirroring
`src/media/index/worker.ts`/`worker-client.ts` and `src/media/frames/worker-client.ts`'s existing
patterns -- `architecture-v3.md`'s system diagram already names `export.worker` alongside
`index.worker` and the frame decode pool. The worker does not trust a plan computed on the main
thread and shipped over `postMessage`: it receives the raw ingredients (`File`, serialized tracks,
selected track ids, requested in/out) and calls `resolveExportSelection` itself, independently --
the same function the main thread calls for its live "est. size" estimate, invoked separately so
nothing correctness-critical crosses the boundary as a pre-trusted value. `AbortSignal` isn't
structured-cloneable, so cancellation is message-based (`{type:'cancel', requestId}`), mirroring
`FrameWorkerClient.cancel(requestId)`'s existing pattern -- the worker keeps a `{cancelled: false}`
signal per in-flight request and `forEachWindowMerged` polls it.

`ExportWorkerClient`, like `IndexWorkerClient` and `FrameWorkerClient`, is a thin main-thread
wrapper with no dedicated unit test of its own (neither sibling has one either) -- the logic it
wraps (`RemuxStrategy.ts` down through `copy-loop.ts`) is fully Node-tested; the wrapper itself is
verified by running in a real browser.

## Files

- `types.ts` -- shared types (`ExportSelection`, `ExportProgress`, `ExportError`, `ExportResult`).
- `select.ts` -- `resolveExportSelection`: keyframe-snaps the in-point off the video track, then
  calls `SampleIndex.sampleRange` per selected track.
- `estimate.ts` -- `estimateExportBytes`: real, no-I/O size estimate for a resolved selection.
- `raw-boxes.ts` -- `readRawMoovBoxes`: the independent moov walk described above.
- `box-writer.ts` -- low-level box-writing primitives (ported near-verbatim from the spike).
- `moov-builder.ts`, `schedule.ts`, `copy-loop.ts` -- the moov rewrite and merged copy loop
  (ported from `src/spikes/A-remux/remux-write.ts`, retyped against production `TrackIndex`).
- `RemuxStrategy.ts` -- orchestrates the above into one export run, sink-injected so it stays
  Node-testable against a fake `ExportSink`.
- `progress.ts` -- the T0 cost-model constants.
- `sinks/file-system-sink.ts`, `picker.ts`, `worker*.ts` -- the browser-only boundary.
