// Memory measurement -- both methods below are APPROXIMATIONS.
//
// - performance.measureUserAgentSpecificMemory() (Chrome, requires
//   crossOriginIsolated): estimates memory attributable to this origin's
//   agent cluster, sampled at GC boundaries. It is not a live number, can
//   lag behind reality by a GC cycle or more, and includes workers/shared
//   memory that may not be relevant to a single operation.
// - performance.memory.usedJSHeapSize (non-standard, always available):
//   only reports the JS heap of *this* context. It misses ArrayBuffers
//   held outside the heap, GPU/decoder buffers, and other renderer-process
//   memory that a video trimmer will actually stress.
//
// GROUND TRUTH for this project is Chrome's Task Manager (Shift+Esc),
// the "Memory footprint" / private memory column for this tab's render
// process, read manually and written into the run's notes field. Treat
// every number produced by this module as directional, not authoritative --
// and never compare a measureUserAgentSpecificMemory() run against a
// usedJSHeapSize run as if they were the same unit.

export type MemoryMethod = 'measureUserAgentSpecificMemory' | 'usedJSHeapSize' | 'unavailable';

export interface MemoryReading {
  method: MemoryMethod;
  bytes: number | null;
}

interface PerformanceWithMemory extends Performance {
  measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
  memory?: { usedJSHeapSize: number };
}

export async function measureMemory(): Promise<MemoryReading> {
  const perf = performance as PerformanceWithMemory;

  if (crossOriginIsolated && typeof perf.measureUserAgentSpecificMemory === 'function') {
    const measurement = await perf.measureUserAgentSpecificMemory();
    return { method: 'measureUserAgentSpecificMemory', bytes: measurement.bytes };
  }

  if (perf.memory) {
    return { method: 'usedJSHeapSize', bytes: perf.memory.usedJSHeapSize };
  }

  return { method: 'unavailable', bytes: null };
}

export interface MemorySample {
  tMs: number;
  reading: MemoryReading;
}
export interface MemorySamplerResult {
  method: MemoryMethod;
  before: MemoryReading;
  peak: MemoryReading;
  after: MemoryReading;
  samples: MemorySample[];
  /** false if the measurement method changed mid-run; metrics should be distrusted if so. */
  consistent: boolean;
}

function higher(a: MemoryReading, b: MemoryReading): MemoryReading {
  if (b.bytes === null) return a;
  if (a.bytes === null) return b;
  return b.bytes > a.bytes ? b : a;
}

/** Polls measureMemory() every intervalMs while `operation` runs. */
export async function sampleMemoryDuring(
  operation: () => Promise<void>,
  intervalMs = 250,
): Promise<MemorySamplerResult> {
  const before = await measureMemory();
  const samples: MemorySample[] = [];
  let peak = before;
  let consistent = true;
  const t0 = performance.now();

  const timer = setInterval(() => {
    void measureMemory().then((reading) => {
      if (reading.method !== before.method) consistent = false;
      samples.push({ tMs: performance.now() - t0, reading });
      peak = higher(peak, reading);
    });
  }, intervalMs);

  try {
    await operation();
  } finally {
    clearInterval(timer);
  }

  const after = await measureMemory();
  if (after.method !== before.method) consistent = false;
  peak = higher(peak, after);

  return { method: before.method, before, peak, after, samples, consistent };
}
