import { sampleMemoryDuring } from '../measure/memory';
import { clearTimingRecords, getTimingRecords, timeAsync } from '../measure/timing';
import { buildResult, recordResult } from '../measure/record';

export interface SpikeOperationResult {
  metrics: Record<string, unknown>;
  notes?: string;
}

export type SpikeOperation = (file: File, log: (msg: string) => void) => Promise<SpikeOperationResult>;

/** Wires a file picker + run button to `operation`, instrumenting it with memory/timing and recording the result. */
export function mountSpikeHarness(
  root: HTMLElement,
  spikeName: string,
  description: string,
  operation: SpikeOperation,
): void {
  root.innerHTML = `
    <p><a href="/">&larr; all spikes</a></p>
    <h1>${spikeName}</h1>
    <p>${description}</p>
    <p><em>Ground truth: watch Chrome Task Manager (Shift+Esc), "Memory footprint", while this runs.</em></p>
    <p>crossOriginIsolated: <strong>${crossOriginIsolated}</strong></p>
    <label>Machine label: <input type="text" id="machine" value="local" /></label><br /><br />
    <input type="file" id="file" accept="video/*,.mkv,.mp4" /><br /><br />
    <button id="run" disabled>Run</button>
    <pre id="log"></pre>
  `;

  const fileInput = root.querySelector<HTMLInputElement>('#file')!;
  const runBtn = root.querySelector<HTMLButtonElement>('#run')!;
  const machineInput = root.querySelector<HTMLInputElement>('#machine')!;
  const logEl = root.querySelector<HTMLPreElement>('#log')!;
  const log = (msg: string): void => {
    logEl.textContent += `${msg}\n`;
  };

  fileInput.addEventListener('change', () => {
    runBtn.disabled = !fileInput.files?.length;
  });

  runBtn.addEventListener('click', () => {
    void runSpike();
  });

  async function runSpike(): Promise<void> {
    const file = fileInput.files?.[0];
    if (!file) return;

    runBtn.disabled = true;
    logEl.textContent = '';
    clearTimingRecords();
    log(`file=${file.name} size=${file.size} bytes`);

    let opResult: SpikeOperationResult | undefined;
    const memory = await sampleMemoryDuring(async () => {
      const { result, timing } = await timeAsync(spikeName, () => operation(file, log));
      opResult = result;
      log(`operation took ${timing.durationMs.toFixed(1)}ms`);
    });

    if (!memory.consistent) {
      log('WARNING: memory measurement method changed mid-run -- memory metrics below are unreliable');
    }

    const result = buildResult({
      spike: spikeName,
      machine: machineInput.value.trim() || 'unknown',
      fixture: file.name,
      metrics: {
        ...opResult?.metrics,
        fileSizeBytes: file.size,
        memoryMethod: memory.method,
        memoryConsistent: memory.consistent,
        memoryBeforeBytes: memory.before.bytes,
        memoryPeakBytes: memory.peak.bytes,
        memoryAfterBytes: memory.after.bytes,
        timings: getTimingRecords(),
      },
      notes: opResult?.notes,
    });

    recordResult(result);
    log('result printed to console and downloaded as JSON.');
    runBtn.disabled = false;
  }
}
