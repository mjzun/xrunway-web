/**
 * (X)RUNWAY — M11 THE TURN: the canonical out-and-back 180 analyzer
 * (EDGE-ROADMAP Wave 2; spec wave2-spec-m11.md; adjudication §A/§B/§C/§H
 * binding).
 *
 * Pure per-walk turn tracker + summary contract for the one 180 the
 * protocol asks for: walk out, hit the mark, hold, TURN, bring it home.
 * Five head-only sub-measures come out of one segmentation pass:
 * - SWEEP SMOOTHNESS: deadband-filtered yaw-sweep reversals + the
 *   time-free monotone fraction (net sweep / total swept path).
 * - DURATION vs a mode-scaled band (judged, never nulled — see the
 *   no-timeout law at TURN_EXIT_DEG).
 * - HEIGHT DIP vs the walk baseline (the collapse-into-the-turn fault).
 * - CARRIAGE PITCH THROUGH THE TURN — consumed from M8's tracker via the
 *   one additive raw tap (liveRawPitchDevDeg); one owner per number: the
 *   neutral chain and the pitch extraction stay in head-carriage.ts.
 * - LINE RE-ACQUISITION on the return leg (time to hold the centerline).
 *
 * HONESTY LAW (the roadmap's binding label rule): every quantity here is
 * the HEAD PATH through the turn — feet are not tracked, and no string this
 * module builds ever claims a foot pivot, style, or poise. A null read is a
 * fact worth a sentence: the reason taxonomy (TurnNullReason) discriminates
 * coachable motion facts (never-settled, turned-in-hold) from sensor facts
 * (tracking-dark) using the tracker's OWN accepted seconds — never inferred
 * from another channel's null reason (adjudication §B).
 *
 * THE BEAT PARTITION (hold then turn — the claim law): the HOLD owns
 * [tArm, tArm + HOLD_WINDOW_SEC] whether or not every frame inside it was
 * measurable; the turn window OPENS at the hold window's close
 * (noteHoldArmed + HOLD_WINDOW_SEC), so no second of the beat is ever
 * scored by two channels. A pivot begun inside the hold window is charged
 * to the hold as motion (the protocol said freeze); the analyzer sees only
 * what remains at the open — a sweep already past the ENTER gate at the
 * first accepted post-open frame is stamped entryClipped (measured from the
 * hold release, duration verdict suppressed — adjudication §C); already
 * past the COMMIT gate, the turn is null "turned-in-hold". The straddle
 * frame at the open is trimmed to its post-open portion
 * (dtEff = min(dt, walkTime - windowOpen)) — zero shared time by
 * construction (adjudication §H).
 *
 * Dependency-free by design (no @iwsdk/core, no DOM; pure-module imports
 * only) so the golden-vector generator and vitest import the REAL code —
 * the walk-stats.ts / pose-derive.ts pattern — and the module stays
 * Swift-PORTABLE (scalar-only state, no closures over engine state, no
 * Date/DOM, explicit unwrap arithmetic; mirror-synced-but-unconsumed this
 * wave). Zero per-frame allocation: update() is scalar math on plain
 * number/boolean fields plus one HeadForward scratch allocated at
 * construction; finalize() and the copy builders allocate at walk end only.
 * PoseFrame.t is never consumed (wall-clock law) — the tracker runs on the
 * caller's ECS frame delta and walk clock exclusively.
 *
 * Head-orientation math is IMPORTED from head-orient.ts (adjudication §D:
 * one quaternion -> forward extraction; yaw semantics consumer-side). The
 * signed yaw deviation vs the OUTBOUND route heading uses the exact M8
 * convention (head-carriage.ts yaw error: atan2(cross, dot) against
 * (hx, hz) = (-sin psi, -cos psi)) with NO return flip ever applied — the
 * reference is the outbound facing for the whole machine, so the 180 reads
 * as a sweep from ~0 to ~+-180 deg.
 */

import {
  headForward,
  makeHeadForward,
  type HeadForward,
} from "./head-orient.js";
import { M8_MIN_HORIZ, M8_PITCH_BAND_DEG } from "./head-carriage.js";
import {
  HOLD_WINDOW_SEC,
  HOLD_REF_HEAD_M,
  HOLD_STAND_MIN_M,
} from "./hold-stats.js";
import { LATERAL_CUE_M, POSTURE_CUE_M } from "./coach-live.js";

const RAD2DEG = 180 / Math.PI;

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Constants (every value shows its derivation — the SOLO_POSTURE_SLOPE rule).
// ---------------------------------------------------------------------------

/**
 * Provisional-entry gate (deg |yaw deviation| vs the outbound heading).
 * M8's honest facing band is 12 deg (M8_YAW_BAND_DEG: gait yaw wobble
 * ~3-4 deg + legitimate line-correction heading ~7.6 deg, head-carriage.ts)
 * + the ~4 deg gait oscillation itself + 4 margin: 12 + 4 + 4 = 20. Below
 * 20 the head is still honestly "facing down the line"; entry is cheap
 * (aborts discard wholesale), so chatter at the gate costs nothing and
 * needs no re-arm constant.
 */
export const TURN_ENTER_DEG = 20;

/**
 * Commit gate (deg |yaw deviation|): the turn CONFIRMS here. Physiological
 * anchor: adult cervical axial rotation tops out ~70-90 deg — a head yaw of
 * 100 deg vs the walk line REQUIRES trunk rotation. A head-only glance
 * (checking the house, an over-shoulder look) physically cannot reach it:
 * 90 (cervical max) + 4 (gait wobble) < 100. Past commit, the BODY is
 * turning — which is why a committed turn truncated by the walk clock is
 * "walk-ended-mid-turn", never a glance (adjudication §B).
 */
export const TURN_COMMIT_DEG = 100;

/**
 * Exit gate (deg |yaw deviation|), declared AS its derivation: the head is
 * within the same TURN_ENTER_DEG facing band of the RETURN heading
 * (symmetric hysteresis; overshoot past 180 still satisfies >= 160).
 * TIMEOUT: none, by design — a committed sweep is measurable whenever it
 * completes; the duration band judges slowness, and a hard timeout would
 * convert a measured slow turn into a fabricated null. Walk end while
 * committed -> "walk-ended-mid-turn".
 */
export const TURN_EXIT_DEG = 180 - TURN_ENTER_DEG;

/**
 * Sweep-reversal deadband (deg): a reversal counts only when the deviation
 * retreats at least this far from the sweep's running extremum (the
 * zigzag/extremum filter — the noise-robust equivalent of a yaw-velocity
 * sign flip that actually moved). 5 > the ~3-4 deg gait/vestibular yaw
 * oscillation (the M8_YAW_BAND derivation's own figure), so rhythmic wobble
 * never counts; a genuine stutter (stop + counter-rotate) retreats ~10+.
 * The paired monotone fraction (net sweep / total swept path, both on the
 * deadband-filtered series) is time-free by construction, so a slow
 * deliberate turn is never punished for taking more frames.
 */
export const TURN_REV_DEADBAND_DEG = 5;

/**
 * Reference pace (m/s) the base duration band is anchored at — the Beginner
 * ideal (DEFAULT_MODE.idealPace, modes.ts; pinned by a suite assert). The
 * mode's ONLY tempo parameter is idealPace, so the band scales by
 * TURN_DUR_BASE_PACE_MPS / idealPaceMps: a slower, more deliberate mode
 * earns a proportionally slower turn.
 */
export const TURN_DUR_BASE_PACE_MPS = 0.85;

/**
 * Base duration band LOW edge (s) at the reference pace: 180 deg / 0.9 s =
 * 200 deg/s — the top of the controlled whole-body turn range
 * (turning-in-place at comfortable effort completes a 180 in ~0.9-1.6 s);
 * faster reads as a whip/snap, off balance.
 */
export const TURN_DUR_BASE_LO_SEC = 0.9;

/**
 * Base duration band HIGH edge (s), declared AS its derivation
 * (adjudication §H): a 4-step step-turn at the codebase's 1.8 Hz reference
 * gait (pose-derive.ts) = 4 / 1.8 ~ 2.22 s; more than 4 steps is shuffling
 * through the turn. The per-mode table is COMPUTED from this value
 * (turnDurBand) and stamped round2 on every row — golden pins come from the
 * live computation, never spec prose.
 */
export const TURN_DUR_BASE_HI_SEC = 4 / 1.8;

/**
 * Height-dip fault line as a FRACTION of the trainee's own standing head
 * height, declared AS its derivation (adjudication §A — meters over
 * meters): POSTURE_CUE_M / HOLD_REF_HEAD_M = 0.06 / 1.60 = 0.0375. Trips
 * when dipFrac >= 3.75% of standing head height, i.e. EXACTLY the live
 * coach's 6 cm decisive posture fault at the reference body, scaled per
 * body (a 1.9 m-headed trainee trips at 7.1 cm — the roadmap's per-body
 * rule). The copy cites the RAW cm; the band consumes the fraction (the
 * M10 raw-cited / normalized-banded law).
 */
export const TURN_DIP_FAULT_FRAC = POSTURE_CUE_M / HOLD_REF_HEAD_M;

/**
 * Dip EMA fold rate (1/s, frame-rate-independent form 1 - exp(-8 * dt)):
 * the dip is an EXTREMUM statistic with no averaging of its own, so the
 * head-height series is smoothed before the min is taken. A single 14 ms
 * tracking spike folds to ~10% of its amplitude (1 - exp(-8 * 0.014) =
 * 0.106) while a real 0.5 s dip reads 98% (1 - exp(-8 * 0.5)). Seeded on
 * the first accepted in-turn height sample; the raw integrals elsewhere
 * are untouched.
 */
export const TURN_DIP_EMA_RATE = 8;

/**
 * Line re-acquisition bar (m |lateral|) — an import ALIAS of the live
 * coach's cue line (the POSE_HOLD_SEC single-sourcing precedent):
 * "re-acquired" must mean "the live coach would no longer call the line
 * lost", so the SAME constant guarantees M11 and coach-live can never
 * disagree. The rejected candidate was the footwork score curve's lowest
 * pass edge (|lat| = 21/240 = 0.0875 m, metrics.ts) — that measures
 * steady-state precision, which stays M4's business; a trainee whose
 * normal line is 10 cm off would never "re-acquire" against it, punishing
 * footwork twice.
 */
export const TURN_REACQ_BAR_M = LATERAL_CUE_M;

/**
 * Re-acquisition sustain (s): ~one step at the 1.8 Hz reference gait
 * (1/1.8 = 0.556) — one full step planted inside the corridor before the
 * claim; rejects a single-frame projector flicker at a junction and
 * tracking jitter. The reported time is the ENTRY of the sustained stretch
 * (the sustain is evidence, not latency); a dark/non-finite lateral frame
 * RESETS the candidate (a gap breaks the evidence — conservative).
 */
export const TURN_REACQ_SUSTAIN_SEC = 0.5;

/**
 * Minimum measured return-leg seconds before ANY re-acquisition claim
 * (incl. the capped "never re-centered" floor): one gait cycle — the
 * M8_YAW_MIN_SEC convention. A mostly-dark return must not claim "never
 * re-centered"; under this, reacquireSec is null (unmeasured, disclosed).
 */
export const TURN_RETURN_MIN_SEC = 1;

/**
 * Minimum accepted yaw-seconds (s) before the machine's NO-turn verdicts
 * are trusted — one gait cycle (the M8_YAW_MIN_SEC convention): under a
 * cycle of data, "no-turn" vs "dark" is a coin flip, so the answer is
 * "tracking-dark". Serves BOTH floors of the reason taxonomy
 * (adjudication §B): accepted post-MARK seconds under it = the mark beat
 * itself was unmeasurable (vs "never-settled", the coachable motion fact);
 * accepted post-OPEN seconds under it = the turn span was unmeasurable.
 * A COMPLETED sweep (entry -> exit measured) is direct evidence and is
 * never floored; a COMMITTED truncation outranks the floor too
 * (walk-ended-mid-turn — the §B commit-latch-first law).
 */
export const TURN_MIN_MEASURED_SEC = 1;

/**
 * Re-acquisition cue line (s): 3 s at the beginner ideal 0.85 m/s =
 * 2.55 m of runway walked off-line — over a third of the 7 m default deck
 * (theme.ts deckLength). Slower re-centering than that is the walk's
 * story; under it the row line carries the number without a correction.
 */
export const TURN_REACQ_CUE_SEC = 3;

// ---------------------------------------------------------------------------
// The summary contract.
// ---------------------------------------------------------------------------

/**
 * Why finalize() returned null (the copy branches on it; different facts
 * never share a sentence). Discrimination law (adjudication §B): the
 * sensor claims ("tracking-dark") come from THIS tracker's own accepted
 * seconds, never inferred from the hold's null reason.
 */
export type TurnNullReason =
  /** U route: the protocol has no 180 (stamped at walk start / remap). */
  | "one-way-route"
  /** The walk ended before the pose mark — no beat, no turn. */
  | "never-marked"
  /** Live post-mark stream, but the hold never armed: the trainee never
   * settled on the mark (a rolling turn keeps head speed >= the arrival
   * bound and legitimately never arms) — a coachable fact about motion,
   * not a sensor claim. */
  | "never-settled"
  /** The head was already past TURN_COMMIT_DEG at the first accepted
   * post-open frame: the pivot happened inside the hold window and was
   * measured THERE as hold motion. */
  | "turned-in-hold"
  /** Window open, stream measured, no committed 180 on the head path
   * (e.g. backing down the runway facing the house). */
  | "no-turn"
  /** Committed mid-sweep when the walk/clock ended — truncation, never a
   * dark claim (the §B commit-latch-before-floor law). */
  | "walk-ended-mid-turn"
  /** The mark beat / turn span was not measurably tracked. */
  | "tracking-dark";

/** Which standing-head-height normalized this row's dip fraction — the M10
 *  ladder verbatim: "fit" = FIT baseline, "walk" = the first-0.5-s-of-walk
 *  head-height baseline, "ref" = the reference fallback (identity). */
export type TurnHeightSource = "fit" | "walk" | "ref";

/** Measured facts of the one 180. All head-path quantities (feet are not
 *  tracked); null sub-channels disclose themselves per field. */
export interface TurnStats {
  /** Walk-seconds of turn entry (round2). */
  startAtSec: number;
  /** Exit - entry on the head path, s (round2). */
  durationSec: number;
  /** Mode-scaled duration band stamps (round2) — the row grades itself. */
  durBandLoSec: number;
  durBandHiSec: number;
  /** True = the sweep provably began INSIDE the hold window (the first
   * accepted post-open frame was already past TURN_ENTER_DEG): the
   * measured span is the remainder from the hold release, so the duration
   * verdict and the whipped cue are suppressed and the copy labels the
   * remainder (adjudication §C). */
  entryClipped: boolean;
  /** Net unwrapped head-yaw sweep entry -> exit, deg (round1). */
  sweepDeg: number;
  /** Deadband-filtered sweep reversals (int) — see TURN_REV_DEADBAND_DEG. */
  reversalCount: number;
  /** netSweep / totalTravel on the filtered series, 0..1 (round3);
   * 1 = one motion, time-independent. */
  sweepMonotoneFrac: number;
  /** Deepest head-height dip below the WALK baseline, cm (round1) — the
   * raw number the copy cites. Null when the walk baseline never sampled
   * (no honest zero to dip from) or no height sample landed in-turn. */
  dipCm: number | null;
  /** dip / normalizing standing head height, meters over meters
   * (adjudication §A). round4 — NOT round3: the 0.0375 fault anchor is a
   * 4-decimal quantity round3 would destroy (0.038). Null with dipCm. */
  dipFrac: number | null;
  /** Normalizing standing head height, m (round3). Null with dipCm. */
  heightM: number | null;
  /** Per-row normalization stamp. Null with dipCm. */
  heightSource: TurnHeightSource | null;
  /** Fraction of measured turn time head pitch stayed within
   * M8_PITCH_BAND_DEG of M8's calibrated neutral (round3) — consumed from
   * the M8 raw tap; null when the tap never measured inside the turn. */
  pitchInBandFrac: number | null;
  /** Accepted yaw-seconds inside the turn (round2). */
  measuredSec: number;
  /** Turn exit -> the ENTRY of the first sustained under-bar stretch on
   * the return leg, s (round2). When reacquireCapped, the full return-leg
   * span (a floor, not a measurement — "never re-centered"). Null when
   * the return leg measured < TURN_RETURN_MIN_SEC. */
  reacquireSec: number | null;
  /** True = the centerline was never re-acquired before the finish. */
  reacquireCapped: boolean;
}

/**
 * The mode-scaled duration band (see TURN_DUR_BASE_HI_SEC): scale =
 * TURN_DUR_BASE_PACE_MPS / idealPaceMps, both edges stamped round2.
 * Computed table (the golden family pins these from THIS function):
 *   beginner    0.85: x1.000 -> [0.90, 2.22]
 *   highfashion 0.72: x1.181 -> [1.06, 2.62]
 *   commercial  0.95: x0.895 -> [0.81, 1.99]
 *   challenge   1.05: x0.810 -> [0.73, 1.80]
 * A non-finite/non-positive pace falls back to the reference band
 * (identity scale) — the tracker must never carry a NaN band. Allocates
 * one result object — called at walk start only, never per frame.
 */
export function turnDurBand(idealPaceMps: number): { lo: number; hi: number } {
  const scale =
    Number.isFinite(idealPaceMps) && idealPaceMps > 0
      ? TURN_DUR_BASE_PACE_MPS / idealPaceMps
      : 1;
  return {
    lo: round2(TURN_DUR_BASE_LO_SEC * scale),
    hi: round2(TURN_DUR_BASE_HI_SEC * scale),
  };
}

// ---------------------------------------------------------------------------
// The tracker.
// ---------------------------------------------------------------------------

// Machine phases (plain ints — scalar state, Swift-portable).
const PH_ARMED = 0; // watching devU (pre-open frames never reach the machine)
const PH_TURNING = 1; // provisional entry taken; commit latch inside
const PH_RETURN = 2; // exited; re-acquisition folds

/**
 * Per-walk turn tracker. The engine wiring (a later phase) feeds update()
 * every walk frame from the M8 block — REUSING the one getWorldQuaternion
 * read and the captured projectRoute scalars — and calls noteMark /
 * noteHoldArmed on the wiring's own edge latches (the poseBurst
 * durable-flag pattern; both are idempotent, first call wins). ShowDirector
 * finalizes at walk end with its first-0.5-s walk baseline (the ONE
 * baseline sampler, shared with the hold).
 *
 * Lifecycle (reset laws):
 * - walk start -> beginWalk(fit, oneWay, idealPace): full reset; FIT /
 *   topology / duration-band snapshot for the run (the mode-lock law).
 * - mid-walk remap -> resetRoute(oneWay): full machine re-arm (mark, arm,
 *   machine, every accumulator — a turn measured against the OLD geometry
 *   is discarded wholesale; the M10 last-window-wins law). The FIT + band
 *   snapshots are KEPT (the mode did not change), and the frozen-pose
 *   reference is kept too (the pose stream's identity did not change).
 * - camera<->head handoff -> NOTHING (the M8 arbitration-independence law:
 *   the headset stays on the head; resetCadence never touches this).
 * - one-way (U) routes: the machine never runs — finalize is null
 *   "one-way-route" (the roadmap's v1 ruling; a U has no 180).
 */
export class TurnTracker {
  // Walk-locked snapshots (beginWalk; band + fit survive resetRoute).
  private fitHeightM: number | null = null;
  private oneWay = false;
  private bandLo = TURN_DUR_BASE_LO_SEC;
  private bandHi = round2(TURN_DUR_BASE_HI_SEC);

  // Edge latches (idempotent; -1 = not yet).
  private markAt = -1;
  private armAt = -1;
  private windowOpen = -1;

  // Accepted-time accounting (the §B reason floors).
  private acceptedPostMarkSec = 0;
  private acceptedOpenSec = 0;

  // The machine.
  private phase = PH_ARMED;
  private firstOpenSeen = false;
  private turnedInHold = false;
  private committed = false;
  private entryClippedState = false;
  private entryAt = -1;
  private exitAt = -1;

  // Yaw-deviation unwrap state (post-open only; the hold-stats law:
  // frame-to-frame head rotation cannot exceed PI, so the +-2PI offset
  // branch only ever corrects the seam). Radians.
  private prevRawDev = 0;
  private devOffset = 0;
  private haveDev = false;

  // Zigzag state in p-space (p = devU * sweepSign, deg — progress toward
  // the exit): running max, the current retreat excursion's minimum, the
  // one-event-per-excursion trip latch, and the closed-retreat sum that
  // feeds totalTravel = net + 2 * retreatSum.
  private sweepSign = 1;
  private entryP = 0;
  private exitP = 0;
  private pMax = 0;
  private excMin = 0;
  private revTripped = false;
  private retreatSum = 0;
  private reversals = 0;

  // Sub-measure accumulators (accepted turn frames only).
  private measuredTurnSec = 0;
  private pitchSec = 0;
  private pitchInBandSec = 0;
  private dipEmaY = 0;
  private haveDipEma = false;
  private minEmaY = Infinity;

  // Return-leg re-acquisition state.
  private returnMeasSec = 0;
  private candStart = -1;
  private sustainAcc = 0;
  private reacqAt = -1;

  // The walk clock's last non-frozen gated frame (the capped-reacquire
  // span's end; frozen frames never extend a "measured" span).
  private lastWalkTime = -1;

  // Frozen-pose guard state: the last ACCEPTED input tuple
  // (qx, qy, qz, qw, lateralM, headYM) — recorded only when all six are
  // finite (dark frames never become the reference). The threat model is
  // hold-stats.ts's: tracking loss / VisibleBlurred with the loop still
  // running / a desktop preview's static camera all keep feeding one
  // bit-identical pose, and folding it would let a frozen stream complete
  // a turn or fake a re-acquisition.
  private lastQx = 0;
  private lastQy = 0;
  private lastQz = 0;
  private lastQw = 0;
  private lastLat = 0;
  private lastHeadY = 0;
  private haveLast = false;

  /** Construction-time scratch for the forward-ray extraction (zero
   * per-frame allocation). */
  private readonly fwd: HeadForward = makeHeadForward();

  /**
   * Arm for a new walk. `fitHeightM` = the trainee's FIT standing head
   * height (globals.bodyBaseline.standHeightM, peeked by the WIRING at the
   * synchronous setPhase("walk") moment) or null; `routeOneWay` = the
   * run's route topology (compiledPath.kind === "U"); `idealPaceMps` = the
   * walk-locked mode pace (metrics' this.idealPace — the mode-lock law).
   * All plain scalars: this module never reads a signal.
   */
  beginWalk(
    fitHeightM: number | null,
    routeOneWay: boolean,
    idealPaceMps: number,
  ): void {
    this.fitHeightM = fitHeightM;
    const band = turnDurBand(idealPaceMps);
    this.bandLo = band.lo;
    this.bandHi = band.hi;
    this.clearMachine(routeOneWay);
    this.haveLast = false; // frozen-pose guard re-arms per walk
    this.lastWalkTime = -1;
  }

  /**
   * Mid-walk remap: the route geometry (and possibly topology) moved under
   * the live walk — a half-measured turn against the OLD geometry is
   * discarded wholesale (the M10 last-window-wins law). FIT + band
   * snapshots are kept (the mode did not change); the frozen-pose
   * reference is kept (the pose stream's identity did not change).
   */
  resetRoute(routeOneWay: boolean): void {
    this.clearMachine(routeOneWay);
  }

  /** Everything that re-arms on beginWalk AND resetRoute. */
  private clearMachine(routeOneWay: boolean): void {
    this.oneWay = routeOneWay;
    this.markAt = -1;
    this.armAt = -1;
    this.windowOpen = -1;
    this.acceptedPostMarkSec = 0;
    this.acceptedOpenSec = 0;
    this.phase = PH_ARMED;
    this.firstOpenSeen = false;
    this.turnedInHold = false;
    this.committed = false;
    this.entryClippedState = false;
    this.entryAt = -1;
    this.exitAt = -1;
    this.prevRawDev = 0;
    this.devOffset = 0;
    this.haveDev = false;
    this.sweepSign = 1;
    this.entryP = 0;
    this.exitP = 0;
    this.pMax = 0;
    this.excMin = 0;
    this.revTripped = false;
    this.retreatSum = 0;
    this.reversals = 0;
    this.measuredTurnSec = 0;
    this.pitchSec = 0;
    this.pitchInBandSec = 0;
    this.dipEmaY = 0;
    this.haveDipEma = false;
    this.minEmaY = Infinity;
    this.returnMeasSec = 0;
    this.candStart = -1;
    this.sustainAcc = 0;
    this.reacqAt = -1;
  }

  /** The pose-mark edge (idempotent — first call wins): the wiring calls
   * this on ITS mark rising edge (the markAtWalkTime latch frame). Starts
   * the accepted post-mark accounting the §B reason floors read. */
  noteMark(walkTime: number): void {
    if (this.markAt < 0 && Number.isFinite(walkTime)) {
      this.markAt = walkTime;
    }
  }

  /** The hold ARMING edge (idempotent — first call wins): the wiring
   * edge-detects globals.holdArmed (observed at worst ONE FRAME after the
   * director's true arm — at or after the true hold close, never before).
   * Opens the turn window at armAt + HOLD_WINDOW_SEC (the beat partition).
   * Defensively latches the mark too: an armed hold implies a reached
   * mark, and the reason taxonomy must never read "never-marked" past it. */
  noteHoldArmed(walkTime: number): void {
    if (this.armAt < 0 && Number.isFinite(walkTime)) {
      this.armAt = walkTime;
      this.windowOpen = walkTime + HOLD_WINDOW_SEC;
      if (this.markAt < 0) this.markAt = walkTime;
    }
  }

  /**
   * One walk frame. Zero allocation; every input is a plain scalar the
   * wiring already holds (the one head-quaternion read, the captured
   * projectRoute scalars, the head world y, and M8's raw pitch tap).
   *
   * - `dt` = the ECS frame delta; `walkTime` = seconds since walk start
   *   (never PoseFrame.t — the wall-clock law).
   * - `qx..qw` = the head WORLD quaternion's raw components.
   * - `walkYawRad` = the active route segment heading (projectRoute().yaw,
   *   captured as a scalar — the reused-result law). The OUTBOUND facing:
   *   no return flip is ever applied here.
   * - `lateralM` = signed route lateral (the re-acquisition channel).
   * - `headYM` = head world height (the dip channel). NOT pre-filtered by
   *   the wiring (boundary law: each tracker owns its own gates).
   * - `pitchDevDeg` = CarriageTracker.liveRawPitchDevDeg (null = tap dark).
   *
   * GUARDS (the Wave 1 law, in order):
   * 1. whole-frame gate: non-finite/<= 0 dt or non-finite walkTime.
   * 2. FROZEN-POSE guard: the (qx,qy,qz,qw,lateralM,headYM) tuple
   *    bit-equal to the last accepted tuple -> zero weight everywhere;
   *    the sustain candidate and dip EMA hold; the machine never advances.
   *    Runs BEFORE any state advance, so a frozen stream can never
   *    complete a turn or fake a re-acquisition.
   * 3. per-channel dark gates: non-finite quat / horiz < M8_MIN_HORIZ /
   *    non-finite walkYawRad -> yaw-dark (no machine advance, no accepted
   *    seconds); non-finite lateralM -> re-acquisition fold skipped +
   *    candidate reset; non-finite headYM -> dip fold skipped; null or
   *    non-finite pitchDevDeg -> pitch fold skipped. NaN never enters a
   *    fold.
   */
  update(
    dt: number,
    walkTime: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    walkYawRad: number,
    lateralM: number,
    headYM: number,
    pitchDevDeg: number | null,
  ): void {
    if (!(Number.isFinite(dt) && dt > 0 && Number.isFinite(walkTime))) return;
    if (this.oneWay) return; // no 180 exists on a U — the machine is dark

    // Frozen-pose guard (before any state advance).
    if (
      this.haveLast &&
      qx === this.lastQx &&
      qy === this.lastQy &&
      qz === this.lastQz &&
      qw === this.lastQw &&
      lateralM === this.lastLat &&
      headYM === this.lastHeadY
    ) {
      return;
    }
    // Record the reference — accepted (all-finite) tuples only; a dark
    // frame never becomes the reference.
    if (
      Number.isFinite(qx) &&
      Number.isFinite(qy) &&
      Number.isFinite(qz) &&
      Number.isFinite(qw) &&
      Number.isFinite(lateralM) &&
      Number.isFinite(headYM)
    ) {
      this.lastQx = qx;
      this.lastQy = qy;
      this.lastQz = qz;
      this.lastQw = qw;
      this.lastLat = lateralM;
      this.lastHeadY = headYM;
      this.haveLast = true;
    }
    this.lastWalkTime = walkTime;

    // Yaw acceptance (per-channel gate — the M8 criterion: finite quat,
    // measurable horizontal forward, finite heading).
    let yawOk = false;
    let rawDev = 0;
    if (
      Number.isFinite(qx) &&
      Number.isFinite(qy) &&
      Number.isFinite(qz) &&
      Number.isFinite(qw) &&
      Number.isFinite(walkYawRad)
    ) {
      const f = headForward(qx, qy, qz, qw, this.fwd);
      if (f.horiz >= M8_MIN_HORIZ) {
        // Signed yaw deviation vs the OUTBOUND heading — the exact M8
        // convention (head-carriage.ts): heading unit vector
        // (hx, hz) = (-sin psi, -cos psi) in the runway frame
        // (yaw-0 forward = (0, 0, -1)), error = atan2(cross, dot).
        const hx = -Math.sin(walkYawRad);
        const hz = -Math.cos(walkYawRad);
        rawDev = Math.atan2(f.z * hx - f.x * hz, f.x * hx + f.z * hz);
        yawOk = true;
      }
    }

    // Accepted post-mark seconds (the never-settled vs tracking-dark
    // discriminator, adjudication §B) — counted from the mark on,
    // window or no window.
    if (this.markAt >= 0 && yawOk) {
      this.acceptedPostMarkSec += dt;
    }

    // Nothing below runs until the turn window is OPEN (the hold owns its
    // claim on the beat; pre-open frames feed only the guard reference and
    // the post-mark accounting above).
    if (this.armAt < 0 || walkTime <= this.windowOpen) return;

    // The straddle frame at the open is trimmed to its post-open portion
    // (adjudication §H) — zero shared time with the hold by construction.
    const sinceOpen = walkTime - this.windowOpen;
    const dtEff = dt < sinceOpen ? dt : sinceOpen;

    // Return-leg re-acquisition folds on the LATERAL channel (yaw not
    // required); the exit frame itself belongs to the turn, so the fold
    // starts on the next frame (exitedThisFrame below).
    let exitedThisFrame = false;

    if (yawOk) {
      // Unwrap (seeded at the first accepted post-open frame; the +-2PI
      // branch only ever corrects the seam — hold-stats.ts law).
      if (this.haveDev) {
        const d = rawDev - this.prevRawDev;
        if (d > Math.PI) this.devOffset -= 2 * Math.PI;
        else if (d < -Math.PI) this.devOffset += 2 * Math.PI;
      }
      this.prevRawDev = rawDev;
      this.haveDev = true;
      const devUDeg = (rawDev + this.devOffset) * RAD2DEG;
      const absDev = devUDeg < 0 ? -devUDeg : devUDeg;

      this.acceptedOpenSec += dtEff;

      // First accepted post-open frame: the entry-clipped / turned-in-hold
      // discrimination (adjudication §C). Past COMMIT = the pivot happened
      // inside the hold window (terminal null); past ENTER = the sweep
      // began inside it, measure the remainder with the clipped stamp.
      if (!this.firstOpenSeen) {
        this.firstOpenSeen = true;
        if (absDev >= TURN_COMMIT_DEG) {
          this.turnedInHold = true;
        } else if (absDev >= TURN_ENTER_DEG) {
          this.enterTurn(walkTime, devUDeg, true);
        }
      } else if (
        !this.turnedInHold &&
        this.phase === PH_ARMED &&
        absDev >= TURN_ENTER_DEG
      ) {
        this.enterTurn(walkTime, devUDeg, false);
      }

      if (!this.turnedInHold && this.phase === PH_TURNING) {
        // ABORT (provisional only): back below the enter gate = it was a
        // glance/wander, not a turn — discard the stretch wholesale
        // (incl. the clipped stamp: the sweep did NOT begin in the hold
        // after all) and fold nothing this frame.
        if (!this.committed && absDev < TURN_ENTER_DEG) {
          this.phase = PH_ARMED;
          this.entryClippedState = false;
        } else {
          // Zigzag on p = devU * sweepSign (progress toward the exit).
          const p = devUDeg * this.sweepSign;
          if (p >= this.pMax) {
            if (this.revTripped) {
              // Excursion recovered: close it into the travel sum.
              this.retreatSum += this.pMax - this.excMin;
              this.revTripped = false;
            }
            this.pMax = p;
            this.excMin = p;
          } else {
            if (p < this.excMin) this.excMin = p;
            if (
              !this.revTripped &&
              this.pMax - p >= TURN_REV_DEADBAND_DEG
            ) {
              this.reversals++;
              this.revTripped = true;
            }
          }

          if (absDev >= TURN_COMMIT_DEG) this.committed = true;

          // Sub-measure folds (accepted turn frames only; dtEff so the
          // open-straddle entry frame never double-claims hold time).
          this.measuredTurnSec += dtEff;
          if (pitchDevDeg !== null && Number.isFinite(pitchDevDeg)) {
            this.pitchSec += dtEff;
            if (
              pitchDevDeg >= -M8_PITCH_BAND_DEG &&
              pitchDevDeg <= M8_PITCH_BAND_DEG
            ) {
              this.pitchInBandSec += dtEff;
            }
          }
          if (Number.isFinite(headYM)) {
            if (this.haveDipEma) {
              this.dipEmaY +=
                (headYM - this.dipEmaY) *
                (1 - Math.exp(-TURN_DIP_EMA_RATE * dtEff));
            } else {
              this.dipEmaY = headYM; // seeded, never 0-seeded
              this.haveDipEma = true;
            }
            if (this.dipEmaY < this.minEmaY) this.minEmaY = this.dipEmaY;
          }

          // EXIT: within the enter band of the RETURN heading. Commit is
          // implied (TURN_EXIT_DEG > TURN_COMMIT_DEG). Close any open
          // retreat excursion (tripped implies depth >= the deadband).
          if (absDev >= TURN_EXIT_DEG) {
            if (this.revTripped) {
              this.retreatSum += this.pMax - this.excMin;
              this.revTripped = false;
            }
            this.exitAt = walkTime;
            this.exitP = p;
            this.phase = PH_RETURN;
            exitedThisFrame = true;
          }
        }
      }
    }

    // Return leg: accepted-LATERAL frames fold the re-acquisition read.
    if (this.phase === PH_RETURN && !exitedThisFrame) {
      if (Number.isFinite(lateralM)) {
        this.returnMeasSec += dt;
        if (this.reacqAt < 0) {
          const absLat = lateralM < 0 ? -lateralM : lateralM;
          if (absLat <= TURN_REACQ_BAR_M) {
            if (this.candStart < 0) {
              // Stretch ENTRY = this frame's start, clamped to the exit
              // (an on-the-line exit reads 0.0 legitimately). Seed the
              // sustain with ONLY the post-exit slice of this (possibly
              // straddling) frame: candStart is clamped to exitAt, so a
              // mid-frame exit's pre-exit time must not count toward the
              // sustain gate — the dtEff straddle-trim already used at the
              // turn-window entry (lines 679/699/754). A non-straddle frame
              // reads candStart = walkTime - dt, so walkTime - candStart = dt
              // and the credit is unchanged.
              const start = walkTime - dt;
              this.candStart = start > this.exitAt ? start : this.exitAt;
              this.sustainAcc = walkTime - this.candStart;
            } else {
              this.sustainAcc += dt;
            }
            if (this.sustainAcc >= TURN_REACQ_SUSTAIN_SEC) {
              this.reacqAt = this.candStart;
            }
          } else {
            this.candStart = -1;
            this.sustainAcc = 0;
          }
        }
      } else {
        // A dark lateral frame breaks the evidence — candidate reset.
        this.candStart = -1;
        this.sustainAcc = 0;
      }
    }
  }

  /** Provisional turn entry: seed the zigzag and every sub-measure fresh
   * (an aborted stretch was discarded wholesale before re-entry). */
  private enterTurn(
    walkTime: number,
    devUDeg: number,
    clipped: boolean,
  ): void {
    this.phase = PH_TURNING;
    this.committed = false;
    this.entryClippedState = clipped;
    this.entryAt = walkTime;
    this.sweepSign = devUDeg >= 0 ? 1 : -1;
    this.entryP = devUDeg * this.sweepSign;
    this.pMax = this.entryP;
    this.excMin = this.entryP;
    this.revTripped = false;
    this.retreatSum = 0;
    this.reversals = 0;
    this.measuredTurnSec = 0;
    this.pitchSec = 0;
    this.pitchInBandSec = 0;
    this.dipEmaY = 0;
    this.haveDipEma = false;
    this.minEmaY = Infinity;
  }

  /**
   * Freeze the walk into a TurnStats — non-null ONLY when a full sweep was
   * measured (entry -> exit on the head path); nullReason() says why not.
   * Non-destructive and re-callable (the walk-stats finalize law).
   *
   * `walkBaseHeadYM` is the director's first-0.5-s-of-walk mean head
   * height (the ONE baseline sampler, shared with the hold finalize) or
   * null when the walk never sampled it. Two roles, two references
   * (disclosed): the DIP DELTA is measured against the walk baseline —
   * FIT height is STANDING height, ~2-3 cm above walking head height, so
   * using it as the dip ZERO would fabricate ~2 cm of dip on every
   * FIT-stamped walk; with no walk baseline the dip channel is null (no
   * honest zero to dip from). The NORMALIZING height (the fraction's
   * denominator — a unit choice that cancels per body) uses the M10
   * ladder verbatim: FIT -> walk baseline above HOLD_STAND_MIN_M ->
   * HOLD_REF_HEAD_M ("ref", identity, disclosed), stamped per row.
   */
  finalize(walkBaseHeadYM: number | null): TurnStats | null {
    if (this.exitAt < 0) return null;

    const net = this.exitP - this.entryP;
    const total = net + 2 * this.retreatSum;
    let frac = total > 0 ? net / total : 1;
    if (frac < 0) frac = 0;
    else if (frac > 1) frac = 1;

    let dipCm: number | null = null;
    let dipFrac: number | null = null;
    let heightM: number | null = null;
    let heightSource: TurnHeightSource | null = null;
    if (
      walkBaseHeadYM !== null &&
      Number.isFinite(walkBaseHeadYM) &&
      this.minEmaY < Infinity
    ) {
      const dipM =
        walkBaseHeadYM - this.minEmaY > 0 ? walkBaseHeadYM - this.minEmaY : 0;
      let hM = HOLD_REF_HEAD_M;
      let src: TurnHeightSource = "ref";
      if (
        this.fitHeightM !== null &&
        Number.isFinite(this.fitHeightM) &&
        this.fitHeightM > 0
      ) {
        hM = this.fitHeightM;
        src = "fit";
      } else if (walkBaseHeadYM > HOLD_STAND_MIN_M) {
        hM = walkBaseHeadYM;
        src = "walk";
      }
      dipCm = round1(dipM * 100);
      dipFrac = round4(dipM / hM); // meters over meters (adjudication §A)
      heightM = round3(hM);
      heightSource = src;
    }

    let reacquireSec: number | null = null;
    let reacquireCapped = false;
    if (this.reacqAt >= 0) {
      reacquireSec = round2(this.reacqAt - this.exitAt);
    } else if (this.returnMeasSec >= TURN_RETURN_MIN_SEC) {
      // Never re-centered: the full return-leg span is a FLOOR, disclosed.
      const span = this.lastWalkTime - this.exitAt;
      reacquireSec = round2(span > 0 ? span : 0);
      reacquireCapped = true;
    }

    return {
      startAtSec: round2(this.entryAt),
      durationSec: round2(this.exitAt - this.entryAt),
      durBandLoSec: this.bandLo,
      durBandHiSec: this.bandHi,
      entryClipped: this.entryClippedState,
      sweepDeg: round1(net),
      reversalCount: this.reversals,
      sweepMonotoneFrac: round3(frac),
      dipCm,
      dipFrac,
      heightM,
      heightSource,
      pitchInBandFrac:
        this.pitchSec > 0 ? round3(this.pitchInBandSec / this.pitchSec) : null,
      measuredSec: round2(this.measuredTurnSec),
      reacquireSec,
      reacquireCapped,
    };
  }

  /**
   * Why finalize() returned null — meaningful ONLY when it did. First
   * match wins (adjudication §B ordering: the COMMIT latch outranks the
   * min-measured floor — a committed turn truncated by the walk clock is
   * a truncation fact, never a dark claim; and the never-settled vs
   * tracking-dark split reads THIS tracker's own accepted post-mark
   * seconds, never the hold's null reason).
   */
  nullReason(): TurnNullReason {
    if (this.oneWay) return "one-way-route";
    if (this.markAt < 0) return "never-marked";
    if (this.armAt < 0) {
      // No window ever opened. Live post-mark stream = the trainee never
      // settled (a rolling turn keeps head speed above the arrival bound
      // and legitimately never arms the hold); ~zero accepted post-mark
      // seconds = the mark beat itself was unmeasurable.
      return this.acceptedPostMarkSec < TURN_MIN_MEASURED_SEC
        ? "tracking-dark"
        : "never-settled";
    }
    if (this.phase === PH_TURNING && this.committed) {
      return "walk-ended-mid-turn";
    }
    if (this.acceptedOpenSec < TURN_MIN_MEASURED_SEC) return "tracking-dark";
    if (this.turnedInHold) return "turned-in-hold";
    return "no-turn";
  }
}

// ---------------------------------------------------------------------------
// Copy (ASCII punctuation only — every string enters the panel-ascii sweep).
// Parked HERE (not coach.ts / coach-copy.ts — the M10 rule): keeps the
// shared coach tables and their Swift string mirrors untouched.
// ---------------------------------------------------------------------------

/**
 * Landing tooltip / explainer row — templated from the constants so the
 * disclosure can never drift from the math. Head path, never foot pivot.
 */
export const TURN_EXPLAIN =
  `Measured from the headset between the end of the ` +
  `${HOLD_WINDOW_SEC.toFixed(1)} s hold window and the moment your head ` +
  `faces the walk home - head path through the turn, not foot pivot; feet ` +
  `are not tracked. Sweep-backs count reversals of the head's yaw sweep ` +
  `bigger than ${TURN_REV_DEADBAND_DEG} deg. The dip is your lowest head ` +
  `height vs your walking baseline. Line re-acquisition is the time until ` +
  `you hold within ${TURN_REACQ_BAR_M.toFixed(2)} m of the centerline on ` +
  `the way home.`;

/**
 * The turn-aware M7 presentation explainer (adjudication §I: ADDITIVE,
 * never in-place — coach.ts and METRIC_EXPLAIN.presentation are NOT
 * touched; the legacy "the turn is not analyzed" text stays true for any
 * walk without a turn read). The summary surfaces branch AT RENDER on the
 * per-walk stamp: summary.turn != null -> THIS string; else the legacy
 * table text. Honest by construction: the turn row exists AND the
 * presentation composite still does not consume it (folding new channels
 * into composites is a reserved founder call).
 */
export const PRESENTATION_EXPLAIN_WITH_TURN =
  "Composite read: all four measured channels blended, posture and rhythm weighted heaviest. It is not separately measured - your turn is analyzed separately in the TURN row and does not feed this score.";

/** "ONE MOTION" | "1 SWEEP-BACK" | "{n} SWEEP-BACKS". */
function sweepBacksLabel(n: number): string {
  if (n <= 0) return "ONE MOTION";
  if (n === 1) return "1 SWEEP-BACK";
  return `${n} SWEEP-BACKS`;
}

/**
 * Summary stat line (XR panel node "sum-turn" + the landing card). The
 * null branch REQUIRES the reason — different facts never share a
 * sentence. Segments disclose per sub-channel: DIP omitted when the dip
 * channel is null; LINE omitted when the return leg went unmeasured;
 * capped renders the NOT RE-CENTERED form. An entry-clipped turn labels
 * its remainder (adjudication §C: "measured from the hold release").
 *
 * `sep` law = walkStatLine (coach.ts): the ASCII " - " default is a PANEL
 * constraint (the XR font has no middle-dot glyph); the DOM landing passes
 * " · " for its own typography.
 */
export function turnStatLine(
  t: TurnStats | null,
  reason: TurnNullReason,
  sep: string = " - ",
): string {
  if (t === null) {
    switch (reason) {
      case "one-way-route":
        return "TURN: NO TURN ON A ONE-WAY ROUTE";
      case "never-marked":
        return "TURN: NO READ - THE WALK ENDED BEFORE THE MARK";
      case "never-settled":
        return "TURN: NO READ - YOU NEVER SETTLED ON THE MARK";
      case "turned-in-hold":
        return "TURN: NO READ - THE TURN HAPPENED INSIDE THE HOLD WINDOW";
      case "no-turn":
        return "TURN: NO READ - NO 180 TURN ON THE HEAD PATH";
      case "walk-ended-mid-turn":
        return "TURN: NO READ - THE WALK ENDED MID-TURN";
      case "tracking-dark":
        return "TURN: NO READ - TRACKING WENT DARK AT THE MARK";
    }
  }
  let line = `TURN ${t.durationSec.toFixed(1)}S`;
  if (t.entryClipped) line += " FROM THE HOLD RELEASE";
  line += `${sep}${sweepBacksLabel(t.reversalCount)}`;
  if (t.dipCm !== null) {
    line += `${sep}DIP ${Math.round(t.dipCm)} CM`;
  }
  if (t.reacquireSec !== null) {
    line += t.reacquireCapped
      ? `${sep}LINE NOT RE-CENTERED`
      : `${sep}LINE IN ${t.reacquireSec.toFixed(1)}S`;
  }
  return line;
}

/**
 * Post-walk coach note — cites only measured counts / seconds / cm; head
 * path, never foot pivot; never style or poise. Selection order (the dip
 * first — the roadmap calls collapsing into the turn THE classic fault;
 * then the discrete count; then duration; then the line):
 * 1. dip fault (dipFrac >= TURN_DIP_FAULT_FRAC — the per-body band; the
 *    cited number is the RAW cm).
 * 2. sweep-backs (1 / n).
 * 3. duration vs the stamped band — SUPPRESSED when entryClipped (the
 *    measured span is a remainder; a whip/slow verdict on it would be
 *    fabricated — adjudication §C).
 * 4. the line: never re-centered (capped), or re-acquired slower than
 *    TURN_REACQ_CUE_SEC.
 * 5. clean — claimed only when every clause was MEASURED clean: no
 *    sweep-backs, duration in band (so never on a clipped turn), the dip
 *    measured under the fault line (an unmeasured dip cannot back "level
 *    all the way round" — the honesty law), and the line re-acquired
 *    under the cue line.
 * 6. else null (between bands: no claim — the M10 law).
 * Null-reason cues: only the coachable motion facts speak
 * (turned-in-hold, walk-ended-mid-turn, no-turn); one-way / never-marked /
 * tracking-dark / never-settled return null — the row line carries the
 * disclosure alone, and the hold's own cue already narrates the mark
 * facts (never-settled would double-narrate holdCue's no-data sentence).
 */
export function turnCue(
  t: TurnStats | null,
  reason: TurnNullReason,
): string | null {
  if (t === null) {
    switch (reason) {
      case "turned-in-hold":
        return "You turned inside the hold beat - freeze for the count, then turn.";
      case "walk-ended-mid-turn":
        return "The walk ended mid-turn - finish the turn and bring it home.";
      case "no-turn":
        return "No 180 showed on the head path - turn at the mark and face the walk home.";
      default:
        return null;
    }
  }
  if (
    t.dipFrac !== null &&
    t.dipCm !== null &&
    t.dipFrac >= TURN_DIP_FAULT_FRAC
  ) {
    return `You sank ${Math.round(t.dipCm)} cm through the turn - stay tall as you come around.`;
  }
  if (t.reversalCount === 1) {
    return "Your head swept back once mid-turn - one motion, commit the turn.";
  }
  if (t.reversalCount >= 2) {
    return `Your head swept back ${t.reversalCount} times mid-turn - one motion, commit the turn.`;
  }
  if (!t.entryClipped) {
    if (t.durationSec > t.durBandHiSec) {
      return `The turn took ${t.durationSec.toFixed(1)} s - hit the mark, turn, and go.`;
    }
    if (t.durationSec < t.durBandLoSec) {
      return `You whipped the turn in ${t.durationSec.toFixed(1)} s - give it one controlled beat.`;
    }
  }
  if (t.reacquireSec !== null && t.reacquireCapped) {
    return "You never got back on the line after the turn - find center, then drive home.";
  }
  if (
    t.reacquireSec !== null &&
    !t.reacquireCapped &&
    t.reacquireSec >= TURN_REACQ_CUE_SEC
  ) {
    return `It took ${t.reacquireSec.toFixed(1)} s to find the line again after the turn - square up and go.`;
  }
  if (
    !t.entryClipped &&
    t.reversalCount === 0 &&
    t.durationSec >= t.durBandLoSec &&
    t.durationSec <= t.durBandHiSec &&
    t.dipFrac !== null &&
    t.dipFrac < TURN_DIP_FAULT_FRAC &&
    t.reacquireSec !== null &&
    !t.reacquireCapped &&
    t.reacquireSec < TURN_REACQ_CUE_SEC
  ) {
    return `One motion in ${t.durationSec.toFixed(1)} s, level all the way round - a clean turn.`;
  }
  return null;
}
