import { describe, expect, it } from 'vitest';
import { PanelTimers } from './panel-timers.ts';
import { motion } from '../tokens.ts';
import type { Scheduler } from './panel-timers.ts';

/** Deterministic Scheduler double: records what was scheduled, runs it manually. */
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

  /** Fires every still-pending callback, as if all their delays had elapsed. */
  runAllPending(): void {
    const entries = [...this.#pending.values()];
    this.#pending.clear();
    for (const { fn } of entries) {
      fn();
    }
  }
}

describe('PanelTimers', () => {
  it('schedules hover-open at panelHoverOpenMs and fires it', () => {
    const scheduler = new FakeScheduler();
    const timers = new PanelTimers(scheduler);
    let opened = false;
    timers.scheduleHoverOpen(() => {
      opened = true;
    });
    expect(scheduler.pendingCount).toBe(1);
    scheduler.runAllPending();
    expect(opened).toBe(true);
  });

  it('re-scheduling hover-open cancels the previous timer', () => {
    const scheduler = new FakeScheduler();
    const timers = new PanelTimers(scheduler);
    let firstFired = false;
    let secondFired = false;
    timers.scheduleHoverOpen(() => {
      firstFired = true;
    });
    timers.scheduleHoverOpen(() => {
      secondFired = true;
    });
    expect(scheduler.pendingCount).toBe(1);
    scheduler.runAllPending();
    expect(firstFired).toBe(false);
    expect(secondFired).toBe(true);
  });

  it('cancelHoverOpen prevents the callback from firing', () => {
    const scheduler = new FakeScheduler();
    const timers = new PanelTimers(scheduler);
    let opened = false;
    timers.scheduleHoverOpen(() => {
      opened = true;
    });
    timers.cancelHoverOpen();
    scheduler.runAllPending();
    expect(opened).toBe(false);
  });

  it('scheduleClose cancelled by a re-entry never fires (hover-intent)', () => {
    const scheduler = new FakeScheduler();
    const timers = new PanelTimers(scheduler);
    let closed = false;
    timers.scheduleClose(() => {
      closed = true;
    });
    // Pointer re-enters the panel before the close delay elapses.
    timers.cancelClose();
    scheduler.runAllPending();
    expect(closed).toBe(false);
  });

  it('dispose cancels both pending timers', () => {
    const scheduler = new FakeScheduler();
    const timers = new PanelTimers(scheduler);
    timers.scheduleHoverOpen(() => {});
    timers.scheduleClose(() => {});
    expect(scheduler.pendingCount).toBe(2);
    timers.dispose();
    expect(scheduler.pendingCount).toBe(0);
  });

  it('uses the token module durations, not hardcoded numbers', () => {
    const scheduler = new FakeScheduler();
    const timers = new PanelTimers(scheduler);
    let capturedDelay: number | null = null;
    const originalSchedule = scheduler.schedule.bind(scheduler);
    scheduler.schedule = (fn, delayMs) => {
      capturedDelay = delayMs;
      return originalSchedule(fn, delayMs);
    };
    timers.scheduleHoverOpen(() => {});
    expect(capturedDelay).toBe(motion.panelHoverOpenMs);
  });
});
