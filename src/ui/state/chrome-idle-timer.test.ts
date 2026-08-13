import { describe, expect, it } from 'vitest';
import { ChromeIdleTimer } from './chrome-idle-timer.ts';
import { motion } from '../tokens.ts';
import type { Scheduler } from './panel-timers.ts';

/** Deterministic Scheduler double: records what was scheduled, runs it manually. Mirrors
 * ./panel-timers.test.ts's FakeScheduler. */
class FakeScheduler implements Scheduler {
  #nextId = 1;
  #pending = new Map<number, { fn: () => void; delayMs: number }>();

  schedule(fn: () => void, delayMs: number): number {
    const id = this.#nextId++;
    this.#pending.set(id, { fn, delayMs });
    return id;
  }

  cancel(id: number): void {
    this.#pending.delete(id);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  runAllPending(): void {
    const entries = [...this.#pending.values()];
    this.#pending.clear();
    for (const { fn } of entries) {
      fn();
    }
  }
}

describe('ChromeIdleTimer', () => {
  it('arms and fires onHide when not suppressed', () => {
    const scheduler = new FakeScheduler();
    const timer = new ChromeIdleTimer(scheduler);
    let hidden = false;
    timer.arm(false, () => {
      hidden = true;
    });
    expect(scheduler.pendingCount).toBe(1);
    scheduler.runAllPending();
    expect(hidden).toBe(true);
  });

  it('arm(true, ...) schedules nothing', () => {
    const scheduler = new FakeScheduler();
    const timer = new ChromeIdleTimer(scheduler);
    let hidden = false;
    timer.arm(true, () => {
      hidden = true;
    });
    expect(scheduler.pendingCount).toBe(0);
    scheduler.runAllPending();
    expect(hidden).toBe(false);
  });

  it('re-arming cancels the previous timer', () => {
    const scheduler = new FakeScheduler();
    const timer = new ChromeIdleTimer(scheduler);
    let firstFired = false;
    let secondFired = false;
    timer.arm(false, () => {
      firstFired = true;
    });
    timer.arm(false, () => {
      secondFired = true;
    });
    expect(scheduler.pendingCount).toBe(1);
    scheduler.runAllPending();
    expect(firstFired).toBe(false);
    expect(secondFired).toBe(true);
  });

  it('cancel prevents onHide from firing', () => {
    const scheduler = new FakeScheduler();
    const timer = new ChromeIdleTimer(scheduler);
    let hidden = false;
    timer.arm(false, () => {
      hidden = true;
    });
    timer.cancel();
    scheduler.runAllPending();
    expect(hidden).toBe(false);
  });

  it('dispose cancels any pending timer', () => {
    const scheduler = new FakeScheduler();
    const timer = new ChromeIdleTimer(scheduler);
    timer.arm(false, () => {});
    expect(scheduler.pendingCount).toBe(1);
    timer.dispose();
    expect(scheduler.pendingCount).toBe(0);
  });

  it('uses motion.chromeIdleMs, not a hardcoded duration', () => {
    const scheduler = new FakeScheduler();
    const timer = new ChromeIdleTimer(scheduler);
    let capturedDelay: number | null = null;
    const originalSchedule = scheduler.schedule.bind(scheduler);
    scheduler.schedule = (fn, delayMs) => {
      capturedDelay = delayMs;
      return originalSchedule(fn, delayMs);
    };
    timer.arm(false, () => {});
    expect(capturedDelay).toBe(motion.chromeIdleMs);
  });
});
