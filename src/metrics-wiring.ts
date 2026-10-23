/**
 * (X)RUNWAY — metrics WIRING constants + display-smoothing forms, in a pure
 * module (SOLO-MODE §6 single-sourcing; review finding #12).
 *
 * These are the seams the Swift Solo port re-implements around the scoring
 * core: the neutral score bars start from, the ~6 Hz publish cadence, and the
 * display ramp/blend smoothing. They used to live as private constants inside
 * @iwsdk/core-coupled metrics.ts with hand-replicated copies in
 * test/pose-tapes.ts and scripts/gen-golden-vectors.mjs — a change to the
 * live wiring would have left the replicas (and therefore the walk-replay
 * vectors) silently pinning the OLD behavior. Now metrics.ts, the tape
 * driver, and the golden generator all import THIS module, so the vectors
 * and the app provably share one truth (the pose-derive.ts pattern already
 * used for SCORE_MIN/STEP_MIN/RING_SIZE).
 *
 * Dependency-free by design (no @iwsdk/core, no DOM) so it loads under plain
 * node for the generator and in vitest — the walk-stats.ts pattern.
 */

/** Score every metric bar starts/ramps from (metrics.ts beginWalkTracking
 *  fills targets/smooth/snapshot with it). */
export const NEUTRAL = 62;

/** Rounded-snapshot publish interval (s) — the ~6 Hz metrics tick. */
export const PUBLISH_INTERVAL = 1 / 6;

/** Display values ramp in from NEUTRAL over this many seconds of walk time
 *  so bars never jump on incomplete data. */
export const RAMP_IN_SEC = 2;

/** Rate constant of the display blend toward the ramped target. */
export const DISPLAY_BLEND_RATE = 3;

/** Ramp-in weight at `walkTime` seconds into the walk: linear 0..1 over the
 *  first RAMP_IN_SEC, then 1. (metrics.ts update() display smoothing.) */
export function rampInWeight(walkTime: number): number {
  return walkTime < RAMP_IN_SEC ? walkTime / RAMP_IN_SEC : 1;
}

/** Per-frame display blend factor: 1 - exp(-DISPLAY_BLEND_RATE * dt) — the
 *  frame-rate-independent EMA form shared with the scoring core. */
export function displayBlend(delta: number): number {
  return 1 - Math.exp(-DISPLAY_BLEND_RATE * delta);
}
