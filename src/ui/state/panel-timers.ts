// Rail hover-open (400ms) / panel close (220ms, cancelled on pointer re-entry) timing, per
// design/README.md's Pointer table. Takes an injectable Scheduler rather than calling setTimeout
// directly -- the same testability-seam pattern as ByteSource/VideoElementLike in src/media/ --
// so tests drive it deterministically instead of waiting on real timers.

import { motion } from '../tokens.ts';

export interface Scheduler {
  schedule(fn: () => void, delayMs: number): number;
  cancel(id: number): void;
}

export const realScheduler: Scheduler = {
  schedule: (fn, delayMs) => setTimeout(fn, delayMs) as unknown as number,
  cancel: (id) => {
    clearTimeout(id);
  },
};

export class PanelTimers {
  readonly #scheduler: Scheduler;
  #openTimer: number | null = null;
  #closeTimer: number | null = null;

  constructor(scheduler: Scheduler = realScheduler) {
    this.#scheduler = scheduler;
  }

  /** Hovering a rail icon for panelHoverOpenMs opens it, per design/README.md. */
  scheduleHoverOpen(onOpen: () => void): void {
    this.cancelHoverOpen();
    this.#openTimer = this.#scheduler.schedule(onOpen, motion.panelHoverOpenMs);
  }

  cancelHoverOpen(): void {
    if (this.#openTimer !== null) {
      this.#scheduler.cancel(this.#openTimer);
      this.#openTimer = null;
    }
  }

  /** Leaving a floating panel closes it after panelCloseMs unless the pointer re-enters. */
  scheduleClose(onClose: () => void): void {
    this.cancelClose();
    this.#closeTimer = this.#scheduler.schedule(onClose, motion.panelCloseMs);
  }

  cancelClose(): void {
    if (this.#closeTimer !== null) {
      this.#scheduler.cancel(this.#closeTimer);
      this.#closeTimer = null;
    }
  }

  dispose(): void {
    this.cancelHoverOpen();
    this.cancelClose();
  }
}
