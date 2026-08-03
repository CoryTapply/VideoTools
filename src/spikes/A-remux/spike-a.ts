// Spike A -- real remux with streamed output. See prompts/m0.5-spike-prompts.md.
import { sampleMemoryDuring } from '../../measure/memory';
import { clearTimingRecords, getTimingRecords, markStart, markEnd } from '../../measure/timing';
import { buildResult, recordResult } from '../../measure/record';
import { buildMp4Index, type Mp4Index } from './mp4-index';
import { selectSamples, localUnitsToPresentationSec, type SelectionResult } from './select';
import { buildMoov, buildMdatHeader, planWriteSchedule, forEachWindowCoalesced, type WriteChunk } from './remux-write';

/**
 * Chosen from the Step 5 chunk-size sweep, on the same 1,132,380,899-byte real-export range
 * throughout: 1MB -> 80.5MB/s, 4MB -> 91.1MB/s, 16MB -> 92.0MB/s. Window size plateaus at 4MB --
 * 16MB halved the read-call count again (841 -> 421) for a <1% throughput change, well short of
 * the read-only sweep's predicted ~17% gain, so the remaining bottleneck past 4MB is genuine
 * disk-write bandwidth and/or the lack of overlap between reading and writing (each window is
 * fully read, then fully written, with no pipelining) -- not call count. Settled on 4MB: same
 * throughput as 16MB with less over-read waste and smaller transient buffers. Net result vs. the
 * original per-sample implementation: 37.0MB/s -> 91.1MB/s, a 2.46x improvement, just under the
 * spec's ~100MB/s threshold. Closing that last gap would need read/write pipelining, a real
 * architecture change flagged as a concrete M1 candidate rather than attempted in this spike.
 */
const COALESCE_WINDOW_BYTES = 4 * 1024 * 1024;

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
}
declare global {
  interface Window {
    showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  }
}

// box-writer.ts's Uint8Arrays are always backed by a plain (never shared) ArrayBuffer, but TS's
// generic ArrayBufferView<T> can't express that statically here -- narrow it once, in one place.
async function writeChunk(writable: FileSystemWritableFileStream, bytes: Uint8Array | ArrayBuffer): Promise<void> {
  await writable.write(bytes instanceof ArrayBuffer ? bytes : (bytes as Uint8Array<ArrayBuffer>));
}

const root = document.getElementById('app')!;
root.innerHTML = `
  <p><a href="/">&larr; all spikes</a></p>
  <h1>spike A: remux + streamed export</h1>
  <p>Given a source file and an [in, out] time range (seconds), builds a real playable
  trimmed MP4 by rewriting sample tables and streaming the output to disk via
  showSaveFilePicker(). See <code>prompts/m0.5-spike-prompts.md</code> for the full spec.</p>
  <p>crossOriginIsolated: <strong>${crossOriginIsolated}</strong> |
     File System Access API: <strong>${typeof window.showSaveFilePicker === 'function'}</strong></p>

  <input type="file" id="file" accept="video/*,.mkv,.mp4" /><br /><br />
  <button id="buildIndex" disabled>1. Build index</button>
  <pre id="indexLog"></pre>

  <hr />
  <label>in (sec): <input type="number" id="inSec" value="0" step="0.001" /></label>
  <label>out (sec): <input type="number" id="outSec" value="10" step="0.001" /></label><br /><br />
  <button id="exportBtn" disabled>2. Export range</button>
  <button id="abortBtn" disabled>abort in-flight export</button>
  <pre id="exportLog"></pre>

  <hr />
  <button id="sweepBtn" disabled>3. Source-read chunk-size sweep</button>
  <pre id="sweepLog"></pre>
`;

const fileInput = root.querySelector<HTMLInputElement>('#file')!;
const buildIndexBtn = root.querySelector<HTMLButtonElement>('#buildIndex')!;
const indexLog = root.querySelector<HTMLPreElement>('#indexLog')!;
const inSecInput = root.querySelector<HTMLInputElement>('#inSec')!;
const outSecInput = root.querySelector<HTMLInputElement>('#outSec')!;
const exportBtn = root.querySelector<HTMLButtonElement>('#exportBtn')!;
const abortBtn = root.querySelector<HTMLButtonElement>('#abortBtn')!;
const exportLog = root.querySelector<HTMLPreElement>('#exportLog')!;
const sweepBtn = root.querySelector<HTMLButtonElement>('#sweepBtn')!;
const sweepLog = root.querySelector<HTMLPreElement>('#sweepLog')!;

const ilog = (msg: string): void => {
  indexLog.textContent += `${msg}\n`;
};
const elog = (msg: string): void => {
  exportLog.textContent += `${msg}\n`;
};
const slog = (msg: string): void => {
  sweepLog.textContent += `${msg}\n`;
};

let currentFile: File | undefined;
let currentIndex: Mp4Index | undefined;
let abortController: AbortController | undefined;

fileInput.addEventListener('change', () => {
  currentFile = fileInput.files?.[0];
  currentIndex = undefined;
  buildIndexBtn.disabled = !currentFile;
  exportBtn.disabled = true;
  sweepBtn.disabled = true;
});

// --- ftyp: read verbatim from the source, per spec (stsd etc. are also copied byte-for-byte) ---
async function readFtyp(file: File): Promise<Uint8Array> {
  const head = new DataView(await file.slice(0, 8).arrayBuffer());
  const size = head.getUint32(0);
  if (size === 1) throw new Error('ftyp using 64-bit largesize is not a case this spike handles');
  return new Uint8Array(await file.slice(0, size).arrayBuffer());
}

// --- 1. build index ---
buildIndexBtn.addEventListener('click', () => {
  void (async () => {
    if (!currentFile) return;
    buildIndexBtn.disabled = true;
    indexLog.textContent = '';
    try {
      const index = await buildMp4Index(currentFile);
      currentIndex = index;
      ilog(`moov: offset=${index.moovOffset} size=${index.moovSize} buildMs=${index.buildMs.toFixed(1)} retainedBytes=${index.retainedBytes} (${(index.retainedBytes / 1e6).toFixed(2)}MB)`);
      ilog(`mvhd: timescale=${index.mvhdTimescale} duration=${index.mvhdDuration} (${(index.mvhdDuration / index.mvhdTimescale).toFixed(3)}s)`);
      for (const t of index.tracks) {
        const syncCount = t.sync.reduce((a, b) => a + b, 0);
        ilog(
          `track ${t.trackId} [${t.handlerType}]: timescale=${t.timescale} samples=${t.sampleCount} ` +
            `syncSamples=${syncCount} hasCtts=${t.hasCtts} editList=${t.editList ? JSON.stringify(t.editList) : 'none'}`,
        );
      }
      exportBtn.disabled = false;
      sweepBtn.disabled = false;
    } catch (err) {
      ilog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      buildIndexBtn.disabled = false;
    }
  })();
});

// --- shared: plan a selection + schedule from the current in/out inputs ---
function planSelectionAndSchedule(): { selection: SelectionResult; schedule: WriteChunk[] } {
  if (!currentIndex) throw new Error('build the index first');
  const inSec = Number(inSecInput.value);
  const outSec = Number(outSecInput.value);
  const selection = selectSamples(currentIndex.tracks, inSec, outSec);
  const schedule = planWriteSchedule(selection.ranges);
  return { selection, schedule };
}

// --- 2. export ---
exportBtn.addEventListener('click', () => {
  void (async () => {
    if (!currentFile || !currentIndex) return;
    if (typeof window.showSaveFilePicker !== 'function') {
      elog('ERROR: showSaveFilePicker unavailable in this browser (Safari/Firefox -- expected per M0 findings).');
      return;
    }
    exportBtn.disabled = true;
    abortBtn.disabled = false;
    exportLog.textContent = '';
    clearTimingRecords();
    abortController = new AbortController();
    try {
      markStart('index-reuse'); // index already built; this just times selection+moov build
      const inSec = Number(inSecInput.value);
      const outSec = Number(outSecInput.value);
      const selection = selectSamples(currentIndex.tracks, inSec, outSec);
      elog(
        `requested [${selection.requestedInSec}, ${selection.requestedOutSec}] -> actual ` +
          `[${selection.actualInSec.toFixed(3)}, ${selection.actualOutSec.toFixed(3)}] shift=${selection.inShiftSec.toFixed(3)}s`,
      );

      const ftypBytes = await readFtyp(currentFile);
      markStart('moov-build');
      const built = buildMoov(currentIndex, selection, ftypBytes);
      const moovTiming = markEnd('moov-build');
      elog(
        `pass 1 (moov build, no media reads): ${moovTiming.durationMs.toFixed(1)}ms, ` +
          `ftyp+moov=${built.bytes.byteLength}B, mdatContentBytes=${built.mdatContentBytes} ` +
          `(${(built.mdatContentBytes / 1e6).toFixed(1)}MB), scheduledChunks=${built.schedule.length}`,
      );

      const handle = await window.showSaveFilePicker({
        suggestedName: `trim-${currentFile.name}`,
        types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
      });
      const writable = await handle.createWritable();

      let bytesWritten = 0;
      let sampleReads = 0;
      let windowReads = 0;
      let abortedFileState = 'completed';

      const memory = await sampleMemoryDuring(async () => {
        markStart('pass2-write');
        try {
          await writeChunk(writable, built.bytes);
          bytesWritten += built.bytes.byteLength;
          const mdatHeader = buildMdatHeader(built.mdatContentBytes);
          await writeChunk(writable, mdatHeader);
          bytesWritten += mdatHeader.byteLength;

          // Coalesced reads AND writes, batched per-window rather than per-sample: a first
          // version coalesced only reads but still called writable.write() once per sample
          // (~60k calls), and a real browser run only improved 37 -> 56.6MB/s -- writes were
          // still the dominant cost. Batching each window's needed sample bytes into one
          // concatenated buffer and writing that ONCE per window (not per sample) should get
          // much closer to the sweep's ~1230MB/s read-only number. A 1MB window was chosen from
          // the 256KB/1MB/4MB/16MB sweep as the best throughput-per-byte-of-waste point.
          const stats = await forEachWindowCoalesced(currentFile!, built.schedule, COALESCE_WINDOW_BYTES, async (bytes, sampleCount) => {
            if (abortController?.signal.aborted) throw new DOMException('export aborted', 'AbortError');
            await writeChunk(writable, bytes);
            bytesWritten += bytes.byteLength;
            sampleReads += sampleCount;
          });
          windowReads = stats.windowReads;
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            // Confirmed via a real aborted export (1620s mid-file range, aborted partway
            // through pass 2): FileSystemWritableFileStream buffers into a swap file and only
            // replaces the real target on close(); abort() discards that swap file instead.
            // showSaveFilePicker already reserved the target's directory entry when the picker
            // resolved, so the result isn't "no file at all" -- it's a real, unlocked, exactly
            // 0-byte file. Never truncated with partial content, regardless of how far into the
            // write the abort happens, since the transactional model discards ALL buffered
            // writes at once rather than flushing whatever had accumulated so far.
            abortedFileState = 'aborted -- FSA write is transactional: target left as a real, unlocked, 0-byte file (confirmed in browser), never truncated with partial content';
          } else {
            throw err;
          }
        } finally {
          if (abortedFileState !== 'completed') await writable.abort();
          else await writable.close();
        }
      }, 250);

      const pass2Timing = markEnd('pass2-write');
      const throughputMBps = bytesWritten / 1e6 / (pass2Timing.durationMs / 1000);
      elog(
        `pass 2 (streamed write): ${pass2Timing.durationMs.toFixed(0)}ms, wrote ${bytesWritten}B ` +
          `(${(bytesWritten / 1e6).toFixed(1)}MB), ${sampleReads} samples via ${windowReads} coalesced ` +
          `${(COALESCE_WINDOW_BYTES / 1e6).toFixed(1)}MB-window reads, ${throughputMBps.toFixed(1)} MB/s, status=${abortedFileState}`,
      );
      elog(`heap: before=${memory.before.bytes} peak=${memory.peak.bytes} after=${memory.after.bytes} method=${memory.method} consistent=${memory.consistent}`);

      elog('');
      elog('--- Step 4 validation ---');
      elog('1. Open the exported file in this browser (drag into a new tab) to confirm it plays.');
      elog('2. Also open it in VLC and QuickTime Player -- both should play cleanly with correct A/V sync.');
      elog(`3. Run: ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames,duration -of default "trim-${currentFile.name}"`);
      elog(
        `4. Reference: ffmpeg -y -ss ${selection.actualInSec} -to ${selection.actualOutSec} -i "${currentFile.name}" -map 0 -c copy ref.mp4` +
          ` -- then diff frame counts/durations/timescales against step 3's output (won't be byte-identical; should agree structurally).`,
      );
      for (const r of selection.ranges) {
        const firstT = localUnitsToPresentationSec(r.track, r.track.cts[r.startIdx]!);
        const lastT = localUnitsToPresentationSec(r.track, r.track.cts[r.endIdx]!);
        elog(`5. A/V sync check, track ${r.track.trackId} [${r.track.handlerType}]: first=${firstT.toFixed(4)}s last=${lastT.toFixed(4)}s`);
      }

      const result = buildResult({
        spike: 'A-remux',
        machine: 'local',
        fixture: currentFile.name,
        metrics: {
          requestedInSec: selection.requestedInSec,
          requestedOutSec: selection.requestedOutSec,
          actualInSec: selection.actualInSec,
          actualOutSec: selection.actualOutSec,
          inShiftSec: selection.inShiftSec,
          moovBuildMs: moovTiming.durationMs,
          pass2Ms: pass2Timing.durationMs,
          bytesWritten,
          throughputMBps,
          sampleReads,
          windowReads,
          coalesceWindowBytes: COALESCE_WINDOW_BYTES,
          memoryMethod: memory.method,
          memoryConsistent: memory.consistent,
          memoryBeforeBytes: memory.before.bytes,
          memoryPeakBytes: memory.peak.bytes,
          memoryAfterBytes: memory.after.bytes,
          memorySamples: memory.samples.length,
          abortedFileState,
          timings: getTimingRecords(),
        },
        notes: abortedFileState !== 'completed' ? `Aborted mid-export: ${abortedFileState}` : '',
      });
      recordResult(result);
      elog('result printed to console and downloaded as JSON.');
    } catch (err) {
      elog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      exportBtn.disabled = false;
      abortBtn.disabled = true;
      abortController = undefined;
    }
  })();
});

abortBtn.addEventListener('click', () => {
  abortController?.abort();
  elog('abort requested...');
});

// --- 3. source-read chunk-size sweep (Step 5): compare per-sample reads against coalesced
// fixed-size-window reads, since the source interleaves tracks far more finely than our
// output-side ~1s chunk grouping (confirmed against the 27GB fixture: a naive
// "copy [chunk.start, chunk.end)" range grabs huge amounts of unrelated bytes). ---
async function timePerSampleReads(file: File, schedule: WriteChunk[]): Promise<{ ms: number; bytes: number }> {
  const t0 = performance.now();
  let bytes = 0;
  for (const chunk of schedule) {
    for (let i = chunk.startIdx; i <= chunk.endIdx; i += 1) {
      const off = chunk.track.offset[i]!;
      const len = chunk.track.size[i]!;
      await file.slice(off, off + len).arrayBuffer();
      bytes += len;
    }
  }
  return { ms: performance.now() - t0, bytes };
}

/** Coalesces nearby per-sample reads into fixed-size windows -- shares the real export path's windowing logic (forEachWindowCoalesced) so the sweep measures exactly what export would do. */
async function timeCoalescedReads(file: File, schedule: WriteChunk[], windowBytes: number): Promise<{ ms: number; bytes: number; windowReads: number }> {
  const t0 = performance.now();
  const stats = await forEachWindowCoalesced(file, schedule, windowBytes, async () => {
    /* sweep only measures read throughput; nothing to do with the window's sliced bytes */
  });
  return { ms: performance.now() - t0, bytes: stats.windowBytesRead, windowReads: stats.windowReads };
}

sweepBtn.addEventListener('click', () => {
  void (async () => {
    if (!currentFile || !currentIndex) return;
    sweepBtn.disabled = true;
    sweepLog.textContent = '';
    try {
      const { schedule } = planSelectionAndSchedule();
      slog(`sweeping over ${schedule.length} scheduled chunks...`);

      const perSample = await timePerSampleReads(currentFile, schedule);
      slog(`per-sample reads: ${perSample.ms.toFixed(0)}ms, ${(perSample.bytes / 1e6 / (perSample.ms / 1000)).toFixed(1)} MB/s`);

      for (const windowBytes of [256 * 1024, 1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024]) {
        const r = await timeCoalescedReads(currentFile, schedule, windowBytes);
        slog(
          `coalesced ${(windowBytes / 1024 / 1024).toFixed(2)}MB window: ${r.ms.toFixed(0)}ms, ` +
            `${r.windowReads} reads, ${(r.bytes / 1e6 / (r.ms / 1000)).toFixed(1)} MB/s (reads ${(r.bytes / 1e6).toFixed(1)}MB incl. over-read waste)`,
        );
      }
    } catch (err) {
      slog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      sweepBtn.disabled = false;
    }
  })();
});
