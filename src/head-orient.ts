/**
 * (X)RUNWAY — head-orientation extraction: the ONE quaternion -> forward-
 * vector convention shared by every head-orientation channel (M8 head
 * carriage in head-carriage.ts, M10 hold stillness in hold-stats.ts).
 *
 * WHY THIS FILE EXISTS (Wave 1 adjudication §D): two channels read the head
 * quaternion; two hand-rolled extractions would eventually disagree on a
 * sign and ship two different "pitch" claims for the same head. Both pure
 * trackers import THIS math, the golden families of both carry twin cases
 * asserting identical pitch for a shared quaternion set, and the engine
 * wiring (metrics.ts / show.ts) reads player.head.getWorldQuaternion into
 * ONE preallocated Quaternion and passes the raw components down.
 *
 * THE CONVENTION (pinned):
 * - The head's forward ray is the local -Z axis rotated by the head WORLD
 *   quaternion — computed in scalar form below, NEVER via
 *   Object3D.getWorldDirection (Camera overrides it to return -Z-forward
 *   while plain Object3D returns +Z-forward; the headset rig has exposed
 *   both flavors, so the API is a sign trap this module exists to bury).
 * - pitch = asin(forward.y), POSITIVE = chin up (head pitched above the
 *   horizon). Roll-immune by construction: rolling the head about its own
 *   forward axis does not move the forward ray.
 * - Yaw semantics stay CONSUMER-SIDE on the horizontal components (fx, fz):
 *   M8 measures yaw ERROR against a route heading via atan2(cross, dot);
 *   the hold measures yaw DISPERSION about the window mean. Each consumer
 *   also owns its own measurability gate on `horiz` (the yaw of a nearly
 *   vertical forward ray is numerically meaningless; M8 gates at 0.35,
 *   the hold unwraps only above sin 5 deg) — the gates differ because the
 *   channels tolerate different noise, so they live at the consumers.
 *
 * Dependency-free by design (no @iwsdk/core, no DOM) so the golden-vector
 * generator and vitest import the REAL code — the pose-derive.ts pattern.
 * Zero allocation: the caller owns the out-scratch.
 *
 * FINITENESS LAW: this is pure math — a non-finite quaternion component
 * yields a non-finite forward vector. Consumers treat any non-finite
 * component as a dark frame (the kpOk law); the engine wiring must never
 * pre-filter on behalf of the trackers, so the gate lives exactly once, in
 * each tracker's ingest.
 */

/** Caller-owned scratch for the extracted forward ray. */
export interface HeadForward {
  /** World-space forward ray components (unit-ish for a unit quaternion). */
  x: number;
  y: number;
  z: number;
  /** Horizontal magnitude hypot(x, z) — the consumers' yaw-measurability
   *  input, computed here so both channels gate on the SAME number. */
  horiz: number;
}

/** A fresh scratch (allocate once per tracker, never per frame). */
export function makeHeadForward(): HeadForward {
  return { x: 0, y: 0, z: -1, horiz: 1 };
}

/**
 * Rotate the local -Z axis by the (unit) world quaternion (qx, qy, qz, qw),
 * writing into `out`. Scalar expansion of q * (0,0,-1) * q^-1:
 *
 *   f = (-2(qw*qy + qx*qz),  2(qw*qx - qy*qz),  2(qx^2 + qy^2) - 1)
 *
 * Identity (0,0,0,1) -> (0, 0, -1); a +90 deg yaw about +Y
 * (0, sin45, 0, cos45) -> (-1, 0, 0) — the Three.js rotation convention.
 */
export function headForward(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  out: HeadForward,
): HeadForward {
  out.x = -2 * (qw * qy + qx * qz);
  out.y = 2 * (qw * qx - qy * qz);
  out.z = 2 * (qx * qx + qy * qy) - 1;
  out.horiz = Math.hypot(out.x, out.z);
  return out;
}

/**
 * Head pitch (radians) from the forward ray's y component: asin, input
 * clamped to [-1, 1] (a slightly non-unit quaternion must not NaN the asin).
 * POSITIVE = chin up. Non-finite input propagates (dark-frame law — the
 * consumer's gate owns it).
 */
export function pitchOf(fy: number): number {
  if (!Number.isFinite(fy)) return fy;
  const c = fy < -1 ? -1 : fy > 1 ? 1 : fy;
  return Math.asin(c);
}
