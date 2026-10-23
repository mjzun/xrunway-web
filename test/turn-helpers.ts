/**
 * (X)RUNWAY — SHARED M11 turn case builders: the single source of test-case
 * truth for BOTH the vitest suite (test/turn-stats.test.ts) and the future
 * `turn-stats` golden-family emitter in scripts/gen-golden-vectors.mjs (the
 * case-helpers.ts pattern — the VECTORS commit registers the family; these
 * builders are ready for it).
 *
 * NO vitest imports allowed in this file: it must load under plain `node`
 * (the generator runs via node's TS type-stripping). Assertions stay in the
 * suite.
 *
 * THE WIRING-VS-TAPE LAW (both Wave 1 HIGHs were tapes that skipped the
 * engine's real stream): tapes here are OP SCRIPTS replayed through the REAL
 * production tracker, and the canonical protocol builder models the exact
 * wiring feed — approach transit BEFORE the mark, the hold-armed edge
 * observed via the durable globals flag (at worst one frame after the true
 * arm — noteHoldArmed lands at the CURRENT tape clock, after the frames fed
 * so far), posing yaw wander INSIDE the hold window that must not leak into
 * the turn, the straddle frame at the window open (TAPE_DT = 0.125 never
 * divides HOLD_WINDOW_SEC = 1.6 evenly, so every tape exercises the
 * adjudication-§H dtEff trim), dark/frozen frames, and walk-end truncation.
 */

import {
  TurnTracker,
  type TurnNullReason,
  type TurnStats,
} from "../src/turn-stats.ts";

const DEG2RAD = Math.PI / 180;

/**
 * Default tape frame delta (s) — binary-exact (1/8, the carriage-helpers
 * precedent) so repeated addition sums EXACTLY: entry/exit walk times are
 * dyadic and durations come out as the clean numbers the cases assert.
 * Deliberately NOT a divisor of HOLD_WINDOW_SEC (1.6 / 0.125 = 12.8): the
 * turn window always opens MID-frame, so the straddle-frame dtEff trim is
 * exercised by construction on every protocol tape.
 */
export const TURN_TAPE_DT = 0.125;

// ---------------------------------------------------------------------------
// Op scripts.
// ---------------------------------------------------------------------------

export type TurnOp =
  /** Walk start — full tracker reset + FIT/topology/band snapshot. */
  | {
      op: "begin-walk";
      fit?: number | null;
      oneWay?: boolean;
      idealPace?: number;
    }
  /** Mid-walk remap — full machine re-arm, FIT + band kept. */
  | { op: "reset-route"; oneWay: boolean }
  /** The wiring's mark rising edge, latched at the CURRENT tape clock. */
  | { op: "mark" }
  /** The wiring's hold-armed edge (the globals.holdArmed durable flag,
   * observed after the frames fed so far — the one-frame-late skew is
   * modeled by placing this op after the arrival frames). */
  | { op: "hold-armed" }
  /** Walk frames at a constant signed yaw deviation `devDeg` vs the route
   * heading (deg; the head quaternion is composed so the tracker's own
   * atan2 reads back exactly devDeg). `lat`/`headY` may be NaN to model a
   * per-channel dark frame. `pitchDev` = the M8 raw tap (null = tap dark). */
  | {
      op: "frame";
      devDeg?: number;
      walkYawDeg?: number;
      lat?: number;
      headY?: number;
      pitchDev?: number | null;
      dt?: number;
      reps?: number;
    }
  /** A linear deviation sweep: frame k of `frames` carries
   * devDeg = devFrom + (devTo - devFrom) * k / frames (k = 1..frames). */
  | {
      op: "sweep";
      devFrom: number;
      devTo: number;
      frames: number;
      walkYawDeg?: number;
      lat?: number;
      headY?: number;
      pitchDev?: number | null;
      dt?: number;
    }
  /** A fully dark frame: NaN quaternion component; lat/headY default NaN
   * too (override lat to model a yaw-dark-but-lateral-live return frame).
   * REAL time still passes (the tape clock advances). */
  | { op: "dark-frame"; lat?: number; headY?: number; dt?: number; reps?: number }
  /** FROZEN repeats: replays the LAST FED input tuple bit-identically
   * (guaranteed frozen-guard hits, independent of the dither parity).
   * Requires a previous frame. */
  | { op: "freeze"; dt?: number; reps?: number }
  /** A bad-clock frame: non-positive/NaN dt (the tape clock does NOT
   * advance — no real time passed). */
  | { op: "bad-dt-frame"; dt: number };

export interface TurnTapeResult {
  tracker: TurnTracker;
  /** finalize(walkBase) at tape end (non-destructive — re-callable). */
  stats: TurnStats | null;
  /** nullReason() at tape end (meaningful only when stats is null). */
  reason: TurnNullReason;
  /** The tape's walk clock at the end (s since the last begin-walk). */
  walkTime: number;
}

/**
 * Replay an op tape through the REAL production tracker.
 *
 * DOUBLE-COVER DITHER (the carriage-helpers law): a real fused tracker
 * never emits two bit-identical tuples at 72-90 Hz, and TurnTracker's
 * frozen-pose guard zero-weights exact repeats — so repeated tape frames
 * must be DISTINCT tuples without moving a single extracted value. The
 * quaternion double cover is exactly that: q and -q are the SAME rotation
 * and the forward extraction is quadratic in the components, so negating
 * all four leaves every extracted number BIT-identical while the guard
 * sees a distinct tuple. The runner alternates the sign per fed frame
 * (one tape-global parity). Deliberate frozen fixtures use the "freeze"
 * op, which replays the exact last-fed tuple instead.
 */
export function runTurnTape(
  ops: readonly TurnOp[],
  opts: { walkBase?: number | null; tracker?: TurnTracker } = {},
): TurnTapeResult {
  const tracker = opts.tracker ?? new TurnTracker();
  let walkTime = 0;
  let parity = 0;
  // The last fed tuple (the "freeze" op's replay source).
  let haveFed = false;
  let fQy = 0;
  let fQw = 1;
  let fPsi = 0;
  let fLat = 0;
  let fHeadY = 0;
  let fPitch: number | null = null;

  const feed = (
    devDeg: number,
    walkYawDeg: number,
    lat: number,
    headY: number,
    pitchDev: number | null,
    dt: number,
  ): void => {
    walkTime += dt;
    const psi = walkYawDeg * DEG2RAD;
    // Head world yaw theta = psi - dev: the tracker's signed deviation
    // (atan2 against (-sin psi, -cos psi)) reads back exactly devDeg —
    // the carriage-helpers headQuat identity (yaw error = psi - yaw).
    const theta = psi - devDeg * DEG2RAD;
    const s = parity++ % 2 === 0 ? 1 : -1;
    const qy = s * Math.sin(theta / 2);
    const qw = s * Math.cos(theta / 2);
    tracker.update(dt, walkTime, 0, qy, 0, qw, psi, lat, headY, pitchDev);
    haveFed = true;
    fQy = qy;
    fQw = qw;
    fPsi = psi;
    fLat = lat;
    fHeadY = headY;
    fPitch = pitchDev;
  };

  for (const o of ops) {
    switch (o.op) {
      case "begin-walk":
        tracker.beginWalk(o.fit ?? null, o.oneWay ?? false, o.idealPace ?? 0.85);
        walkTime = 0;
        break;
      case "reset-route":
        tracker.resetRoute(o.oneWay);
        break;
      case "mark":
        tracker.noteMark(walkTime);
        break;
      case "hold-armed":
        tracker.noteHoldArmed(walkTime);
        break;
      case "frame": {
        const reps = o.reps ?? 1;
        for (let i = 0; i < reps; i++) {
          feed(
            o.devDeg ?? 0,
            o.walkYawDeg ?? 0,
            o.lat ?? 0,
            o.headY ?? 1.6,
            o.pitchDev === undefined ? 0 : o.pitchDev,
            o.dt ?? TURN_TAPE_DT,
          );
        }
        break;
      }
      case "sweep": {
        for (let k = 1; k <= o.frames; k++) {
          feed(
            o.devFrom + ((o.devTo - o.devFrom) * k) / o.frames,
            o.walkYawDeg ?? 0,
            o.lat ?? 0,
            o.headY ?? 1.6,
            o.pitchDev === undefined ? 0 : o.pitchDev,
            o.dt ?? TURN_TAPE_DT,
          );
        }
        break;
      }
      case "dark-frame": {
        const reps = o.reps ?? 1;
        const dt = o.dt ?? TURN_TAPE_DT;
        for (let i = 0; i < reps; i++) {
          walkTime += dt; // real time passed; the tracker credits nothing
          tracker.update(
            dt,
            walkTime,
            NaN,
            0,
            0,
            1,
            0,
            o.lat ?? NaN,
            o.headY ?? NaN,
            null,
          );
        }
        break;
      }
      case "freeze": {
        if (!haveFed) {
          throw new Error("freeze op needs a previous frame to replay");
        }
        const reps = o.reps ?? 1;
        const dt = o.dt ?? TURN_TAPE_DT;
        for (let i = 0; i < reps; i++) {
          walkTime += dt;
          tracker.update(
            dt,
            walkTime,
            0,
            fQy,
            0,
            fQw,
            fPsi,
            fLat,
            fHeadY,
            fPitch,
          );
        }
        break;
      }
      case "bad-dt-frame":
        tracker.update(o.dt, walkTime, 0, 0, 0, 1, 0, 0, 1.6, 0);
        break;
    }
  }
  return {
    tracker,
    stats: tracker.finalize(opts.walkBase ?? null),
    reason: tracker.nullReason(),
    walkTime,
  };
}

// ---------------------------------------------------------------------------
// Canonical protocol segments (composable; times below in TAPE frames).
// ---------------------------------------------------------------------------

/**
 * The canonical out-and-back prelude up to the CLOSE of the hold window —
 * the exact wiring feed shape:
 * - 16 approach frames (2.0 s) facing down the line;
 * - the mark rising edge;
 * - 2 arrival-transit frames, THEN the hold-armed edge (the durable-flag
 *   skew: the observed edge lands after the arrival frames — armAt = 2.25);
 * - a 13-frame hold beat (1.625 s > HOLD_WINDOW_SEC) carrying posing yaw
 *   wander OUT to 60 deg and BACK inside the window (must not leak into
 *   the turn), ending at devDeg = 4 so the straddle frame at the open
 *   (walkTime 3.875 vs windowOpen 3.85) is honestly "facing down the
 *   line" (no clip).
 * `holdEndDev` overrides the last 3 hold frames' deviation — the
 * entry-clipped (20 <= dev < 100) and turned-in-hold (dev >= 100) fixtures
 * park the head off-line at the close.
 */
export function protocolPrelude(holdEndDev = 4): TurnOp[] {
  const ops: TurnOp[] = [
    { op: "begin-walk", fit: null, oneWay: false, idealPace: 0.85 },
    { op: "frame", devDeg: 0, lat: 0.3, headY: 1.6, reps: 16 },
    { op: "mark" },
    { op: "frame", devDeg: 0, lat: 0.05, headY: 1.6, reps: 2 },
    { op: "hold-armed" },
    // Hold beat: wander out to 60, back down, settle at holdEndDev.
    { op: "sweep", devFrom: 5, devTo: 60, frames: 5, lat: 0.02, headY: 1.6 },
    { op: "sweep", devFrom: 49, devTo: 5, frames: 5, lat: 0.02, headY: 1.6 },
    { op: "frame", devDeg: holdEndDev, lat: 0.02, headY: 1.6, reps: 3 },
  ];
  return ops;
}

/**
 * The clean 12-frame pivot: dev 5 -> 170 linearly (entry trips at 32.5 on
 * frame 2, exit at 170 on frame 12). Closed forms at TAPE_DT = 0.125:
 * durationSec = 10 frames = 1.25 s, sweepDeg = 170 - 32.5 = 137.5,
 * measuredSec = 11 frames = 1.375 s, reversals 0, monotone frac 1.
 * `headY` lets the dip fixtures sink the head through the pivot.
 */
export function cleanPivot(headY = 1.6): TurnOp[] {
  return [
    { op: "sweep", devFrom: 5, devTo: 170, frames: 12, lat: 0.02, headY },
  ];
}

/**
 * A return leg that walks 0.75 s off the line (|lat| 0.5) then holds the
 * corridor (|lat| 0.1) for 1.0 s — closed form: reacquireSec = 0.75,
 * not capped, returnMeasSec = 1.75.
 */
export function returnLeg(): TurnOp[] {
  return [
    { op: "frame", devDeg: 172, lat: 0.5, headY: 1.6, reps: 6 },
    { op: "frame", devDeg: 172, lat: 0.1, headY: 1.6, reps: 8 },
  ];
}

/** The canonical FULL PROTOCOL tape (prelude + clean pivot + return). */
export function fullProtocolOps(): TurnOp[] {
  return [...protocolPrelude(), ...cleanPivot(), ...returnLeg()];
}

// ---------------------------------------------------------------------------
// TurnStats fixture (the holdStats() pattern): a clean turn's read unless
// overridden — the copy builders are pure functions of the struct.
// ---------------------------------------------------------------------------

export function makeTurnStats(over: Partial<TurnStats> = {}): TurnStats {
  return {
    startAtSec: 4.13,
    durationSec: 1.25,
    durBandLoSec: 0.9,
    durBandHiSec: 2.22,
    entryClipped: false,
    sweepDeg: 137.5,
    reversalCount: 0,
    sweepMonotoneFrac: 1,
    dipCm: 2.1,
    dipFrac: 0.0131,
    heightM: 1.6,
    heightSource: "walk",
    pitchInBandFrac: 0.94,
    measuredSec: 1.38,
    reacquireSec: 0.75,
    reacquireCapped: false,
    ...over,
  };
}
