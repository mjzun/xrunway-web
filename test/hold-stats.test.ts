import { describe, expect, it } from "vitest";

import {
  HOLD_ARRIVE_EPS_M,
  HOLD_EXPLAIN,
  HOLD_MARK_FAULT_CM,
  HOLD_MARK_GOOD_CM,
  HOLD_REF_HEAD_M,
  HOLD_SPEED_EMA_RATE,
  HOLD_SPEED_STILL_MPS,
  HOLD_STAND_MIN_M,
  HOLD_STILL_FAULT_NORM_CM,
  HOLD_STILL_GOOD_NORM_CM,
  HOLD_WINDOW_SEC,
  HOLD_YAW_HORIZ_MIN,
  HoldAccumulator,
  holdCue,
  holdStatLine,
  type HoldStats,
} from "../src/hold-stats.ts";
import {
  boltTape,
  ditherQ,
  feed,
  HOLD_TAPE_DT,
  HOLD_TAPE_FRAMES,
  HOLD_TAPE_FRAMES_ARMED,
  holdStats,
  newAcc,
  Q_IDENTITY,
  quatPitch,
  quatYaw,
  quatYawPitch,
  rimFreezeTape,
  runTape,
  stepTape,
  stillTape,
  tape,
  transitTape,
  type HoldFrame,
} from "./hold-helpers.ts";

const DEG = Math.PI / 180;

/** Sub-cm sway tape: dAlong alternates +-amp about 0 (RMS = amp exactly —
 *  arms on frame 0 for amp <= HOLD_ARRIVE_EPS_M; 34 frames fill the rebased
 *  window with 16 folds of each sign). */
function swayTape(ampM: number): HoldFrame[] {
  return tape(HOLD_TAPE_FRAMES_ARMED, (i) => ({
    dAlong: (i % 2 === 0 ? 1 : -1) * ampM,
    lat: 0,
  }));
}

// ---------------------------------------------------------------------------
// Constant pins.
// ---------------------------------------------------------------------------

describe("constant pins", () => {
  it("HOLD_WINDOW_SEC is 1.6 - this constant IS the U pose dwell", () => {
    // Single-source identity: show.ts's POSE_HOLD_SEC becomes an import
    // alias of HOLD_WINDOW_SEC (wiring phase), so moving this value CHANGES
    // THE U-ROUTE WALK PROTOCOL for every trainee. That is a reserved
    // founder call, not a tuning knob.
    expect(HOLD_WINDOW_SEC).toBe(1.6);
  });

  it("the hold's yaw gate is sin(5 deg)", () => {
    expect(Math.abs(HOLD_YAW_HORIZ_MIN - Math.sin(5 * DEG))).toBeLessThan(5e-4);
  });

  it("bands: good/fault spacing as derived (2/5 norm cm, 15/40 raw cm)", () => {
    expect(HOLD_STILL_GOOD_NORM_CM).toBe(2);
    expect(HOLD_STILL_FAULT_NORM_CM).toBe(5);
    expect(HOLD_MARK_FAULT_CM).toBe(40);
  });

  it("HOLD_ARRIVE_EPS_M is 0.05 — the derived residual-transit bound", () => {
    // The constant's own arithmetic: even the slowest position-arm arrival
    // (v = the 0.25 m/s speed-arm bound) leaves residual-transit variance
    // f * d^2/5 with f = (2d/v)/W — RSS'd with the ~1 cm sway floor it must
    // stay inside the 2 cm good band.
    const d = HOLD_ARRIVE_EPS_M;
    const f = (2 * d) / HOLD_SPEED_STILL_MPS / HOLD_WINDOW_SEC;
    const varCm2 = f * (d * 100) ** 2 / 5;
    expect(Math.sqrt(1 + varCm2)).toBeLessThan(HOLD_STILL_GOOD_NORM_CM);
  });
});

// ---------------------------------------------------------------------------
// Null contract + reason enum (adjudication K).
// ---------------------------------------------------------------------------

describe("finalize null + nullReason", () => {
  it("an untouched accumulator is null with reason never-marked", () => {
    const acc = newAcc();
    expect(acc.finalize(null)).toBeNull();
    expect(acc.nullReason()).toBe("never-marked");
  });

  it("zero-weight adds (latch frame only) are null with reason no-data", () => {
    const acc = newAcc();
    acc.add(0, 0.05, 0, 0, 0, 0, 0, 1); // the latch frame: tSinceMark = 0
    expect(acc.finalize(null)).toBeNull();
    expect(acc.nullReason()).toBe("no-data");
  });

  it("junk-only frames are null with reason no-data", () => {
    const acc = newAcc();
    acc.add(0.1, 0.05, Number.NaN, 0, 0, 0, 0, 1);
    acc.add(0.15, 0.05, 0, Number.POSITIVE_INFINITY, 0, 0, 0, 1);
    expect(acc.finalize(null)).toBeNull();
    expect(acc.nullReason()).toBe("no-data");
  });

  it("reset() re-arms the reason to never-marked", () => {
    const acc = newAcc();
    acc.add(0.1, 0.05, 0, 0, 0, 0, 0, 1);
    expect(acc.nullReason()).toBe("no-data");
    acc.reset(null);
    expect(acc.nullReason()).toBe("never-marked");
  });

  it("markReached() latches the fact without any add() (all-dark window)", () => {
    // The wiring calls this on the reachedMark edge BEFORE its finiteness
    // gate — a walk whose whole post-mark stretch is dark never reaches
    // add() and must still read no-data, never the false never-marked.
    const acc = newAcc();
    acc.markReached();
    expect(acc.finalize(null)).toBeNull();
    expect(acc.nullReason()).toBe("no-data");
    acc.reset(null);
    expect(acc.nullReason()).toBe("never-marked");
  });
});

// ---------------------------------------------------------------------------
// The arming law (the arrival gate): nothing folds until the trainee has
// actually ARRIVED — |dAlong| <= HOLD_ARRIVE_EPS_M or frame speed below
// HOLD_SPEED_STILL_MPS — and every fold rebases to the arming frame.
// ---------------------------------------------------------------------------

describe("arming (the arrival law)", () => {
  it("approach frames at walking speed never arm or fold", () => {
    const acc = newAcc();
    expect(acc.armed).toBe(false);
    expect(acc.armedAtSec).toBeNull();
    // Crossing the latch at 0.85 m/s: 0.0425 m per 50 ms frame, still
    // 0.11 m short at the last frame — outside EPS, speed >= 0.25.
    for (let i = 0; i < 7; i++) {
      const q = ditherQ(i);
      acc.add((i + 1) * 0.05, 0.05, -0.4 + 0.0425 * (i + 1), 0, q.qx, q.qy, q.qz, q.qw);
    }
    expect(acc.armed).toBe(false);
    expect(acc.finalize(null)).toBeNull(); // nothing folded
    expect(acc.nullReason()).toBe("no-data"); // but the mark WAS seen
  });

  it("arms via position at the first frame inside HOLD_ARRIVE_EPS_M", () => {
    const acc = newAcc();
    acc.add(0.05, 0.05, -0.2, 0, 0, 0, 0, 1); // approaching
    expect(acc.armed).toBe(false);
    const q = ditherQ(1);
    acc.add(0.1, 0.05, -0.04, 0, q.qx, q.qy, q.qz, q.qw); // |dAlong| <= 0.05
    expect(acc.armed).toBe(true);
    expect(acc.armedAtSec).toBe(0.1);
  });

  it("arms via speed short of the mark (began the hold early)", () => {
    const acc = newAcc();
    acc.add(0.05, 0.05, -0.3, 0, 0, 0, 0, 1);
    const q = ditherQ(1);
    // 0.005 m over 50 ms = 0.1 m/s < HOLD_SPEED_STILL_MPS, still 0.295 m
    // short — the mark error will read the shortfall.
    acc.add(0.1, 0.05, -0.295, 0, q.qx, q.qy, q.qz, q.qw);
    expect(acc.armed).toBe(true);
    expect(acc.armedAtSec).toBe(0.1);
  });

  it("every fold is rebased: the measured window is [tArm, tArm + W]", () => {
    // stillTape(0, 0) arms on frame 0 (t = 0.05) and its 34 frames fill the
    // REBASED window exactly — a 32-frame slice would now read short.
    const full = runTape(stillTape(0, 0))!;
    expect(full.timeInWindowSec).toBe(HOLD_WINDOW_SEC);
    // A 32-frame slice ends at t = 1.6: with tArm = 0.05 the last fold is
    // tw = 1.55, so one 0.05 s sliver of the rebased window went unmeasured.
    const short = runTape(stillTape(0, 0).slice(0, HOLD_TAPE_FRAMES))!;
    expect(short.timeInWindowSec).toBeCloseTo(
      HOLD_WINDOW_SEC - HOLD_TAPE_DT,
      9,
    );
  });

  it("frozen tracking never arms (dark tracking cannot fake an arrival)", () => {
    // Bit-identical repeats hit the frozen-pose guard BEFORE the arming
    // check — speed 0 on frozen frames must not arm the window, so a dark
    // U walk never fires the settle dwell and ends via the walk timeout.
    const acc = newAcc();
    for (let i = 0; i < HOLD_TAPE_FRAMES_ARMED; i++) {
      acc.add((i + 1) * HOLD_TAPE_DT, HOLD_TAPE_DT, -0.2, 0, 0, 0, 0, 1);
    }
    expect(acc.armed).toBe(false);
    expect(acc.finalize(null)).toBeNull();
    expect(acc.nullReason()).toBe("no-data");
  });

  it("reset() disarms", () => {
    const acc = newAcc();
    acc.add(0.05, 0.05, 0, 0, 0, 0, 0, 1);
    expect(acc.armed).toBe(true);
    acc.reset(null);
    expect(acc.armed).toBe(false);
    expect(acc.armedAtSec).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The jointly-satisfiable pin: an HONEST arrival lands in the GOOD band on
// BOTH stillness and mark accuracy; gaming stillness at the latch rim earns
// the mark fault. (The point of splitting the latch from the window open.)
// ---------------------------------------------------------------------------

describe("honest arrival vs freeze-at-rim (transit tapes)", () => {
  it("decel-to-stop at 0.85 m/s (beginner ideal) reads a clean hold", () => {
    const acc = newAcc();
    feed(acc, transitTape(0.85));
    const h = acc.finalize(null)!;
    expect(h.timeInWindowSec).toBe(HOLD_WINDOW_SEC); // full window measured
    expect(h.stillnessNormRmsCm).toBeLessThanOrEqual(HOLD_STILL_GOOD_NORM_CM);
    expect(h.markErrCm).toBeLessThanOrEqual(HOLD_MARK_GOOD_CM);
    expect(holdCue(h, "no-data")).toMatch(/a clean hold\.$/);
  });

  it("decel-to-stop at 2.0 m/s (a brisk arrival) reads a clean hold", () => {
    const acc = newAcc();
    feed(acc, transitTape(2.0));
    const h = acc.finalize(null)!;
    expect(h.timeInWindowSec).toBe(HOLD_WINDOW_SEC);
    expect(h.stillnessNormRmsCm).toBeLessThanOrEqual(HOLD_STILL_GOOD_NORM_CM);
    expect(h.markErrCm).toBeLessThanOrEqual(HOLD_MARK_GOOD_CM);
    expect(holdCue(h, "no-data")).toMatch(/a clean hold\.$/);
  });

  it("freezing at the latch rim reads the MARK fault, not clean", () => {
    const acc = newAcc();
    feed(acc, rimFreezeTape());
    const h = acc.finalize(null)!;
    expect(h.stillnessRmsCm).toBe(0); // perfectly still...
    expect(h.markErrCm).toBe(HOLD_MARK_FAULT_CM); // ...40 cm off the mark
    expect(holdCue(h, "no-data")).toBe(
      "Your hold settled 40 cm short of the mark - walk all the way onto it before you set.",
    );
  });
});

// ---------------------------------------------------------------------------
// Analytic anchors (the golden family's assert-then-emit cases).
// ---------------------------------------------------------------------------

describe("analytic anchors", () => {
  it("frozen trainee: RMS exactly 0, markErr equal to the fed offset", () => {
    const h = runTape(stillTape(-0.1, 0.05))!;
    expect(h.stillnessRmsCm).toBe(0);
    expect(h.markAlongCm).toBe(-10);
    expect(h.markLatCm).toBe(5);
    // hypot(0.10, 0.05) = 0.1118 m -> 11.2 cm (round1)
    expect(h.markErrCm).toBe(11.2);
    expect(h.timeInWindowSec).toBe(HOLD_WINDOW_SEC);
    expect(h.orientRmsDeg).toBe(0); // 1e-9 rad dither vanishes under round1
  });

  it("bolt sweep at 0.85 m/s: std within 2% of L / sqrt(12)", () => {
    const speed = 0.85;
    const h = runTape(boltTape(speed))!;
    const expectCm = ((speed * HOLD_WINDOW_SEC) / Math.sqrt(12)) * 100; // 39.26
    expect(Math.abs(h.stillnessRmsCm - expectCm) / expectCm).toBeLessThan(0.02);
    expect(h.stillnessNormRmsCm).toBeGreaterThan(HOLD_STILL_FAULT_NORM_CM);
  });

  it("two-level adjustment step (+0.30 m at half-window): RMS 15 cm exact", () => {
    const h = runTape(stepTape(0.3))!;
    expect(h.stillnessRmsCm).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Window-overlap clamp (the accumulator owns it, not the wiring).
// ---------------------------------------------------------------------------

describe("window weighting", () => {
  it("a frame straddling window close contributes exactly its sliver", () => {
    const acc = newAcc();
    acc.add(0.1, 0.1, 0, 0, 0, 0, 0, 1); // arms ON the mark: tArm = 0.1
    // tw spans [1.5, 1.7] of the REBASED window -> only the [1.5, 1.6]
    // sliver folds.
    acc.add(1.8, 0.2, 0.01, 0, 0, 0, 0.001, 1);
    expect(acc.finalize(null)!.timeInWindowSec).toBe(0.1);
  });

  it("the latch frame (tSinceMark = 0) contributes 0 even when it arms", () => {
    const acc = newAcc();
    acc.add(0, 0.014, 0.01, 0, 0, 0, 0, 1); // on-mark latch frame: arms...
    expect(acc.armed).toBe(true);
    expect(acc.finalize(null)).toBeNull(); // ...but tw = 0 folds nothing
  });

  it("a fully post-window frame contributes 0", () => {
    const acc = newAcc();
    feed(acc, stillTape(0, 0));
    acc.add(1.8, 0.05, 3, 3, 0, 0, 0, 1); // walked off after the window
    const h = acc.finalize(null)!;
    expect(h.timeInWindowSec).toBe(HOLD_WINDOW_SEC);
    expect(h.markAlongCm).toBe(0); // the post-window position never folded
  });

  it("a truncated feed discloses the short window", () => {
    const acc = newAcc();
    // Walk ended at 0.7 s; armed at frame 0 (t = 0.05), so 13 rebased
    // 0.05 s folds were measured.
    feed(acc, stillTape(-0.02, 0.01).slice(0, 14));
    expect(acc.finalize(null)!.timeInWindowSec).toBe(0.65);
  });
});

// ---------------------------------------------------------------------------
// Live stillness (presentation channel).
// ---------------------------------------------------------------------------

describe("liveStill01", () => {
  it("a frozen trainee reads 1, a bolter reads 0", () => {
    const still = newAcc();
    feed(still, stillTape(0, 0));
    expect(still.liveStill01).toBe(1);

    const bolt = newAcc();
    feed(bolt, boltTape(0.85));
    expect(bolt.liveStill01).toBe(0);
  });

  it("the speed EMA seeds from the FIRST in-window sample (no fake-still 0 seed)", () => {
    const acc = newAcc();
    acc.add(0.05, 0.05, 0, 0, 0, 0, 0, 1); // arms on the mark
    const q = ditherQ(1);
    acc.add(0.1, 0.05, 0.05, 0, q.qx, q.qy, q.qz, q.qw); // 1 m/s over the real dt
    // seeded ema = 1.0 -> q = 4 -> clamped -> 0. A 0-seeded EMA fold would
    // still read ~0.62 here.
    expect(acc.liveStill01).toBe(0);
  });

  it("stays 0 before the window arms (pre-arrival frames fold no speed)", () => {
    const acc = newAcc();
    feed(acc, transitTape(0.85).slice(0, 8)); // mid-approach, unarmed
    expect(acc.armed).toBe(false);
    expect(acc.liveStill01).toBe(0);
  });

  it("the speed divides by the REAL frame dt, not the window-clipped sliver", () => {
    const acc = newAcc();
    acc.add(0.05, 0.05, 0, 0, 0, 0, 0, 1); // arms: tArm = 0.05
    const q1 = ditherQ(1);
    acc.add(1.6, 1.55, 0, 0, q1.qx, q1.qy, q1.qz, q1.qw); // still: ema seeds 0
    expect(acc.liveStill01).toBe(1);
    // Straddler: tw spans [1.55, 1.65] -> only a 0.05 s sliver folds, but
    // the 0.024 m displacement happened over the REAL 0.1 s frame ->
    // 0.24 m/s (an honest sub-still-bound creep). The old /effDt time base
    // read 0.024/0.05 = 0.48 m/s — a phantom 2x inflation on the close
    // straddler.
    const q2 = ditherQ(2);
    acc.add(1.7, 0.1, 0.024, 0, q2.qx, q2.qy, q2.qz, q2.qw);
    const speed = 0.024 / 0.1;
    const effDt = HOLD_WINDOW_SEC - (1.7 - 0.05 - 0.1);
    const ema = speed * (1 - Math.exp(-HOLD_SPEED_EMA_RATE * effDt));
    expect(acc.liveStill01).toBeCloseTo(1 - ema / HOLD_SPEED_STILL_MPS, 9);
  });

  it("resets to 0 with the walk", () => {
    const acc = newAcc();
    feed(acc, stillTape(0, 0));
    acc.reset(null);
    expect(acc.liveStill01).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Finiteness gates + junk/clean twin equivalence.
// ---------------------------------------------------------------------------

describe("junk frames", () => {
  it("a junk-frame tape FINALIZES identically to its clean-frames-only twin", () => {
    const clean = stepTape(0.12);
    const junky: HoldFrame[] = [];
    for (let i = 0; i < clean.length; i++) {
      junky.push(clean[i]);
      if (i % 5 === 2) {
        // a dark frame between grid frames: non-finite position
        junky.push({
          t: clean[i].t + 0.01,
          dt: 0.01,
          dAlong: Number.NaN,
          lat: 0,
          q: Q_IDENTITY,
        });
      }
    }
    const a = newAcc();
    const b = newAcc();
    feed(a, junky);
    feed(b, clean);
    // The RECORD is junk-invariant (position/orientation moments never see
    // the dark frames). The presentation-only liveStill01 legitimately
    // diverges: each junk frame drops the speed anchor, so the following
    // clean frame folds no speed sample (the re-seed law pinned below).
    expect(a.finalize(null)).toEqual(b.finalize(null));
  });

  it("a junk frame drops the speed anchor (no differencing across the junk)", () => {
    const acc = newAcc();
    feed(acc, stillTape(0, 0).slice(0, 4)); // armed + still: liveStill01 = 1
    expect(acc.liveStill01).toBe(1);
    acc.add(0.25, 0.05, Number.NaN, 0, 0, 0, 0, 1); // junk: anchor dropped
    const q = ditherQ(5);
    // Recovery 0.5 m away: differencing across the junk would read a 10 m/s
    // jump (clamped 4) and crash liveStill01 to 0; the re-seed folds no
    // speed sample, so the last honest read stands.
    acc.add(0.3, 0.05, 0.5, 0, q.qx, q.qy, q.qz, q.qw);
    expect(acc.liveStill01).toBe(1);
  });

  it("non-finite dt or t skips the frame entirely", () => {
    const acc = newAcc();
    acc.add(Number.NaN, 0.05, 0, 0, 0, 0, 0, 1);
    acc.add(0.1, Number.NaN, 0, 0, 0, 0, 0, 1);
    acc.add(0.1, 0, 0, 0, 0, 0, 0, 1);
    acc.add(0.1, -0.05, 0, 0, 0, 0, 0, 1);
    expect(acc.finalize(null)).toBeNull();
  });

  it("a non-finite quaternion folds position but not orientation", () => {
    const acc = newAcc();
    feed(
      acc,
      tape(HOLD_TAPE_FRAMES_ARMED, () => ({
        dAlong: -0.03,
        lat: 0.02,
        q: { qx: Number.NaN, qy: 0, qz: 0, qw: 1 },
      })),
    );
    const h = acc.finalize(null)!;
    expect(h.timeInWindowSec).toBe(HOLD_WINDOW_SEC);
    expect(h.markAlongCm).toBe(-3);
    expect(h.orientRmsDeg).toBeNull();
  });

  it("gimbal-locked frames (horiz below sin 5 deg) skip orientation only", () => {
    // Head pitched 89 deg up: forward is nearly vertical, atan2 yaw is
    // numerically meaningless. Position must still fold.
    const gimbal = quatPitch(89 * DEG);
    const acc = newAcc();
    feed(
      acc,
      tape(HOLD_TAPE_FRAMES_ARMED, (i) => ({
        dAlong: (i % 2 === 0 ? 1 : -1) * 0.01,
        lat: 0,
        q: gimbal,
      })),
    );
    const h = acc.finalize(null)!;
    expect(h.timeInWindowSec).toBe(HOLD_WINDOW_SEC);
    expect(h.stillnessRmsCm).toBe(1);
    expect(h.orientRmsDeg).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Orientation RMS: pitch fold, yaw fold, seam unwrap.
// ---------------------------------------------------------------------------

describe("orientation RMS", () => {
  it("pitch dispersion of +-2 deg reads 2.0 deg", () => {
    const h = runTape(
      tape(HOLD_TAPE_FRAMES_ARMED, (i) => ({
        dAlong: 0,
        lat: 0,
        q: quatPitch((i % 2 === 0 ? 2 : -2) * DEG),
      })),
    )!;
    expect(h.orientRmsDeg).toBeCloseTo(2, 1);
  });

  it("yaw dispersion of +-2 deg reads 2.0 deg", () => {
    const h = runTape(
      tape(HOLD_TAPE_FRAMES_ARMED, (i) => ({
        dAlong: 0,
        lat: 0,
        q: quatYaw((i % 2 === 0 ? 2 : -2) * DEG),
      })),
    )!;
    expect(h.orientRmsDeg).toBeCloseTo(2, 1);
  });

  it("composed yaw+pitch wobble reads the RSS of both axes", () => {
    // pitch +-2 deg and yaw +-2 deg in phase: RSS = sqrt(4 + 4) = 2.83 deg.
    const h = runTape(
      tape(HOLD_TAPE_FRAMES_ARMED, (i) => {
        const s = i % 2 === 0 ? 1 : -1;
        return { dAlong: 0, lat: 0, q: quatYawPitch(s * 2 * DEG, s * 2 * DEG) };
      }),
    )!;
    expect(h.orientRmsDeg).toBeCloseTo(Math.sqrt(8), 1);
  });

  it("a hold oscillating +-2 deg across the +-PI seam reads ~2 deg, not ~180", () => {
    const h = runTape(
      tape(HOLD_TAPE_FRAMES_ARMED, (i) => ({
        dAlong: 0,
        lat: 0,
        q: quatYaw((i % 2 === 0 ? 1 : -1) * (Math.PI - 2 * DEG)),
      })),
    )!;
    expect(h.orientRmsDeg).toBeCloseTo(2, 1);
  });
});

// ---------------------------------------------------------------------------
// Height normalization + the per-row stamp.
// ---------------------------------------------------------------------------

describe("height normalization", () => {
  it("no FIT, no walk baseline: source ref, norm == raw exactly", () => {
    const h = runTape(swayTape(0.02))!;
    expect(h.heightSource).toBe("ref");
    expect(h.headHeightM).toBe(HOLD_REF_HEAD_M);
    expect(h.stillnessRmsCm).toBe(2);
    expect(h.stillnessNormRmsCm).toBe(h.stillnessRmsCm);
  });

  it("FIT height stamps source fit and scales the norm (adjudication C pin)", () => {
    const h = runTape(swayTape(0.02), { fit: 1.9 })!;
    expect(h.heightSource).toBe("fit");
    expect(h.headHeightM).toBe(1.9);
    expect(h.stillnessRmsCm).toBe(2);
    // 2 * 1.6 / 1.9 = 1.684 -> 1.7 (round1)
    expect(h.stillnessNormRmsCm).toBe(1.7);
  });

  it("equal skill on a 1.9 m body (raw x 1.9/1.6) normalizes identically", () => {
    const base = runTape(swayTape(0.02))!; // 1.6 m reference body
    const tall = runTape(swayTape((0.02 * 1.9) / 1.6), { fit: 1.9 })!;
    expect(tall.stillnessRmsCm).toBeGreaterThan(base.stillnessRmsCm);
    expect(tall.stillnessNormRmsCm).toBe(base.stillnessNormRmsCm);
  });

  it("walk baseline is the middle rung; FIT wins over it", () => {
    const walk = runTape(swayTape(0.02), { walkBase: 1.8 })!;
    expect(walk.heightSource).toBe("walk");
    expect(walk.headHeightM).toBe(1.8);

    const both = runTape(swayTape(0.02), { fit: 1.9, walkBase: 1.8 })!;
    expect(both.heightSource).toBe("fit");
    expect(both.headHeightM).toBe(1.9);
  });

  it("a non-standing walk baseline falls through to ref", () => {
    const low = runTape(swayTape(0.02), { walkBase: HOLD_STAND_MIN_M - 0.1 })!;
    expect(low.heightSource).toBe("ref");
    const junk = runTape(swayTape(0.02), { walkBase: Number.NaN })!;
    expect(junk.heightSource).toBe("ref");
  });

  it("a junk FIT height falls through to the walk baseline", () => {
    const h = runTape(swayTape(0.02), { fit: Number.NaN, walkBase: 1.7 })!;
    expect(h.heightSource).toBe("walk");
    expect(h.headHeightM).toBe(1.7);
  });
});

// ---------------------------------------------------------------------------
// Frozen-pose guard.
// ---------------------------------------------------------------------------

describe("frozen-pose guard", () => {
  it("a static desktop camera never even arms — the read is null/no-data", () => {
    const acc = newAcc();
    for (let i = 0; i < HOLD_TAPE_FRAMES_ARMED; i++) {
      // a static desktop camera: EXACTLY the same tuple every frame. The
      // guard runs BEFORE the arming check, so the zero frozen "speed" can
      // never fake an arrival — the window stays unarmed and unmeasured.
      acc.add((i + 1) * HOLD_TAPE_DT, HOLD_TAPE_DT, 0.1, -0.05, 0, 0, 0, 1);
    }
    expect(acc.armed).toBe(false);
    expect(acc.finalize(null)).toBeNull();
    expect(acc.nullReason()).toBe("no-data");
  });

  it("a freeze AFTER arming adds zero weight (arming frame folds nothing)", () => {
    const acc = newAcc();
    acc.add(0.05, HOLD_TAPE_DT, 0, 0, 0, 0, 0, 1); // arms ON the mark
    for (let i = 1; i < HOLD_TAPE_FRAMES_ARMED; i++) {
      acc.add((i + 1) * HOLD_TAPE_DT, HOLD_TAPE_DT, 0, 0, 0, 0, 0, 1); // frozen
    }
    expect(acc.armed).toBe(true);
    expect(acc.finalize(null)).toBeNull(); // zero measured window time
    expect(acc.nullReason()).toBe("no-data");
  });

  it("speed does not difference across the freeze", () => {
    const acc = newAcc();
    // 8 live still frames at the mark (armed at frame 0)...
    feed(acc, stillTape(0, 0).slice(0, 8));
    // ...then the source freezes: exact repeats of frame 8's tuple...
    const f8 = stillTape(0, 0)[7];
    for (let i = 8; i < 16; i++) {
      acc.add((i + 1) * HOLD_TAPE_DT, HOLD_TAPE_DT, f8.dAlong, f8.lat, f8.q.qx, f8.q.qy, f8.q.qz, f8.q.qw);
    }
    // ...then it recovers HALF A METER away. Differencing across the freeze
    // would read a huge jump speed; the re-seed keeps the stillness read.
    for (let i = 16; i < HOLD_TAPE_FRAMES; i++) {
      const q = ditherQ(i);
      acc.add((i + 1) * HOLD_TAPE_DT, HOLD_TAPE_DT, 0.5, 0, q.qx, q.qy, q.qz, q.qw);
    }
    expect(acc.liveStill01).toBe(1);
    const h = acc.finalize(null)!;
    // Armed at frame 0 (tArm 0.05): frames 1-7 folded 0.35 s, the 8 frozen
    // frames folded nothing, the recovery frames folded 0.80 s.
    expect(h.timeInWindowSec).toBe(1.15);
  });
});

// ---------------------------------------------------------------------------
// finalize is non-destructive and re-callable.
// ---------------------------------------------------------------------------

describe("finalize round trip", () => {
  it("same args twice -> identical result; state survives", () => {
    const acc = newAcc();
    feed(acc, stepTape(0.1));
    expect(acc.finalize(1.7)).toEqual(acc.finalize(1.7));
  });

  it("re-callable with a different height resolution", () => {
    const acc = newAcc();
    feed(acc, swayTape(0.02));
    expect(acc.finalize(null)!.heightSource).toBe("ref");
    expect(acc.finalize(1.8)!.heightSource).toBe("walk");
    expect(acc.finalize(1.8)!.stillnessRmsCm).toBe(2); // raw untouched
  });
});

// ---------------------------------------------------------------------------
// Copy: every branch pinned exact-string (ASCII only).
// ---------------------------------------------------------------------------

describe("copy", () => {
  it("HOLD_EXPLAIN is the pinned disclosure (the window opens at the SETTLE)", () => {
    expect(HOLD_EXPLAIN).toBe(
      "Measured in the 1.6 s window once you settle on the pose mark. " +
        "Stillness is the RMS drift of your head position in cm (the " +
        "verdict band scales it to a 1.60 m reference height); mark " +
        "accuracy is your average position vs the mark in cm. Head sensor " +
        "only - nothing reads your expression or styling. The tightening " +
        "light pool and the flash surge follow these measured numbers.",
    );
  });

  it("holdStatLine formats the measured line", () => {
    expect(
      holdStatLine(
        holdStats({ timeInWindowSec: 1.6, stillnessRmsCm: 2.4, markErrCm: 11.2 }),
        "never-marked",
      ),
    ).toBe("HOLD 1.6S - STILL 2.4 CM - MARK 11 CM");
    // a truncated window is VISIBLE in the line
    expect(
      holdStatLine(
        holdStats({ timeInWindowSec: 0.7, stillnessRmsCm: 1.9, markErrCm: 9 }),
        "never-marked",
      ),
    ).toBe("HOLD 0.7S - STILL 1.9 CM - MARK 9 CM");
  });

  it("holdStatLine sep threads only the measured-field joiners; NO-READ prose keeps its dash", () => {
    // The DOM landing passes " · " to match its sibling rows; the joiners
    // switch, the field text is unchanged.
    expect(
      holdStatLine(
        holdStats({ timeInWindowSec: 1.6, stillnessRmsCm: 2.4, markErrCm: 11.2 }),
        "never-marked",
        " · ",
      ),
    ).toBe("HOLD 1.6S · STILL 2.4 CM · MARK 11 CM");
    // The NO-READ sentence is prose punctuation, sep-independent (the
    // turnStatLine convention).
    expect(holdStatLine(null, "no-data", " · ")).toBe(
      "HOLD: NO READ - THE HOLD WINDOW WAS NOT MEASURED",
    );
    // Default sep is unchanged (golden byte-identity).
    expect(
      holdStatLine(
        holdStats({ timeInWindowSec: 1.6, stillnessRmsCm: 2.4, markErrCm: 11.2 }),
        "never-marked",
      ),
    ).toBe("HOLD 1.6S - STILL 2.4 CM - MARK 11 CM");
  });

  it("holdStatLine null branches on the reason enum", () => {
    expect(holdStatLine(null, "never-marked")).toBe(
      "HOLD: NO READ - THE WALK ENDED BEFORE THE MARK",
    );
    expect(holdStatLine(null, "no-data")).toBe(
      "HOLD: NO READ - THE HOLD WINDOW WAS NOT MEASURED",
    );
  });

  it("holdCue null branches on the reason enum", () => {
    expect(holdCue(null, "never-marked")).toBe(
      "You never reached the pose mark - the hold was not measured.",
    );
    expect(holdCue(null, "no-data")).toBe(
      "You reached the mark but the hold was not measured - you never settled on it or tracking went dark.",
    );
  });

  it("drift fault cites the RAW cm and wins over the mark fault", () => {
    const drifty = holdStats({
      stillnessRmsCm: 6.2,
      stillnessNormRmsCm: 5.2,
      markErrCm: 50,
      markAlongCm: 50,
      markLatCm: 2,
    });
    expect(holdCue(drifty, "never-marked")).toBe(
      "You drifted 6.2 cm through the hold - hit the mark, freeze, count the beat.",
    );
  });

  it("mark fault: along-dominated short / past, else squared-up generic", () => {
    const short = holdStats({
      stillnessNormRmsCm: 3,
      markErrCm: 45,
      markAlongCm: -44,
      markLatCm: 9,
    });
    expect(holdCue(short, "never-marked")).toBe(
      "Your hold settled 45 cm short of the mark - walk all the way onto it before you set.",
    );
    const past = holdStats({
      stillnessNormRmsCm: 3,
      markErrCm: 45,
      markAlongCm: 44,
      markLatCm: 9,
    });
    expect(holdCue(past, "never-marked")).toBe(
      "Your hold settled 45 cm past the mark - stop on it, not through it.",
    );
    const diagonal = holdStats({
      stillnessNormRmsCm: 3,
      markErrCm: 42,
      markAlongCm: 30,
      markLatCm: 30,
    });
    // never names a side: the window can contain the turn
    expect(holdCue(diagonal, "never-marked")).toBe(
      "Your hold settled 42 cm off the mark - land it, square up, then freeze.",
    );
  });

  it("clean hold praises; between bands stays silent", () => {
    const clean = holdStats({
      stillnessRmsCm: 1.4,
      stillnessNormRmsCm: 1.4,
      markErrCm: 10,
    });
    expect(holdCue(clean, "never-marked")).toBe(
      "Held 1.4 cm still, 10 cm off the mark - a clean hold.",
    );
    const middling = holdStats({
      stillnessRmsCm: 3.1,
      stillnessNormRmsCm: 3.1,
      markErrCm: 20,
    });
    expect(holdCue(middling, "never-marked")).toBeNull();
    const stillButOff = holdStats({
      stillnessRmsCm: 1.4,
      stillnessNormRmsCm: 1.4,
      markErrCm: 25,
    });
    expect(holdCue(stillButOff, "never-marked")).toBeNull();
  });

  it("every reachable string is ASCII-printable (panel law)", () => {
    const measured: HoldStats = runTape(stillTape(-0.1, 0.05))!;
    const strings = [
      HOLD_EXPLAIN,
      holdStatLine(measured, "never-marked"),
      holdStatLine(null, "never-marked"),
      holdStatLine(null, "no-data"),
      holdCue(null, "never-marked"),
      holdCue(null, "no-data"),
      holdCue(holdStats({ stillnessNormRmsCm: 6 }), "never-marked"),
      holdCue(
        holdStats({ stillnessNormRmsCm: 3, markErrCm: 45, markAlongCm: -44, markLatCm: 0 }),
        "never-marked",
      ),
      holdCue(
        holdStats({ stillnessNormRmsCm: 3, markErrCm: 45, markAlongCm: 44, markLatCm: 0 }),
        "never-marked",
      ),
      holdCue(
        holdStats({ stillnessNormRmsCm: 3, markErrCm: 42, markAlongCm: 30, markLatCm: 30 }),
        "never-marked",
      ),
      holdCue(holdStats({}), "never-marked"),
    ];
    for (const s of strings) {
      expect(s).not.toBeNull();
      for (const ch of s!) {
        const c = ch.charCodeAt(0);
        expect(c, `non-ASCII char in: ${s}`).toBeGreaterThanOrEqual(32);
        expect(c, `non-ASCII char in: ${s}`).toBeLessThanOrEqual(126);
      }
    }
  });
});
