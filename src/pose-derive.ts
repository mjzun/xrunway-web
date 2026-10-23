/**
 * (X)RUNWAY — pose-derive: the WORLD-SPACE (native ARKit) scoring core,
 * extracted VERBATIM from MetricsSystem.deriveFromPoseWorld (metrics.ts).
 *
 * WHY THIS FILE EXISTS (SOLO-MODE.md §6.2): the world-pose derivation is the
 * exact function Solo mode ports to Swift, so the golden-vector generator and
 * vitest must import the REAL code instead of replicating it (the
 * test/pose-derive-demo.mjs replica-drift problem). MetricsSystem is coupled
 * to @iwsdk/core and cannot load in node; this module is dependency-free by
 * design — no @iwsdk/core, no DOM, type-only imports — the walk-stats.ts
 * pattern, so it loads standalone in node/vitest.
 *
 * Split of responsibilities:
 * - This module owns the per-frame WORLD derivation (`deriveWorld`) and every
 *   piece of mutable state it reads/writes (`PoseDeriveState`), INCLUDING the
 *   step-interval ring buffer. The ring is deliberately part of this state
 *   object even though the head/image paths in metrics.ts feed it too: all
 *   three derivation paths must share ONE ring (a source handoff clears it for
 *   all of them via resetCadence), so it lives with the state MetricsSystem
 *   already owns and hands to this module, and the other paths reach it
 *   through that same object.
 * - MetricsSystem (metrics.ts) keeps the system wiring: source arbitration and
 *   fresh-frame gating (poseLastT), the walk clock (walkTime) and the per-run
 *   idealPace (both shared with the head path, so they stay system fields and
 *   are passed in per call), display smoothing/ramp, the ~6 Hz publish, and
 *   the head/image derivations.
 * - The stats accumulator (globals.walkStats) is PASSED IN, never imported —
 *   `PoseDeriveStats` is the structural surface WalkStatsAccumulator already
 *   satisfies.
 *
 * Zero per-frame allocation preserved: all scratch state lives in
 * PoseDeriveState (allocated once), and deriveWorld is pure scalar math
 * writing into the caller's preallocated Float32Array target.
 */

import type { PoseFrame, PoseKeypoint } from "./external-tracker.js";

// ---------------------------------------------------------------------------
// Tuning shared by all three derivation paths (moved verbatim from metrics.ts).
// ---------------------------------------------------------------------------

export const SCORE_MIN = 40;
/** 100 (was 98) — the perfect=100 rescale (founder ruling 2026-07-09): every
 * channel anchor moved to 100 so a perfect walk reads a clean 100, never a
 * "random number in the 90s". Slopes and SCORE_MIN are UNCHANGED — only the
 * anchors moved (+4/+5), so every physical sensitivity survives. */
export const SCORE_MAX = 100;

/** The ruler stamp minted into every history row scored by THIS engine.
 * Rows persisted before the perfect=100 rescale carry no stamp and read
 * "s98.v1" via session-grading's rowScoreScale — old-ruler rows never blend
 * into PB / benchmark / trends / deltaVsLast comparisons (the normalization
 * -stamp idiom applied to the scale itself). Bumped to v3 by PACE Part B
 * (the asymmetric control band, founder go 2026-07-16): every pace score
 * moved, so v2 rows are an old ruler too. */
export const SCORE_SCALE_STAMP = "s100-pb.v3";

/**
 * PACE Part B — the asymmetric control band (docs/PACE-RECONCILE.md, founder
 * go 2026-07-16). The old symmetric proximity score `100 - |v - t| * 70`
 * punished the taught long confident stride exactly as hard as timid slow
 * walking. Now: full credit inside a comfortable band around the target;
 * beyond it, slow costs ~2x what fast does. ONE shared mapping for every
 * pace site (head path in metrics.ts, world/solo paths here, the Swift
 * mirror) — never re-derive it inline.
 */
export const PACE_BAND_MPS = 0.1;
export const PACE_K_SLOW = 90;
export const PACE_K_FAST = 45;

/** Runtime band overrides (the pace-style pref, 2026-07-18): the trainee can
 * flip which side is forgiven (a director's "take your time" swaps the
 * slopes) and widen/narrow the band through the quiet ADVANCED control.
 * Omitted -> the Part B constants, byte-identical (golden-safe). Resolved
 * from prefs by pace-prefs.ts and LATCHED once per run at walk start. */
export interface PaceBandOpts {
  band: number;
  kSlow: number;
  kFast: number;
}

export const DEFAULT_PACE_OPTS: PaceBandOpts = {
  band: PACE_BAND_MPS,
  kSlow: PACE_K_SLOW,
  kFast: PACE_K_FAST,
};

/** The pace score BEFORE clamping (callers clamp like every other channel). */
export function paceBandScore(
  speed: number,
  idealPace: number,
  opts: PaceBandOpts = DEFAULT_PACE_OPTS,
): number {
  const d = speed - idealPace;
  if (d > opts.band) return 100 - (d - opts.band) * opts.kFast;
  if (d < -opts.band) return 100 - (-d - opts.band) * opts.kSlow;
  return 100;
}

/** Plausible step-interval window (s). */
export const STEP_MIN = 0.15;
export const STEP_MAX = 1.2;
export const RING_SIZE = 8;

export function clampScore(v: number): number {
  return v < SCORE_MIN ? SCORE_MIN : v > SCORE_MAX ? SCORE_MAX : v;
}

/**
 * SOLO M1 slope — the §3 posture redefinition's score mapping, DERIVED (the
 * SOLO-MODE §5 rule: never a copied magic number):
 *
 * The head path anchors its curve `100 - heightDevEma * 350` at two points
 * (anchor 96 -> 100 in the perfect=100 rescale; the SLOPE never moved):
 * a clean walk (natural head bob folds to a ~1.0 cm |dev| EMA) scores
 * ~96.5, and the curve crossed the LOWEST pass bar (75, modes.ts) at
 * dev = 21/350 = 0.06 m under the old 96 anchor — which is where
 * POSTURE_CUE_M was set. POST-RESCALE the cue gates (POSTURE_CUE_M 0.06,
 * SOLO_POSTURE_CUE_M 0.075) are TUNED PHYSICAL VALUES: the score-bar
 * derivation is retired; with the +4 anchor shift the cues now fire
 * slightly BEFORE the bar-crossing (the safe direction — coaching leads
 * the verdict). Solo M1 mirrors the SHAPE onto the hip
 * (100 - soloHipDevEma * K), but the hip channel's clean-walk noise is
 * larger: gait bobs the hip ~2 cm (amplitude A = 0.02 m — the same bob the
 * rhythm channel's TH = 0.008 m was tuned against; mean |A sin| = 2A/pi ~
 * 1.27 cm) where the damped head bobs ~1 cm. Keeping the clean-walk score
 * equal re-derived the slope: K = 350 * (0.010 / 0.0127) = 275.6, rounded
 * to 280. Cross-check: clean walk scores 100 - 280*0.0127 = 96.4
 * (head: 96.5).
 */
export const SOLO_POSTURE_SLOPE = 280;

/**
 * SOLO lateral needs a STABLE travel line before the hip-path offset may
 * integrate. The heading EMA folds UNIT displacement directions, so its
 * magnitude is its own confidence: 1 = perfectly steady travel, warm-up
 * starts at 0, and a mid-walk reversal pulls it through 0 while the old and
 * new directions cancel. Gating at 0.9 (recent directions agree within
 * ~25 deg) keeps the warm-up direction error out of the offset integral —
 * without it, the first ~1.5 s of heading convergence integrated a phantom
 * ~sway-amplitude DC offset that a clean walk carried forever — and it
 * self-excludes turns even when the caller's turnExcluded flag is late.
 */
export const SOLO_HEADING_STABLE_MIN = 0.9;

/**
 * SOLO lateral baseline window (s): the reported offset is the raw integral
 * minus its own running mean over the first second of measurement — the
 * posture walk-start-baseline law mirrored onto the lateral channel. The
 * integral's zero is the hip position at measurement start, an ARBITRARY
 * sway phase (+-swayAmp); averaging over one full sway period (~1.1 s at a
 * 1.8 Hz gait) re-centers the reference on the sway MEAN, so a clean walk
 * reads ~0 instead of the sway phase it happened to start on.
 */
export const SOLO_LATERAL_BASELINE_SEC = 1.0;

/**
 * SOLO §2 gap rule (s): any inter-frame gap above this — or any interval
 * where framing is not good — contributes ZERO stats weight. The caller
 * (the Solo engine loop) calls resetCadence() and re-arms its fresh-frame
 * gate, so the first frame after the gap RE-SEEDS the hip anchor instead of
 * differencing across the outage (which would credit the whole unobserved
 * displacement to one frame). BELOW this bound the posePendingDt anchor law
 * already measures hiccups correctly (full gap displacement / full gap
 * time), so brief capture stalls cost nothing. 0.6 s is chosen against the
 * capture physics, not the math: a healthy ARKit body stream never gaps
 * beyond a few frames (~0.05 s at 60 Hz), while a real occlusion or an
 * anchor re-lock (walker out of frame, passer-by steal) keeps the anchor
 * dark for ~0.5 s+ — and 0.6 s of unobserved walking is also half a
 * slowest-counted stride (STEP_MAX 1.2 s), so the bob/cadence trackers have
 * provably missed structure and must re-seed rather than interpolate.
 */
export const SOLO_GAP_SEC = 0.6;

/**
 * SOLO §3 turn-window exclusion (s): the engine flags `turnExcluded` for
 * this long after each detected travel reversal, freezing the lateral
 * integral (soloDeriveWorld). Derivation: the reversal mark lands mid-turn,
 * where the heading EMA has collapsed toward 0; regrowing from 0 to the
 * SOLO_HEADING_STABLE_MIN bar under the heading fold rate (1.5) takes
 * -ln(1 - 0.9) / 1.5 = ln(10) / 1.5 ~ 1.5 s — so the flag and the stability
 * gate agree on the window. Both exist on purpose (§3): the gate is the
 * belt (it self-excludes even a missed mark), the caller window the
 * suspenders (a fast snap turn can swing the heading without ever pulling
 * the EMA magnitude under the bar, and the flag still freezes it).
 */
export const SOLO_TURN_EXCLUDE_SEC = 1.5;

/**
 * Keypoint with a usable confidence AND finite coordinates, else null.
 * Hoisted to avoid a per-frame closure.
 *
 * Coordinate finiteness is part of the ACCEPTANCE gate, not a downstream
 * repair: a keypoint whose x/y/z is NaN/Infinity is not a measurement, so it
 * is treated exactly like a low-score one — absent — and the existing
 * single-hip / sparse-keypoint fallbacks own the frame. Pre-gate, a junk
 * ARKit hip with a healthy score folded NaN into the speed/upright/bob EMAs
 * PERMANENTLY (NaN never leaves an `ema += (v - ema) * a` fold), clampScore
 * passed the NaN through to the published targets, and the live pace tap
 * (stats.livePaceMps) went NaN for the rest of the walk. Both skeleton paths
 * (world here, image in metrics.ts deriveFromPose) read keypoints through
 * this ONE gate, so both are protected by it.
 */
export function kpOk(
  kp: Record<string, PoseKeypoint>,
  n: string,
): PoseKeypoint | null {
  const k = kp[n];
  return k &&
    k.score >= 0.3 &&
    Number.isFinite(k.x) &&
    Number.isFinite(k.y) &&
    Number.isFinite(k.z)
    ? k
    : null;
}

/**
 * The stats taps the world path feeds — the exact WalkStatsAccumulator surface
 * it needs (walk-stats.ts satisfies this structurally). Passed in per call so
 * this module never imports the accumulator.
 */
export interface PoseDeriveStats {
  livePaceMps: number | null;
  liveLateralM: number | null;
  livePostureM: number | null;
  noteSource(source: "camera-world", dtSec: number): void;
  addPace(speedMps: number, dtSec: number): void;
  addStep(atSec: number): void;
  /** Fed by the SOLO variant only (§3 redefined channels — signed hip-path
   *  offset / signed hip-height drift). The web path leaves them dark. */
  addLateral(lateralM: number, dtSec: number): void;
  addPosture(deviationM: number, dtSec: number): void;
}

/**
 * All mutable pose-stream derivation state, extracted from MetricsSystem's
 * pose* instance fields (names and initializers kept verbatim so the
 * extraction stays a mechanical move). MetricsSystem owns ONE instance:
 * deriveWorld mutates it per fresh world frame, metrics.ts's image path
 * shares the same EMAs/bob trackers (a mid-walk world<->image space switch
 * keeps today's carry-over semantics), and the head path shares the interval
 * ring inside it.
 */
export class PoseDeriveState {
  posePrevHipX = 0;
  posePrevHipZ = 0; // world path only
  poseHavePrev = false;
  poseSpeedEma = 0;
  poseLatEma = 0;
  poseUprightEma = 0.92;
  poseHeadingX = 0; // world path: smoothed travel direction
  poseHeadingZ = -1;
  poseBobBaseline = 0;
  poseBobHavePrev = false;
  poseBobSign = 0;
  poseLastCross = -1;
  /** True once the world-pose travel heading has integrated real motion; until
   *  then footwork lateral isn't measured (no valid travel line in ARKit space). */
  poseHeadingValid = false;

  /**
   * THE ANCHOR OWNS ITS TIMESTAMP (the dt/anchor law). Pose-stream seconds
   * that have elapsed since the frame that set the hip anchor but have NOT
   * yet been folded into a measurement — accumulated by bail frames (no
   * usable hip), zeroed by every measuring frame. A clean frame measures over
   * `span = delta + posePendingDt`, i.e. exactly `now - anchorTimestamp`, so
   * a bail frame can never desync the anchor from the dt that divides its
   * displacement: recovery after N dark frames divides the FULL gap
   * displacement by the FULL gap time (pre-fix it divided N+1 intervals of
   * displacement by ONE interval — a (N+1)x pace spike into the EMA and the
   * persisted meanPaceMps). A REAL outage still re-seeds with zero weight:
   * reset()/resetCadence() clear this along with the anchor (the §2 gap
   * rule) — the span math applies only WITHIN a walk's tolerated bails.
   */
  posePendingDt = 0;

  // -- SOLO-only channels (§3 redefinitions) — untouched by the web path. ----

  /** Hip-height baseline vs which the SOLO M1 drift is signed: averaged over
   *  the first 0.5 s of the walk, the head path's baselineY law mirrored
   *  onto the hip. Per-WALK quantities: reset() clears them, resetCadence()
   *  (a tracking gap) deliberately does NOT — the baseline, the drift EMA
   *  and the accumulated lateral offset survive an outage, like the EMAs. */
  soloBaseY = 0;
  soloBaseAcc = 0;
  soloBaseSamples = 0;
  /** EMA of |hip-height dev| feeding the SOLO M1 score (rate 1.5 — the head
   *  path's heightDevEma law). */
  soloHipDevEma = 0;
  /** SIGNED perpendicular offset of the hip path from the walker's own
   *  travel line, integrated from per-frame hip displacement projected on
   *  the heading's right-hand perpendicular (+ = the walker's RIGHT relative
   *  to travel — the sign does NOT flip meaning at a turn, §3). Integrates
   *  only while the heading is STABLE (SOLO_HEADING_STABLE_MIN) and the
   *  caller flags no turn window; the REPORTED offset subtracts the
   *  baseline below. */
  soloLatOffset = 0;
  /** walkTime when lateral measurement first engaged (-1 = not yet). */
  soloLatStartT = -1;
  /** Running mean of the raw integral over its first
   *  SOLO_LATERAL_BASELINE_SEC of measurement — the offset's reference
   *  (see the constant's derivation). */
  soloLatBaseline = 0;
  soloLatBaseAcc = 0;
  soloLatBaseSamples = 0;

  /** Ring buffer of bob-crossing (step) intervals — SHARED by all three
   *  derivation paths (world here; head/image in metrics.ts) so one
   *  resetCadence clears cadence for all of them. */
  readonly intervals = new Float32Array(RING_SIZE);
  intervalIdx = 0;
  intervalCount = 0;

  /** Per-walk reset — the pose-state half of MetricsSystem.beginWalkTracking
   *  (values verbatim from metrics.ts). */
  reset(): void {
    this.poseHavePrev = false;
    this.posePrevHipX = 0;
    this.posePrevHipZ = 0;
    this.poseSpeedEma = 0;
    this.poseLatEma = 0;
    this.poseUprightEma = 0.92;
    // Do NOT seed the heading from layoutYaw: the streamed world keypoints are in
    // the iPhone's ARKit frame (unregistered to the headset runway frame), so the
    // runway yaw is meaningless here. Start neutral and only measure footwork once
    // the heading EMA has integrated real travel (poseHeadingValid).
    this.poseHeadingX = 0;
    this.poseHeadingZ = 0;
    this.poseHeadingValid = false;
    this.poseBobHavePrev = false;
    this.poseBobBaseline = 0;
    this.poseBobSign = 0;
    this.poseLastCross = -1;
    this.posePendingDt = 0;
    this.soloBaseY = 0;
    this.soloBaseAcc = 0;
    this.soloBaseSamples = 0;
    this.soloHipDevEma = 0;
    this.soloLatOffset = 0;
    this.soloLatStartT = -1;
    this.soloLatBaseline = 0;
    this.soloLatBaseAcc = 0;
    this.soloLatBaseSamples = 0;
    this.intervalIdx = 0;
    this.intervalCount = 0;
  }

  /**
   * The pose-state half of MetricsSystem.resetCadence (camera<->head source
   * handoff): clear the shared interval ring and the bob trackers, and drop
   * the hip anchor so the first frame after a handoff carries ZERO stats
   * weight and re-seeds instead of differencing across the gap. metrics.ts
   * resets its own head-path crossing fields and the poseLastT frame gate
   * alongside this call.
   */
  resetCadence(): void {
    this.intervalIdx = 0;
    this.intervalCount = 0;
    this.poseBobSign = 0;
    this.poseLastCross = -1;
    this.poseBobHavePrev = false;
    this.poseHavePrev = false;
    // The anchor is gone, so the time owed to it is too — a resumed stream
    // re-seeds with ZERO weight instead of measuring across the outage.
    this.posePendingDt = 0;
  }
}

// ---------------------------------------------------------------------------
// The WORLD-SPACE (native ARKit) derivation.
// ---------------------------------------------------------------------------

/**
 * Derive quality scores from a streamed skeleton in WORLD meters (native
 * ARKit body tracking — Y up, gravity aligned). This is REAL data, not a
 * proxy: pace is true m/s, posture is true torso tilt, footwork is the
 * lateral deviation of each footfall from the line of travel, rhythm is the
 * hip-bob cadence. Fills target[]; zero allocation.
 *
 * Body moved VERBATIM from MetricsSystem.deriveFromPoseWorld, plus the
 * dt/anchor law (see PoseDeriveState.posePendingDt): the hip anchor owns its
 * timestamp, a bail frame banks its dt instead of measuring, and the next
 * clean frame measures over the FULL time back to the anchor. The caller
 * supplies the system-owned inputs: `delta` is the TRUE inter-pose interval
 * (poseDt — metrics.ts gates on frame.t), `walkTime` the seconds since walk
 * start, `idealPace` the mode's per-run ideal pace, plus its PoseDeriveState,
 * the stats accumulator, and the 7-slot raw target array (METRICS order:
 * posture, pace, rhythm, footPlacement, presence, confidence, presentation).
 *
 * Returns TRUE when the derivation ran to completion (target[] holds a
 * fresh legacy composite), FALSE on the both-hips-missing bail (no targets
 * written) — the deriveFromHead §B contract mirrored onto the pose paths:
 * the wiring's presence-blend latch must only capture target[4] on frames
 * a derive path actually WROTE it, or a fresh-but-hipless camera stream
 * latches an already-blended value and the blend compounds toward pure
 * carriageScore (the §B read-modify-write this return exists to prevent).
 */
function deriveWorldImpl(
  frame: PoseFrame,
  delta: number,
  walkTime: number,
  idealPace: number,
  rampSeconds: number,
  state: PoseDeriveState,
  stats: PoseDeriveStats,
  target: Float32Array,
  solo: boolean,
  turnExcluded: boolean,
  paceOpts: PaceBandOpts = DEFAULT_PACE_OPTS,
): boolean {
  // Delta is a CALLER-supplied input on the port surface: a non-finite or
  // non-positive value is not a time interval, so it is treated as 0 — a
  // dark frame. Every EMA alpha becomes 1-exp(0) = 0 (all EMAs hold), the
  // bob seed and hip-anchor updates still occur, and walk-stats already
  // rejects dtSec <= 0 — mirroring its !(dtSec > 0) convention. Without
  // this, one NaN delta made poseBobBaseline/poseUprightEma NaN FOREVER
  // (NaN never leaves an `ema += (v - ema) * a` fold).
  if (!(Number.isFinite(delta) && delta > 0)) delta = 0;
  // Camera-world owns this stretch of the walk. Its pace is TRUE m/s and
  // feeds the stats below. The lateral/posture taps default DARK each frame:
  // on the WEB path they stay dark (the centerline channel is head-path-only
  // — the iPhone's ARKit frame is unregistered to the mapped runway — and
  // camera-world posture is torso TILT, a different quantity than the tap
  // documents, #12); the SOLO variant OWNS both channels (§3 redefinitions)
  // and overwrites the taps below on every frame it actually measures.
  stats.noteSource("camera-world", delta);
  stats.liveLateralM = null;
  stats.livePostureM = null;
  const kp = frame.keypoints;
  const lh = kpOk(kp, "leftHip");
  const rh = kpOk(kp, "rightHip");
  if (!lh && !rh) {
    // Bail: a dark frame. The hip anchor AND its timestamp hold untouched —
    // only the elapsed time is banked, so the next measuring frame divides
    // the FULL gap displacement by the FULL gap time (see posePendingDt).
    // No targets written -> derived=false (§B: the blend latch holds).
    state.posePendingDt += delta;
    return false;
  }
  // The true measurement interval: now - the anchor frame's timestamp. Every
  // EMA below folds over `span` — the physical seconds since the last fold.
  const span = delta + state.posePendingDt;
  state.posePendingDt = 0;
  // Single-hip fallback (defensive; ARKit normally backfills both from .root).
  const hip = (lh ?? rh)!;
  const hx = lh && rh ? (lh.x + rh.x) * 0.5 : hip.x;
  const hy = lh && rh ? (lh.y + rh.y) * 0.5 : hip.y;
  const hz = lh && rh ? (lh.z + rh.z) * 0.5 : hip.z;
  const ls = kpOk(kp, "leftShoulder");
  const rs = kpOk(kp, "rightShoulder");
  const la = kpOk(kp, "leftAnkle");
  const ra = kpOk(kp, "rightAnkle");

  if (state.poseHavePrev && span > 0) {
    const dx = hx - state.posePrevHipX;
    const dz = hz - state.posePrevHipZ;
    const mag = Math.hypot(dx, dz);

    // Pace — true horizontal world speed (m/s), vs the ideal catwalk pace.
    let speed = mag / span;
    if (speed > 4) speed = 4;
    stats.addPace(speed, span); // true m/s, pre-score-mapping (#12)
    state.poseSpeedEma += (speed - state.poseSpeedEma) * (1 - Math.exp(-2 * span));
    stats.livePaceMps = state.poseSpeedEma;

    // Heading — smoothed travel direction (only when actually moving). The
    // first measured motion makes the heading (and thus footwork) valid.
    if (mag > 1e-4) {
      const a = 1 - Math.exp(-1.5 * span);
      state.poseHeadingX += (dx / mag - state.poseHeadingX) * a;
      state.poseHeadingZ += (dz / mag - state.poseHeadingZ) * a;
      state.poseHeadingValid = true;
    }

    // Foot placement — lateral distance of each ankle from the travel line
    // (perpendicular to heading). Only once a real travel line exists: the
    // heading lives in the iPhone's ARKit frame, so it must come from measured
    // motion, never a seed, or we'd project against a meaningless direction.
    if (state.poseHeadingValid) {
      const hraw = Math.hypot(state.poseHeadingX, state.poseHeadingZ);
      const hmag = hraw || 1;
      const hxn = state.poseHeadingX / hmag;
      const hzn = state.poseHeadingZ / hmag;
      let lat = 0;
      let n = 0;
      if (la) {
        lat += Math.abs((la.x - hx) * -hzn + (la.z - hz) * hxn);
        n++;
      }
      if (ra) {
        lat += Math.abs((ra.x - hx) * -hzn + (ra.z - hz) * hxn);
        n++;
      }
      if (n > 0) {
        lat /= n;
        state.poseLatEma += (lat - state.poseLatEma) * (1 - Math.exp(-1.5 * span));
      }

      // SOLO lateral (§3): the SIGNED perpendicular offset of the HIP path
      // from the walker's own travel line — this frame's hip displacement
      // projected on the heading's right-hand perpendicular (-hzn, hxn),
      // integrated (+ = the walker's right relative to travel; the sign
      // keeps its meaning across a turn). The M4 SCORE stays on the abs
      // ankle offset above — §3 keeps them distinct on purpose. Measurement
      // needs a STABLE heading (SOLO_HEADING_STABLE_MIN — warm-up and turns
      // self-exclude) and no caller-flagged turn window; while unmeasured,
      // the offset FREEZES and the live tap stays dark. The reported offset
      // is the raw integral re-centered on its own first-second mean
      // (SOLO_LATERAL_BASELINE_SEC — the posture-baseline law mirrored).
      if (solo && !turnExcluded && hraw >= SOLO_HEADING_STABLE_MIN) {
        state.soloLatOffset += dx * -hzn + dz * hxn;
        if (state.soloLatStartT < 0) state.soloLatStartT = walkTime;
        if (
          walkTime - state.soloLatStartT < SOLO_LATERAL_BASELINE_SEC ||
          state.soloLatBaseSamples === 0
        ) {
          state.soloLatBaseAcc += state.soloLatOffset;
          state.soloLatBaseSamples++;
          state.soloLatBaseline =
            state.soloLatBaseAcc / state.soloLatBaseSamples;
        }
        const offset = state.soloLatOffset - state.soloLatBaseline;
        stats.addLateral(offset, span);
        stats.liveLateralM = offset;
      }
    }
  }
  state.posePrevHipX = hx;
  state.posePrevHipZ = hz;
  state.poseHavePrev = true;

  if (solo) {
    // SOLO posture (§3, decision made): SIGNED hip-height drift vs the
    // walk-start baseline — ONE quantity feeding the M1 score, the live cue
    // channel AND postureDriftM, so the score and the spoken copy can never
    // disagree. The baseline mirrors the head path's law: averaged over the
    // first 0.5 s of the walk (seeded by the first usable frame if none
    // landed inside the window). Torso tilt is deliberately NOT used in v1.
    if (walkTime < 0.5 || state.soloBaseSamples === 0) {
      state.soloBaseAcc += hy;
      state.soloBaseSamples++;
      state.soloBaseY = state.soloBaseAcc / state.soloBaseSamples;
    }
    const devSigned = hy - state.soloBaseY;
    stats.addPosture(devSigned, span);
    stats.livePostureM = devSigned;
    const dev = devSigned < 0 ? -devSigned : devSigned;
    state.soloHipDevEma +=
      (dev - state.soloHipDevEma) * (1 - Math.exp(-1.5 * span));
  } else if (ls && rs) {
    // WEB posture — true torso tilt: |vertical| / length of shoulder->hip.
    const vx = (ls.x + rs.x) * 0.5 - hx;
    const vy = (ls.y + rs.y) * 0.5 - hy;
    const vz = (ls.z + rs.z) * 0.5 - hz;
    const len = Math.hypot(vx, vy, vz) || 1e-3;
    const upright = Math.abs(vy) / len; // 1 = perfectly vertical
    state.poseUprightEma +=
      (upright - state.poseUprightEma) * (1 - Math.exp(-1.5 * span));
  }

  // Rhythm — hip vertical-bob cadence (one up-crossing per stride).
  if (!state.poseBobHavePrev) {
    state.poseBobBaseline = hy;
    state.poseBobHavePrev = true;
  }
  state.poseBobBaseline +=
    (hy - state.poseBobBaseline) * (1 - Math.exp(-1.2 * span));
  const dev = hy - state.poseBobBaseline;
  const TH = 0.008; // world meters
  if (dev > TH && state.poseBobSign <= 0) {
    state.poseBobSign = 1;
    stats.addStep(walkTime); // every real strike counts (#22)
    if (state.poseLastCross >= 0) {
      const interval = walkTime - state.poseLastCross;
      if (interval >= STEP_MIN && interval <= STEP_MAX) {
        state.intervals[state.intervalIdx] = interval;
        state.intervalIdx = (state.intervalIdx + 1) % RING_SIZE;
        if (state.intervalCount < RING_SIZE) state.intervalCount++;
      }
    }
    state.poseLastCross = walkTime;
  } else if (dev < -TH && state.poseBobSign >= 0) {
    state.poseBobSign = -1;
  }

  // Scores (true-metric mappings).
  const pace =
    state.poseSpeedEma < 0.05
      ? 44
      : paceBandScore(state.poseSpeedEma, idealPace, paceOpts);

  let rhythm = 58;
  if (state.intervalCount >= 3) {
    let mean = 0;
    for (let i = 0; i < state.intervalCount; i++) mean += state.intervals[i];
    mean /= state.intervalCount;
    let mad = 0;
    for (let i = 0; i < state.intervalCount; i++) {
      mad += Math.abs(state.intervals[i] - mean);
    }
    mad /= state.intervalCount;
    const cv = mean > 0 ? mad / mean : 1;
    rhythm = 100 - cv * 220;
  }

  // WEB: upright torso ~0.97-1.0; a visible lean drops toward 0.90.
  // SOLO: the head-path curve shape mirrored onto the hip-drift channel,
  // slope re-derived (SOLO_POSTURE_SLOPE — see its derivation above).
  const posture = solo
    ? 100 - state.soloHipDevEma * SOLO_POSTURE_SLOPE
    : 40 + ((state.poseUprightEma - 0.9) / 0.09) * 60;
  const footPlacement = 100 - state.poseLatEma * 240;

  const cPace = clampScore(pace);
  const cRhythm = clampScore(rhythm);
  const cPosture = clampScore(posture);
  const cFoot = clampScore(footPlacement);

  // Session ramp over the LOCKED walk duration (perfect=100 rescale): the
  // confidence ramp used to cap at a hard 45 s no walk could reach (every
  // mode locks 20 s; the duration wave allows 10-60 s), silently denying a
  // perfect walk its 100. rampSeconds is the run's locked walkSeconds —
  // junk-guarded to 1 (full ramp) so a bad caller can never wedge NaN in.
  const sessionRamp =
    Number.isFinite(rampSeconds) && rampSeconds > 0
      ? Math.min(walkTime / rampSeconds, 1)
      : 1;
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

  target[0] = posture;
  target[1] = pace;
  target[2] = rhythm;
  target[3] = footPlacement;
  target[4] = presence;
  target[5] = confidence;
  target[6] = presentation;
  return true; // full derivation ran (§B)
}

/** The WEB world derivation — MetricsSystem's camera-world path, behavior
 *  unchanged: torso-tilt M1, lateral/posture live taps honest-dark.
 *  Returns the §B wrote-targets fact (true = target[] holds a fresh legacy
 *  composite; false = the both-hips bail — see deriveWorldImpl). */
export function deriveWorld(
  frame: PoseFrame,
  delta: number,
  walkTime: number,
  idealPace: number,
  rampSeconds: number,
  state: PoseDeriveState,
  stats: PoseDeriveStats,
  target: Float32Array,
  paceOpts: PaceBandOpts = DEFAULT_PACE_OPTS,
): boolean {
  return deriveWorldImpl(
    frame,
    delta,
    walkTime,
    idealPace,
    rampSeconds,
    state,
    stats,
    target,
    false,
    false,
    paceOpts,
  );
}

/**
 * The SOLO world derivation (SOLO-MODE §3) — the additive variant the Swift
 * Solo port implements; the web app never calls it. Shares PoseDeriveState
 * and every pace/rhythm/footwork-score/composite rule with deriveWorld, and
 * redefines the two channels an unregistered ARKit frame can carry honestly:
 *
 * - POSTURE (M1): SIGNED hip-height drift vs the walk-start baseline — one
 *   quantity feeding stats.addPosture/livePostureM AND the M1 score
 *   (96 - |dev|EMA * SOLO_POSTURE_SLOPE, the head-path curve shape with a
 *   re-derived slope). Torso tilt is deliberately unused in v1.
 * - LATERAL: SIGNED perpendicular offset of the hip path from the walker's
 *   own travel line (+ = walker's right relative to travel), feeding
 *   stats.addLateral/liveLateralM. The M4 SCORE keeps the abs ankle-offset
 *   input unchanged. Measurement engages only under a STABLE heading
 *   (SOLO_HEADING_STABLE_MIN — warm-up and turns self-exclude) and outside
 *   `turnExcluded`, the caller's turn-window flag (§3: the heading EMA is
 *   garbage ~1.5 s mid-turn); the reported offset re-centers on its own
 *   first-second mean (SOLO_LATERAL_BASELINE_SEC). While unmeasured, the
 *   offset integration freezes, no sample lands, and the live tap reads
 *   null — the mean stays unpolluted by warm-up or the turn.
 *
 * Returns the §B wrote-targets fact (true = target[] holds a fresh legacy
 * composite; false = the both-hips bail — see deriveWorldImpl). The Swift
 * SoloWalkCore mirror carries the same (discardable) return.
 */
export function soloDeriveWorld(
  frame: PoseFrame,
  delta: number,
  walkTime: number,
  idealPace: number,
  rampSeconds: number,
  state: PoseDeriveState,
  stats: PoseDeriveStats,
  target: Float32Array,
  turnExcluded = false,
): boolean {
  return deriveWorldImpl(
    frame,
    delta,
    walkTime,
    idealPace,
    rampSeconds,
    state,
    stats,
    target,
    true,
    turnExcluded,
  );
}
