// Spike C -- WebCodecs scrub + thumbnails. See prompts/m0.5-spike-prompts.md.
import { buildMp4Index, type TrackIndex } from '../A-remux/mp4-index';
import { keyframeIntervalStats, pickSpreadKeyframes, runKeyframeThroughput } from './keyframe-throughput';
import type { KeyframeThroughputResult } from './decode-worker';

const root = document.getElementById('app')!;
root.innerHTML = `
  <p><a href="/">&larr; all spikes</a></p>
  <h1>spike C: WebCodecs scrub + thumbnails</h1>
  <p>Uses the index from spikes A/B (src/spikes/A-remux/mp4-index.ts). See
  <code>prompts/m0.5-spike-prompts.md</code> for the full spec. H.264 (avc1/avc3) only.</p>

  <input type="file" id="file" accept="video/*,.mkv,.mp4" /><br /><br />
  <button id="buildIndex" disabled>1. Build index</button>
  <pre id="indexLog"></pre>

  <hr />
  <label>keyframes to sample: <input type="number" id="keyframeCount" value="200" /></label><br /><br />
  <button id="throughputBtn" disabled>2. Keyframe throughput (filmstrip path)</button>
  <pre id="throughputLog"></pre>
`;

const fileInput = root.querySelector<HTMLInputElement>('#file')!;
const buildIndexBtn = root.querySelector<HTMLButtonElement>('#buildIndex')!;
const indexLog = root.querySelector<HTMLPreElement>('#indexLog')!;
const keyframeCountInput = root.querySelector<HTMLInputElement>('#keyframeCount')!;
const throughputBtn = root.querySelector<HTMLButtonElement>('#throughputBtn')!;
const throughputLog = root.querySelector<HTMLPreElement>('#throughputLog')!;

const ilog = (msg: string): void => {
  indexLog.textContent += `${msg}\n`;
};
const tlog = (msg: string): void => {
  throughputLog.textContent += `${msg}\n`;
};

let currentFile: File | undefined;
let videoTrack: TrackIndex | undefined;

fileInput.addEventListener('change', () => {
  currentFile = fileInput.files?.[0];
  videoTrack = undefined;
  buildIndexBtn.disabled = !currentFile;
  throughputBtn.disabled = true;
});

buildIndexBtn.addEventListener('click', () => {
  void (async () => {
    if (!currentFile) return;
    buildIndexBtn.disabled = true;
    indexLog.textContent = '';
    try {
      const index = await buildMp4Index(currentFile);
      videoTrack = index.tracks.find((t) => t.handlerType === 'vide');
      if (!videoTrack) {
        ilog('no video track found');
        return;
      }
      ilog(`video track: ${videoTrack.sampleCount} samples, buildMs=${index.buildMs.toFixed(1)}`);
      const stats = keyframeIntervalStats(videoTrack);
      ilog(`real keyframes: ${stats.realKeyframeCount}, interval min/mean/max = ${stats.minIntervalSec.toFixed(3)}s / ${stats.meanIntervalSec.toFixed(3)}s / ${stats.maxIntervalSec.toFixed(3)}s`);
      throughputBtn.disabled = false;
    } catch (err) {
      ilog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      buildIndexBtn.disabled = false;
    }
  })();
});

function logResult(label: string, r: KeyframeThroughputResult): void {
  tlog(`${label}: ${r.thumbnailsPerSecond.toFixed(1)} thumbnails/sec over ${r.count} frames (${r.totalMs.toFixed(0)}ms total)`);
  tlog(`  read=${r.readMs.toFixed(0)}ms decode=${r.decodeMs.toFixed(0)}ms downscale=${r.downscaleMs.toFixed(0)}ms`);
  if (r.errors.length > 0) tlog(`  ERRORS: ${JSON.stringify(r.errors)}`);
  const status = r.thumbnailsPerSecond < 50 ? 'FAIL (<50/sec)' : 'ok';
  tlog(`  status: ${status}`);
}

// --- 2. keyframe throughput: hardware vs software, and coalesced-window read comparison ---
throughputBtn.addEventListener('click', () => {
  void (async () => {
    if (!currentFile || !videoTrack) return;
    throughputBtn.disabled = true;
    throughputLog.textContent = '';
    try {
      const count = Number(keyframeCountInput.value) || 200;
      const targets = pickSpreadKeyframes(videoTrack, count);
      tlog(`sampling ${targets.length} keyframes spread across the track`);

      const hw = await runKeyframeThroughput(currentFile, videoTrack, targets, 'prefer-hardware');
      logResult('prefer-hardware', hw);

      const sw = await runKeyframeThroughput(currentFile, videoTrack, targets, 'prefer-software');
      logResult('\nprefer-software', sw);

      const coalesced = await runKeyframeThroughput(currentFile, videoTrack, targets, 'prefer-hardware', 4 * 1024 * 1024);
      logResult('\nprefer-hardware, 4MB-window coalesced reads', coalesced);
    } catch (err) {
      tlog(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      throughputBtn.disabled = false;
    }
  })();
});
