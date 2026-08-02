export interface TimingRecord {
  name: string;
  startMs: number;
  durationMs: number;
}

const records: TimingRecord[] = [];

export function markStart(name: string): void {
  performance.mark(`${name}:start`);
}

export function markEnd(name: string): TimingRecord {
  performance.mark(`${name}:end`);
  const measure = performance.measure(name, `${name}:start`, `${name}:end`);
  const record: TimingRecord = { name, startMs: measure.startTime, durationMs: measure.duration };
  records.push(record);
  return record;
}

export async function timeAsync<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<{ result: T; timing: TimingRecord }> {
  markStart(name);
  const result = await fn();
  const timing = markEnd(name);
  return { result, timing };
}

export function getTimingRecords(): readonly TimingRecord[] {
  return records;
}

export function clearTimingRecords(): void {
  records.length = 0;
}
