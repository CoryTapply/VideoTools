// Spike B -- sample index at scale. See prompts/m0.5-spike-prompts.md.
import { BlobSource } from 'mediabunny';
import { sampleMemoryDuring } from '../../measure/memory';
import { buildMp4Index, type Mp4Index, type StageTimings } from '../A-remux/mp4-index';
import { checkCorrectness } from './mediabunny-check';

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

const ilog = (msg: string): void => {
  indexLog.textContent += `${msg}\n`;
};
const clog = (msg: string): void => {
  correctnessLog.textContent += `${msg}\n`;
};
const slog = (msg: string): void => {
  scaleLog.textContent += `${msg}\n`;
};

let currentFile: File | undefined;
let currentIndex: Mp4Index | undefined;

fileInput.addEventListener('change', () => {
  currentFile = fileInput.files?.[0];
  currentIndex = undefined;
  buildIndexBtn.disabled = !currentFile;
  correctnessBtn.disabled = true;
  scaleBtn.disabled = true;
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
