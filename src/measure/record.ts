export interface SpikeRunResult {
  spike: string;
  machine: string;
  browser: string;
  browserVersion: string;
  fixture: string;
  metrics: Record<string, unknown>;
  timestamp: string;
  notes: string;
}

function detectBrowser(): { browser: string; browserVersion: string } {
  const match = /(Chrome|Chromium|Firefox|Edg|Safari)\/([\d.]+)/.exec(navigator.userAgent);
  return match ? { browser: match[1], browserVersion: match[2] } : { browser: 'unknown', browserVersion: 'unknown' };
}

export function buildResult(params: {
  spike: string;
  machine: string;
  fixture: string;
  metrics: Record<string, unknown>;
  notes?: string;
}): SpikeRunResult {
  const { browser, browserVersion } = detectBrowser();
  return {
    spike: params.spike,
    machine: params.machine,
    browser,
    browserVersion,
    fixture: params.fixture,
    metrics: params.metrics,
    timestamp: new Date().toISOString(),
    notes: params.notes ?? '',
  };
}

export function printResultTable(result: SpikeRunResult): void {
  console.log(`--- ${result.spike} :: ${result.fixture} ---`);
  console.table(result.metrics);
  console.log(
    `browser=${result.browser}/${result.browserVersion} machine=${result.machine} at=${result.timestamp}`,
  );
  if (result.notes) console.log(`notes: ${result.notes}`);
}

export function downloadResult(result: SpikeRunResult): void {
  const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const safeName = `${result.spike}_${result.fixture}_${result.timestamp}`.replace(/[^a-z0-9._-]/gi, '_');
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Prints the result as a console table and offers it as a JSON download. */
export function recordResult(result: SpikeRunResult): void {
  printResultTable(result);
  downloadResult(result);
}
