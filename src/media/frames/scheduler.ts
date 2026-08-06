// Priority queue for "what to decode next" (Part 7), decoupled from the worker pool so it's
// fully testable in Node: this module only owns ordering, out-of-range cancellation, and
// progress bookkeeping for items that haven't been dispatched yet. Once a tier builder
// (coarse-tier.ts / dense-tier.ts) calls takeNext() and submits the result to FrameWorkerPool, it
// owns tracking that in-flight requestId itself and calling pool.cancel() on it if the item falls
// out of range before it completes -- this scheduler can't reach into the pool to do that itself,
// nor should it need to.
//
// "Coarse tier builds outward from the current playhead, not from t=0" falls out for free: pass
// the playhead as the initial center in reset(), and takeNext() naturally returns items nearest
// it first, regardless of what order they were built in.

export interface ScheduledItem<T> {
  readonly key: string;
  /** Presentation ticks -- what distance-from-center is measured against. */
  readonly time: number;
  readonly payload: T;
}

export interface SchedulerProgress {
  readonly completed: number;
  readonly total: number;
}

export class PriorityScheduler<T> {
  private pending = new Map<string, ScheduledItem<T>>();
  private center = 0;
  private completedCount = 0;
  private totalCount = 0;

  get pendingCount(): number {
    return this.pending.size;
  }

  get progress(): SchedulerProgress {
    return { completed: this.completedCount, total: this.totalCount };
  }

  /** Replaces the full item set (e.g. a fresh warmCoarse() build, or the dense tier's window rebuilt around a new viewport) and resets progress accounting to reflect it. */
  reset(items: readonly ScheduledItem<T>[], center: number): void {
    this.pending = new Map(items.map((item) => [item.key, item]));
    this.center = center;
    this.completedCount = 0;
    this.totalCount = items.length;
  }

  /** Re-centers priority ordering (playhead moved, viewport panned) without touching which items are pending. */
  setCenter(center: number): void {
    this.center = center;
  }

  /** Removes and returns the keys of any still-pending items outside [rangeStart, rangeEnd] -- CANCELLED, never dispatched, not merely deprioritized. Reduces `total` so progress stays meaningful (a cancelled item was never going to complete). */
  cancelOutOfRange(rangeStart: number, rangeEnd: number): string[] {
    const removed: string[] = [];
    for (const [key, item] of this.pending) {
      if (item.time < rangeStart || item.time > rangeEnd) {
        this.pending.delete(key);
        removed.push(key);
        this.totalCount -= 1;
      }
    }
    return removed;
  }

  /** Returns up to `count` pending items closest to the current center (closest first), removing them from the pending set -- the caller now owns dispatching them. */
  takeNext(count: number): ScheduledItem<T>[] {
    const sorted = Array.from(this.pending.values()).sort((a, b) => Math.abs(a.time - this.center) - Math.abs(b.time - this.center));
    const taken = sorted.slice(0, count);
    for (const item of taken) this.pending.delete(item.key);
    return taken;
  }

  /** Bookkeeping only -- call once a dispatched item's decode has settled (success or permanent failure), for a status bar's "thumbs N%". */
  markCompleted(count = 1): void {
    this.completedCount = Math.min(this.totalCount, this.completedCount + count);
  }
}
