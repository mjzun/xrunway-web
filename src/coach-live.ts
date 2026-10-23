/**
 * (X)RUNWAY — live mid-walk coaching policy (POLISH-AUDIT #20/#48).
 *
 * During a scored walk the trainee physically walks AWAY from the panel — no
 * visual channel can coach mid-walk. Audio can. This module is the PURE
 * decision layer: CoachLiveSystem samples the live measurement channels
 * (walk-stats.ts taps) at 2 Hz and asks `decideLiveCue` whether anything has
 * earned a spoken correction; coach-voice.ts owns the actual speech/earcon.
 *
 * Dependency-free by design (no @iwsdk/core, no DOM) so it loads in vitest —
 * the coach.ts / walk-stats.ts pattern. Every string is ASCII-only (the
 * coach.ts law) and short enough to SPEAK mid-stride.
 *
 * THE RULES (each one is unit-tested in test/coach-live.test.ts):
 *  - Walk phase only. Cues never fire outside the walk.
 *  - Settle window: faults do not even ACCUMULATE before SETTLE_SEC — the
 *    metrics EMAs warm up over ~2 s from a standing start and the posture
 *    baseline forms over the first 0.5 s (metrics.ts), so early channel
 *    values are ramp artifacts, not faults. Earliest possible cue is
 *    therefore SETTLE_SEC + FAULT_HOLD_SEC into the walk.
 *  - Final guard: nothing cues inside the last FINAL_GUARD_SEC of the walk
 *    clock OR past FINAL_GUARD_PROGRESS of the route — a correction the
 *    trainee cannot act on is noise. The route term matters: out-and-back
 *    walks END positionally (show.ts FINISH_RADIUS at the start line),
 *    routinely with 20+ s still on the clock, so a clock-only guard was
 *    inert exactly where fast finishers cross the line.
 *  - Turn-back window: reaching the far-end pose mark starts the pose beat
 *    (paparazzi burst) and, on an out-and-back route, the physical turn —
 *    pace legitimately collapses and the lateral line swings. Fault timers
 *    are CLEARED (not just muted) for TURN_SUPPRESS_SEC after the mark so
 *    the turn itself can never mature into a cue. On a ONE-WAY route (the
 *    U) the walk ends at the mark after the pose hold (show.ts
 *    POSE_HOLD_SEC), so suppression holds to the end. The finale burst needs
 *    no rule of its own: show.ts raises it and flips to summary in the same
 *    frame, so no walk-phase sample can ever see it.
 *  - Hysteresis: a fault must hold continuously for FAULT_HOLD_SEC beyond
 *    its threshold before it cues; a clean sample (or a sign flip, for the
 *    signed channels) restarts the clock.
 *  - Cadence: >= CUE_COOLDOWN_SEC between ANY two cues, at most MAX_PER_KIND
 *    of each kind per walk, and never the same kind twice in a row.
 *  - Priority when several faults are sustained at once: pace > center >
 *    posture (pace is the most coachable mid-stride; posture the least).
 *  - Channel honesty (the coach.ts law — never claim what wasn't measured):
 *    pace cues need a live pace channel, center cues a live lateral channel,
 *    posture cues a live posture channel. A null channel never cues — and a
 *    NON-FINITE value is treated exactly like null: NaN/Infinity means "not
 *    measured" (a poisoned upstream EMA, e.g. a junk pose-frame coordinate),
 *    never a fault. NaN fails every clean-sample test, so without the
 *    Number.isFinite gate it would mature through the hold and speak a
 *    fabricated correction (and `NaN > 0` is false, so always the
 *    slow/lift flavor). Center
 *    copy uses the ABS offset only and NEVER names left/right — the lateral
 *    sign is route-relative and flips on the return leg of an out-and-back
 *    walk (see walk-stats.ts sign conventions).
 *
 * THRESHOLDS — sanity-checked against metrics.ts's own score mappings:
 *  - PACE_DELTA_CUE_MPS = 0.25: the pace score is 95 - |delta| * 70, so a
 *    sustained 0.25 m/s error maps to ~77.5 — at or below every mode's pass
 *    bar (75-82, modes.ts). Smaller deltas sit inside the speed-EMA's normal
 *    stride-to-stride wobble. (Pinned value; it matches the code's reality.)
 *  - LATERAL_CUE_M = 0.20, ADJUSTED DOWN from the pinned 0.35: footwork is
 *    100 - |lat| * 240, which hits the SCORE_MIN floor (40) at ~0.23 m — a
 *    0.35 m gate could only fire after the metric had been pinned at its
 *    floor for seconds, far too late to coach. 0.20 m maps to score ~48
 *    (decisively failing every bar) while staying ~4x natural head sway
 *    (~5 cm), so it cannot nag a clean line.
 *  - POSTURE_CUE_M = 0.06: posture is 100 - dev * 350, so 0.06 m maps to
 *    ~75 — right at the lowest pass bar. Walking head-bob is ~1-2 cm
 *    (BOB_THRESHOLD detrending, metrics.ts), well under the gate. (Pinned
 *    value; it matches the code's reality.)
 */

// ---------------------------------------------------------------------------
// Cue vocabulary.
// ---------------------------------------------------------------------------

export type LiveCueKind =
  | "pace-fast"
  | "pace-slow"
  | "center-up"
  | "posture-drop"
  | "posture-lift";

export const LIVE_CUE_KINDS: readonly LiveCueKind[] = [
  "pace-fast",
  "pace-slow",
  "center-up",
  "posture-drop",
  "posture-lift",
];

/** One decided cue: the kind doubles as the earcon id (COACH_EARCONS). */
export interface LiveCue {
  kind: LiveCueKind;
  /** Short spoken line — the coach.ts editorial voice, ASCII only. */
  text: string;
}

/**
 * Spoken copy per kind. Mid-stride lines must be SHORT (~2 s at rate 1.05).
 * center-up deliberately never says left/right — see the header honesty rule.
 */
export const LIVE_CUE_TEXT: Record<LiveCueKind, string> = {
  "pace-fast": "Slow it down - long, even strides.",
  "pace-slow": "Pick up the pace - stretch every stride.",
  "center-up": "Find the centerline.",
  "posture-drop": "Settle your height - smooth, no bounce.",
  "posture-lift": "Lift through the crown - chin level.",
};

// ---------------------------------------------------------------------------
// Earcon recipes (pure data — coach-voice.ts synthesizes from these).
// Each kind is LEARNABLE: pace = two blips (falling = slow down, rising =
// speed up), center = a same-pitch double tap, posture = one gliding swoop
// (falling = settle, rising = lift). Contours mirror the correction.
// ---------------------------------------------------------------------------

export interface CoachEarcon {
  /** Two frequencies (Hz): blip pair, or glide start -> end when `glide`. */
  notes: readonly [number, number];
  /** Blip spacing (s), or the glide duration when `glide`. */
  span: number;
  /** Per-voice gain decay (s). */
  decay: number;
  glide: boolean;
}

/** Earcon peak level, relative to the SFX pref law master (sfxLevel). Sits
 * between the countdown tick (0.14) and the pose sting (0.18). */
export const COACH_EARCON_LEVEL = 0.16;

export const COACH_EARCONS: Record<LiveCueKind, CoachEarcon> = {
  "pace-fast": { notes: [1318.51, 987.77], span: 0.11, decay: 0.09, glide: false },
  "pace-slow": { notes: [987.77, 1318.51], span: 0.11, decay: 0.09, glide: false },
  "center-up": { notes: [1174.66, 1174.66], span: 0.09, decay: 0.07, glide: false },
  "posture-drop": { notes: [1046.5, 783.99], span: 0.18, decay: 0.3, glide: true },
  "posture-lift": { notes: [783.99, 1046.5], span: 0.18, decay: 0.3, glide: true },
};

// ---------------------------------------------------------------------------
// Rule constants (all seconds / meters / m/s — exported for the tests).
// ---------------------------------------------------------------------------

/** Policy sampling interval (s) — the 2 Hz grid coach-live-system.ts samples
 *  the live taps on. Lives HERE (the pure module) rather than in the
 *  @iwsdk/core-coupled system so the golden generator and the Swift port
 *  consume the same value the app runs (single-sourcing, finding #12);
 *  plenty against the 2.5 s hysteresis. */
export const COACH_SAMPLE_SEC = 0.5;

/** No fault accumulation before this much walk time (EMA warm-up window). */
export const SETTLE_SEC = 5;
/** No cue inside the last N seconds of the walk clock. */
export const FINAL_GUARD_SEC = 4;
/** No cue past this route progress (0..1) either: out-and-back walks finish
 * POSITIONALLY (re-crossing the start line, show.ts) long before the clock,
 * and a cue fired on the last sample gets chopped mid-word by the summary
 * flip's cancelCoachVoice — right on top of the finale payoff. */
export const FINAL_GUARD_PROGRESS = 0.9;
/** A fault must hold continuously this long beyond threshold to cue. */
export const FAULT_HOLD_SEC = 2.5;
/** Minimum spacing between ANY two cues. */
export const CUE_COOLDOWN_SEC = 9;
/** Per-kind cap per walk. */
export const MAX_PER_KIND = 2;
/** Fault timers stay cleared this long after the pose mark on an
 * out-and-back route (covers the pose beat + the physical turn — the HUD's
 * "Turn around" prompt itself holds 3 s). One-way routes stay suppressed to
 * the walk's end (it ends at the mark). */
export const TURN_SUPPRESS_SEC = 4;

/** |live pace - mode ideal| must exceed this (m/s). See header for why. */
export const PACE_DELTA_CUE_MPS = 0.25;
/** |live centerline offset| must exceed this (m). ADJUSTED from the pinned
 * 0.35 — see header. */
export const LATERAL_CUE_M = 0.2;
/** |live head-height deviation from the walk-start baseline| gate (m). */
export const POSTURE_CUE_M = 0.06;

// ---------------------------------------------------------------------------
// SOLO thresholds (SOLO-MODE §3/§5) — RE-DERIVED against the §3 channel
// definitions, never carried over (the doc rules this a Phase A task, not an
// option). PACE_DELTA_CUE_MPS carries unchanged: the pace channel and its
// score mapping (95 - |delta| * 70) are identical in Solo.
// ---------------------------------------------------------------------------

/**
 * SOLO |hip-path lateral offset| cue gate (m) — re-derived for the §3
 * channel (pose-derive.ts soloDeriveWorld): the web's 0.20 was tuned against
 * the HEAD centerline channel with ~5 cm natural head sway (gate ~4x noise;
 * with the 2.5 s hold a drift had to sustain ~0.25 m to cue). Solo's channel
 * is the HIP path offset from the walker's own travel line: it carries NO
 * stance width (that lives only in the ankle-offset M4 score input) and its
 * natural noise is hip sway — ~3 cm (the §6 walker's swayAmp; up to ~5 cm on
 * a real catwalk). 0.15 keeps both web rules on the new channel: it is 5x
 * the 3 cm sway noise (>= the web's 4x rule), and with FAULT_HOLD_SEC a
 * drift must sustain ~0.18 m+ beyond sway to cue — "you have left your
 * line" on a narrower, stance-free channel, matching the web's effective
 * ~0.25 m trip on its wider one.
 *
 * NOTE the INPUT this gate compares against is the SMOOTHED |offset| (see
 * SOLO_LATERAL_CUE_SMOOTH_RATE below) — on that tap the gate sits >=13x the
 * clean-walk noise floor (~0.011 m) and trips on a sustained ~+-0.33 m
 * physical weave.
 */
export const SOLO_LATERAL_CUE_M = 0.15;

/**
 * SOLO |hip-height drift| cue gate (m) — re-derived against the §3 M1
 * mapping (100 - |dev|EMA * SOLO_POSTURE_SLOPE, pose-derive.ts): the same
 * score-bar rule that produced the head gate (0.06 = 21/350, the dev where
 * the curve crosses the lowest pass bar 75) gives 21/280 = 0.075 for the
 * hip slope. Gait hip bob (~2 cm) plus the 2.5 s continuous hold keep a
 * clean walk from ever tripping it: a sustained drift must clear
 * ~0.095 m through the bob oscillation to cue.
 */
export const SOLO_POSTURE_CUE_M = 0.075;

/**
 * SOLO lateral CUE-INPUT smoothing rate (1/s): the Solo engine feeds the
 * policy's absLateralM with a rate-0.5 EMA of |liveLateralM| sampled on the
 * 2 Hz grid — NOT the raw tap the web uses. Discovered by the
 * walk-replay-solo assert-then-emit anchors (a scripted lateral fault
 * produced no cue): the web's lateral channel is an offset from an ABSOLUTE
 * mapped centerline, trivially sustainable, but Solo's §3 channel is offset
 * from the walker's OWN heading-EMA travel line, which has no absolute
 * reference — a slow drift is absorbed by the heading (your line follows
 * you), a sharp side-step is eaten by the stability gate, and a weave
 * crosses zero twice a cycle, so the RAW |offset| can never hold above any
 * gate for the FAULT_HOLD_SEC continuous-hold law. The cue's product
 * meaning ("Find your line" = you are CONSISTENTLY off your line) is the
 * sustained MAGNITUDE, so the input is the |offset| mean over the hold
 * timescale: tau = 1/0.5 = 2 s ~ FAULT_HOLD_SEC smooths the rectification
 * ripple of any weave FASTER than ~0.25 Hz to <=~+-10% (no false clock
 * resets at the dips; a first-order EMA attenuates high frequencies, so
 * the bound is a floor, not a ceiling — slower wander is instead absorbed
 * by the heading EMA before it ever reaches this tap, per the drift
 * argument above) while adding ~3 s of onset latency. Noise floor:
 * clean-walk hip sway reads ~0.011 m on the smoothed tap, so the 0.15 gate
 * keeps >=13x noise (the web rule was >=4x). Trip point: a sustained weave
 * of ~+-0.33 m physical amplitude — clearly a fault; deliberate stylistic
 * hip sway (+-0.10-0.15 m) reads ~0.05-0.07 and never nags. The RECORD
 * channels (meanLateralM/meanAbsLateralM) stay on the raw signed offset —
 * only the cue input smooths. Records/posture are untouched: posture has an
 * absolute reference (the walk-start baseline), so its raw tap sustains.
 *
 * DARK-TAP RULE at the sampler: the raw tap goes null for a single sample
 * whenever the stability gate blips at a weave's direction extreme — under
 * the null-clears honesty law one blip would reset the fault clock and no
 * hold could ever complete. The sampler therefore reports the HELD EMA
 * while the tap has been dark for <= SOLO_GAP_SEC (the same tolerance the
 * §2 derive loop gives the stream itself), and null beyond it — so a turn
 * window (~SOLO_TURN_EXCLUDE_SEC dark) still nulls the channel and clears
 * the clock, exactly as suppression intends.
 */
export const SOLO_LATERAL_CUE_SMOOTH_RATE = 0.5;

// ---------------------------------------------------------------------------
// Cue gate sets — the thresholds a policy instance trips on. The RULES
// (settle, hold, cooldown, caps, priority, honesty) are surface-independent;
// only the three gate values differ because the web and Solo channels are
// physically different quantities (head-vs-centerline vs the §3 hip
// channels). Pace carries unchanged — same channel, same score mapping.
// ---------------------------------------------------------------------------

/** The three cue gates a LiveCoachPolicy trips on (all derived values — see
 * the constants above; never free parameters). */
export interface LiveCueGates {
  /** |live pace - mode ideal| gate (m/s). */
  paceDeltaMps: number;
  /** |live lateral offset| gate (m). */
  lateralM: number;
  /** |live height deviation| gate (m). */
  postureM: number;
}

/** The web surface's gates (head/centerline channels) — the default, so
 * every existing construction site keeps its exact behavior. */
export const WEB_CUE_GATES: LiveCueGates = {
  paceDeltaMps: PACE_DELTA_CUE_MPS,
  lateralM: LATERAL_CUE_M,
  postureM: POSTURE_CUE_M,
};

/** The Solo surface's gates (§3 hip channels, re-derived above). The Solo
 * engine constructs its policy with these; the golden coach-live family
 * pins the differential behavior (cases tagged `gates: "solo"`). */
export const SOLO_CUE_GATES: LiveCueGates = {
  paceDeltaMps: PACE_DELTA_CUE_MPS,
  lateralM: SOLO_LATERAL_CUE_M,
  postureM: SOLO_POSTURE_CUE_M,
};

// ---------------------------------------------------------------------------
// Policy input — one flat snapshot per 2 Hz sample (the system reuses ONE
// mutable object; this module never holds a reference past the call).
// ---------------------------------------------------------------------------

export interface LiveCueInput {
  /** True only while the show phase is "walk". */
  walking: boolean;
  /** Seconds left on the walk clock (globals.walkRemaining). */
  walkRemainingSec: number;
  /** Walk-time (s) when the pose mark was reached, or null before it. */
  markAtSec: number | null;
  /** Route progress 0..1 (globals.walkProgress; 0 when unknown). Feeds the
   * POSITIONAL half of the final guard — see FINAL_GUARD_PROGRESS. */
  walkProgress01: number;
  /** One-way route (U): the walk ENDS at the mark — no return leg. */
  oneWayRoute: boolean;
  /** livePaceMps - the mode's idealPace, or null while no pace channel. */
  paceDeltaMps: number | null;
  /** |liveLateralM| — ABS only (the sign is route-relative), or null. */
  absLateralM: number | null;
  /** SIGNED live head-height deviation (+ above baseline), or null. */
  postureM: number | null;
}

// ---------------------------------------------------------------------------
// The policy. Stateful across one walk (reset() re-arms it); every decide
// call is pure scalar math — the only allocation is the LiveCue on a fire.
// ---------------------------------------------------------------------------

export class LiveCoachPolicy {
  /** The gate set this instance trips on (web default; the Solo engine
   * passes SOLO_CUE_GATES). Gates only — every rule constant is shared. */
  private readonly gates: LiveCueGates;

  constructor(gates: LiveCueGates = WEB_CUE_GATES) {
    this.gates = gates;
  }

  /** +1 fast / -1 slow / 0 no pace fault. */
  private paceSign = 0;
  private paceSince = -1;
  private latSince = -1;
  /** +1 riding high (bounce) / -1 sinking / 0 no posture fault. */
  private postSign = 0;
  private postSince = -1;

  private lastCueAt = Number.NEGATIVE_INFINITY;
  private lastKind: LiveCueKind | null = null;
  private readonly counts: Record<LiveCueKind, number> = {
    "pace-fast": 0,
    "pace-slow": 0,
    "center-up": 0,
    "posture-drop": 0,
    "posture-lift": 0,
  };

  /** Arm for a new walk: counters, cooldown and fault timers all clear. */
  reset(): void {
    this.clearFaults();
    this.lastCueAt = Number.NEGATIVE_INFINITY;
    this.lastKind = null;
    for (let i = 0; i < LIVE_CUE_KINDS.length; i++) {
      this.counts[LIVE_CUE_KINDS[i]] = 0;
    }
  }

  /**
   * Clear ONLY the fault-persistence timers (counters/cooldown survive).
   * Called on a mid-walk runway remap — the centerline just moved under the
   * live walk (metrics.ts resets its lateral channel on the same signal), so
   * every in-flight fault clock was measured against stale geometry.
   */
  clearFaults(): void {
    this.paceSign = 0;
    this.paceSince = -1;
    this.latSince = -1;
    this.postSign = 0;
    this.postSince = -1;
  }

  /**
   * One 2 Hz policy step. `nowSec` is seconds since the walk started (the
   * same clock `input.markAtSec` is on). Returns a cue to deliver, or null.
   */
  decideLiveCue(input: LiveCueInput, nowSec: number): LiveCue | null {
    if (!input.walking) {
      return null;
    }

    // Settle window — see header. Keep timers clear so a ramp-in artifact
    // can never pre-age a fault.
    if (nowSec < SETTLE_SEC) {
      this.clearFaults();
      return null;
    }

    // Turn-back / pose-beat window — CLEAR, don't just mute: the turn itself
    // (pace ~0, lateral swinging) must never mature into a fault.
    if (input.markAtSec !== null) {
      if (input.oneWayRoute || nowSec - input.markAtSec < TURN_SUPPRESS_SEC) {
        this.clearFaults();
        return null;
      }
    }

    // -- fault persistence tracking (channel honesty: null/non-finite clears)
    // Number.isFinite gates route NaN/Infinity through the SAME clear/reset
    // path as null — a value that isn't a measurement can never age a fault.
    const pace = input.paceDeltaMps;
    if (pace === null || !Number.isFinite(pace) || Math.abs(pace) <= this.gates.paceDeltaMps) {
      this.paceSign = 0;
      this.paceSince = -1;
    } else {
      const sign = pace > 0 ? 1 : -1;
      if (sign !== this.paceSign) {
        this.paceSign = sign;
        this.paceSince = nowSec;
      }
    }

    const lat = input.absLateralM;
    if (lat === null || !Number.isFinite(lat) || lat <= this.gates.lateralM) {
      this.latSince = -1;
    } else if (this.latSince < 0) {
      this.latSince = nowSec;
    }

    const post = input.postureM;
    if (post === null || !Number.isFinite(post) || Math.abs(post) <= this.gates.postureM) {
      this.postSign = 0;
      this.postSince = -1;
    } else {
      const sign = post > 0 ? 1 : -1;
      if (sign !== this.postSign) {
        this.postSign = sign;
        this.postSince = nowSec;
      }
    }

    // -- cue gates (faults above keep aging through these) ------------------
    if (
      input.walkRemainingSec <= FINAL_GUARD_SEC ||
      input.walkProgress01 >= FINAL_GUARD_PROGRESS
    ) {
      return null;
    }
    if (nowSec - this.lastCueAt < CUE_COOLDOWN_SEC) {
      return null;
    }

    // -- selection: priority pace > center > posture -------------------------
    if (this.held(this.paceSince, nowSec)) {
      const kind: LiveCueKind = this.paceSign > 0 ? "pace-fast" : "pace-slow";
      if (this.eligible(kind)) {
        return this.fire(kind, nowSec);
      }
    }
    if (this.held(this.latSince, nowSec) && this.eligible("center-up")) {
      return this.fire("center-up", nowSec);
    }
    if (this.held(this.postSince, nowSec)) {
      const kind: LiveCueKind =
        this.postSign > 0 ? "posture-drop" : "posture-lift";
      if (this.eligible(kind)) {
        return this.fire(kind, nowSec);
      }
    }
    return null;
  }

  private held(since: number, nowSec: number): boolean {
    return since >= 0 && nowSec - since >= FAULT_HOLD_SEC;
  }

  private eligible(kind: LiveCueKind): boolean {
    return this.counts[kind] < MAX_PER_KIND && kind !== this.lastKind;
  }

  private fire(kind: LiveCueKind, nowSec: number): LiveCue {
    this.counts[kind]++;
    this.lastKind = kind;
    this.lastCueAt = nowSec;
    return { kind, text: LIVE_CUE_TEXT[kind] };
  }
}
