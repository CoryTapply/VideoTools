// Kinetic pan: an EMA-smoothed velocity from wheel deltas, coasting via exponential decay once
// the gesture ends. This is a new design decision, not a transcribed spec -- no existing code
// (not design/README.md, not the reference prototype, whose wheel handler pans 1:1 with no
// momentum) defines this physics. Self-contained on purpose so it's trivial to rip out if it
// doesn't feel right against real hardware; the friction constant below is a first guess that
// needs tuning against a real trackpad, not something derivable from a spec.

/** Weight on the newest sample vs. the running average when a new wheel delta arrives. */
const VELOCITY_EMA_ALPHA = 0.3;

/** Multiplies velocity per ~16.7ms frame while coasting. Closer to 1 = coasts longer. Needs
 * empirical tuning on real hardware -- flagged, not guessable from a spec. */
export const COAST_FRICTION_PER_FRAME = 0.94;

const REFERENCE_FRAME_MS = 16.7;

/** Blends a new instantaneous sample (deltaTicks over deltaMs) into the running velocity. */
export function updateVelocity(previousVelocity: number, deltaTicks: number, deltaMs: number): number {
  if (deltaMs <= 0) return previousVelocity;
  const instantaneous = deltaTicks / deltaMs;
  return previousVelocity * (1 - VELOCITY_EMA_ALPHA) + instantaneous * VELOCITY_EMA_ALPHA;
}

/** Applies one coast step's friction, scaled to the actual elapsed frame time so coasting feels
 * the same regardless of the display's real refresh rate. */
export function decayVelocity(velocity: number, frameDtMs: number): number {
  if (frameDtMs <= 0) return velocity;
  return velocity * Math.pow(COAST_FRICTION_PER_FRAME, frameDtMs / REFERENCE_FRAME_MS);
}

export function isCoastingDone(velocity: number, stopThresholdTicksPerMs: number): boolean {
  return Math.abs(velocity) < stopThresholdTicksPerMs;
}
