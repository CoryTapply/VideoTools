import { describe, expect, it } from 'vitest';
import { PriorityScheduler, type ScheduledItem } from './scheduler';

function items(...times: number[]): ScheduledItem<number>[] {
  return times.map((time) => ({ key: `k${String(time)}`, time, payload: time }));
}

describe('PriorityScheduler', () => {
  it('takeNext returns items closest to center first', () => {
    const scheduler = new PriorityScheduler<number>();
    scheduler.reset(items(0, 4000, 8000, 12000), 8000);
    const taken = scheduler.takeNext(4);
    expect(taken.map((i) => i.time)).toEqual([8000, 4000, 12000, 0]);
  });

  it('"coarse tier builds outward from the playhead": passing the playhead as center orders from it, not from t=0', () => {
    const scheduler = new PriorityScheduler<number>();
    scheduler.reset(items(0, 41000, 41660, 83000), 41660); // playhead mid-file
    expect(scheduler.takeNext(1)[0]?.time).toBe(41660);
    expect(scheduler.takeNext(1)[0]?.time).toBe(41000); // next-closest, not t=0
  });

  it('takeNext removes taken items from the pending set', () => {
    const scheduler = new PriorityScheduler<number>();
    scheduler.reset(items(0, 1000), 0);
    expect(scheduler.pendingCount).toBe(2);
    scheduler.takeNext(1);
    expect(scheduler.pendingCount).toBe(1);
  });

  it('takeNext with count greater than pendingCount returns only what is available, without throwing', () => {
    const scheduler = new PriorityScheduler<number>();
    scheduler.reset(items(0, 1000), 0);
    const taken = scheduler.takeNext(10);
    expect(taken).toHaveLength(2);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('setCenter re-orders subsequent takeNext calls without changing pendingCount', () => {
    const scheduler = new PriorityScheduler<number>();
    scheduler.reset(items(0, 5000, 10000), 0);
    scheduler.setCenter(10000);
    expect(scheduler.pendingCount).toBe(3);
    expect(scheduler.takeNext(1)[0]?.time).toBe(10000);
  });

  it('cancelOutOfRange removes and returns keys for pending items outside the range, and reduces total', () => {
    const scheduler = new PriorityScheduler<number>();
    scheduler.reset(items(0, 5000, 10000, 20000), 10000);
    const cancelled = scheduler.cancelOutOfRange(4000, 12000);
    expect(cancelled.sort()).toEqual(['k0', 'k20000'].sort());
    expect(scheduler.pendingCount).toBe(2);
    expect(scheduler.progress.total).toBe(2);
  });

  it('cancelOutOfRange with everything in range removes nothing', () => {
    const scheduler = new PriorityScheduler<number>();
    scheduler.reset(items(1000, 2000), 1500);
    expect(scheduler.cancelOutOfRange(0, 5000)).toEqual([]);
    expect(scheduler.pendingCount).toBe(2);
  });

  it('progress tracks completed against the original total, unaffected by takeNext alone', () => {
    const scheduler = new PriorityScheduler<number>();
    scheduler.reset(items(0, 1000, 2000), 0);
    expect(scheduler.progress).toEqual({ completed: 0, total: 3 });
    scheduler.takeNext(2);
    expect(scheduler.progress).toEqual({ completed: 0, total: 3 });
    scheduler.markCompleted(2);
    expect(scheduler.progress).toEqual({ completed: 2, total: 3 });
  });

  it('markCompleted never exceeds total, even if called too many times', () => {
    const scheduler = new PriorityScheduler<number>();
    scheduler.reset(items(0, 1000), 0);
    scheduler.markCompleted(5);
    expect(scheduler.progress.completed).toBe(2);
  });

  it('reset() replaces the item set and restarts progress accounting', () => {
    const scheduler = new PriorityScheduler<number>();
    scheduler.reset(items(0, 1000), 0);
    scheduler.takeNext(1);
    scheduler.markCompleted(1);
    scheduler.reset(items(5000, 6000, 7000), 5000); // e.g. dense tier rebuilt around a new viewport
    expect(scheduler.pendingCount).toBe(3);
    expect(scheduler.progress).toEqual({ completed: 0, total: 3 });
  });
});
