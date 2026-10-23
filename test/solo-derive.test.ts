/**
 * SOLO derivation producer (SOLO-MODE §3) — src/pose-derive.ts
 * soloDeriveWorld. The §3 decisions, unit-locked:
 *
 * - Posture (M1) = SIGNED hip-height drift vs the walk-start baseline: ONE
 *   quantity feeding livePostureM/postureDriftM AND the M1 score
 *   (100 - |dev|EMA * SOLO_POSTURE_SLOPE, the head-path curve shape with the
 *   slope re-derived — see the constant's derivation comment).
 * - Lateral = SIGNED perpendicular hip-path offset from the walker's own
 *   travel line (+ = walker's right relative to travel), turn-window
 *   excluded, feeding liveLateralM/meanLateralM; the M4 score keeps the abs
 *   ankle-offset input.
 * - The WEB path (deriveWorld) is byte-unchanged: it never touches the solo
 *   channels (proven here and by the byte-golden tape suite).
 * - Frame invariance: every solo tape produces identical outputs under the
 *   rigid yaw+translation freedom of an unregistered ARKit frame.
 */

import { describe, expect, it } from "vitest";

import {
  PoseDeriveState,
  SOLO_HEADING_STABLE_MIN,
  SOLO_LATERAL_BASELINE_SEC,
  SOLO_POSTURE_SLOPE,
  deriveWorld,
  soloDeriveWorld,
} from "../src/pose-derive.ts";
import {
  SOLO_LATERAL_CUE_M,
  SOLO_POSTURE_CUE_M,
  PACE_DELTA_CUE_MPS,
} from "../src/coach-live.ts";
import { WalkStatsAccumulator, type WalkStats } from "../src/walk-stats.ts";
import type { PoseKeypoint } from "../src/external-tracker.ts";
import { RIGID_TRANSFORM, goldenDiff } from "./golden-format.ts";
import { buildSoloTapes, makeSoloSession, runTape } from "./pose-tapes.ts";

function kpt(x: number, y: number, z: number, score = 0.9): PoseKeypoint {
  return { x, y, z, score };
}

/** Minimal full skeleton around a hip center (z included). */
function body(
  hx: number,
  hy: number,
  hz: number,
): Record<string, PoseKeypoint> {
  return {
    leftHip: kpt(hx - 0.1, hy, hz),
    rightHip: kpt(hx + 0.1, hy, hz),
    leftShoulder: kpt(hx - 0.15, hy + 0.45, hz),
    rightShoulder: kpt(hx + 0.15, hy + 0.45, hz),
    leftAnkle: kpt(hx - 0.09, 0.08, hz),
    rightAnkle: kpt(hx + 0.09, 0.08, hz),
  };
}

/** Direct-drive harness around soloDeriveWorld (metrics-seam equivalent). */
function soloSession(idealPace = 0.85) {
  const state = new PoseDeriveState();
  const stats = new WalkStatsAccumulator();
  const target = new Float32Array(7);
  stats.reset(idealPace);
  target.fill(62);
  state.reset();
  let poseLastT = -1;
  return {
    state,
    stats,
    target,
    frame(
      t: number,
      walkTime: number,
      kps: Record<string, PoseKeypoint>,
      turnExcluded = false,
    ) {
      if (t === poseLastT) return;
      const poseDt = poseLastT >= 0 ? (t - poseLastT) / 1000 : 0;
      poseLastT = t;
      soloDeriveWorld(
        { t, source: "test", space: "world", keypoints: kps },
        poseDt,
        walkTime,
        idealPace,
        20,
        state,
        stats,
        target,
        turnExcluded,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Re-derived constants — pinned by VALUE with their derivations cross-checked.
// ---------------------------------------------------------------------------

describe("SOLO constants are pinned by value, derivations cross-checked", () => {
  it("SOLO_POSTURE_SLOPE and the gates carry their derived values", () => {
    expect(SOLO_POSTURE_SLOPE).toBe(280);
    expect(SOLO_LATERAL_CUE_M).toBe(0.15);
    expect(SOLO_POSTURE_CUE_M).toBe(0.075);
    expect(SOLO_HEADING_STABLE_MIN).toBe(0.9);
    expect(SOLO_LATERAL_BASELINE_SEC).toBe(1.0);
    // Pace carries UNCHANGED into Solo (same channel, same mapping).
    expect(PACE_DELTA_CUE_MPS).toBe(0.25);
  });

  it("the posture gate is a tuned physical value (the retired score-bar rule)", () => {
    // Pre-rescale, the gate was the dev where the OLD 96 anchor crossed the
    // lowest pass bar (75): 0.075 = 21/280. The perfect=100 rescale moved
    // the anchor (+4) but deliberately kept the cue value — it now fires
    // ~4 pts BEFORE the bar (the safe direction: coaching leads the
    // verdict). Pin both facts so a slope/cue retune must revisit this.
    expect(SOLO_POSTURE_CUE_M).toBe(21 / SOLO_POSTURE_SLOPE);
    expect(100 - SOLO_POSTURE_CUE_M * SOLO_POSTURE_SLOPE).toBe(79);
  });

  it("the lateral gate keeps the web noise rule on the hip channel", () => {
    // >= 4x the channel's natural noise (hip sway ~0.03 m — the tape
    // walker's swayAmp; the web rule used ~4x of 5 cm head sway).
    expect(SOLO_LATERAL_CUE_M / 0.03).toBeGreaterThanOrEqual(4);
    // And it stays BELOW the web gate: the hip channel carries no stance
    // width, so the same physical drift reads smaller than the head channel.
    expect(SOLO_LATERAL_CUE_M).toBeLessThan(0.2);
  });
});

// ---------------------------------------------------------------------------
// The web path never touches the solo channels (additive-variant proof).
// ---------------------------------------------------------------------------

describe("the web path is untouched by the solo channels", () => {
  it("deriveWorld leaves solo state at zero and the taps dark", () => {
    const state = new PoseDeriveState();
    const stats = new WalkStatsAccumulator();
    const target = new Float32Array(7);
    stats.reset(0.85);
    target.fill(62);
    state.reset();
    let lastT = -1;
    for (let i = 0; i < 30; i++) {
      const t = i * 40;
      const dt = lastT >= 0 ? (t - lastT) / 1000 : 0;
      lastT = t;
      deriveWorld(
        { t, source: "t", space: "world", keypoints: body(0.05 * i, 0.95, 0) },
        dt,
        0.05 + i * 0.04,
        0.85,
        20,
        state,
        stats,
        target,
      );
    }
    expect(state.soloLatOffset).toBe(0);
    expect(state.soloBaseSamples).toBe(0);
    expect(state.soloHipDevEma).toBe(0);
    expect(stats.liveLateralM).toBeNull();
    expect(stats.livePostureM).toBeNull();
    const final = stats.finalize(1.5) as WalkStats;
    expect(final.meanLateralM).toBeNull();
    expect(final.postureDriftM).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §3 lateral — signed hip-path offset, + = the walker's right.
// ---------------------------------------------------------------------------

describe("solo lateral: signed hip-path offset from the travel line", () => {
  /** 60 straight frames at 50 ms: the heading EMA passes the stability
   *  gate (~31 folds to |h| >= 0.9) and the 1 s baseline window closes
   *  with the raw integral at 0 (no z motion), so the baseline is 0. */
  function warmedUp(dir: 1 | -1) {
    const s = soloSession();
    for (let i = 0; i < 60; i++) {
      s.frame(i * 50, 0.05 + i * 0.05, body(dir * 0.05 * i, 0.95, 0));
    }
    expect(s.state.poseHeadingValid).toBe(true);
    expect(
      Math.hypot(s.state.poseHeadingX, s.state.poseHeadingZ),
    ).toBeGreaterThanOrEqual(SOLO_HEADING_STABLE_MIN);
    expect(s.state.soloLatStartT).toBeGreaterThanOrEqual(0); // measuring
    expect(s.state.soloLatOffset).toBe(0); // dead-straight walk
    expect(s.state.soloLatBaseline).toBe(0);
    return s;
  }

  it("a drift to the walker's RIGHT reads positive (outbound +x leg)", () => {
    const s = warmedUp(1);
    // Drift +z (the right-hand side of a +x heading) while advancing.
    for (let j = 1; j <= 10; j++) {
      s.frame(
        (60 + j) * 50,
        0.05 + (60 + j) * 0.05,
        body(3.0 + 0.05 * j, 0.95, 0.01 * j),
      );
    }
    expect(s.state.soloLatOffset).toBeGreaterThan(0.05);
    expect(s.stats.liveLateralM).toBe(
      s.state.soloLatOffset - s.state.soloLatBaseline,
    );
    expect(s.stats.liveLateralM!).toBeGreaterThan(0.05);
    const final = s.stats.finalize(3.55) as WalkStats;
    expect(final.meanLateralM).not.toBeNull();
    expect(final.meanLateralM!).toBeGreaterThan(0);
  });

  it("the walker's right stays positive on a -x (return-direction) leg", () => {
    const s = warmedUp(-1);
    // Travel line -x; the walker's right is now -z.
    for (let j = 1; j <= 10; j++) {
      s.frame(
        (60 + j) * 50,
        0.05 + (60 + j) * 0.05,
        body(-3.0 - 0.05 * j, 0.95, -0.01 * j),
      );
    }
    expect(s.state.soloLatOffset).toBeGreaterThan(0.05);
    expect(s.stats.liveLateralM!).toBeGreaterThan(0.05);
  });

  it("no measurement before the heading stability gate opens", () => {
    const s = soloSession();
    // 10 frames is far short of the ~31 folds the 0.9 gate needs: the
    // channel must read UNMEASURED — pre-gate this warm-up integrated a
    // phantom sway-scale offset a clean walk carried forever.
    for (let i = 0; i < 10; i++) {
      s.frame(i * 50, 0.05 + i * 0.05, body(0.05 * i, 0.95, 0.002 * i));
    }
    expect(s.state.poseHeadingValid).toBe(true);
    expect(
      Math.hypot(s.state.poseHeadingX, s.state.poseHeadingZ),
    ).toBeLessThan(SOLO_HEADING_STABLE_MIN);
    expect(s.state.soloLatStartT).toBe(-1);
    expect(s.state.soloLatOffset).toBe(0);
    expect(s.stats.liveLateralM).toBeNull();
    const final = s.stats.finalize(0.5) as WalkStats;
    expect(final.meanLateralM).toBeNull();
  });

  it("the M4 score input stays the abs ankle offset (unchanged from web)", () => {
    // Same walk driven through both variants: poseLatEma (the M4 input) and
    // target[3] must be IDENTICAL — §3 redefines the lateral CHANNEL, not
    // the footwork score.
    const web = { state: new PoseDeriveState(), stats: new WalkStatsAccumulator(), target: new Float32Array(7) };
    const solo = soloSession();
    web.stats.reset(0.85);
    web.target.fill(62);
    web.state.reset();
    let lastT = -1;
    for (let i = 0; i < 20; i++) {
      const t = i * 50;
      const dt = lastT >= 0 ? (t - lastT) / 1000 : 0;
      lastT = t;
      const kps = body(0.05 * i, 0.95, 0.002 * i);
      deriveWorld(
        { t, source: "t", space: "world", keypoints: kps },
        dt,
        0.05 + i * 0.05,
        0.85,
        20,
        web.state,
        web.stats,
        web.target,
      );
      solo.frame(t, 0.05 + i * 0.05, kps);
    }
    expect(solo.state.poseLatEma).toBe(web.state.poseLatEma);
    expect(solo.target[3]).toBe(web.target[3]);
  });

  it("turn windows freeze the offset, dark the tap, and skip the mean", () => {
    const s = soloSession();
    for (let i = 0; i < 60; i++) {
      s.frame(i * 50, 0.05 + i * 0.05, body(0.05 * i, 0.95, 0));
    }
    const frozen = s.state.soloLatOffset;
    const preFinal = s.stats.finalize(3.0) as WalkStats;
    expect(preFinal.meanLateralM).not.toBeNull(); // channel was live
    // Five excluded frames with a violent sideways move: nothing may land.
    for (let j = 1; j <= 5; j++) {
      s.frame(
        (60 + j) * 50,
        0.05 + (60 + j) * 0.05,
        body(3.0 + 0.05 * j, 0.95, 0.05 * j),
        true, // turnExcluded
      );
    }
    expect(s.state.soloLatOffset).toBe(frozen); // integration frozen
    expect(s.stats.liveLateralM).toBeNull(); // channel not measured
    const midFinal = s.stats.finalize(3.25) as WalkStats;
    expect(midFinal.meanLateralM).toBe(preFinal.meanLateralM); // no samples
    // Resuming outside the window integrates again from the frozen value.
    s.frame(66 * 50, 0.05 + 66 * 0.05, body(3.3 + 0.05, 0.95, 0.25), false);
    expect(s.stats.liveLateralM).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §3 posture — signed hip-height drift vs the walk-start baseline.
// ---------------------------------------------------------------------------

describe("solo posture: hip-height drift, one quantity for score + copy", () => {
  it("baseline mirrors the head path (0.5 s average), dev is SIGNED, M1 is hand-derivable", () => {
    const s = soloSession();
    s.frame(0, 0.1, body(0, 0.95, 0));
    // First frame: baseline seeds to the hip height, dev 0, zero weight.
    expect(s.state.soloBaseSamples).toBe(1);
    expect(s.state.soloBaseY).toBe(0.95);
    expect(s.stats.livePostureM).toBe(0);

    s.frame(100, 0.2, body(0.1, 0.97, 0));
    // Still inside the 0.5 s window: the baseline is the running average.
    const baseY = (0.95 + 0.97) / 2;
    expect(s.state.soloBaseY).toBe(baseY);
    const dev1 = 0.97 - baseY;
    expect(s.stats.livePostureM).toBe(dev1);
    // |dev| EMA folds at rate 1.5 (the head path's law), M1 mirrors the
    // head-path curve shape with the re-derived slope.
    const ema1 = 0 + (Math.abs(dev1) - 0) * (1 - Math.exp(-1.5 * 0.1));
    expect(s.state.soloHipDevEma).toBe(ema1);
    expect(s.target[0]).toBe(Math.fround(100 - ema1 * SOLO_POSTURE_SLOPE));

    s.frame(200, 0.6, body(0.2, 0.95, 0));
    // Past the window: the baseline froze; the dev goes signed-negative.
    expect(s.state.soloBaseY).toBe(baseY);
    const dev2 = 0.95 - baseY;
    expect(dev2).toBeLessThan(0);
    expect(s.stats.livePostureM).toBe(dev2);
    // postureDriftM is the duration-weighted SIGNED mean of the same
    // quantity — score and spoken copy can never disagree (§3).
    const final = s.stats.finalize(0.6) as WalkStats;
    const drift = (dev1 * 0.1 + dev2 * 0.1) / 0.2;
    expect(final.postureDriftM).toBe(Math.round(drift * 1000) / 1000);
  });

  it("torso tilt does not feed solo M1 (shoulders may vanish freely)", () => {
    const withShoulders = soloSession();
    const without = soloSession();
    for (let i = 0; i < 20; i++) {
      const t = i * 50;
      const wt = 0.05 + i * 0.05;
      const full = body(0.05 * i, 0.95 + (i >= 10 ? -0.03 : 0), 0);
      const bare = { ...full };
      delete (bare as Record<string, PoseKeypoint>).leftShoulder;
      delete (bare as Record<string, PoseKeypoint>).rightShoulder;
      withShoulders.frame(t, wt, full);
      without.frame(t, wt, bare);
    }
    // M1 identical with and without shoulders: the solo channel is hips-only.
    expect(withShoulders.target[0]).toBe(without.target[0]);
    expect(withShoulders.state.soloHipDevEma).toBe(without.state.soloHipDevEma);
  });
});

// ---------------------------------------------------------------------------
// Per-walk lifecycle: reset clears, a tracking gap (resetCadence) survives.
// ---------------------------------------------------------------------------

describe("solo channel lifecycle", () => {
  it("resetCadence (a gap) keeps baseline/EMA/offset; reset() clears them", () => {
    const s = soloSession();
    for (let i = 0; i < 70; i++) {
      s.frame(i * 50, 0.05 + i * 0.05, body(0.05 * i, 0.96, 0.002 * i));
    }
    expect(s.state.soloLatStartT).toBeGreaterThanOrEqual(0); // channel engaged
    const kept = {
      baseY: s.state.soloBaseY,
      samples: s.state.soloBaseSamples,
      ema: s.state.soloHipDevEma,
      offset: s.state.soloLatOffset,
      latStartT: s.state.soloLatStartT,
      latBase: s.state.soloLatBaseline,
      latBaseSamples: s.state.soloLatBaseSamples,
    };
    expect(kept.samples).toBeGreaterThan(0);
    s.state.resetCadence();
    expect(s.state.soloBaseY).toBe(kept.baseY);
    expect(s.state.soloBaseSamples).toBe(kept.samples);
    expect(s.state.soloHipDevEma).toBe(kept.ema);
    expect(s.state.soloLatOffset).toBe(kept.offset);
    expect(s.state.soloLatStartT).toBe(kept.latStartT);
    expect(s.state.soloLatBaseline).toBe(kept.latBase);
    expect(s.state.soloLatBaseSamples).toBe(kept.latBaseSamples);
    s.state.reset();
    expect(s.state.soloBaseY).toBe(0);
    expect(s.state.soloBaseSamples).toBe(0);
    expect(s.state.soloHipDevEma).toBe(0);
    expect(s.state.soloLatOffset).toBe(0);
    expect(s.state.soloLatStartT).toBe(-1);
    expect(s.state.soloLatBaseline).toBe(0);
    expect(s.state.soloLatBaseSamples).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Analytic anchors + frame invariance over the solo tapes.
// ---------------------------------------------------------------------------

describe("solo tapes: analytic anchors", () => {
  const recs = new Map(
    buildSoloTapes().map((t) => [t.name, runTape(makeSoloSession, t)]),
  );

  it("clean line: lateral channels are EXACTLY zero, pace/posture analytic", () => {
    const final = recs.get("solo-clean-line")!.final as WalkStats;
    expect(final.meanLateralM).toBe(0);
    expect(final.meanAbsLateralM).toBe(0);
    expect(Math.abs(final.meanPaceMps! - 1.0)).toBeLessThan(0.02);
    expect(Math.abs(final.postureDriftM!)).toBeLessThan(0.005);
  });

  it("slouch: postureDriftM lands at the closed-form -0.025", () => {
    const final = recs.get("solo-slouch")!.final as WalkStats;
    // 3 s at baseline, 3 s exactly 5 cm below it -> time-weighted -0.025.
    expect(Math.abs(final.postureDriftM! - -0.025)).toBeLessThan(0.006);
    // And the M1 target sank with it.
    const rec = recs.get("solo-slouch")!;
    const at = (i: number) =>
      (rec.steps[i] as { targets: number[] }).targets[0];
    expect(at(rec.steps.length - 1)).toBeLessThan(at(85));
  });

  it("sway rides the abs mean, cancels in the signed mean (normal-walk)", () => {
    const final = recs.get("normal-walk")!.final as WalkStats;
    // 0.03 m sway: the abs mean lands at the pure-sway analytic 2A/pi
    // (~0.019 — the stability gate + baseline killed the warm-up artifact
    // that used to double it); the SIGNED mean cancels near 0.
    expect(final.meanAbsLateralM!).toBeGreaterThan(0.008);
    expect(final.meanAbsLateralM!).toBeLessThan(0.03);
    expect(Math.abs(final.meanLateralM!)).toBeLessThan(0.01);
    // …and the clean-walk M1 target sits at the derivation's predicted
    // 100 - 280 * (2 * bobAmp/pi) = 100 - 280 * 0.0127 ~ 96.4 (the
    // SOLO_POSTURE_SLOPE derivation, cross-checked by the walker itself).
    const rec = recs.get("normal-walk")!;
    const lastM1 = (rec.steps[rec.steps.length - 1] as { targets: number[] })
      .targets[0];
    expect(Math.abs(lastM1 - 96.4)).toBeLessThan(1.0);
  });

  it("turn exclusion keeps the out-and-back mean near zero", () => {
    const final = recs.get("solo-turn-exclusion")!.final as WalkStats;
    expect(final.meanLateralM).not.toBeNull();
    expect(Math.abs(final.meanLateralM!)).toBeLessThan(0.02);
  });

  it("the solo producer inherits the dt/anchor law (bail-dt-semantics)", () => {
    const final = recs.get("bail-dt-semantics")!.final as WalkStats;
    expect(Math.abs(final.meanPaceMps! - 1.1)).toBeLessThan(0.02);
    expect(final.postureDriftM).not.toBeNull();
    expect(final.meanLateralM).not.toBeNull();
  });
});

describe("solo tapes: frame invariance (the §6.4 honesty rule)", () => {
  const YAW = (RIGID_TRANSFORM.yawDeg * Math.PI) / 180;
  const COS = Math.cos(YAW);
  const SIN = Math.sin(YAW);
  const TR = RIGID_TRANSFORM.translate;
  const rigid = (k: PoseKeypoint): PoseKeypoint => ({
    x: COS * k.x + SIN * k.z + TR.x,
    y: k.y + TR.y,
    z: -SIN * k.x + COS * k.z + TR.z,
    score: k.score,
  });

  for (const tape of buildSoloTapes()) {
    it(`${tape.name}: identical under rigid yaw+translation`, () => {
      const twin = {
        ...tape,
        events: tape.events.map((ev) =>
          ev.kind === "frame"
            ? {
                ...ev,
                keypoints: Object.fromEntries(
                  Object.entries(ev.keypoints).map(([n, k]) => [n, rigid(k)]),
                ),
              }
            : ev,
        ),
      };
      const a = runTape(makeSoloSession, tape);
      const b = runTape(makeSoloSession, twin);
      const pick = (r: typeof a) => ({
        steps: r.steps.map((st) => ({
          targets: (st as { targets: number[] }).targets,
          live: (st as { live: unknown }).live,
        })),
        final: r.final,
      });
      expect(goldenDiff(pick(a), pick(b))).toBeNull();
    });
  }
});
