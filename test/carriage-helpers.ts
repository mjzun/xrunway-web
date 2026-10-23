/**
 * (X)RUNWAY — SHARED M8 head-carriage case builders: the single source of
 * test-case truth for BOTH the vitest suite (test/head-carriage.test.ts) and
 * the future `head-carriage` golden-family emitter in
 * scripts/gen-golden-vectors.mjs (the case-helpers.ts pattern — the vectors
 * commit registers the family; these builders are ready for it).
 *
 * NO vitest imports allowed in this file: it must load under plain `node`
 * (the generator runs via node's TS type-stripping, exactly like
 * test/pose-derive-tape.mjs).
 *
 * The quaternion builders here are TEST-SIDE conveniences (they allocate
 * freely); the production tracker never constructs quaternions — the engine
 * wiring hands it raw getWorldQuaternion components.
 */

import {
  CarriageTracker,
  type CarriageStats,
} from "../src/head-carriage.ts";
import { headForward, makeHeadForward } from "../src/head-orient.ts";

// ---------------------------------------------------------------------------
// Quaternion builders (x, y, z, w — the Three.js component order the engine
// wiring passes down).
// ---------------------------------------------------------------------------

export type Quat = [number, number, number, number];

const DEG2RAD = Math.PI / 180;

/** Hamilton product a * b (apply b first, then a — world-frame composition). */
export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Axis-angle quaternion (axis normalized here; angle in degrees). */
export function quatAxisAngle(
  ax: number,
  ay: number,
  az: number,
  deg: number,
): Quat {
  const len = Math.hypot(ax, ay, az) || 1;
  const half = (deg * DEG2RAD) / 2;
  const s = Math.sin(half) / len;
  return [ax * s, ay * s, az * s, Math.cos(half)];
}

/**
 * A head world quaternion with the given pitch (deg, + = chin up), world
 * yaw (deg, 0 = facing the runway-frame forward (0, 0, -1), + toward -X)
 * and an optional roll about the resulting FORWARD axis (deg) — the roll
 * twin for the invariance cases: rolling about the forward ray must leave
 * every extracted quantity identical.
 *
 * Composition: q = Ry(yaw) * Rx(pitch), optionally pre-multiplied by an
 * axis-angle roll about q's own forward ray. Resulting forward:
 * (-cos(pitch) sin(yaw), sin(pitch), -cos(pitch) cos(yaw)) — so the head's
 * yaw error against a walk heading psi is exactly (psi - yaw).
 */
export function headQuat(pitchDeg: number, yawDeg = 0, rollDeg = 0): Quat {
  const qy = quatAxisAngle(0, 1, 0, yawDeg);
  const qx = quatAxisAngle(1, 0, 0, pitchDeg);
  let q = quatMul(qy, qx);
  if (rollDeg !== 0) {
    const f = headForward(q[0], q[1], q[2], q[3], makeHeadForward());
    q = quatMul(quatAxisAngle(f.x, f.y, f.z, rollDeg), q);
  }
  return q;
}

// ---------------------------------------------------------------------------
// CarriageStats fixture (the case-helpers stats() pattern): a clean walk's
// read unless overridden.
// ---------------------------------------------------------------------------

export function makeCarriage(over: Partial<CarriageStats> = {}): CarriageStats {
  return {
    pitchInBandFrac: 1,
    yawInBandFrac: 1,
    meanPitchDevDeg: 0,
    glanceCount: 0,
    firstGlanceAtSec: null,
    neutralPitchDeg: 0,
    neutralSource: "stand",
    measuredSec: 10,
    carriageScore: 98,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Tracker op-script tapes (the walk-stats op-script style): a declarative
// op list the suite AND the golden emitter replay through the REAL tracker.
// ---------------------------------------------------------------------------

/**
 * Default tape frame delta (s). Binary-exact (1/8) so repeated addition sums
 * EXACTLY — tape durations and in-band fractions come out as the clean
 * numbers the cases assert (0.1 would drift: 20 * 0.1 = 1.9999...).
 */
export const TAPE_DT = 0.125;

export type CarriageOp =
  /** Countdown entry — clears the stand accumulator. */
  | { op: "reset-neutral" }
  /** Countdown stand samples (speedMps defaults to 0 = a clean stand). */
  | {
      op: "stand";
      pitchDeg: number;
      yawDeg?: number;
      rollDeg?: number;
      speedMps?: number;
      dt?: number;
      reps?: number;
    }
  /** Walk start — resolves the neutral chain, resets the tape walk clock. */
  | { op: "begin-walk"; fitNeutralPitchRad?: number | null }
  /** Walk frames built from pitch/yaw/roll (walkYawDeg = route heading).
   *  `frozen: true` REPLAYS one bit-identical tuple (see the runner's
   *  double-cover dither note) — the frozen-pose-guard fixture. */
  | {
      op: "frame";
      pitchDeg?: number;
      yawDeg?: number;
      rollDeg?: number;
      walkYawDeg?: number;
      returning?: boolean;
      suppressed?: boolean;
      dt?: number;
      reps?: number;
      frozen?: boolean;
    }
  /** Walk frames from a raw quaternion (extraction/roll-twin cases).
   *  `frozen: true` disables the double-cover dither (bit-identical reps). */
  | {
      op: "quat-frame";
      q: Quat;
      walkYawDeg?: number;
      returning?: boolean;
      suppressed?: boolean;
      dt?: number;
      reps?: number;
      frozen?: boolean;
    }
  /** A dark frame: NaN quaternion component. REAL time still passes (the
   *  tape walk clock advances) but the tracker must credit nothing. */
  | { op: "dark-frame"; dt?: number; reps?: number }
  /** A bad-clock frame: non-positive/NaN dt (the walk clock does NOT
   *  advance — no real time passed). */
  | { op: "bad-dt-frame"; dt: number }
  /** Mid-walk runway remap — clears only the yaw channel. */
  | { op: "reset-yaw" };

export interface CarriageTapeResult {
  tracker: CarriageTracker;
  /** finalize() at tape end (non-destructive — the tracker keeps running). */
  stats: CarriageStats | null;
  livePitchDevDeg: number | null;
  liveYawDevDeg: number | null;
  engaged: boolean;
  /** The tape's walk clock at the end (s since the last begin-walk). */
  walkTime: number;
}

/**
 * Replay an op tape through the REAL production tracker.
 *
 * DOUBLE-COVER DITHER: a real fused tracker never emits two bit-identical
 * quaternion tuples at 72-90 Hz, and CarriageTracker's frozen-pose guard
 * zero-weights exact repeats — so repeated tape frames must be distinct
 * tuples WITHOUT moving a single extracted value (band-edge tapes sit
 * exactly on the +-7/-15 deg lines; any numeric dither could flip them).
 * The quaternion double cover is exactly that: q and -q are the SAME
 * rotation, and the forward-ray extraction is quadratic in the components
 * (every term is a product of two of x/y/z/w), so negating all four leaves
 * every extracted number BIT-identical while the guard sees a distinct
 * tuple. The runner alternates the sign per fed frame (one tape-global
 * parity, so consecutive ops with the same rotation stay distinct too).
 * Ops with `frozen: true` skip the dither and replay one bit-identical
 * tuple — the deliberate frozen-tracking fixture.
 */
export function runCarriageTape(
  ops: readonly CarriageOp[],
  tracker: CarriageTracker = new CarriageTracker(),
): CarriageTapeResult {
  let walkTime = 0;
  let frameParity = 0; // tape-global double-cover parity (walk frames only)
  for (const o of ops) {
    switch (o.op) {
      case "reset-neutral":
        tracker.resetNeutral();
        break;
      case "stand": {
        const q = headQuat(o.pitchDeg, o.yawDeg ?? 0, o.rollDeg ?? 0);
        const dt = o.dt ?? TAPE_DT;
        const reps = o.reps ?? 1;
        for (let i = 0; i < reps; i++) {
          tracker.addNeutralSample(q[0], q[1], q[2], q[3], o.speedMps ?? 0, dt);
        }
        break;
      }
      case "begin-walk":
        tracker.beginWalk(o.fitNeutralPitchRad ?? null);
        walkTime = 0;
        break;
      case "frame": {
        const q = headQuat(o.pitchDeg ?? 0, o.yawDeg ?? 0, o.rollDeg ?? 0);
        const dt = o.dt ?? TAPE_DT;
        const reps = o.reps ?? 1;
        const walkYawRad = (o.walkYawDeg ?? 0) * DEG2RAD;
        for (let i = 0; i < reps; i++) {
          walkTime += dt;
          // Double-cover dither (see the runner doc): -q on odd parity,
          // bit-identical extraction. Frozen ops replay the exact tuple.
          const s = o.frozen === true ? 1 : frameParity++ % 2 === 0 ? 1 : -1;
          tracker.update(
            s * q[0],
            s * q[1],
            s * q[2],
            s * q[3],
            walkYawRad,
            o.returning ?? false,
            o.suppressed ?? false,
            dt,
            walkTime,
          );
        }
        break;
      }
      case "quat-frame": {
        const dt = o.dt ?? TAPE_DT;
        const reps = o.reps ?? 1;
        const walkYawRad = (o.walkYawDeg ?? 0) * DEG2RAD;
        for (let i = 0; i < reps; i++) {
          walkTime += dt;
          const s = o.frozen === true ? 1 : frameParity++ % 2 === 0 ? 1 : -1;
          tracker.update(
            s * o.q[0],
            s * o.q[1],
            s * o.q[2],
            s * o.q[3],
            walkYawRad,
            o.returning ?? false,
            o.suppressed ?? false,
            dt,
            walkTime,
          );
        }
        break;
      }
      case "dark-frame": {
        const dt = o.dt ?? TAPE_DT;
        const reps = o.reps ?? 1;
        for (let i = 0; i < reps; i++) {
          walkTime += dt; // real time passed; the tracker credits nothing
          tracker.update(NaN, 0, 0, 1, 0, false, false, dt, walkTime);
        }
        break;
      }
      case "bad-dt-frame":
        tracker.update(0, 0, 0, 1, 0, false, false, o.dt, walkTime);
        break;
      case "reset-yaw":
        tracker.resetYawChannel();
        break;
    }
  }
  return {
    tracker,
    stats: tracker.finalize(),
    livePitchDevDeg: tracker.livePitchDevDeg,
    liveYawDevDeg: tracker.liveYawDevDeg,
    engaged: tracker.engaged,
    walkTime,
  };
}

/** The standard calibrated prelude: a 1 s clean stand at `pitchDeg`, then
 *  walk start — most tapes begin here (neutral = pitchDeg, source "stand"). */
export function calibrated(
  pitchDeg = 0,
  fitNeutralPitchRad: number | null = null,
): CarriageOp[] {
  return [
    { op: "reset-neutral" },
    { op: "stand", pitchDeg, reps: 8 },
    { op: "begin-walk", fitNeutralPitchRad },
  ];
}
