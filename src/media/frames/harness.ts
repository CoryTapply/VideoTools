// Manual browser harness for src/media/frames/ (Part 9), following src/media/index/harness.ts and
// src/media/playback/harness.ts's convention -- not wired into CI, since it needs real WebCodecs
// hardware decode, real Worker threads, OPFS, and (for the full run) the real 27GB fixture.
//
// Part A (mountSpikeHarness, below) is everything measurable without a human: coarse build
// time/rate, getNearest() latency percentiles, dense build + cancellation timing, frames
// decoded-vs-kept per tier, atlas pack/write/read round-trip, and the 20-cycle warm/clear leak
// check (via the FrameLifecycleRegistry's own liveCount -- a real, in-JS signal, though NOT a
// substitute for the OS-level check below, since GPU-backed VideoFrame/ImageBitmap memory is
// invisible to every JS-level API per src/measure/memory.ts's header comment).
//
// Part B (mountMemoryCheckpointSection) is the one thing that can't be automated: OS-level
// process-group memory at idle/coarse-warm/dense-warm/after-clear, read by hand from Activity
// Monitor per the task prompt's explicit instruction ("every memory claim in this task must be
// cross-checked... a memory number measured from a JS API in this module has not been measured").
//
// Run `npm run dev:coi` (not plain `npm run dev`) -- COOP/COEP is required for
// performance.measureUserAgentSpecificMemory(), same as the index/playback harnesses.

import { mountSpikeHarness } from '../../spikes/harness';
import { buildResult, recordResult } from '../../measure/record';
import { measureMemory } from '../../measure/memory';
import { buildIndex } from '../index/build-index';
import { computeFingerprint } from '../index/fingerprint';
import { SampleIndex } from '../index/query';
import { FileByteSource } from '../index/sources/file-byte-source';
import { ticksToSeconds } from '../index/time';
import type { TrackIndex } from '../index/track-index';
import { atlasCacheKey, readAtlas, writeAtlas } from './atlas-cache';
import { decodeAtlas, packAtlas } from './atlas-pack';
import { createFrameLifecycleRegistry } from './frame-lifecycle';
import type { DecodedBitmap } from './FrameDecoder';
import { DEFAULT_COARSE_SIZE, FrameCache } from './FrameCache';
import { buildCoarseJobs, buildDenseWindowJobs } from './job-builder';
import { defaultWorkerCount, FrameWorkerPool } from './worker-pool';
import { FrameWorkerClient } from './worker-client';

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return NaN;
  const idx = Math.min(sortedMs.length - 1, Math.floor(p * sortedMs.length));
  return sortedMs[idx];
}

/** getNearest() is a synchronous lookup, so "60Hz drag" is simulated as a tight back-to-back loop over random query times -- this measures raw per-call latency, the number that matters for the 16.67ms/frame budget, not wall-clock spacing. */
function measureGetNearestLatencies(cache: FrameCache, durationTicks: number, iterations: number): number[] {
  const latencies: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const t = Math.random() * durationTicks;
    const t0 = performance.now();
    cache.getNearest(t);
    latencies.push(performance.now() - t0);
  }
  return latencies.sort((a, b) => a - b);
}

interface AtlasRoundTripStats {
  packMs: number;
  writeMs: number;
  readMs: number;
  decodeMs: number;
  bytesWritten: number;
  atlasCount: number;
}

/** Wires FrameCache's onCoarseAtlasReady to the real atlas.ts pipeline: pack -> OPFS write -> OPFS read-back -> decode-once, accumulating timings across every atlas the coarse warm produces. */
function makeAtlasHandler(fingerprint: Awaited<ReturnType<typeof computeFingerprint>>, coarseSize: { width: number; height: number }, log: (msg: string) => void, stats: AtlasRoundTripStats) {
  return (atlasId: number, bitmaps: readonly DecodedBitmap[]): void => {
    void (async () => {
      const cacheKey = atlasCacheKey({ fingerprint, tier: 'coarse', atlasId, tileWidth: coarseSize.width, tileHeight: coarseSize.height });

      const t0 = performance.now();
      const packed = await packAtlas(bitmaps, coarseSize.width, coarseSize.height);
      stats.packMs += performance.now() - t0;

      const t1 = performance.now();
      const writeResult = await writeAtlas(cacheKey, packed.blob);
      stats.writeMs += performance.now() - t1;
      if (writeResult.kind === 'ok') stats.bytesWritten += writeResult.bytesWritten;
      else log(`atlas ${String(atlasId)}: OPFS write degraded to quota-exceeded (memory-only) -- expected fallback, not a failure`);

      const t2 = performance.now();
      const readResult = await readAtlas(cacheKey);
      stats.readMs += performance.now() - t2;

      if (readResult.kind === 'hit') {
        const t3 = performance.now();
        const decoded = await decodeAtlas(readResult.blob);
        stats.decodeMs += performance.now() - t3;
        decoded.close();
      }

      stats.atlasCount += 1;
      log(`atlas ${String(atlasId)} packed+written+read back: ${String(bitmaps.length)} tiles, ${String(packed.blob.size)} bytes`);
    })();
  };
}

async function runAutomatedMeasurements(file: File, log: (msg: string) => void): Promise<Record<string, unknown>> {
  const source = new FileByteSource(file);
  const indexResult = await buildIndex(source);
  if (!indexResult.ok) throw new Error(`index build failed: ${indexResult.error.kind}`);
  const videoTrack: TrackIndex | undefined = indexResult.tracks.find((t) => t.kind === 'video');
  if (!videoTrack?.video) throw new Error('no video track with decodable metadata in this file');

  const sampleIndex = new SampleIndex(indexResult.tracks);
  const fingerprint = await computeFingerprint(source, file.lastModified);

  const workerCount = defaultWorkerCount(navigator.hardwareConcurrency);
  log(`hardwareConcurrency=${String(navigator.hardwareConcurrency)} -> ${String(workerCount)} decode worker(s)`);
  const handles = Array.from({ length: workerCount }, () => new FrameWorkerClient(file));
  const pool = new FrameWorkerPool(handles);

  const registry = createFrameLifecycleRegistry();
  const atlasStats: AtlasRoundTripStats = { packMs: 0, writeMs: 0, readMs: 0, decodeMs: 0, bytesWritten: 0, atlasCount: 0 };
  const cache = new FrameCache({
    sampleIndex,
    videoTrackId: videoTrack.trackId,
    pool,
    registry,
    onCoarseAtlasReady: makeAtlasHandler(fingerprint, DEFAULT_COARSE_SIZE, log, atlasStats),
  });

  // --- coarse build time + effective keyframes/sec (target < 15s) ---------------------------
  const allCoarseJobs = buildCoarseJobs(sampleIndex, videoTrack.trackId);
  log(`coarse tier: ${String(allCoarseJobs.length)} keyframes to decode`);
  const coarseT0 = performance.now();
  await cache.warmCoarse((completed, total) => {
    if (completed === total) log(`coarse warm progress: ${String(completed)}/${String(total)}`);
  });
  const coarseMs = performance.now() - coarseT0;
  const coarseKeyframesPerSec = allCoarseJobs.length / (coarseMs / 1000);
  log(`coarse build: ${coarseMs.toFixed(1)}ms (${coarseKeyframesPerSec.toFixed(1)} keyframes/sec), target <15000ms`);

  // --- getNearest() latency over a simulated 60Hz drag -------------------------------------
  const durationTicks = videoTrack.duration - videoTrack.editOffsetTicks;
  const getNearestLatencies = measureGetNearestLatencies(cache, durationTicks, 2000);
  const getNearestStats = { p50: percentile(getNearestLatencies, 0.5), p95: percentile(getNearestLatencies, 0.95), p99: percentile(getNearestLatencies, 0.99), max: getNearestLatencies.at(-1) ?? NaN };
  log(`getNearest() over 2000 calls: p50=${getNearestStats.p50.toFixed(3)}ms p95=${getNearestStats.p95.toFixed(3)}ms p99=${getNearestStats.p99.toFixed(3)}ms max=${getNearestStats.max.toFixed(3)}ms`);

  // --- dense build time + cancellation responsiveness when the viewport moves ---------------
  const midTicks = durationTicks / 2;
  const denseTriggerPxPerSec = 400; // comfortably above the default 40px/keyframe trigger for any realistic GOP
  const denseT0 = performance.now();
  cache.setViewport(midTicks - 1000, midTicks + 1000, denseTriggerPxPerSec);
  await waitUntil(() => cache.getNearest(midTicks)?.tier === 'dense', 15_000);
  const denseBuildMs = performance.now() - denseT0;
  log(`dense build (first window, around ${(ticksToSeconds(midTicks, videoTrack.timescale)).toFixed(1)}s): ${denseBuildMs.toFixed(1)}ms`);

  const cancelT0 = performance.now();
  const farTicks = Math.min(durationTicks - 1000, midTicks + durationTicks / 4);
  cache.setViewport(farTicks - 1000, farTicks + 1000, denseTriggerPxPerSec); // supersedes the first window -- cancels it
  await waitUntil(() => cache.getNearest(farTicks)?.tier === 'dense', 15_000);
  const cancelResponsivenessMs = performance.now() - cancelT0;
  log(`dense rebuild after viewport moved (cancellation + new window): ${cancelResponsivenessMs.toFixed(1)}ms`);

  // --- frames decoded vs. frames kept per tier ------------------------------------------------
  const denseJobs = buildDenseWindowJobs(sampleIndex, videoTrack.trackId, farTicks - 1000, farTicks + 1000, videoTrack.timescale / 2);
  const denseDecodedVsKept = { decoded: denseJobs.length, kept: denseJobs.filter((j) => j.job.keep).length };
  log(`dense tier decode ratio for this window: ${String(denseDecodedVsKept.kept)} kept / ${String(denseDecodedVsKept.decoded)} decoded`);

  // --- 20-cycle warm/clear leak check (real, in-JS signal via the registry) -----------------
  const leakCycleLiveCounts: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    await cache.warmCoarse();
    cache.clear();
    leakCycleLiveCounts.push(registry.liveCount);
  }
  const leakCheckPassed = leakCycleLiveCounts.every((c) => c === 0);
  log(`20-cycle warm/clear leak check: liveCount after each cycle = [${leakCycleLiveCounts.join(', ')}] -- ${leakCheckPassed ? 'PASS' : 'FAIL, see task prompt Part 2'}`);

  cache.dispose();

  return {
    coarseKeyframeCount: allCoarseJobs.length,
    coarseBuildMs: coarseMs,
    coarseKeyframesPerSec,
    getNearestLatencyMs: getNearestStats,
    denseBuildMs,
    denseCancelResponsivenessMs: cancelResponsivenessMs,
    denseDecodedVsKept,
    atlas: atlasStats,
    leakCheckPassed,
    leakCycleLiveCounts,
    workerCount,
    trackTimescale: videoTrack.timescale,
    trackCodec: videoTrack.codec,
    trackCodedSize: `${String(videoTrack.video.codedWidth)}x${String(videoTrack.video.codedHeight)}`,
  };
}

function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const tick = (): void => {
      if (condition()) {
        resolve();
        return;
      }
      if (performance.now() - start > timeoutMs) {
        reject(new Error(`waitUntil: condition not met within ${String(timeoutMs)}ms`));
        return;
      }
      setTimeout(tick, 16);
    };
    tick();
  });
}

const root = document.getElementById('app');
if (!root) throw new Error('#app element missing from frames.html');

mountSpikeHarness(
  root,
  'frame cache harness',
  'M1 Task 3 Part 9: coarse/dense build timing, getNearest() latency, atlas round-trip, and the 20-cycle leak check. Run once against fixtures/27gb.mp4, once against fixtures/longgop.mp4 (note its keyframe interval/rate in the log -- resolution-dependent per spike C).',
  async (file, log) => {
    const metrics = await runAutomatedMeasurements(file, log);
    return {
      metrics,
      notes: `coarse ${(metrics.coarseBuildMs as number).toFixed(0)}ms / getNearest p50=${(metrics.getNearestLatencyMs as { p50: number }).p50.toFixed(3)}ms / dense build ${(metrics.denseBuildMs as number).toFixed(0)}ms / leak check ${metrics.leakCheckPassed ? 'PASS' : 'FAIL'}`,
    };
  },
);

mountMemoryCheckpointSection(root);

// =================================================================================================
// Part B: OS-level process-group memory checkpoints. This is the ONLY trustworthy memory number in
// this task -- GPU-backed VideoFrame/ImageBitmap memory is invisible to every JS-level API,
// including performance.measureUserAgentSpecificMemory() (see src/measure/memory.ts). Each button
// below performs its checkpoint's action, logs the JS-side reading for reference only, and asks the
// human running this page to read Activity Monitor's "Memory" column for this tab's render process
// (and, for the coarse/dense-warm checkpoints, note that hardware-decoded frames may live in
// VTDecoderXPCService on macOS -- check the whole process group, not just the tab).
// =================================================================================================

interface MemoryCheckpoint {
  label: string;
  jsHeapBytes: number | null;
  jsHeapMethod: string;
  activityMonitorMB: number;
}

function mountMemoryCheckpointSection(container: HTMLElement): void {
  const section = document.createElement('div');
  section.innerHTML = `
    <hr />
    <h2>Part B: OS-level memory checkpoints</h2>
    <p>Pick the SAME file used above. Click each button in order, reading Activity Monitor's
    "Memory" column for this tab's render process (Shift+Esc in Chrome, or macOS Activity Monitor)
    right after each click, before doing anything else.</p>
    <input type="file" id="mem-file" accept="video/*" /><br /><br />
    <button id="mem-idle" disabled>1. Idle (file loaded, nothing warmed)</button>
    <button id="mem-coarse" disabled>2. Coarse warm</button>
    <button id="mem-dense" disabled>3. Dense warm (zoomed viewport)</button>
    <button id="mem-clear" disabled>4. After clear()</button>
    <button id="mem-download" disabled>Download checkpoints JSON</button>
    <pre id="mem-log"></pre>
  `;
  container.appendChild(section);

  const fileInput = section.querySelector<HTMLInputElement>('#mem-file');
  const idleBtn = section.querySelector<HTMLButtonElement>('#mem-idle');
  const coarseBtn = section.querySelector<HTMLButtonElement>('#mem-coarse');
  const denseBtn = section.querySelector<HTMLButtonElement>('#mem-dense');
  const clearBtn = section.querySelector<HTMLButtonElement>('#mem-clear');
  const downloadBtn = section.querySelector<HTMLButtonElement>('#mem-download');
  const logEl = section.querySelector<HTMLPreElement>('#mem-log');
  if (!fileInput || !idleBtn || !coarseBtn || !denseBtn || !clearBtn || !downloadBtn || !logEl) throw new Error('memory checkpoint section failed to build its DOM');

  const log = (msg: string): void => {
    logEl.textContent += `${msg}\n`;
  };

  let cache: FrameCache | undefined;
  let sampleIndex: SampleIndex | undefined;
  let trackId = -1;
  let durationTicks = 0;
  const checkpoints: MemoryCheckpoint[] = [];

  async function recordCheckpoint(label: string): Promise<void> {
    const reading = await measureMemory();
    const activityMonitorMB = Number(prompt(`Checkpoint "${label}": enter Activity Monitor's Memory reading for this process group, in MB`, '0') ?? '0');
    checkpoints.push({ label, jsHeapBytes: reading.bytes, jsHeapMethod: reading.method, activityMonitorMB });
    log(`${label}: JS-side ${reading.method}=${String(reading.bytes)} bytes (NOT authoritative) | Activity Monitor=${String(activityMonitorMB)}MB`);
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    idleBtn.disabled = !file;
  });

  idleBtn.addEventListener('click', () => {
    void (async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const source = new FileByteSource(file);
      const indexResult = await buildIndex(source);
      if (!indexResult.ok) {
        log(`index build failed: ${indexResult.error.kind}`);
        return;
      }
      const videoTrack = indexResult.tracks.find((t) => t.kind === 'video');
      if (!videoTrack) {
        log('no video track in this file');
        return;
      }
      sampleIndex = new SampleIndex(indexResult.tracks);
      trackId = videoTrack.trackId;
      durationTicks = videoTrack.duration - videoTrack.editOffsetTicks;
      const workerCount = defaultWorkerCount(navigator.hardwareConcurrency);
      const pool = new FrameWorkerPool(Array.from({ length: workerCount }, () => new FrameWorkerClient(file)));
      cache = new FrameCache({ sampleIndex, videoTrackId: trackId, pool });
      await recordCheckpoint('1-idle');
      idleBtn.disabled = true;
      coarseBtn.disabled = false;
    })();
  });

  coarseBtn.addEventListener('click', () => {
    void (async () => {
      if (!cache) return;
      await cache.warmCoarse();
      await recordCheckpoint('2-coarse-warm');
      coarseBtn.disabled = true;
      denseBtn.disabled = false;
    })();
  });

  denseBtn.addEventListener('click', () => {
    void (async () => {
      if (!cache) return;
      const mid = durationTicks / 2;
      cache.setViewport(mid - 1000, mid + 1000, 400);
      await waitUntil(() => cache?.getNearest(mid)?.tier === 'dense', 15_000).catch(() => undefined);
      await recordCheckpoint('3-dense-warm');
      denseBtn.disabled = true;
      clearBtn.disabled = false;
    })();
  });

  clearBtn.addEventListener('click', () => {
    void (async () => {
      if (!cache) return;
      cache.clear();
      await recordCheckpoint('4-after-clear');
      clearBtn.disabled = true;
      downloadBtn.disabled = false;
    })();
  });

  downloadBtn.addEventListener('click', () => {
    const result = buildResult({
      spike: 'frame-cache-memory-checkpoints',
      machine: 'local',
      fixture: fileInput.files?.[0]?.name ?? 'unknown',
      metrics: { checkpoints },
      notes: checkpoints.map((c) => `${c.label}: ${String(c.activityMonitorMB)}MB (Activity Monitor)`).join(' | '),
    });
    recordResult(result);
    log('checkpoints printed to console and downloaded as JSON.');
  });
}
