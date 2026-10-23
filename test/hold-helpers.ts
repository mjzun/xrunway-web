/**
 * (X)RUNWAY — SHARED hold case builders: the single source of test-case
 * truth for BOTH the vitest suite (test/hold-stats.test.ts) and the future
 * golden-vector emitter for the "hold-stats" family
 * (scripts/gen-golden-vectors.mjs — registered in the VECTORS commit).
 *
 * NO vitest imports allowed in this file: it must load under plain `node`
 * (the generator runs via node's TS type-stripping) — the case-helpers.ts
 * rule. Assertions stay in the suite.
 *
 * The tapes here are the family's analytic anchors, so their closed forms
 * are documented at the builder: a still tape's RMS is exactly 0, a bolt
 * sweep's std is L / sqrt(12), a two-level step's RMS is half the step.
 */

import {
  HOLD_WINDOW_SEC,
  HoldAccumulator,
  type HoldHeightSource,
  type HoldStats,
} from "../src/hold-stats.ts";

// ---------------------------------------------------------------------------
// Quaternions (test-side composers; the forward extraction itself is
// head-orient.ts's and is never re-derived here).
// ---------------------------------------------------------------------------

/** Raw quaternion components, the accumulator's ingest order. */
export interface Quat {
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export const Q_IDENTITY: Quat = { qx: 0, qy: 0, qz: 0, qw: 1 };

/** Pure pitch about +X: + = chin up (forward.y = sin(pitch)). */
export function quatPitch(pitchRad: number): Quat {
  return {
    qx: Math.sin(pitchRad / 2),
    qy: 0,
    qz: 0,
    qw: Math.cos(pitchRad / 2),
  };
}

/** Pure yaw about +Y: yaw = atan2(-fx, -fz) reads back exactly this. */
export function quatYaw(yawRad: number): Quat {
  return {
    qx: 0,
    qy: Math.sin(yawRad / 2),
    qz: 0,
    qw: Math.cos(yawRad / 2),
  };
}

/**
 * Yaw about +Y composed onto pitch about +X (q = qYaw * qPitch), the
 * head-like order: pitch in the head's own frame, then face a heading.
 * Forward = (-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch)), so the
 * extracted pitch/yaw read back exactly (pitchRad, yawRad) for |pitch| < 90.
 */
export function quatYawPitch(yawRad: number, pitchRad: number): Quat {
  const sy = Math.sin(yawRad / 2);
  const cy = Math.cos(yawRad / 2);
  const sp = Math.sin(pitchRad / 2);
  const cp = Math.cos(pitchRad / 2);
  return { qx: cy * sp, qy: sy * cp, qz: -sy * sp, qw: cy * cp };
}

/**
 * Sub-noise sensor dither (rad): a REAL fused tracker never repeats a
 * bit-identical tuple, so realistic tapes carry a +-1e-9 rad pitch
 * alternation — invisible to every statistic (5.7e-8 deg, vanishes under
 * round1) but distinct to the frozen-pose guard. Tapes that WANT the guard
 * to fire simply repeat an exact frame instead.
 */
export function ditherQ(i: number): Quat {
  return quatPitch(((i % 2) * 2 - 1) * 1e-9);
}

// ---------------------------------------------------------------------------
// Tapes: one frame per HOLD_TAPE_DT, frame i ending at t = (i + 1) * dt.
//
// ARMING (the arrival law, hold-stats.ts): the accumulator folds nothing
// until a frame arrives with |dAlong| <= HOLD_ARRIVE_EPS_M (0.05) or a
// frame-to-frame speed below HOLD_SPEED_STILL_MPS. On these grid tapes an
// already-settled shape therefore arms on frame 0 (t = dt) when its
// |dAlong| <= 0.05, else on frame 1 (t = 2 dt) via zero speed — so a tape
// that wants the accumulator to measure a FULL window must extend
// HOLD_TAPE_FRAMES + 2 frames (out to tArm + HOLD_WINDOW_SEC on either
// arming variant). The builders below do; slices of them model truncation.
// ---------------------------------------------------------------------------

/** One ingest frame: `t` = tSinceMarkSec at frame END. */
export interface HoldFrame {
  t: number;
  dt: number;
  dAlong: number;
  lat: number;
  q: Quat;
}

/** 20 Hz — a clean decimal grid that divides the 1.6 s window into exactly
 *  32 frames (and halves at 0.8 s, the step tape's switch point). */
export const HOLD_TAPE_DT = 0.05;

export const HOLD_TAPE_FRAMES = Math.round(HOLD_WINDOW_SEC / HOLD_TAPE_DT); // 32

/** Frames a settled-shape tape needs to fill the REBASED window whichever
 *  arming variant fires (frame 0 via position, frame 1 via speed): 34. */
export const HOLD_TAPE_FRAMES_ARMED = HOLD_TAPE_FRAMES + 2;

/** Build a tape of `n` frames on the grid from a per-frame shape function. */
export function tape(
  n: number,
  at: (i: number, t: number) => { dAlong: number; lat: number; q?: Quat },
  dt: number = HOLD_TAPE_DT,
): HoldFrame[] {
  const out: HoldFrame[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 1) * dt;
    const f = at(i, t);
    out.push({ t, dt, dAlong: f.dAlong, lat: f.lat, q: f.q ?? ditherQ(i) });
  }
  return out;
}

/**
 * A trainee who stood and froze at (dAlong, lat): position bit-constant
 * (RMS exactly 0; the window mean IS the position), orientation carrying
 * only the sensor dither (so the frozen-pose guard never fires — a REAL
 * still trainee is live-still, not tracking-frozen). Arms on frame 0 when
 * |dAlong| <= HOLD_ARRIVE_EPS_M, else on frame 1 via zero speed; 34 frames
 * cover the full rebased window either way. Closed forms: stillnessRmsCm =
 * 0, markAlongCm = dAlong * 100, markLatCm = lat * 100, liveStill01 = 1,
 * timeInWindowSec = HOLD_WINDOW_SEC.
 */
export function stillTape(dAlong: number, lat: number): HoldFrame[] {
  return tape(HOLD_TAPE_FRAMES_ARMED, () => ({ dAlong, lat }));
}

/**
 * A bolter sweeping through the mark at `speedMps` along the route:
 * dAlong(t) = start + speed * t. The window ARMS at the first grid frame
 * inside HOLD_ARRIVE_EPS_M of the mark (sweep speed >= the 0.25 m/s
 * speed-arm bound, so position is the only arming path) and measures the
 * NEXT 1.6 s of sweep — the tape extends past the crossing by a full
 * window, so the measured positions are a uniform grid over
 * L = speed * HOLD_WINDOW_SEC and std = L * sqrt(1 - 1/n^2) / sqrt(12) —
 * within 0.05% of L / sqrt(12) at n = 32 (the analytic anchor, unchanged
 * by the arming rebase: the window still holds exactly 1.6 s of sweep).
 */
export function boltTape(speedMps: number, startAlong = -0.68): HoldFrame[] {
  const tCross = -startAlong / speedMps; // dAlong = 0 crossing
  const n = Math.ceil((tCross + HOLD_WINDOW_SEC) / HOLD_TAPE_DT) + 2;
  return tape(n, (_i, t) => ({
    dAlong: startAlong + speedMps * t,
    lat: 0,
  }));
}

/**
 * One adjustment step of `stepM` along the route exactly at half of the
 * MEASURED window: `base` sits inside HOLD_ARRIVE_EPS_M so the tape arms on
 * frame 0 (tArm = dt) and the switch at t <= dt + W/2 lands mid-window
 * after the rebase — a two-level signal +-stepM/2 about its mean, so
 * stillnessRmsCm = stepM / 2 * 100 exactly (the closed-form anchor:
 * 0.30 m -> 15 cm).
 */
export function stepTape(stepM: number, base = -0.05): HoldFrame[] {
  const half = HOLD_TAPE_DT + HOLD_WINDOW_SEC / 2;
  return tape(HOLD_TAPE_FRAMES_ARMED, (_i, t) => ({
    dAlong: t <= half ? base : base + stepM,
    lat: 0,
  }));
}

/**
 * The HONEST ARRIVAL (the jointly-satisfiable pin): cross the 0.4 m latch
 * at `speedMps` decelerating uniformly to a dead stop ON the mark, then
 * hold bit-still (dithered orientation) for the rest of the tape. Uniform
 * decel from v over d = 0.4 m: T = 2d/v, s(t) = -d (1 - t/T)^2. The window
 * arms once |s| <= HOLD_ARRIVE_EPS_M, so only the residual sub-5 cm transit
 * tail is measured — the HOLD_ARRIVE_EPS_M derivation puts its RMS
 * contribution under ~1 cm at any physical arrival speed, so this tape
 * must land in the GOOD band on BOTH stillness and mark accuracy.
 */
export function transitTape(speedMps: number, latchM = 0.4): HoldFrame[] {
  const T = (2 * latchM) / speedMps;
  const n = Math.ceil((T + HOLD_WINDOW_SEC) / HOLD_TAPE_DT) + 2;
  return tape(n, (_i, t) => ({
    dAlong: t < T ? -latchM * (1 - t / T) * (1 - t / T) : 0,
    lat: 0,
  }));
}

/**
 * The FREEZE-AT-RIM negative control: settle live-still exactly AT the
 * latch rim (dAlong = -0.4 = -MARK_RADIUS, show.ts). Arms via the speed
 * path (never inside HOLD_ARRIVE_EPS_M), reads RMS 0 — and markErrCm = 40
 * = HOLD_MARK_FAULT_CM: gaming the stillness read by stopping at the rim
 * earns the mark fault, which is the point of the two-band design.
 */
export function rimFreezeTape(): HoldFrame[] {
  return stillTape(-0.4, 0);
}

// ---------------------------------------------------------------------------
// Drivers.
// ---------------------------------------------------------------------------

/** A fresh accumulator armed with an optional FIT height (adjudication §C:
 *  plain number-or-null at reset; the signal peek is wiring-side). */
export function newAcc(fitHeightM: number | null = null): HoldAccumulator {
  const acc = new HoldAccumulator();
  acc.reset(fitHeightM);
  return acc;
}

/** Feed a tape through add() in order. */
export function feed(acc: HoldAccumulator, frames: HoldFrame[]): void {
  for (const f of frames) {
    acc.add(f.t, f.dt, f.dAlong, f.lat, f.q.qx, f.q.qy, f.q.qz, f.q.qw);
  }
}

/** reset(fit) -> feed -> finalize(walkBase) in one move. */
export function runTape(
  frames: HoldFrame[],
  opts: { fit?: number | null; walkBase?: number | null } = {},
): HoldStats | null {
  const acc = newAcc(opts.fit ?? null);
  feed(acc, frames);
  return acc.finalize(opts.walkBase ?? null);
}

/** A HoldStats literal with clean-hold defaults — the copy-branch builder
 *  (holdStatLine/holdCue are pure functions of the struct). */
export function holdStats(over: Partial<HoldStats> = {}): HoldStats {
  return {
    timeInWindowSec: 1.6,
    stillnessRmsCm: 1.5,
    stillnessNormRmsCm: 1.5,
    headHeightM: 1.6,
    heightSource: "ref" as HoldHeightSource,
    orientRmsDeg: 1,
    markErrCm: 10,
    markAlongCm: -8,
    markLatCm: 6,
    ...over,
  };
}
