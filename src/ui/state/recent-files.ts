// A lightweight "Recent" list for the empty state -- design/empty-state-changes.md sketches a
// full File System Access handle store (IndexedDB, queryPermission/requestPermission re-acquire).
// Nothing like that exists in this codebase: files open via a plain <input type="file">, which
// yields a one-shot File with no handle to persist or silently reopen. Per product direction, this
// is the scoped-down version -- a localStorage-backed {name, openedAt} list. Clicking a row can't
// reopen the exact file without a prompt (the browser won't allow that), so it just triggers the
// same file-picker path as "Choose file" / "Open".
//
// Takes an injectable KeyValueStorage rather than calling `localStorage` directly, the same
// testability-seam pattern as `Scheduler` in panel-timers.ts.

const STORAGE_KEY = 'videotools.recentFiles';
const MAX_ENTRIES = 5;

export interface RecentFileEntry {
  name: string;
  openedAt: number;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// typeof-guarded so this module loads safely under the Node test environment (no `localStorage`
// global) as well as jsdom/real browsers -- mirrors panel-timers.ts's `realScheduler`.
export const browserStorage: KeyValueStorage =
  typeof localStorage !== 'undefined'
    ? localStorage
    : {
        getItem: () => null,
        setItem: () => {
          // No-op outside a browser-like environment.
        },
      };

function isRecentFileEntry(value: unknown): value is RecentFileEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).name === 'string' &&
    typeof (value as Record<string, unknown>).openedAt === 'number'
  );
}

export function loadRecentFiles(storage: KeyValueStorage = browserStorage): RecentFileEntry[] {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecentFileEntry) : [];
  } catch {
    return [];
  }
}

/** Dedups by name (moving a reopened file to the front with a fresh timestamp), caps at 5. */
export function recordRecentFile(name: string, storage: KeyValueStorage = browserStorage, now: number = Date.now()): void {
  const existing = loadRecentFiles(storage).filter((entry) => entry.name !== name);
  const updated = [{ name, openedAt: now }, ...existing].slice(0, MAX_ENTRIES);
  storage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Buckets by calendar-day difference: today / yesterday / N days ago / last week / N weeks ago / Mon D[, YYYY]. */
export function formatRecentWhen(openedAt: number, now: number = Date.now()): string {
  const dayDiff = Math.round((startOfDay(now) - startOfDay(openedAt)) / 86_400_000);

  if (dayDiff <= 0) return 'today';
  if (dayDiff === 1) return 'yesterday';
  if (dayDiff < 7) return `${dayDiff.toString()} days ago`;
  if (dayDiff < 14) return 'last week';
  if (dayDiff < 30) return `${Math.floor(dayDiff / 7).toString()} weeks ago`;

  const opened = new Date(openedAt);
  const monthDay = opened.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const sameYear = new Date(now).getFullYear() === opened.getFullYear();
  return sameYear ? monthDay : `${monthDay}, ${opened.getFullYear().toString()}`;
}
