// Manual browser harness for src/media/playback/, following src/media/index/harness.ts's
// convention (a page run by hand against a local file, producing a results JSON) -- not wired
// into CI, since it needs a real <video> element and (for the full 27GB run) a real large file.
//
// Part 1 (M1 Task 2): the edit-list ground-truth check. Establishes empirically whether
// SampleIndex's presentation-time methods (frameAtPresentationTime / presentationTimeOfSample --
// see query.ts) agree with what a real <video> element actually presents, via
// requestVideoFrameCallback's reported mediaTime. See src/media/index/README.md's "Edit lists"
// section for the resolved finding this check is meant to produce.
//
// Part 7 additions (seek coalescing / frame stepping / rVFC drift reports) extend this same page.

import { mountSpikeHarness } from '../../spikes/harness';
import { buildResult, recordResult } from '../../measure/record';
import { buildIndex } from '../index/build-index';
import { SampleIndex } from '../index/query';
import { FileByteSource } from '../index/sources/file-byte-source';
import { localTicksToPresentationSeconds, secondsToTicks, ticksToSeconds } from '../index/time';
import { pickStepStartingPoints } from './frame-stepping';
import { NativeVideoEngine } from './NativeVideoEngine';
import { RealVideoElement } from './RealVideoElement';

interface EditListDeltaRow {
  targetSec: number;
  rvfcMediaTimeSec: number;
  rawTickSec: number;
  adjustedSec: number;
  deltaRawSec: number;
  deltaAdjustedSec: number;
}

function waitForEvent(target: EventTarget, type: string): Promise<void> {
  return new Promise((resolve) => {
    target.addEventListener(
      type,
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

function waitForFrame(video: HTMLVideoElement): Promise<{ mediaTime: number; presentedFrames: number }> {
  return new Promise((resolve) => {
    video.requestVideoFrameCallback((_now, metadata) => {
      resolve({ mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames });
    });
  });
}

/**
 * Seeks to `targetSec` and waits for it to settle. Browsers do NOT fire 'seeked' when
 * `currentTime` is assigned a value it's already at (e.g. seeking to 0 on a freshly-loaded video,
 * which is already sitting at 0) -- awaiting 'seeked' unconditionally hangs forever on exactly
 * that case, which is the first target this harness tries. Skip the wait when already close
 * enough; otherwise wait, with a generous timeout so a genuine stall is reported, not silent.
 */
async function seekAndSettle(video: HTMLVideoElement, targetSec: number, log: (msg: string) => void): Promise<void> {
  const EPSILON_SEC = 0.001;
  if (Math.abs(video.currentTime - targetSec) < EPSILON_SEC) {
    log(`  (seek to ${targetSec.toFixed(3)}s skipped -- already there)`);
    return;
  }

  log(`  seeking to ${targetSec.toFixed(3)}s...`);
  const t0 = performance.now();
  const seeked = waitForEvent(video, 'seeked');
  video.currentTime = targetSec;
  const timedOut = await Promise.race([seeked.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => { resolve(true); }, 10_000))]);
  log(`  seek settled after ${(performance.now() - t0).toFixed(0)}ms${timedOut ? ' -- TIMED OUT, proceeding anyway without a seeked event' : ''}`);
}

/** Picks >=8 target seconds per the task's spec: 0, a few seconds in, four across the middle, one near the end, one exactly at a keyframe boundary. */
function pickTargetSeconds(durationSec: number, keyframePresentationSec: number[]): number[] {
  const targets = [
    0,
    Math.min(2, durationSec * 0.1),
    durationSec * 0.25,
    durationSec * 0.4,
    durationSec * 0.55,
    durationSec * 0.7,
    Math.max(0, durationSec - 1),
  ];
  if (keyframePresentationSec.length > 0) targets.push(keyframePresentationSec[Math.floor(keyframePresentationSec.length / 2)]);
  return targets;
}

async function runEditListCheck(file: File, log: (msg: string) => void): Promise<{ rows: EditListDeltaRow[]; constantOffset: boolean }> {
  const source = new FileByteSource(file);
  const result = await buildIndex(source);
  if (!result.ok) throw new Error(`index build failed: ${result.error.kind}`);

  const videoTrack = result.tracks.find((t) => t.kind === 'video');
  if (!videoTrack) throw new Error('no video track in this file');

  const index = new SampleIndex(result.tracks);
  const keyframePresentationSec = Array.from(index.keyframePresentationTimes(videoTrack.trackId)).map((ticks) => ticksToSeconds(ticks, videoTrack.timescale));

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.src = url;
  video.style.display = 'none';
  document.body.appendChild(video);

  try {
    await waitForEvent(video, 'loadedmetadata');
    log(`duration=${video.duration.toFixed(3)}s, trackTimescale=${String(videoTrack.timescale)}, editOffsetTicks=${String(videoTrack.editOffsetTicks)}`);

    const targets = pickTargetSeconds(video.duration, keyframePresentationSec);
    const rows: EditListDeltaRow[] = [];

    for (const targetSec of targets) {
      await seekAndSettle(video, targetSec, log);
      const { mediaTime } = await waitForFrame(video);

      // Find the sample via the PRESENTATION-native lookup (frameAtPresentationTime), which
      // correctly adds editOffsetTicks before searching raw ticks -- using the raw frameAtTime
      // directly with a presentation-time input is exactly the bug this whole check exists to
      // catch, and breaks outright at target=0 whenever editOffsetTicks > 0 (the track's raw pts
      // array starts at raw tick editOffsetTicks, not 0, so frameAtTime(trackId, 0) legitimately
      // finds nothing and returns -1). Once we have the right sample, read ITS raw pts back two
      // ways for comparison: raw division (what a naive caller using the wrong method would get)
      // and edit-adjusted (what this should match).
      const targetPresentationTicks = secondsToTicks(targetSec, videoTrack.timescale);
      const n = index.frameAtPresentationTime(videoTrack.trackId, targetPresentationTicks);
      const sampleRawTicks = n >= 0 ? index.timeOfSample(videoTrack.trackId, n) : NaN;
      const rawTickSec = ticksToSeconds(sampleRawTicks, videoTrack.timescale);
      const adjustedSec = localTicksToPresentationSeconds(sampleRawTicks, videoTrack.timescale, videoTrack.editOffsetTicks);

      const row: EditListDeltaRow = {
        targetSec,
        rvfcMediaTimeSec: mediaTime,
        rawTickSec,
        adjustedSec,
        deltaRawSec: mediaTime - rawTickSec,
        deltaAdjustedSec: mediaTime - adjustedSec,
      };
      rows.push(row);
      log(`target=${targetSec.toFixed(3)}s rVFC.mediaTime=${mediaTime.toFixed(4)}s raw=${rawTickSec.toFixed(4)}s(Δ${row.deltaRawSec.toFixed(4)}) adjusted=${adjustedSec.toFixed(4)}s(Δ${row.deltaAdjustedSec.toFixed(4)})`);
    }

    // Constant-offset check: the adjusted-time delta should agree across all points (within a
    // small tolerance for float/frame-boundary rounding). If it doesn't, something is wrong in the
    // index or edit-list interpretation -- see this file's header comment and the task's
    // instruction to stop and report rather than build further.
    const deltas = rows.map((r) => r.deltaAdjustedSec);
    const meanDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const maxDeviation = Math.max(...deltas.map((d) => Math.abs(d - meanDelta)));
    const FRAME_TOLERANCE_SEC = 1 / 24; // generous: well under a frame at any realistic fps
    const constantOffset = maxDeviation < FRAME_TOLERANCE_SEC;
    log(`adjusted-time delta: mean=${meanDelta.toFixed(4)}s, maxDeviationFromMean=${maxDeviation.toFixed(4)}s, constantOffset=${String(constantOffset)}`);
    if (!constantOffset) {
      log('WARNING: delta is NOT constant across target points -- per task spec, STOP and investigate before building anything on this. Do not treat this as a rounding artifact.');
    }

    return { rows, constantOffset };
  } finally {
    document.body.removeChild(video);
    URL.revokeObjectURL(url);
  }
}

const root = document.getElementById('app');
if (!root) throw new Error('#app element missing from playback.html');

mountSpikeHarness(
  root,
  'playback engine harness',
  'M1 Task 2 Part 1: edit-list ground truth (does SampleIndex presentation time agree with what <video> actually presents?). Part 7 adds seek/step/drift checks on top of this.',
  async (file, log) => {
    const { rows, constantOffset } = await runEditListCheck(file, log);
    return {
      metrics: { editListDeltaRows: rows, editListDeltaConstant: constantOffset },
      notes: `edit-list delta constant across ${String(rows.length)} points: ${String(constantOffset)}`,
    };
  },
);

mountInteractiveSection(root);

// =================================================================================================
// Part 7: interactive playback controls + the full report (seek latency distribution, convergence
// across 20 real drag simulations, step round-trip accuracy, rVFC drift over 60s of playback, and
// the Part 1 edit-list delta table folded in). A persistent NativeVideoEngine driving a REAL
// <video> element -- this is deliberately separate from mountSpikeHarness's one-shot
// file-in/result-out flow above, since this section stays alive across many user actions
// (play/pause/step/scrub) rather than running once and finishing.
// =================================================================================================

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function mountInteractiveSection(container: HTMLElement): void {
  const section = document.createElement('div');
  section.innerHTML = `
    <hr />
    <h2>Part 7: interactive playback + full report</h2>
    <input type="file" id="pb-file" accept="video/*" /><br /><br />
    <div id="pb-controls" style="display:none">
      <video id="pb-video" muted style="max-width: 480px; display: block;"></video>
      <p>
        state: <strong id="pb-state"></strong> |
        timecode: <strong id="pb-timecode"></strong> |
        frame: <strong id="pb-frame"></strong> |
        syncPath: <strong id="pb-syncpath"></strong> |
        dropped: <strong id="pb-dropped"></strong>
      </p>
      <input type="range" id="pb-scrub" min="0" max="1000" value="0" style="width: 480px" /><br /><br />
      <button id="pb-play">Play</button>
      <button id="pb-pause">Pause</button>
      <button id="pb-step-back-10">-10</button>
      <button id="pb-step-back-1">-1</button>
      <button id="pb-step-fwd-1">+1</button>
      <button id="pb-step-fwd-10">+10</button>
      <button id="pb-seek-random">Seek random</button>
      <br /><br />
      <button id="pb-run-report">Run full report (seek latency, 20 drag sims, step accuracy, 60s drift)</button>
      <pre id="pb-log"></pre>
    </div>
  `;
  container.appendChild(section);

  const fileInput = section.querySelector<HTMLInputElement>('#pb-file');
  const controls = section.querySelector<HTMLDivElement>('#pb-controls');
  const videoEl = section.querySelector<HTMLVideoElement>('#pb-video');
  const stateEl = section.querySelector<HTMLElement>('#pb-state');
  const timecodeEl = section.querySelector<HTMLElement>('#pb-timecode');
  const frameEl = section.querySelector<HTMLElement>('#pb-frame');
  const syncPathEl = section.querySelector<HTMLElement>('#pb-syncpath');
  const droppedEl = section.querySelector<HTMLElement>('#pb-dropped');
  const scrub = section.querySelector<HTMLInputElement>('#pb-scrub');
  const logEl = section.querySelector<HTMLPreElement>('#pb-log');
  if (!fileInput || !controls || !videoEl || !stateEl || !timecodeEl || !frameEl || !syncPathEl || !droppedEl || !scrub || !logEl) {
    throw new Error('Part 7 harness section failed to build its DOM');
  }

  const log = (msg: string): void => {
    logEl.textContent += `${msg}\n`;
  };

  const setup = async (file: File): Promise<void> => {
    const source = new FileByteSource(file);
    const result = await buildIndex(source);
    if (!result.ok) {
      log(`index build failed: ${result.error.kind}`);
      return;
    }
    const videoTrack = result.tracks.find((t) => t.kind === 'video');
    if (!videoTrack) {
      log('no video track in this file');
      return;
    }

    const index = new SampleIndex(result.tracks);
    const engine = new NativeVideoEngine(new RealVideoElement(videoEl));
    const loadResult = await engine.load(file, index);
    if (!loadResult.ok) {
      log(`engine.load failed: ${loadResult.error.kind}`);
      return;
    }

    controls.style.display = '';
    scrub.max = String(videoTrack.duration);

    engine.onStateChange((s) => {
      stateEl.textContent = s;
    });
    engine.onFrame((t, frameIndex) => {
      timecodeEl.textContent = ticksToSeconds(t, videoTrack.timescale).toFixed(3);
      frameEl.textContent = String(frameIndex);
      syncPathEl.textContent = engine.syncPath ?? 'n/a';
      droppedEl.textContent = engine.droppedFrameCount === undefined ? 'n/a (raf path)' : String(engine.droppedFrameCount);
      scrub.value = String(t);
    });

    section.querySelector('#pb-play')?.addEventListener('click', () => { engine.play(); });
    section.querySelector('#pb-pause')?.addEventListener('click', () => { engine.pause(); });
    section.querySelector('#pb-step-back-10')?.addEventListener('click', () => void engine.stepFrames(-10));
    section.querySelector('#pb-step-back-1')?.addEventListener('click', () => void engine.stepFrames(-1));
    section.querySelector('#pb-step-fwd-1')?.addEventListener('click', () => void engine.stepFrames(1));
    section.querySelector('#pb-step-fwd-10')?.addEventListener('click', () => void engine.stepFrames(10));
    section.querySelector('#pb-seek-random')?.addEventListener('click', () => {
      const target = Math.floor(Math.random() * videoTrack.duration);
      void engine.seek(target, 'accurate');
    });
    scrub.addEventListener('input', () => {
      void engine.seek(Number(scrub.value), 'scrub');
    });

    section.querySelector('#pb-run-report')?.addEventListener('click', () => {
      void runFullReport(file, engine, index, videoTrack.trackId, videoTrack.timescale, videoTrack.duration, log);
    });
  };

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void setup(file);
  });
}

async function measureSeekLatencies(engine: NativeVideoEngine, durationTicks: number, count: number): Promise<number[]> {
  const latencies: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const target = Math.floor(Math.random() * durationTicks);
    const t0 = performance.now();
    await engine.seek(target, 'accurate'); // one at a time -- no overlap, so this is per-seek latency, not a coalescing scenario
    latencies.push(performance.now() - t0);
  }
  return latencies.sort((a, b) => a - b);
}

/** Fires `burstSize` rapid, unawaited seeks (simulating fast drag input), then asserts the engine converges on the LAST requested target. Repeats `simCount` times. */
async function runDragConvergenceSimulations(engine: NativeVideoEngine, durationTicks: number, simCount: number, burstSize: number): Promise<{ pass: number; fail: number; details: string[] }> {
  let pass = 0;
  let fail = 0;
  const details: string[] = [];
  for (let sim = 0; sim < simCount; sim += 1) {
    let lastTarget = 0;
    let lastPromise: Promise<void> = Promise.resolve();
    for (let i = 0; i < burstSize; i += 1) {
      lastTarget = Math.floor(Math.random() * durationTicks);
      lastPromise = engine.seek(lastTarget, 'scrub');
    }
    await lastPromise;
    const ok = engine.currentTime === lastTarget;
    if (ok) pass += 1;
    else fail += 1;
    details.push(`sim ${String(sim)}: requested=${String(lastTarget)} actual=${String(engine.currentTime)} ${ok ? 'PASS' : 'FAIL'}`);
  }
  return { pass, fail, details };
}

async function measureStepRoundTripAccuracy(engine: NativeVideoEngine, index: SampleIndex, trackId: number): Promise<{ pass: number; fail: number; details: string[] }> {
  const startingPoints = pickStepStartingPoints(index, trackId, 20);
  let pass = 0;
  let fail = 0;
  const details: string[] = [];
  for (const startSample of startingPoints) {
    const startTicks = index.presentationTimeOfSample(trackId, startSample);
    await engine.seek(startTicks, 'accurate');
    await engine.stepFrames(10);
    await engine.stepFrames(-10);
    const finalSample = index.frameAtPresentationTime(trackId, engine.currentTime);
    const ok = finalSample === startSample;
    if (ok) pass += 1;
    else fail += 1;
    details.push(`start=${String(startSample)} final=${String(finalSample)} ${ok ? 'PASS' : 'FAIL'}`);
  }
  return { pass, fail, details };
}

/** Samples rVFC-reported mediaTime against a directly-read video.currentTime over ~60s of continuous playback. */
async function measureRvfcDrift(engine: NativeVideoEngine, videoEl: HTMLVideoElement, timescale: number, durationMs = 60_000, sampleEveryMs = 1000): Promise<{ maxDriftSec: number; meanDriftSec: number; samples: number }> {
  const drifts: number[] = [];
  engine.play();
  const start = performance.now();
  while (performance.now() - start < durationMs) {
    await new Promise((resolve) => setTimeout(resolve, sampleEveryMs));
    const engineSec = ticksToSeconds(engine.currentTime, timescale);
    drifts.push(Math.abs(engineSec - videoEl.currentTime));
  }
  engine.pause();
  return {
    maxDriftSec: drifts.length > 0 ? Math.max(...drifts) : 0,
    meanDriftSec: drifts.length > 0 ? drifts.reduce((a, b) => a + b, 0) / drifts.length : 0,
    samples: drifts.length,
  };
}

async function runFullReport(file: File, engine: NativeVideoEngine, index: SampleIndex, trackId: number, timescale: number, durationTicks: number, log: (msg: string) => void): Promise<void> {
  log('--- seek latency distribution (30 sequential, non-overlapping seeks) ---');
  const latencies = await measureSeekLatencies(engine, durationTicks, 30);
  const seekLatency = { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99), max: latencies[latencies.length - 1] ?? NaN };
  log(`p50=${seekLatency.p50.toFixed(1)}ms p95=${seekLatency.p95.toFixed(1)}ms p99=${seekLatency.p99.toFixed(1)}ms max=${seekLatency.max.toFixed(1)}ms`);

  log('--- convergence: 20 real drag simulations (200-seek bursts) ---');
  const convergence = await runDragConvergenceSimulations(engine, durationTicks, 20, 200);
  for (const d of convergence.details) log(d);
  log(`convergence: ${String(convergence.pass)}/20 passed`);

  log('--- step round-trip accuracy: 20 starting points ---');
  const stepAccuracy = await measureStepRoundTripAccuracy(engine, index, trackId);
  for (const d of stepAccuracy.details) log(d);
  log(`step accuracy: ${String(stepAccuracy.pass)}/${String(stepAccuracy.details.length)} passed`);

  log('--- rVFC drift over 60s of continuous playback ---');
  const videoEl = document.querySelector<HTMLVideoElement>('#pb-video');
  const drift = videoEl ? await measureRvfcDrift(engine, videoEl, timescale, 60_000) : { maxDriftSec: NaN, meanDriftSec: NaN, samples: 0 };
  log(`maxDrift=${drift.maxDriftSec.toFixed(4)}s meanDrift=${drift.meanDriftSec.toFixed(4)}s (${String(drift.samples)} samples)`);

  log('--- edit-list delta table (Part 1, re-run here for a single consolidated report) ---');
  const editList = await runEditListCheck(file, log);

  const result = buildResult({
    spike: 'playback-engine-harness-part7',
    machine: 'local',
    fixture: file.name,
    metrics: {
      seekLatencyMs: seekLatency,
      seekLatenciesRawMs: latencies,
      convergencePass: convergence.pass,
      convergenceFail: convergence.fail,
      stepAccuracyPass: stepAccuracy.pass,
      stepAccuracyFail: stepAccuracy.fail,
      rvfcDrift: drift,
      editListDeltaRows: editList.rows,
      editListDeltaConstant: editList.constantOffset,
    },
    notes: `seek p50=${seekLatency.p50.toFixed(1)}ms / convergence ${String(convergence.pass)}/20 / step ${String(stepAccuracy.pass)}/${String(stepAccuracy.details.length)} / drift max=${drift.maxDriftSec.toFixed(4)}s`,
  });
  recordResult(result);
  log('full report printed to console and downloaded as JSON.');
}
