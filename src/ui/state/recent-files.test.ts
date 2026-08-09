import { describe, expect, it } from 'vitest';
import { formatRecentWhen, loadRecentFiles, recordRecentFile } from './recent-files.ts';
import type { KeyValueStorage } from './recent-files.ts';

function fakeStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

const DAY = 86_400_000;

describe('recordRecentFile / loadRecentFiles', () => {
  it('round-trips a single entry', () => {
    const storage = fakeStorage();
    recordRecentFile('session-4.mp4', storage, 1000);
    expect(loadRecentFiles(storage)).toEqual([{ name: 'session-4.mp4', openedAt: 1000 }]);
  });

  it('returns an empty list when nothing has been recorded', () => {
    expect(loadRecentFiles(fakeStorage())).toEqual([]);
  });

  it('most-recently-opened file is first', () => {
    const storage = fakeStorage();
    recordRecentFile('a.mp4', storage, 1000);
    recordRecentFile('b.mp4', storage, 2000);
    expect(loadRecentFiles(storage).map((e) => e.name)).toEqual(['b.mp4', 'a.mp4']);
  });

  it('reopening an existing name dedups and moves it to the front with a fresh timestamp', () => {
    const storage = fakeStorage();
    recordRecentFile('a.mp4', storage, 1000);
    recordRecentFile('b.mp4', storage, 2000);
    recordRecentFile('a.mp4', storage, 3000);
    expect(loadRecentFiles(storage)).toEqual([
      { name: 'a.mp4', openedAt: 3000 },
      { name: 'b.mp4', openedAt: 2000 },
    ]);
  });

  it('caps at 5 entries, dropping the oldest', () => {
    const storage = fakeStorage();
    for (let i = 0; i < 7; i++) {
      recordRecentFile(`file-${i.toString()}.mp4`, storage, i);
    }
    const names = loadRecentFiles(storage).map((e) => e.name);
    expect(names).toEqual(['file-6.mp4', 'file-5.mp4', 'file-4.mp4', 'file-3.mp4', 'file-2.mp4']);
  });

  it('ignores unparsable stored data', () => {
    const storage = fakeStorage();
    storage.setItem('videotools.recentFiles', 'not json');
    expect(loadRecentFiles(storage)).toEqual([]);
  });

  it('ignores malformed stored entries', () => {
    const storage = fakeStorage();
    storage.setItem('videotools.recentFiles', JSON.stringify([{ name: 'ok.mp4', openedAt: 1 }, { name: 42 }, 'garbage']));
    expect(loadRecentFiles(storage)).toEqual([{ name: 'ok.mp4', openedAt: 1 }]);
  });
});

describe('formatRecentWhen', () => {
  const now = new Date('2026-08-09T12:00:00').getTime();

  it('same calendar day -> today', () => {
    expect(formatRecentWhen(now - 60_000, now)).toBe('today');
  });

  it('previous calendar day -> yesterday', () => {
    expect(formatRecentWhen(now - DAY, now)).toBe('yesterday');
  });

  it('2-6 days ago -> "N days ago"', () => {
    expect(formatRecentWhen(now - 3 * DAY, now)).toBe('3 days ago');
  });

  it('7-13 days ago -> last week', () => {
    expect(formatRecentWhen(now - 9 * DAY, now)).toBe('last week');
  });

  it('14-29 days ago -> "N weeks ago"', () => {
    expect(formatRecentWhen(now - 15 * DAY, now)).toBe('2 weeks ago');
  });

  it('30+ days ago, same year -> "Mon D"', () => {
    const opened = new Date('2026-06-29T12:00:00').getTime();
    expect(formatRecentWhen(opened, now)).toBe('Jun 29');
  });

  it('30+ days ago, different year -> "Mon D, YYYY"', () => {
    const opened = new Date('2025-06-29T12:00:00').getTime();
    expect(formatRecentWhen(opened, now)).toBe('Jun 29, 2025');
  });
});
