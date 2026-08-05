// The structural fix for this module's single most dangerous failure mode: an unclosed
// VideoFrame leaks 11-13MB, LINEARLY, with ZERO errors thrown -- no decoder stall, no exception,
// no runtime signal until the OS intervenes (measured in spike C, src/spikes/C-decode/, up to 800
// frames / 9.3GB). `close()` discipline cannot be left to reviewers noticing it; every decoder
// output site in this module must go through withFrame/withFrameAsync, which close in `finally`
// so a thrown error or a cancelled batch still releases the frame.
//
// The same rule applies to ImageBitmap (also GPU-backed, also silently leaked without close()),
// so this module is written generically over anything with a `close(): void` -- both VideoFrame
// and ImageBitmap satisfy `Closable` without modification.
//
// A FrameLifecycleRegistry is a plain tracking ledger, not a global -- callers (the decoder
// wrapper, the LRU cache) hold their own instance and pass it in, the same way SampleIndex is
// constructed and held rather than reached for as a singleton. That keeps tests isolated from
// each other and lets each owner ask "how many closables do I currently believe are alive,"
// which is exactly the number Part 9's 20-cycle warm/clear leak check needs to see return to 0.

export interface Closable {
  close(): void;
}

export interface FrameLifecycleRegistry {
  readonly liveCount: number;
  track(closable: Closable, label: string): void;
  untrack(closable: Closable): void;
  /** Age of the longest-lived still-tracked closable, in ms. 0 if nothing is tracked. */
  oldestAgeMs(now?: number): number;
  /** Labels currently tracked, for diagnostics (e.g. an assertion failure message). Not ordered. */
  labels(): string[];
  /** Test/dev-only reset of the ledger itself. Does NOT call close() on anything still tracked. */
  reset(): void;
}

export function createFrameLifecycleRegistry(): FrameLifecycleRegistry {
  const live = new Map<Closable, { label: string; createdAt: number }>();

  return {
    get liveCount() {
      return live.size;
    },
    track(closable, label) {
      live.set(closable, { label, createdAt: Date.now() });
    },
    untrack(closable) {
      live.delete(closable);
    },
    oldestAgeMs(now = Date.now()) {
      let oldest = 0;
      for (const entry of live.values()) oldest = Math.max(oldest, now - entry.createdAt);
      return oldest;
    },
    labels() {
      return Array.from(live.values(), (entry) => entry.label);
    },
    reset() {
      live.clear();
    },
  };
}

/**
 * Thrown by assertNoStaleFrames when a closable has been tracked longer than expected without
 * being released -- the loud, dev-build signal the prompt asks for in place of silent growth.
 */
export class StaleFrameError extends Error {
  readonly liveCount: number;
  readonly oldestAgeMs: number;
  readonly labels: string[];

  constructor(liveCount: number, oldestAgeMs: number, labels: string[]) {
    super(`${String(liveCount)} closable(s) still tracked, oldest ${String(oldestAgeMs)}ms: ${labels.join(', ')}`);
    this.name = 'StaleFrameError';
    this.liveCount = liveCount;
    this.oldestAgeMs = oldestAgeMs;
    this.labels = labels;
  }
}

/** Call from a dev-build-gated path (harness, periodic sanity check) -- never from hot code. */
export function assertNoStaleFrames(registry: FrameLifecycleRegistry, maxAgeMs: number): void {
  const oldest = registry.oldestAgeMs();
  if (oldest > maxAgeMs) {
    throw new StaleFrameError(registry.liveCount, oldest, registry.labels());
  }
}

/**
 * Scope-bound guard for a decoder output frame: `frame` is tracked on entry and ALWAYS closed
 * (and untracked) in `finally`, whether `fn` returns normally, throws, or -- for the async
 * version -- rejects. Every VideoFrame a decoder emits must pass through here or its async
 * sibling before this module does anything else with it; no raw VideoFrame is allowed to escape
 * the call site that received it from the decoder.
 */
export function withFrame<F extends Closable, R>(registry: FrameLifecycleRegistry, frame: F, label: string, fn: (frame: F) => R): R {
  registry.track(frame, label);
  try {
    return fn(frame);
  } finally {
    frame.close();
    registry.untrack(frame);
  }
}

export async function withFrameAsync<F extends Closable, R>(registry: FrameLifecycleRegistry, frame: F, label: string, fn: (frame: F) => Promise<R>): Promise<R> {
  registry.track(frame, label);
  try {
    return await fn(frame);
  } finally {
    frame.close();
    registry.untrack(frame);
  }
}
