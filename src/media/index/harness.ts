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

function trackRetainedBytes(t: TrackIndex): number {
  return t.pts.byteLength + t.dts.byteLength + t.offset.byteLength + t.size.byteLength + t.isSync.byteLength;
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
    },
    notes: `build ${result.buildMs.toFixed(1)}ms / retained ${(retainedBytes / 1e6).toFixed(2)}MB / cache write ${writeMs.toFixed(1)}ms / read ${readMs.toFixed(1)}ms / roundTrip ${String(roundTripCorrect)}`,
  };
});
