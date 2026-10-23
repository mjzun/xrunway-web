/**
 * (X)RUNWAY — FIT SESSION pure capture core: the still-stand detector, the
 * relaxed-walk capture, and the guided-flow state machine that sequences
 * them (mark -> stand -> walk -> saved | aborted).
 *
 * WHY THIS FILE EXISTS (EDGE-ROADMAP "FIT SESSION"): the ~60 s guided FIT
 * flow measures the trainee's body ONCE — standing head height, idle-noise
 * floor, neutral head pitch, natural pace/cadence, head-bob amplitude — and
 * body-baseline.ts turns the measurement into the head path's per-body
 * normalization. Everything that MEASURES lives here, dependency-free (no
 * @iwsdk/core, no DOM — the walk-stats.ts / pose-derive.ts pattern), so the
 * golden-vector generator and vitest import the REAL code. The engine
 * wrapper (a later wiring phase) only projects the head onto the route
 * (RunwayPathProjector), reads player.head position + world quaternion, and
 * publishes this machine's stage EDGES on globals.bodyFitFlow.
 *
 * Head orientation goes through src/head-orient.ts — the ONE shared
 * quaternion -> forward-ray convention (Wave 1 adjudication §D); this module
 * never re-derives the quaternion math.
 *
 * The FIT flow is NOT a show phase: showPhase stays "idle" for the whole
 * flow, MetricsSystem never arms, the recorder never opens a row, no summary
 * is minted. All timing here is CALLER-SUPPLIED ECS delta — PoseFrame.t is
 * wall-clock and is never consumed (design brief law 6).
 *
 * Zero-allocation per-sample paths: the detector ring and all accumulator
 * state are preallocated/scalar; the only allocations are the FitFlowState
 * edge objects (a handful per session — the metrics.ts 6 Hz-publish
 * allowance) and the one BodyBaseline candidate at save.
 */

import {
  type BodyBaseline,
  FIT_BOB_AMP_MAX_M,
  FIT_BOB_AMP_MIN_M,
  FIT_PACE_MAX_MPS,
  FIT_PACE_MIN_MPS,
  sanitizeBodyBaseline,
} from "./body-baseline.js";
import { makeHeadForward, headForward, pitchOf } from "./head-orient.js";
import { STEP_MIN, STEP_MAX } from "./pose-derive.js";

// The imports above pull only from modules that are themselves
// dependency-free (pose-derive.ts is the pure scoring core — the value
// import is the shipped metrics.ts precedent; head-orient.ts is the §D
// shared extraction; body-baseline.ts is this feature's own record module).

// ---------------------------------------------------------------------------
// Tuning — every constant carries its derivation (the SOLO_POSTURE_SLOPE
// exemplar format, pose-derive.ts:54-74).
// ---------------------------------------------------------------------------

/**
 * Still-stand gate: FIT_STILL_STD_M = 0.012 m combined 3D RMS over the
 * window. Quiet-stance sway at head level is 5-9 mm RMS (posturography range
 * for healthy adults; the head amplifies ankle sway ~1.5x). Quest 6DoF
 * jitter is sub-mm — negligible. Gate at 0.012 = 1.3x the top of quiet-
 * stance sway, so a genuinely still trainee passes, while:
 * - a step (>= 0.25 m head travel inside the 1 s window; a linear ramp's
 *   std = L/sqrt(12) = 0.072 m) fails by 6x;
 * - a deliberate weight-shift (~3 cm p2p sinusoid; std = 0.015/sqrt(2)
 *   = 0.0106 m) sits AT the gate — borderline by design: it corrupts the
 *   height mean and must not certify.
 */
export const FIT_STILL_STD_M = 0.012;

/**
 * WINDOW = 1.0 s: one full postural-sway period (the SOLO_LATERAL_BASELINE_SEC
 * = 1.0 precedent, pose-derive.ts:89-98) — shorter windows under-sample the
 * sway cycle and read "still" when the trainee is mid-oscillation.
 */
export const FIT_STILL_WINDOW_SEC = 1.0;

/**
 * SAMPLE RATE = 30 Hz decimated: frame-rate independent (72/90/120 Hz app
 * frames all decimate to the same 30 Hz tape), 30 samples per window, and
 * the golden tapes replay deterministically at a fixed rate.
 */
export const FIT_STILL_SAMPLE_HZ = 30;

/**
 * HOLD = 5.0 s of consecutive certified stillness (the roadmap's number).
 * Why it is enough: sway has ~1 s correlation time -> >= 5 independent
 * height samples; the worst-case certified std (0.012 m, the gate itself)
 * gives a standing-height standard error of dH = 0.012/sqrt(5) = 0.0054 m.
 * A height error rescales the SLOPE, not the measured deviation: the slope
 * error is d(560/H) = -560*dH/H^2, and at the pass-bar deviation 21H/560
 * the score shift is exactly 21*dH/H = 21*0.0054/1.60 ~ 0.07 points —
 * roughly 40x smaller than pushing dH through the steepest slope as if it
 * were a deviation error (0.0054 * 560/1.0 ~ 3.0 pts), and far below the
 * 2-point wobble display rounding already tolerates. In practice the
 * certified std is the QUIET value (~6 mm) -> ~0.035 points.
 */
export const FIT_STILL_HOLD_SEC = 5.0;

/** One silent-retry coaching re-prompt fires at 12 s without certification
 *  (~2.4x the required hold — a couple of failed attempts in). */
export const FIT_STAND_REPROMPT_SEC = 12;

/**
 * The stand stage ABORTS at 30 s = 6x the required hold: a trainee who
 * cannot certify in six attempts' worth of time is being interrupted (kids,
 * dogs, demo crowd) and should retry deliberately rather than be gated
 * forever. No partial save; scores keep the active normalization.
 */
export const FIT_STAND_TIMEOUT_SEC = 30;

/**
 * FIT_MARK_RADIUS_M = 0.8 along / FIT_MARK_LATERAL_M = 0.6 lateral: twice
 * the show's MARK_RADIUS 0.4 (show.ts:117) — the stand needs "near the start
 * mark", not the finish-detector's precision; a loose gate avoids coaching
 * someone 10 cm sideways. The same 0.8 along-slack ends the fit walk at the
 * pose mark.
 */
export const FIT_MARK_RADIUS_M = 0.8;
export const FIT_MARK_LATERAL_M = 0.6;

/** Walking to the start mark is seconds; 30 covers a room crossing plus
 *  hesitation. Past it the flow aborts (interruption, not measurement). */
export const FIT_MARK_TIMEOUT_SEC = 30;

/** The longest sane fit walk: a 12 m U route at the 0.3 m/s speed floor is
 *  40 s — abort past 45 (the 80 m slider max is absurd for a fit). */
export const FIT_WALK_TIMEOUT_SEC = 45;

/**
 * STEADY BAND (adjudication §H — corrected arithmetic): the capture trims
 * margin = min(1.0 m, 0.12 * span) off BOTH ends of startA..poseA, where
 * span = poseA - startA = deckLength - 0.75 m (START_INSET 0.15 +
 * POSE_INSET 0.6, runway-layout.ts:47-49). Gait analysis discards ~2 steps
 * of acceleration/deceleration each end (~1.4 m at a 0.7 m relaxed stride)
 * — the 1.0 m cap plus the 0.8 m mark radius covers that on a full deck,
 * while the 0.12*span form keeps a legal 3 m runway (rw-length min="3")
 * usable. Worked examples (§H):
 *   3 m deck -> span 2.25, margin 0.27, band 1.71 m
 *   7 m deck -> span 6.25, margin 0.75, band 4.75 m
 */
export const FIT_STEADY_MARGIN_FRAC = 0.12;
export const FIT_STEADY_MARGIN_CAP_M = 1.0;

/**
 * Steady-time floor (adjudication §H, re-derived over the MEASURABLE span —
 * the golden-emitter pass caught the original form over-demanding on short
 * decks): min(2.0, 0.6 * usable / 1.3) seconds of time-weighted speed
 * samples before finalize() accepts, where
 *
 *   usable = span - margin - max(margin, FIT_MARK_RADIUS_M)
 *
 * is the distance the walk stage can actually feed the accumulator: samples
 * gate to the band [margin, span - margin], AND the stage itself completes
 * at poseA - FIT_MARK_RADIUS_M (0.8 m — the walker "reached the far mark"),
 * so the far cut is whichever is larger. The original min(2.0, 0.6*span/1.3)
 * ignored the mark radius: on a minimum 3 m deck it demanded 1.04 s from a
 * stage that at a brisk 1.2 m/s can only deliver ~0.98 s — every brisk
 * walker aborted "did not read cleanly" on a legal deck.
 *
 * 2.0 s stays the statistical floor on a full deck; 0.6 * usable / 1.3 is
 * the time a BRISK relaxed walker (1.3 m/s) spends covering 60% of the
 * measurable band — entry/exit slack carried by the remaining 40%.
 * Worked examples (§H, corrected):
 *   3 m deck -> span 2.25, margin 0.27, usable 2.25 - 0.27 - 0.8 = 1.18 m
 *     -> floor min(2.0, 0.6*1.18/1.3) = 0.545 s; at 1.2 m/s the stage
 *     delivers ~0.98 s of band samples -> PASSES (1.8x the floor).
 *   7 m deck -> span 6.25, margin 0.75, usable 6.25 - 0.75 - 0.8 = 4.70 m
 *     -> floor min(2.0, 2.17) = 2.0 s; at 1.0 m/s -> ~4.7 s -> PASSES.
 */
export function fitMinSteadySec(spanM: number): number {
  const marginM = Math.min(
    FIT_STEADY_MARGIN_CAP_M,
    FIT_STEADY_MARGIN_FRAC * spanM,
  );
  const usableM = Math.max(
    0,
    spanM - marginM - Math.max(marginM, FIT_MARK_RADIUS_M),
  );
  return Math.min(2.0, (0.6 * usableM) / 1.3);
}

/**
 * FIT_MIN_SPEED_MPS = 0.3: below the slowest mode ideal (0.72, modes.ts) by
 * 2.4x — filters standing/pausing out of the pace mean without clipping a
 * genuinely slow natural pace. (The head path's own "not walking" pin is
 * speedEma < 0.05, metrics.ts:672 — 0.3 is the "walking with intent" line,
 * not the "moving at all" line.)
 */
export const FIT_MIN_SPEED_MPS = 0.3;

/**
 * Gap rule (the SOLO_GAP_SEC = 0.6 precedent, pose-derive.ts:100-116): any
 * inter-sample gap above this is a tracking outage, not a frame hiccup —
 * the head may have moved unobserved, so the detector's window re-seeds and
 * the walk capture drops its anchor (zero-weight re-seed) instead of
 * measuring across the darkness.
 */
export const FIT_GAP_SEC = 0.6;

/** Cadence needs >= 4 intervals in [STEP_MIN, STEP_MAX] = two full gait
 *  cycles, the fewest that expose a stable mean; fewer -> cadenceSpm = null
 *  (the baseline still saves — cadence is a stored-only field). */
export const FIT_MIN_CADENCE_INTERVALS = 4;

/**
 * The relaxed walk's step detector reuses the shipped head-path law
 * (metrics.ts:623-641): bob EMA baseline at rate 1.2, hysteresis crossings
 * at the DEFAULT threshold 0.004 m (the capture measures the default body's
 * detector against the unknown body — the amplitude estimate itself is the
 * MAD, not the crossings, so a miss here costs only cadence, never bobAmpM).
 */
export const FIT_CAPTURE_BOB_THRESHOLD_M = 0.004;

/** Tracking-jump clamp for per-sample speed (the metrics.ts:614 law). */
const SPEED_CLAMP_MPS = 4;

/** Terminal stages (saved/aborted) hold this long before the engine clears
 *  the flow signal to null (spec §4.3 — presentation, engine-owned). */
export const FIT_TERMINAL_HOLD_SEC = 4.0;

/** Geometry of one capture, precomputed at start(). */
export interface FitSteadyBand {
  /** Trimmed off each end (m): min(1.0, 0.12 * span). */
  marginM: number;
  /** The band as alongFrac bounds: [marginM/span, 1 - marginM/span]. */
  loFrac: number;
  hiFrac: number;
  /** Acceptance floor for time-weighted speed samples (s). */
  minSteadySec: number;
}

/** Compute the §H steady band for a walk span (poseA - startA, meters). */
export function fitSteadyBand(spanM: number): FitSteadyBand {
  const marginM = Math.min(
    FIT_STEADY_MARGIN_CAP_M,
    FIT_STEADY_MARGIN_FRAC * spanM,
  );
  const f = spanM > 0 ? marginM / spanM : 0.5;
  return {
    marginM,
    loFrac: f,
    hiFrac: 1 - f,
    minSteadySec: fitMinSteadySec(spanM),
  };
}

// ---------------------------------------------------------------------------
// The still-stand detector.
// ---------------------------------------------------------------------------

const STILL_PERIOD_SEC = 1 / FIT_STILL_SAMPLE_HZ;
const STILL_WINDOW_N = Math.round(FIT_STILL_WINDOW_SEC * FIT_STILL_SAMPLE_HZ); // 30

/**
 * Variance-gated stillness certifier. Feed one head sample per app frame
 * (dtSec = ECS delta — never PoseFrame.t, the wall-clock law); the detector
 * decimates to FIT_STILL_SAMPLE_HZ, keeps a 1.0 s ring of (x, y, z) with
 * running per-axis sum + sum-of-squares (add-on-push / subtract-on-evict ->
 * O(1) window variance; magnitudes ~1.6 m, squares ~2.6, far from float64
 * cancellation), and certifies while the combined 3D std
 * sqrt(varX + varY + varZ) stays <= FIT_STILL_STD_M once the window is full.
 * While the gate holds, a SECOND accumulator (count, sumY, sumY2, sumPitch)
 * integrates the certified span; any gate failure zeroes holdSec and that
 * accumulator (silent within-stage retry).
 *
 * Sample-drop law: non-finite x/y/z/pitch or dt <= 0 -> the sample is
 * DROPPED — hold state unchanged AND the decimation clock does not advance
 * (a dark frame is not evidence of anything, stillness included). A gap
 * (dt > FIT_GAP_SEC) re-seeds the whole window: the head may have moved
 * unobserved (the SOLO gap rule).
 *
 * FROZEN-POSE GUARD (the HoldAccumulator law mirrored — hold-stats.ts
 * documents the threat model): a tracked 6DoF head can never emit two
 * bit-identical (x, y, z, pitch) float64 tuples at 72-90 Hz, so a repeat
 * means the pose source froze (tracking loss / VisibleBlurred with the
 * loop still running / a desktop preview's static camera). Frozen frames
 * are DROPPED exactly like dark ones — zero evidence, no hold accrual, no
 * window fill, the decimation clock does not advance — so a frozen stream
 * can never certify a variance of literally zero as a measured stand: the
 * stand stage keeps its stageElapsed clock running and a long freeze
 * honestly hits the 30 s stand-timeout abort instead of saving a baseline
 * the sensor never measured.
 *
 * Zero allocation after construction: one Float64Array ring + scalar sums.
 */
export class StillStandDetector {
  /** Interleaved (x, y, z) ring, STILL_WINDOW_N samples. Pitch needs no
   *  windowed statistic (the gate is positional), so it rides only in the
   *  certified-span accumulator below. */
  private readonly ring = new Float64Array(3 * STILL_WINDOW_N);
  private ringIdx = 0;
  private ringCount = 0;
  private sx = 0;
  private sx2 = 0;
  private sy = 0;
  private sy2 = 0;
  private sz = 0;
  private sz2 = 0;

  /** Decimation accumulator (seconds owed to the 30 Hz grid). */
  private acc = 0;

  // Frozen-pose guard state: the last ACCEPTED raw input tuple.
  private lastX = 0;
  private lastY = 0;
  private lastZ = 0;
  private lastPitch = 0;
  private haveLast = false;

  /** Certified-span accumulator — valid stretch feeding result(). */
  private spanCount = 0;
  private spanSumY = 0;
  private spanSumY2 = 0;
  private spanSumPitch = 0;

  private hold = 0;

  reset(): void {
    this.ringIdx = 0;
    this.ringCount = 0;
    this.sx = 0;
    this.sx2 = 0;
    this.sy = 0;
    this.sy2 = 0;
    this.sz = 0;
    this.sz2 = 0;
    this.acc = 0;
    this.haveLast = false; // frozen-pose guard re-arms
    this.clearHold();
  }

  private clearHold(): void {
    this.hold = 0;
    this.spanCount = 0;
    this.spanSumY = 0;
    this.spanSumY2 = 0;
    this.spanSumPitch = 0;
  }

  /** Window re-seed (gap rule): everything windowed is stale evidence. */
  private clearWindow(): void {
    this.ringIdx = 0;
    this.ringCount = 0;
    this.sx = 0;
    this.sx2 = 0;
    this.sy = 0;
    this.sy2 = 0;
    this.sz = 0;
    this.sz2 = 0;
    this.acc = 0;
    this.haveLast = false; // frozen-pose guard re-arms with the window
    this.clearHold();
  }

  /** Consecutive certified-still seconds (counts from the first FULL window
   *  — worst case that defers certification by the 1 s fill, well inside
   *  the 30 s stage timeout). */
  get holdSec(): number {
    return this.hold;
  }

  get windowFull(): boolean {
    return this.ringCount >= STILL_WINDOW_N;
  }

  /**
   * Current windowed 3D std (m) — Infinity until the window is full.
   * Diagnostic surface for the tests/golden cases (the brute-force variance
   * pin); the gate below uses the same number.
   */
  windowStd3D(): number {
    if (this.ringCount < STILL_WINDOW_N) return Infinity;
    const n = STILL_WINDOW_N;
    const mx = this.sx / n;
    const my = this.sy / n;
    const mz = this.sz / n;
    const vx = Math.max(0, this.sx2 / n - mx * mx);
    const vy = Math.max(0, this.sy2 / n - my * my);
    const vz = Math.max(0, this.sz2 / n - mz * mz);
    return Math.sqrt(vx + vy + vz);
  }

  /** Feed one head sample; dtSec = ECS delta. See the class doc for the
   *  drop/gap laws. */
  push(dtSec: number, x: number, y: number, z: number, pitchRad: number): void {
    if (!(Number.isFinite(dtSec) && dtSec > 0)) return;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(z) ||
      !Number.isFinite(pitchRad)
    ) {
      return; // dropped, not aborted — the clock does not advance either
    }
    if (dtSec > FIT_GAP_SEC) {
      this.clearWindow();
      return;
    }
    // Frozen-pose guard (see the class doc): a bit-identical repeat of the
    // last accepted tuple is frozen tracking — dropped like a dark frame,
    // BEFORE the decimation clock advances.
    if (
      this.haveLast &&
      x === this.lastX &&
      y === this.lastY &&
      z === this.lastZ &&
      pitchRad === this.lastPitch
    ) {
      return;
    }
    this.lastX = x;
    this.lastY = y;
    this.lastZ = z;
    this.lastPitch = pitchRad;
    this.haveLast = true;
    this.acc += dtSec;
    if (this.acc < STILL_PERIOD_SEC) return;
    this.acc -= STILL_PERIOD_SEC;
    // Never bank more than one period: a frame hitch emits ONE conservative
    // sample instead of a burst of duplicates that would fake stillness.
    if (this.acc > STILL_PERIOD_SEC) this.acc = STILL_PERIOD_SEC;

    // Evict-then-write keeps the running sums exact O(1).
    const base = this.ringIdx * 3;
    if (this.ringCount >= STILL_WINDOW_N) {
      const ox = this.ring[base];
      const oy = this.ring[base + 1];
      const oz = this.ring[base + 2];
      this.sx -= ox;
      this.sx2 -= ox * ox;
      this.sy -= oy;
      this.sy2 -= oy * oy;
      this.sz -= oz;
      this.sz2 -= oz * oz;
    } else {
      this.ringCount++;
    }
    this.ring[base] = x;
    this.ring[base + 1] = y;
    this.ring[base + 2] = z;
    this.ringIdx = (this.ringIdx + 1) % STILL_WINDOW_N;
    this.sx += x;
    this.sx2 += x * x;
    this.sy += y;
    this.sy2 += y * y;
    this.sz += z;
    this.sz2 += z * z;

    if (this.ringCount < STILL_WINDOW_N) return; // window still filling
    if (this.windowStd3D() <= FIT_STILL_STD_M) {
      this.hold += STILL_PERIOD_SEC;
      this.spanCount++;
      this.spanSumY += y;
      this.spanSumY2 += y * y;
      this.spanSumPitch += pitchRad;
    } else {
      this.clearHold(); // silent within-stage retry
    }
  }

  done(): boolean {
    return this.hold >= FIT_STILL_HOLD_SEC - 1e-9;
  }

  /**
   * Stats over the certified-still span — valid only when done(). Head
   * height is the mean head y (standing HEAD height — never body height);
   * the noise floor is the std of head y; neutral pitch is the mean head
   * pitch (+ = head pitch above horizontal — head orientation, not gaze).
   */
  result(): {
    standHeightM: number;
    stillNoiseM: number;
    neutralPitchRad: number;
  } {
    const n = this.spanCount || 1;
    const meanY = this.spanSumY / n;
    return {
      standHeightM: meanY,
      stillNoiseM: Math.sqrt(Math.max(0, this.spanSumY2 / n - meanY * meanY)),
      neutralPitchRad: this.spanSumPitch / n,
    };
  }
}

// ---------------------------------------------------------------------------
// The relaxed-walk capture.
// ---------------------------------------------------------------------------

/** What one clean fit walk measures (finalize() output; null = the walk did
 *  not read cleanly — the acceptance gates in finalize()). */
export interface FitWalkMeasurement {
  paceMps: number;
  cadenceSpm: number | null;
  bobAmpM: number;
}

/**
 * Accumulates the relaxed unscored walk inside the steady band. The CALLER
 * computes alongFrac = (along - startA) / span (the machine below does);
 * measurement engages only for alongFrac in [loFrac, hiFrac] AND per-sample
 * speed >= FIT_MIN_SPEED_MPS:
 * - time-weighted speed sum (the WalkStatsAccumulator.addPace law,
 *   walk-stats.ts:158-162),
 * - bob EMA baseline at rate 1.2 (identical form to metrics.ts:623-624)
 *   with FIT_CAPTURE_BOB_THRESHOLD_M hysteresis crossings feeding step
 *   intervals gated to [STEP_MIN, STEP_MAX] (pose-derive.ts:46-47),
 * - time-weighted mean |y - bobBaseline| (the MAD).
 *
 * BOB AMPLITUDE ESTIMATOR: bobAmpM = MAD * pi/2. The capture integrates
 * m = time-weighted mean |y - bobBaseline| over the steady band; for
 * y = A sin(wt), mean|A sin| = 2A/pi ~ 0.637A (the identity
 * SOLO_POSTURE_SLOPE already uses, pose-derive.ts:63-67). Invert:
 * bobAmpM = m * pi/2. Cross-check on the default body: a clean-walk head
 * MAD ~ 0.0064 m -> 0.0064 * pi/2 = 0.0100 m = the documented damped-head
 * amplitude — a measured default body round-trips to TH = 0.004 exactly.
 *
 * ACCEPTANCE (finalize -> null, ATOMIC — a fit walk that fails any gate
 * saves NOTHING): paceTime >= minSteadySec (§H), paceMps in [0.2, 2.0]
 * (below = not a walk, above = jogging), bobAmpM in [0.005, 0.05] m (below =
 * glide indistinguishable from tracking noise at head level, above = bounce
 * artifact). Those pace/bob bounds are re-checked by sanitizeBodyBaseline —
 * the same table (body-baseline.ts) — so capture and record can never
 * disagree. Cadence out-of-range is caught by sanitize (atomic there too).
 *
 * Sample-drop law: non-finite input or a gap (dt > FIT_GAP_SEC) drops the
 * anchor — the next sample re-seeds with ZERO weight instead of differencing
 * across the outage (the SOLO gap rule); leaving the band does the same.
 */
export class FitWalkAccumulator {
  private loFrac = 0;
  private hiFrac = 1;
  private minSteadySec = 2;

  private tSec = 0; // capture clock (sum of accepted dt) — crossing timebase
  private havePrev = false;
  private prevX = 0;
  private prevZ = 0;

  private paceSum = 0;
  private paceTime = 0;

  private bobSeeded = false;
  private bobBaseline = 0;
  private bobSign = 0;
  private lastCross = -1;
  private madSum = 0;
  private madTime = 0;

  private itvSum = 0;
  private itvCount = 0;

  /** Arm for one capture with the §H band (fitSteadyBand output). */
  reset(loFrac: number, hiFrac: number, minSteadySec: number): void {
    this.loFrac = loFrac;
    this.hiFrac = hiFrac;
    this.minSteadySec = minSteadySec;
    this.tSec = 0;
    this.havePrev = false;
    this.prevX = 0;
    this.prevZ = 0;
    this.paceSum = 0;
    this.paceTime = 0;
    this.bobSeeded = false;
    this.bobBaseline = 0;
    this.bobSign = 0;
    this.lastCross = -1;
    this.madSum = 0;
    this.madTime = 0;
    this.itvSum = 0;
    this.itvCount = 0;
  }

  /** Zero-weight re-seed: measurement disengaged (gap / dark frame / out of
   *  band). The bob BASELINE survives (the EMA carry-over law); the crossing
   *  state does not — no step interval may span an unmeasured stretch. */
  private dropAnchor(): void {
    this.havePrev = false;
    this.bobSign = 0;
    this.lastCross = -1;
  }

  push(dtSec: number, x: number, y: number, z: number, alongFrac: number): void {
    if (!(Number.isFinite(dtSec) && dtSec > 0)) return;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(z) ||
      !Number.isFinite(alongFrac)
    ) {
      this.dropAnchor();
      return;
    }
    this.tSec += dtSec;
    if (dtSec > FIT_GAP_SEC) {
      this.dropAnchor();
      return;
    }
    if (alongFrac < this.loFrac || alongFrac > this.hiFrac) {
      this.dropAnchor(); // outside the steady band: not measuring
      return;
    }
    if (!this.havePrev) {
      // Band entry: seed the anchor (zero weight) and the bob baseline.
      this.havePrev = true;
      this.prevX = x;
      this.prevZ = z;
      if (!this.bobSeeded) {
        this.bobSeeded = true;
        this.bobBaseline = y;
      }
      return;
    }
    const dx = x - this.prevX;
    const dz = z - this.prevZ;
    this.prevX = x;
    this.prevZ = z;
    let speed = Math.hypot(dx, dz) / dtSec;
    if (speed > SPEED_CLAMP_MPS) speed = SPEED_CLAMP_MPS;
    if (speed < FIT_MIN_SPEED_MPS) return; // pausing — filtered, anchor kept

    this.paceSum += speed * dtSec;
    this.paceTime += dtSec;

    this.bobBaseline += (y - this.bobBaseline) * (1 - Math.exp(-1.2 * dtSec));
    const dev = y - this.bobBaseline;
    this.madSum += (dev < 0 ? -dev : dev) * dtSec;
    this.madTime += dtSec;

    if (dev > FIT_CAPTURE_BOB_THRESHOLD_M && this.bobSign <= 0) {
      this.bobSign = 1;
      if (this.lastCross >= 0) {
        const interval = this.tSec - this.lastCross;
        if (interval >= STEP_MIN && interval <= STEP_MAX) {
          this.itvSum += interval;
          this.itvCount++;
        }
      }
      this.lastCross = this.tSec;
    } else if (dev < -FIT_CAPTURE_BOB_THRESHOLD_M && this.bobSign >= 0) {
      this.bobSign = -1;
    }
  }

  /** Freeze the capture (non-destructive). Null = did not read cleanly. */
  finalize(): FitWalkMeasurement | null {
    if (this.paceTime < this.minSteadySec) return null;
    const paceMps = this.paceSum / this.paceTime;
    if (paceMps < FIT_PACE_MIN_MPS || paceMps > FIT_PACE_MAX_MPS) return null;
    const bobAmpM =
      this.madTime > 0 ? (this.madSum / this.madTime) * (Math.PI / 2) : 0;
    if (bobAmpM < FIT_BOB_AMP_MIN_M || bobAmpM > FIT_BOB_AMP_MAX_M) return null;
    const cadenceSpm =
      this.itvCount >= FIT_MIN_CADENCE_INTERVALS
        ? 60 / (this.itvSum / this.itvCount)
        : null;
    return { paceMps, cadenceSpm, bobAmpM };
  }
}

// ---------------------------------------------------------------------------
// The flow state machine.
// ---------------------------------------------------------------------------

export type FitStage = "mark" | "stand" | "walk" | "saved" | "aborted";

export type FitAbortReason =
  | "mark-timeout"
  | "stand-timeout"
  | "walk-timeout"
  | "walk-not-clean"
  | "cancelled";

/**
 * One published flow EDGE (a stage transition or a line change). Allocated
 * on edges ONLY — a handful per session. Deliberately carries NO progress
 * field (adjudication §K): per-frame progress lives on the machine's plain
 * mutable `progress` ref (the globals.holdLive pattern), so the signal that
 * publishes these edges never churns per frame.
 */
export interface FitFlowState {
  stage: FitStage;
  /** ASCII guidance the XR panel renders verbatim (and the coach voice
   *  speaks — spoken forms identical). */
  line: string;
  /** Terminal stages: why (the FitAbortReason token); null otherwise. */
  detail: string | null;
}

/** Guidance copy (ASCII-only — every string can reach the XR panel; spoken
 *  via the coach-voice path, mute + coach-voice prefs respected by wiring). */
export const FIT_LINES = Object.freeze({
  mark: "Walk to the start mark.",
  stand: "Stand easy on the mark. Hold still.",
  standReprompt: "Soft knees. Let your shoulders drop. Hold still.",
  walk: "Now walk the runway at your own pace. Easy and natural.",
  saved: "Fit saved. Your scores now use your own baseline.",
  savedNotStored:
    "Fit saved for this session - it could not be stored on this device.",
  abortStandTimeout:
    "Could not get a still read. Your scores keep the standard baseline.",
  abortWalkNotClean:
    "That walk did not read cleanly. Your scores keep the standard baseline.",
  abortInterrupted:
    "Fit cancelled. Your scores keep the standard baseline.",
});

const ABORT_LINE: Record<FitAbortReason, string> = {
  // A mark timeout / an external cancel are interruptions of the flow, not
  // failed reads; walk timeout and a dirty capture are both "the walk did
  // not read cleanly" (the honest shared line — neither saves anything).
  "mark-timeout": FIT_LINES.abortInterrupted,
  "stand-timeout": FIT_LINES.abortStandTimeout,
  "walk-timeout": FIT_LINES.abortWalkNotClean,
  "walk-not-clean": FIT_LINES.abortWalkNotClean,
  cancelled: FIT_LINES.abortInterrupted,
};

/** start() configuration — the engine supplies route geometry (startA/poseA
 *  in global-along meters, runway-shape.ts projectRoute space), the trainee
 *  identity, and the wall clock ONCE (capturedAt is a record timestamp, not
 *  timing math — all flow timing is ECS delta). */
export interface FitStartConfig {
  startA: number;
  poseA: number;
  traineeId: string;
  nowMs: number;
}

/**
 * The pure guided-flow runner: null -> mark -> stand -> walk ->
 * saved | aborted. The engine wrapper feeds push() once per app frame with
 * the ECS delta, the head world position, the head world-quaternion RAW
 * components (ONE preallocated Quaternion read, adjudication §D — pitch is
 * extracted here via head-orient), and the route projection (along,
 * lateral). It publishes takeEdge() results on the flow signal, reads
 * `progress` as a plain ref, and on "saved" persists `baseline` and
 * publishes it on globals.bodyBaseline (signal write LAST — the
 * subscriber-throw safety law). Terminal stages: the ENGINE holds them
 * FIT_TERMINAL_HOLD_SEC, then calls reset().
 *
 * Abort-on-interruption (phase leaves idle, remap, trainee switch, headset
 * off, mapping/demo) is the engine's subscription surface — it calls
 * cancel(). Nothing is ever persisted by this class.
 */
export class FitCaptureMachine {
  /** Current stage; null = inactive (update() early-return — zero cost). */
  stage: FitStage | null = null;

  /** 0..1 within the stage (stand: hold fraction; walk: along fraction) —
   *  a PLAIN MUTABLE REF updated per push, deliberately NOT on the edge
   *  objects (adjudication §K, the holdLive pattern). */
  progress = 0;

  /** The sanitized capture — non-null exactly in the "saved" stage. */
  baseline: BodyBaseline | null = null;

  /** Why the flow ended, in terminal stages (mirrors the last edge's detail). */
  detail: string | null = null;

  private startA = 0;
  private poseA = 0;
  private span = 0;
  private band: FitSteadyBand = fitSteadyBand(1);
  private traineeId = "";
  private nowMs = 0;

  private stageElapsed = 0;
  private reprompted = false;
  private pendingEdge: FitFlowState | null = null;

  private readonly det = new StillStandDetector();
  private readonly walk = new FitWalkAccumulator();
  private stand: {
    standHeightM: number;
    stillNoiseM: number;
    neutralPitchRad: number;
  } | null = null;
  private readonly fwd = makeHeadForward();

  /**
   * Arm the flow. Returns false (stage stays null) on junk geometry or a
   * missing trainee id — the CALLER-side refusals (phase not idle, demo,
   * mapping, flow already active) live in the engine per the spec.
   */
  start(cfg: FitStartConfig): boolean {
    const span = cfg.poseA - cfg.startA;
    if (
      !Number.isFinite(cfg.startA) ||
      !Number.isFinite(cfg.poseA) ||
      !(span > 0) ||
      typeof cfg.traineeId !== "string" ||
      cfg.traineeId.length === 0 ||
      !Number.isFinite(cfg.nowMs) ||
      cfg.nowMs <= 0
    ) {
      return false;
    }
    this.startA = cfg.startA;
    this.poseA = cfg.poseA;
    this.span = span;
    this.band = fitSteadyBand(span);
    this.traineeId = cfg.traineeId;
    this.nowMs = cfg.nowMs;
    this.det.reset();
    this.walk.reset(this.band.loFrac, this.band.hiFrac, this.band.minSteadySec);
    this.stand = null;
    this.baseline = null;
    this.detail = null;
    this.progress = 0;
    this.stageElapsed = 0;
    this.reprompted = false;
    this.setStage("mark", FIT_LINES.mark, null);
    return true;
  }

  /** The pending EDGE since the last take (stage transition or line change),
   *  or null. The engine publishes exactly these on the flow signal. */
  takeEdge(): FitFlowState | null {
    const e = this.pendingEdge;
    this.pendingEdge = null;
    return e;
  }

  /** External interruption / user cancel. No-op when inactive or terminal. */
  cancel(): void {
    if (this.stage === null || this.stage === "saved" || this.stage === "aborted") {
      return;
    }
    this.abort("cancelled");
  }

  /** Back to inactive (the engine calls this after the terminal hold). */
  reset(): void {
    this.stage = null;
    this.progress = 0;
    this.baseline = null;
    this.detail = null;
    this.stand = null;
    this.pendingEdge = null;
    this.det.reset();
  }

  /**
   * One app frame. dtSec = ECS delta; (x, y, z) = head world position;
   * (qx, qy, qz, qw) = head world-quaternion raw components; along/lateral =
   * the head's route projection (projectRoute). Non-finite spatial inputs
   * are DROPPED SAMPLES (finiteness law at the boundary) — but stage
   * timeout clocks still advance: an interruption that blinds tracking must
   * not also freeze the abort clock.
   */
  push(
    dtSec: number,
    x: number,
    y: number,
    z: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    along: number,
    lateral: number,
  ): void {
    const stage = this.stage;
    if (stage === null || stage === "saved" || stage === "aborted") return;
    if (!(Number.isFinite(dtSec) && dtSec > 0)) return;
    this.stageElapsed += dtSec;

    const posOk =
      Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
    const routeOk = Number.isFinite(along) && Number.isFinite(lateral);

    if (stage === "mark") {
      if (
        posOk &&
        routeOk &&
        Math.abs(along - this.startA) <= FIT_MARK_RADIUS_M &&
        Math.abs(lateral) <= FIT_MARK_LATERAL_M
      ) {
        this.stageElapsed = 0;
        this.reprompted = false;
        this.det.reset();
        this.progress = 0;
        this.setStage("stand", FIT_LINES.stand, null);
        return;
      }
      if (this.stageElapsed >= FIT_MARK_TIMEOUT_SEC) this.abort("mark-timeout");
      return;
    }

    if (stage === "stand") {
      if (posOk) {
        // §D extraction: the ONE shared quaternion -> pitch convention. A
        // non-finite quaternion yields a non-finite pitch, which the
        // detector's own gate drops (the dark-frame law).
        headForward(qx, qy, qz, qw, this.fwd);
        this.det.push(dtSec, x, y, z, pitchOf(this.fwd.y));
      }
      const p = this.det.holdSec / FIT_STILL_HOLD_SEC;
      this.progress = p > 1 ? 1 : p;
      if (this.det.done()) {
        this.stand = this.det.result();
        this.stageElapsed = 0;
        this.progress = 0;
        this.walk.reset(
          this.band.loFrac,
          this.band.hiFrac,
          this.band.minSteadySec,
        );
        this.setStage("walk", FIT_LINES.walk, null);
        return;
      }
      if (this.stageElapsed >= FIT_STAND_TIMEOUT_SEC) {
        this.abort("stand-timeout");
        return;
      }
      if (!this.reprompted && this.stageElapsed >= FIT_STAND_REPROMPT_SEC) {
        this.reprompted = true;
        this.setStage("stand", FIT_LINES.standReprompt, null);
      }
      return;
    }

    // stage === "walk"
    if (posOk && routeOk) {
      const frac = (along - this.startA) / this.span;
      this.walk.push(dtSec, x, y, z, frac);
      this.progress = frac < 0 ? 0 : frac > 1 ? 1 : frac;
      if (along >= this.poseA - FIT_MARK_RADIUS_M) {
        this.finishWalk();
        return;
      }
    } else {
      // Dark frame: FORWARD it so the accumulator's documented anchor-drop
      // law runs in production — the non-finite branch performs the
      // zero-weight anchor re-seed without advancing its capture clock, so
      // the resume frame after an outage re-seeds instead of differencing
      // the whole unobserved travel into one pace sample. (Pre-fix the
      // machine silently skipped dark frames and the unit-tested dropAnchor
      // path was unreachable from the app.)
      this.walk.push(dtSec, NaN, NaN, NaN, NaN);
    }
    if (this.stageElapsed >= FIT_WALK_TIMEOUT_SEC) this.abort("walk-timeout");
  }

  private finishWalk(): void {
    const m = this.walk.finalize();
    const stand = this.stand;
    if (!m || !stand) {
      this.abort("walk-not-clean");
      return;
    }
    // ATOMIC save candidate -> the ONE acceptance table (body-baseline.ts).
    // A capture that fails any range (height, pitch, noise, cadence...)
    // saves NOTHING — no partially measured body.
    const candidate: BodyBaseline = {
      version: 1,
      traineeId: this.traineeId,
      capturedAt: this.nowMs,
      standHeightM: stand.standHeightM,
      stillNoiseM: stand.stillNoiseM,
      neutralPitchRad: stand.neutralPitchRad,
      paceMps: m.paceMps,
      cadenceSpm: m.cadenceSpm,
      bobAmpM: m.bobAmpM,
      source: "headset",
    };
    const clean = sanitizeBodyBaseline(candidate, this.nowMs);
    if (!clean) {
      this.abort("walk-not-clean");
      return;
    }
    this.baseline = clean;
    this.progress = 1;
    this.setStage("saved", FIT_LINES.saved, null);
  }

  private abort(reason: FitAbortReason): void {
    this.progress = 0;
    this.baseline = null;
    this.setStage("aborted", ABORT_LINE[reason], reason);
  }

  private setStage(stage: FitStage, line: string, detail: string | null): void {
    this.stage = stage;
    this.detail = detail;
    // Edge allocation — stage transitions / line changes only (§K: the
    // signal publishes edges; progress never rides on them).
    this.pendingEdge = { stage, line, detail };
  }
}
