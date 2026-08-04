// T0 -- locate the fixed export cost. See prompts/task-0-export-cost-prompt.md.
// Reuses spike A's remux code (mp4-index, select, remux-write) as-is; this file only adds
// six-stage timing around the same export path and a target-size/position range resolver so
// matrix points (10/50/200/500/1000/4000MB @ mid-file; 200MB @ 0/25/50/75%/last-frame) can be
// hit without hand-computing seconds.
import { clearTimingRecords, markStart, markEnd } from '../../measure/timing';
import { buildResult, recordResult } from '../../measure/record';
import { sampleMemoryDuring } from '../../measure/memory';
import { buildMp4Index, type Mp4Index } from '../A-remux/mp4-index';
import { selectSamples, type SelectionResult } from '../A-remux/select';
import {
  buildMoov,
  buildMoovMerged,
  buildMdatHeader,
  forEachWindowCoalesced,
  forEachWindowMerged,
  planWriteSchedule,
  type BuiltMoov,
  type WriteChunk,
} from '../A-remux/remux-write';
import type { SampleRange } from '../A-remux/select';

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
}
declare global {
  interface Window {
    showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  }
}

async function writeChunk(writable: FileSystemWritableFileStream, bytes: Uint8Array | ArrayBuffer): Promise<void> {
  await writable.write(bytes instanceof ArrayBuffer ? bytes : (bytes as Uint8Array<ArrayBuffer>));
}

const root = document.getElementById('app')!;
root.innerHTML = `
  <p><a href="/">&larr; all spikes</a></p>
  <h1>T0: locate the fixed export cost</h1>
  <p>Diagnosis only -- see <code>prompts/task-0-export-cost-prompt.md</code>. Times six stages of a
  real streamed export separately (picker, writable, pass1 moov build, moov write, mdat copy,
  close) so a fixed per-export toll can be attributed rather than guessed at.</p>
  <p>crossOriginIsolated: <strong>${crossOriginIsolated}</strong> |
     File System Access API: <strong>${typeof window.showSaveFilePicker === 'function'}</strong></p>

  <input type="file" id="file" accept="video/*,.mkv,.mp4" /><br /><br />
  <button id="buildIndex" disabled>1. Build index</button>
  <pre id="indexLog"></pre>

  <hr />
  <h2>range picker</h2>
  <label>preset:
    <select id="preset">
      <option value="floor">Phase 1 floor -- smallest valid output, position 0</option>
      <option value="matrixA">Matrix A point -- mid-file, custom size</option>
      <option value="matrixB-start">Matrix B -- 0% position, 200MB</option>
      <option value="matrixB-25">Matrix B -- 25% position, 200MB</option>
      <option value="matrixB-50">Matrix B -- 50% position, 200MB</option>
      <option value="matrixB-75">Matrix B -- 75% position, 200MB</option>
      <option value="matrixB-last">Matrix B -- last-frame range, 200MB</option>
      <option value="custom">custom position fraction + size</option>
    </select>
  </label><br /><br />
  <label>target size (MB): <input type="number" id="targetMB" value="200" step="0.1" /></label>
  <label>position fraction (0-1, ignored for floor/last-frame): <input type="number" id="posFrac" value="0.5" step="0.01" min="0" max="1" /></label>
  <label>run label (free text, e.g. "matrixA-200MB-rep1"): <input type="text" id="runLabel" value="" size="30" /></label><br /><br />
  <button id="resolveBtn" disabled>2. Resolve range</button>
  <pre id="resolveLog"></pre>

  <hr />
  <label><input type="checkbox" id="useMerged" /> use merged single-pass copy loop (item 3b -- off = original per-track path)</label><br /><br />
  <label>track selection (item 3d correctness re-validation):
    <select id="exportTrackMode">
      <option value="video+allaudio" selected>all tracks (normal export)</option>
      <option value="video">video only</option>
      <option value="audio1only">audio only (track 2, "mic only")</option>
    </select>
  </label><br /><br />
  <button id="exportBtn" disabled>3. Run measured export (6-stage timing)</button>
  <pre id="exportLog"></pre>

  <hr />
  <h2>runs this session</h2>
  <table id="runsTable" border="1" cellpadding="4" style="border-collapse: collapse; font: 12px monospace;">
    <thead>
      <tr>
        <th>label</th><th>targetMB</th><th>actualMB</th><th>in..out (s)</th>
        <th>picker</th><th>writable</th><th>pass1</th><th>moovwrite</th><th>copy</th><th>close</th>
        <th>total(excl picker)</th><th>MB/s</th>
      </tr>
    </thead>
    <tbody id="runsBody"></tbody>
  </table>

  <hr />
  <h2>Item 3a: read-amplification diagnostic (results/T0-FOLLOWUP.md)</h2>
  <p>Read-only -- doesn't write any output file. Runs the copy loop's exact windowing logic over a
  fixed [in, out] range with a chosen track subset, recording every window read's track/offset/size
  so the access pattern (per-track sweeps vs. interleaved thrashing) can be inspected directly.</p>
  <label>in (sec): <input type="number" id="diagInSec" value="2112.5" step="0.001" /></label>
  <label>out (sec): <input type="number" id="diagOutSec" value="2144.083" step="0.001" /></label><br /><br />
  <label>tracks:
    <select id="diagTrackMode">
      <option value="video">video only</option>
      <option value="video+1audio">video + 1 audio track</option>
      <option value="video+allaudio" selected>video + all audio tracks (default export)</option>
    </select>
  </label>
  <button id="diagBtn" disabled>Run read-pattern diagnostic</button>
  <pre id="diagLog"></pre>

  <hr />
  <p><em>Manual steps NOT automated here (see deliverable phases 3-4 in the prompt):</em></p>
  <ul>
    <li>H1: while an export with a large target size is running, watch the destination directory in
      Finder for a <code>.crswap</code> file (name, growth, disappearance on close).</li>
    <li>H2: pre-create target files of 0/200MB/4GB via <code>dd</code> and re-run "resolve range" +
      "run measured export" against each, pointing the save picker at that exact filename, to see if
      t_writable scales with existing file size.</li>
    <li>H3: run matrix A twice warm, then once after <code>sudo purge</code>, and diff t_copy.</li>
    <li>Phase 4 OPFS/Blob/ffmpeg baselines are not in this page.</li>
  </ul>
`;

const fileInput = root.querySelector<HTMLInputElement>('#file')!;
const buildIndexBtn = root.querySelector<HTMLButtonElement>('#buildIndex')!;
const indexLog = root.querySelector<HTMLPreElement>('#indexLog')!;
const presetSelect = root.querySelector<HTMLSelectElement>('#preset')!;
const targetMBInput = root.querySelector<HTMLInputElement>('#targetMB')!;
const posFracInput = root.querySelector<HTMLInputElement>('#posFrac')!;
const runLabelInput = root.querySelector<HTMLInputElement>('#runLabel')!;
const resolveBtn = root.querySelector<HTMLButtonElement>('#resolveBtn')!;
const resolveLog = root.querySelector<HTMLPreElement>('#resolveLog')!;
const exportBtn = root.querySelector<HTMLButtonElement>('#exportBtn')!;
const useMergedCheckbox = root.querySelector<HTMLInputElement>('#useMerged')!;
const exportTrackModeSelect = root.querySelector<HTMLSelectElement>('#exportTrackMode')!;
const exportLog = root.querySelector<HTMLPreElement>('#exportLog')!;
const runsBody = root.querySelector<HTMLTableSectionElement>('#runsBody')!;
const diagInSecInput = root.querySelector<HTMLInputElement>('#diagInSec')!;
const diagOutSecInput = root.querySelector<HTMLInputElement>('#diagOutSec')!;
const diagTrackModeSelect = root.querySelector<HTMLSelectElement>('#diagTrackMode')!;
const diagBtn = root.querySelector<HTMLButtonElement>('#diagBtn')!;
const diagLog = root.querySelector<HTMLPreElement>('#diagLog')!;

const ilog = (msg: string): void => {
  indexLog.textContent += `${msg}\n`;
};
const rlog = (msg: string): void => {
  resolveLog.textContent += `${msg}\n`;
};
const elog = (msg: string): void => {
  exportLog.textContent += `${msg}\n`;
};
const dlog = (msg: string): void => {
  diagLog.textContent += `${msg}\n`;
};

let currentFile: File | undefined;
let currentIndex: Mp4Index | undefined;
let currentFtyp: Uint8Array | undefined;
let resolvedRange: { inSec: number; outSec: number; actualBytes: number; label: string; targetBytes: number } | undefined;

fileInput.addEventListener('change', () => {
  currentFile = fileInput.files?.[0];
  currentIndex = undefined;
  currentFtyp = undefined;
  resolvedRange = undefined;
  buildIndexBtn.disabled = !currentFile;
  resolveBtn.disabled = true;
  exportBtn.disabled = true;
  diagBtn.disabled = true;
});

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
      currentFtyp = await readFtyp(currentFile);
      ilog(`moov: buildMs=${index.buildMs.toFixed(1)} (index build is NOT inside any of the six timed stages below -- H5)`);
      const totalSec = index.mvhdDuration / index.mvhdTimescale;
      ilog(`duration: ${totalSec.toFixed(3)}s across ${index.tracks.length} tracks`);
      for (const t of index.tracks) {
        ilog(`  track ${t.trackId} [${t.handlerType}]: samples=${t.sampleCount}`);
      }
      resolveBtn.disabled = false;
      diagBtn.disabled = false;
    } catch (err) {
      ilog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      buildIndexBtn.disabled = false;
    }
  })();
});

// --- range resolution: cheap because buildMoov (pass 1) never reads media bytes, only the
// index -- so we can binary-search toward a target mdat byte count by re-running it in a tight
// loop with no I/O cost. ---
function mdatBytesFor(index: Mp4Index, ftyp: Uint8Array, inSec: number, outSec: number): { bytes: number; selection: SelectionResult; built: BuiltMoov } {
  const selection = selectSamples(index.tracks, inSec, outSec);
  const built = buildMoov(index, selection, ftyp);
  return { bytes: built.mdatContentBytes, selection, built };
}

function resolveRangeForTarget(
  index: Mp4Index,
  ftyp: Uint8Array,
  opts: { targetBytes: number; positionFrac?: number; anchorToEnd?: boolean; log: (msg: string) => void },
): { inSec: number; outSec: number; actualBytes: number } {
  const totalSec = index.mvhdDuration / index.mvhdTimescale;
  const probe = mdatBytesFor(index, ftyp, 0, totalSec - 0.001);
  const avgBytesPerSec = probe.bytes / (totalSec - 0.001);
  opts.log(`whole-file avg byte rate (all tracks): ${(avgBytesPerSec / 1e6).toFixed(1)} MB/s of presentation time`);

  let inSec: number;
  let outSec: number;
  const durGuess = opts.targetBytes / avgBytesPerSec;
  if (opts.anchorToEnd) {
    outSec = totalSec - 0.001;
    inSec = Math.max(0, outSec - durGuess);
  } else {
    inSec = Math.max(0, Math.min(totalSec - 0.001, (opts.positionFrac ?? 0) * totalSec));
    outSec = Math.min(totalSec - 0.001, inSec + durGuess);
  }

  let bytes = 0;
  for (let iter = 0; iter < 6; iter += 1) {
    const r = mdatBytesFor(index, ftyp, inSec, outSec);
    bytes = r.bytes;
    if (bytes === 0) break;
    const ratio = opts.targetBytes / bytes;
    if (Math.abs(ratio - 1) < 0.02) break;
    const dur = outSec - inSec;
    if (opts.anchorToEnd) inSec = Math.max(0, outSec - dur * ratio);
    else outSec = Math.min(totalSec - 0.001, inSec + dur * ratio);
  }
  return { inSec, outSec, actualBytes: bytes };
}

function applyPreset(): void {
  const v = presetSelect.value;
  if (v === 'floor') {
    targetMBInput.value = '3';
    posFracInput.value = '0';
  } else if (v === 'matrixB-start') {
    targetMBInput.value = '200';
    posFracInput.value = '0';
  } else if (v === 'matrixB-25') {
    targetMBInput.value = '200';
    posFracInput.value = '0.25';
  } else if (v === 'matrixB-50' || v === 'matrixA') {
    targetMBInput.value = v === 'matrixA' ? targetMBInput.value : '200';
    posFracInput.value = '0.5';
  } else if (v === 'matrixB-75') {
    targetMBInput.value = '200';
    posFracInput.value = '0.75';
  }
  // matrixB-last and custom: leave fields as-is, user sets targetMB (and posFrac if custom)
}
// Applied on load too -- "floor" is the <select>'s first (default-selected) option, so without
// this the shown target/position fields silently stay at the raw HTML defaults (200MB/0.5) until
// the user manually changes the dropdown, producing a run mislabeled "floor" that's actually a
// matrixA/B-50-style 200MB mid-file point (bit us once: resolved range came out at [2112s,2144s]
// on a ~4226s-duration fixture instead of a few-MB clip at position 0).
applyPreset();
presetSelect.addEventListener('change', applyPreset);

resolveBtn.addEventListener('click', () => {
  if (!currentIndex || !currentFtyp) return;
  resolveLog.textContent = '';
  exportBtn.disabled = true;
  try {
    const targetBytes = Number(targetMBInput.value) * 1e6;
    const preset = presetSelect.value;
    const anchorToEnd = preset === 'matrixB-last';
    const positionFrac = anchorToEnd ? undefined : Number(posFracInput.value);
    const label = runLabelInput.value.trim() || preset;

    const { inSec, outSec, actualBytes } = resolveRangeForTarget(currentIndex, currentFtyp, {
      targetBytes,
      positionFrac,
      anchorToEnd,
      log: rlog,
    });
    resolvedRange = { inSec, outSec, actualBytes, label, targetBytes };
    rlog(
      `resolved: [${inSec.toFixed(3)}, ${outSec.toFixed(3)}]s -> mdat ${(actualBytes / 1e6).toFixed(1)}MB ` +
        `(target ${(targetBytes / 1e6).toFixed(1)}MB, off by ${(((actualBytes - targetBytes) / targetBytes) * 100).toFixed(1)}%)`,
    );
    exportBtn.disabled = false;
  } catch (err) {
    rlog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// --- 3. six-stage measured export ---
function addRunRow(fields: {
  label: string;
  targetMB: number;
  actualMB: number;
  inOut: string;
  t: { picker: number; writable: number; pass1: number; moovwrite: number; copy: number; close: number };
  totalMs: number;
  mbps: number;
}): void {
  const row = document.createElement('tr');
  const cells = [
    fields.label,
    fields.targetMB.toFixed(1),
    fields.actualMB.toFixed(1),
    fields.inOut,
    fields.t.picker.toFixed(0),
    fields.t.writable.toFixed(0),
    fields.t.pass1.toFixed(0),
    fields.t.moovwrite.toFixed(0),
    fields.t.copy.toFixed(0),
    fields.t.close.toFixed(0),
    fields.totalMs.toFixed(0),
    fields.mbps.toFixed(1),
  ];
  for (const c of cells) {
    const td = document.createElement('td');
    td.textContent = c;
    row.appendChild(td);
  }
  runsBody.appendChild(row);
}

function filterRangesByTrackMode(ranges: SampleRange[], mode: string): SampleRange[] {
  const video = ranges.find((r) => r.track.handlerType === 'vide');
  if (mode === 'video') {
    if (!video) throw new Error('no video range in selection');
    return [video];
  }
  const audio = ranges.filter((r) => r.track.handlerType !== 'vide');
  if (mode === 'video+1audio') {
    if (!video) throw new Error('no video range in selection');
    return audio.length > 0 ? [video, audio[0]!] : [video];
  }
  if (mode === 'audio1only') {
    if (audio.length === 0) throw new Error('no audio range in selection');
    return [audio[0]!];
  }
  return ranges; // video+allaudio: everything selectSamples found
}

exportBtn.addEventListener('click', () => {
  void (async () => {
    if (!currentFile || !currentIndex || !currentFtyp || !resolvedRange) return;
    if (typeof window.showSaveFilePicker !== 'function') {
      elog('ERROR: showSaveFilePicker unavailable in this browser.');
      return;
    }
    exportBtn.disabled = true;
    exportLog.textContent = '';
    clearTimingRecords();
    const { inSec, outSec, label, targetBytes } = resolvedRange;

    try {
      const useMerged = useMergedCheckbox.checked;
      const trackMode = exportTrackModeSelect.value;
      const fullSelection = selectSamples(currentIndex.tracks, inSec, outSec);
      const selection: SelectionResult = { ...fullSelection, ranges: filterRangesByTrackMode(fullSelection.ranges, trackMode) };
      elog(`requested [${inSec.toFixed(3)}, ${outSec.toFixed(3)}] -> actual [${selection.actualInSec.toFixed(3)}, ${selection.actualOutSec.toFixed(3)}] (copy path: ${useMerged ? 'MERGED (item 3b)' : 'original per-track'}, tracks: ${trackMode})`);
      elog(`selected tracks: [${selection.ranges.map((r) => `${r.track.trackId}:${r.track.handlerType}`).join(', ')}]`);

      markStart('t_picker');
      const handle = await window.showSaveFilePicker({
        suggestedName: `t0-${label}-${currentFile.name}`,
        types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
      });
      const tPicker = markEnd('t_picker');

      markStart('t_writable');
      const writable = await handle.createWritable();
      const tWritable = markEnd('t_writable');

      markStart('t_pass1');
      const built = useMerged ? buildMoovMerged(currentIndex, selection, currentFtyp) : buildMoov(currentIndex, selection, currentFtyp);
      const tPass1 = markEnd('t_pass1');

      let bytesWritten = 0;
      let sampleReads = 0;
      let stats = { windowReads: 0, windowBytesRead: 0 };
      let tMoovwrite = { durationMs: 0 };
      let tCopy = { durationMs: 0 };

      const memory = await sampleMemoryDuring(async () => {
        markStart('t_moovwrite');
        await writeChunk(writable, built.bytes);
        bytesWritten += built.bytes.byteLength;
        const mdatHeader = buildMdatHeader(built.mdatContentBytes);
        await writeChunk(writable, mdatHeader);
        bytesWritten += mdatHeader.byteLength;
        tMoovwrite = markEnd('t_moovwrite');

        markStart('t_copy');
        const onWindow = async (bytes: Uint8Array, sampleCount: number): Promise<void> => {
          await writeChunk(writable, bytes);
          bytesWritten += bytes.byteLength;
          sampleReads += sampleCount;
        };
        stats = useMerged
          ? await forEachWindowMerged(currentFile!, selection.ranges, 4 * 1024 * 1024, onWindow)
          : await forEachWindowCoalesced(currentFile!, built.schedule, 4 * 1024 * 1024, onWindow);
        tCopy = markEnd('t_copy');
      }, 250);

      markStart('t_close');
      await writable.close();
      const tClose = markEnd('t_close');

      const t = {
        picker: tPicker.durationMs,
        writable: tWritable.durationMs,
        pass1: tPass1.durationMs,
        moovwrite: tMoovwrite.durationMs,
        copy: tCopy.durationMs,
        close: tClose.durationMs,
      };
      const totalExclPicker = t.writable + t.pass1 + t.moovwrite + t.copy + t.close;
      const totalInclPicker = totalExclPicker + t.picker;
      const mbps = bytesWritten / 1e6 / (totalExclPicker / 1000);

      elog('');
      elog(`--- six-stage breakdown (label=${label}) ---`);
      for (const [name, ms] of Object.entries(t)) {
        const pctOfExclPicker = name === 'picker' ? NaN : (ms / totalExclPicker) * 100;
        elog(`  t_${name}: ${ms.toFixed(1)}ms${Number.isNaN(pctOfExclPicker) ? ' (human interaction time, excluded from total)' : ` (${pctOfExclPicker.toFixed(1)}% of total excl. picker)`}`);
      }
      elog(`  total excl. picker: ${totalExclPicker.toFixed(1)}ms | incl. picker: ${totalInclPicker.toFixed(1)}ms`);
      elog(`  bytesWritten=${bytesWritten} (${(bytesWritten / 1e6).toFixed(1)}MB), throughput=${mbps.toFixed(1)}MB/s`);
      elog(`  reads: ${sampleReads} samples via ${stats.windowReads} coalesced 4MB-window reads, ${(stats.windowBytesRead / 1e6).toFixed(1)}MB read incl. over-read waste`);
      elog(`  amplification: ${(stats.windowBytesRead / bytesWritten).toFixed(2)}x (bytes read / bytes written)`);
      elog(`  heap: before=${memory.before.bytes} peak=${memory.peak.bytes} after=${memory.after.bytes} method=${memory.method} consistent=${memory.consistent}`);

      addRunRow({
        label,
        targetMB: targetBytes / 1e6,
        actualMB: bytesWritten / 1e6,
        inOut: `${selection.actualInSec.toFixed(1)}..${selection.actualOutSec.toFixed(1)}`,
        t,
        totalMs: totalExclPicker,
        mbps,
      });

      const result = buildResult({
        spike: 'T0-exportcost',
        machine: 'local',
        fixture: currentFile.name,
        metrics: {
          runLabel: label,
          copyPath: useMerged ? 'merged' : 'original',
          requestedInSec: inSec,
          requestedOutSec: outSec,
          actualInSec: selection.actualInSec,
          actualOutSec: selection.actualOutSec,
          targetBytes,
          bytesWritten,
          throughputMBps: mbps,
          sampleReads,
          windowReads: stats.windowReads,
          windowBytesRead: stats.windowBytesRead,
          amplification: stats.windowBytesRead / bytesWritten,
          coalesceWindowBytes: 4 * 1024 * 1024,
          t_picker_ms: t.picker,
          t_writable_ms: t.writable,
          t_pass1_ms: t.pass1,
          t_moovwrite_ms: t.moovwrite,
          t_copy_ms: t.copy,
          t_close_ms: t.close,
          totalMsExclPicker: totalExclPicker,
          totalMsInclPicker: totalInclPicker,
          memoryMethod: memory.method,
          memoryConsistent: memory.consistent,
          memoryBeforeBytes: memory.before.bytes,
          memoryPeakBytes: memory.peak.bytes,
          memoryAfterBytes: memory.after.bytes,
        },
        notes: '',
      });
      recordResult(result);
      elog('result printed to console and downloaded as JSON.');
    } catch (err) {
      elog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      exportBtn.disabled = false;
    }
  })();
});

// --- Item 3a: read-pattern diagnostic (T0-FOLLOWUP.md). Read-only, mirrors
// forEachWindowCoalesced's exact windowing logic (remux-write.ts) so the access pattern matches
// what a real export does, but also records per-read {trackId, offset, bytes} so the pattern can
// be inspected: per-track full sweeps (trackId changes rarely) vs. round-robin/thrashing
// (trackId changes almost every read). Doesn't write any output -- diagnostic only. ---
interface DiagReadEvent {
  trackId: number;
  handlerType: string;
  offset: number;
  bytes: number;
}

async function instrumentedCoalescedRead(file: File, chunks: WriteChunk[], windowBytes: number): Promise<DiagReadEvent[]> {
  const events: DiagReadEvent[] = [];
  for (const chunk of chunks) {
    const { track } = chunk;
    let i = chunk.startIdx;
    while (i <= chunk.endIdx) {
      const windowStart = track.offset[i]!;
      let windowEnd = windowStart;
      let j = i;
      while (j <= chunk.endIdx && track.offset[j]! + track.size[j]! - windowStart <= windowBytes) {
        windowEnd = track.offset[j]! + track.size[j]!;
        j += 1;
      }
      if (j === i) {
        windowEnd = track.offset[i]! + track.size[i]!;
        j = i + 1;
      }
      await file.slice(windowStart, windowEnd).arrayBuffer();
      events.push({ trackId: track.trackId, handlerType: track.handlerType, offset: windowStart, bytes: windowEnd - windowStart });
      i = j;
    }
  }
  return events;
}

diagBtn.addEventListener('click', () => {
  void (async () => {
    if (!currentFile || !currentIndex) return;
    diagBtn.disabled = true;
    diagLog.textContent = '';
    try {
      const inSec = Number(diagInSecInput.value);
      const outSec = Number(diagOutSecInput.value);
      const mode = diagTrackModeSelect.value;
      const selection = selectSamples(currentIndex.tracks, inSec, outSec);
      const filteredRanges = filterRangesByTrackMode(selection.ranges, mode);
      dlog(`mode=${mode}, tracks=[${filteredRanges.map((r) => `${r.track.trackId}:${r.track.handlerType}`).join(', ')}]`);

      let outputBytes = 0;
      for (const r of filteredRanges) {
        for (let i = r.startIdx; i <= r.endIdx; i += 1) outputBytes += r.track.size[i]!;
      }

      const schedule = planWriteSchedule(filteredRanges);
      const t0 = performance.now();
      const events = await instrumentedCoalescedRead(currentFile, schedule, 4 * 1024 * 1024);
      const ms = performance.now() - t0;

      const totalBytesRead = events.reduce((a, e) => a + e.bytes, 0);
      const sizes = events.map((e) => e.bytes).sort((a, b) => a - b);
      const mean = totalBytesRead / events.length;
      const median = sizes[Math.floor(sizes.length / 2)] ?? 0;

      const perTrack = new Map<number, { handlerType: string; reads: number; bytes: number }>();
      for (const e of events) {
        const cur = perTrack.get(e.trackId) ?? { handlerType: e.handlerType, reads: 0, bytes: 0 };
        cur.reads += 1;
        cur.bytes += e.bytes;
        perTrack.set(e.trackId, cur);
      }

      let trackSwitches = 0;
      for (let i = 1; i < events.length; i += 1) if (events[i]!.trackId !== events[i - 1]!.trackId) trackSwitches += 1;

      dlog(`output bytes (useful, this track selection): ${outputBytes} (${(outputBytes / 1e6).toFixed(1)}MB)`);
      dlog(`total reads: ${events.length}, total bytes read: ${totalBytesRead} (${(totalBytesRead / 1e6).toFixed(1)}MB)`);
      dlog(`amplification (bytes read / useful output bytes): ${(totalBytesRead / outputBytes).toFixed(2)}x`);
      dlog(`mean read size: ${(mean / 1024).toFixed(1)}KB, median: ${(median / 1024).toFixed(1)}KB`);
      dlog(`wall time: ${ms.toFixed(0)}ms`);
      dlog(`track switches between consecutive reads: ${trackSwitches} (out of ${events.length - 1} transitions) -- ${trackSwitches > events.length * 0.5 ? 'HIGH: looks like round-robin/thrashing, not per-track sweeps' : 'LOW: looks like per-track sweeps'}`);
      dlog('per-track breakdown:');
      for (const [trackId, v] of perTrack) {
        dlog(`  track ${trackId} [${v.handlerType}]: ${v.reads} reads, ${v.bytes} bytes (${(v.bytes / 1e6).toFixed(1)}MB)`);
      }
      dlog('first 20 reads (trackId @ offset, bytes):');
      for (const e of events.slice(0, 20)) {
        dlog(`  track ${e.trackId} @ ${e.offset.toFixed(0)}, ${e.bytes}B`);
      }

      const result = buildResult({
        spike: 'T0-readamp-diag',
        machine: 'local',
        fixture: currentFile.name,
        metrics: {
          mode,
          inSec,
          outSec,
          outputBytes,
          totalBytesRead,
          amplification: totalBytesRead / outputBytes,
          totalReads: events.length,
          meanReadBytes: mean,
          medianReadBytes: median,
          trackSwitches,
          wallMs: ms,
          perTrack: Object.fromEntries([...perTrack.entries()].map(([k, v]) => [k, v])),
        },
        notes: 'read-only diagnostic, no output written',
      });
      recordResult(result);
      dlog('result printed to console and downloaded as JSON.');
    } catch (err) {
      dlog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      diagBtn.disabled = false;
    }
  })();
});
