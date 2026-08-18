// Manual browser harness for src/media/waveform/, following src/media/frames/harness.ts's
// convention -- not wired into CI, since it needs a real AudioDecoder, a real Worker thread, real
// OPFS, and (for the multi-track cost question) the real 27GB fixture's six audio tracks.
//
// This is the harness that answers the "needs a real browser" list in README.md: whether
// AudioDecoder buffers output until flush() the same way VideoDecoder does, whether the extracted
// AudioSpecificConfig actually passes configure(), real single-worker sequential-decode throughput
// against a multi-track file, real OPFS quota/round-trip behavior for this new binary format, and
// -- the one that matters most, directly answering the roadmap's own "never decodeAudioData"
// framing -- real Activity Monitor memory during a build, confirming it stays orders of magnitude
// under the ~5.5GB a raw-PCM approach would cost.
//
// Run `npm run dev:coi` (not plain `npm run dev`) -- COOP/COEP is required for
// performance.measureUserAgentSpecificMemory(), same as the index/frames/playback harnesses.

import { buildIndex } from '../index/build-index';
import { computeFingerprint, type FileFingerprint } from '../index/fingerprint';
import { measureMemory } from '../../measure/memory';
import { buildResult, recordResult } from '../../measure/record';
import { SampleIndex } from '../index/query';
import { FileByteSource } from '../index/sources/file-byte-source';
import { readPyramidCache } from './opfs-cache';
import { DEFAULT_RATIO } from './pyramid';
import { WaveformCache } from './WaveformCache';
import { WaveformWorkerClient } from './worker-client';
import { WaveformWorkerPool } from './worker-pool';
import type { TrackIndex } from '../index/track-index';

const CHECKPOINT_SETTLE_MS = 2000;

function audioTracksOf(tracks: readonly TrackIndex[]): TrackIndex[] {
  return tracks.filter((t) => t.kind === 'audio' && t.audio);
}

function formatTrackOption(track: TrackIndex): string {
  const a = track.audio;
  return `track ${String(track.trackId)}: ${track.codec}, ${String(a?.channelCount ?? '?')}ch @ ${String(a?.sampleRate ?? '?')}Hz, ${String(track.sampleCount)} samples${a?.handlerName ? ` (${a.handlerName})` : ''}`;
}

const root = document.getElementById('app');
if (!root) throw new Error('#app element missing from waveform.html');

root.innerHTML = `
  <p><a href="/">&larr; all spikes</a></p>
  <h1>waveform peak-pyramid harness</h1>
  <p>M2: builds one audio track's peak pyramid via a real AudioDecoder in a real Worker, reports
  timing/size/OPFS round-trip. crossOriginIsolated: <strong>${String(crossOriginIsolated)}</strong></p>
  <input type="file" id="file" accept="video/*,.mkv,.mp4" /><br /><br />
  <button id="load" disabled>1. Load file, list audio tracks</button>
  <pre id="load-log"></pre>
  <div id="track-section" style="display:none">
    <label>Audio track: <select id="track-select"></select></label><br /><br />
    <button id="build">2. Build waveform for selected track</button>
    <button id="rebuild">3. Re-build (should hit OPFS cache)</button>
    <pre id="build-log"></pre>
  </div>
  <hr />
  <h2>Part B: OS-level memory checkpoints</h2>
  <p>Click each button in order, reading Activity Monitor's "Memory" column for this tab's render
  process right after each click. Each checkpoint waits ${String(CHECKPOINT_SETTLE_MS / 1000)}s
  before prompting.</p>
  <button id="mem-idle" disabled>1. Idle (file loaded, track selected, nothing built)</button>
  <button id="mem-build" disabled>2. After build</button>
  <button id="mem-download" disabled>Download checkpoints JSON</button>
  <pre id="mem-log"></pre>
`;

const fileInput = root.querySelector<HTMLInputElement>('#file');
const loadBtn = root.querySelector<HTMLButtonElement>('#load');
const loadLog = root.querySelector<HTMLPreElement>('#load-log');
const trackSection = root.querySelector<HTMLDivElement>('#track-section');
const trackSelect = root.querySelector<HTMLSelectElement>('#track-select');
const buildBtn = root.querySelector<HTMLButtonElement>('#build');
const rebuildBtn = root.querySelector<HTMLButtonElement>('#rebuild');
const buildLog = root.querySelector<HTMLPreElement>('#build-log');
const memIdleBtn = root.querySelector<HTMLButtonElement>('#mem-idle');
const memBuildBtn = root.querySelector<HTMLButtonElement>('#mem-build');
const memDownloadBtn = root.querySelector<HTMLButtonElement>('#mem-download');
const memLog = root.querySelector<HTMLPreElement>('#mem-log');
if (!fileInput || !loadBtn || !loadLog || !trackSection || !trackSelect || !buildBtn || !rebuildBtn || !buildLog || !memIdleBtn || !memBuildBtn || !memDownloadBtn || !memLog) {
  throw new Error('waveform harness failed to build its DOM');
}

function log(el: HTMLPreElement, msg: string): void {
  el.textContent += `${msg}\n`;
}

let file: File | undefined;
let sampleIndex: SampleIndex | undefined;
let fingerprint: FileFingerprint | undefined;
let audioTracks: TrackIndex[] = [];
interface MemoryCheckpoint {
  label: string;
  jsHeapBytes: number | null;
  jsHeapMethod: string;
  activityMonitorMB: number;
}
const checkpoints: MemoryCheckpoint[] = [];

fileInput.addEventListener('change', () => {
  loadBtn.disabled = !fileInput.files?.length;
});

loadBtn.addEventListener('click', () => {
  void (async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    file = f;
    const source = new FileByteSource(f);
    const t0 = performance.now();
    const indexResult = await buildIndex(source);
    if (!indexResult.ok) {
      log(loadLog, `index build failed: ${indexResult.error.kind}`);
      return;
    }
    log(loadLog, `index built in ${(performance.now() - t0).toFixed(1)}ms, ${String(indexResult.tracks.length)} track(s)`);
    sampleIndex = new SampleIndex(indexResult.tracks);
    fingerprint = await computeFingerprint(source, f.lastModified);
    audioTracks = audioTracksOf(indexResult.tracks);
    if (audioTracks.length === 0) {
      log(loadLog, 'no audio tracks with decodable metadata in this file');
      return;
    }
    trackSelect.innerHTML = audioTracks.map((t, i) => `<option value="${String(i)}">${formatTrackOption(t)}</option>`).join('');
    for (const t of audioTracks) log(loadLog, `  ${formatTrackOption(t)}`);
    trackSection.style.display = '';
    memIdleBtn.disabled = false;
  })();
});

// Arrow function expressions, not `function` declarations -- deliberately, so the null-checked
// DOM consts above stay narrowed inside these (a hoisted function declaration is reachable before
// its own textually-preceding narrowing check runs, so TS won't carry the narrowing into it; an
// expression assigned to a const that's itself never reassigned does keep it, same convention
// src/media/frames/harness.ts's own `log`/callback closures already use).
const buildSelected = async (reason: string, useCache: boolean): Promise<void> => {
  if (!file || !sampleIndex || !fingerprint) return;
  const track = audioTracks.at(Number(trackSelect.value));
  if (!track) return;

  const handles = [new WaveformWorkerClient(file)];
  const pool = new WaveformWorkerPool(handles);
  const cache = new WaveformCache({
    sampleIndex,
    audioTrackId: track.trackId,
    pool,
    fingerprint: useCache ? fingerprint : undefined,
    onError: (message, detail) => { log(buildLog, `ERROR: ${message} :: ${JSON.stringify(detail)}`); },
  });

  const t0 = performance.now();
  await cache.build();
  const buildMs = performance.now() - t0;
  const stats = cache.stats();
  log(buildLog, `[${reason}] built in ${buildMs.toFixed(1)}ms -- ${JSON.stringify(stats)}`);

  if (stats.built) {
    // track.sampleCount is an ISOBMFF sample count (one AAC frame = ~1024 raw PCM samples per
    // channel), not a raw-sample count -- estimatePyramidBytes() wants the latter, and this
    // harness previously passed the former, producing a wildly wrong "~0.01MB" estimate on the
    // real 27gb.mp4 six-track fixture (real size: ~13.8MB/track). Deriving the estimate from the
    // real build's own l0BucketCount instead sidesteps the units mismatch entirely: total bytes is
    // a geometric series in DEFAULT_RATIO dominated by level 0, so l0Bytes * ratio/(ratio-1) is the
    // same closed form estimatePyramidBytes() itself uses, just anchored to a real measurement
    // instead of a wrongly-scaled input.
    const l0Bytes = stats.l0BucketCount * stats.channelCount * 2 * 2; // Int16 min + Int16 max
    const estimatedBytes = l0Bytes * (DEFAULT_RATIO / (DEFAULT_RATIO - 1));
    log(buildLog, `[${reason}] pyramid size estimate (from this build's real L0 bucket count): ~${(estimatedBytes / 1024 / 1024).toFixed(2)}MB total pyramid`);
  }

  if (useCache) {
    const cacheCheck = await readPyramidCache(fingerprint, track.trackId);
    log(buildLog, `[${reason}] OPFS cache read-back: ${cacheCheck.kind}`);
  }

  pool.dispose();
};

buildBtn.addEventListener('click', () => {
  void buildSelected('fresh build', true);
});

rebuildBtn.addEventListener('click', () => {
  void buildSelected('rebuild (expect OPFS hit)', true);
});

const recordCheckpoint = async (label: string): Promise<void> => {
  log(memLog, `${label}: settling ${String(CHECKPOINT_SETTLE_MS / 1000)}s before reading...`);
  await new Promise((resolve) => setTimeout(resolve, CHECKPOINT_SETTLE_MS));
  const reading = await measureMemory();
  const activityMonitorMB = Number(prompt(`Checkpoint "${label}": enter Activity Monitor's Memory reading for this process group, in MB`, '0') ?? '0');
  checkpoints.push({ label, jsHeapBytes: reading.bytes, jsHeapMethod: reading.method, activityMonitorMB });
  log(memLog, `${label}: JS-side ${reading.method}=${String(reading.bytes)} bytes (NOT authoritative) | Activity Monitor=${String(activityMonitorMB)}MB`);
};

memIdleBtn.addEventListener('click', () => {
  void (async () => {
    await recordCheckpoint('1-idle');
    memIdleBtn.disabled = true;
    memBuildBtn.disabled = false;
  })();
});

memBuildBtn.addEventListener('click', () => {
  void (async () => {
    await buildSelected('memory-checkpoint build', false); // no OPFS cache -- this checkpoint measures a real decode, not a cache hit
    await recordCheckpoint('2-after-build');
    memBuildBtn.disabled = true;
    memDownloadBtn.disabled = false;
  })();
});

memDownloadBtn.addEventListener('click', () => {
  const result = buildResult({
    spike: 'waveform-memory-checkpoints',
    machine: 'local',
    fixture: file?.name ?? 'unknown',
    metrics: { checkpoints },
    notes: checkpoints.map((c) => `${c.label}: ${String(c.activityMonitorMB)}MB (Activity Monitor)`).join(' | '),
  });
  recordResult(result);
  log(memLog, 'checkpoints printed to console and downloaded as JSON.');
});
