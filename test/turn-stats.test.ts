/**
 * M11 THE TURN — the pure segmentation machine, sub-measures, null/reason
 * taxonomy and copy builders (src/turn-stats.ts). Tapes model the REAL
 * wiring feed (the wiring-vs-tape law): approach transit, the one-frame-late
 * hold-armed edge, posing wander inside the hold window, the straddle-frame
 * dtEff trim at the window open, entry-clipped sweeps, never-settled rolling
 * turns, dark/frozen frames mid-pivot, and walk-end truncation mid-turn.
 */
import { describe, expect, it } from "vitest";

import {
  TURN_COMMIT_DEG,
  TURN_DIP_FAULT_FRAC,
  TURN_DUR_BASE_HI_SEC,
  TURN_DUR_BASE_LO_SEC,
  TURN_DUR_BASE_PACE_MPS,
  TURN_ENTER_DEG,
  TURN_EXIT_DEG,
  TURN_EXPLAIN,
  TURN_MIN_MEASURED_SEC,
  TURN_REACQ_BAR_M,
  TURN_REACQ_CUE_SEC,
  TURN_REACQ_SUSTAIN_SEC,
  TURN_RETURN_MIN_SEC,
  TURN_REV_DEADBAND_DEG,
  PRESENTATION_EXPLAIN_WITH_TURN,
  TurnTracker,
  turnCue,
  turnDurBand,
  turnStatLine,
  type TurnNullReason,
} from "../src/turn-stats.ts";
import { LATERAL_CUE_M, POSTURE_CUE_M } from "../src/coach-live.ts";
import { HOLD_REF_HEAD_M, HOLD_WINDOW_SEC } from "../src/hold-stats.ts";
import { DEFAULT_MODE, MODES } from "../src/modes.ts";
import { CarriageTracker } from "../src/head-carriage.ts";
import { calibrated, runCarriageTape } from "./carriage-helpers.ts";
import {
  cleanPivot,
  fullProtocolOps,
  makeTurnStats,
  protocolPrelude,
  returnLeg,
  runTurnTape,
  type TurnOp,
} from "./turn-helpers.ts";

const round2 = (v: number): number => Math.round(v * 100) / 100;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/** ops with the prelude's begin-walk swapped for a different mode pace. */
function withPace(ops: TurnOp[], idealPace: number): TurnOp[] {
  return [{ op: "begin-walk", fit: null, oneWay: false, idealPace }, ...ops.slice(1)];
}

// ---------------------------------------------------------------------------
// Constant derivations (the adjudication's arithmetic, asserted live).
// ---------------------------------------------------------------------------

describe("turn-stats constants", () => {
  it("exit gate is the symmetric hysteresis of the enter gate", () => {
    expect(TURN_EXIT_DEG).toBe(180 - TURN_ENTER_DEG);
    expect(TURN_EXIT_DEG).toBe(160);
  });

  it("gates order: enter < commit < exit", () => {
    expect(TURN_ENTER_DEG).toBeLessThan(TURN_COMMIT_DEG);
    expect(TURN_COMMIT_DEG).toBeLessThan(TURN_EXIT_DEG);
  });

  it("dip fault is meters over meters: POSTURE_CUE_M / HOLD_REF_HEAD_M (§A)", () => {
    expect(TURN_DIP_FAULT_FRAC).toBe(POSTURE_CUE_M / HOLD_REF_HEAD_M);
    // The unit assertion: the fraction is exactly 0.0375 (6 cm at 1.6 m).
    expect(TURN_DIP_FAULT_FRAC).toBe(0.0375);
  });

  it("re-acquisition bar is an alias of the live coach's cue line", () => {
    expect(TURN_REACQ_BAR_M).toBe(LATERAL_CUE_M);
  });

  it("base band is anchored at the Beginner ideal pace", () => {
    expect(TURN_DUR_BASE_PACE_MPS).toBe(DEFAULT_MODE.idealPace);
  });

  it("base band HIGH edge is declared as its derivation 4 / 1.8 (§H)", () => {
    expect(TURN_DUR_BASE_HI_SEC).toBe(4 / 1.8);
  });

  it("deadband clears the gait yaw oscillation, floors are one gait cycle", () => {
    expect(TURN_REV_DEADBAND_DEG).toBe(5);
    expect(TURN_MIN_MEASURED_SEC).toBe(1);
    expect(TURN_RETURN_MIN_SEC).toBe(1);
    expect(TURN_REACQ_SUSTAIN_SEC).toBe(0.5);
  });
});

describe("turnDurBand", () => {
  it("computes the per-mode table from the base constants (round2 stamps)", () => {
    for (const m of MODES) {
      const scale = TURN_DUR_BASE_PACE_MPS / m.idealPace;
      const band = turnDurBand(m.idealPace);
      expect(band.lo).toBe(round2(TURN_DUR_BASE_LO_SEC * scale));
      expect(band.hi).toBe(round2(TURN_DUR_BASE_HI_SEC * scale));
    }
  });

  it("spot table: beginner / highfashion / commercial / challenge", () => {
    expect(turnDurBand(0.85)).toEqual({ lo: 0.9, hi: 2.22 });
    expect(turnDurBand(0.72)).toEqual({ lo: 1.06, hi: 2.62 });
    expect(turnDurBand(0.95)).toEqual({ lo: 0.81, hi: 1.99 });
    expect(turnDurBand(1.05)).toEqual({ lo: 0.73, hi: 1.8 });
  });

  it("guards a junk pace with the reference band (identity scale)", () => {
    const base = { lo: 0.9, hi: 2.22 };
    expect(turnDurBand(NaN)).toEqual(base);
    expect(turnDurBand(0)).toEqual(base);
    expect(turnDurBand(-1)).toEqual(base);
    expect(turnDurBand(Infinity)).toEqual(base);
  });
});

// ---------------------------------------------------------------------------
// The full protocol (the wiring feed shape, end to end).
// ---------------------------------------------------------------------------

describe("full protocol tape", () => {
  const r = runTurnTape(fullProtocolOps(), { walkBase: 1.6 });

  it("measures the turn", () => {
    expect(r.stats).not.toBeNull();
  });

  it("segments the pivot at the entry/exit gates (closed-form times)", () => {
    // Entry at dev 32.5 (frame 2 of the pivot, walk 4.125 s), exit at 170.
    expect(r.stats!.startAtSec).toBe(4.13);
    expect(r.stats!.durationSec).toBe(1.25);
    expect(r.stats!.measuredSec).toBe(1.38); // 11 accepted turn frames
    expect(r.stats!.sweepDeg).toBe(137.5); // 170 - 32.5
  });

  it("hold-window wander (up to 60 deg) never leaks into the turn", () => {
    expect(r.stats!.entryClipped).toBe(false);
    expect(r.stats!.reversalCount).toBe(0);
    expect(r.stats!.sweepMonotoneFrac).toBe(1);
  });

  it("stamps the walk-locked band", () => {
    expect(r.stats!.durBandLoSec).toBe(0.9);
    expect(r.stats!.durBandHiSec).toBe(2.22);
  });

  it("dip: level head reads 0 cm against the walk baseline (source walk)", () => {
    expect(r.stats!.dipCm).toBe(0);
    expect(r.stats!.dipFrac).toBe(0);
    expect(r.stats!.heightM).toBe(1.6);
    expect(r.stats!.heightSource).toBe("walk");
  });

  it("pitch tap in band the whole turn", () => {
    expect(r.stats!.pitchInBandFrac).toBe(1);
  });

  it("re-acquires at the sustained stretch ENTRY (0.75 s), not entry+sustain", () => {
    expect(r.stats!.reacquireSec).toBe(0.75);
    expect(r.stats!.reacquireCapped).toBe(false);
  });

  it("earns the clean cue", () => {
    expect(turnCue(r.stats, r.reason)).toBe(
      `One motion in ${r.stats!.durationSec.toFixed(1)} s, level all the way round - a clean turn.`,
    );
  });

  it("stat line", () => {
    expect(turnStatLine(r.stats, r.reason)).toBe(
      "TURN 1.3S - ONE MOTION - DIP 0 CM - LINE IN 0.8S",
    );
  });

  it("finalize is non-destructive and re-callable", () => {
    expect(r.tracker.finalize(1.6)).toEqual(r.stats);
    expect(r.tracker.finalize(1.6)).toEqual(r.stats);
  });
});

// ---------------------------------------------------------------------------
// The dip channel (adjudication §A anchor + ladder + null discipline).
// ---------------------------------------------------------------------------

describe("dip channel", () => {
  it("§A anchor: a 6 cm dip at a 1.6 m body reads dipFrac exactly at the fault", () => {
    const ops = [...protocolPrelude(), ...cleanPivot(1.54), ...returnLeg()];
    const r = runTurnTape(ops, { walkBase: 1.6 });
    expect(r.stats!.dipCm).toBe(6);
    expect(r.stats!.dipFrac).toBe(TURN_DIP_FAULT_FRAC);
    expect(r.stats!.dipFrac).toBe(0.0375);
    expect(turnCue(r.stats, r.reason)).toBe(
      "You sank 6 cm through the turn - stay tall as you come around.",
    );
  });

  it("FIT height normalizes when present (source fit)", () => {
    const ops = [...protocolPrelude(), ...cleanPivot(1.54), ...returnLeg()];
    ops[0] = { op: "begin-walk", fit: 1.7, oneWay: false, idealPace: 0.85 };
    const r = runTurnTape(ops, { walkBase: 1.6 });
    expect(r.stats!.heightSource).toBe("fit");
    expect(r.stats!.heightM).toBe(1.7);
    // Dip DELTA still vs the WALK baseline; only the denominator is FIT.
    expect(r.stats!.dipCm).toBe(6);
    expect(r.stats!.dipFrac).toBe(round4((1.6 - 1.54) / 1.7));
  });

  it("sub-standing walk baseline falls to the reference denominator (source ref)", () => {
    const ops = [...protocolPrelude(), ...cleanPivot(0.35), ...returnLeg()];
    const r = runTurnTape(ops, { walkBase: 0.4 });
    expect(r.stats!.heightSource).toBe("ref");
    expect(r.stats!.heightM).toBe(HOLD_REF_HEAD_M);
    expect(r.stats!.dipCm).toBe(5); // 0.4 - 0.35, still vs the walk baseline
    expect(r.stats!.dipFrac).toBe(round4((0.4 - 0.35) / HOLD_REF_HEAD_M));
  });

  it("walk-baseline-dark: the dip channel is null while everything else measures", () => {
    const r = runTurnTape(fullProtocolOps(), { walkBase: null });
    expect(r.stats).not.toBeNull();
    expect(r.stats!.dipCm).toBeNull();
    expect(r.stats!.dipFrac).toBeNull();
    expect(r.stats!.heightM).toBeNull();
    expect(r.stats!.heightSource).toBeNull();
    expect(r.stats!.durationSec).toBe(1.25);
    // The stat line omits the DIP segment (nothing measured, nothing said).
    expect(turnStatLine(r.stats, r.reason)).toBe(
      "TURN 1.3S - ONE MOTION - LINE IN 0.8S",
    );
  });

  it("dark headY frames mid-turn skip the dip fold only", () => {
    const ops = [
      ...protocolPrelude(),
      { op: "sweep", devFrom: 5, devTo: 100, frames: 6, headY: 1.55 } as TurnOp,
      { op: "frame", devDeg: 110, headY: NaN } as TurnOp,
      { op: "sweep", devFrom: 120, devTo: 170, frames: 4, headY: 1.55 } as TurnOp,
      ...returnLeg(),
    ];
    const r = runTurnTape(ops, { walkBase: 1.6 });
    expect(r.stats).not.toBeNull();
    expect(r.stats!.dipCm).toBe(5); // the NaN frame never entered the EMA
  });
});

// ---------------------------------------------------------------------------
// Entry-clipped sweeps (adjudication §C).
// ---------------------------------------------------------------------------

describe("entry-clipped turns", () => {
  // Head parked at 40 deg when the hold window closes: the sweep provably
  // began inside the hold — measure the remainder, stamp it.
  const clipped = [
    ...protocolPrelude(40),
    { op: "sweep", devFrom: 66, devTo: 170, frames: 4, lat: 0.02 } as TurnOp,
    { op: "frame", devDeg: 172, lat: 0.05, reps: 10 } as TurnOp,
  ];
  const r = runTurnTape(clipped, { walkBase: 1.6 });

  it("stamps entryClipped and measures from the hold release", () => {
    expect(r.stats).not.toBeNull();
    expect(r.stats!.entryClipped).toBe(true);
    expect(r.stats!.startAtSec).toBe(3.88); // the straddle frame itself
    expect(r.stats!.durationSec).toBe(0.5);
  });

  it("the straddle frame carries only its post-open sliver (§H dtEff trim)", () => {
    // 0.025 (trimmed straddle) + 4 pivot frames * 0.125 = 0.525 -> round2
    // lands at 0.52 (the trim is fractionally under 0.025 because
    // windowOpen = armAt + HOLD_WINDOW_SEC carries 1.6's float excess).
    expect(r.stats!.measuredSec).toBe(0.52);
  });

  it("suppresses the duration verdict (a 0.5 s remainder is NOT a whip)", () => {
    // Duration is under the band's low edge, but the clipped stamp
    // suppresses both duration cues AND the clean claim -> no cue at all.
    expect(r.stats!.durationSec).toBeLessThan(r.stats!.durBandLoSec);
    expect(turnCue(r.stats, r.reason)).toBeNull();
  });

  it("labels the measured remainder in the stat line", () => {
    expect(turnStatLine(r.stats, r.reason)).toBe(
      "TURN 0.5S FROM THE HOLD RELEASE - ONE MOTION - DIP 0 CM - LINE IN 0.0S",
    );
  });

  it("a dip fault still cues on a clipped turn (the dip outranks everything)", () => {
    const ops = [
      ...protocolPrelude(40),
      { op: "sweep", devFrom: 66, devTo: 170, frames: 4, lat: 0.02, headY: 1.5 } as TurnOp,
      { op: "frame", devDeg: 172, lat: 0.05, reps: 10 } as TurnOp,
    ];
    const rr = runTurnTape(ops, { walkBase: 1.6 });
    expect(rr.stats!.entryClipped).toBe(true);
    expect(turnCue(rr.stats, rr.reason)).toBe(
      "You sank 10 cm through the turn - stay tall as you come around.",
    );
  });

  it("an aborted clipped entry clears the stamp (it was hold wander, not a sweep)", () => {
    const ops = [
      ...protocolPrelude(25),
      { op: "sweep", devFrom: 18, devTo: 4, frames: 2, lat: 0.02 } as TurnOp, // back on line: abort
      ...cleanPivot(),
      ...returnLeg(),
    ];
    const rr = runTurnTape(ops, { walkBase: 1.6 });
    expect(rr.stats).not.toBeNull();
    expect(rr.stats!.entryClipped).toBe(false);
    expect(rr.stats!.reversalCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Null/reason taxonomy (adjudication §B ordering).
// ---------------------------------------------------------------------------

describe("null reasons", () => {
  it("one-way route: the machine is dark by protocol", () => {
    const ops = fullProtocolOps();
    ops[0] = { op: "begin-walk", fit: null, oneWay: true, idealPace: 0.85 };
    const r = runTurnTape(ops, { walkBase: 1.6 });
    expect(r.stats).toBeNull();
    expect(r.reason).toBe("one-way-route");
  });

  it("never-marked: the walk ended before the mark", () => {
    const r = runTurnTape([
      { op: "begin-walk" },
      { op: "frame", devDeg: 0, reps: 20 },
    ]);
    expect(r.stats).toBeNull();
    expect(r.reason).toBe("never-marked");
  });

  it("never-settled: live post-mark stream, hold never armed (rolling turn)", () => {
    const r = runTurnTape([
      { op: "begin-walk" },
      { op: "frame", devDeg: 0, lat: 0.1, reps: 16 },
      { op: "mark" },
      // A rolling 180 on the move — head speed never drops, the hold
      // never arms, the head path still sweeps home.
      { op: "sweep", devFrom: 0, devTo: 180, frames: 24, lat: 0.1 },
      { op: "frame", devDeg: 178, lat: 0.1, reps: 8 },
    ]);
    expect(r.stats).toBeNull();
    expect(r.reason).toBe("never-settled");
  });

  it("tracking-dark: a frozen mark beat is a sensor fact, not a motion fact", () => {
    const r = runTurnTape([
      { op: "begin-walk" },
      { op: "frame", devDeg: 0, lat: 0.1, reps: 16 },
      { op: "mark" },
      { op: "freeze", reps: 30 }, // bit-identical repeats: zero accepted
    ]);
    expect(r.stats).toBeNull();
    expect(r.reason).toBe("tracking-dark");
  });

  it("turned-in-hold: past the commit gate at the first accepted post-open frame", () => {
    const r = runTurnTape([
      ...protocolPrelude(120),
      { op: "frame", devDeg: 120, reps: 10 }, // live stream after (clears the floor)
    ]);
    expect(r.stats).toBeNull();
    expect(r.reason).toBe("turned-in-hold");
  });

  it("turned-in-hold + dark turn span floors to tracking-dark (spec order)", () => {
    const r = runTurnTape([
      ...protocolPrelude(120),
      { op: "dark-frame", reps: 10 },
    ]);
    expect(r.stats).toBeNull();
    expect(r.reason).toBe("tracking-dark");
  });

  it("walk-ended-mid-turn: committed at walk end", () => {
    const r = runTurnTape([
      ...protocolPrelude(),
      { op: "sweep", devFrom: 5, devTo: 130, frames: 8 },
    ]);
    expect(r.stats).toBeNull();
    expect(r.reason).toBe("walk-ended-mid-turn");
  });

  it("§B ordering: the commit latch outranks the min-measured floor", () => {
    // Committed with only ~0.4 accepted seconds: a truncation fact, never
    // a dark claim.
    const r = runTurnTape([
      ...protocolPrelude(),
      { op: "sweep", devFrom: 30, devTo: 130, frames: 3 },
    ]);
    expect(r.stats).toBeNull();
    expect(r.reason).toBe("walk-ended-mid-turn");
  });

  it("a provisional fragment at walk end folds into no-turn (abort semantics)", () => {
    const r = runTurnTape([
      ...protocolPrelude(),
      { op: "frame", devDeg: 60, reps: 12 }, // entered, never committed
    ]);
    expect(r.stats).toBeNull();
    expect(r.reason).toBe("no-turn");
  });

  it("no-turn: a measured window with the head on the line the whole time", () => {
    const r = runTurnTape([
      ...protocolPrelude(),
      { op: "frame", devDeg: 4, reps: 16 },
    ]);
    expect(r.stats).toBeNull();
    expect(r.reason).toBe("no-turn");
  });

  it("tracking-dark: window opened, then nothing measured", () => {
    const r = runTurnTape([...protocolPrelude(), { op: "dark-frame", reps: 20 }]);
    expect(r.stats).toBeNull();
    expect(r.reason).toBe("tracking-dark");
  });

  it("an armed hold can never read never-marked (the defensive mark latch)", () => {
    const r = runTurnTape([
      { op: "begin-walk" },
      { op: "frame", devDeg: 0, reps: 2 },
      { op: "hold-armed" }, // no mark op — the arm implies the mark
    ]);
    expect(r.stats).toBeNull();
    expect(r.reason).toBe("tracking-dark"); // not "never-marked"
  });
});

// ---------------------------------------------------------------------------
// Sweep smoothness (deadband zigzag + monotone fraction).
// ---------------------------------------------------------------------------

describe("sweep smoothness", () => {
  it("stutter: two 10-deg retreats -> 2 reversals, arithmetic-pinned fraction", () => {
    const devs = [25, 50, 80, 70, 100, 120, 110, 140, 165];
    const ops: TurnOp[] = [
      ...protocolPrelude(),
      ...devs.map((d): TurnOp => ({ op: "frame", devDeg: d, lat: 0.02 })),
      ...returnLeg(),
    ];
    const r = runTurnTape(ops, { walkBase: 1.6 });
    expect(r.stats).not.toBeNull();
    expect(r.stats!.reversalCount).toBe(2);
    // net = 165 - 25 = 140; total = net + 2 * (10 + 10) = 180.
    expect(r.stats!.sweepMonotoneFrac).toBe(round3(140 / 180));
    expect(r.stats!.sweepDeg).toBe(140);
    expect(turnCue(r.stats, r.reason)).toBe(
      "Your head swept back 2 times mid-turn - one motion, commit the turn.",
    );
  });

  it("sub-deadband wobble never counts (gait oscillation is not a stutter)", () => {
    const devs = [25, 50, 47, 75, 72, 100, 130, 165];
    const ops: TurnOp[] = [
      ...protocolPrelude(),
      ...devs.map((d): TurnOp => ({ op: "frame", devDeg: d, lat: 0.02 })),
      ...returnLeg(),
    ];
    const r = runTurnTape(ops, { walkBase: 1.6 });
    expect(r.stats!.reversalCount).toBe(0);
    expect(r.stats!.sweepMonotoneFrac).toBe(1);
  });

  it("one sweep-back cues in the singular", () => {
    const devs = [25, 60, 100, 88, 130, 165];
    const ops: TurnOp[] = [
      ...protocolPrelude(),
      ...devs.map((d): TurnOp => ({ op: "frame", devDeg: d, lat: 0.02 })),
      ...returnLeg(),
    ];
    const r = runTurnTape(ops, { walkBase: 1.6 });
    expect(r.stats!.reversalCount).toBe(1);
    expect(turnCue(r.stats, r.reason)).toBe(
      "Your head swept back once mid-turn - one motion, commit the turn.",
    );
  });

  it("a LEFT turn measures identically (sign symmetry)", () => {
    const ops: TurnOp[] = [
      ...protocolPrelude(-4),
      { op: "sweep", devFrom: -5, devTo: -170, frames: 12, lat: 0.02 },
      { op: "frame", devDeg: -172, lat: 0.05, reps: 10 },
    ];
    const r = runTurnTape(ops, { walkBase: 1.6 });
    expect(r.stats).not.toBeNull();
    expect(r.stats!.sweepDeg).toBe(137.5);
    expect(r.stats!.reversalCount).toBe(0);
    expect(r.stats!.sweepMonotoneFrac).toBe(1);
  });

  it("overshoot past 180 unwraps through the seam (no fake reversal)", () => {
    const ops: TurnOp[] = [
      ...protocolPrelude(),
      { op: "sweep", devFrom: 5, devTo: 185, frames: 12, lat: 0.02 },
      { op: "frame", devDeg: 186, lat: 0.05, reps: 10 },
    ];
    const r = runTurnTape(ops, { walkBase: 1.6 });
    expect(r.stats).not.toBeNull();
    expect(r.stats!.reversalCount).toBe(0);
    expect(r.stats!.sweepMonotoneFrac).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Duration band (mode-scaled) + glance/abort.
// ---------------------------------------------------------------------------

describe("duration + glances", () => {
  const slowPivot: TurnOp[] = [
    { op: "sweep", devFrom: 5, devTo: 170, frames: 20, lat: 0.02 },
  ];

  it("a slow deliberate 2.13 s turn is OVER the challenge band and cues", () => {
    // dev = 5 + 8.25k: entry at k=2 (21.5), exit at k=19 (161.75) -> 17
    // frames = 2.125 s.
    const ops = withPace([...protocolPrelude(), ...slowPivot, ...returnLeg()], 1.05);
    const r = runTurnTape(ops, { walkBase: 1.6 });
    expect(r.stats!.durationSec).toBe(2.13);
    expect(r.stats!.durBandHiSec).toBe(1.8);
    expect(turnCue(r.stats, r.reason)).toBe(
      `The turn took ${r.stats!.durationSec.toFixed(1)} s - hit the mark, turn, and go.`,
    );
  });

  it("the same turn is INSIDE the highfashion band and reads clean", () => {
    const ops = withPace([...protocolPrelude(), ...slowPivot, ...returnLeg()], 0.72);
    const r = runTurnTape(ops, { walkBase: 1.6 });
    expect(r.stats!.durBandLoSec).toBe(1.06);
    expect(r.stats!.durBandHiSec).toBe(2.62);
    expect(turnCue(r.stats, r.reason)).toBe(
      `One motion in ${r.stats!.durationSec.toFixed(1)} s, level all the way round - a clean turn.`,
    );
  });

  it("a whipped turn under the band cues (unclipped)", () => {
    const ops = [
      ...protocolPrelude(),
      { op: "sweep", devFrom: 5, devTo: 170, frames: 6, lat: 0.02 } as TurnOp, // 0.625 s
      ...returnLeg(),
    ];
    const r = runTurnTape(ops, { walkBase: 1.6 });
    expect(r.stats!.durationSec).toBeLessThan(r.stats!.durBandLoSec);
    expect(turnCue(r.stats, r.reason)).toBe(
      `You whipped the turn in ${r.stats!.durationSec.toFixed(1)} s - give it one controlled beat.`,
    );
  });

  it("a glance (60 deg and back) aborts; a later real turn measures cleanly", () => {
    const ops: TurnOp[] = [
      ...protocolPrelude(),
      { op: "sweep", devFrom: 4, devTo: 60, frames: 4, lat: 0.02 },
      { op: "sweep", devFrom: 46, devTo: 4, frames: 4, lat: 0.02 }, // back on line
      ...cleanPivot(),
      ...returnLeg(),
    ];
    const r = runTurnTape(ops, { walkBase: 1.6 });
    expect(r.stats).not.toBeNull();
    // The discarded glance leaks nothing: fresh entry, zero reversals.
    expect(r.stats!.startAtSec).toBe(5.13);
    expect(r.stats!.reversalCount).toBe(0);
    expect(r.stats!.sweepMonotoneFrac).toBe(1);
    expect(r.stats!.entryClipped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dark + frozen frames mid-pivot (the guard laws).
// ---------------------------------------------------------------------------

describe("dark and frozen frames", () => {
  it("dark frames mid-pivot: zero weight, sweep resumes, no reversal minted", () => {
    const ops: TurnOp[] = [
      ...protocolPrelude(),
      { op: "sweep", devFrom: 5, devTo: 100, frames: 6, lat: 0.02 },
      { op: "dark-frame", reps: 4 },
      { op: "sweep", devFrom: 110, devTo: 170, frames: 4, lat: 0.02 },
      ...returnLeg(),
    ];
    const r = runTurnTape(ops, { walkBase: 1.6 });
    expect(r.stats).not.toBeNull();
    expect(r.stats!.reversalCount).toBe(0);
    expect(r.stats!.sweepMonotoneFrac).toBe(1);
    // Duration spans the gap (wall of the walk clock); measured does not.
    expect(r.stats!.durationSec).toBe(1.63);
    expect(r.stats!.measuredSec).toBe(1.25);
  });

  it("frozen repeats mid-pivot: zero weight, the sweep resumes", () => {
    const ops: TurnOp[] = [
      ...protocolPrelude(),
      { op: "sweep", devFrom: 5, devTo: 150, frames: 8, lat: 0.02 },
      { op: "freeze", reps: 8 },
      { op: "sweep", devFrom: 150, devTo: 165, frames: 2, lat: 0.02 },
      ...returnLeg(),
    ];
    const r = runTurnTape(ops, { walkBase: 1.6 });
    expect(r.stats).not.toBeNull();
    expect(r.stats!.reversalCount).toBe(0);
    expect(r.stats!.measuredSec).toBe(1.25); // 8 + 2 accepted frames only
  });

  it("a frozen stream can never complete a turn", () => {
    const r = runTurnTape([
      ...protocolPrelude(),
      { op: "sweep", devFrom: 5, devTo: 150, frames: 8, lat: 0.02 },
      { op: "freeze", reps: 20 },
    ]);
    expect(r.stats).toBeNull();
    expect(r.reason).toBe("walk-ended-mid-turn"); // committed, honest truncation
  });

  it("junk-clock frames are inert", () => {
    const base = fullProtocolOps();
    const withJunk: TurnOp[] = [
      ...protocolPrelude(),
      { op: "bad-dt-frame", dt: 0 },
      { op: "bad-dt-frame", dt: -1 },
      { op: "bad-dt-frame", dt: NaN },
      ...cleanPivot(),
      ...returnLeg(),
    ];
    const a = runTurnTape(base, { walkBase: 1.6 });
    const b = runTurnTape(withJunk, { walkBase: 1.6 });
    expect(b.stats).toEqual(a.stats);
  });

  it("a non-finite walk clock is inert (direct)", () => {
    const t = new TurnTracker();
    t.beginWalk(null, false, 0.85);
    t.noteMark(1);
    t.noteHoldArmed(1);
    t.update(0.125, NaN, 0, 0, 0, 1, 0, 0, 1.6, 0);
    expect(t.nullReason()).toBe("tracking-dark"); // nothing accepted
  });
});

// ---------------------------------------------------------------------------
// Line re-acquisition on the return leg.
// ---------------------------------------------------------------------------

describe("re-acquisition", () => {
  const pivotOps = [...protocolPrelude(), ...cleanPivot()];

  it("S-swing pass-through: the first SUSTAINED stretch wins", () => {
    const r = runTurnTape(
      [
        ...pivotOps,
        { op: "frame", devDeg: 172, lat: 0.1, reps: 2 }, // 0.25 s — not sustained
        { op: "frame", devDeg: 172, lat: 0.4, reps: 2 },
        { op: "frame", devDeg: 172, lat: 0.1, reps: 8 },
      ],
      { walkBase: 1.6 },
    );
    expect(r.stats!.reacquireSec).toBe(0.5);
    expect(r.stats!.reacquireCapped).toBe(false);
  });

  it("never re-centered: capped at the full return span, disclosed", () => {
    const r = runTurnTape(
      [...pivotOps, { op: "frame", devDeg: 172, lat: 0.5, reps: 12 }],
      { walkBase: 1.6 },
    );
    expect(r.stats!.reacquireSec).toBe(1.5);
    expect(r.stats!.reacquireCapped).toBe(true);
    expect(turnStatLine(r.stats, r.reason)).toContain("LINE NOT RE-CENTERED");
    expect(turnCue(r.stats, r.reason)).toBe(
      "You never got back on the line after the turn - find center, then drive home.",
    );
  });

  it("a dark return leg claims nothing (reacquireSec null)", () => {
    const r = runTurnTape([...pivotOps, { op: "dark-frame", reps: 12 }], {
      walkBase: 1.6,
    });
    expect(r.stats).not.toBeNull();
    expect(r.stats!.reacquireSec).toBeNull();
    expect(r.stats!.reacquireCapped).toBe(false);
    // The stat line omits the LINE segment entirely.
    expect(turnStatLine(r.stats, r.reason)).not.toContain("LINE");
  });

  it("under a second of measured return is also unmeasured (the floor)", () => {
    const r = runTurnTape(
      [...pivotOps, { op: "frame", devDeg: 172, lat: 0.5, reps: 6 }], // 0.75 s
      { walkBase: 1.6 },
    );
    expect(r.stats!.reacquireSec).toBeNull();
  });

  it("turned ON the line: 0.0 legitimately", () => {
    const r = runTurnTape(
      [...pivotOps, { op: "frame", devDeg: 172, lat: 0.05, reps: 10 }],
      { walkBase: 1.6 },
    );
    expect(r.stats!.reacquireSec).toBe(0);
    expect(r.stats!.reacquireCapped).toBe(false);
  });

  it("a dark lateral frame resets the sustain candidate (a gap breaks evidence)", () => {
    const r = runTurnTape(
      [
        ...pivotOps,
        { op: "frame", devDeg: 172, lat: 0.1, reps: 3 }, // 0.375 s — almost
        { op: "frame", devDeg: 172, lat: NaN, reps: 1 },
        // A real stream never repeats a pre-gap pose bit-identically: the
        // post-gap frames carry a distinct deviation so the frozen guard
        // (correctly) stays out of the way of this reset case.
        { op: "frame", devDeg: 171, lat: 0.1, reps: 8 },
      ],
      { walkBase: 1.6 },
    );
    // The pre-gap stretch is discarded; the claim is the post-gap entry.
    expect(r.stats!.reacquireSec).toBe(0.5);
  });

  it("slow re-centering past the cue line cues", () => {
    const r = runTurnTape(
      [
        ...pivotOps,
        { op: "frame", devDeg: 172, lat: 0.5, reps: 26 }, // 3.25 s off line
        { op: "frame", devDeg: 172, lat: 0.1, reps: 8 },
      ],
      { walkBase: 1.6 },
    );
    expect(r.stats!.reacquireSec).toBe(3.25);
    expect(r.stats!.reacquireSec).toBeGreaterThanOrEqual(TURN_REACQ_CUE_SEC);
    expect(turnCue(r.stats, r.reason)).toBe(
      "It took 3.3 s to find the line again after the turn - square up and go.",
    );
  });

  it("yaw-dark but lateral-live return frames still fold the read", () => {
    const r = runTurnTape(
      [...pivotOps, { op: "dark-frame", lat: 0.1, reps: 10 }],
      { walkBase: 1.6 },
    );
    expect(r.stats!.reacquireSec).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pitch-through-turn (the M8 raw tap, consumed).
// ---------------------------------------------------------------------------

describe("pitch through the turn", () => {
  it("null-tap frames fold nothing; in-band arithmetic pinned", () => {
    const ops: TurnOp[] = [
      ...protocolPrelude(),
      { op: "sweep", devFrom: 5, devTo: 60, frames: 4, lat: 0.02, pitchDev: null },
      { op: "sweep", devFrom: 74, devTo: 130, frames: 4, lat: 0.02, pitchDev: 10 },
      { op: "sweep", devFrom: 140, devTo: 158, frames: 2, lat: 0.02, pitchDev: 3 },
      { op: "frame", devDeg: 165, lat: 0.02, pitchDev: 3 },
      ...returnLeg(),
    ];
    const r = runTurnTape(ops, { walkBase: 1.6 });
    expect(r.stats).not.toBeNull();
    // pitchSec = 7 tapped frames (4 at 10 deg out-of-band, 3 at 3 deg in).
    expect(r.stats!.pitchInBandFrac).toBe(round3(0.375 / 0.875));
  });

  it("a tap dark through the whole turn reads null", () => {
    const ops: TurnOp[] = [
      ...protocolPrelude(),
      { op: "sweep", devFrom: 5, devTo: 170, frames: 12, lat: 0.02, pitchDev: null },
      ...returnLeg(),
    ];
    const r = runTurnTape(ops, { walkBase: 1.6 });
    expect(r.stats).not.toBeNull();
    expect(r.stats!.pitchInBandFrac).toBeNull();
  });

  it("band edge is M8's own band (7 deg, inclusive)", () => {
    const ops: TurnOp[] = [
      ...protocolPrelude(),
      { op: "sweep", devFrom: 5, devTo: 100, frames: 6, lat: 0.02, pitchDev: 7 },
      { op: "sweep", devFrom: 112, devTo: 170, frames: 5, lat: 0.02, pitchDev: -7.5 },
      ...returnLeg(),
    ];
    const r = runTurnTape(ops, { walkBase: 1.6 });
    expect(r.stats!.pitchInBandFrac).toBe(round3(6 / 11));
  });
});

// ---------------------------------------------------------------------------
// Remap + latch laws.
// ---------------------------------------------------------------------------

describe("remap and latches", () => {
  it("resetRoute discards a half-measured turn; the new geometry measures fresh", () => {
    const ops: TurnOp[] = [
      ...protocolPrelude(),
      { op: "sweep", devFrom: 5, devTo: 100, frames: 6, lat: 0.02 }, // mid-turn...
      { op: "reset-route", oneWay: false }, // ...remap
      // The fresh protocol on the new geometry.
      { op: "frame", devDeg: 0, lat: 0.3, reps: 4 },
      { op: "mark" },
      { op: "frame", devDeg: 0, lat: 0.05, reps: 2 },
      { op: "hold-armed" },
      { op: "frame", devDeg: 4, lat: 0.02, reps: 13 },
      ...cleanPivot(),
      ...returnLeg(),
    ];
    const r = runTurnTape(ops, { walkBase: 1.6 });
    expect(r.stats).not.toBeNull();
    expect(r.stats!.entryClipped).toBe(false);
    expect(r.stats!.durationSec).toBe(1.25);
    // Entry belongs to the SECOND geometry's pivot (well past the remap).
    expect(r.stats!.startAtSec).toBeGreaterThan(6);
    // The band snapshot survived the remap (the mode did not change).
    expect(r.stats!.durBandHiSec).toBe(2.22);
  });

  it("immediately after a remap the machine is re-armed (never-marked)", () => {
    const r = runTurnTape([
      ...protocolPrelude(),
      { op: "sweep", devFrom: 5, devTo: 100, frames: 6 },
      { op: "reset-route", oneWay: false },
    ]);
    expect(r.stats).toBeNull();
    expect(r.reason).toBe("never-marked");
  });

  it("a remap to a U goes dark as one-way-route", () => {
    const r = runTurnTape([
      ...protocolPrelude(),
      { op: "reset-route", oneWay: true },
      { op: "frame", devDeg: 0, reps: 4 },
    ]);
    expect(r.stats).toBeNull();
    expect(r.reason).toBe("one-way-route");
  });

  it("noteMark / noteHoldArmed are idempotent edges (first call wins)", () => {
    const ops: TurnOp[] = [
      { op: "begin-walk" },
      { op: "frame", devDeg: 0, lat: 0.3, reps: 8 },
      { op: "mark" },
      { op: "frame", devDeg: 0, lat: 0.05, reps: 2 },
      { op: "hold-armed" },
      { op: "frame", devDeg: 4, lat: 0.02, reps: 13 },
      { op: "mark" }, // repeated edges must be ignored
      { op: "hold-armed" },
      ...cleanPivot(),
      ...returnLeg(),
    ];
    const r = runTurnTape(ops, { walkBase: 1.6 });
    // Had the SECOND hold-armed won, the window would open ~1.6 s later
    // and this pivot would be unmeasured.
    expect(r.stats).not.toBeNull();
    expect(r.stats!.durationSec).toBe(1.25);
  });

  it("beginWalk re-arms everything including the frozen-pose reference", () => {
    const t = new TurnTracker();
    const first = runTurnTape(fullProtocolOps(), { walkBase: 1.6, tracker: t });
    expect(first.stats).not.toBeNull();
    const second = runTurnTape(fullProtocolOps(), { walkBase: 1.6, tracker: t });
    expect(second.stats).toEqual(first.stats);
  });
});

// ---------------------------------------------------------------------------
// Copy builders (exact strings; every branch).
// ---------------------------------------------------------------------------

describe("turnStatLine", () => {
  const NULL_LINES: Array<[TurnNullReason, string]> = [
    ["one-way-route", "TURN: NO TURN ON A ONE-WAY ROUTE"],
    ["never-marked", "TURN: NO READ - THE WALK ENDED BEFORE THE MARK"],
    ["never-settled", "TURN: NO READ - YOU NEVER SETTLED ON THE MARK"],
    ["turned-in-hold", "TURN: NO READ - THE TURN HAPPENED INSIDE THE HOLD WINDOW"],
    ["no-turn", "TURN: NO READ - NO 180 TURN ON THE HEAD PATH"],
    ["walk-ended-mid-turn", "TURN: NO READ - THE WALK ENDED MID-TURN"],
    ["tracking-dark", "TURN: NO READ - TRACKING WENT DARK AT THE MARK"],
  ];

  it("every null branch carries its reason", () => {
    for (const [reason, line] of NULL_LINES) {
      expect(turnStatLine(null, reason)).toBe(line);
    }
  });

  it("measured line with every segment", () => {
    const t = makeTurnStats({ durationSec: 1.4, dipCm: 2.1, reacquireSec: 1.2 });
    expect(turnStatLine(t, "no-turn")).toBe(
      "TURN 1.4S - ONE MOTION - DIP 2 CM - LINE IN 1.2S",
    );
  });

  it("landing separator variant", () => {
    const t = makeTurnStats({ durationSec: 1.4, dipCm: 2.1, reacquireSec: 1.2 });
    expect(turnStatLine(t, "no-turn", " · ")).toBe(
      "TURN 1.4S · ONE MOTION · DIP 2 CM · LINE IN 1.2S",
    );
  });

  it("sweep-back labels: 1 / n", () => {
    expect(
      turnStatLine(makeTurnStats({ durationSec: 1.4, reversalCount: 1 }), "no-turn"),
    ).toContain("1 SWEEP-BACK - ");
    expect(
      turnStatLine(makeTurnStats({ durationSec: 1.4, reversalCount: 3 }), "no-turn"),
    ).toContain("3 SWEEP-BACKS");
  });

  it("null sub-channels omit their segments", () => {
    const t = makeTurnStats({
      durationSec: 1.4,
      dipCm: null,
      dipFrac: null,
      heightM: null,
      heightSource: null,
      reacquireSec: null,
    });
    expect(turnStatLine(t, "no-turn")).toBe("TURN 1.4S - ONE MOTION");
  });

  it("capped renders the NOT RE-CENTERED form", () => {
    const t = makeTurnStats({
      durationSec: 1.4,
      dipCm: null,
      dipFrac: null,
      reacquireSec: 4.2,
      reacquireCapped: true,
    });
    expect(turnStatLine(t, "no-turn")).toBe(
      "TURN 1.4S - ONE MOTION - LINE NOT RE-CENTERED",
    );
  });

  it("clipped labels the remainder", () => {
    const t = makeTurnStats({ durationSec: 0.6, entryClipped: true, dipCm: null, dipFrac: null, reacquireSec: null });
    expect(turnStatLine(t, "no-turn")).toBe(
      "TURN 0.6S FROM THE HOLD RELEASE - ONE MOTION",
    );
  });
});

describe("turnCue selection order", () => {
  it("dip fault outranks everything", () => {
    const t = makeTurnStats({
      dipCm: 8,
      dipFrac: 0.05,
      reversalCount: 2,
      durationSec: 3.5,
      reacquireCapped: true,
    });
    expect(turnCue(t, "no-turn")).toBe(
      "You sank 8 cm through the turn - stay tall as you come around.",
    );
  });

  it("reversals outrank duration", () => {
    const t = makeTurnStats({ reversalCount: 1, durationSec: 3.5 });
    expect(turnCue(t, "no-turn")).toBe(
      "Your head swept back once mid-turn - one motion, commit the turn.",
    );
  });

  it("duration outranks the line", () => {
    const t = makeTurnStats({ durationSec: 3.5, reacquireSec: 5, reacquireCapped: true });
    expect(turnCue(t, "no-turn")).toBe(
      "The turn took 3.5 s - hit the mark, turn, and go.",
    );
  });

  it("whip cue on an unclipped fast turn", () => {
    const t = makeTurnStats({ durationSec: 0.6 });
    expect(turnCue(t, "no-turn")).toBe(
      "You whipped the turn in 0.6 s - give it one controlled beat.",
    );
  });

  it("clipped suppresses BOTH duration verdicts", () => {
    expect(turnCue(makeTurnStats({ durationSec: 0.6, entryClipped: true }), "no-turn")).toBeNull();
    expect(turnCue(makeTurnStats({ durationSec: 3.5, entryClipped: true }), "no-turn")).toBeNull();
  });

  it("the line cues when everything above is clean", () => {
    expect(turnCue(makeTurnStats({ reacquireSec: 4.5 }), "no-turn")).toBe(
      "It took 4.5 s to find the line again after the turn - square up and go.",
    );
    expect(
      turnCue(makeTurnStats({ reacquireSec: 6, reacquireCapped: true }), "no-turn"),
    ).toBe(
      "You never got back on the line after the turn - find center, then drive home.",
    );
  });

  it("clean requires every clause MEASURED clean", () => {
    expect(turnCue(makeTurnStats({ durationSec: 1.4 }), "no-turn")).toBe(
      "One motion in 1.4 s, level all the way round - a clean turn.",
    );
    // An unmeasured dip cannot back "level all the way round".
    expect(
      turnCue(
        makeTurnStats({ dipCm: null, dipFrac: null, heightM: null, heightSource: null }),
        "no-turn",
      ),
    ).toBeNull();
    // An unmeasured return leg cannot back the clean claim either.
    expect(turnCue(makeTurnStats({ reacquireSec: null }), "no-turn")).toBeNull();
  });

  it("sub-cue-line re-acquisition still reads clean (2.5 < 3)", () => {
    expect(
      turnCue(makeTurnStats({ durationSec: 1.4, reacquireSec: 2.5 }), "no-turn"),
    ).toBe("One motion in 1.4 s, level all the way round - a clean turn.");
  });

  it("between bands: no claim (clipped, nothing tripped, nothing clean-claimable)", () => {
    expect(
      turnCue(makeTurnStats({ durationSec: 1.4, entryClipped: true }), "no-turn"),
    ).toBeNull();
  });

  it("null-reason cues: only the coachable motion facts speak", () => {
    expect(turnCue(null, "turned-in-hold")).toBe(
      "You turned inside the hold beat - freeze for the count, then turn.",
    );
    expect(turnCue(null, "walk-ended-mid-turn")).toBe(
      "The walk ended mid-turn - finish the turn and bring it home.",
    );
    expect(turnCue(null, "no-turn")).toBe(
      "No 180 showed on the head path - turn at the mark and face the walk home.",
    );
    expect(turnCue(null, "one-way-route")).toBeNull();
    expect(turnCue(null, "never-marked")).toBeNull();
    expect(turnCue(null, "tracking-dark")).toBeNull();
    expect(turnCue(null, "never-settled")).toBeNull(); // holdCue owns the mark facts
  });
});

describe("panel strings are ASCII", () => {
  const ASCII = /^[\x20-\x7e]*$/;

  it("explainers", () => {
    expect(TURN_EXPLAIN).toMatch(ASCII);
    expect(PRESENTATION_EXPLAIN_WITH_TURN).toMatch(ASCII);
    // Templated from the constants — the disclosure can never drift.
    expect(TURN_EXPLAIN).toContain(`${HOLD_WINDOW_SEC.toFixed(1)} s hold window`);
    expect(TURN_EXPLAIN).toContain(`${TURN_REV_DEADBAND_DEG} deg`);
    expect(TURN_EXPLAIN).toContain(`${TURN_REACQ_BAR_M.toFixed(2)} m`);
  });

  it("every stat line and cue (panel default separator)", () => {
    const reasons: TurnNullReason[] = [
      "one-way-route",
      "never-marked",
      "never-settled",
      "turned-in-hold",
      "no-turn",
      "walk-ended-mid-turn",
      "tracking-dark",
    ];
    for (const reason of reasons) {
      expect(turnStatLine(null, reason)).toMatch(ASCII);
      const cue = turnCue(null, reason);
      if (cue !== null) expect(cue).toMatch(ASCII);
    }
    const shapes = [
      makeTurnStats(),
      makeTurnStats({ entryClipped: true }),
      makeTurnStats({ reversalCount: 2, dipCm: 9, dipFrac: 0.06 }),
      makeTurnStats({ reacquireSec: 6, reacquireCapped: true }),
      makeTurnStats({ dipCm: null, dipFrac: null, reacquireSec: null }),
    ];
    for (const t of shapes) {
      expect(turnStatLine(t, "no-turn")).toMatch(ASCII);
      const cue = turnCue(t, "no-turn");
      if (cue !== null) expect(cue).toMatch(ASCII);
    }
  });
});

// ---------------------------------------------------------------------------
// The M8 raw tap (the one allowed edit — additive, output-neutral).
// ---------------------------------------------------------------------------

describe("CarriageTracker.liveRawPitchDevDeg (the M11 tap)", () => {
  it("null at construction and after beginWalk", () => {
    const t = new CarriageTracker();
    expect(t.liveRawPitchDevDeg).toBeNull();
    const r = runCarriageTape([...calibrated(0)]);
    expect(r.tracker.liveRawPitchDevDeg).toBeNull();
  });

  it("carries the RAW per-frame deviation (not the EMA)", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: 10, reps: 8 },
      { op: "frame", pitchDeg: 2 },
    ]);
    // Raw = the LAST accepted frame's deviation; the EMA still drags high.
    expect(r.tracker.liveRawPitchDevDeg).toBeCloseTo(2, 6);
    expect(r.livePitchDevDeg).toBeGreaterThan(4);
  });

  it("nulls on a frozen frame (the dark-channel disclosure)", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: 5 },
      { op: "frame", pitchDeg: 5, frozen: true },
    ]);
    expect(r.tracker.liveRawPitchDevDeg).toBeNull();
  });

  it("nulls EXPLICITLY on a dark frame (never a stale raw value)", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: 5 },
      { op: "dark-frame" },
    ]);
    expect(r.tracker.liveRawPitchDevDeg).toBeNull();
    // The EMA tap keeps its existing hold contract — the two taps differ
    // by design (raw discloses per frame; the EMA re-seeds on resume).
    expect(r.livePitchDevDeg).not.toBeNull();
  });

  it("output-neutral: finalize is untouched by the tap (same tape, same stats)", () => {
    const tape = [...calibrated(0), { op: "frame" as const, pitchDeg: 3, reps: 40 }];
    const a = runCarriageTape(tape);
    const b = runCarriageTape(tape);
    expect(a.stats).toEqual(b.stats);
    expect(a.stats).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Long-run smoke (zero-alloc discipline: scalar state only, stable results).
// ---------------------------------------------------------------------------

describe("smoke", () => {
  it("a 20k-frame walk stays finite and finalizes identically twice", () => {
    const t = new TurnTracker();
    t.beginWalk(1.65, false, 0.95);
    const dt = 1 / 72;
    let wt = 0;
    for (let i = 0; i < 400; i++) {
      wt += dt;
      t.update(dt, wt, 0, Math.sin(i * 1e-4), 0, Math.cos(i * 1e-4), 0, 0.1, 1.6, 0);
    }
    t.noteMark(wt);
    t.noteHoldArmed(wt);
    for (let i = 0; i < 20000; i++) {
      wt += dt;
      // A slow wandering pivot with noise: dev ramps 0 -> ~200 deg.
      const dev = Math.min(200, i * 0.02) + Math.sin(i * 0.7) * 2;
      const theta = (-dev * Math.PI) / 180;
      t.update(
        dt,
        wt,
        0,
        Math.sin(theta / 2),
        0,
        Math.cos(theta / 2),
        0,
        0.3 * Math.exp(-i * 0.001),
        1.6 - 0.02 * Math.sin(i * 0.01),
        Math.sin(i * 0.1) * 3,
      );
    }
    const a = t.finalize(1.6);
    const b = t.finalize(1.6);
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
    expect(Number.isFinite(a!.durationSec)).toBe(true);
    expect(Number.isFinite(a!.sweepMonotoneFrac)).toBe(true);
    expect(a!.sweepMonotoneFrac).toBeGreaterThan(0);
    expect(a!.sweepMonotoneFrac).toBeLessThanOrEqual(1);
  });
});
