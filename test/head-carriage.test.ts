/**
 * M8 HEAD CARRIAGE — pins the pure tracker (src/head-carriage.ts), the
 * shared head-orient.ts extraction convention, the score/blend arithmetic
 * and the copy builders. Drives the REAL production module through the
 * shared op-tape builders in test/carriage-helpers.ts (the case-helpers
 * pattern — the future golden-family emitter replays the same builders).
 */
import { describe, expect, it } from "vitest";

import {
  buildCoachReport,
  METRIC_EXPLAIN,
  type CoachReport,
} from "../src/coach.ts";
import {
  applyCarriageNotes,
  blendPresence,
  carriageLine,
  carriagePresenceCue,
  carriageScoreOf,
  carriageTooltip,
  CARRIAGE_NO_READ_TOOLTIP,
  CARRIAGE_TOOLTIP,
  CarriageTracker,
  COMPOSITE_CAPTION_WITH_CARRIAGE,
  M8_ENGAGE_SEC,
  M8_GLANCE_PITCH_DEG,
  M8_GLANCE_REARM_DEG,
  M8_MIN_HORIZ,
  M8_NEUTRAL_SANE_DEG,
  M8_PITCH_BAND_DEG,
  M8_PITCH_FRAC_WEIGHT,
  M8_PRESENCE_WEIGHT,
  M8_STAND_SPEED_MAX_MPS,
  M8_TURN_EXCLUDE_SEC,
  M8_YAW_BAND_DEG,
  M8_YAW_CUE_MIN_OFF_PCT,
  M8_YAW_MIN_SEC,
  markTurnFlags,
  PRESENCE_EXPLAIN_WITH_CARRIAGE,
  stepPresenceBlend,
  type MarkTurnFlags,
  type PresenceBlendLatch,
} from "../src/head-carriage.ts";
import { headForward, makeHeadForward, pitchOf } from "../src/head-orient.ts";
import { coachContext, noteContext, snap } from "./case-helpers.ts";
import {
  calibrated,
  headQuat,
  makeCarriage,
  runCarriageTape,
  type CarriageOp,
} from "./carriage-helpers.ts";

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

// ---------------------------------------------------------------------------
// 1. Extraction (the shared head-orient.ts convention — adjudication §D).
// ---------------------------------------------------------------------------

describe("head-carriage extraction (head-orient convention)", () => {
  it("identity quaternion -> forward (0, 0, -1), pitch 0", () => {
    const f = headForward(0, 0, 0, 1, makeHeadForward());
    expect(f.x).toBeCloseTo(0, 12);
    expect(f.y).toBeCloseTo(0, 12);
    expect(f.z).toBeCloseTo(-1, 12);
    expect(f.horiz).toBeCloseTo(1, 12);
    expect(pitchOf(f.y)).toBeCloseTo(0, 12);
  });

  it("pitch-only quaternion -> exact pitch degrees (+ = chin up)", () => {
    const q = headQuat(30);
    const f = headForward(q[0], q[1], q[2], q[3], makeHeadForward());
    expect(pitchOf(f.y) * RAD2DEG).toBeCloseTo(30, 9);
    const qd = headQuat(-12.5);
    const fd = headForward(qd[0], qd[1], qd[2], qd[3], makeHeadForward());
    expect(pitchOf(fd.y) * RAD2DEG).toBeCloseTo(-12.5, 9);
  });

  it("yaw-only quaternion -> horizontal forward (-sin, 0, -cos), pitch 0", () => {
    const q = headQuat(0, 40);
    const f = headForward(q[0], q[1], q[2], q[3], makeHeadForward());
    expect(f.x).toBeCloseTo(-Math.sin(40 * DEG2RAD), 9);
    expect(f.y).toBeCloseTo(0, 9);
    expect(f.z).toBeCloseTo(-Math.cos(40 * DEG2RAD), 9);
    expect(pitchOf(f.y) * RAD2DEG).toBeCloseTo(0, 9);
  });

  it("combined pitch+yaw quaternion keeps the exact pitch", () => {
    const q = headQuat(-20, 55);
    const f = headForward(q[0], q[1], q[2], q[3], makeHeadForward());
    expect(pitchOf(f.y) * RAD2DEG).toBeCloseTo(-20, 9);
  });
});

// ---------------------------------------------------------------------------
// 2. Roll invariance (negative control — the module's own invariance twin).
// ---------------------------------------------------------------------------

describe("roll invariance", () => {
  it("25 deg roll about the forward axis leaves the forward ray identical", () => {
    const q = headQuat(-20, 15);
    const qr = headQuat(-20, 15, 25);
    const f = headForward(q[0], q[1], q[2], q[3], makeHeadForward());
    const fr = headForward(qr[0], qr[1], qr[2], qr[3], makeHeadForward());
    expect(fr.x).toBeCloseTo(f.x, 9);
    expect(fr.y).toBeCloseTo(f.y, 9);
    expect(fr.z).toBeCloseTo(f.z, 9);
  });

  it("rolled and unrolled tapes produce identical CarriageStats", () => {
    const tape = (roll: number): CarriageOp[] => [
      ...calibrated(0),
      { op: "frame", pitchDeg: -20, yawDeg: 15, rollDeg: roll, reps: 20 },
    ];
    const plain = runCarriageTape(tape(0));
    const rolled = runCarriageTape(tape(25));
    expect(rolled.stats).toEqual(plain.stats);
  });
});

// ---------------------------------------------------------------------------
// 3. Yaw error sign law (+ = the trainee's right — the lateral convention).
// ---------------------------------------------------------------------------

describe("yaw error sign", () => {
  it("head forward = RIGHT(psi) -> yaw error +90", () => {
    // Walk heading psi = 30; the runway-frame RIGHT of that heading is the
    // head world-yaw psi - 90 (helpers headQuat convention).
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", yawDeg: 30 - 90, walkYawDeg: 30 },
    ]);
    // First measured sample seeds the live tap with the raw error.
    expect(r.liveYawDevDeg).toBeCloseTo(90, 9);
  });

  it("head left of the line reads negative", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", yawDeg: 20, walkYawDeg: 0 },
    ]);
    expect(r.liveYawDevDeg).toBeCloseTo(-20, 9);
  });
});

// ---------------------------------------------------------------------------
// 4. Band accounting + rate independence.
// ---------------------------------------------------------------------------

describe("band accounting", () => {
  it("10 s tape with 6 s in the pitch band -> pitchInBandFrac 0.6", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: 3, reps: 48 }, // 6 s inside +-7
      { op: "frame", pitchDeg: 20, reps: 32 }, // 4 s outside
    ]);
    expect(r.stats?.pitchInBandFrac).toBe(0.6);
    expect(r.stats?.measuredSec).toBe(10);
  });

  it("yaw band splits on M8_YAW_BAND_DEG the same way", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", yawDeg: -5, reps: 24 }, // 3 s: |err 5| <= 12
      { op: "frame", yawDeg: -30, reps: 8 }, // 1 s: |err 30| out
    ]);
    expect(r.stats?.yawInBandFrac).toBe(0.75);
  });

  it("halving the frame rate does not move the fractions (time-weighted)", () => {
    const at = (dt: number, mul: number): CarriageOp[] => [
      ...calibrated(0),
      { op: "frame", pitchDeg: 3, yawDeg: 4, dt, reps: 48 * mul },
      { op: "frame", pitchDeg: 20, yawDeg: 30, dt, reps: 32 * mul },
    ];
    const coarse = runCarriageTape(at(1 / 32, 4)).stats;
    const fine = runCarriageTape(at(1 / 64, 8)).stats;
    expect(fine).toEqual(coarse);
  });
});

// ---------------------------------------------------------------------------
// 5. HEAD DROP hysteresis.
// ---------------------------------------------------------------------------

describe("head-drop hysteresis", () => {
  const settle: CarriageOp = { op: "frame", pitchDeg: 0, reps: 16 }; // engage

  it("one long dip below -15 counts once and stamps firstGlanceAtSec", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: 0, reps: 4 }, // 0.5 s level
      { op: "frame", pitchDeg: -25, reps: 12 }, // 1.5 s dip
      settle,
    ]);
    expect(r.stats?.glanceCount).toBe(1);
    // Trip lands on the first dip frame: walkTime 0.5 + 0.125 -> round1 0.6.
    expect(r.stats?.firstGlanceAtSec).toBe(0.6);
  });

  it("recovering only to -12 (below the -10 re-arm) does not re-count", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: -25, reps: 4 },
      { op: "frame", pitchDeg: -12, reps: 4 },
      { op: "frame", pitchDeg: -25, reps: 4 },
      settle,
    ]);
    expect(r.stats?.glanceCount).toBe(1);
  });

  // NOTE — deviation from the spec's §8.5 example (recover-to--8 -> 1): -8
  // is ABOVE the M8_GLANCE_REARM_DEG = -10 line, so per the constant's own
  // hysteresis law (§3.6: "re-arms only above -10") the counter re-arms and
  // the second dip is a second event. The constant + derivation are the
  // binding law; the example contradicted them.
  it("recovering above -10 re-arms: dip / -8 / dip counts 2", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: -25, reps: 4 },
      { op: "frame", pitchDeg: -8, reps: 4 },
      { op: "frame", pitchDeg: -25, reps: 4 },
      settle,
    ]);
    expect(r.stats?.glanceCount).toBe(2);
  });

  it("dip / recover to -5 / dip counts 2", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: -25, reps: 4 },
      { op: "frame", pitchDeg: -5, reps: 4 },
      { op: "frame", pitchDeg: -25, reps: 4 },
      settle,
    ]);
    expect(r.stats?.glanceCount).toBe(2);
  });

  it("a -14 dip (above the trip line) never counts", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: -14, reps: 8 },
      settle,
    ]);
    expect(r.stats?.glanceCount).toBe(0);
    expect(r.stats?.firstGlanceAtSec).toBeNull();
  });

  it("a counted drop still costs its pitch-band time (no double penalty)", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: -25, reps: 8 }, // 1 s out of band
      { op: "frame", pitchDeg: 0, reps: 24 }, // 3 s in band
    ]);
    expect(r.stats?.glanceCount).toBe(1);
    expect(r.stats?.pitchInBandFrac).toBe(0.75); // time scored once, via the band
  });
});

// ---------------------------------------------------------------------------
// 6. Neutral calibration chain: stand -> fit -> walk (adjudication §K).
// ---------------------------------------------------------------------------

describe("neutral calibration", () => {
  it("the countdown stand mean wins and the walk scores against it", () => {
    const r = runCarriageTape([
      ...calibrated(5),
      { op: "frame", pitchDeg: 5, reps: 24 },
    ]);
    expect(r.stats?.neutralSource).toBe("stand");
    expect(r.stats?.neutralPitchDeg).toBe(5);
    expect(r.stats?.pitchInBandFrac).toBe(1);
    expect(r.stats?.meanPitchDevDeg).toBe(0);
  });

  it("stand samples at walking speed are approach motion and never bias it", () => {
    const r = runCarriageTape([
      { op: "reset-neutral" },
      { op: "stand", pitchDeg: 5, speedMps: 0, reps: 8 },
      { op: "stand", pitchDeg: -20, speedMps: 1.0, reps: 8 }, // gated out
      { op: "begin-walk" },
      { op: "frame", pitchDeg: 5, reps: 24 },
    ]);
    expect(r.stats?.neutralSource).toBe("stand");
    expect(r.stats?.neutralPitchDeg).toBe(5);
  });

  it("an insane stand (|mean| > 12) falls back to the walk window", () => {
    const r = runCarriageTape([
      ...calibrated(-25), // reading a panel, not a neutral stand
      { op: "frame", pitchDeg: -25, reps: 24 },
    ]);
    expect(r.stats?.neutralSource).toBe("walk");
    // The baselineY mirror re-centers on the walk's own first 0.5 s.
    expect(r.stats?.neutralPitchDeg).toBe(-25);
    expect(r.stats?.pitchInBandFrac).toBe(1);
    expect(r.stats?.glanceCount).toBe(0);
  });

  it("an insane stand prefers a sane FIT neutral over the walk window", () => {
    const r = runCarriageTape([
      ...calibrated(-25, 3 * DEG2RAD),
      { op: "frame", pitchDeg: 3, reps: 24 },
    ]);
    expect(r.stats?.neutralSource).toBe("fit");
    expect(r.stats?.neutralPitchDeg).toBe(3);
    expect(r.stats?.pitchInBandFrac).toBe(1);
  });

  it("an insane FIT neutral is discarded by the same sane gate", () => {
    const r = runCarriageTape([
      ...calibrated(-25, 20 * DEG2RAD),
      { op: "frame", pitchDeg: 0, reps: 24 },
    ]);
    expect(r.stats?.neutralSource).toBe("walk");
  });

  it("a sane stand outranks a FIT neutral (the chain order)", () => {
    const r = runCarriageTape([
      ...calibrated(5, 3 * DEG2RAD),
      { op: "frame", pitchDeg: 5, reps: 24 },
    ]);
    expect(r.stats?.neutralSource).toBe("stand");
    expect(r.stats?.neutralPitchDeg).toBe(5);
  });

  it("no stand and no FIT -> the walk window, running-mean seeded", () => {
    const r = runCarriageTape([
      { op: "begin-walk" },
      { op: "frame", pitchDeg: 4, reps: 24 },
    ]);
    expect(r.stats?.neutralSource).toBe("walk");
    expect(r.stats?.neutralPitchDeg).toBe(4);
    expect(r.stats?.pitchInBandFrac).toBe(1);
  });

  it("a source dark through the window seeds from its first live sample", () => {
    const r = runCarriageTape([
      { op: "begin-walk" },
      { op: "frame", pitchDeg: 6, dt: 1 }, // first frame lands past 0.5 s
      { op: "frame", pitchDeg: 6, dt: 0.5, reps: 2 },
    ]);
    expect(r.stats?.neutralSource).toBe("walk");
    expect(r.stats?.neutralPitchDeg).toBe(6);
    expect(r.stats?.pitchInBandFrac).toBe(1);
  });

  it("the stand survives a re-run without a fresh countdown", () => {
    const first = runCarriageTape([
      ...calibrated(5),
      { op: "frame", pitchDeg: 5, reps: 24 },
    ]);
    const again = runCarriageTape(
      [{ op: "begin-walk" }, { op: "frame", pitchDeg: 5, reps: 24 }],
      first.tracker,
    );
    expect(again.stats?.neutralSource).toBe("stand");
    expect(again.stats?.neutralPitchDeg).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 7. Turn window (yaw-dark) + 8. the return flip / one-way rule.
// ---------------------------------------------------------------------------

describe("turn window and the return flip", () => {
  it("suppressed yaw frames change nothing (negative control)", () => {
    const base: CarriageOp[] = [
      ...calibrated(0),
      { op: "frame", yawDeg: 0, reps: 32 }, // 4 s measured in band
    ];
    const calm = runCarriageTape([
      ...base,
      { op: "frame", yawDeg: 0, suppressed: true, reps: 24 },
    ]);
    const wild = runCarriageTape([
      ...base,
      { op: "frame", yawDeg: 90, suppressed: true, reps: 24 },
    ]);
    expect(wild.stats).toEqual(calm.stats);
    expect(wild.stats?.yawInBandFrac).toBe(1);
    expect(wild.liveYawDevDeg).toBeNull(); // the tap goes honest-dark too
  });

  it("pitch keeps measuring through the suppression window", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: 0, reps: 16 },
      { op: "frame", pitchDeg: 20, suppressed: true, reps: 16 },
    ]);
    expect(r.stats?.pitchInBandFrac).toBe(0.5);
    expect(r.stats?.measuredSec).toBe(4);
  });

  it("after the mark on out-and-back, facing the RETURN direction is in band", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", yawDeg: 180, walkYawDeg: 0, returning: true, reps: 20 },
    ]);
    expect(r.stats?.yawInBandFrac).toBe(1);
  });

  it("without the flip the same facing is 180 out (negative control)", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", yawDeg: 180, walkYawDeg: 0, returning: false, reps: 20 },
    ]);
    expect(r.stats?.yawInBandFrac).toBe(0);
  });

  it("one-way U: yaw suppressed from the mark to the end, no flip applied", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", yawDeg: 0, reps: 8 }, // 1 s measured pre-mark
      { op: "frame", yawDeg: 170, suppressed: true, reps: 24 }, // pose scan
    ]);
    expect(r.stats?.yawInBandFrac).toBe(1); // only the pre-mark second counts
  });

  it("yawInBandFrac is null when yaw measured under M8_YAW_MIN_SEC", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", yawDeg: 0, reps: 4 }, // 0.5 s measured
      { op: "frame", yawDeg: 0, suppressed: true, reps: 24 },
    ]);
    expect(r.stats?.yawInBandFrac).toBeNull();
  });

  it("a near-vertical forward ray is yaw-dark (M8_MIN_HORIZ gate)", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", yawDeg: 0, reps: 8 }, // 1 s measured
      { op: "frame", pitchDeg: 80, reps: 8 }, // horiz = cos 80 ~ 0.17 < 0.35
    ]);
    expect(r.liveYawDevDeg).toBeNull();
    expect(r.stats?.yawInBandFrac).toBe(1); // gated frames credited nothing
  });
});

// ---------------------------------------------------------------------------
// 9. Mid-walk remap (resetYawChannel).
// ---------------------------------------------------------------------------

describe("mid-walk remap", () => {
  it("restarts the yaw fractions only; pitch, drops and neutral survive", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", yawDeg: 30, reps: 16 }, // 2 s off the OLD heading
      { op: "frame", pitchDeg: -25, reps: 4 }, // one head drop pre-remap
      { op: "reset-yaw" },
      { op: "frame", yawDeg: 0, reps: 16 }, // 2 s on the NEW heading
    ]);
    expect(r.stats?.yawInBandFrac).toBe(1); // old-heading samples cleared
    expect(r.stats?.glanceCount).toBe(1); // geometry-independent, survives
    expect(r.stats?.neutralSource).toBe("stand");
    expect(r.stats?.measuredSec).toBe(4.5); // pitch time never cleared
  });

  it("clears the live yaw tap; the next sample re-seeds it", () => {
    const t = runCarriageTape([
      ...calibrated(0),
      { op: "frame", yawDeg: 30, reps: 16 },
      { op: "reset-yaw" },
    ]);
    expect(t.liveYawDevDeg).toBeNull();
    const after = runCarriageTape(
      [{ op: "frame", yawDeg: -4, reps: 1 }],
      t.tracker,
    );
    expect(after.liveYawDevDeg).toBeCloseTo(4, 9); // seeded raw, not folded
  });
});

// ---------------------------------------------------------------------------
// 10. Finiteness (dark frames).
// ---------------------------------------------------------------------------

describe("finiteness gates", () => {
  it("NaN quaternion frames and bad dt frames carry zero weight", () => {
    const clean = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: 3, reps: 16 },
    ]);
    const dirty = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: 3, reps: 8 },
      { op: "dark-frame", reps: 4 },
      { op: "bad-dt-frame", dt: 0 },
      { op: "bad-dt-frame", dt: -0.1 },
      { op: "bad-dt-frame", dt: NaN },
      { op: "frame", pitchDeg: 3, reps: 8 },
    ]);
    expect(dirty.stats).toEqual(clean.stats);
  });

  it("live taps hold their last value through a dark frame (no NaN in an EMA)", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: 5, yawDeg: 4 },
      { op: "dark-frame", reps: 3 },
    ]);
    expect(r.livePitchDevDeg).toBeCloseTo(5, 9);
    expect(r.liveYawDevDeg).toBeCloseTo(-4, 9);
    expect(Number.isFinite(r.livePitchDevDeg ?? NaN)).toBe(true);
  });

  it("non-finite stand samples never bias the neutral", () => {
    const r = runCarriageTape([
      { op: "reset-neutral" },
      { op: "stand", pitchDeg: 5, reps: 8 },
      { op: "quat-frame", q: [NaN, 0, 0, 1] }, // ignored: not a stand op
      { op: "begin-walk" },
    ]);
    const t = new CarriageTracker();
    t.resetNeutral();
    t.addNeutralSample(NaN, 0, 0, 1, 0, 0.125);
    t.addNeutralSample(0, 0, 0, 1, NaN, 0.125);
    t.addNeutralSample(0, 0, 0, 1, 0, NaN);
    t.beginWalk();
    // No sane stand accumulated -> the chain fell through to "walk".
    t.update(...headQuat(0), 0, false, false, 0.5, 0.5);
    expect(r.stats).toBeNull(); // (walk never ran long enough there)
    expect(t.finalize()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10b. Frozen-pose guard (the HoldAccumulator law mirrored onto M8).
// ---------------------------------------------------------------------------

describe("frozen-pose guard", () => {
  it("a frozen tape adds ~zero measured time (never claims frozen carriage)", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: 0, reps: 16 }, // 2 s live -> engaged
      // 20 s of bit-identical tracking (VisibleBlurred / static preview):
      // the FIRST frozen frame is a new tuple (0.125 s), every repeat is
      // zero weight — the record must not claim 20 s of chin-level time.
      { op: "frame", pitchDeg: 3, frozen: true, reps: 160 },
    ]);
    expect(r.walkTime).toBeCloseTo(22, 9); // real time passed...
    expect(r.stats?.measuredSec).toBe(2.1); // ...but only 2.125 s measured
    expect(r.stats?.pitchInBandFrac).toBe(1);
  });

  it("a real dithered stream is never bit-identical (negative control)", () => {
    // The same 22 s shape WITHOUT the frozen flag: the runner's
    // double-cover dither models a live sensor (q/-q alternation — the
    // same rotation, distinct tuples), so every frame measures.
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: 0, reps: 16 },
      { op: "frame", pitchDeg: 3, reps: 160 },
    ]);
    expect(r.stats?.measuredSec).toBe(22);
  });

  it("frozen frames NULL the live taps (dark-channel disclosure)", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: 5, yawDeg: 4 },
      { op: "frame", pitchDeg: 5, yawDeg: 4, frozen: true, reps: 8 },
    ]);
    // The first frozen frame may measure (new tuple); the repeats disclose.
    expect(r.livePitchDevDeg).toBeNull();
    expect(r.liveYawDevDeg).toBeNull();
  });

  it("the taps re-seed raw when the stream resumes after a freeze", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: 5 },
      { op: "frame", pitchDeg: 5, frozen: true, reps: 8 },
      { op: "frame", pitchDeg: 3 },
    ]);
    expect(r.livePitchDevDeg).toBeCloseTo(3, 9); // seeded raw, not folded
  });

  it("beginWalk re-arms the guard (a stale reference never leaks)", () => {
    const first = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: 2, frozen: true, reps: 8 },
    ]);
    // Re-run: the SAME tuple as the frozen stretch must be accepted again.
    const again = runCarriageTape(
      [{ op: "begin-walk" }, { op: "frame", pitchDeg: 2, frozen: true, reps: 1 }],
      first.tracker,
    );
    expect(again.livePitchDevDeg).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10c. markTurnFlags — the M8 yaw-flag LAW the engine wiring runs
// (metrics.ts cannot load under vitest; the stepPresenceBlend precedent).
// ---------------------------------------------------------------------------

describe("markTurnFlags", () => {
  const out = (): MarkTurnFlags => ({ returning: false, yawSuppressed: false });

  it("unmarked walk: no flip, no suppression (either route)", () => {
    expect(markTurnFlags(-1, 10, false, out())).toEqual({
      returning: false,
      yawSuppressed: false,
    });
    expect(markTurnFlags(-1, 10, true, out())).toEqual({
      returning: false,
      yawSuppressed: false,
    });
  });

  it("out-and-back: flips from the mark and darkens the turn window", () => {
    expect(markTurnFlags(10, 10, false, out())).toEqual({
      returning: true,
      yawSuppressed: true,
    });
    expect(markTurnFlags(10, 12, false, out())).toEqual({
      returning: true,
      yawSuppressed: true,
    });
  });

  it("the window edge is STRICT: at exactly M8_TURN_EXCLUDE_SEC yaw measures again", () => {
    const edge = markTurnFlags(10, 10 + M8_TURN_EXCLUDE_SEC, false, out());
    expect(edge.yawSuppressed).toBe(false);
    expect(edge.returning).toBe(true); // the flip is permanent post-mark
    const inside = markTurnFlags(10, 10 + M8_TURN_EXCLUDE_SEC - 1e-9, false, out());
    expect(inside.yawSuppressed).toBe(true);
  });

  it("one-way (U): never flips, dark from the mark to the walk's end", () => {
    expect(markTurnFlags(10, 10 + M8_TURN_EXCLUDE_SEC + 100, true, out())).toEqual({
      returning: false,
      yawSuppressed: true,
    });
  });

  it("post-remap re-arm: markAtWalkTime resets to -1 and the flags drop", () => {
    // show.ts applyPath clears reachedMark/poseBurst on a mid-walk remap and
    // the wiring resets its private mark latch to -1 with it — the flags
    // must read as unmarked until the mark is genuinely re-reached.
    const o = out();
    markTurnFlags(10, 12, false, o); // marked...
    expect(o.yawSuppressed).toBe(true);
    markTurnFlags(-1, 12.5, false, o); // ...remap re-armed
    expect(o).toEqual({ returning: false, yawSuppressed: false });
    markTurnFlags(20, 21, false, o); // re-marked on the new route
    expect(o).toEqual({ returning: true, yawSuppressed: true });
  });

  it("writes into the caller's out-object and returns it (zero-alloc law)", () => {
    const o = out();
    expect(markTurnFlags(5, 6, false, o)).toBe(o);
  });
});

// ---------------------------------------------------------------------------
// 11. Engage + finalize contract.
// ---------------------------------------------------------------------------

describe("engage and finalize", () => {
  it("under 2 s measured -> not engaged, finalize null", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: 0, reps: 15 }, // 1.875 s
    ]);
    expect(r.engaged).toBe(false);
    expect(r.stats).toBeNull();
  });

  it("exactly 2 s measured -> engaged, finalize non-null (one criterion)", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: 0, reps: 16 }, // 2.0 s exactly
    ]);
    expect(r.engaged).toBe(true);
    expect(r.stats).not.toBeNull();
    expect(r.stats?.measuredSec).toBe(2);
  });

  it("finalize is non-destructive and repeatable", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: 3, yawDeg: 4, reps: 24 },
    ]);
    expect(r.tracker.finalize()).toEqual(r.stats);
    expect(r.tracker.finalize()).toEqual(r.stats);
  });

  it("beginWalk clears engagement, drops and the live taps", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: -25, reps: 24 },
      { op: "begin-walk" },
    ]);
    expect(r.engaged).toBe(false);
    expect(r.stats).toBeNull();
    expect(r.livePitchDevDeg).toBeNull();
    expect(r.liveYawDevDeg).toBeNull();
  });

  it("live taps are null before any walk frame", () => {
    const t = new CarriageTracker();
    expect(t.livePitchDevDeg).toBeNull();
    expect(t.liveYawDevDeg).toBeNull();
    expect(t.liveScore()).toBe(40); // SCORE_MIN floor before any pitch time
  });
});

// ---------------------------------------------------------------------------
// 12. Score mapping + 13. the M5 presence blend.
// ---------------------------------------------------------------------------

describe("score mapping", () => {
  it("anchors: fc 1 -> 100 (the cap), fc 0 -> 40 (the floor)", () => {
    expect(carriageScoreOf(1, 1)).toBeCloseTo(100, 12);
    expect(carriageScoreOf(0, 0)).toBeCloseTo(40, 12);
  });

  it("crosses the lowest pass bar 75 at fc = 35/60 (the 40+60 map)", () => {
    expect(carriageScoreOf(35 / 60, null)).toBeCloseTo(75, 12);
  });

  it("yaw-null walks map fc = pitchFrac (disclosed single-channel form)", () => {
    expect(carriageScoreOf(0.5, null)).toBeCloseTo(70, 12); // 40 + 60 * 0.5
    expect(carriageScoreOf(1, 0)).toBeCloseTo(76, 12); // 40 + 60 * 0.6
  });

  it("the tracker's liveScore and finalize agree on the mapping", () => {
    const r = runCarriageTape([
      ...calibrated(0),
      { op: "frame", pitchDeg: 3, yawDeg: 4, reps: 24 },
    ]);
    expect(r.tracker.liveScore()).toBeCloseTo(100, 9);
    expect(r.stats?.carriageScore).toBe(100);
  });
});

describe("blendPresence", () => {
  it("is the pure 0.75/0.25 one-shot (idempotence is wiring-side)", () => {
    expect(blendPresence(80, 40)).toBeCloseTo(70, 12);
    expect(blendPresence(60, 98)).toBeCloseTo(69.5, 12);
    expect(M8_PRESENCE_WEIGHT).toBe(0.25);
  });

  it("keeps clamped inputs inside [40, 98] (convex combination)", () => {
    for (const legacy of [40, 62, 98]) {
      for (const carriage of [40, 75, 98]) {
        const v = blendPresence(legacy, carriage);
        expect(v).toBeGreaterThanOrEqual(40);
        expect(v).toBeLessThanOrEqual(98);
      }
    }
    expect(blendPresence(90, 90)).toBeCloseTo(90, 12); // agreement moves nothing
  });
});

// ---------------------------------------------------------------------------
// 14. Copy builders (ASCII; HEAD DROPS naming per adjudication §K).
// ---------------------------------------------------------------------------

describe("carriageLine", () => {
  it("full line with the XR separator", () => {
    const c = makeCarriage({
      pitchInBandFrac: 0.84,
      yawInBandFrac: 0.91,
      glanceCount: 2,
    });
    expect(carriageLine(c)).toBe(
      "HEAD CARRIAGE - CHIN LEVEL 84% - FACING ON LINE 91% - 2 HEAD DROPS",
    );
  });

  it("landing separator variant", () => {
    const c = makeCarriage({ pitchInBandFrac: 0.84, yawInBandFrac: 0.91 });
    expect(carriageLine(c, " · ")).toBe(
      "HEAD CARRIAGE · CHIN LEVEL 84% · FACING ON LINE 91% · NO HEAD DROPS",
    );
  });

  it("omits FACING ON LINE when the yaw channel never measured", () => {
    const c = makeCarriage({ pitchInBandFrac: 0.5, yawInBandFrac: null });
    expect(carriageLine(c)).toBe(
      "HEAD CARRIAGE - CHIN LEVEL 50% - NO HEAD DROPS",
    );
  });

  it("singular head drop", () => {
    expect(carriageLine(makeCarriage({ glanceCount: 1 }))).toBe(
      "HEAD CARRIAGE - CHIN LEVEL 100% - FACING ON LINE 100% - 1 HEAD DROP",
    );
  });

  it("null carriage -> null (surfaces hide the row)", () => {
    expect(carriageLine(null)).toBeNull();
  });

  it("default-sep output and the tooltip are ASCII-only (XR panel law)", () => {
    const ascii = /^[\x20-\x7e]+$/;
    expect(carriageLine(makeCarriage({ glanceCount: 3 }))).toMatch(ascii);
    expect(CARRIAGE_TOOLTIP).toMatch(ascii);
    expect(CARRIAGE_TOOLTIP).toContain("not gaze");
  });
});

describe("carriageTooltip (source-aware neutral provenance)", () => {
  const SOURCES = ["stand", "fit", "walk"] as const;

  it("every variant is ASCII-only and keeps the shared disclosures", () => {
    const ascii = /^[\x20-\x7e]+$/;
    for (const s of SOURCES) {
      const tip = carriageTooltip(s);
      expect(tip).toMatch(ascii);
      expect(tip).toContain("not gaze");
      expect(tip).toContain("Head drops");
    }
  });

  it("the three variants are pairwise distinct and name their source", () => {
    const tips = SOURCES.map((s) => carriageTooltip(s));
    expect(new Set(tips).size).toBe(3);
    expect(tips[0]).toContain("set during the countdown stand");
    expect(tips[1]).toContain("from your FIT baseline");
    expect(tips[2]).toContain("from the first half second of the walk");
  });

  it("CARRIAGE_TOOLTIP stays the stand variant (compatibility alias)", () => {
    expect(CARRIAGE_TOOLTIP).toBe(carriageTooltip("stand"));
  });

  it("CARRIAGE_NO_READ_TOOLTIP: ASCII, keeps the not-gaze disclosure, and never claims a calibrated neutral", () => {
    expect(CARRIAGE_NO_READ_TOOLTIP).toMatch(/^[\x20-\x7e]+$/);
    expect(CARRIAGE_NO_READ_TOOLTIP).toContain("not gaze");
    expect(CARRIAGE_NO_READ_TOOLTIP).toContain("No read");
    // Stamp honesty: a null walk calibrated nothing — the no-read text may
    // not carry any of the three source-aware neutral phrases.
    for (const s of SOURCES) {
      const phrase = carriageTooltip(s).match(/\(([^)]+)\)/)?.[1];
      expect(phrase).toBeTruthy();
      expect(CARRIAGE_NO_READ_TOOLTIP).not.toContain(phrase as string);
    }
  });
});

describe("COMPOSITE_CAPTION_WITH_CARRIAGE (run-history detail caption)", () => {
  it("is ASCII-only and discloses the exact blended form", () => {
    expect(COMPOSITE_CAPTION_WITH_CARRIAGE).toMatch(/^[\x20-\x7e]+$/);
    expect(COMPOSITE_CAPTION_WITH_CARRIAGE).toContain("75%");
    expect(COMPOSITE_CAPTION_WITH_CARRIAGE).toContain("25%");
    expect(COMPOSITE_CAPTION_WITH_CARRIAGE).toContain("measured head carriage");
  });

  it("is distinct from the presence explainer (different surfaces)", () => {
    expect(COMPOSITE_CAPTION_WITH_CARRIAGE).not.toBe(
      PRESENCE_EXPLAIN_WITH_CARRIAGE,
    );
  });
});

describe("carriagePresenceCue", () => {
  it("head drops win first: singular and plural forms", () => {
    expect(carriagePresenceCue(makeCarriage({ glanceCount: 1 }))).toBe(
      "You dropped your head to the deck once - chin level, hold the far wall.",
    );
    expect(
      carriagePresenceCue(
        makeCarriage({ glanceCount: 3, meanPitchDevDeg: -6 }),
      ),
    ).toBe(
      "You dropped your head to the deck 3 times - chin level, hold the far wall.",
    );
  });

  it("pitch cue cites the measured mean and its direction", () => {
    const below = makeCarriage({
      pitchInBandFrac: 0.5,
      meanPitchDevDeg: -4.2,
      yawInBandFrac: 0.9,
    });
    expect(carriagePresenceCue(below)).toBe(
      "Your chin averaged 4 deg below neutral - level it and hold the far wall.",
    );
    const above = makeCarriage({
      pitchInBandFrac: 0.5,
      meanPitchDevDeg: 2.4,
      yawInBandFrac: 0.9,
    });
    expect(carriagePresenceCue(above)).toBe(
      "Your chin averaged 2 deg above neutral - level it and hold the far wall.",
    );
  });

  it("yaw cue fires at >= 25% off-line when pitch does not qualify", () => {
    const c = makeCarriage({
      pitchInBandFrac: 1,
      meanPitchDevDeg: 0.4,
      yawInBandFrac: 0.6,
    });
    expect(carriagePresenceCue(c)).toBe(
      "Your head faced off the walk line 40 percent of the walk - pick the far point and hold it.",
    );
  });

  it("both qualify: the larger weighted deficit wins", () => {
    // yaw deficit 0.4 * 0.5 = 0.2 > pitch deficit 0.6 * 0.1 = 0.06.
    const yawWins = makeCarriage({
      pitchInBandFrac: 0.9,
      meanPitchDevDeg: -2,
      yawInBandFrac: 0.5,
    });
    expect(carriagePresenceCue(yawWins)).toContain("faced off the walk line");
    // pitch deficit 0.6 * 0.7 = 0.42 > yaw deficit 0.4 * 0.3 = 0.12.
    const pitchWins = makeCarriage({
      pitchInBandFrac: 0.3,
      meanPitchDevDeg: -5,
      yawInBandFrac: 0.7,
    });
    expect(carriagePresenceCue(pitchWins)).toContain("Your chin averaged");
  });

  it("qualify guards: sub-1-deg pitch and sub-25% yaw fall through to null", () => {
    const c = makeCarriage({
      pitchInBandFrac: 0.9,
      meanPitchDevDeg: 0.3,
      yawInBandFrac: 0.9, // 10% off-line < 25
    });
    expect(carriagePresenceCue(c)).toBeNull();
    const yawNull = makeCarriage({
      pitchInBandFrac: 0.95,
      meanPitchDevDeg: -0.4,
      yawInBandFrac: null,
    });
    expect(carriagePresenceCue(yawNull)).toBeNull();
  });
});

describe("applyCarriageNotes", () => {
  const presenceReport = (): CoachReport =>
    buildCoachReport(noteContext("presence", null));

  it("upgrades the presence note to a directional carriage cue", () => {
    const report = presenceReport();
    const applied = applyCarriageNotes(report, makeCarriage({ glanceCount: 1 }));
    expect(applied).not.toBe(report);
    expect(applied.notes).toHaveLength(1);
    expect(applied.notes[0]).toEqual({
      key: "presence",
      cue: "You dropped your head to the deck once - chin level, hold the far wall.",
      directional: true,
    });
    // Verdict fields carried through untouched.
    expect(applied.overall).toBe(report.overall);
    expect(applied.verdict).toBe(report.verdict);
  });

  it("identity when carriage is null (returns the SAME report object)", () => {
    const report = presenceReport();
    expect(applyCarriageNotes(report, null)).toBe(report);
  });

  it("identity when the report carries no presence note", () => {
    const clean = buildCoachReport(coachContext()); // every metric clears
    expect(clean.notes).toHaveLength(0);
    expect(applyCarriageNotes(clean, makeCarriage({ glanceCount: 2 }))).toBe(
      clean,
    );
  });

  it("identity when no directional cue qualifies", () => {
    const report = presenceReport();
    const quiet = makeCarriage({ meanPitchDevDeg: 0.2, yawInBandFrac: 0.95 });
    expect(applyCarriageNotes(report, quiet)).toBe(report);
  });

  it("touches no other note object (identity preserved element-wise)", () => {
    const report = buildCoachReport(
      coachContext({
        scores: snap(95, { presence: 50, posture: 50 }),
        overall: 85,
      }),
    );
    const postureNote = report.notes.find((n) => n.key === "posture");
    expect(postureNote).toBeDefined();
    const applied = applyCarriageNotes(report, makeCarriage({ glanceCount: 1 }));
    expect(applied.notes.find((n) => n.key === "posture")).toBe(postureNote);
    expect(applied.notes.length).toBe(report.notes.length);
  });
});

// ---------------------------------------------------------------------------
// §B wiring pin: the presence-blend frame step (the exact law metrics.ts
// runs — extracted pure because the engine wiring cannot load under vitest).
// ---------------------------------------------------------------------------

describe("stepPresenceBlend (adjudication §B: idempotent, never read-modify-write)", () => {
  const latch = (legacy = 62): PresenceBlendLatch => ({ legacy });

  it("latches the legacy composite on derived frames and blends from it", () => {
    const l = latch(0);
    const out = stepPresenceBlend(l, true, 80, true, 90);
    expect(l.legacy).toBe(80);
    expect(out).toBe(blendPresence(80, 90));
  });

  it("PIN: repeated cached frames leave target[4] bit-identical", () => {
    // Two consecutive update() frames with the same cached PoseFrame (no
    // derive ran -> derived = false; target[4] holds LAST frame's blended
    // value) and a frozen carriage tracker: the output must not move.
    const l = latch();
    const first = stepPresenceBlend(l, true, 80, true, 90); // the derive frame
    const second = stepPresenceBlend(l, false, first, true, 90);
    const third = stepPresenceBlend(l, false, second, true, 90);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(l.legacy).toBe(80); // the latch never absorbed a blended value
  });

  it("NEGATIVE CONTROL: read-modify-write WOULD compound (why the latch exists)", () => {
    // The forbidden shape — feeding the blend's own output back in as the
    // "legacy" input — drifts toward the carriage score frame over frame.
    let rmw = 80;
    rmw = blendPresence(rmw, 90);
    const once = rmw;
    rmw = blendPresence(rmw, 90);
    expect(rmw).not.toBe(once);
    expect(Math.abs(90 - rmw)).toBeLessThan(Math.abs(90 - once)); // compounds
  });

  it("head re-seed frame (derived false, engaged): blend holds from the stale-but-valid latch", () => {
    const l = latch(70);
    const out = stepPresenceBlend(l, false, 55.5, true, 90);
    expect(out).toBe(blendPresence(70, 90));
    expect(l.legacy).toBe(70);
  });

  it("§B PIN: a fresh-but-HIPLESS camera stream never compounds the blend", () => {
    // The wiring's derive paths RETURN the wrote-targets fact, and a fresh
    // PoseFrame whose both hips fail the kpOk gate returns FALSE (metrics.ts
    // deriveFromPose / pose-derive.ts deriveWorldImpl) — so update() feeds
    // derived=false here even though the frame was fresh. target[4] on such
    // frames holds LAST frame's blended value; the latch must ignore it, or
    // 1 s of hip occlusion at 30 Hz drives presence to ~pure carriageScore
    // (weight 1 - 0.75^(k+1)).
    const l = latch(0);
    const first = stepPresenceBlend(l, true, 80, true, 90); // one good derive
    let out = first;
    for (let k = 0; k < 30; k++) {
      // fresh-but-hipless frames: derived=false, target[4] = the previous
      // blended output (the exact update() shape)
      out = stepPresenceBlend(l, false, out, true, 90);
      expect(out).toBe(first); // bit-identical every frame — no compounding
    }
    expect(l.legacy).toBe(80); // the latch never absorbed a blended value
  });

  it("not engaged: target[4] passes through untouched, the latch still tracks derives", () => {
    const l = latch(0);
    expect(stepPresenceBlend(l, true, 77, false, 40)).toBe(77);
    expect(l.legacy).toBe(77);
    expect(stepPresenceBlend(l, false, 77, false, 40)).toBe(77);
  });
});

// ---------------------------------------------------------------------------
// The carriage-aware presence explainer (adjudication §I: additive, coach.ts
// untouched — surfaces branch AT RENDER on summary.carriage != null).
// ---------------------------------------------------------------------------

describe("PRESENCE_EXPLAIN_WITH_CARRIAGE", () => {
  it("pins the exact string (discloses the 75/25 blended form, composite, not gaze)", () => {
    expect(PRESENCE_EXPLAIN_WITH_CARRIAGE).toBe(
      "Composite read: your posture, rhythm and pace weighted together (posture counting most) at 75%, plus your measured head carriage at 25% - chin held level, head facing down the walk line. Still a composite - carriage is head orientation, not gaze; eyes are not tracked.",
    );
  });

  it("differs from the untouched legacy METRIC_EXPLAIN.presence", () => {
    expect(PRESENCE_EXPLAIN_WITH_CARRIAGE).not.toBe(METRIC_EXPLAIN.presence);
    // The legacy table text itself is pinned elsewhere (coach golden family);
    // assert the load-bearing part: coach.ts still ships the legacy wording.
    expect(METRIC_EXPLAIN.presence).toContain("not separately measured");
  });

  it("is printable ASCII (XR panel law) and its shares match M8_PRESENCE_WEIGHT", () => {
    expect(PRESENCE_EXPLAIN_WITH_CARRIAGE).toMatch(/^[\x20-\x7E]*$/);
    expect(PRESENCE_EXPLAIN_WITH_CARRIAGE).toContain(
      `${Math.round((1 - M8_PRESENCE_WEIGHT) * 100)}%`,
    );
    expect(PRESENCE_EXPLAIN_WITH_CARRIAGE).toContain(
      `${Math.round(M8_PRESENCE_WEIGHT * 100)}%`,
    );
  });
});

// ---------------------------------------------------------------------------
// Constants sanity (the derivations' pinned relationships).
// ---------------------------------------------------------------------------

describe("constant relationships", () => {
  it("band edge and drop threshold cannot merge through gait oscillation", () => {
    expect(M8_PITCH_BAND_DEG).toBeLessThan(Math.abs(M8_GLANCE_PITCH_DEG) / 2);
  });

  it("re-arm sits between the trip line and the band edge", () => {
    expect(M8_GLANCE_REARM_DEG).toBeGreaterThan(M8_GLANCE_PITCH_DEG);
    expect(M8_GLANCE_REARM_DEG).toBeLessThan(-M8_PITCH_BAND_DEG);
  });

  it("stand speed gate sits between sway and the slowest walk pace", () => {
    expect(M8_STAND_SPEED_MAX_MPS).toBeGreaterThan(0.1);
    expect(M8_STAND_SPEED_MAX_MPS).toBeLessThan(0.72 / 2);
  });

  it("pinned wiring constants (turn window, engage, yaw floor, gates)", () => {
    expect(M8_TURN_EXCLUDE_SEC).toBe(4); // = TURN_SUPPRESS_SEC (coach-live)
    expect(M8_ENGAGE_SEC).toBe(2); // = RAMP_IN_SEC (metrics-wiring)
    expect(M8_YAW_MIN_SEC).toBe(1);
    expect(M8_MIN_HORIZ).toBe(0.35);
    expect(M8_NEUTRAL_SANE_DEG).toBe(12);
    expect(M8_YAW_BAND_DEG).toBe(12);
    expect(M8_PITCH_FRAC_WEIGHT).toBe(0.6);
    expect(M8_YAW_CUE_MIN_OFF_PCT).toBe(25);
  });
});
