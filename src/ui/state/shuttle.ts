// J/L shuttle rate -- design/README.md names J/L as accelerating shuttle keys but doesn't specify
// a curve. This doubles per repeated keydown while held (capped at +/-8x), resets to 0 on keyup.
// Flagged as an invented first pass, not a transcribed spec -- open to retuning once it's been
// tried against a real held-key feel.

// Task 4c: mutable so a real-hardware feel-check session can retune these live (see
// src/ui/main.tsx's dev-only `window.__tuning` exposure) without a rebuild per value tried.
// Defaults are the same first-guess values this replaced.
export const shuttleTuning = {
  baseRate: 1,
  maxRate: 8,
};

/** `direction` is -1 for J (shuttle-back) or +1 for L (shuttle-forward). Starting fresh (rate 0)
 * or reversing direction resets to the base rate; repeating the same direction doubles it. */
export function nextShuttleRate(currentRate: number, direction: -1 | 1): number {
  if (currentRate === 0 || Math.sign(currentRate) !== direction) return direction * shuttleTuning.baseRate;
  return direction * Math.min(Math.abs(currentRate) * 2, shuttleTuning.maxRate);
}
