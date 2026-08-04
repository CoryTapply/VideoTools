// Spike B -- sample index at scale. See prompts/m0.5-spike-prompts.md.
import { BlobSource } from 'mediabunny';
import { sampleMemoryDuring } from '../../measure/memory';
import { buildMp4Index, type Mp4Index, type StageTimings } from '../A-remux/mp4-index';
import { checkCorrectness } from './mediabunny-check';
import { runQueryBenchmarks } from './queries';
import { benchTransferables, benchSharedArrayBuffer } from './worker-transfer';
import { reportVfr } from './vfr-report';
import { persistAndReload } from './opfs-persist';

const root = document.getElementById('app')!;
root.innerHTML = `
  <p><a href="/">&larr; all spikes</a></p>
  <h1>spike B: sample index at scale</h1>
  <p>Reuses spike A's index builder (src/spikes/A-remux/mp4-index.ts). See
  <code>prompts/m0.5-spike-prompts.md</code> for the full spec.</p>

  <input type="file" id="file" accept="video/*,.mkv,.mp4" /><br /><br />
  <button id="buildIndex" disabled>1. Build index</button>
  <pre id="indexLog"></pre>

  <hr />
  <label>random samples to byte-check per track: <input type="number" id="randomCount" value="1000" /></label><br />
  <label><input type="checkbox" id="useStreamReader" />
    BlobSource useStreamReader (OFF by default -- confirmed on the 27GB fixture in Chrome:
    the default true path grows tab memory to 3.2GB immediately and 9GB ~30s after the
    operation visibly finishes, vs. false's 600MB peak returning to baseline with nothing
    delayed, AND ~28% faster. Check this box only to reproduce/compare against the bug.)
  </label><br /><br />
  <button id="correctnessBtn" disabled>2. Correctness cross-check vs mediabunny</button>
  <pre id="correctnessLog"></pre>

  <hr />
  <button id="scaleBtn" disabled>3. Scale test (stage timing, heap, disk bytes read)</button>
  <pre id="scaleLog"></pre>

  <hr />
  <label>iterations per query: <input type="number" id="queryIterations" value="10000" /></label><br /><br />
  <button id="queryBtn" disabled>4. Query latency (binary search etc.)</button>
  <pre id="queryLog"></pre>

  <hr />
  <button id="workerBtn" disabled>5. Worker transfer (transferables vs SharedArrayBuffer)</button>
  <pre id="workerLog"></pre>

  <hr />
  <button id="vfrBtn" disabled>6. VFR report (video track)</button>
  <pre id="vfrLog"></pre>

  <hr />
  <button id="opfsBtn" disabled>7. OPFS persistence (write, read back, compare vs. rebuild)</button>
  <pre id="opfsLog"></pre>
`;

const fileInput = root.querySelector<HTMLInputElement>('#file')!;
const buildIndexBtn = root.querySelector<HTMLButtonElement>('#buildIndex')!;
const indexLog = root.querySelector<HTMLPreElement>('#indexLog')!;
const randomCountInput = root.querySelector<HTMLInputElement>('#randomCount')!;
const correctnessBtn = root.querySelector<HTMLButtonElement>('#correctnessBtn')!;
const useStreamReaderInput = root.querySelector<HTMLInputElement>('#useStreamReader')!;
const correctnessLog = root.querySelector<HTMLPreElement>('#correctnessLog')!;
const scaleBtn = root.querySelector<HTMLButtonElement>('#scaleBtn')!;
const scaleLog = root.querySelector<HTMLPreElement>('#scaleLog')!;
const queryIterationsInput = root.querySelector<HTMLInputElement>('#queryIterations')!;
const queryBtn = root.querySelector<HTMLButtonElement>('#queryBtn')!;
const queryLog = root.querySelector<HTMLPreElement>('#queryLog')!;
const workerBtn = root.querySelector<HTMLButtonElement>('#workerBtn')!;
const workerLog = root.querySelector<HTMLPreElement>('#workerLog')!;
const vfrBtn = root.querySelector<HTMLButtonElement>('#vfrBtn')!;
const vfrLog = root.querySelector<HTMLPreElement>('#vfrLog')!;
const opfsBtn = root.querySelector<HTMLButtonElement>('#opfsBtn')!;
const opfsLog = root.querySelector<HTMLPreElement>('#opfsLog')!;

const ilog = (msg: string): void => {
  indexLog.textContent += `${msg}\n`;
};
const clog = (msg: string): void => {
  correctnessLog.textContent += `${msg}\n`;
};
const slog = (msg: string): void => {
  scaleLog.textContent += `${msg}\n`;
};
const qlog = (msg: string): void => {
  queryLog.textContent += `${msg}\n`;
};
const wlog = (msg: string): void => {
  workerLog.textContent += `${msg}\n`;
};
const vlog = (msg: string): void => {
  vfrLog.textContent += `${msg}\n`;
};
const olog = (msg: string): void => {
  opfsLog.textContent += `${msg}\n`;
};

let currentFile: File | undefined;
let currentIndex: Mp4Index | undefined;

fileInput.addEventListener('change', () => {
  currentFile = fileInput.files?.[0];
  currentIndex = undefined;
  buildIndexBtn.disabled = !currentFile;
  correctnessBtn.disabled = true;
  scaleBtn.disabled = true;
  queryBtn.disabled = true;
  workerBtn.disabled = true;
  vfrBtn.disabled = true;
  opfsBtn.disabled = true;
});

// --- 1. build index ---
buildIndexBtn.addEventListener('click', () => {
  void (async () => {
    if (!currentFile) return;
    buildIndexBtn.disabled = true;
    indexLog.textContent = '';
    try {
      const index = await buildMp4Index(currentFile);
      currentIndex = index;
      ilog(`moov: buildMs=${index.buildMs.toFixed(1)} retainedBytes=${index.retainedBytes} (${(index.retainedBytes / 1e6).toFixed(2)}MB)`);
      for (const t of index.tracks) {
        ilog(`track ${t.trackId} [${t.handlerType}]: samples=${t.sampleCount} editList=${t.editList ? JSON.stringify(t.editList) : 'none'}`);
      }
      correctnessBtn.disabled = false;
      scaleBtn.disabled = false;
      queryBtn.disabled = false;
      workerBtn.disabled = false;
      vfrBtn.disabled = false;
      opfsBtn.disabled = false;
    } catch (err) {
      ilog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      buildIndexBtn.disabled = false;
    }
  })();
});

// --- 2. correctness cross-check vs mediabunny ---
correctnessBtn.addEventListener('click', () => {
  void (async () => {
    if (!currentFile || !currentIndex) return;
    correctnessBtn.disabled = true;
    correctnessLog.textContent = '';
    try {
      const randomSampleCount = Number(randomCountInput.value) || 1000;
      clog(`cross-checking ${currentIndex.tracks.length} tracks against mediabunny (${randomSampleCount} random byte-checks/track)...`);
      const useStreamReader = useStreamReaderInput.checked;
      clog(`BlobSource useStreamReader=${useStreamReader}`);
      const report = await checkCorrectness(currentIndex, new BlobSource(currentFile, { useStreamReader }), currentFile, randomSampleCount);
      clog(`\ndone in ${report.elapsedMs.toFixed(0)}ms`);
      clog(`per-track sample counts: ${JSON.stringify(report.perTrackSampleCounts)}`);
      clog(`full metadata samples checked: ${report.fullMetadataSamplesChecked}`);
      clog(`byte comparisons checked: ${report.byteComparisonsChecked}`);
      clog(`keyframes checked: ${report.keyframesChecked}`);
      if (report.tracksSkippedForScale.length > 0) {
        clog(`skipped for scale: ${JSON.stringify(report.tracksSkippedForScale)}`);
      }
      clog(`MISMATCHES: ${report.mismatches.length}`);
      if (report.mismatches.length > 0) {
        clog(JSON.stringify(report.mismatches.slice(0, 50), null, 2));
        if (report.mismatches.length > 50) clog(`... and ${report.mismatches.length - 50} more (see console for all, printed live during the check)`);
      }
    } catch (err) {
      clog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      correctnessBtn.disabled = false;
    }
  })();
});

// --- 3. scale test: stage timing, peak/retained heap, retained bytes, disk bytes read ---

/** Wraps a File to count bytes requested via slice(), without changing what's actually read. */
function countingFile(file: File): { file: File; bytesRead: () => number } {
  let bytesRead = 0;
  const wrapper = {
    size: file.size,
    type: file.type,
    slice(start?: number, end?: number, contentType?: string) {
      const s = start ?? 0;
      const e = end ?? file.size;
      bytesRead += e - s;
      return file.slice(s, e, contentType);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { file: wrapper as any, bytesRead: () => bytesRead };
}

scaleBtn.addEventListener('click', () => {
  void (async () => {
    if (!currentFile) return;
    scaleBtn.disabled = true;
    scaleLog.textContent = '';
    try {
      const stageTimings: StageTimings = { sttsMs: 0, cttsMs: 0, stszMs: 0, stscStcoMs: 0 };
      const { file: tracked, bytesRead } = countingFile(currentFile);

      let built: Mp4Index | undefined;
      const memory = await sampleMemoryDuring(async () => {
        built = await buildMp4Index(tracked, stageTimings);
      }, 50);

      const index = built!;
      slog(`build: ${index.buildMs.toFixed(1)}ms total`);
      slog(`  stts: ${stageTimings.sttsMs.toFixed(1)}ms`);
      slog(`  ctts: ${stageTimings.cttsMs.toFixed(1)}ms`);
      slog(`  stsz: ${stageTimings.stszMs.toFixed(1)}ms`);
      slog(`  stsc+stco offset walk: ${stageTimings.stscStcoMs.toFixed(1)}ms`);
      const accountedMs = stageTimings.sttsMs + stageTimings.cttsMs + stageTimings.stszMs + stageTimings.stscStcoMs;
      slog(`  (unaccounted -- box finding, raw byte capture, mvhd/tkhd/mdhd/hdlr parse, etc.: ${(index.buildMs - accountedMs).toFixed(1)}ms)`);

      slog(`\nbytes read from disk during build: ${bytesRead()} (${(bytesRead() / 1e6).toFixed(2)}MB) vs. moov size ${index.moovSize} (${(index.moovSize / 1e6).toFixed(2)}MB)`);
      slog(`  -- should be close to moovSize: we buffer moov once, then never touch mdat`);

      slog(`\nretained bytes (typed arrays): ${index.retainedBytes} (${(index.retainedBytes / 1e6).toFixed(2)}MB)`);
      slog(`heap: before=${memory.before.bytes} peak=${memory.peak.bytes} after=${memory.after.bytes} method=${memory.method} consistent=${memory.consistent}`);

      const totalSamples = index.tracks.reduce((sum, t) => sum + t.sampleCount, 0);
      slog(`\ntotal samples across ${index.tracks.length} tracks: ${totalSamples}`);
      const bytesPerSample = index.retainedBytes / totalSamples;
      const msPerSample = index.buildMs / totalSamples;
      const extrapolatedSamples = 1.7e6; // spec's 8hr/60fps estimate
      const extrapolatedBytes = bytesPerSample * extrapolatedSamples;
      const extrapolatedMs = msPerSample * extrapolatedSamples;
      slog(
        `extrapolated to an 8hr/60fps recording (~${extrapolatedSamples.toExponential(1)} samples, linear scaling from this file's ` +
          `${(bytesPerSample).toFixed(1)}B/sample, ${(msPerSample * 1000).toFixed(2)}µs/sample): ` +
          `${(extrapolatedBytes / 1e6).toFixed(0)}MB retained, ${(extrapolatedMs / 1000).toFixed(2)}s build time`,
      );
      const dominantStage = (['stts', 'ctts', 'stsz', 'stsc+stco'] as const)[
        [stageTimings.sttsMs, stageTimings.cttsMs, stageTimings.stszMs, stageTimings.stscStcoMs].reduce(
          (best, v, i, arr) => (v > arr[best]! ? i : best),
          0,
        )
      ];
      slog(`dominant stage in this build: ${dominantStage}`);
    } catch (err) {
      slog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      scaleBtn.disabled = false;
    }
  })();
});

// --- 4. query latency: binary search (frame-at-timestamp, nearest sync sample), O(1)
// frame-stepping and byte-range lookups. Run against the video track (the interesting case --
// it has real B-frame reordering, confirmed on the 27GB fixture: cts is NOT monotonic in decode
// order, so binary search needs the presentation-order index queries.ts builds). Fail condition
// per spec: any query above ~1 microsecond -- these need to run inside a pointermove handler.
queryBtn.addEventListener('click', () => {
  void (async () => {
    if (!currentIndex) return;
    queryBtn.disabled = true;
    queryLog.textContent = '';
    try {
      const videoTrack = currentIndex.tracks.find((t) => t.handlerType === 'vide');
      if (!videoTrack) {
        qlog('no video track found');
        return;
      }
      const iterations = Number(queryIterationsInput.value) || 10_000;
      const nonMonotonic = videoTrack.cts.slice(0, 20).some((c, i) => i > 0 && c < videoTrack.cts[i - 1]!);
      qlog(`video track: ${videoTrack.sampleCount} samples, cts non-monotonic in first 20 decode-order samples: ${nonMonotonic}`);

      const { queryIndexBuildMs, results } = runQueryBenchmarks(videoTrack, iterations);
      qlog(`query index build (one-time, not part of per-query cost): ${queryIndexBuildMs.toFixed(2)}ms`);
      for (const r of results) {
        const status = r.nsPerOp > 1000 ? 'FAIL (>1us)' : 'ok';
        qlog(`  ${r.name}: ${r.nsPerOp.toFixed(1)}ns/op over ${r.iterations} iterations (${status})`);
      }
    } catch (err) {
      qlog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      queryBtn.disabled = false;
    }
  })();
});

// --- 5. worker transfer: transferables (zero-copy, single owner) vs SharedArrayBuffer (not
// zero-copy to set up, but the same memory can go to multiple workers at once). Run against the
// video track (largest typed arrays of the 7, so the most representative timing). ---
workerBtn.addEventListener('click', () => {
  void (async () => {
    if (!currentIndex) return;
    workerBtn.disabled = true;
    workerLog.textContent = '';
    try {
      const videoTrack = currentIndex.tracks.find((t) => t.handlerType === 'vide');
      if (!videoTrack) {
        wlog('no video track found');
        return;
      }
      wlog(`video track: ${videoTrack.sampleCount} samples`);

      const xfer = await benchTransferables(videoTrack);
      wlog(`\ntransferables: ${xfer.ms.toFixed(2)}ms, zero-copy confirmed=${xfer.zeroCopyConfirmed} (source buffers detached to byteLength 0)`);
      wlog(`  worker checksum=${xfer.reply.checksum}, received byte lengths=${JSON.stringify(xfer.reply.receivedByteLengths)}`);

      const sab = await benchSharedArrayBuffer(videoTrack);
      wlog(`\nSharedArrayBuffer (posted to 2 workers concurrently): ${sab.ms.toFixed(2)}ms`);
      wlog(`  worker A checksum=${sab.reply.checksum}, worker B checksum=${sab.secondWorkerReply.checksum} (equal confirms both read the SAME memory: ${sab.reply.checksum === sab.secondWorkerReply.checksum})`);
    } catch (err) {
      wlog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      workerBtn.disabled = false;
    }
  })();
});

// --- 6. VFR report: is it safe to assume a fixed frame rate? (spec: "no" for vfr-screen.mp4) ---
vfrBtn.addEventListener('click', () => {
  if (!currentIndex) return;
  vfrLog.textContent = '';
  try {
    const videoTrack = currentIndex.tracks.find((t) => t.handlerType === 'vide');
    if (!videoTrack) {
      vlog('no video track found');
      return;
    }
    const report = reportVfr(videoTrack);
    vlog(`samples: ${report.sampleCount}`);
    vlog(`constant duration: ${report.constant} (${report.distinctDurationCount} distinct durations seen)`);
    vlog(`min/median/max duration: ${(report.minDurationSec * 1000).toFixed(2)}ms / ${(report.medianDurationSec * 1000).toFixed(2)}ms / ${(report.maxDurationSec * 1000).toFixed(2)}ms`);
    vlog(`implied nominal fps (from most common duration): ${report.impliedNominalFps.toFixed(2)}`);
    vlog(`true average fps (samples / total duration): ${report.averageFps.toFixed(2)}`);
    const gapPct = (100 * Math.abs(report.impliedNominalFps - report.averageFps)) / report.impliedNominalFps;
    vlog(`gap between naive nominal-fps assumption and reality: ${gapPct.toFixed(1)}%`);
  } catch (err) {
    vlog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// --- 7. OPFS persistence: write the video track's index to OPFS, read it back, and compare
// against the cost of just rebuilding from the source file. Determines whether index caching
// is worth building in M1. ---
opfsBtn.addEventListener('click', () => {
  void (async () => {
    if (!currentFile || !currentIndex) return;
    opfsBtn.disabled = true;
    opfsLog.textContent = '';
    try {
      const videoTrack = currentIndex.tracks.find((t) => t.handlerType === 'vide');
      if (!videoTrack) {
        olog('no video track found');
        return;
      }
      olog(`video track: ${videoTrack.sampleCount} samples`);

      const persisted = await persistAndReload(videoTrack);
      olog(`\nOPFS write: ${persisted.writeMs.toFixed(2)}ms for ${persisted.bytesWritten} bytes (${(persisted.bytesWritten / 1e6).toFixed(2)}MB)`);
      olog(`OPFS read + deserialize: ${persisted.readMs.toFixed(2)}ms`);
      olog(`round-trip byte-exact match against the in-memory index: ${persisted.roundTripCorrect}`);

      const t0 = performance.now();
      await buildMp4Index(currentFile);
      const rebuildMs = performance.now() - t0;
      olog(`\nrebuild from source file (fresh buildMp4Index call): ${rebuildMs.toFixed(2)}ms`);
      olog(`OPFS read vs. rebuild: ${persisted.readMs < rebuildMs ? 'OPFS read is faster' : 'rebuilding is faster (or comparable)'} (${persisted.readMs.toFixed(2)}ms vs ${rebuildMs.toFixed(2)}ms)`);
    } catch (err) {
      olog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      opfsBtn.disabled = false;
    }
  })();
});
