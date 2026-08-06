// This is the entire implementation behind FrameCache.getNearest(): a zero-allocation nearest-
// value search over a sorted ascending Float64Array. Called at 60Hz inside a pointermove handler
// per the task prompt, so no array methods (.filter/.sort/.map all allocate), no promises, and
// no decode triggering -- just index math.

/** Index of the value in `sorted` (ascending) nearest to `target`. -1 if `sorted` is empty. Ties resolve to the lower index. */
export function binarySearchNearest(sorted: Float64Array, target: number): number {
  const n = sorted.length;
  if (n === 0) return -1;
  if (target <= sorted[0]) return 0;
  if (target >= sorted[n - 1]) return n - 1;

  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const value = sorted[mid];
    if (value === target) return mid;
    if (value < target) lo = mid + 1;
    else hi = mid;
  }
  // lo is now the smallest index with sorted[lo] >= target -- compare it against its predecessor.
  const before = lo - 1;
  if (before < 0) return lo;
  return target - sorted[before] <= sorted[lo] - target ? before : lo;
}
