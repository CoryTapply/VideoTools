// The measured cost model from results/T0-EXPORT-COST.md (fit R^2 ~= 1 across 10MB-4GB, warm
// cache). Deliberately not built on src/measure/timing.ts, which is diagnostic-harness-only
// (never imported outside src/spikes/ and two harness files) -- this is the lightweight,
// production-appropriate replacement.

export function estimateCopyMs(totalBytes: number): number {
  const sizeMb = totalBytes / (1024 * 1024);
  return 9.5 + sizeMb / 245.6;
}

export function estimateCloseMs(totalBytes: number): number {
  const sizeMb = totalBytes / (1024 * 1024);
  return 26.6 + sizeMb / 734.1;
}

/**
 * close() is not O(1) -- it's a real, size-proportional operation (the File System Access spec
 * requires createWritable() to write to a temp file and atomically swap it in on close()). T0's
 * finalising-phase table: 10MB -> ~27ms (invisible), 200MB -> ~300ms, 500MB -> ~740ms, 1GB ->
 * ~1.4s, 4GB -> ~5.5s. Below a few hundred MB it's not worth a distinct UI phase -- this threshold
 * is a judgment call, not a measured cliff.
 */
const FINALISING_PHASE_THRESHOLD_BYTES = 200 * 1024 * 1024;

export function shouldShowFinalisingPhase(totalBytes: number): boolean {
  return totalBytes >= FINALISING_PHASE_THRESHOLD_BYTES;
}
