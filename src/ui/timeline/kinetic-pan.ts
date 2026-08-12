// Kinetic pan: an EMA-smoothed velocity from wheel deltas, coasting via exponential decay once
// the gesture ends. This is a new design decision, not a transcribed spec -- no existing code
// (not design/README.md, not the reference prototype, whose wheel handler pans 1:1 with no
// momentum) defines this physics. Self-contained on purpose so it's trivial to rip out if it
// doesn't feel right against real hardware.

/** Task 4c: mutable so a real-hardware feel-check session can retune these live (see
 * src/ui/main.tsx's dev-only `window.__tuning` exposure) without a rebuild per value tried. */
export const kineticPanTuning = {
  /** Weight on the newest sample vs. the running average when a new wheel delta arrives. */
  velocityEmaAlpha: 0.3,
  /** Multiplies velocity per ~16.7ms frame while coasting. Closer to 1 = coasts longer.
   * Confirmed via real-hardware feel-check (Task 4c, 2026-08-11): the original 0.94 guess coasted
   * far too long -- 0.1 kills velocity almost immediately after the gesture ends, closer to the
   * reference prototype's original 1:1-no-momentum feel than to real inertial coasting. */
  coastFrictionPerFrame: 0.1,
};

const REFERENCE_FRAME_MS = 16.7;

/** Blends a new instantaneous sample (deltaTicks over deltaMs) into the running velocity. */
export function updateVelocity(previousVelocity: number, deltaTicks: number, deltaMs: number): number {
  if (deltaMs <= 0) return previousVelocity;
  const instantaneous = deltaTicks / deltaMs;
  return previousVelocity * (1 - kineticPanTuning.velocityEmaAlpha) + instantaneous * kineticPanTuning.velocityEmaAlpha;
}

/** Applies one coast step's friction, scaled to the actual elapsed frame time so coasting feels
 * the same regardless of the display's real refresh rate. */
export function decayVelocity(velocity: number, frameDtMs: number): number {
  if (frameDtMs <= 0) return velocity;
  return velocity * Math.pow(kineticPanTuning.coastFrictionPerFrame, frameDtMs / REFERENCE_FRAME_MS);
}

export function isCoastingDone(velocity: number, stopThresholdTicksPerMs: number): boolean {
  return Math.abs(velocity) < stopThresholdTicksPerMs;
}
