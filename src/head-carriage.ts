/**
 * (X)RUNWAY — M8 HEAD CARRIAGE: the head-orientation discipline channel
 * (Wave 1, docs/EDGE-ROADMAP.md Lens 1; spec wave1-spec-m8.md; adjudication
 * §B/§D/§K binding).
 *
 * Pure per-walk tracker + summary contract for the quantity the headset
 * measures every frame and the app previously threw away: the head's WORLD
 * orientation. Three honest reads come out of it:
 * - CHIN LEVEL: fraction of measured walk time the head pitch stayed within
 *   M8_PITCH_BAND_DEG of a calibrated neutral (countdown stand, with a FIT
 *   and a first-0.5s-of-walk fallback — see beginWalk).
 * - FACING ON LINE: fraction of yaw-measurable time the head faced within
 *   M8_YAW_BAND_DEG of the active walk-route heading (flipped on the return
 *   leg of an out-and-back walk; dark through the turn/pose window).
 * - HEAD DROPS: discrete dips below M8_GLANCE_PITCH_DEG, one per dip
 *   (hysteresis) — counted and narrated, never double-charged to the score.
 *
 * HONESTY LAW (both adversaries' binding label rule): this channel measures
 * HEAD CARRIAGE — head orientation, never gaze/eye contact. Eyes are not
 * tracked; every string this module builds says so or stays silent about
 * eyes. + pitch = head pitch above neutral (head orientation, not gaze).
 *
 * MetricsSystem wiring (a later phase) feeds `update()` every walk frame
 * regardless of which derive path owns M1-M4 — the headset stays on the
 * trainee's head even when an external camera owns the quality scores —
 * and applies `blendPresence` as a post-blend on target[4] (adjudication §B:
 * the blend is a pure one-shot here; idempotence against repeated cached
 * frames is the wiring's `legacyPresence` latch, never this function).
 *
 * Quaternion -> forward extraction is IMPORTED from head-orient.ts
 * (adjudication §D: one pure extraction, two consumers — M8 here and the
 * M10 hold). This module never re-derives the quaternion math; it owns the
 * carriage-specific semantics on top (neutral, bands, glances, yaw error
 * vs a heading).
 *
 * Dependency-free by design (no @iwsdk/core, no DOM; type-only imports) so
 * the golden-vector generator and vitest import the REAL code — the
 * walk-stats.ts / pose-derive.ts pattern. Zero per-frame allocation: all
 * tracker state is plain number/boolean fields plus one HeadForward scratch
 * allocated at construction; the only allocations are finalize() /
 * carriageLine() / carriagePresenceCue() / applyCarriageNotes() at walk end.
 * PoseFrame.t is never consumed (wall-clock law) — the tracker runs on the
 * caller's ECS frame delta and walk clock exclusively.
 */

import type { CoachNote, CoachReport } from "./coach.js";
import {
  headForward,
  makeHeadForward,
  pitchOf,
  type HeadForward,
} from "./head-orient.js";
import { clampScore, SCORE_MAX, SCORE_MIN } from "./pose-derive.js";

const RAD2DEG = 180 / Math.PI;

// ---------------------------------------------------------------------------
// Constants (every one carries its derivation — the SOLO_POSTURE_SLOPE law).
// ---------------------------------------------------------------------------

/**
 * Chin-level band (deg, either side of the calibrated neutral). Two anchors:
 * (a) Noise floor: locomotion pitches the head-in-space ~+-2-3 deg around
 * neutral (the same vestibulocollic stabilization that produces the ~1 cm
 * bob metrics.ts detrends at BOB_THRESHOLD), and a countdown stand estimates
 * the WALK neutral with ~+-2 deg of stand-vs-walk offset — worst-case
 * clean-walk excursion ~5 deg, and the band must hold a clean walk in-band
 * essentially 100% of the time: 7 = 5 + 2 margin.
 * (b) Ergonomic meaning: from ~1.6 m headset eye height a chin 7 deg below
 * level points the head-forward ray at the floor 1.6/tan(7 deg) ~ 13 m out —
 * still past the far end of even a doubled default deck (deckLength 7 m,
 * theme.ts). Inside 7 deg the head can honestly be "on the back wall"; past
 * it the head has committed to the deck.
 * Cross-check vs the head-drop line: 7 < 15/2, so the band edge and the drop
 * threshold cannot merge through the +-3 deg gait oscillation.
 */
export const M8_PITCH_BAND_DEG = 7;

/**
 * Facing-on-line band (deg, either side of the walk heading). Legitimate,
 * non-fault facing deviation is the sum of:
 * (a) gait yaw oscillation of the head, ~+-3-4 deg;
 * (b) honest line-correction heading: closing a centerline error the footwork
 * channel itself only cues at 0.20 m (LATERAL_CUE_M, coach-live.ts) over a
 * stride pair ~1.5 m of travel points the body atan(0.20/1.5) ~ 7.6 deg off
 * the segment heading — facing where you are walking is not a carriage fault.
 * Sum ~11.5 -> 12. Meaning check: at 12 deg with ~7 m of deck remaining the
 * facing point is 7 * tan(12 deg) ~ 1.5 m off-axis — beyond the whole default
 * half-width (deckWidth 1.4 m / 2, theme.ts), i.e. facing OFF the runway
 * entirely; sustained, that is the fault coaches call.
 */
export const M8_YAW_BAND_DEG = 12;

/**
 * HEAD DROP trip line (deg pitch vs neutral, negative = below). A floor
 * point 1-3 m ahead from ~1.6 m eye height is a gaze declination of
 * atan(1.6/3) = 28 deg to atan(1.6/1) = 58 deg; for shifts this large the
 * HEAD carries roughly half the amplitude (eye-head coordination, head gain
 * ~0.5-0.7), so a genuine floor check drags head pitch to about -14..-30
 * deg. -15 is the committed-to-the-floor onset. We count the HEAD DROP
 * (honest, measured) and never claim where the eyes were.
 */
export const M8_GLANCE_PITCH_DEG = -15;

/**
 * HEAD DROP re-arm line (deg): one dip = one event — the counter trips
 * crossing below M8_GLANCE_PITCH_DEG and re-arms only ABOVE this. The 5 deg
 * gap is ~2x the +-3 deg gait pitch oscillation, so bobbing ON the trip line
 * cannot double-count; the re-arm (-10) stays below the -7 band edge, so a
 * counted drop still honestly costs pitch-band time for its full duration
 * (events narrate, time-in-band scores — no double penalty in the score).
 */
export const M8_GLANCE_REARM_DEG = -10;

/**
 * Yaw turn window (s after the mark on out-and-back routes). Carries
 * TURN_SUPPRESS_SEC's derivation verbatim (coach-live.ts): the window after
 * reachedMark covers the pose beat + the physical 180 (the HUD's "Turn
 * around" prompt itself holds 3 s). Same trigger (the poseBurst mark latch),
 * same clock (walk seconds). During it the yaw channel is DARK (no in-band,
 * no measured time — the pivot can never count against carriage); pitch
 * keeps measuring (chin-level-through-the-turn is a real, body-relative
 * read; M11 refines the turn in Wave 2). One-way (U) routes stay suppressed
 * from the mark to the walk's end — the walk ends at the mark after
 * POSE_HOLD_SEC and scanning at the pose is the documented beat, not a
 * carriage fault (the coach-live one-way rule). The wiring computes the
 * suppression from this constant; the tracker only receives the flag.
 */
export const M8_TURN_EXCLUDE_SEC = 4;

/**
 * Minimum seconds of measured pitch time before the channel ENGAGES (s).
 * 2 s = RAMP_IN_SEC (metrics-wiring.ts): the display layer already defines
 * the first 2 s as incomplete data. ONE criterion gates both the M5 blend
 * (wiring reads `engaged`) and finalize()'s non-null, so the score and the
 * record can never disagree about whether carriage was measured
 * (engaged <=> carriage != null on the summary).
 */
export const M8_ENGAGE_SEC = 2;

/**
 * Walk-fallback neutral window (s) — the baselineY law verbatim
 * (metrics.ts: posture baseline = mean head y over the first 0.5 s of walk,
 * including the first-sample seed when the window never landed a sample).
 * Used only when neither the countdown stand nor a FIT baseline produced a
 * sane neutral.
 */
export const M8_NEUTRAL_FALLBACK_SEC = 0.5;

/**
 * Neutral sanity gate (deg, |mean|). Natural standing head pitch varies a
 * few degrees around level (craniovertebral variation ~+-8 deg); reading a
 * panel/wrist is >= ~20 deg down. |mean| > 12 deg means the stand was not a
 * neutral stand — discard it and fall through the neutral chain. Applied to
 * BOTH the countdown-stand mean and a supplied FIT neutral (one law: a
 * non-neutral calibration is discarded wherever it came from).
 */
export const M8_NEUTRAL_SANE_DEG = 12;

/**
 * Countdown-stand speed gate (m/s): stand samples with head speed at or
 * above this are approach motion, not standing. Standing-sway head speed is
 * < ~0.1 m/s while the slowest mode's walk pace is 0.72 m/s (modes.ts) —
 * 0.3 sits 3x above sway and under half the slowest walk, so approach steps
 * during the countdown never bias the neutral.
 */
export const M8_STAND_SPEED_MAX_MPS = 0.3;

/**
 * Yaw measurability gate on the forward ray's horizontal magnitude
 * hLen = hypot(fx, fz) = cos(pitch). Facing has no meaning near straight
 * up/down; gate yaw sampling on hLen >= 0.35, i.e. |pitch| <= acos(0.35)
 * ~ 69.5 deg. Every carriage-relevant pitch is far inside it (the head-drop
 * line -15 deg keeps hLen = cos 15 ~ 0.97), so the gate only darkens
 * genuinely degenerate frames (inspecting the ceiling / own shoes at the
 * mark). A gated frame counts as yaw-dark: no in-band, no measured time.
 * (head-orient.ts computes `horiz` for exactly this; each consumer owns its
 * own gate value — the M10 hold gates elsewhere at sin 5 deg.)
 */
export const M8_MIN_HORIZ = 0.35;

/**
 * Live-tap EMA rate — the heightDevEma/latEma fold-rate convention
 * (metrics.ts, frame-rate-independent form 1 - exp(-1.5 * dt)). Applies
 * ONLY to the recorder/live taps (livePitchDevDeg/liveYawDevDeg); the
 * in-band integrals and the drop detector run on RAW per-frame values — a
 * head drop is a fast event an EMA at 1.5 would smear below threshold (a
 * 0.5 s dip to -25 deg folds to only -13 deg), and time-in-band is already
 * an integral (inherently smooth).
 */
export const M8_EMA_RATE = 1.5;

/**
 * Minimum yaw-measured seconds before yawInBandFrac is reported (else
 * null): one full gait cycle (~1.1 s at the 1.8 Hz reference gait used
 * across the codebase, pose-derive.ts) — under a cycle a fraction is a coin
 * flip, and null is the honest answer.
 */
export const M8_YAW_MIN_SEC = 1;

/**
 * Pitch share of the combined in-band fraction fc = 0.6 * pitchFrac +
 * 0.4 * yawFrac (fc = pitchFrac when yaw never measured — disclosed).
 * 0.6/0.4: the chin is the #1 coached correction (roadmap ruling) AND the
 * pitch channel measures through the turn/pose windows where yaw is dark,
 * so it carries more measured time; 0.4 keeps a wandering head from hiding
 * behind a level chin. Head drops are NOT separately subtracted — a drop
 * already costs its full duration of pitch-band time (events narrate, time
 * scores).
 */
export const M8_PITCH_FRAC_WEIGHT = 0.6;

/**
 * Measured-carriage share of the M5 presence blend:
 *   presence' = 0.75 * (0.4*cPosture + 0.3*cRhythm + 0.3*cPace)
 *             + 0.25 * carriageScore
 *             = 0.30*cPosture + 0.225*cRhythm + 0.225*cPace
 *             + 0.25*carriageScore
 * W = 0.25 is the unique 0.05-step satisfying BOTH constraints:
 * (a) posture stays the single heaviest ingredient (0.30 > 0.25) —
 * preserves the existing disclosure shape ("posture counting most") and
 * bounds the trend discontinuity; W = 0.30 would make carriage the heaviest
 * (0.30 vs 0.28).
 * (b) carriage outweighs every non-posture ingredient (0.25 > 0.225) — the
 * roadmap's ruling that carriage is the closest honest presence proxy in
 * the rig; W = 0.20 would rank it below rhythm/pace (0.20 < 0.24).
 * Bound on the change: |presence' - presence| = 0.25 * |carriageScore -
 * presence| <= 0.25 * 58 = 14.5 pts absolute worst case; a clean walk moves
 * ~0 (both composites sit at their caps). Rows scored with the blend are
 * detectable forever: `carriage != null` on the row IS the stamp.
 */
export const M8_PRESENCE_WEIGHT = 0.25;

/**
 * Yaw directional-cue qualify guard (% of yaw-measured time off-line).
 * Below 25% off-line, yaw drags fc by at most 0.4 * 0.25 = 0.10 -> 5.8
 * score points — real but not the walk's story; the generic presence cue
 * serves better. Mirrors the cm < 1 / same-rendered-number guards in
 * coach.ts.
 */
export const M8_YAW_CUE_MIN_OFF_PCT = 25;

// ---------------------------------------------------------------------------
// Result contract.
// ---------------------------------------------------------------------------

/**
 * Where this walk's neutral pitch came from — the stamp honesty law: the
 * record says which calibration scored the walk.
 * - "stand": time-weighted mean over the countdown stand (speed-gated).
 * - "fit": the trainee's FIT-session BodyBaseline.neutralPitchRad
 *   (adjudication §K FIT<->M8 — the chain is stand -> fit -> walk).
 * - "walk": mean pitch over the first M8_NEUTRAL_FALLBACK_SEC of the walk
 *   (the baselineY law), used when neither calibration was sane/present.
 */
export type CarriageNeutralSource = "stand" | "fit" | "walk";

/**
 * Head-carriage read for one walk (head orientation, not gaze). All angles
 * in degrees; + pitch = head pitch above neutral (head orientation, not
 * gaze); + yaw = the trainee's right of the walk line (the same sign
 * convention as the lateral channel, walk-stats.ts).
 */
export interface CarriageStats {
  /** Fraction of measured walk time |pitch - neutral| <= M8_PITCH_BAND_DEG. round3. */
  pitchInBandFrac: number;
  /** Fraction of yaw-measured time |yawErr| <= M8_YAW_BAND_DEG; null when the
   *  yaw channel measured < M8_YAW_MIN_SEC (e.g. suppressed whole walk). round3. */
  yawInBandFrac: number | null;
  /** Time-weighted SIGNED mean pitch deviation vs neutral (deg, + = above). round1. */
  meanPitchDevDeg: number;
  /** HEAD DROPS below M8_GLANCE_PITCH_DEG, one per dip (hysteresis). */
  glanceCount: number;
  /** Walk-seconds of the FIRST head drop, or null when none. round1. */
  firstGlanceAtSec: number | null;
  /** The calibrated neutral pitch (deg) this walk scored against
   *  (+ = head pitch above horizontal — head orientation, not gaze). round1. */
  neutralPitchDeg: number;
  /** Which calibration produced the neutral — see CarriageNeutralSource. */
  neutralSource: CarriageNeutralSource;
  /** Seconds of walk time the pitch channel measured. round1. */
  measuredSec: number;
  /** 40-100 mapping of the in-band fractions (carriageScoreOf). The PRIMARY
   *  honest numbers are the fractions; this exists as the M5 ingredient and
   *  for exports. round1. */
  carriageScore: number;
}

// ---------------------------------------------------------------------------
// Score mapping + the M5 blend (pure — the golden family pins the arithmetic).
// ---------------------------------------------------------------------------

/**
 * The carriage score map: fc = M8_PITCH_FRAC_WEIGHT * pitchFrac +
 * (1 - M8_PITCH_FRAC_WEIGHT) * yawFrac, or fc = pitchFrac when the yaw
 * channel never measured (yawFrac null — disclosed via the summary line
 * omitting FACING ON LINE). Then:
 *
 *   carriageScore = SCORE_MIN + (SCORE_MAX - SCORE_MIN) * fc = 40 + 60 * fc
 *
 * Anchors: fc = 1 -> 100 (the cap every clean channel hits, pose-derive.ts —
 * the perfect=100 rescale); fc = 0 -> 40 (the floor). The curve crosses the
 * LOWEST pass bar (75, modes.ts) at fc = 35/60 ~ 0.58 — carriage held ~3/5
 * of the walk is the pass edge.
 */
export function carriageScoreOf(
  pitchFrac: number,
  yawFrac: number | null,
): number {
  const fc =
    yawFrac === null
      ? pitchFrac
      : M8_PITCH_FRAC_WEIGHT * pitchFrac +
        (1 - M8_PITCH_FRAC_WEIGHT) * yawFrac;
  return SCORE_MIN + (SCORE_MAX - SCORE_MIN) * fc;
}

/**
 * target[4] post-blend: legacy presence composite + the measured carriage
 * ingredient (see M8_PRESENCE_WEIGHT for the full derivation):
 *
 *   presence' = legacyPresence * (1 - M8_PRESENCE_WEIGHT)
 *             + carriageScore * M8_PRESENCE_WEIGHT
 *
 * PURE ONE-SHOT by adjudication §B: this function is never idempotence-safe
 * against read-modify-write on its own output — the wiring keeps a private
 * `legacyPresence` latch of the last derive-path composite and re-blends
 * from THAT every frame, so repeated cached pose frames cannot compound.
 */
export function blendPresence(
  legacyPresence: number,
  carriageScore: number,
): number {
  return (
    legacyPresence * (1 - M8_PRESENCE_WEIGHT) +
    carriageScore * M8_PRESENCE_WEIGHT
  );
}

/**
 * The wiring's §B latch: the last presence composite a DERIVE PATH actually
 * computed (target[4] before any blend). One mutable field, preallocated by
 * the wiring (zero per-frame allocation); reset to the display-neutral value
 * at walk start (beginWalkTracking).
 */
export interface PresenceBlendLatch {
  /** The legacy (derive-path) presence composite last written to target[4]. */
  legacy: number;
}

/**
 * The §B presence-blend FRAME STEP, extracted pure so vitest pins the exact
 * law the engine wiring runs (metrics.ts cannot load under vitest — it is
 * engine-coupled). Called once per active walk frame with:
 * - `derivedThisFrame`: true only when a derive path RAN this frame (a fresh
 *   camera PoseFrame was derived, or deriveFromHead ran past its re-seed
 *   early-return). On those frames target[4] holds the LEGACY composite and
 *   the latch captures it. On every other frame (repeated cached pose frame,
 *   head re-seed) target[4] holds LAST frame's blended value — which must
 *   never be latched, or the blend would compound (§B blocker).
 * - `engaged`: CarriageTracker.engaged — the ONE blend gate.
 * - `carriageScore`: CarriageTracker.liveScore().
 * Returns the value target[4] must hold after this frame: the idempotent
 * blend of the LATCHED legacy composite while engaged, else target[4]
 * untouched. Repeated calls with a frozen latch/score are bit-stable —
 * the wiring never feeds its own output back into the blend.
 */
export function stepPresenceBlend(
  latch: PresenceBlendLatch,
  derivedThisFrame: boolean,
  target4: number,
  engaged: boolean,
  carriageScore: number,
): number {
  if (derivedThisFrame) {
    latch.legacy = target4;
  }
  return engaged ? blendPresence(latch.legacy, carriageScore) : target4;
}

/**
 * The M8 yaw flags one walk frame feeds CarriageTracker.update() — the
 * wiring's out-object for markTurnFlags (preallocated by MetricsSystem so
 * the per-frame call stays zero-alloc, the PresenceBlendLatch pattern).
 */
export interface MarkTurnFlags {
  /** Out-and-back leg after the mark: the yaw target flips by PI. */
  returning: boolean;
  /** Turn/pose window: the yaw channel is DARK (pitch keeps measuring). */
  yawSuppressed: boolean;
}

/**
 * The M8 yaw-suppression/return-flip LAW, extracted pure so vitest and the
 * golden family pin the exact rule the engine wiring runs (metrics.ts is
 * engine-coupled and cannot load under vitest — the stepPresenceBlend
 * precedent). Inputs are the wiring's own state:
 * - `markAtWalkTime`: walk-seconds when the pose mark was reached this run,
 *   -1 = not yet (also the post-remap re-arm value — show.ts clears
 *   reachedMark/poseBurst on a mid-walk remap and the wiring resets its
 *   private mark latch to -1 with it, so the flags drop back to the
 *   unmarked state until the mark is genuinely re-reached).
 * - `walkTime`: seconds since walk start (the walk clock).
 * - `routeOneWay`: the RUN's route topology (compiledPath.kind === "U").
 *
 * The law (see M8_TURN_EXCLUDE_SEC for the window's derivation):
 * - Unmarked (markAtWalkTime < 0): no flip, no suppression.
 * - Out-and-back, marked: `returning` from the mark on (its exact timing
 *   inside the turn window is moot — the window is yaw-dark), and yaw
 *   suppressed while walkTime - mark < M8_TURN_EXCLUDE_SEC (STRICT `<`:
 *   at exactly the window edge the channel is measuring again).
 * - One-way (U), marked: never returning, suppressed to the walk's end
 *   (the pose beat is documented scanning, not a carriage fault).
 *
 * Writes into `out` and returns it (zero-alloc law).
 */
export function markTurnFlags(
  markAtWalkTime: number,
  walkTime: number,
  routeOneWay: boolean,
  out: MarkTurnFlags,
): MarkTurnFlags {
  const marked = markAtWalkTime >= 0;
  out.returning = marked && !routeOneWay;
  out.yawSuppressed =
    marked &&
    (routeOneWay || walkTime - markAtWalkTime < M8_TURN_EXCLUDE_SEC);
  return out;
}

// ---------------------------------------------------------------------------
// Tracker.
// ---------------------------------------------------------------------------

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Per-walk head-carriage accumulator. The engine wiring (a later phase)
 * reads player.head.getWorldQuaternion into ONE preallocated Quaternion and
 * passes the raw components down (adjudication §D); this tracker owns the
 * HeadForward scratch and calls the shared head-orient.ts extraction —
 * never getWorldDirection, never a second hand-rolled quaternion path.
 *
 * Lifecycle (reset laws):
 * - countdown entry -> resetNeutral() (a re-run recalibrates; a stale stand
 *   never leaks across runs), then addNeutralSample() per countdown frame.
 * - walk start -> beginWalk(fitNeutralPitchRad?) — resolves the neutral
 *   chain (stand -> fit -> walk) and clears every walk accumulator.
 * - mid-walk runway remap -> resetYawChannel() (every yaw sample so far was
 *   measured against the OLD heading — the WalkStatsAccumulator.resetLateral
 *   law); pitch, neutral and drop state are geometry-independent and survive.
 * - camera<->head source handoff -> NOTHING (the headset stays on the head;
 *   M8 is arbitration-independent — the wiring's resetCadence must not
 *   touch this tracker).
 * - dark frame (non-finite quat component, non-finite/<= 0 dt) -> zero
 *   weight everywhere; live-tap EMAs hold; NaN never enters a fold.
 * - FROZEN frame (the quat tuple EXACTLY equals the last accepted one) ->
 *   zero weight everywhere, live taps NULL (the dark-channel disclosure);
 *   see update() — the HoldAccumulator frozen-pose law mirrored.
 */
export class CarriageTracker {
  /**
   * Live taps for the session recorder's 6 Hz MetricSample channels
   * (headPitchDeg/headYawDeg) — EMA-smoothed at M8_EMA_RATE, seeded from
   * the first measured sample so the tap never drags through a phantom 0.
   * null = the channel is unmeasured/dark right now (pitch: no walk frame
   * yet; yaw: the turn window, a gated near-vertical frame, or no sample
   * since the last reset — the tap re-seeds when the channel resumes,
   * because the pre-turn error was measured against the un-flipped target).
   */
  livePitchDevDeg: number | null = null;
  liveYawDevDeg: number | null = null;

  /** RAW per-frame pitch deviation vs the calibrated neutral (deg) of the
   * last ACCEPTED walk frame — NOT EMA-smoothed (the M8_EMA_RATE doc's own
   * rule: fast events must not fold through the 1.5/s EMA; a 1 s turn dip
   * to -10 deg would read ~-7.8 through it). Null at beginWalk and on
   * frozen/dark frames (the same null discipline as livePitchDevDeg — a
   * dark frame must never export a stale raw value). ONE owner per number
   * (Wave 2 adjudication §I): the neutral chain and the pitch extraction
   * stay HERE; M11 (turn-stats.ts) only integrates this tap over its turn
   * window. ADDITIVE + output-neutral by construction: finalize() and
   * liveScore() never read it, so the head-carriage golden family is
   * byte-identical. */
  liveRawPitchDevDeg: number | null = null;

  // Shared extraction scratch (head-orient.ts) — allocated once, never per
  // frame.
  private readonly fwd: HeadForward = makeHeadForward();

  // Countdown-stand neutral accumulator (time-weighted pitch mean, deg).
  private standAcc = 0;
  private standTime = 0;

  // The resolved neutral this walk scores against (deg) + its source. Under
  // the "walk" source the neutral is the RUNNING mean while the fallback
  // window is open (the baselineY law: score against the running value).
  private neutralDeg = 0;
  private neutralSrc: CarriageNeutralSource = "walk";
  private fbAcc = 0;
  private fbSamples = 0;

  // Walk accumulators (seconds; sums are deg * s).
  private pitchSec = 0;
  private pitchInBandSec = 0;
  private pitchDevSum = 0;
  private yawSec = 0;
  private yawInBandSec = 0;

  // HEAD DROP hysteresis latch + count.
  private glanceArmed = true;
  private glances = 0;
  private firstGlanceAt = -1;

  // Live-tap EMA state (raw, pre-rounding; the taps above expose them).
  private pitchEma = 0;
  private yawEma = 0;

  // Frozen-pose guard state: the last ACCEPTED quaternion tuple (the
  // HoldAccumulator law mirrored — hold-stats.ts documents the threat
  // model: tracking loss / VisibleBlurred with the loop still running / a
  // desktop preview's static camera all keep feeding one bit-identical
  // transform, and folding it claims frozen, unmeasured time as measured
  // carriage).
  private lastQx = 0;
  private lastQy = 0;
  private lastQz = 0;
  private lastQw = 0;
  private haveLast = false;

  /**
   * True once pitchMeasuredSec >= M8_ENGAGE_SEC — the M5 blend gate AND the
   * finalize non-null criterion (one criterion, so score and record can
   * never disagree about whether carriage was measured). Monotone per walk:
   * measured seconds only grow between beginWalk() calls.
   */
  get engaged(): boolean {
    return this.pitchSec >= M8_ENGAGE_SEC;
  }

  /**
   * Shared quaternion ingest: extract the forward ray (head-orient.ts) and
   * return head pitch in DEGREES, or NaN for a dark frame (any non-finite
   * component, or a degenerate zero quaternion). Defensive renormalization:
   * getWorldQuaternion is normalized, but composed float drift is guarded —
   * n2 = |f|^2; if |n2 - 1| > 1e-3 the ray (and its horiz) is rescaled.
   * Leaves `this.fwd` populated for the yaw consumer.
   */
  private extractPitchDeg(
    qx: number,
    qy: number,
    qz: number,
    qw: number,
  ): number {
    if (
      !Number.isFinite(qx) ||
      !Number.isFinite(qy) ||
      !Number.isFinite(qz) ||
      !Number.isFinite(qw)
    ) {
      return NaN;
    }
    const f = headForward(qx, qy, qz, qw, this.fwd);
    const n2 = f.x * f.x + f.y * f.y + f.z * f.z;
    if (!(n2 > 0)) return NaN; // zero quaternion — no direction exists
    if (Math.abs(n2 - 1) > 1e-3) {
      const inv = 1 / Math.sqrt(n2);
      f.x *= inv;
      f.y *= inv;
      f.z *= inv;
      f.horiz = Math.hypot(f.x, f.z);
    }
    return pitchOf(f.y) * RAD2DEG;
  }

  /** Countdown entry: clear the stand accumulator (neutral re-calibrates
   *  every run — a stale stand never leaks across runs). */
  resetNeutral(): void {
    this.standAcc = 0;
    this.standTime = 0;
  }

  /**
   * One countdown stand sample. `headSpeedMps` gates out approach motion
   * (< M8_STAND_SPEED_MAX_MPS counts; the wiring's first frame has no
   * previous position and passes a failing speed). Finiteness-gated: a
   * non-finite quaternion/speed/dt contributes zero weight.
   */
  addNeutralSample(
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    headSpeedMps: number,
    dt: number,
  ): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (!Number.isFinite(headSpeedMps)) return;
    if (headSpeedMps >= M8_STAND_SPEED_MAX_MPS) return;
    const pitchDeg = this.extractPitchDeg(qx, qy, qz, qw);
    if (!Number.isFinite(pitchDeg)) return;
    this.standAcc += pitchDeg * dt;
    this.standTime += dt;
  }

  /**
   * Walk start: resolve the neutral chain and clear ALL walk accumulators,
   * the drop latch, the live taps and the engage state. The chain
   * (adjudication §K, FIT<->M8):
   * 1. STAND: the countdown mean, when it exists and passes the sane gate.
   * 2. FIT: `fitNeutralPitchRad` (BodyBaseline.neutralPitchRad, radians —
   *    the FIT session's own calibrated stand), same sane gate.
   * 3. WALK: mean pitch over the first M8_NEUTRAL_FALLBACK_SEC of the walk
   *    (the baselineY law), armed here and folded by update().
   * The stand accumulator itself is KEPT (resetNeutral clears it at the
   * next countdown), so a summary->walk re-run without a fresh countdown
   * still resolves the same stand.
   */
  beginWalk(fitNeutralPitchRad: number | null = null): void {
    const standMean =
      this.standTime > 0 ? this.standAcc / this.standTime : null;
    const fitDeg =
      fitNeutralPitchRad !== null && Number.isFinite(fitNeutralPitchRad)
        ? fitNeutralPitchRad * RAD2DEG
        : null;
    if (standMean !== null && Math.abs(standMean) <= M8_NEUTRAL_SANE_DEG) {
      this.neutralDeg = standMean;
      this.neutralSrc = "stand";
    } else if (fitDeg !== null && Math.abs(fitDeg) <= M8_NEUTRAL_SANE_DEG) {
      this.neutralDeg = fitDeg;
      this.neutralSrc = "fit";
    } else {
      this.neutralDeg = 0;
      this.neutralSrc = "walk";
    }
    this.fbAcc = 0;
    this.fbSamples = 0;
    this.pitchSec = 0;
    this.pitchInBandSec = 0;
    this.pitchDevSum = 0;
    this.yawSec = 0;
    this.yawInBandSec = 0;
    this.glanceArmed = true;
    this.glances = 0;
    this.firstGlanceAt = -1;
    this.livePitchDevDeg = null;
    this.liveYawDevDeg = null;
    this.liveRawPitchDevDeg = null;
    this.pitchEma = 0;
    this.yawEma = 0;
    this.haveLast = false; // frozen-pose guard re-arms per walk
  }

  /**
   * Mid-walk remap: the route heading just moved under the live walk. Clears
   * ONLY the yaw channel (in-band/measured seconds + the live yaw tap):
   * every yaw sample so far was measured against the OLD heading — the
   * WalkStatsAccumulator.resetLateral law. Pitch, neutral and drop state are
   * geometry-independent and survive.
   */
  resetYawChannel(): void {
    this.yawSec = 0;
    this.yawInBandSec = 0;
    this.liveYawDevDeg = null;
    this.yawEma = 0;
  }

  /**
   * One walk frame.
   * - (qx, qy, qz, qw): the head WORLD quaternion's raw components.
   * - walkYawRad: the active route segment's WALK-direction heading
   *   (projectRoute().yaw — segment yaw IS the walk heading).
   * - returning: out-and-back leg after the mark — the yaw target flips by
   *   PI (F := -F). Its exact timing inside the turn window is moot because
   *   the window is yaw-dark.
   * - yawSuppressed: the turn/pose window (wiring computes it from
   *   M8_TURN_EXCLUDE_SEC / the one-way rule) — yaw channel dark, pitch
   *   keeps measuring.
   * - dt: the ECS frame delta (never PoseFrame.t — wall-clock law).
   * - walkTime: seconds since walk start (the walk clock).
   *
   * FROZEN-POSE GUARD (the HoldAccumulator law mirrored): a tracked 6DoF
   * head can never emit two bit-identical float64 quaternion tuples at
   * 72-90 Hz (sensor-fusion noise floors are sub-mm/sub-microradian), so a
   * repeat means the pose source froze (tracking loss / VisibleBlurred with
   * the loop still running / a desktop preview's static camera). Such a
   * frame contributes ZERO weight everywhere — pitchSec/pitchInBandSec/
   * yawSec never advance, the EMAs hold — and the live taps read NULL to
   * disclose the dark channel (the taps re-seed when the stream resumes).
   * A static desktop preview therefore accumulates ~0 measured carriage
   * time and finalizes null instead of reading fake-perfect — the same walk
   * whose hold row honestly reads NO READ can never claim a measured
   * CHIN LEVEL 100%.
   */
  update(
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    walkYawRad: number,
    returning: boolean,
    yawSuppressed: boolean,
    dt: number,
    walkTime: number,
  ): void {
    if (!Number.isFinite(dt) || dt <= 0 || !Number.isFinite(walkTime)) return;
    if (
      this.haveLast &&
      qx === this.lastQx &&
      qy === this.lastQy &&
      qz === this.lastQz &&
      qw === this.lastQw
    ) {
      // Frozen pose: zero weight, EMAs hold, taps disclose the dark channel.
      this.livePitchDevDeg = null;
      this.liveYawDevDeg = null;
      this.liveRawPitchDevDeg = null;
      return;
    }
    const pitchDeg = this.extractPitchDeg(qx, qy, qz, qw);
    if (!Number.isFinite(pitchDeg)) {
      // Dark frame: zero weight, EMAs hold — the RAW tap is EXPLICITLY
      // nulled (never a stale value on an unmeasured frame; the frozen
      // branch's discipline mirrored). The EMA taps keep their existing
      // hold-then-reseed contract.
      this.liveRawPitchDevDeg = null;
      return;
    }
    // Record the last ACCEPTED tuple (a dark frame never becomes the
    // reference — NaN would compare unequal anyway; the guard tracks real
    // accepted poses only).
    this.lastQx = qx;
    this.lastQy = qy;
    this.lastQz = qz;
    this.lastQw = qw;
    this.haveLast = true;

    // Walk-fallback neutral — the baselineY law: running mean over the
    // first M8_NEUTRAL_FALLBACK_SEC, scored against the running value, with
    // the first-sample seed if the window never landed a sample (a source
    // dark through the window re-seeds on its first live frame).
    if (this.neutralSrc === "walk") {
      if (walkTime < M8_NEUTRAL_FALLBACK_SEC) {
        this.fbAcc += pitchDeg;
        this.fbSamples++;
        this.neutralDeg = this.fbAcc / this.fbSamples;
      } else if (this.fbSamples === 0) {
        this.fbAcc = pitchDeg;
        this.fbSamples = 1;
        this.neutralDeg = pitchDeg;
      }
    }

    const devDeg = pitchDeg - this.neutralDeg;

    // Pitch accounting — RAW per-frame values (see M8_EMA_RATE for why the
    // integrals never fold through the EMA).
    this.pitchSec += dt;
    this.pitchDevSum += devDeg * dt;
    if (devDeg >= -M8_PITCH_BAND_DEG && devDeg <= M8_PITCH_BAND_DEG) {
      this.pitchInBandSec += dt;
    }

    // The M11 raw tap: this frame's UNsmoothed deviation (see the field
    // doc) — set right after the pitch accounting so a consumer reading it
    // post-update always sees the accepted frame's own value.
    this.liveRawPitchDevDeg = devDeg;

    // HEAD DROP hysteresis: trip below M8_GLANCE_PITCH_DEG, re-arm only
    // above M8_GLANCE_REARM_DEG — one dip, one event.
    if (this.glanceArmed) {
      if (devDeg < M8_GLANCE_PITCH_DEG) {
        this.glanceArmed = false;
        this.glances++;
        if (this.firstGlanceAt < 0) this.firstGlanceAt = walkTime;
      }
    } else if (devDeg > M8_GLANCE_REARM_DEG) {
      this.glanceArmed = true;
    }

    // Pitch live tap: seed on the first measured sample, then fold at
    // M8_EMA_RATE (frame-rate-independent form).
    if (this.livePitchDevDeg === null) {
      this.pitchEma = devDeg;
    } else {
      this.pitchEma +=
        (devDeg - this.pitchEma) * (1 - Math.exp(-M8_EMA_RATE * dt));
    }
    this.livePitchDevDeg = this.pitchEma;

    // Yaw channel — dark through the turn window, on gated near-vertical
    // frames (M8_MIN_HORIZ) and when the heading itself is non-finite. Dark
    // frames credit nothing and NULL the tap (the recorder must not export
    // a stale error against a target that may have flipped); the tap
    // re-seeds when the channel resumes.
    const f = this.fwd;
    if (
      !yawSuppressed &&
      f.horiz >= M8_MIN_HORIZ &&
      Number.isFinite(walkYawRad)
    ) {
      // Walk-heading unit vector in the runway frame (runway-layout.ts:
      // yaw-0 forward = (0, 0, -1)): F = (-sin psi, -cos psi); the return
      // leg reverses the walk direction (F := -F).
      let hx = -Math.sin(walkYawRad);
      let hz = -Math.cos(walkYawRad);
      if (returning) {
        hx = -hx;
        hz = -hz;
      }
      // Signed yaw error via atan2(cross, dot) on the horizontal parts.
      // Sign law: + = the trainee's RIGHT (head forward = RIGHT(psi) gives
      // cross = sin^2 + cos^2 = +1 -> +90 deg) — the same sign convention
      // as the lateral channel (walk-stats.ts).
      const yawErrDeg =
        Math.atan2(f.z * hx - f.x * hz, f.x * hx + f.z * hz) * RAD2DEG;
      this.yawSec += dt;
      if (yawErrDeg >= -M8_YAW_BAND_DEG && yawErrDeg <= M8_YAW_BAND_DEG) {
        this.yawInBandSec += dt;
      }
      if (this.liveYawDevDeg === null) {
        this.yawEma = yawErrDeg;
      } else {
        this.yawEma +=
          (yawErrDeg - this.yawEma) * (1 - Math.exp(-M8_EMA_RATE * dt));
      }
      this.liveYawDevDeg = this.yawEma;
    } else {
      this.liveYawDevDeg = null;
    }
  }

  /** Running 40-100 carriage score (valid once `engaged`; SCORE_MIN floor
   *  before any pitch time exists). The wiring's M5 post-blend input. */
  liveScore(): number {
    if (this.pitchSec <= 0) return SCORE_MIN;
    const pitchFrac = this.pitchInBandSec / this.pitchSec;
    const yawFrac =
      this.yawSec >= M8_YAW_MIN_SEC ? this.yawInBandSec / this.yawSec : null;
    return clampScore(carriageScoreOf(pitchFrac, yawFrac));
  }

  /**
   * Freeze the walk into a CarriageStats — NULL unless engaged
   * (pitchMeasuredSec >= M8_ENGAGE_SEC: short walk, no orientation stream).
   * Non-destructive (the walk-stats finalize law): the accumulators keep
   * their state until the next beginWalk().
   */
  finalize(): CarriageStats | null {
    if (!this.engaged) return null;
    const pitchFrac = this.pitchInBandSec / this.pitchSec;
    const yawFrac =
      this.yawSec >= M8_YAW_MIN_SEC ? this.yawInBandSec / this.yawSec : null;
    return {
      pitchInBandFrac: round3(pitchFrac),
      yawInBandFrac: yawFrac === null ? null : round3(yawFrac),
      meanPitchDevDeg: round1(this.pitchDevSum / this.pitchSec),
      glanceCount: this.glances,
      firstGlanceAtSec:
        this.firstGlanceAt < 0 ? null : round1(this.firstGlanceAt),
      neutralPitchDeg: round1(this.neutralDeg),
      neutralSource: this.neutralSrc,
      measuredSec: round1(this.pitchSec),
      carriageScore: round1(carriageScoreOf(pitchFrac, yawFrac)),
    };
  }
}

// ---------------------------------------------------------------------------
// Copy builders (ASCII-only — every string can reach the XR panel; HEAD
// DROPS naming everywhere user-facing per adjudication §K, and never a gaze
// claim anywhere).
// ---------------------------------------------------------------------------

/** "NO HEAD DROPS" | "1 HEAD DROP" | "{n} HEAD DROPS" (adjudication §K). */
function headDropsLabel(n: number): string {
  if (n <= 0) return "NO HEAD DROPS";
  if (n === 1) return "1 HEAD DROP";
  return `${n} HEAD DROPS`;
}

/**
 * Summary-row line, or null when carriage is null (surfaces hide the row).
 * Format: HEAD CARRIAGE{sep}CHIN LEVEL {p}%{sep}FACING ON LINE {y}%{sep}
 * {drops} — the FACING segment is OMITTED when the yaw channel never
 * measured (yawInBandFrac null), because printing a number nothing measured
 * would violate the honesty law.
 *
 * `sep` law = walkStatLine (coach.ts): the ASCII " - " default is a PANEL
 * constraint (the XR font has no middle-dot glyph); the DOM landing passes
 * " · " for its own typography.
 */
export function carriageLine(
  c: CarriageStats | null,
  sep: string = " - ",
): string | null {
  if (!c) return null;
  let line = `HEAD CARRIAGE${sep}CHIN LEVEL ${Math.round(c.pitchInBandFrac * 100)}%`;
  if (c.yawInBandFrac !== null) {
    line += `${sep}FACING ON LINE ${Math.round(c.yawInBandFrac * 100)}%`;
  }
  return `${line}${sep}${headDropsLabel(c.glanceCount)}`;
}

/** Per-source neutral parenthetical for {@link carriageTooltip} — the stamp-
 * honesty law (CarriageStats.neutralSource) extended to the tooltip: the
 * sentence names the calibration that actually scored THIS walk. */
const NEUTRAL_SOURCE_PHRASE: Record<CarriageNeutralSource, string> = {
  stand: "set during the countdown stand",
  fit: "from your FIT baseline",
  walk: "from the first half second of the walk",
};

/**
 * Landing tooltip for the carriage summary row (title attr — wiring sets it
 * from the per-walk stamp: carriageTooltip(stats.neutralSource)). Explains
 * the geometry per adjudication §K ("a drop this deep points the head at
 * the deck") and repeats the not-gaze disclosure. Source-aware: the neutral
 * parenthetical must match CarriageStats.neutralSource — beginWalk discards
 * an insane stand mean and falls to the FIT baseline or the walk's first
 * half second, and the tooltip may not claim the discarded stand.
 */
export function carriageTooltip(source: CarriageNeutralSource): string {
  return (
    "Measured from headset orientation - head carriage, not gaze; eyes are not tracked. " +
    `Chin level: head pitch within 7 deg of your calibrated neutral (${NEUTRAL_SOURCE_PHRASE[source]}). ` +
    "Facing on line: head yaw within 12 deg of the walk direction; the turn at the mark is not counted. " +
    "Head drops: head pitch dropping more than 15 deg below neutral, counted once per dip - a drop this deep points the head at the deck."
  );
}

/** Compatibility alias — the stand-sourced variant (the pre-source-aware
 * text, byte-identical). Prefer carriageTooltip(stats.neutralSource). */
export const CARRIAGE_TOOLTIP = carriageTooltip("stand");

/**
 * Tooltip for a CARRIAGE surface on a walk with NO carriage read (stats
 * null: the tracker never engaged — walk shorter than M8_ENGAGE_SEC or no
 * orientation stream). The source-aware carriageTooltip may not be used
 * here: it names a calibrated neutral, and a null walk calibrated nothing.
 * States what the channel measures and why this walk shows no score.
 */
export const CARRIAGE_NO_READ_TOOLTIP =
  "Head carriage - how level and on-line you keep your head, measured from " +
  "headset orientation (not gaze; eyes are not tracked). No read this walk: " +
  "the walk was too short or carried no head-orientation data.";

/**
 * The carriage-aware M5 presence explainer (adjudication §I: ADDITIVE, never
 * in-place — coach.ts and METRIC_EXPLAIN.presence are NOT touched; their
 * legacy text stays true for any walk without a carriage read, and for Solo
 * always). The summary surfaces branch AT RENDER on the per-walk stamp:
 * summary.carriage != null (<=> the tracker engaged <=> the M5 blend ran —
 * one criterion, M8_ENGAGE_SEC) -> THIS string; else the legacy table text.
 * Discloses the exact blended form (M8_PRESENCE_WEIGHT: legacy composite at
 * 75% + measured carriage at 25%), that it is still a composite, and the
 * head-orientation-not-gaze law.
 */
export const PRESENCE_EXPLAIN_WITH_CARRIAGE =
  "Composite read: your posture, rhythm and pace weighted together (posture counting most) at 75%, plus your measured head carriage at 25% - chin held level, head facing down the walk line. Still a composite - carriage is head orientation, not gaze; eyes are not tracked.";

/**
 * The carriage-aware COMPOSITE caption for the run-history detail card
 * (same §I additive rule as PRESENCE_EXPLAIN_WITH_CARRIAGE: the legacy
 * caption in landing.ts is NOT touched — it stays true for any row without
 * a carriage stamp). Per-row accurate: a stamped row's persisted PRESENCE
 * is 75% legacy composite + 25% MEASURED head carriage, while CONFIDENCE
 * and PRESENTATION remain reads of the four measured channels.
 */
export const COMPOSITE_CAPTION_WITH_CARRIAGE =
  "CONFIDENCE and PRESENTATION are composite reads derived from the four measured channels - not separately measured. PRESENCE on this walk blends that composite at 75% with your measured head carriage at 25%.";

/**
 * Directional presence-cue builder — null when nothing qualifies (the
 * generic presence note stands). Selection: HEAD DROPS first (discrete,
 * unambiguous), else the channel with the larger weighted deficit
 * 0.6 * (1 - pitchFrac) vs 0.4 * (1 - yawFrac), each behind its own qualify
 * guard (a sub-1-deg mean pitch dev or a sub-25%-off-line yaw would cite a
 * number too small to be the walk's story — the coach.ts cm < 1 rule).
 * Every number cited is a measured quantity from CarriageStats (the
 * coach.ts directional-cue law).
 */
export function carriagePresenceCue(c: CarriageStats): string | null {
  if (c.glanceCount === 1) {
    return "You dropped your head to the deck once - chin level, hold the far wall.";
  }
  if (c.glanceCount >= 2) {
    return `You dropped your head to the deck ${c.glanceCount} times - chin level, hold the far wall.`;
  }
  const d = Math.round(Math.abs(c.meanPitchDevDeg));
  const pitchQualifies = d >= 1;
  const offPct =
    c.yawInBandFrac === null
      ? 0
      : Math.round((1 - c.yawInBandFrac) * 100);
  const yawQualifies =
    c.yawInBandFrac !== null && offPct >= M8_YAW_CUE_MIN_OFF_PCT;
  const pitchDeficit = M8_PITCH_FRAC_WEIGHT * (1 - c.pitchInBandFrac);
  const yawDeficit =
    c.yawInBandFrac === null
      ? 0
      : (1 - M8_PITCH_FRAC_WEIGHT) * (1 - c.yawInBandFrac);
  // Ties keep pitch — the chin is the #1 coached correction (roadmap).
  if (pitchQualifies && (!yawQualifies || pitchDeficit >= yawDeficit)) {
    const side = c.meanPitchDevDeg < 0 ? "below" : "above";
    return `Your chin averaged ${d} deg ${side} neutral - level it and hold the far wall.`;
  }
  if (yawQualifies) {
    return `Your head faced off the walk line ${offPct} percent of the walk - pick the far point and hold it.`;
  }
  return null;
}

/**
 * Post-process a CoachReport with this walk's carriage read — both surfaces
 * call it right after buildCoachReport, so buildCoachReport itself (and its
 * Swift mirror) stays behaviorally untouched. IDENTITY (returns the SAME
 * report object) unless ALL of: carriage is non-null, the report already
 * carries a presence note (presence below the mode's bar — this feature
 * never adds notes, only upgrades one), and a directional cue qualifies.
 * The upgrade replaces the presence note's cue and marks it directional;
 * every other note object is carried through untouched.
 */
export function applyCarriageNotes(
  report: CoachReport,
  c: CarriageStats | null,
): CoachReport {
  if (!c) return report;
  const idx = report.notes.findIndex((n) => n.key === "presence");
  if (idx < 0) return report;
  const cue = carriagePresenceCue(c);
  if (cue === null) return report;
  const notes: CoachNote[] = report.notes.map((n, i) =>
    i === idx ? { key: "presence", cue, directional: true } : n,
  );
  return { ...report, notes };
}
