// The 2000ms chrome auto-hide idle timer -- design/floating-chrome-changes.md's "5. Auto-hide
// behaviour". Same injectable-Scheduler testability seam as ./panel-timers.ts's PanelTimers.

import { motion } from '../tokens.ts';
import { realScheduler } from './panel-timers.ts';
import type { Scheduler } from './panel-timers.ts';

export class ChromeIdleTimer {
  readonly #scheduler: Scheduler;
  #timer: number | null = null;

  constructor(scheduler: Scheduler = realScheduler) {
    this.#scheduler = scheduler;
  }

  /** (Re-)arms a motion.chromeIdleMs timer that calls `onHide` on expiry. While `suppressed` is
   * true (hover-pinned, a panel open/pinned, or the shortcut sheet open -- design/README.md's pin
   * conditions), any pending timer is cancelled and none is armed: "the timer simply does not
   * hide" rather than firing anyway once suppression lifts. */
  arm(suppressed: boolean, onHide: () => void): void {
    this.cancel();
    if (suppressed) return;
    this.#timer = this.#scheduler.schedule(onHide, motion.chromeIdleMs);
  }

  cancel(): void {
    if (this.#timer !== null) {
      this.#scheduler.cancel(this.#timer);
      this.#timer = null;
    }
  }

  dispose(): void {
    this.cancel();
  }
}
