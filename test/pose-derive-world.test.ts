/**
 * Characterization suite for the extracted WORLD-pose derivation
 * (src/pose-derive.ts — SOLO-MODE.md §6.2 / Phase A1a).
 *
 * Two layers of protection:
 *
 * 1) GOLDEN TAPE REPLAY — the deterministic synthetic tapes
 *    (test/pose-tapes.ts) replay against the real module and must reproduce
 *    test/pose-derive-world.golden.json BYTE-identically. That fixture was
 *    recorded from this module immediately after the extraction and diffed
 *    byte-identical against the PRE-refactor MetricsSystem.deriveFromPoseWorld
 *    (the real method sliced out of a git worktree at cc22b19 and executed
 *    verbatim — see test/pose-derive-tape.mjs). These are the current outputs,
 *    pinned exactly — including warm-up frames, ring rollover, and gap resets.
 *    ONE deliberate divergence from that pre-refactor recording: the kpOk
 *    finiteness gate (a non-finite-coordinate keypoint is absent, so junk
 *    frames degrade gracefully instead of NaN-poisoning the EMAs) changed the
 *    nan-junk tape's expectations, and the golden was regenerated via the
 *    documented mechanism (node test/pose-derive-tape.mjs --post). Every
 *    other tape's record stayed byte-identical across that regeneration.
 *
 * 2) HAND-VERIFIED SPOT CHECKS — selected quantities recomputed independently
 *    in this file from the raw keypoints (same formulas, read from the source
 *    and re-derived), so the goldens are anchored to the math, not just to
 *    "whatever the module said".
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  PACE_BAND_MPS,
  PACE_K_FAST,
  PACE_K_SLOW,
  PoseDeriveState,
  RING_SIZE,
  SCORE_MAX,
  SCORE_MIN,
  SCORE_SCALE_STAMP,
  STEP_MAX,
  STEP_MIN,
  clampScore,
  deriveWorld,
  kpOk,
} from "../src/pose-derive.ts";
import { STEP_DEBOUNCE_SEC, WalkStatsAccumulator } from "../src/walk-stats.ts";
import type { PoseKeypoint } from "../src/external-tracker.ts";
import {
  buildTapes,
  makeRealSession,
  runTape,
  serializeRecords,
  type TapeFrameEvent,
} from "./pose-tapes.ts";

const GOLDEN_PATH = new URL("./pose-derive-world.golden.json", import.meta.url);

// ---------------------------------------------------------------------------
// Small drive harness for the unit cases (mirrors metrics.ts walk start +
// fresh-frame seam, like makeRealSession but with direct state access).
// ---------------------------------------------------------------------------

function mkSession(idealPace = 0.85) {
  const state = new PoseDeriveState();
  const stats = new WalkStatsAccumulator();
  const target = new Float32Array(7);
  stats.reset(idealPace);
  target.fill(62); // NEUTRAL (metrics.ts beginWalkTracking)
  state.reset();
  let poseLastT = -1;
  return {
    state,
    stats,
    target,
    frame(t: number, walkTime: number, kps: Record<string, PoseKeypoint>) {
      if (t === poseLastT) return;
      const poseDt = poseLastT >= 0 ? (t - poseLastT) / 1000 : 0;
      poseLastT = t;
      deriveWorld(
        { t, source: "test", space: "world", keypoints: kps },
        poseDt,
        walkTime,
        idealPace,
        20,
        state,
        stats,
        target,
      );
    },
  };
}

function kpt(x: number, y: number, z: number, score = 0.9): PoseKeypoint {
  return { x, y, z, score };
}

/** Minimal full skeleton around a hip center. */
function body(hx: number, hy: number, hz: number): Record<string, PoseKeypoint> {
  return {
    leftHip: kpt(hx - 0.1, hy, hz),
    rightHip: kpt(hx + 0.1, hy, hz),
    leftShoulder: kpt(hx - 0.15, hy + 0.45, hz),
    rightShoulder: kpt(hx + 0.15, hy + 0.45, hz),
    leftAnkle: kpt(hx - 0.09, 0.08, hz),
    rightAnkle: kpt(hx + 0.09, 0.08, hz),
  };
}

// ---------------------------------------------------------------------------
// 1) Golden tape replay — exact, byte-level.
// ---------------------------------------------------------------------------

describe("golden tape replay (pinned pre-refactor behavior)", () => {
  const golden = readFileSync(GOLDEN_PATH, "utf8");
  const goldenRecords = JSON.parse(golden) as Array<{
    name: string;
    steps: unknown[];
  }>;
  const tapes = buildTapes();
  const records = tapes.map((tape) => runTape(makeRealSession, tape));
  const serialized = serializeRecords(records);
  // Split the serialized output per tape so a failure names its tape.
  const reSerialized = JSON.parse(serialized) as Array<{ name: string }>;

  it("covers the mandated scenarios", () => {
    expect(tapes.map((t) => t.name)).toEqual([
      "normal-walk",
      "single-hip",
      "dropout-resume",
      "heading-drift",
      "sparse-keypoints",
      "nan-junk",
      "bail-dt-semantics",
      "delta-junk",
    ]);
  });

  for (const tape of buildTapes()) {
    it(`replays byte-exact — ${tape.name}`, () => {
      const got = reSerialized.find((r) => r.name === tape.name);
      const want = goldenRecords.find((r) => r.name === tape.name);
      expect(got).toBeDefined();
      expect(want).toBeDefined();
      expect(got).toEqual(want);
    });
  }

  it("full serialization is byte-identical to the checked-in golden", () => {
    expect(serialized).toBe(golden);
  });

  it("the goldens are not trivial: steps, rollover, gaps and junk survival all occurred", () => {
    const byName = new Map(records.map((r) => [r.name, r]));
    const last = (n: string) =>
      byName.get(n)!.steps[byName.get(n)!.steps.length - 1] as {
        state: Record<string, unknown>;
      };
    // ring rolled over on the steady walk
    expect(last("normal-walk").state.intervalCount).toBe(RING_SIZE);
    // walk finalized with real steps + cadence
    const final = byName.get("normal-walk")!.final as { steps: number };
    expect(final.steps).toBeGreaterThan(5);
    // the gap cleared the ring mid-walk
    const gapStep = byName
      .get("dropout-resume")!
      .steps.find((s) => (s as { ev: string }).ev === "gap") as {
      state: { intervalCount: number; poseHavePrev: boolean };
    };
    expect(gapStep.state.intervalCount).toBe(0);
    expect(gapStep.state.poseHavePrev).toBe(false);
    // junk frames DEGRADE instead of poisoning: the kpOk finiteness gate keeps
    // every EMA finite for the rest of the walk (pre-gate this pinned NaN).
    const njLast = last("nan-junk").state;
    expect(Number.isFinite(njLast.poseSpeedEma as number)).toBe(true);
    expect(Number.isFinite(njLast.poseUprightEma as number)).toBe(true);
    expect(Number.isFinite(njLast.poseLatEma as number)).toBe(true);
    expect(Number.isFinite(njLast.poseBobBaseline as number)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Non-finite keypoints — the kpOk finiteness gate (the NaN-poisoning fix).
// ---------------------------------------------------------------------------

describe("non-finite keypoints are treated as absent (finiteness joins the gate)", () => {
  // The nan-junk tape's poisoned frames, replayed through the real module:
  // frame 60 = both hips NaN-coordinates (healthy scores), frame 90 = one
  // Infinity-coordinate ankle, frame 120 = NaN scores on every keypoint.
  const tape = buildTapes().find((t) => t.name === "nan-junk")!;
  const rec = runTape(makeRealSession, tape);
  type Step = {
    targets: number[];
    live: { pace: number | null };
    state: Record<string, number | boolean>;
  };
  const step = (i: number) => rec.steps[i] as Step;

  it("a NaN-coordinate hip pair is a bail frame: targets hold, anchor holds", () => {
    // Channel dark for that frame — the previous targets stand untouched.
    expect(step(60).targets).toEqual(step(59).targets);
    expect(step(60).state.posePrevHipX).toBe(step(59).state.posePrevHipX);
    expect(step(60).state.posePrevHipZ).toBe(step(59).state.posePrevHipZ);
  });

  it("every EMA stays finite through all three junk frames and to the end", () => {
    for (const i of [60, 61, 90, 91, 120, 121, rec.steps.length - 1]) {
      const st = step(i).state;
      for (const k of [
        "poseSpeedEma",
        "poseLatEma",
        "poseUprightEma",
        "poseBobBaseline",
      ] as const) {
        expect(Number.isFinite(st[k] as number), `step ${i} ${k}`).toBe(true);
      }
    }
  });

  it("the next clean frame recovers: the pace EMA folds a real sample again", () => {
    expect(step(61).state.poseSpeedEma).not.toBe(step(60).state.poseSpeedEma);
    expect(Number.isFinite(step(61).live.pace as number)).toBe(true);
    // The walk keeps counting steps after the junk (pre-gate it froze at 4).
    const final = rec.final as { steps: number; meanPaceMps: number };
    expect(final.steps).toBeGreaterThan(4);
    expect(Number.isFinite(final.meanPaceMps)).toBe(true);
  });

  it("recovery divides the FULL gap displacement by the FULL gap time (no 2x)", () => {
    // Hand-recompute the recovery fold: frame 60 is the bail, so the sample
    // at frame 61 spans frames 59 -> 61 in BOTH displacement and time (the
    // anchor owns its timestamp). Pre-fix this divided a two-interval chord
    // by ONE interval — a ~2.2 m/s sample for the 1.1 m/s walker.
    const e59 = tape.events[59] as TapeFrameEvent;
    const e61 = tape.events[61] as TapeFrameEvent;
    const mid = (kp: Record<string, PoseKeypoint>) => ({
      x: (kp.leftHip.x + kp.rightHip.x) * 0.5,
      z: (kp.leftHip.z + kp.rightHip.z) * 0.5,
    });
    const h0 = mid(e59.keypoints);
    const h1 = mid(e61.keypoints);
    const span = (e61.t - e59.t) / 1000; // two pose intervals
    let speed = Math.hypot(h1.x - h0.x, h1.z - h0.z) / span;
    if (speed > 4) speed = 4;
    // The raw recovery sample IS the walker's true speed (1.1 m/s + sway).
    expect(Math.abs(speed - 1.1)).toBeLessThan(0.055); // within 5%, not 2x
    const ema59 = step(59).state.poseSpeedEma as number;
    const expected = ema59 + (speed - ema59) * (1 - Math.exp(-2 * span));
    expect(step(61).state.poseSpeedEma).toBe(expected);
  });

  it("physical invariant: junk frames cannot move the true-pace mean", () => {
    // nan-junk is the SAME 1.1 m/s walker as normal-walk with two bail frames
    // (60: NaN hips, 120: NaN scores). Under the anchor-timestamp law the
    // recovery samples carry the outage's displacement AND time, so the
    // duration-weighted mean pace is identical to the junk-free walk. (The
    // pre-fix goldens pinned 1.119 vs 1.106 — pure measurement error.)
    const normal = runTape(makeRealSession, buildTapes()[0]);
    const nj = rec.final as { meanPaceMps: number };
    const nw = normal.final as { meanPaceMps: number };
    expect(nj.meanPaceMps).toBe(nw.meanPaceMps);
  });

  it("an Infinity ankle degrades to the single-ankle lateral fallback", () => {
    // Same skeleton twice: an Infinity-x left ankle vs NO left ankle must
    // produce identical state — "non-finite" and "absent" are the same gate.
    const junk = mkSession();
    const missing = mkSession();
    for (let i = 0; i < 20; i++) {
      const t = i * 50;
      const wt = 0.05 + i * 0.05;
      const kJunk = body(0.05 * i, 0.95, 0);
      const kMiss = body(0.05 * i, 0.95, 0);
      if (i === 10) {
        kJunk.leftAnkle = kpt(Infinity, 0.08, 0);
        delete (kMiss as Record<string, PoseKeypoint>).leftAnkle;
      }
      junk.frame(t, wt, kJunk);
      missing.frame(t, wt, kMiss);
    }
    expect(Array.from(junk.target)).toEqual(Array.from(missing.target));
    expect(junk.state.poseLatEma).toBe(missing.state.poseLatEma);
  });

  it("a NaN-coordinate hip equals a low-score hip (single-hip fallback owns it)", () => {
    const junk = mkSession();
    const lowScore = mkSession();
    for (let i = 0; i < 20; i++) {
      const t = i * 50;
      const wt = 0.05 + i * 0.05;
      const kJunk = body(0.05 * i, 0.95, 0);
      const kLow = body(0.05 * i, 0.95, 0);
      if (i === 10) {
        kJunk.rightHip = kpt(NaN, NaN, NaN, 0.9);
        kLow.rightHip = { ...kLow.rightHip, score: 0.1 };
      }
      junk.frame(t, wt, kJunk);
      lowScore.frame(t, wt, kLow);
    }
    expect(Array.from(junk.target)).toEqual(Array.from(lowScore.target));
    expect(junk.state.poseSpeedEma).toBe(lowScore.state.poseSpeedEma);
    expect(junk.state.poseBobBaseline).toBe(lowScore.state.poseBobBaseline);
  });
});

// ---------------------------------------------------------------------------
// The dt/anchor law (the anchor owns its timestamp) — hand-verified against
// the bail-dt-semantics tape: single bail, multi-bail run, real-outage gap.
// ---------------------------------------------------------------------------

describe("bail dt/anchor semantics (anchor-timestamp law)", () => {
  const tape = buildTapes().find((t) => t.name === "bail-dt-semantics")!;
  const rec = runTape(makeRealSession, tape);
  type Step = {
    ev: string;
    targets: number[];
    live: { pace: number | null };
    state: Record<string, number | boolean>;
  };
  const step = (i: number) => rec.steps[i] as Step;
  const mid = (kp: Record<string, PoseKeypoint>) => ({
    x: (kp.leftHip.x + kp.rightHip.x) * 0.5,
    z: (kp.leftHip.z + kp.rightHip.z) * 0.5,
  });

  it("a bail frame banks its dt and holds the anchor + targets", () => {
    expect(step(60).targets).toEqual(step(59).targets);
    expect(step(60).state.posePrevHipX).toBe(step(59).state.posePrevHipX);
    // One pose interval banked while the anchor's timestamp holds.
    expect(step(60).state.posePendingDt).toBeCloseTo(1 / 30, 12);
    expect(step(61).state.posePendingDt).toBe(0);
  });

  it("single-bail recovery folds displacement/time back to the anchor frame", () => {
    const e59 = tape.events[59] as TapeFrameEvent;
    const e61 = tape.events[61] as TapeFrameEvent;
    const h0 = mid(e59.keypoints);
    const h1 = mid(e61.keypoints);
    const span = (e61.t - e59.t) / 1000;
    let speed = Math.hypot(h1.x - h0.x, h1.z - h0.z) / span;
    if (speed > 4) speed = 4;
    expect(Math.abs(speed - 1.1)).toBeLessThan(0.055); // true speed, not 2x
    const ema59 = step(59).state.poseSpeedEma as number;
    expect(step(61).state.poseSpeedEma).toBe(
      ema59 + (speed - ema59) * (1 - Math.exp(-2 * span)),
    );
  });

  it("a multi-bail run accumulates dt and the resume measures the whole gap", () => {
    // Frames 100-104 bail (five intervals banked one by one)…
    for (let k = 0; k < 5; k++) {
      const st = step(100 + k).state;
      expect(st.posePendingDt).toBeCloseTo((k + 1) / 30, 12);
      expect(st.posePrevHipX).toBe(step(99).state.posePrevHipX); // anchor holds
      expect(st.poseSpeedEma).toBe(step(99).state.poseSpeedEma); // no fold
    }
    // …and frame 105 divides the SIX-interval displacement by six intervals.
    const e99 = tape.events[99] as TapeFrameEvent;
    const e105 = tape.events[105] as TapeFrameEvent;
    const h0 = mid(e99.keypoints);
    const h1 = mid(e105.keypoints);
    const span = (e105.t - e99.t) / 1000;
    let speed = Math.hypot(h1.x - h0.x, h1.z - h0.z) / span;
    if (speed > 4) speed = 4;
    expect(Math.abs(speed - 1.1)).toBeLessThan(0.055); // no (N+1)x double-count
    const ema99 = step(99).state.poseSpeedEma as number;
    expect(step(105).state.poseSpeedEma).toBe(
      ema99 + (speed - ema99) * (1 - Math.exp(-2 * span)),
    );
    expect(step(105).state.posePendingDt).toBe(0);
  });

  it("a REAL outage still re-seeds with zero weight (the §2 gap rule)", () => {
    const gapIdx = rec.steps.findIndex((s) => (s as Step).ev === "gap");
    expect(gapIdx).toBeGreaterThan(0);
    const gap = step(gapIdx);
    expect(gap.state.posePendingDt).toBe(0); // resetCadence dropped the debt
    expect(gap.state.poseHavePrev).toBe(false);
    // The resume frame re-seeds the anchor instead of measuring the outage:
    // poseDt = 0 (re-armed frame gate), no pace fold, no banked time.
    const resume = step(gapIdx + 1);
    expect(resume.state.poseSpeedEma).toBe(gap.state.poseSpeedEma);
    expect(resume.state.posePendingDt).toBe(0);
    expect(resume.state.poseHavePrev).toBe(true);
  });

  it("the tolerated bails leave the true-pace mean at the walker's speed", () => {
    const final = rec.final as { meanPaceMps: number };
    expect(Math.abs(final.meanPaceMps - 1.1)).toBeLessThan(0.02);
  });
});

// ---------------------------------------------------------------------------
// 2) Hand-verified spot checks — recomputed independently from the keypoints.
// ---------------------------------------------------------------------------

describe("hand-verified: first-frame warm start (normal-walk)", () => {
  const tape = buildTapes()[0];
  const ev0 = tape.events[0] as TapeFrameEvent;
  const rec = runTape(makeRealSession, tape);
  const step0 = rec.steps[0] as {
    targets: number[];
    state: Record<string, number | boolean>;
  };

  it("seeds the anchors and scores from the warm-start EMAs alone", () => {
    // poseDt = 0 on the first frame -> no pace/heading/lateral; EMA alpha
    // 1-exp(0) = 0 -> uprightEma still 0.92; bob baseline seeded to hip y.
    expect(step0.state.poseHavePrev).toBe(true);
    expect(step0.state.poseHeadingValid).toBe(false);
    expect(step0.state.poseSpeedEma).toBe(0);
    expect(step0.state.poseUprightEma).toBe(0.92);
    const hipY =
      ((ev0.keypoints.leftHip.y + ev0.keypoints.rightHip.y) * 0.5);
    expect(step0.state.poseBobBaseline).toBe(hipY);
  });

  it("first-frame targets match the score formulas recomputed by hand", () => {
    // pace: speedEma 0 < 0.05 -> 44; rhythm: <3 intervals -> 58;
    // posture: 40 + ((0.92 - 0.9) / 0.09) * 60; foot: 100 - 0 * 240 = 100.
    const posture = 40 + ((0.92 - 0.9) / 0.09) * 60;
    const pace = 44;
    const rhythm = 58;
    const foot = 100;
    const cPace = clampScore(pace);
    const cRhythm = clampScore(rhythm);
    const cPosture = clampScore(posture);
    const cFoot = clampScore(foot);
    // Ramp spans the tape's locked duration (the perfect=100 rescale).
    const sessionRamp = Math.min(ev0.walkTime / tape.durationSec, 1);
    const presence = cPosture * 0.4 + cRhythm * 0.3 + cPace * 0.3;
    const confidence =
      cPace * 0.25 +
      cPosture * 0.25 +
      cRhythm * 0.25 +
      cFoot * 0.15 +
      sessionRamp * 10;
    const presentation =
      cPosture * 0.25 +
      cRhythm * 0.25 +
      cFoot * 0.2 +
      cPace * 0.15 +
      presence * 0.15;
    // targets are stored in a Float32Array -> compare against fround().
    expect(step0.targets).toEqual(
      [posture, pace, rhythm, foot, presence, confidence, presentation].map(
        Math.fround,
      ),
    );
  });
});

describe("hand-verified: second-frame pace EMA (normal-walk)", () => {
  it("speed and EMA match hypot(d)/dt folded once", () => {
    const tape = buildTapes()[0];
    const ev0 = tape.events[0] as TapeFrameEvent;
    const ev1 = tape.events[1] as TapeFrameEvent;
    const rec = runTape(makeRealSession, tape);
    const step1 = rec.steps[1] as {
      targets: number[];
      state: { poseSpeedEma: number };
      live: { pace: number | null };
    };
    const mid = (kp: Record<string, PoseKeypoint>) => ({
      x: (kp.leftHip.x + kp.rightHip.x) * 0.5,
      z: (kp.leftHip.z + kp.rightHip.z) * 0.5,
    });
    const h0 = mid(ev0.keypoints);
    const h1 = mid(ev1.keypoints);
    const dt = (ev1.t - ev0.t) / 1000;
    let speed = Math.hypot(h1.x - h0.x, h1.z - h0.z) / dt;
    if (speed > 4) speed = 4;
    let ema = 0;
    ema += (speed - ema) * (1 - Math.exp(-2 * dt));
    expect(step1.state.poseSpeedEma).toBe(ema);
    expect(step1.live.pace).toBe(ema);
    // The moving-pace MAPPING, recomputed by hand on its sensitive side
    // (ema >= 0.05): PACE Part B - full credit inside the control band,
    // then the asymmetric slopes (kSlow beyond it slow, kFast fast).
    expect(ema).toBeGreaterThanOrEqual(0.05);
    const d = ema - tape.idealPace;
    const byHand =
      d > PACE_BAND_MPS
        ? 100 - (d - PACE_BAND_MPS) * PACE_K_FAST
        : d < -PACE_BAND_MPS
          ? 100 - (-d - PACE_BAND_MPS) * PACE_K_SLOW
          : 100;
    expect(step1.targets[1]).toBe(Math.fround(byHand));
  });
});

describe("hand-verified: score-mapping constants on their sensitive side", () => {
  it("the 0.05 idle threshold straddles: just below -> 44, just above -> formula", () => {
    // Two identical two-frame sessions; only the hip displacement differs so
    // the folded EMA lands just under vs just over the idle threshold.
    const drive = (speed: number) => {
      const s = mkSession();
      s.frame(0, 0.1, body(0, 0.95, 0));
      const kps = body(speed * 0.1, 0.95, 0);
      s.frame(100, 0.2, kps); // dt = 0.1 s
      // Hand fold, midpoint recomputed exactly as the module reads it.
      const hx = (kps.leftHip.x + kps.rightHip.x) * 0.5;
      const v = Math.hypot(hx - 0, 0 - 0) / 0.1;
      const ema = 0 + (v - 0) * (1 - Math.exp(-2 * 0.1));
      expect(s.state.poseSpeedEma).toBe(ema);
      return { s, ema };
    };
    const below = drive(0.27); // ema ~0.0489 < 0.05
    expect(below.ema).toBeLessThan(0.05);
    expect(below.s.target[1]).toBe(44);
    const above = drive(0.28); // ema ~0.0508 >= 0.05
    expect(above.ema).toBeGreaterThanOrEqual(0.05);
    // Part B mapping: the just-above-idle EMA sits far BELOW the band,
    // so the slow slope applies.
    expect(above.s.target[1]).toBe(
      Math.fround(100 - (0.85 - above.ema - PACE_BAND_MPS) * PACE_K_SLOW),
    );
  });

  it("rhythm slope: a nonzero cv recomputes to 100 - cv * 220 exactly", () => {
    // Alternating up-phase spacings (12 vs 18 frames) produce two DISTINCT
    // step intervals, so MAD > 0 and the slope term actually exercises.
    const s = mkSession();
    const frameMs = 33.34;
    const pattern = [6, 6, 9, 9, 6, 6, 9, 9, 6];
    let i = 0;
    for (let p = 0; p < pattern.length; p++) {
      const up = p % 2 === 0;
      for (let k = 0; k < pattern[p]; k++, i++) {
        const hy = 0.95 + (up ? 0.05 : -0.05);
        s.frame(i * frameMs, (i * frameMs) / 1000 + 0.05, body(0.02 * i, hy, 0));
      }
    }
    const n = s.state.intervalCount;
    expect(n).toBeGreaterThanOrEqual(3);
    // Recompute mean/MAD/cv by hand from the ring's stored (float32) values.
    const ints = Array.from(s.state.intervals.slice(0, n));
    expect(new Set(ints).size).toBeGreaterThan(1); // genuinely distinct
    let mean = 0;
    for (const v of ints) mean += v;
    mean /= n;
    let mad = 0;
    for (const v of ints) mad += Math.abs(v - mean);
    mad /= n;
    const cv = mad / mean;
    expect(cv).toBeGreaterThan(0);
    expect(s.target[2]).toBe(Math.fround(100 - cv * 220));
  });

  it("bob threshold 0.008 straddles, and the baseline folds at rate 1.2", () => {
    // On the second frame the baseline has already absorbed alpha of the
    // rise, so the crossing sees dev = D * (1 - alpha): D must clear
    // 0.008 / (1 - alpha) ~ 0.00902 to trip the detector.
    const drive = (D: number) => {
      const s = mkSession();
      s.frame(0, 0.1, body(0, 0.95, 0)); // baseline seeds to 0.95
      const hy = 0.95 + D;
      s.frame(100, 0.2, body(0.01, hy, 0)); // dt = 0.1 s
      // Hand-folded baseline: seed + (hy - seed) * (1 - exp(-1.2 * dt)).
      const baseline = 0.95 + (hy - 0.95) * (1 - Math.exp(-1.2 * 0.1));
      expect(s.state.poseBobBaseline).toBe(baseline);
      return { s, dev: hy - baseline };
    };
    const below = drive(0.0089);
    expect(below.dev).toBeLessThanOrEqual(0.008);
    expect(below.s.state.poseBobSign).toBe(0);
    expect((below.s.stats.finalize(1) as { steps: number }).steps).toBe(0);
    const above = drive(0.0091);
    expect(above.dev).toBeGreaterThan(0.008);
    expect(above.s.state.poseBobSign).toBe(1);
    expect((above.s.stats.finalize(1) as { steps: number }).steps).toBe(1);
  });
});

describe("hand-verified: tracking-jump clamp and true-pace stats", () => {
  it("clamps a 10 m/s hip jump to 4 m/s in EMA and stats alike", () => {
    const s = mkSession();
    s.frame(0, 0.1, body(0, 0.95, 0));
    s.frame(100, 0.2, body(1, 0.95, 0)); // 1 m in 100 ms = 10 m/s -> clamp 4
    const dt = 0.1;
    let ema = 0;
    ema += (4 - ema) * (1 - Math.exp(-2 * dt));
    expect(s.state.poseSpeedEma).toBe(ema);
    // stats got the CLAMPED true speed, duration-weighted
    const final = s.stats.finalize(1) as { meanPaceMps: number };
    expect(final.meanPaceMps).toBe(4);
  });
});

describe("hand-verified: single-hip fallback equals the both-hip midpoint", () => {
  it("a lone hip at the midpoint position produces identical state", () => {
    const both = mkSession();
    const single = mkSession();
    for (let i = 0; i < 30; i++) {
      const t = i * 50;
      const wt = 0.05 + i * 0.05;
      const hx = 0.06 * i;
      const kpsBoth = body(hx, 0.95, 0);
      // Same skeleton, but both hips COINCIDE at the midpoint...
      kpsBoth.leftHip = kpt(hx, 0.95, 0);
      kpsBoth.rightHip = kpt(hx, 0.95, 0);
      both.frame(t, wt, kpsBoth);
      // ...vs only one hip at that midpoint (the other under the 0.3 gate).
      const kpsSingle = body(hx, 0.95, 0);
      kpsSingle.leftHip = kpt(hx, 0.95, 0);
      kpsSingle.rightHip = { ...kpt(hx, 0.95, 0), score: 0.1 };
      single.frame(t, wt, kpsSingle);
    }
    expect(Array.from(single.target)).toEqual(Array.from(both.target));
    expect(single.state.poseSpeedEma).toBe(both.state.poseSpeedEma);
    expect(single.state.poseBobBaseline).toBe(both.state.poseBobBaseline);
    expect(single.state.poseLatEma).toBe(both.state.poseLatEma);
  });
});

describe("hand-verified: footwork gating on the travel heading", () => {
  it("no lateral is measured before real motion validates the heading", () => {
    const s = mkSession();
    for (let i = 0; i < 10; i++) {
      s.frame(i * 50, 0.05 + i * 0.05, body(0, 0.95, 0)); // stationary
    }
    expect(s.state.poseHeadingValid).toBe(false);
    expect(s.state.poseLatEma).toBe(0);
    expect(Math.fround(100)).toBe(s.target[3]); // footPlacement pinned at the anchor
    // First real displacement turns the heading valid.
    s.frame(500, 0.55, body(0.05, 0.95, 0));
    expect(s.state.poseHeadingValid).toBe(true);
  });

  it("ankle lateral is the perpendicular distance to the travel line", () => {
    const s = mkSession();
    // Two frames moving straight +x seed heading (1, 0)-ish; ankles offset in z.
    s.frame(0, 0.1, body(0, 0.95, 0));
    s.frame(100, 0.2, body(0.1, 0.95, 0));
    const st = s.state;
    const hmag = Math.hypot(st.poseHeadingX, st.poseHeadingZ) || 1;
    const hxn = st.poseHeadingX / hmag;
    const hzn = st.poseHeadingZ / hmag;
    // body() ankles sit at hip x -/+ 0.09 in X, z = hip z; recompute the mean
    // |perp| by hand for the second frame (hip at x=0.1).
    const la = { x: 0.1 - 0.09, z: 0 };
    const ra = { x: 0.1 + 0.09, z: 0 };
    let lat =
      (Math.abs((la.x - 0.1) * -hzn + (la.z - 0) * hxn) +
        Math.abs((ra.x - 0.1) * -hzn + (ra.z - 0) * hxn)) /
      2;
    let ema = 0;
    ema += (lat - ema) * (1 - Math.exp(-1.5 * 0.1));
    expect(st.poseLatEma).toBe(ema);
  });

  it("a NONZERO ankle offset drives target[3] = 100 - ema * 240 exactly", () => {
    // body()'s ankles sit ON the travel line (offset along x only), so the
    // slope term never exercised — plant them 0.09 m to each SIDE (z) of a
    // +x walk and recompute the mapping by hand on its sensitive side.
    const s = mkSession();
    const mk = (hx: number) => {
      const k = body(hx, 0.95, 0);
      k.leftAnkle = kpt(hx, 0.08, -0.09);
      k.rightAnkle = kpt(hx, 0.08, 0.09);
      return k;
    };
    s.frame(0, 0.1, mk(0));
    s.frame(100, 0.2, mk(0.1));
    const st = s.state;
    const hmag = Math.hypot(st.poseHeadingX, st.poseHeadingZ) || 1;
    const hxn = st.poseHeadingX / hmag;
    const hzn = st.poseHeadingZ / hmag;
    const la = { x: 0.1, z: -0.09 };
    const ra = { x: 0.1, z: 0.09 };
    let lat =
      Math.abs((la.x - 0.1) * -hzn + (la.z - 0) * hxn) +
      Math.abs((ra.x - 0.1) * -hzn + (ra.z - 0) * hxn);
    lat /= 2;
    let ema = 0;
    ema += (lat - ema) * (1 - Math.exp(-1.5 * 0.1));
    expect(st.poseLatEma).toBe(ema);
    expect(ema).toBeGreaterThan(0);
    expect(s.target[3]).toBe(Math.fround(100 - ema * 240));
  });
});

describe("hand-verified: footstrikes, ring windowing, debounce", () => {
  /** Drive a square-wave hip bob: `period` frames up, `period` down. */
  function bobWalk(upDownFrames: number, cycles: number, frameMs: number) {
    const s = mkSession();
    let i = 0;
    for (let c = 0; c < cycles; c++) {
      for (let phase = 0; phase < 2; phase++) {
        for (let k = 0; k < upDownFrames; k++, i++) {
          const hy = 0.95 + (phase === 0 ? +0.05 : -0.05);
          s.frame(i * frameMs, (i * frameMs) / 1000 + 0.05, body(0.02 * i, hy, 0));
        }
      }
    }
    return s;
  }

  it("equal strike intervals fill the ring and score rhythm 100 (cv = 0)", () => {
    // 6 frames up + 6 down at 33.34 ms -> up-crossings every ~0.4 s (in the
    // [STEP_MIN, STEP_MAX] window), identical intervals -> MAD 0 -> 96.
    const s = bobWalk(6, 8, 33.34);
    expect(s.state.intervalCount).toBeGreaterThanOrEqual(3);
    const ints = Array.from(s.state.intervals.slice(0, s.state.intervalCount));
    expect(new Set(ints).size).toBe(1); // all identical
    expect(s.target[2]).toBe(100);
  });

  it("ring rolls over at RING_SIZE without growing", () => {
    const s = bobWalk(6, 16, 33.34);
    expect(s.state.intervalCount).toBe(RING_SIZE);
    expect(s.state.intervalIdx).toBeLessThan(RING_SIZE);
  });

  it("sub-STEP_MIN re-fires are debounced from stats and kept out of the ring", () => {
    // 2 frames up + 2 down at 25 ms -> crossings every 0.1 s < STEP_MIN 0.15.
    const s = bobWalk(2, 10, 25);
    expect(s.state.intervalCount).toBe(0); // interval window rejected them
    const final = s.stats.finalize(1) as { steps: number };
    // The accumulator's own debounce (STEP_DEBOUNCE_SEC) drops the re-fires:
    // strikes land every 0.1 s but only every second one is >= 0.15 s apart.
    expect(STEP_DEBOUNCE_SEC).toBe(STEP_MIN);
    expect(final.steps).toBeLessThan(10);
    expect(final.steps).toBeGreaterThan(0);
  });

  it("intervals beyond STEP_MAX stay out of the ring (steps still count)", () => {
    // 13 frames up + 13 down at 50 ms -> crossings every 1.3 s > STEP_MAX.
    const slow = bobWalk(13, 4, 50);
    expect(slow.state.intervalCount).toBe(0); // window rejected every interval
    expect((slow.stats.finalize(6) as { steps: number }).steps).toBeGreaterThan(
      1,
    ); // a strike after a pause is still a real step
    // 11 + 11 at 50 ms -> 1.1 s, inside the window -> intervals accepted.
    const brisk = bobWalk(11, 4, 50);
    expect(brisk.state.intervalCount).toBeGreaterThanOrEqual(2);
  });
});

describe("SOLO-MODE §5 tuning constants are pinned by VALUE for the Swift port", () => {
  it("ring/step-window constants match the spec literals", () => {
    // Literal pins (not identifier-vs-identifier): a tuning edit plus a
    // golden regen must still go red HERE until the spec is updated.
    expect(RING_SIZE).toBe(8);
    expect(STEP_MIN).toBe(0.15);
    expect(STEP_MAX).toBe(1.2);
    expect(STEP_DEBOUNCE_SEC).toBe(0.15);
  });
});

// ---------------------------------------------------------------------------
// Junk delta — the caller-input sanitize (delta is a port-surface input).
// ---------------------------------------------------------------------------

describe("junk delta is a dark frame (non-finite/non-positive -> 0)", () => {
  function rawSession(idealPace = 0.85) {
    const state = new PoseDeriveState();
    const stats = new WalkStatsAccumulator();
    const target = new Float32Array(7);
    stats.reset(idealPace);
    target.fill(62);
    state.reset();
    return {
      state,
      stats,
      target,
      derive(delta: number, walkTime: number, kps: Record<string, PoseKeypoint>) {
        deriveWorld(
          { t: 0, source: "test", space: "world", keypoints: kps },
          delta,
          walkTime,
          idealPace,
          20,
          state,
          stats,
          target,
        );
      },
    };
  }

  const snapState = (s: ReturnType<typeof rawSession>) => ({
    speedEma: s.state.poseSpeedEma,
    latEma: s.state.poseLatEma,
    uprightEma: s.state.poseUprightEma,
    bobBaseline: s.state.poseBobBaseline,
    pendingDt: s.state.posePendingDt,
    prevHipX: s.state.posePrevHipX,
    havePrev: s.state.poseHavePrev,
    targets: Array.from(s.target),
  });

  for (const junk of [NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    it(`delta ${junk} behaves EXACTLY like delta 0 and never poisons an EMA`, () => {
      const a = rawSession();
      const b = rawSession();
      const walk = (i: number) => body(0.04 * i, 0.95 + 0.01 * (i % 2), 0);
      for (let i = 0; i < 5; i++) {
        a.derive(i === 0 ? 0 : 1 / 30, 0.1 + i / 30, walk(i));
        b.derive(i === 0 ? 0 : 1 / 30, 0.1 + i / 30, walk(i));
      }
      a.derive(junk, 0.3, walk(5)); // the junk-dt frame (healthy keypoints)
      b.derive(0, 0.3, walk(5)); // the defined dark-frame equivalent
      expect(snapState(a)).toEqual(snapState(b));
      for (const v of Object.values(snapState(a))) {
        if (typeof v === "number") expect(Number.isFinite(v)).toBe(true);
      }
      // Recovery: the next clean frame folds a real sample in both.
      a.derive(1 / 30, 0.3 + 1 / 30, walk(6));
      b.derive(1 / 30, 0.3 + 1 / 30, walk(6));
      expect(snapState(a)).toEqual(snapState(b));
      expect(Number.isFinite(a.state.poseSpeedEma)).toBe(true);
    });
  }

  it("the delta-junk tape: backward and NaN frame.t are zero-weight, never sticky", () => {
    const tape = buildTapes().find((t) => t.name === "delta-junk")!;
    const rec = runTape(makeRealSession, tape);
    type Step = { state: Record<string, number | boolean>; live: { pace: number | null } };
    const step = (i: number) => rec.steps[i] as Step;
    // Frame 45 arrives with a BACKWARD frame.t -> negative poseDt -> 0:
    // every EMA holds, the anchor still re-seats on the frame's hips.
    expect(step(45).state.poseSpeedEma).toBe(step(44).state.poseSpeedEma);
    expect(step(45).state.poseUprightEma).toBe(step(44).state.poseUprightEma);
    expect(step(45).state.posePrevHipX).not.toBe(step(44).state.posePrevHipX);
    // Frame 80 arrives with a NaN frame.t -> NaN poseDt -> 0 (dark), and the
    // FOLLOWING frame's poseDt is (t - NaN) = NaN -> 0 (dark again) — but
    // the seam re-arms poseLastT to that frame's finite t, so frame 82
    // onward measures normally. Two dark frames, contained recovery, every
    // EMA finite (pre-sanitize this NaN-poisoned poseBobBaseline /
    // poseUprightEma permanently).
    const last = rec.steps.length - 1;
    expect(step(80).state.poseSpeedEma).toBe(step(79).state.poseSpeedEma);
    expect(step(81).state.poseSpeedEma).toBe(step(79).state.poseSpeedEma);
    expect(step(82).state.poseSpeedEma).not.toBe(step(81).state.poseSpeedEma);
    for (const k of [
      "poseSpeedEma",
      "poseLatEma",
      "poseUprightEma",
      "poseBobBaseline",
    ]) {
      expect(Number.isFinite(step(last).state[k] as number), k).toBe(true);
    }
    const final = rec.final as { meanPaceMps: number };
    expect(Number.isFinite(final.meanPaceMps)).toBe(true);
  });
});

describe("hand-verified: honest-dark stats taps on the world path", () => {
  it("lateral and posture live taps go dark; pace is live", () => {
    const s = mkSession();
    s.stats.liveLateralM = 0.5; // pretend a head stretch wrote them
    s.stats.livePostureM = 0.5;
    s.frame(0, 0.1, body(0, 0.95, 0));
    expect(s.stats.liveLateralM).toBeNull();
    expect(s.stats.livePostureM).toBeNull();
    s.frame(100, 0.2, body(0.1, 0.95, 0));
    expect(s.stats.livePaceMps).toBe(s.state.poseSpeedEma);
    const final = s.stats.finalize(1) as {
      meanLateralM: null;
      postureDriftM: null;
      source: string;
    };
    expect(final.meanLateralM).toBeNull();
    expect(final.postureDriftM).toBeNull();
    expect(final.source).toBe("camera-world");
  });
});

describe("hand-verified: bail and reset seams", () => {
  it("a frame with no usable hip holds the previous targets untouched", () => {
    const s = mkSession();
    s.frame(0, 0.1, body(0, 0.95, 0));
    s.frame(100, 0.2, body(0.1, 0.95, 0));
    const before = Array.from(s.target);
    const stateBefore = { ...s.state };
    s.frame(200, 0.3, {
      leftHip: { ...kpt(0.2, 0.95, 0), score: 0.29 },
      rightHip: { ...kpt(0.2, 0.95, 0), score: NaN },
    });
    expect(Array.from(s.target)).toEqual(before);
    expect(s.state.posePrevHipX).toBe(stateBefore.posePrevHipX); // anchor held
  });

  it("resetCadence clears ring + bob + anchor but keeps EMAs and heading", () => {
    const s = mkSession();
    for (let i = 0; i < 60; i++) {
      const t = i * 33.34;
      s.frame(t, t / 1000 + 0.05, body(0.04 * i, 0.95 + 0.05 * ((i % 12 < 6) ? 1 : -1), 0));
    }
    const emaSpeed = s.state.poseSpeedEma;
    const heading = [s.state.poseHeadingX, s.state.poseHeadingZ];
    expect(s.state.intervalCount).toBeGreaterThan(0);
    s.state.posePendingDt = 0.5; // pretend bail frames banked time pre-outage
    s.state.resetCadence();
    expect(s.state.intervalCount).toBe(0);
    expect(s.state.intervalIdx).toBe(0);
    expect(s.state.poseBobHavePrev).toBe(false);
    expect(s.state.poseBobSign).toBe(0);
    expect(s.state.poseLastCross).toBe(-1);
    expect(s.state.poseHavePrev).toBe(false);
    expect(s.state.posePendingDt).toBe(0); // banked time dies with the anchor
    // survives (only cadence/anchor state re-arms on a source handoff):
    expect(s.state.poseSpeedEma).toBe(emaSpeed);
    expect([s.state.poseHeadingX, s.state.poseHeadingZ]).toEqual(heading);
    expect(s.state.poseHeadingValid).toBe(true);
  });

  it("reset() restores the exact walk-start values from beginWalkTracking", () => {
    const s = mkSession();
    for (let i = 0; i < 30; i++) {
      s.frame(i * 40, i * 0.04 + 0.05, body(0.05 * i, 0.95, 0));
    }
    s.state.reset();
    const fresh = {
      posePrevHipX: 0,
      posePrevHipZ: 0,
      poseHavePrev: false,
      poseSpeedEma: 0,
      poseLatEma: 0,
      poseUprightEma: 0.92,
      poseHeadingX: 0,
      poseHeadingZ: 0,
      poseHeadingValid: false,
      poseBobBaseline: 0,
      poseBobHavePrev: false,
      poseBobSign: 0,
      poseLastCross: -1,
      posePendingDt: 0,
      intervalIdx: 0,
      intervalCount: 0,
    };
    for (const [k, v] of Object.entries(fresh)) {
      expect(s.state[k as keyof PoseDeriveState]).toBe(v);
    }
  });
});

describe("shared helpers keep their exact gates", () => {
  it("kpOk: 0.3 passes, just below fails, NaN fails, absent fails", () => {
    const good = kpt(1, 2, 3, 0.3);
    expect(kpOk({ a: good }, "a")).toBe(good);
    expect(kpOk({ a: kpt(1, 2, 3, 0.29999) }, "a")).toBeNull();
    expect(kpOk({ a: kpt(1, 2, 3, NaN) }, "a")).toBeNull();
    expect(kpOk({}, "a")).toBeNull();
  });

  it("kpOk: a non-finite coordinate fails the gate whatever the score says", () => {
    // Coordinate finiteness IS the acceptance gate (the NaN-poisoning fix):
    // each axis rejects NaN and both infinities independently.
    expect(kpOk({ a: kpt(NaN, 2, 3, 0.9) }, "a")).toBeNull();
    expect(kpOk({ a: kpt(1, NaN, 3, 0.9) }, "a")).toBeNull();
    expect(kpOk({ a: kpt(1, 2, NaN, 0.9) }, "a")).toBeNull();
    expect(kpOk({ a: kpt(Infinity, 2, 3, 0.9) }, "a")).toBeNull();
    expect(kpOk({ a: kpt(1, -Infinity, 3, 0.9) }, "a")).toBeNull();
    expect(kpOk({ a: kpt(1, 2, Infinity, 0.9) }, "a")).toBeNull();
    // ...while ordinary finite coordinates (zero included) still pass.
    const zero = kpt(0, 0, 0, 0.9);
    expect(kpOk({ a: zero }, "a")).toBe(zero);
  });

  it("clampScore clamps to [SCORE_MIN, SCORE_MAX] and passes NaN through", () => {
    expect(SCORE_MIN).toBe(40);
    expect(SCORE_MAX).toBe(100);
    expect(clampScore(39.999)).toBe(40);
    expect(clampScore(40)).toBe(40);
    expect(clampScore(70.5)).toBe(70.5);
    expect(clampScore(100)).toBe(100);
    expect(clampScore(100.001)).toBe(100);
    // NaN fails both comparisons and flows through — a documented property of
    // the pure function. The kpOk finiteness gate upstream is what keeps NaN
    // out of the EMAs, so no derivation path feeds this a NaN anymore.
    expect(Number.isNaN(clampScore(NaN))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §B wrote-targets return (the presence-blend latch contract): deriveWorld
// returns FALSE on the both-hips bail — no targets written — and TRUE after
// a full derivation. metrics.ts update() feeds this return into `derived`,
// so a fresh-but-hipless camera frame can never latch an already-blended
// target[4] (the §B compounding blocker, fresh-frame flavor).
// ---------------------------------------------------------------------------

describe("§B wrote-targets return", () => {
  it("false on the both-hips bail; targets untouched", () => {
    const state = new PoseDeriveState();
    const stats = new WalkStatsAccumulator();
    const target = new Float32Array(7);
    stats.reset(0.85);
    target.fill(62);
    state.reset();
    const hipless = {
      leftShoulder: kpt(0, 1.4, 0),
      rightShoulder: kpt(0.3, 1.4, 0),
      leftHip: kpt(0, 1, 0, 0.1), // under the kpOk 0.3 score gate
      rightHip: kpt(0.2, 1, 0, 0.1),
    };
    const wrote = deriveWorld(
      { t: 1, source: "test", space: "world", keypoints: hipless },
      1 / 30,
      0.5,
      0.85,
      20,
      state,
      stats,
      target,
    );
    expect(wrote).toBe(false);
    for (let i = 0; i < 7; i++) expect(target[i]).toBe(62); // held
    expect(state.posePendingDt).toBeCloseTo(1 / 30, 12); // dt banked
  });

  it("true after a full derivation (targets written)", () => {
    const state = new PoseDeriveState();
    const stats = new WalkStatsAccumulator();
    const target = new Float32Array(7);
    stats.reset(0.85);
    target.fill(62);
    state.reset();
    const wrote = deriveWorld(
      { t: 1, source: "test", space: "world", keypoints: body(0, 1, 0) },
      1 / 30,
      0.5,
      0.85,
      20,
      state,
      stats,
      target,
    );
    expect(wrote).toBe(true);
  });
});

describe("the founder pin (perfect=100 rescale): a perfect walk reads 100 everywhere", () => {
  it("every channel AND every composite hits exactly 100 at the anchors with a full ramp", () => {
    // Prime a converged perfect state (the EMAs an ideal walk folds to),
    // then run ONE real derive at walkTime = the locked duration: the
    // engine itself must emit 100 on every channel and composite — the
    // ruling is the arithmetic, not a rounding accident.
    const state = new PoseDeriveState();
    const stats = new WalkStatsAccumulator();
    const target = new Float32Array(7);
    stats.reset(0.85);
    state.reset();
    state.poseSpeedEma = 0.85; // dv = 0 -> pace 100
    state.poseUprightEma = 0.99; // 40 + ((0.99-0.9)/0.09)*60 = exactly 100
    state.poseLatEma = 0; // dead on the line -> 100
    // cv = 0: >= 3 identical strike intervals in the ring.
    state.intervals[0] = 0.5;
    state.intervals[1] = 0.5;
    state.intervals[2] = 0.5;
    state.intervalCount = 3;
    state.poseHavePrev = false; // the frame seeds; the primed EMAs hold
    const wrote = deriveWorld(
      { t: 1, source: "test", space: "world", keypoints: body(0, 1, 0) },
      1 / 30,
      20, // walkTime = the locked duration
      0.85,
      20, // rampSeconds
      state,
      stats,
      target,
    );
    expect(wrote).toBe(true);
    // posture(0) pace(1) rhythm(2) foot(3) hold RAW channel values (the
    // composites consume the CLAMPED ones); presence(4) confidence(5)
    // presentation(6) are the composites themselves — all exactly 100.
    for (let i = 0; i < 7; i++) {
      expect(clampScore(target[i]), `channel ${i}`).toBe(100);
    }
  });

  it("the ruler stamp and the anchors ship in the same build on BOTH platforms", () => {
    // The split-lag tripwire (adversary finding): a stamp that moves
    // without the anchors (or vice versa, on either platform) mints rows
    // claiming a ruler they weren't scored on. Pin the stamp token and the
    // 100-anchors to the SAME source files, web and Swift.
    expect(SCORE_SCALE_STAMP).toBe("s100-pb.v3");
    const readSrc = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const web = readSrc("../src/pose-derive.ts");
    expect(web).toContain('SCORE_SCALE_STAMP = "s100-pb.v3"');
    expect(web).toContain("SCORE_MAX = 100");
    const swift = readSrc(
      "../native/ios-companion/Sources/XRunwayCore/PoseDerive.swift",
    );
    expect(swift).toContain('SCORE_SCALE_STAMP = "s100-pb.v3"');
    expect(swift).toContain("SCORE_MAX: Double = 100");
  });
});
