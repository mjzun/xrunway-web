/**
 * (X)RUNWAY — M10 THE HOLD: measured stillness + mark accuracy in the fixed
 * post-mark hold window (EDGE-ROADMAP Wave 1).
 *
 * Pure scalar accumulator + summary contract for the ONE canonical hold:
 * ShowDirector feeds it every walk frame after `reachedMark` latches (the
 * director owns the route protocol AND the head sensor keeps measuring even
 * when an external camera owns the M1-M4 quality scores), then finalizes it
 * into a `HoldStats` on `ShowSummary.hold`. The ARMING law lives HERE, not in
 * the wiring: post-latch frames fold NOTHING until the trainee has actually
 * ARRIVED on the mark (see add()) — the latch fires MARK_RADIUS = 0.4 m out,
 * and measuring the mandatory arrival transit as "hold drift" made the clean
 * verdict physically unreachable (an honest 0.85 m/s arrival read ~11 cm RMS
 * against a 5 cm fault line). The stagecraft (spot tighten, house dim, floor
 * ring, flash surge) is a PRESENTATION layer over this one accumulator's
 * live outputs — it never measures anything itself.
 *
 * Dependency-free by design (no @iwsdk/core, no DOM) so the golden-vector
 * generator and vitest import the REAL code — the walk-stats.ts /
 * pose-derive.ts pattern. Zero per-frame allocation: add() is scalar math on
 * plain number fields; the only allocations are the one HeadForward scratch
 * per accumulator (construction-time) and the HoldStats object finalize()
 * builds once per walk.
 *
 * Head-orientation math is IMPORTED from head-orient.ts (Wave 1 adjudication
 * §D: one quaternion -> forward convention shared with M8 head carriage;
 * never re-derived here). This module owns only its consumer-side pieces:
 * the yaw atan2 convention (M10 uses yaw VARIANCE, which is convention-
 * invariant) and its own measurability gate (HOLD_YAW_HORIZ_MIN).
 *
 * Honesty contract (the product laws this module encodes):
 * - Every quantity is a HEAD-SENSOR quantity and the copy says so; the words
 *   are stillness and mark accuracy — never poise, never presence.
 * - The RAW cm is always reported and is what the copy cites; only the
 *   verdict BANDS consume the height-normalized value, and every row stamps
 *   which normalization scored it (heightSource + headHeightM).
 * - A window the sensor did not actually measure discloses itself
 *   (timeInWindowSec < HOLD_WINDOW_SEC; the frozen-pose guard) instead of
 *   reading as fake-perfect stillness.
 */

import { headForward, makeHeadForward, pitchOf } from "./head-orient.js";

// ---------------------------------------------------------------------------
// Constants (every value shows its derivation — the SOLO_POSTURE_SLOPE rule).
// ---------------------------------------------------------------------------

/**
 * The ONE hold window (s) — single-sourced HERE. show.ts's POSE_HOLD_SEC
 * becomes an import alias of this constant (wiring phase), so the U-route
 * finish dwell and the measured window can never diverge, and the U walk
 * finishes byte-identically to today.
 *
 * Derivation: the one-way U ENDS the walk POSE_HOLD_SEC = 1.6 s after the
 * hold ARMS (the settle-on-the-mark dwell — show.ts keys `reachedFinish`
 * off the arming edge, with the walkSeconds timeout as the fallback when
 * tracking goes dark and the window never arms). Any window LONGER than the
 * dwell would be censored at 1.6 s on every U walk — a statistic
 * systematically truncated on one route class is dishonest to aggregate
 * across shapes — so the longest window fully measurable on every route is
 * the U dwell itself: 1.6 s.
 *
 * Statistical honesty at 1.6 s: postural-sway power sits in ~0.1-1 Hz, so
 * the window holds n_eff ~ 2 * B * T = 2 * 1 * 1.6 ~ 3 independent sway
 * samples; SE(RMS) ~ RMS / sqrt(2 * n_eff) ~ 40%. The verdict bands are
 * spaced 2.5x apart (2 cm good / 5 cm fault), i.e. ~2.3 sigma at that SE —
 * BAND assignment is reliable; resolving 10% differences is NOT claimed and
 * is M12's job (cross-walk aggregation of these rows). Lengthening the
 * window is a reserved founder call: it would change the U walk's feel for
 * every trainee (one line here + golden regen when called).
 */
export const HOLD_WINDOW_SEC = 1.6;

/**
 * Reference standing head height (m) the normalized stillness is scaled to.
 *
 * Physics (the roadmap's per-body rule — a 1.9 m trainee sways more at equal
 * skill): standing sway is an inverted pendulum about the ankles, so the
 * horizontal head excursion is x ~ h * theta for sway angle theta. Equal
 * skill = equal theta => x proportional to h => divide by the trainee's own
 * standing head height and re-scale by a fixed reference so the number stays
 * in familiar cm: norm = raw * (HOLD_REF_HEAD_M / headHeightM).
 *
 * 1.60 = pooled-adult mean standing EYE height (pooled US adult stature
 * ~1.69 m; eye height ~ stature * 0.936 ~ 1.575 m), rounded to a clean 1.60
 * — also within 0.1 m of the product's own synthetic rig (demo-walk.ts
 * EYE_HEIGHT = 1.5). The exact value is a UNIT CHOICE: it cancels in every
 * same-body comparison and only picks which body reads normalized == raw.
 * Golden-locked; never re-tuned.
 */
export const HOLD_REF_HEAD_M = 1.6;

/**
 * "Stood and froze" stillness band (normalized cm): quiet-stance head sway
 * RMS is ~1 cm — the same ~1.0 cm clean-walk |dev| EMA the M1 curve is
 * anchored on (pose-derive.ts SOLO_POSTURE_SLOPE derivation), and standing
 * is stiller than walking. 2 cm = 2x that noise floor: unambiguously still.
 */
export const HOLD_STILL_GOOD_NORM_CM = 2;

/**
 * Stillness fault band (normalized cm): 5 cm is the product's own natural
 * WALKING head-sway figure (coach-live.ts LATERAL_CUE_M header, "~4x natural
 * head sway (~5 cm)"). A hold that sways as much as a walk was not a hold.
 * Between the bands the copy makes no directional claim. Scale checks (also
 * the golden anchors): one adjustment step of +0.30 m halfway through the
 * window = a two-level signal +-0.15 m => RMS 15 cm (fault, correctly);
 * bolting through at 0.85 m/s sweeps L = 1.36 m => std = L / sqrt(12) =
 * 39 cm (fault, loudly); micro-settling ~2-4 cm sits in the neutral gap.
 */
export const HOLD_STILL_FAULT_NORM_CM = 5;

/**
 * Mark-accuracy "on the mark" band (RAW cm — position error does not scale
 * with body height): a standing stance footprint is ~30 cm long; a window-
 * mean position within half a footprint means the mark is UNDER the trainee,
 * not beside them. (= 0.375 * MARK_RADIUS, show.ts:117.)
 */
export const HOLD_MARK_GOOD_CM = 15;

/**
 * Mark-accuracy fault band (RAW cm): MARK_RADIUS = FINISH_RADIUS = 0.4 m is
 * the protocol's own "at the mark" radius (show.ts:117-119). A settled mean
 * at or beyond the latch rim = "you stopped at the edge of the mark zone,
 * never on the mark". Errors > 40 cm remain reachable: the latch fires
 * crossing poseA - 0.4 m and retreating/overrunning afterwards moves the
 * mean freely.
 */
export const HOLD_MARK_FAULT_CM = 40;

/**
 * Live-stillness speed scale (m/s): coach-live's PACE_DELTA_CUE_MPS = 0.25
 * (coach-live.ts) is the smallest speed the product already treats as a
 * decisive walking error — moving at a decisive walking-error speed during a
 * hold earns ZERO stillness credit. liveStill01 = 1 - min(1, ema / this):
 * a frozen trainee reads ~1, a bolter ~0. Presentation-only (the flash-surge
 * input); never reaches records or copy.
 *
 * DOUBLE DUTY — the speed ARM bound: a frame-to-frame speed first dropping
 * below this arms the measured window even short of the mark (add()): a
 * trainee moving slower than a decisive walking error has begun the hold,
 * so the residual creep IS hold drift and the mark error honestly reads the
 * shortfall.
 */
export const HOLD_SPEED_STILL_MPS = 0.25;

/**
 * ARRIVAL epsilon (m): the measured window arms at the first post-latch
 * frame with |dAlong| <= this (or a sub-HOLD_SPEED_STILL_MPS frame speed —
 * whichever comes first). The latch itself fires MARK_RADIUS = 0.4 m out
 * (show.ts), so arming at the latch measured the mandatory arrival transit
 * as hold drift: an honest 0.85 m/s decel-to-stop read ~11 cm RMS >= the
 * 5 cm fault line, and the 2 cm good band needed a physically impossible
 * ~20 m/s arrival — the good and mark bands were jointly unsatisfiable.
 *
 * Why 0.05 m is small enough (the residual-transit arithmetic): a uniform
 * decel from arrival speed v to a stop over the last d = 0.05 m takes
 * T = 2d/v and traces s(t) = -d (1 - t/T)^2 vs the stop point, so inside
 * the W = 1.6 s window it contributes weight fraction f = T/W and added
 * variance ~ f * d^2/5. At the beginner ideal arrival v = 0.85 m/s:
 * T ~ 0.12 s, f ~ 0.074 -> var ~ 0.37 cm^2 -> 0.61 cm RMS alone, i.e.
 * sqrt(1^2 + 0.37) ~ 1.2 cm RSS'd with the ~1 cm quiet-stance sway floor —
 * comfortably inside the 2 cm good band. Even at the slowest position-arm
 * arrival (the 0.25 m/s speed-arm bound): T = 0.4 s, f = 0.25 ->
 * var ~ 1.25 cm^2 -> RSS ~ 1.5 cm < 2. The residual transit can never cost
 * a clean hold its verdict.
 */
export const HOLD_ARRIVE_EPS_M = 0.05;

/**
 * Speed-EMA fold rate (1/s): the head path's own pace-EMA rate
 * (metrics.ts, `1 - Math.exp(-2 * dt)`) — the same smoothing law, so the
 * live stillness read and the live pace read agree on responsiveness. The
 * EMA is SEEDED with the first window speed sample (never 0-seeded — a
 * 0 seed would fake a still start for every bolter).
 */
export const HOLD_SPEED_EMA_RATE = 2;

/**
 * Presentation release ramp (s): after the window closes, the published
 * holdLive.t01 ramps 1 -> 0 over this long (wiring). The spot target's own
 * exponential smoothing settles to 95% in 3/7 ~ 0.43 s (stage.ts, k-rate
 * 7 /s); 0.6 s covers it so the cone release is a driven ease, not a step.
 * Never affects measurement — the accumulator stopped at HOLD_WINDOW_SEC.
 */
export const HOLD_RELEASE_SEC = 0.6;

/**
 * The hold's yaw-measurability gate on the forward ray's horizontal
 * magnitude (head-orient.ts `horiz`): sin(5 deg) = 0.0872. Below 5 deg of
 * horizontal forward component (pitch beyond +-85 deg) the atan2 yaw is
 * numerically meaningless, so the frame skips the ORIENTATION fold entirely
 * (pitch + yaw share one weight — orientRmsDeg is their RSS) while the
 * position still folds. Consumer-side by design (adjudication §D): M8 gates
 * the same `horiz` at 0.35 because it compares yaw against a route heading;
 * the hold only needs yaw dispersion, so it tolerates far more tilt.
 */
export const HOLD_YAW_HORIZ_MIN = 0.0872;

/**
 * Standing-body floor (m) for the walk-baseline height fallback: a headset
 * baseline below 0.5 m is not a standing trainee (it is a tracking artifact
 * or a floor-level rig), and normalizing by it would inflate the normalized
 * stillness by > 3x. Such a baseline falls through to the reference
 * (identity normalization, disclosed as source "ref").
 */
export const HOLD_STAND_MIN_M = 0.5;

/**
 * Frame-to-frame speed clamp (m/s) for the live-stillness read: the
 * metrics.ts tracking-jump clamp (`if (speed > 4) speed = 4`) — a head
 * displacement above 4 m/s between frames is a tracking artifact, not a
 * sprint, and must not blow the EMA out for seconds.
 */
export const HOLD_SPEED_CLAMP_MPS = 4;

const DEG_PER_RAD = 180 / Math.PI;

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// The summary contract.
// ---------------------------------------------------------------------------

/** Which standing-head-height normalized this row's stillness verdict:
 *  "fit" = the trainee's FIT baseline, "walk" = the first-0.5-s-of-walk
 *  head-height baseline (the metrics.ts baselineY law), "ref" = the
 *  reference fallback (normalization is identity). The per-row
 *  normalization stamp — a pre-FIT and a post-FIT hold are never silently
 *  trended as one series. */
export type HoldHeightSource = "fit" | "walk" | "ref";

/** Why finalize() returned null (adjudication §K — the copy branches on it):
 *  "never-marked" = the walk ended before the pose mark, so no window ever
 *  opened; "no-data" = the mark WAS reached but the window never accepted a
 *  measured sample (every frame was frozen/junk/zero-weight). */
export type HoldNullReason = "never-marked" | "no-data";

/** Measured facts of the post-mark hold window. All head-sensor quantities. */
export interface HoldStats {
  /** Seconds of MEASURED pose data inside the window (round2). Less than
   * HOLD_WINDOW_SEC = the window was truncated (walk clock expired, walk
   * finished, or the pose source froze) and the row says so. */
  timeInWindowSec: number;
  /** RAW horizontal (along/lateral) RMS drift of the head about its own
   * window-mean position, cm (round1). The honest number the copy cites. */
  stillnessRmsCm: number;
  /** stillnessRmsCm x (HOLD_REF_HEAD_M / headHeightM), cm (round1) — the
   * height-normalized value the verdict bands consume. */
  stillnessNormRmsCm: number;
  /** Standing head height used for the normalization, m (round3). */
  headHeightM: number;
  /** Which normalization scored this row (per-row stamp). */
  heightSource: HoldHeightSource;
  /** Head pitch+yaw RMS about their window means, deg (round1). Roll is
   * unobserved (direction-vector form — a forward ray is roll-blind, and
   * roll during a 1.6 s pose hold is not a coached fault). Null when the
   * window never accepted an orientation sample. */
  orientRmsDeg: number | null;
  /** Window-mean settled position vs the pose mark, cm: hypot of the two
   * signed errors below (round1). */
  markErrCm: number;
  /** Signed along error (round1): + = settled PAST the mark. */
  markAlongCm: number;
  /** Signed lateral error (round1): + = trainee's right on the OUTBOUND leg
   * (the walk-stats.ts sign convention; copy never names sides — the window
   * can contain the turn). */
  markLatCm: number;
}

// ---------------------------------------------------------------------------
// The accumulator.
// ---------------------------------------------------------------------------

/**
 * Per-walk hold accumulator. ShowDirector resets it at walk start (and on a
 * mid-walk remap — the mark moved, so the LAST window wins), feeds one add()
 * per walk frame while reachedMark is latched, and finalizes at walk end.
 * add() itself decides when measurement STARTS (the arming law — see the
 * method doc): pre-arrival frames latch markSeen and feed the arrival
 * detector but fold nothing, so the wiring stays dumb and the law stays
 * golden-testable.
 *
 * Settled position is the TIME-WEIGHTED MEAN over the window — chosen over
 * first-settle detection because it needs zero extra constants (a settle
 * detector needs a speed threshold + hysteresis), is defined for EVERY walk,
 * is one-pass streaming (the same sums the RMS already keeps), and is
 * monotone in misbehavior: a bolting trainee's mean is dragged off the mark,
 * which is the honest reading of "did not settle".
 *
 * Stillness is HORIZONTAL (along/lateral) by design: vertical drift in the
 * hold is head-height posture — M1's already-reported channel — and
 * double-claiming it here would blur both disclosures.
 *
 * RMS about the window mean (not mean-abs): one-pass zero-alloc streaming
 * (Var = S2/w - (S1/w)^2 needs only w, S1, S2), the standard posturography
 * sway statistic, and a quadratic penalty that matches the skill — one lurch
 * is worse than uniform micro-sway, and it composes with the mark error
 * (total second moment about the mark = markErr^2 + driftRMS^2).
 *
 * Cancellation safety: add() takes dAlong PRE-CENTERED on the pose mark's
 * route-along (the wiring subtracts poseA), so magnitudes are O(1 m), not
 * O(runway length): S2/w - mean^2 in f64 carries ~1e-16 relative error
 * against variances >= 1e-8 m^2 (a 0.1 mm RMS). No Welford needed; golden
 * vectors carry small human-readable numbers.
 */
export class HoldAccumulator {
  /** Live 0..1 stillness quality for the flash surge. 0 until the window
   * ARMS and the first in-window speed sample lands; presentation-only. */
  liveStill01 = 0;

  /** FIT standing head height snapshotted for THIS run at reset() —
   * adjudication §C: the globals.bodyBaseline peek is WIRING-side; the pure
   * module receives a plain number-or-null so the height ladder in
   * finalize() is golden-locked. A mid-run FIT rerun cannot move the
   * normalization under the walk (the mode-lock pattern). */
  private fitHeightM: number | null = null;

  /** True once the mark latch fired. Latched by EVERY add() call (the
   * wiring only feeds frames after reachedMark latches, so one call — even
   * zero-weight — means the mark was reached) AND by markReached(), which
   * the wiring calls on the latch frame itself BEFORE its finiteness gate:
   * a walk whose entire post-mark stretch was dark never reaches add(), and
   * without the wiring-side latch it would mis-read "never-marked". */
  private markSeen = false;

  /** Arming state (the arrival law): nothing folds until `armedState`, and
   * every fold is rebased to tSince - tArm (the measured window is
   * [tArm, tArm + HOLD_WINDOW_SEC]). */
  private armedState = false;
  private tArm = 0;

  // Position moments (time-weighted, one-pass): Var = S2/w - (S1/w)^2 with
  // a max(0, .) negative-zero guard for float rounding.
  private wPos = 0;
  private sumA = 0;
  private sumA2 = 0;
  private sumL = 0;
  private sumL2 = 0;

  // Orientation moments (pitch + unwrapped yaw share ONE weight — the
  // reported orientRmsDeg is their RSS, so they must cover the same time).
  private wOri = 0;
  private sumP = 0;
  private sumP2 = 0;
  private sumY = 0;
  private sumY2 = 0;

  // Yaw unwrap state (scalar): a hold facing the +-PI seam must not explode
  // to a 360-degree RMS. Frame-to-frame head rotation at 72 Hz cannot
  // legitimately exceed PI (that is > 11,000 deg/s), so the +-2PI offset
  // branch only ever corrects the seam.
  private prevRawYaw = 0;
  private yawOffset = 0;
  private haveYaw = false;

  // Live-stillness differencing state (the speed prev is DROPPED by the
  // frozen-pose guard so a resumed stream re-seeds instead of differencing
  // across the freeze — the resetCadence law).
  private prevA = 0;
  private prevL = 0;
  private havePrevPos = false;
  private speedEma = 0;
  private haveSpeed = false;

  // Frozen-pose guard state: the last ACCEPTED input tuple.
  private lastA = 0;
  private lastL = 0;
  private lastQx = 0;
  private lastQy = 0;
  private lastQz = 0;
  private lastQw = 0;
  private haveLast = false;

  /** Construction-time scratch for the forward-ray extraction (zero
   * per-frame allocation). */
  private readonly fwd = makeHeadForward();

  /**
   * Arm for a new walk. `fitHeightM` is the trainee's FIT standing head
   * height (globals.bodyBaseline.standHeightM, peeked by the WIRING at
   * setPhase("walk")) or null when no FIT baseline exists — passed as a
   * plain number so this module never reads a signal (adjudication §C).
   */
  reset(fitHeightM: number | null): void {
    this.fitHeightM = fitHeightM;
    this.markSeen = false;
    this.armedState = false;
    this.tArm = 0;
    this.wPos = 0;
    this.sumA = 0;
    this.sumA2 = 0;
    this.sumL = 0;
    this.sumL2 = 0;
    this.wOri = 0;
    this.sumP = 0;
    this.sumP2 = 0;
    this.sumY = 0;
    this.sumY2 = 0;
    this.prevRawYaw = 0;
    this.yawOffset = 0;
    this.haveYaw = false;
    this.prevA = 0;
    this.prevL = 0;
    this.havePrevPos = false;
    this.speedEma = 0;
    this.haveSpeed = false;
    this.lastA = 0;
    this.lastL = 0;
    this.lastQx = 0;
    this.lastQy = 0;
    this.lastQz = 0;
    this.lastQw = 0;
    this.haveLast = false;
    this.liveStill01 = 0;
  }

  /**
   * Wiring-side mark latch (the never-marked/no-data discriminator): the
   * director calls this inside its reachedMark branch, BEFORE the per-frame
   * finiteness gate that guards the data feed. add() also latches markSeen,
   * but the wiring withholds add() on dark frames — so a walk that reached
   * the mark with an all-dark window must latch HERE to read "no-data"
   * instead of the false "never-marked". (The data feed itself stays gated:
   * projectRoute launders NaN positions into finite start-line projections
   * that must never fold.)
   */
  markReached(): void {
    this.markSeen = true;
  }

  /** True once the arrival law armed the measured window this walk. The
   * wiring keys the U-route finish dwell and the holdLive ramp off the
   * arming EDGE (its own holdStartElapsed snapshot). */
  get armed(): boolean {
    return this.armedState;
  }

  /** tSinceMarkSec of the arming frame, or null before arming — the
   * golden-queryable form of the arming edge. */
  get armedAtSec(): number | null {
    return this.armedState ? this.tArm : null;
  }

  /**
   * One walk frame while reachedMark is latched. Zero allocation.
   *
   * - ARMING (the arrival law): post-latch frames fold NOTHING until the
   *   trainee has actually ARRIVED — the first accepted frame with
   *   |dAlongM| <= HOLD_ARRIVE_EPS_M, OR whose frame-to-frame speed is
   *   below HOLD_SPEED_STILL_MPS (began the hold short of the mark; the
   *   mark error reads the shortfall) — whichever comes first. That frame
   *   records tArm = its tSinceMarkSec and every subsequent fold rebases to
   *   tw = tSinceMark - tArm: the measured window is [tArm, tArm +
   *   HOLD_WINDOW_SEC]. Pre-arm frames still latch markSeen, feed the
   *   arrival differencing and the frozen-pose guard — they just carry zero
   *   measurement weight, exactly like the latch frame always did.
   * - `tSinceMarkSec` = phaseElapsed - markElapsed at frame END; once
   *   armed, the frame spans [tw - dt, tw] and is weighted by its overlap
   *   with [0, HOLD_WINDOW_SEC]:
   *     effDt = max(0, min(HOLD_WINDOW_SEC, tw) - max(0, tw - dt))
   *   The arming frame (tw = 0) gets weight 0 — no pre-arrival time ever
   *   counts; the frame straddling window close gets exactly the remaining
   *   sliver. The clamp lives HERE (not the wiring) so it is
   *   golden-testable and show.ts stays wiring-only.
   * - `dAlongM` = projected route-along MINUS the pose mark's route-along
   *   (pre-centered, wiring-side); `lateralM` = signed route lateral.
   * - `qx..qw` = the head WORLD quaternion's raw components (the wiring
   *   reads player.head.getWorldQuaternion into ONE preallocated Quaternion
   *   — adjudication §D); the forward-ray math is head-orient.ts's. A
   *   non-finite or gimbal-locked quaternion (horiz < HOLD_YAW_HORIZ_MIN)
   *   skips the ORIENTATION fold only; position still folds.
   * - Non-finite position values skip the frame's folds AND drop the speed
   *   anchor (havePrevPos) — the next clean frame re-seeds instead of
   *   differencing across the junk (position/orientation moments are
   *   untouched, so a junk-frame tape still FINALIZES identically to its
   *   clean-frames-only twin; only the presentation-channel speed EMA
   *   diverges, by design). Non-finite timing skips the frame entirely.
   * - FROZEN-POSE GUARD: a tracked 6DoF head can never emit two bit-identical
   *   float64 tuples at 72-90 Hz (sensor-fusion noise floors are sub-mm).
   *   If (dAlong, lateral, qx, qy, qz, qw) EXACTLY equals the last accepted
   *   tuple, the pose source froze (tracking loss / VisibleBlurred with the
   *   loop still running / a desktop preview's static camera): the frame
   *   contributes ZERO weight and does not advance timeInWindowSec — a
   *   half-blind hold discloses itself as timeInWindowSec < HOLD_WINDOW_SEC
   *   instead of reading as fake-perfect stillness — and the speed prev is
   *   dropped so the next live frame re-seeds instead of differencing across
   *   the freeze. The guard runs BEFORE the arming check, so frozen tracking
   *   can never arm the window (speed 0 on frozen frames would otherwise
   *   fake an arrival): a dark U walk never arms, never fires the settle
   *   dwell, and ends via the walkSeconds timeout with an honest no-data
   *   row. Bonus honesty: a desktop preview walk cannot fake a hold (its
   *   static camera never even arms).
   */
  add(
    tSinceMarkSec: number,
    dtSec: number,
    dAlongM: number,
    lateralM: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
  ): void {
    // Any call = the mark was reached (set before every gate so a walk whose
    // whole window was junk still reads "no-data", not "never-marked").
    this.markSeen = true;
    if (!(Number.isFinite(tSinceMarkSec) && Number.isFinite(dtSec) && dtSec > 0)) {
      return;
    }
    if (!Number.isFinite(dAlongM) || !Number.isFinite(lateralM)) {
      // Junk position: nothing folds, and the speed anchor is dropped so
      // the next clean frame re-seeds instead of differencing across the
      // junk (the frozen-pose guard's re-seed law, applied to junk gaps).
      this.havePrevPos = false;
      return;
    }
    if (
      this.haveLast &&
      dAlongM === this.lastA &&
      lateralM === this.lastL &&
      qx === this.lastQx &&
      qy === this.lastQy &&
      qz === this.lastQz &&
      qw === this.lastQw
    ) {
      // Frozen pose: zero weight, and the speed anchor is gone. Running
      // before the arming check keeps dark tracking from ever arming.
      this.havePrevPos = false;
      return;
    }

    // Frame-to-frame speed over the REAL frame time (never the
    // window-clipped effDt — dividing the displacement since the last
    // ACCEPTED frame by a clipped sliver inflated the read on the
    // window-close straddler). Serves BOTH the arrival law and liveStill01;
    // -1 = no anchor (first accepted frame, or the anchor was dropped).
    let speed = -1;
    if (this.havePrevPos) {
      const da = dAlongM - this.prevA;
      const dl = lateralM - this.prevL;
      speed = Math.hypot(da, dl) / dtSec;
      if (speed > HOLD_SPEED_CLAMP_MPS) speed = HOLD_SPEED_CLAMP_MPS;
    }

    // ARMING — the arrival law (see the method doc + HOLD_ARRIVE_EPS_M).
    if (!this.armedState) {
      const arrived =
        (dAlongM <= HOLD_ARRIVE_EPS_M && dAlongM >= -HOLD_ARRIVE_EPS_M) ||
        (speed >= 0 && speed < HOLD_SPEED_STILL_MPS);
      if (arrived) {
        this.armedState = true;
        this.tArm = tSinceMarkSec;
      }
    }

    if (this.armedState) {
      const tw = tSinceMarkSec - this.tArm;
      const hi = tw < HOLD_WINDOW_SEC ? tw : HOLD_WINDOW_SEC;
      const lo0 = tw - dtSec;
      const lo = lo0 > 0 ? lo0 : 0;
      const effDt = hi - lo;
      if (effDt > 0) {
        // Position moments.
        this.wPos += effDt;
        this.sumA += dAlongM * effDt;
        this.sumA2 += dAlongM * dAlongM * effDt;
        this.sumL += lateralM * effDt;
        this.sumL2 += lateralM * lateralM * effDt;

        // Orientation moments — head-orient.ts owns the quaternion math;
        // this module owns only its gate and the yaw atan2 convention.
        // yaw = atan2(-fx, -fz) is the runway-heading convention
        // (comparable to rect.yaw — M8's need); the hold uses only its
        // VARIANCE, which is convention-invariant.
        const f = headForward(qx, qy, qz, qw, this.fwd);
        const pitch = pitchOf(f.y);
        if (Number.isFinite(pitch) && f.horiz >= HOLD_YAW_HORIZ_MIN) {
          const rawYaw = Math.atan2(-f.x, -f.z);
          if (this.haveYaw) {
            const d = rawYaw - this.prevRawYaw;
            if (d > Math.PI) this.yawOffset -= 2 * Math.PI;
            else if (d < -Math.PI) this.yawOffset += 2 * Math.PI;
          }
          this.prevRawYaw = rawYaw;
          this.haveYaw = true;
          const yawU = rawYaw + this.yawOffset;
          this.wOri += effDt;
          this.sumP += pitch * effDt;
          this.sumP2 += pitch * pitch * effDt;
          this.sumY += yawU * effDt;
          this.sumY2 += yawU * yawU * effDt;
        }

        // Live stillness — the speed above (real-dt time base), folded with
        // the head path's pace-EMA law at the frame's WINDOW weight and
        // SEEDED by the first in-window sample (no fake-still 0 seed).
        if (speed >= 0) {
          if (this.haveSpeed) {
            this.speedEma +=
              (speed - this.speedEma) *
              (1 - Math.exp(-HOLD_SPEED_EMA_RATE * effDt));
          } else {
            this.speedEma = speed;
            this.haveSpeed = true;
          }
          const q = this.speedEma / HOLD_SPEED_STILL_MPS;
          this.liveStill01 = 1 - (q < 1 ? q : 1);
        }
      }
    }

    // Anchors update on EVERY accepted frame — pre-arm frames included:
    // they carry the arrival differencing and the frozen-pose reference.
    this.prevA = dAlongM;
    this.prevL = lateralM;
    this.havePrevPos = true;

    this.lastA = dAlongM;
    this.lastL = lateralM;
    this.lastQx = qx;
    this.lastQy = qy;
    this.lastQz = qz;
    this.lastQw = qw;
    this.haveLast = true;
  }

  /**
   * Freeze the window into a HoldStats; null when no window time was ever
   * accepted (nullReason() says why). Non-destructive and re-callable.
   *
   * `walkBaseHeadYM` is the director's first-0.5-s-of-walk mean head height
   * (the SAME law as metrics.ts baselineY, sampled WIRING-side because the
   * accumulator only sees post-mark frames) or null when the walk never
   * sampled it. Height ladder: FIT baseline (source "fit") -> walk baseline
   * above the standing floor (source "walk") -> HOLD_REF_HEAD_M itself
   * (source "ref", identity normalization, disclosed).
   */
  finalize(walkBaseHeadYM: number | null): HoldStats | null {
    if (!(this.wPos > 0)) return null;

    let heightM = HOLD_REF_HEAD_M;
    let source: HoldHeightSource = "ref";
    if (
      this.fitHeightM !== null &&
      Number.isFinite(this.fitHeightM) &&
      this.fitHeightM > 0
    ) {
      heightM = this.fitHeightM;
      source = "fit";
    } else if (
      walkBaseHeadYM !== null &&
      Number.isFinite(walkBaseHeadYM) &&
      walkBaseHeadYM > HOLD_STAND_MIN_M
    ) {
      heightM = walkBaseHeadYM;
      source = "walk";
    }

    const meanA = this.sumA / this.wPos;
    const meanL = this.sumL / this.wPos;
    const varA = Math.max(0, this.sumA2 / this.wPos - meanA * meanA);
    const varL = Math.max(0, this.sumL2 / this.wPos - meanL * meanL);
    const rawCm = Math.sqrt(varA + varL) * 100;

    let orientRmsDeg: number | null = null;
    if (this.wOri > 0) {
      const meanP = this.sumP / this.wOri;
      const meanY = this.sumY / this.wOri;
      const varP = Math.max(0, this.sumP2 / this.wOri - meanP * meanP);
      const varY = Math.max(0, this.sumY2 / this.wOri - meanY * meanY);
      orientRmsDeg = round1(Math.sqrt(varP + varY) * DEG_PER_RAD);
    }

    return {
      timeInWindowSec: round2(this.wPos),
      stillnessRmsCm: round1(rawCm),
      stillnessNormRmsCm: round1(rawCm * (HOLD_REF_HEAD_M / heightM)),
      headHeightM: round3(heightM),
      heightSource: source,
      orientRmsDeg,
      markErrCm: round1(Math.hypot(meanA, meanL) * 100),
      markAlongCm: round1(meanA * 100),
      markLatCm: round1(meanL * 100),
    };
  }

  /**
   * Why finalize() returned null — meaningful ONLY when it did.
   * "never-marked" until markReached()/the first add() call (the wiring
   * latches markReached on the reachedMark edge itself and only feeds
   * add() after it, so neither = the walk ended before the mark),
   * "no-data" once the mark was seen but nothing measured (dark tracking,
   * a window that never armed, or an all-junk window).
   */
  nullReason(): HoldNullReason {
    return this.markSeen ? "no-data" : "never-marked";
  }
}

// ---------------------------------------------------------------------------
// Copy (ASCII punctuation only — every string enters the panel-ascii sweep).
// Parked HERE (not coach.ts) on purpose: M10 is not Solo-portable, so keeping
// its strings out of the shared coach tables keeps the Swift string mirrors
// (Coach.swift / CoachCopy.swift) and their golden families untouched.
// ---------------------------------------------------------------------------

/**
 * Landing tooltip / explainer row. Discloses sensor, derivation, window,
 * normalization, AND the stagecraft reward mapping (the light/flash layer is
 * a disclosed mapping from measured quantities). The numbers are templated
 * from the constants so the disclosure can never drift from the math.
 */
export const HOLD_EXPLAIN =
  `Measured in the ${HOLD_WINDOW_SEC.toFixed(1)} s window once you settle ` +
  `on the pose mark. Stillness is the RMS drift of your head position in cm ` +
  `(the verdict band scales it to a ${HOLD_REF_HEAD_M.toFixed(2)} m ` +
  `reference height); mark accuracy is your average position vs the mark ` +
  `in cm. Head sensor only - nothing reads your expression or styling. ` +
  `The tightening light pool and the flash surge follow these measured ` +
  `numbers.`;

/**
 * Summary stat line (XR panel node "sum-hold" + the landing card). The null
 * branch REQUIRES the reason (adjudication §K): a walk that never reached
 * the mark and a walk whose window went unmeasured are different facts and
 * must not share a sentence.
 */
export function holdStatLine(
  h: HoldStats | null,
  nullReason: HoldNullReason,
  sep: string = " - ",
): string {
  if (h === null) {
    // NO-READ prose sentences keep their literal dash (sentence punctuation,
    // not a field list) — the turnStatLine convention.
    return nullReason === "never-marked"
      ? "HOLD: NO READ - THE WALK ENDED BEFORE THE MARK"
      : "HOLD: NO READ - THE HOLD WINDOW WAS NOT MEASURED";
  }
  // `sep` joins the measured fields: the XR panel's ASCII " - " default (the
  // panel font has no middle-dot glyph); the DOM landing passes " · " to
  // match its DURATION / CARRIAGE / BEAT / TURN sibling rows.
  return (
    `HOLD ${h.timeInWindowSec.toFixed(1)}S${sep}` +
    `STILL ${h.stillnessRmsCm.toFixed(1)} CM${sep}` +
    `MARK ${Math.round(h.markErrCm)} CM`
  );
}

/**
 * Post-walk coach note. Cites the RAW cm; the BANDS consume the normalized
 * value. Never "poise", never "presence"; never left/right (the hold window
 * can contain the turn, so side words would flip meaning mid-window — the
 * coach.ts law). Between bands: no claim (null).
 */
export function holdCue(
  h: HoldStats | null,
  nullReason: HoldNullReason,
): string | null {
  if (h === null) {
    return nullReason === "never-marked"
      ? "You never reached the pose mark - the hold was not measured."
      : "You reached the mark but the hold was not measured - you never settled on it or tracking went dark.";
  }
  const rms = h.stillnessRmsCm.toFixed(1);
  const err = Math.round(h.markErrCm);
  if (h.stillnessNormRmsCm >= HOLD_STILL_FAULT_NORM_CM) {
    return `You drifted ${rms} cm through the hold - hit the mark, freeze, count the beat.`;
  }
  if (h.markErrCm >= HOLD_MARK_FAULT_CM) {
    const a = h.markAlongCm;
    // Along-dominated (|along| >= 2x |lateral|): the short/past direction is
    // route-frame, not body-side, so it survives the turn.
    if (Math.abs(a) >= 2 * Math.abs(h.markLatCm)) {
      return a < 0
        ? `Your hold settled ${err} cm short of the mark - walk all the way onto it before you set.`
        : `Your hold settled ${err} cm past the mark - stop on it, not through it.`;
    }
    return `Your hold settled ${err} cm off the mark - land it, square up, then freeze.`;
  }
  if (
    h.stillnessNormRmsCm <= HOLD_STILL_GOOD_NORM_CM &&
    h.markErrCm <= HOLD_MARK_GOOD_CM
  ) {
    return `Held ${rms} cm still, ${err} cm off the mark - a clean hold.`;
  }
  return null;
}
