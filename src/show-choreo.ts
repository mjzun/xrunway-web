/**
 * (X)RUNWAY — pure show-choreography math (dependency-free — vitest-safe).
 *
 * The composition/timing logic behind the show's staged beats, extracted from
 * the Three-importing systems (stage.ts / shaders.ts) so the tests can lock
 * it (the stage-budget.ts pattern). Consumed by:
 *
 *   - StageMoodSystem (stage.ts): the FINALE beat envelope (#18) — when the
 *     trainee crosses the finish line the spotlight pulls onto them and the
 *     house lights swell, riding {@link finaleEnvelope} — and the idle
 *     spotlight sweep amplitude (#45), which now derives from the LIVE
 *     mapped runway length instead of the legacy 7 m constant.
 *   - ShaderTimeSystem (shaders.ts): the live floor's trainee-anchor marks
 *     (#45) — {@link floorAnchorUv} resolves the ACTUAL start line and pose
 *     mark of the compiled walk route into the unified floor's bbox-uv frame
 *     (they used to be compile-time constants derived from the default 7 m
 *     deck, in the LEGACY plane uv orientation — offset on any other length
 *     and pinned to the bbox axis on T/X/U).
 */

import { HOLD_RELEASE_SEC, HOLD_WINDOW_SEC } from "./hold-stats.js";
import { startAlong } from "./runway-layout.js";
import {
  compileShape,
  DEFAULT_SHAPE,
  routeToWorld,
  shapeFloorPlan,
  type SegmentedPath,
} from "./runway-shape.js";

/** Finale beat shape (s): snap on, hold the hero moment, ease back to house. */
export const FINALE_ATTACK_SEC = 0.12;
export const FINALE_HOLD_SEC = 2.4; // attack + hold (envelope stays at 1 until here)
export const FINALE_TOTAL_SEC = 4.0; // fully released — summary mood resumes

/**
 * The finale beat envelope, 0..1 over `t` seconds since the finish edge:
 * fast linear attack (the spot SNAPS to the trainee), a held hero beat, then
 * a linear release back into the regular summary mood. 0 outside [0, TOTAL].
 * Pure and allocation-free — evaluated per frame by StageMoodSystem.
 */
export function finaleEnvelope(t: number): number {
  if (t < 0 || t >= FINALE_TOTAL_SEC) {
    return 0;
  }
  if (t < FINALE_ATTACK_SEC) {
    return t / FINALE_ATTACK_SEC;
  }
  if (t <= FINALE_HOLD_SEC) {
    return 1;
  }
  return 1 - (t - FINALE_HOLD_SEC) / (FINALE_TOTAL_SEC - FINALE_HOLD_SEC);
}

/* ------------------------------------------------------------------------ */
/* M10 THE HOLD — presentation-layer math over the ONE hold accumulator.     */
/* The MEASUREMENT lives in hold-stats.ts (pure, ShowDirector-fed); these    */
/* are the stagecraft scalars its live outputs drive. Pure so the ramp and   */
/* the light-budget arithmetic are vitest-locked (the finaleEnvelope rule).  */
/* ------------------------------------------------------------------------ */

/**
 * Spot-cone tighten depth (rad) at full hold: the finale's own already-tuned
 * tighten quantum (stage.ts spot.angle carries `- 0.06 * finale`) reused —
 * the hold reads as "the finale look, earned early" rather than a new grammar.
 * Worst-case overlap (U route: the finale fires at window end while the
 * 0.6 s release still holds): 0.38 - (0.08 + 0.05*1)*1 - 0.06 - 0.06
 * = 0.13 rad > 0 — the cone never closes (pinned in show-choreo.test.ts).
 */
export const HOLD_SPOT_TIGHTEN = 0.06;

/**
 * House-light dim (absolute intensity) at full hold and full show energy:
 * at energy 1 the house sits at 0.5 - 0.32 = 0.18; one photographic stop is
 * a halving = 0.09 absolute. Scaled by energy at the consumer (idle/summary
 * untouched) and clamped >= 0 there — worst case without finale:
 * 0.18 - 0.09 = 0.09 > 0 (pinned in show-choreo.test.ts).
 */
export const HOLD_HOUSE_DIM = 0.09;

/**
 * Flash-storm floor at full MEASURED stillness (uBurst units): the flash
 * vertex shader treats b = 1 as the finale wall (gate scale 0.65 + 0.34*b
 * -> 0.99, shaders.ts FLASH_VERT); 0.7 keeps the sustained stillness storm
 * at gate scale 0.65 + 0.34*0.7 ~ 0.89 — visibly a storm, still below the
 * finish's full wall, so the finale remains the show's peak. HONESTY: this
 * is a disclosed REWARD MAPPING from a measured quantity (the hold's head
 * speed EMA — hold-stats.ts liveStill01); the disclosure line ships in
 * HOLD_EXPLAIN.
 */
export const HOLD_FLASH_MAX = 0.7;

/**
 * The published hold ramp, 0..1 over `t` seconds since the pose mark was
 * reached: rises linearly over the measured window (HOLD_WINDOW_SEC), then
 * releases linearly over HOLD_RELEASE_SEC — the spot target's exponential
 * smoothing settles to 95% in ~0.43 s (stage.ts k-rate 7 /s), so the 0.6 s
 * release makes the cone handback a driven ease, not a step. Presentation
 * only: the accumulator stopped measuring at HOLD_WINDOW_SEC regardless.
 * 0 for t <= 0, after the release, and for non-finite t (dark-frame law).
 */
export function holdRampT01(t: number): number {
  if (!(t > 0)) {
    return 0; // also NaN/-Infinity: a junk clock drives no light
  }
  if (t <= HOLD_WINDOW_SEC) {
    return t / HOLD_WINDOW_SEC;
  }
  const rel = 1 - (t - HOLD_WINDOW_SEC) / HOLD_RELEASE_SEC;
  return rel > 0 ? rel : 0;
}

/**
 * One frame of the hold channel's linear release: `value` stepped down by
 * `delta / HOLD_RELEASE_SEC`, floored at 0 — the SAME slope as holdRampT01's
 * release tail, so a channel released from ~1.0 reproduces that tail exactly.
 * Used by ShowDirector for the walk→summary handoff (a U-route finish and a
 * mid-hold timeout land in "summary" with t01 still high; hard-zeroing there
 * stepped the spot cone and popped the floor ring at the show's hero moment
 * — the HOLD_SPOT_TIGHTEN worst-case derivation above assumes this overlap
 * plays out). Junk-guarded like holdRampT01: a non-finite value or delta
 * drives no light (returns 0).
 */
export function holdReleaseStep(value: number, delta: number): number {
  const next = value - delta / HOLD_RELEASE_SEC;
  return next > 0 && Number.isFinite(next) ? next : 0;
}

/* ------------------------------------------------------------------------ */
/* #45 — choreography scales with the MAPPED runway (7 m default preserved).  */
/* ------------------------------------------------------------------------ */

/** The idle spotlight's "elegant sweep" spans this fraction of the runway
 * length — the SAME 0.33 the legacy hard-coded `STAGE.deckLength * 0.33`
 * used, so the default 7 m deck sweeps byte-identically. */
export const IDLE_SWEEP_FRAC = 0.33;

/** Idle-sweep amplitude (m) for the live spine length: ±amplitude around the
 * runway-local origin. 7 m → ±2.31 m (legacy-identical); a 60 m mapped
 * runway sweeps its whole deck instead of hovering over a central patch. */
export function idleSweepAmplitude(spineLength: number): number {
  return spineLength * IDLE_SWEEP_FRAC;
}

/** The live floor's trainee-anchor marks in the unified floor's bbox-uv frame
 * (x: 0..1 across plan.width, y: 0..1 along plan.length — the exact space
 * createUnifiedFloorGeometry writes into `uv` and uStepA/uStepX use). */
export interface FloorAnchors {
  startX: number;
  startY: number;
  poseX: number;
  poseY: number;
}

/**
 * Resolve the compiled walk route's START LINE and POSE MARK into the unified
 * floor's bbox-uv frame — the anchors the floor shader's resting glow +
 * trainee lock-on use ({@link FloorAnchors} feed uAnchorStart/uAnchorPose).
 *
 * Route-aware: on a U the pose mark lands on legB (off the bbox centerline),
 * so the anchors are full 2-D uv points, not axis fractions. Placement-
 * invariant (the stage root carries world position/yaw). Called once per
 * remap — never per frame.
 */
export function floorAnchorUv(path: SegmentedPath): FloorAnchors {
  const plan = shapeFloorPlan(path);
  const root = path.segments[0].rect;
  const cs = Math.cos(root.yaw);
  const sn = Math.sin(root.yaw);
  const w = plan.width || 1;
  const l = plan.length || 1;
  // World → stage-root-local (the shapeFloorPlan frame) → bbox uv.
  const uvX = (wx: number, wz: number): number => {
    const dx = wx - root.centerX;
    const dz = wz - root.centerZ;
    return (dx * cs - dz * sn - plan.minX) / w;
  };
  const uvY = (wx: number, wz: number): number => {
    const dx = wx - root.centerX;
    const dz = wz - root.centerZ;
    return (dx * sn + dz * cs - plan.minZ) / l;
  };
  const s = routeToWorld(path, startAlong(), 0);
  const p = routeToWorld(path, path.poseRouteAlong, 0);
  return {
    startX: uvX(s.x, s.z),
    startY: uvY(s.x, s.z),
    poseX: uvX(p.x, p.z),
    poseY: uvY(p.x, p.z),
  };
}

/** The default 7 m straight deck's anchors — the floor material's uniform
 * seeds, so a world without a compiledPath signal (tests / partial worlds)
 * rests the glow exactly on the classic start line. */
export const DEFAULT_FLOOR_ANCHORS: FloorAnchors = floorAnchorUv(
  compileShape(DEFAULT_SHAPE),
);
