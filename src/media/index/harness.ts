// Manual browser harness for src/media/index/, following src/spikes/harness.ts's convention (a
// page run by hand against a local file, producing a results JSON) -- per the decision made with
// the user, this is NOT wired into CI; it's how the 27GB-fixture / OPFS-round-trip checks in task
// spec §8's "Browser integration test" get run, since neither a 27GB file nor OPFS exist in Node.
//
// Checks: index build time and retained bytes (compare against the spike's own 107.1ms / 41.8MB
// numbers on the 27GB fixture), and OPFS cache write -> read-back -> byte-exact round-trip.

import { mountSpikeHarness } from '../../spikes/harness';
import { buildIndex } from './build-index';
import { computeFingerprint } from './fingerprint';
import { readIndexCache, writeIndexCache } from './opfs-cache';
import { FileByteSource } from './sources/file-byte-source';
import type { TrackIndex } from './track-index';
import { IndexWorkerClient } from './worker-client';

function trackRetainedBytes(t: TrackIndex): number {
  return t.pts.byteLength + t.dts.byteLength + t.offset.byteLength + t.size.byteLength + t.isSync.byteLength;
}

/** Picks up to `count` random decode-order sample indices per track, deterministic-ish spread across the track. */
function sampleRandomIndices(sampleCount: number, count: number): number[] {
  const n = Math.min(count, sampleCount);
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push(Math.floor((i / n) * sampleCount) + Math.floor(Math.random() * Math.max(1, Math.floor(sampleCount / n))));
  return out.map((i) => Math.min(i, sampleCount - 1));
}

/** Spot-checks a few hundred random samples per track for equality between a main-thread and worker-built TrackIndex. */
function spotCheckTracksMatch(mainTracks: TrackIndex[], workerTracks: TrackIndex[], log: (msg: string) => void): boolean {
  if (mainTracks.length !== workerTracks.length) {
    log(`worker-path MISMATCH: track count ${String(mainTracks.length)} (main) vs ${String(workerTracks.length)} (worker)`);
    return false;
  }
  let allMatch = true;
  for (const mainTrack of mainTracks) {
    const workerTrack = workerTracks.find((t) => t.trackId === mainTrack.trackId);
    if (!workerTrack || workerTrack.sampleCount !== mainTrack.sampleCount) {
      log(`worker-path MISMATCH: track ${String(mainTrack.trackId)} missing or sampleCount differs`);
      allMatch = false;
      continue;
    }
    const indices = sampleRandomIndices(mainTrack.sampleCount, 300);
    let mismatches = 0;
    for (const i of indices) {
      if (mainTrack.pts[i] !== workerTrack.pts[i] || mainTrack.dts[i] !== workerTrack.dts[i] || mainTrack.offset[i] !== workerTrack.offset[i] || mainTrack.size[i] !== workerTrack.size[i] || mainTrack.isSync[i] !== workerTrack.isSync[i]) {
        mismatches += 1;
      }
    }
    if (mismatches > 0) {
      log(`worker-path MISMATCH: track ${String(mainTrack.trackId)}, ${String(mismatches)}/${String(indices.length)} spot-checked samples differ`);
      allMatch = false;
    } else {
      log(`worker-path OK: track ${String(mainTrack.trackId)}, ${String(indices.length)} spot-checked samples match`);
    }
  }
  return allMatch;
}

/**
 * Part 0b: runs the index worker path (src/media/index/worker.ts via IndexWorkerClient) against
 * the same file already indexed on the main thread. Records which branch (SharedArrayBuffer under
 * crossOriginIsolated, or a copied ArrayBuffer transferable otherwise -- see worker.ts's
 * toTransferBuffer) was actually taken, times the 'transferring' phase specifically (not just total
 * worker time), spot-checks samples against the main-thread build, and confirms two concurrent
 * readers both complete correctly under the SAB path. Run this page once via `npm run dev` and once
 * via `npm run dev:coi` to exercise both branches.
 */
async function checkWorkerPath(file: File, mainTracks: TrackIndex[], log: (msg: string) => void): Promise<Record<string, unknown>> {
  log(`worker-path: crossOriginIsolated=${String(crossOriginIsolated)} (expect SharedArrayBuffer branch only when true)`);

  const client = new IndexWorkerClient();
  let transferStartMs = 0;
  const t0 = performance.now();
  const result = await client.index(file, (phase) => {
    if (phase === 'transferring') transferStartMs = performance.now();
  });
  const totalMs = performance.now() - t0;
  const transferMs = transferStartMs > 0 ? performance.now() - transferStartMs : -1;
  client.terminate();

  if (!result.ok) {
    log(`worker-path: index build failed: ${result.error.kind}`);
    return { workerPathOk: false, workerError: result.error };
  }

  log(`worker-path: total=${totalMs.toFixed(1)}ms, transfer=${transferMs.toFixed(1)}ms, tracks=${String(result.tracks.length)}`);
  const spotCheckOk = spotCheckTracksMatch(mainTracks, result.tracks, log);

  // Two simultaneous readers: issue two concurrent .index() calls against the same File and
  // confirm both complete with matching results -- the configuration task 3 (thumbnails) and task 5
  // (export) need later.
  log('worker-path: issuing two concurrent readers...');
  const clientA = new IndexWorkerClient();
  const clientB = new IndexWorkerClient();
  const [resultA, resultB] = await Promise.all([clientA.index(file), clientB.index(file)]);
  clientA.terminate();
  clientB.terminate();
  const concurrentOk = resultA.ok && resultB.ok && spotCheckTracksMatch(mainTracks, resultA.tracks, () => undefined) && spotCheckTracksMatch(mainTracks, resultB.tracks, () => undefined);
  log(`worker-path: two concurrent readers both completed correctly: ${String(concurrentOk)}`);

  return {
    workerPathOk: spotCheckOk,
    workerTotalMs: totalMs,
    workerTransferMs: transferMs,
    workerCrossOriginIsolated: crossOriginIsolated,
    workerConcurrentReadersOk: concurrentOk,
  };
}

function cacheKeyFor(fp: { size: number; lastModified: number; headHash: number; tailHash: number }): string {
  return `${String(fp.size)}-${String(fp.lastModified)}-${String(fp.headHash)}-${String(fp.tailHash)}`;
}

function arraysEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

const root = document.getElementById('app');
if (!root) throw new Error('#app element missing from media-index.html');

mountSpikeHarness(root, 'media/index harness', 'Production parser (src/media/index/): build time, retained bytes, and OPFS cache round-trip against a real local file.', async (file, log) => {
  const source = new FileByteSource(file);

  log('building index...');
  const result = await buildIndex(source);
  if (!result.ok) {
    log(`parse failed: ${result.error.kind}`);
    return { metrics: { ok: false, error: result.error } };
  }

  const retainedBytes = result.tracks.reduce((sum, t) => sum + trackRetainedBytes(t), 0);
  log(`build: ${result.buildMs.toFixed(1)}ms, bytesRead=${String(result.bytesRead)}, retainedBytes=${String(retainedBytes)}`);
  for (const track of result.tracks) log(`  track ${String(track.trackId)} (${track.kind}/${track.handlerType}): ${String(track.sampleCount)} samples, codec=${track.codec}`);
  if (result.warnings.length > 0) log(`warnings: ${JSON.stringify(result.warnings)}`);

  log('computing fingerprint (first/last 1MB hash)...');
  const fingerprint = await computeFingerprint(source, file.lastModified);
  const cacheKey = cacheKeyFor(fingerprint);

  log('writing OPFS cache...');
  const t0 = performance.now();
  const writeResult = await writeIndexCache(cacheKey, { mvhdTimescale: result.mvhdTimescale, mvhdDuration: result.mvhdDuration, tracks: result.tracks }, fingerprint);
  const writeMs = performance.now() - t0;

  log('reading OPFS cache back...');
  const t1 = performance.now();
  const readResult = writeResult.kind === 'ok' ? await readIndexCache(cacheKey, fingerprint) : undefined;
  const readMs = performance.now() - t1;

  let roundTripCorrect = false;
  if (readResult?.kind === 'hit') {
    roundTripCorrect = readResult.index.tracks.every((cached) => {
      const original = result.tracks.find((t) => t.trackId === cached.trackId);
      return (
        !!original &&
        cached.sampleCount === original.sampleCount &&
        arraysEqual(cached.pts, original.pts) &&
        arraysEqual(cached.dts, original.dts) &&
        arraysEqual(cached.offset, original.offset) &&
        arraysEqual(cached.size, original.size) &&
        arraysEqual(cached.isSync, original.isSync)
      );
    });
  }

  log(`cache write=${writeResult.kind} (${writeMs.toFixed(1)}ms), read=${readResult?.kind ?? 'n/a'} (${readMs.toFixed(1)}ms), roundTripCorrect=${String(roundTripCorrect)}`);

  log('checking worker path (Part 0b)...');
  const workerMetrics = await checkWorkerPath(file, result.tracks, log);

  return {
    metrics: {
      buildMs: result.buildMs,
      bytesRead: result.bytesRead,
      retainedBytes,
      trackCount: result.tracks.length,
      perTrackSampleCounts: result.tracks.map((t) => ({ trackId: t.trackId, kind: t.kind, sampleCount: t.sampleCount })),
      warningCount: result.warnings.length,
      cacheWriteResult: writeResult.kind,
      cacheWriteMs: writeMs,
      cacheReadResult: readResult?.kind,
      cacheReadMs: readMs,
      roundTripCorrect,
      ...workerMetrics,
    },
    notes: `build ${result.buildMs.toFixed(1)}ms / retained ${(retainedBytes / 1e6).toFixed(2)}MB / cache write ${writeMs.toFixed(1)}ms / read ${readMs.toFixed(1)}ms / roundTrip ${String(roundTripCorrect)} / workerPathOk ${String(workerMetrics.workerPathOk)}`,
  };
});
