/**
 * (X)RUNWAY — the PURE golden-vector replay runners, shared by the generator
 * (scripts/gen-golden-vectors.mjs) and the web-side staleness net
 * (test/golden-replay.test.ts + the generator's --check mode).
 *
 * These used to live inline in the generator, whose top level shells out to
 * `npx vitest run` — so vitest could never import them and 4 of the vector
 * families had NO web-side staleness net: a scoring change with its unit
 * test updated left all tests green while the checked-in vectors silently
 * pinned the OLD behavior for the Swift port. Extracted here (side-effect
 * free, no vitest imports — the golden-format.ts pattern) the SAME runners
 * that emit the vectors also replay them on every test run.
 *
 * Everything scoring-relevant is imported from the real src modules; the
 * only replicated seams are the documented ones (the metrics.ts publish
 * loop shape and the coach-live 2 Hz sample loop shape inside runReplay —
 * their constants and forms come from metrics-wiring.ts / coach-live.ts).
 */

import { buildCoachReport, type CoachContext } from "../src/coach.js";
import {
  COACH_SAMPLE_SEC,
  LiveCoachPolicy,
  SOLO_CUE_GATES,
  SOLO_LATERAL_CUE_SMOOTH_RATE,
  WEB_CUE_GATES,
  type LiveCueGates,
} from "../src/coach-live.js";
import {
  NEUTRAL,
  PUBLISH_INTERVAL,
  displayBlend,
  rampInWeight,
} from "../src/metrics-wiring.js";
import {
  clampScore,
  deriveWorld,
  PoseDeriveState,
  SOLO_GAP_SEC,
  SOLO_TURN_EXCLUDE_SEC,
  soloDeriveWorld,
} from "../src/pose-derive.js";
import * as progress from "../src/progress.js";
import * as grading from "../src/session-grading.js";
import { WalkStatsAccumulator } from "../src/walk-stats.js";
import type { PoseKeypoint } from "../src/external-tracker.js";
import type { TapeRecord } from "./pose-tapes.js";
// --- Wave 1 families (fit-core / head-carriage / hold-stats / repeatability).
import {
  BOB_HYST_RATIO,
  BOB_THRESHOLD_CAP_M,
  BOB_THRESHOLD_FLOOR_M,
  DEFAULT_BOB_THRESHOLD_M,
  DEFAULT_HEAD_HEIGHT_M,
  DEFAULT_HEAD_NORMALIZATION,
  DEFAULT_NORMALIZATION_STAMP,
  DEFAULT_POSTURE_SLOPE,
  FIT_BOB_AMP_MAX_M,
  FIT_BOB_AMP_MIN_M,
  FIT_CADENCE_MAX_SPM,
  FIT_CADENCE_MIN_SPM,
  FIT_CAPTURED_AT_SLACK_MS,
  FIT_HEIGHT_MAX_M,
  FIT_HEIGHT_MIN_M,
  FIT_NEUTRAL_PITCH_MAX_RAD,
  FIT_PACE_MAX_MPS,
  FIT_PACE_MIN_MPS,
  FIT_STILL_NOISE_MAX_M,
  FIT_STORAGE_KEY,
  POSTURE_SLOPE_NUMERATOR,
  deriveHeadNormalization,
  normalizationStamp,
  sanitizeBodyBaseline,
  type BodyBaseline,
} from "../src/body-baseline.js";
import {
  FIT_CAPTURE_BOB_THRESHOLD_M,
  FIT_GAP_SEC,
  FIT_LINES,
  FIT_MARK_LATERAL_M,
  FIT_MARK_RADIUS_M,
  FIT_MARK_TIMEOUT_SEC,
  FIT_MIN_CADENCE_INTERVALS,
  FIT_MIN_SPEED_MPS,
  FIT_STAND_REPROMPT_SEC,
  FIT_STAND_TIMEOUT_SEC,
  FIT_STEADY_MARGIN_CAP_M,
  FIT_STEADY_MARGIN_FRAC,
  FIT_STILL_HOLD_SEC,
  FIT_STILL_SAMPLE_HZ,
  FIT_STILL_STD_M,
  FIT_STILL_WINDOW_SEC,
  FIT_TERMINAL_HOLD_SEC,
  FIT_WALK_TIMEOUT_SEC,
  FitCaptureMachine,
  FitWalkAccumulator,
  StillStandDetector,
  fitSteadyBand,
  type FitStartConfig,
} from "../src/fit-session.js";
import {
  CARRIAGE_TOOLTIP,
  M8_EMA_RATE,
  M8_ENGAGE_SEC,
  M8_GLANCE_PITCH_DEG,
  M8_GLANCE_REARM_DEG,
  M8_MIN_HORIZ,
  M8_NEUTRAL_FALLBACK_SEC,
  M8_NEUTRAL_SANE_DEG,
  M8_PITCH_BAND_DEG,
  M8_PITCH_FRAC_WEIGHT,
  M8_PRESENCE_WEIGHT,
  M8_STAND_SPEED_MAX_MPS,
  M8_TURN_EXCLUDE_SEC,
  M8_YAW_BAND_DEG,
  M8_YAW_CUE_MIN_OFF_PCT,
  M8_YAW_MIN_SEC,
  COMPOSITE_CAPTION_WITH_CARRIAGE,
  PRESENCE_EXPLAIN_WITH_CARRIAGE,
  applyCarriageNotes,
  blendPresence,
  carriageLine,
  carriagePresenceCue,
  carriageScoreOf,
  carriageTooltip,
  markTurnFlags,
  stepPresenceBlend,
  type CarriageStats,
} from "../src/head-carriage.js";
import {
  HOLD_ARRIVE_EPS_M,
  HOLD_EXPLAIN,
  HOLD_MARK_FAULT_CM,
  HOLD_MARK_GOOD_CM,
  HOLD_REF_HEAD_M,
  HOLD_RELEASE_SEC,
  HOLD_SPEED_CLAMP_MPS,
  HOLD_SPEED_EMA_RATE,
  HOLD_SPEED_STILL_MPS,
  HOLD_STAND_MIN_M,
  HOLD_STILL_FAULT_NORM_CM,
  HOLD_STILL_GOOD_NORM_CM,
  HOLD_WINDOW_SEC,
  HOLD_YAW_HORIZ_MIN,
  holdCue,
  holdStatLine,
  type HoldNullReason,
  type HoldStats,
} from "../src/hold-stats.js";
import {
  BENCHMARK_HEADLINE_SHOWN,
  BENCHMARK_MODE_ID,
  BENCHMARK_SHAPE_KIND,
  BENCHMARK_TOOLTIP,
  DEFAULT_NORMALIZATION,
  REPEAT_DISCLOSURE,
  REPEAT_MIN_WALKS,
  REPEAT_OUTLIER_DOMINANCE,
  REPEAT_OUTLIER_PCT,
  REPEAT_WINDOW,
  benchmarkAtFinalize,
  benchmarkConfigAtWalkStart,
  benchmarkHeadline,
  benchmarkLine,
  benchmarkRows,
  benchmarkSeries,
  isBenchmarkRow,
  repeatabilityReport,
  rowNormalizationFallback,
  withinPct,
  type RepeatRow,
} from "../src/repeatability.js";
// --- Wave 2 families (beat-stats / turn-stats).
import {
  BEAT_CADENCE_MIN_INTERVALS,
  BEAT_DRIFT_MIN_SPM,
  BEAT_EARCON_ATTACK_SEC,
  BEAT_EARCON_DECAY_SEC,
  BEAT_EARCON_HZ,
  BEAT_EARCON_LEAD_SEC,
  BEAT_EARCON_LEVEL,
  BEAT_EXPLAIN,
  BEAT_FLAM_SUPPRESS_SEC,
  BEAT_GO_FRESH_AFTER_SEC,
  BEAT_GO_STALE_BEFORE_SEC,
  BEAT_GRID_SPM_MAX,
  BEAT_GRID_SPM_MIN,
  BEAT_LOCK_FAULT_R,
  BEAT_LOCK_GOOD_R,
  BEAT_MIN_STRIKES,
  BEAT_PULSE_INTENSITY,
  BEAT_PULSE_LEAD_SEC,
  BEAT_PULSE_SEC,
  BEAT_RAYLEIGH_DIRECTION_MIN,
  BEAT_SETTING_TIP,
  BEAT_STRIKE_DEBOUNCE_SEC,
  BEAT_SUBDIV_DEADZONE_SPM,
  BeatAccumulator,
  advancePulseTick,
  beatGridCandidates,
  beatCue,
  beatScoreOf,
  beatStatLine,
  chooseSubdivision,
  countdownFlamSuppressed,
  firstPulseTick,
  goAudioTimeFresh,
  wrapPhaseBeats,
  type BeatNullReason,
  type BeatStats,
} from "../src/beat-stats.js";
import {
  PRESENTATION_EXPLAIN_WITH_TURN,
  TURN_COMMIT_DEG,
  TURN_DIP_EMA_RATE,
  TURN_DIP_FAULT_FRAC,
  TURN_DUR_BASE_HI_SEC,
  TURN_DUR_BASE_LO_SEC,
  TURN_DUR_BASE_PACE_MPS,
  TURN_ENTER_DEG,
  TURN_EXIT_DEG,
  TURN_EXPLAIN,
  TURN_MIN_MEASURED_SEC,
  TURN_REACQ_BAR_M,
  TURN_REACQ_CUE_SEC,
  TURN_REACQ_SUSTAIN_SEC,
  TURN_RETURN_MIN_SEC,
  TURN_REV_DEADBAND_DEG,
  turnCue,
  turnDurBand,
  turnStatLine,
  type TurnNullReason,
  type TurnStats,
} from "../src/turn-stats.js";
import { feedBeatOps, type BeatOp } from "./beat-helpers.js";
import { runTurnTape, type TurnOp } from "./turn-helpers.js";
import { runCarriageTape, type CarriageOp } from "./carriage-helpers.js";
import {
  feedDetector,
  feedWalk,
  type HeadSample,
  type WalkSample,
} from "./fit-helpers.js";
import {
  feed as feedHoldFrames,
  newAcc as newHoldAcc,
  type HoldFrame,
} from "./hold-helpers.js";

/** METRICS key order (metrics.ts) — targets[] slots and the overall rollup. */
export const METRIC_ORDER = [
  "posture",
  "pace",
  "rhythm",
  "footPlacement",
  "presence",
  "confidence",
  "presentation",
] as const;

// ---------------------------------------------------------------------------
// walk-stats — ops tapes.
// ---------------------------------------------------------------------------

// Ops are data decoded from vector JSON; typed loosely on purpose.
type Op = { op: string } & Record<string, unknown>;

export function runWalkStatsOps(ops: ReadonlyArray<Record<string, unknown>>): {
  finals: unknown[];
  lives?: unknown[];
} {
  const acc = new WalkStatsAccumulator();
  const finals: unknown[] = [];
  const lives: unknown[] = [];
  for (const raw of ops) {
    const o = raw as Op;
    if (o.op === "reset") acc.reset(o.idealPace as number);
    else if (o.op === "addPace") acc.addPace(o.v as number, o.dt as number);
    else if (o.op === "addLateral")
      acc.addLateral(o.v as number, o.dt as number);
    else if (o.op === "addPosture")
      acc.addPosture(o.v as number, o.dt as number);
    else if (o.op === "addStep") acc.addStep(o.at as number);
    else if (o.op === "noteSource")
      acc.noteSource(
        o.source as "head" | "camera-world" | "camera-image",
        o.dt as number,
      );
    else if (o.op === "resetLateral") acc.resetLateral();
    else if (o.op === "finalize")
      finals.push(acc.finalize(o.durationSec as number));
    else if (o.op === "setLive") {
      // Direct assignment — exactly what MetricsSystem/pose-derive do to
      // the live-tap fields (they are plain assignable channels).
      acc.livePaceMps = o.pace as number | null;
      acc.liveLateralM = o.lat as number | null;
      acc.livePostureM = o.post as number | null;
    } else if (o.op === "readLive") {
      lives.push({
        pace: acc.livePaceMps,
        lat: acc.liveLateralM,
        post: acc.livePostureM,
      });
    } else throw new Error(`unknown walk-stats op ${o.op}`);
  }
  // Shape rule (Swift runner mirrors it): `lives` rides along only when the
  // ops tape contains at least one readLive.
  return lives.length ? { finals, lives } : { finals };
}

// ---------------------------------------------------------------------------
// coach-live — events tapes (samples + reset/clearFaults ops).
// ---------------------------------------------------------------------------

export interface LiveEvent {
  t: number;
  op?: string;
  sample?: Record<string, unknown>;
}

/** Decode a case's `gates` tag ("solo" | absent = web) into the gate set. */
export function gatesFor(tag: unknown): LiveCueGates {
  if (tag === undefined || tag === null || tag === "web") return WEB_CUE_GATES;
  if (tag === "solo") return SOLO_CUE_GATES;
  throw new Error(`unknown cue-gates tag ${String(tag)}`);
}

export function runLiveEvents(
  events: ReadonlyArray<LiveEvent>,
  gates: LiveCueGates = WEB_CUE_GATES,
): Array<{ t: number; kind: string; text: string }> {
  const policy = new LiveCoachPolicy(gates);
  const cues: Array<{ t: number; kind: string; text: string }> = [];
  for (const ev of events) {
    if (ev.op !== undefined) {
      if (ev.op !== "reset" && ev.op !== "clearFaults") {
        throw new Error(`unknown coach-live op ${ev.op}`);
      }
      policy[ev.op]();
      continue;
    }
    const cue = policy.decideLiveCue(
      ev.sample as Parameters<LiveCoachPolicy["decideLiveCue"]>[0],
      ev.t,
    );
    if (cue) cues.push({ t: ev.t, kind: cue.kind, text: cue.text });
  }
  return cues;
}

// ---------------------------------------------------------------------------
// progress — rows + queries (incl. the session-grading rules).
// ---------------------------------------------------------------------------

export function runProgressQueries(
  rows: unknown[],
  queries: ReadonlyArray<{ fn: string; args?: Record<string, unknown> }>,
): unknown[] {
  type Rows = Parameters<typeof progress.realScoredRows>[0];
  const r = rows as Rows;
  return queries.map((q) => {
    const fn = q.fn;
    const a = (q.args ?? {}) as Record<string, never>;
    if (fn === "realScoredRows") return progress.realScoredRows(r);
    if (fn === "personalBest") return progress.personalBest(r);
    if (fn === "rollingAverage")
      return a.window !== undefined
        ? progress.rollingAverage(a.values, a.window)
        : progress.rollingAverage(a.values);
    if (fn === "trendDelta")
      return a.window !== undefined
        ? progress.trendDelta(a.values, a.window)
        : progress.trendDelta(a.values);
    if (fn === "overallSeries")
      return a.max !== undefined
        ? progress.overallSeries(r, a.max)
        : progress.overallSeries(r);
    if (fn === "metricTrends") return progress.metricTrends(r);
    if (fn === "latestIsPersonalBest") return progress.latestIsPersonalBest(r);
    if (fn === "modeStats") return progress.modeStats(r);
    if (fn === "masteryJustEarned")
      return progress.masteryJustEarned(r, a.modeId);
    if (fn === "progressReport") return progress.progressReport(r);
    if (fn === "rowPassed") return grading.rowPassed(a.row);
    if (fn === "rowPassThreshold") return grading.rowPassThreshold(a.row);
    if (fn === "isSyntheticRow") return grading.isSyntheticRow(a.row);
    if (fn === "rowMatchesTrainee")
      return grading.rowMatchesTrainee(a.row, a.traineeId);
    if (fn === "filterHistoryRows")
      return grading.filterHistoryRows(r, a.filter);
    throw new Error(`unknown progress query ${fn}`);
  });
}

// ---------------------------------------------------------------------------
// pose-derive tapes — checkpointed expectations.
// ---------------------------------------------------------------------------

/** Checkpointed expectations: warm-up frames (EMA sensitivity), ~6 Hz taps
 * (every 5th 30 Hz event), every gap event, and the final event + stats. */
export function deriveExpect(rec: TapeRecord): {
  checkpoints: unknown[];
  final: unknown;
} {
  const checkpoints: unknown[] = [];
  rec.steps.forEach((st, i) => {
    const s = st as {
      ev: string;
      walkTime: number;
      targets: unknown;
      live: unknown;
    };
    const isGap = s.ev === "gap";
    if (i < 8 || i % 5 === 0 || isGap || i === rec.steps.length - 1) {
      checkpoints.push({
        i,
        ev: s.ev,
        walkTime: s.walkTime,
        targets: s.targets,
        live: s.live,
      });
    }
  });
  return { checkpoints, final: rec.final };
}

// ---------------------------------------------------------------------------
// walk-replay — the whole Solo loop: deriveWorld + walk-stats through the
// documented metrics/coach-live/show seams.
// ---------------------------------------------------------------------------

export interface ReplayModeParams {
  idealPace: number;
  passThreshold: number;
  weights: Record<string, number>;
  walkSeconds: number;
}

export interface ReplayFrame {
  t: number;
  walkTime: number;
  keypoints: Record<string, PoseKeypoint>;
}

export interface ReplayResult {
  snapshots: Array<Record<string, number>>;
  cues: Array<{ t: number; kind: string; text: string }>;
  cueContext: Array<{
    t: number;
    walkRemainingSec: number;
    walkProgress01: number;
    markAtSec: number | null;
  }>;
  durationSec: number;
  overall: number;
  finalStats: unknown;
  report: unknown;
}

/**
 * Drive one replay through the REAL modules. `markAt(frameIdx, sampleIdx)`
 * supplies the turn-mark for each 2 Hz sample: the generator feeds its
 * synthesized per-frame marks; the replay net feeds the vector's OWN
 * emitted cueContext (data, not rules) and cross-checks the returned
 * cueContext against it.
 */
export function runReplay(
  hz: number,
  frames: ReadonlyArray<ReplayFrame>,
  mode: ReplayModeParams,
  durationSecCap: number,
  markAt: (frameIdx: number, sampleIdx: number) => number | null,
): ReplayResult {
  const state = new PoseDeriveState();
  const acc = new WalkStatsAccumulator();
  const target = new Float32Array(7);
  const smooth = new Float32Array(7);
  const policy = new LiveCoachPolicy();
  acc.reset(mode.idealPace);
  target.fill(NEUTRAL);
  smooth.fill(NEUTRAL);
  state.reset();
  policy.reset();

  const delta = 1 / hz;
  let poseLastT = -1;
  let publishAcc = 0;
  let sampleAcc = 0;
  let walkTime = 0;
  let published: Record<string, number> | null = null;
  const snapshots: Array<Record<string, number>> = [];
  const cues: ReplayResult["cues"] = [];
  const cueContext: ReplayResult["cueContext"] = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    walkTime = frame.walkTime; // the accumulated clock, stamped into the tape

    // metrics.ts: derive only on a fresh frame.t with the true inter-pose dt.
    if (frame.t !== poseLastT) {
      const poseDt = poseLastT >= 0 ? (frame.t - poseLastT) / 1000 : 0;
      poseLastT = frame.t;
      deriveWorld(
        {
          t: frame.t,
          source: "golden",
          space: "world",
          keypoints: frame.keypoints,
        },
        poseDt,
        walkTime,
        mode.idealPace,
        mode.walkSeconds,
        state,
        acc,
        target,
      );
    }

    // metrics.ts: display smoothing + the ~6 Hz rounded publish (the ramp
    // and blend FORMS come from metrics-wiring.ts, the module metrics.ts
    // itself runs — not a replica).
    const rampIn = rampInWeight(walkTime);
    const blend = displayBlend(delta);
    for (let k = 0; k < 7; k++) {
      const goal = NEUTRAL + (clampScore(target[k]) - NEUTRAL) * rampIn;
      smooth[k] += (goal - smooth[k]) * blend;
    }
    publishAcc += delta;
    if (publishAcc >= PUBLISH_INTERVAL) {
      publishAcc %= PUBLISH_INTERVAL;
      published = {};
      for (let k = 0; k < 7; k++) {
        published[METRIC_ORDER[k]] = Math.round(smooth[k]);
      }
      snapshots.push({ t: walkTime, ...published });
    }

    // coach-live-system.ts: the 2 Hz policy sample off the live taps.
    sampleAcc += delta;
    if (sampleAcc >= COACH_SAMPLE_SEC) {
      sampleAcc %= COACH_SAMPLE_SEC;
      const pace = acc.livePaceMps;
      const lat = acc.liveLateralM;
      const post = acc.livePostureM;
      const input = {
        walking: true,
        walkRemainingSec: Math.max(0, mode.walkSeconds - walkTime),
        markAtSec: markAt(i, cueContext.length),
        walkProgress01: Math.min(walkTime / durationSecCap, 1),
        oneWayRoute: false,
        paceDeltaMps:
          pace !== null && Number.isFinite(pace)
            ? pace - mode.idealPace
            : null,
        absLateralM:
          lat !== null && Number.isFinite(lat) ? Math.abs(lat) : null,
        postureM: post !== null && Number.isFinite(post) ? post : null,
      };
      cueContext.push({
        t: walkTime,
        walkRemainingSec: input.walkRemainingSec,
        walkProgress01: input.walkProgress01,
        markAtSec: input.markAtSec,
      });
      const cue = policy.decideLiveCue(input, walkTime);
      if (cue) cues.push({ t: walkTime, kind: cue.kind, text: cue.text });
    }
  }

  // show.ts finishWalk: the timed-out rollup + the post-walk coach report.
  const finalStats = acc.finalize(walkTime);
  const durationSec = Math.round(walkTime * 10) / 10;
  const scores = published!;
  let weighted = 0;
  for (const key of METRIC_ORDER) {
    weighted += scores[key] * mode.weights[key];
  }
  const overall = Math.max(0, Math.min(100, Math.round(weighted)));
  const report = buildCoachReport({
    scores,
    overall,
    mode,
    stats: finalStats,
    oneWayRoute: false,
  } as unknown as CoachContext);
  return {
    snapshots,
    cues,
    cueContext,
    durationSec,
    overall,
    finalStats,
    report,
  };
}

// ---------------------------------------------------------------------------
// walk-replay-solo — the SOLO engine loop: soloDeriveWorld (§3 channels +
// turn-window exclusion) + the §2 gap rule + the solo-gated 2 Hz policy.
// This is the seam-spec the Swift SoloWalkCore implements; the Swift test
// drives the PRODUCTION core with these vectors (not a test-local mirror).
// ---------------------------------------------------------------------------

/** A travel-heading reversal in a solo tape: the frame it lands on and the
 * walk-clock second it stamps (markAtSec). Sparse — most frames have none. */
export interface SoloMark {
  frameIdx: number;
  atSec: number;
}

export interface SoloReplayResult extends ReplayResult {
  /** §2 gap-rule firings (resetCadence + re-seed) during the replay. */
  gapResets: number;
}

/**
 * Drive one SOLO replay through the REAL modules. Differences from
 * runReplay, each a pinned Solo-engine rule:
 *  - soloDeriveWorld (§3 hip posture + travel-line lateral), with
 *    `turnExcluded` = within SOLO_TURN_EXCLUDE_SEC of the latest mark;
 *  - the §2 gap rule: a fresh frame arriving > SOLO_GAP_SEC after the last
 *    one resets cadence and re-seeds (derives with dt 0, zero weight);
 *  - ticks are FRAME-DRIVEN at the frame's REAL dt (walkTime deltas), so a
 *    tape gap coalesces into one smoothing/publish/sample tick — the
 *    device engine does the same at its capture rate;
 *  - ONE clock: the engine's only time source is the monotonic capture
 *    timestamp, so this runner derives poseDt from the SAME walkTime
 *    deltas that drive the ticks (walk-replay's two-clock t-vs-walkTime
 *    split would diverge from the device loop at the floating-point level,
 *    and accumulator boundary flips are not inside any tolerance);
 *  - the policy runs the SOLO cue gates, and its absLateralM input is the
 *    SMOOTHED |liveLateralM| (SOLO_LATERAL_CUE_SMOOTH_RATE EMA on the 2 Hz
 *    grid — see the constant's docstring for why the raw travel-line tap
 *    can never satisfy the continuous-hold law);
 *  - COPY NOTE: cue/report strings are emitted with the WEB copy tables —
 *    the Solo copy substitution is a CONSUMER rule (coach-copy.ts): the
 *    Swift runner renders .solo and applies the vector-locked copy-variants
 *    table to the expected strings before exact comparison.
 *
 * Two engine rules live OUTSIDE this tape's reach and are unit-tested on
 * the Swift side instead (SoloWalkCoreRuleTests): dark TIMER ticks (no
 * frames > SOLO_GAP_SEC -> the sampler runs with null channels, clearing
 * fault clocks — the closed-gate law) and the §2 anchor-jump guard (a hip
 * displacement no stride can produce is treated as a gap). Neither can
 * fire on a frame tape: ticks are frame-driven here and the walker never
 * teleports.
 */
export function runSoloReplay(
  frames: ReadonlyArray<ReplayFrame>,
  mode: ReplayModeParams,
  marks: ReadonlyArray<SoloMark>,
): SoloReplayResult {
  const state = new PoseDeriveState();
  const acc = new WalkStatsAccumulator();
  const target = new Float32Array(7);
  const smooth = new Float32Array(7);
  const policy = new LiveCoachPolicy(SOLO_CUE_GATES);
  acc.reset(mode.idealPace);
  target.fill(NEUTRAL);
  smooth.fill(NEUTRAL);
  state.reset();
  policy.reset();

  let lastFreshWalkTime = -1;
  let publishAcc = 0;
  let sampleAcc = 0;
  let walkTime = 0;
  let prevWalkTime = 0;
  let markAtSec: number | null = null;
  let nextMark = 0;
  let gapResets = 0;
  // The lateral cue-input EMA (see the runner docstring): folds |raw tap|
  // per 2 Hz sample; HOLDS (no fold, no decay) while the tap is dark, and
  // reports the held value for dark spells <= SOLO_GAP_SEC (a stability
  // blip must not reset the fault clock), null beyond (turn windows DO
  // clear — the coach-live dark-tap rule).
  let latCueEma = 0;
  let latMeasuredAt = Number.NEGATIVE_INFINITY;
  const latCueAlpha = 1 - Math.exp(-SOLO_LATERAL_CUE_SMOOTH_RATE * COACH_SAMPLE_SEC);
  let published: Record<string, number> | null = null;
  const snapshots: Array<Record<string, number>> = [];
  const cues: ReplayResult["cues"] = [];
  const cueContext: ReplayResult["cueContext"] = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    walkTime = frame.walkTime;
    const dt = walkTime - prevWalkTime; // real inter-frame interval
    prevWalkTime = walkTime;

    // Mark feed: the MOST RECENT reversal at or before this frame (§2).
    while (nextMark < marks.length && marks[nextMark].frameIdx <= i) {
      markAtSec = marks[nextMark].atSec;
      nextMark++;
    }
    const turnExcluded =
      markAtSec !== null && walkTime - markAtSec < SOLO_TURN_EXCLUDE_SEC;

    // The fresh-frame gate + the §2 gap rule around it — on the ONE clock
    // (walkTime, i.e. the engine's monotonic capture timestamps).
    if (walkTime !== lastFreshWalkTime) {
      let poseDt = lastFreshWalkTime >= 0 ? walkTime - lastFreshWalkTime : 0;
      lastFreshWalkTime = walkTime;
      if (poseDt > SOLO_GAP_SEC) {
        // Zero weight + re-seed: the outage must not be measured.
        state.resetCadence();
        poseDt = 0;
        gapResets++;
      }
      soloDeriveWorld(
        {
          t: frame.t,
          source: "golden",
          space: "world",
          keypoints: frame.keypoints,
        },
        poseDt,
        walkTime,
        mode.idealPace,
        mode.walkSeconds,
        state,
        acc,
        target,
        turnExcluded,
      );
    }

    // Display smoothing + ~6 Hz publish, at the frame's REAL dt.
    const rampIn = rampInWeight(walkTime);
    const blend = displayBlend(dt);
    for (let k = 0; k < 7; k++) {
      const goal = NEUTRAL + (clampScore(target[k]) - NEUTRAL) * rampIn;
      smooth[k] += (goal - smooth[k]) * blend;
    }
    publishAcc += dt;
    if (publishAcc >= PUBLISH_INTERVAL) {
      publishAcc %= PUBLISH_INTERVAL;
      published = {};
      for (let k = 0; k < 7; k++) {
        published[METRIC_ORDER[k]] = Math.round(smooth[k]);
      }
      snapshots.push({ t: walkTime, ...published });
    }

    // The 2 Hz policy sample off the live taps (solo gates).
    sampleAcc += dt;
    if (sampleAcc >= COACH_SAMPLE_SEC) {
      sampleAcc %= COACH_SAMPLE_SEC;
      const pace = acc.livePaceMps;
      const lat = acc.liveLateralM;
      const post = acc.livePostureM;
      // Solo lateral cue input: the smoothed |offset| (constant's docstring
      // has the full why), held through sub-SOLO_GAP_SEC dark blips.
      let absLat: number | null = null;
      if (lat !== null && Number.isFinite(lat)) {
        latCueEma += (Math.abs(lat) - latCueEma) * latCueAlpha;
        latMeasuredAt = walkTime;
        absLat = latCueEma;
      } else if (walkTime - latMeasuredAt <= SOLO_GAP_SEC) {
        absLat = latCueEma;
      }
      const input = {
        walking: true,
        walkRemainingSec: Math.max(0, mode.walkSeconds - walkTime),
        markAtSec,
        // §2: progress is CLOCK-based, elapsed / the mode's walkSeconds —
        // ONE source shared with the Swift engine (a free cap parameter
        // here could fork the fast-finisher arithmetic undetected).
        walkProgress01: Math.min(walkTime / mode.walkSeconds, 1),
        oneWayRoute: false,
        paceDeltaMps:
          pace !== null && Number.isFinite(pace)
            ? pace - mode.idealPace
            : null,
        absLateralM: absLat,
        postureM: post !== null && Number.isFinite(post) ? post : null,
      };
      cueContext.push({
        t: walkTime,
        walkRemainingSec: input.walkRemainingSec,
        walkProgress01: input.walkProgress01,
        markAtSec: input.markAtSec,
      });
      const cue = policy.decideLiveCue(input, walkTime);
      if (cue) cues.push({ t: walkTime, kind: cue.kind, text: cue.text });
    }
  }

  // The timed-out rollup + the post-walk coach report (web copy — see the
  // COPY NOTE above).
  const finalStats = acc.finalize(walkTime);
  const durationSec = Math.round(walkTime * 10) / 10;
  const scores = published!;
  let weighted = 0;
  for (const key of METRIC_ORDER) {
    weighted += scores[key] * mode.weights[key];
  }
  const overall = Math.max(0, Math.min(100, Math.round(weighted)));
  const report = buildCoachReport({
    scores,
    overall,
    mode,
    stats: finalStats,
    oneWayRoute: false,
  } as unknown as CoachContext);
  return {
    snapshots,
    cues,
    cueContext,
    durationSec,
    overall,
    finalStats,
    report,
    gapResets,
  };
}

// ---------------------------------------------------------------------------
// Wave 1 families — fit-core / head-carriage / hold-stats / repeatability.
//
// Query-style runners (the runProgressQueries pattern): pure JSON-in/JSON-out,
// shared verbatim by the emitter (scripts/gen-golden-vectors.mjs) and the
// replay net, so vectors and their replay are provably one truth. Tape
// drivers come from the SHARED helper files (test/fit-helpers.ts,
// carriage-helpers.ts, hold-helpers.ts — node-loadable, no vitest; the
// case-helpers law); nothing scoring-relevant is re-implemented here. Every
// family carries a "constants"/"tables" query built from the LIVE module
// exports, so replaying the checked-in table against these runners is the
// same tripwire coach-tables gets from golden-freshness.
//
// The progress family is deliberately untouched: M12's benchmark queries ride
// runRepeatabilityQueries below (adjudication §J — an additive key on the
// shared progress runner would fail the replay's exact key-set diff on the
// frozen progress cases).
// ---------------------------------------------------------------------------

/** One decoded golden query ({fn, args} — the runProgressQueries shape). */
export interface GoldenQuery {
  fn: string;
  args?: Record<string, unknown>;
}

/** One fit-machine replay event: a pushed head frame (the full push()
 * signature as data), or the external-interruption op. */
export interface FitMachineEvent {
  op?: "cancel";
  dt?: number;
  x?: number;
  y?: number;
  z?: number;
  qx?: number;
  qy?: number;
  qz?: number;
  qw?: number;
  along?: number;
  lateral?: number;
}

export function runFitQueries(queries: ReadonlyArray<GoldenQuery>): unknown[] {
  return queries.map((q) => {
    const fn = q.fn;
    const a = (q.args ?? {}) as Record<string, never>;
    if (fn === "steadyBand") return fitSteadyBand(a.spanM);
    if (fn === "detector") {
      // Samples are DATA (the emitter serializes the seeded helper tapes);
      // the detector is the REAL production class.
      const det = new StillStandDetector();
      const doneAtSec = feedDetector(det, a.samples as ReadonlyArray<HeadSample>);
      return {
        doneAtSec,
        done: det.done(),
        holdSec: det.holdSec,
        windowFull: det.windowFull,
        windowStd3D: det.windowStd3D(),
        // result() is contractually valid only when done() — never emitted
        // otherwise (its zeros would read as fake measurements).
        result: det.done() ? det.result() : null,
      };
    }
    if (fn === "walk") {
      const spanM = a.spanM as number;
      const band = fitSteadyBand(spanM);
      const acc = new FitWalkAccumulator();
      acc.reset(band.loFrac, band.hiFrac, band.minSteadySec);
      feedWalk(acc, a.samples as ReadonlyArray<WalkSample>, spanM);
      return acc.finalize();
    }
    if (fn === "machine") {
      const m = new FitCaptureMachine();
      const startOk = m.start(a.cfg as FitStartConfig);
      const edges: unknown[] = [];
      const drain = (): void => {
        const e = m.takeEdge();
        if (e) edges.push(e);
      };
      drain(); // the start() edge (or nothing on a refused start)
      for (const evRaw of a.events as ReadonlyArray<FitMachineEvent>) {
        const ev = evRaw;
        if (ev.op === "cancel") {
          m.cancel();
        } else {
          m.push(
            ev.dt as number,
            ev.x as number,
            ev.y as number,
            ev.z as number,
            ev.qx as number,
            ev.qy as number,
            ev.qz as number,
            ev.qw as number,
            ev.along as number,
            ev.lateral as number,
          );
        }
        drain();
      }
      return {
        startOk,
        edges,
        stage: m.stage,
        detail: m.detail,
        progress: m.progress,
        baseline: m.baseline,
      };
    }
    if (fn === "derive") {
      return deriveHeadNormalization(
        a.baseline as BodyBaseline | null,
        a.traineeId as string | null | undefined,
      );
    }
    if (fn === "stamp") {
      return normalizationStamp(
        a.baseline as BodyBaseline | null,
        a.traineeId as string | null | undefined,
      );
    }
    if (fn === "sanitize") return sanitizeBodyBaseline(a.value, a.nowMs as number);
    if (fn === "constants") {
      return {
        FIT_STILL_STD_M,
        FIT_STILL_WINDOW_SEC,
        FIT_STILL_SAMPLE_HZ,
        FIT_STILL_HOLD_SEC,
        FIT_STAND_REPROMPT_SEC,
        FIT_STAND_TIMEOUT_SEC,
        FIT_MARK_RADIUS_M,
        FIT_MARK_LATERAL_M,
        FIT_MARK_TIMEOUT_SEC,
        FIT_WALK_TIMEOUT_SEC,
        FIT_STEADY_MARGIN_FRAC,
        FIT_STEADY_MARGIN_CAP_M,
        FIT_MIN_SPEED_MPS,
        FIT_GAP_SEC,
        FIT_MIN_CADENCE_INTERVALS,
        FIT_CAPTURE_BOB_THRESHOLD_M,
        FIT_TERMINAL_HOLD_SEC,
        FIT_LINES,
        DEFAULT_NORMALIZATION_STAMP,
        DEFAULT_BOB_THRESHOLD_M,
        DEFAULT_POSTURE_SLOPE,
        DEFAULT_HEAD_HEIGHT_M,
        DEFAULT_HEAD_NORMALIZATION,
        BOB_HYST_RATIO,
        BOB_THRESHOLD_FLOOR_M,
        BOB_THRESHOLD_CAP_M,
        POSTURE_SLOPE_NUMERATOR,
        FIT_HEIGHT_MIN_M,
        FIT_HEIGHT_MAX_M,
        FIT_STILL_NOISE_MAX_M,
        FIT_NEUTRAL_PITCH_MAX_RAD,
        FIT_PACE_MIN_MPS,
        FIT_PACE_MAX_MPS,
        FIT_CADENCE_MIN_SPM,
        FIT_CADENCE_MAX_SPM,
        FIT_BOB_AMP_MIN_M,
        FIT_BOB_AMP_MAX_M,
        FIT_CAPTURED_AT_SLACK_MS,
        FIT_STORAGE_KEY,
      };
    }
    throw new Error(`unknown fit-core query ${fn}`);
  });
}

/** One §B presence-blend frame step as data. `target4: null` means "feed the
 * PREVIOUS step's output back in as target[4]" — the repeated-cached-frame
 * shape whose bit-stability the idempotence pin asserts. */
export interface BlendStep {
  derived: boolean;
  target4: number | null;
  engaged: boolean;
  carriageScore: number;
}

export function runCarriageQueries(
  queries: ReadonlyArray<GoldenQuery>,
): unknown[] {
  return queries.map((q) => {
    const fn = q.fn;
    const a = (q.args ?? {}) as Record<string, never>;
    if (fn === "tape") {
      // Ops are DATA (JSON-decoded); the tracker is the REAL production
      // class, driven by the SAME shared runner the vitest suite uses.
      const r = runCarriageTape(a.ops as ReadonlyArray<CarriageOp>);
      return {
        stats: r.stats,
        livePitchDevDeg: r.livePitchDevDeg,
        liveYawDevDeg: r.liveYawDevDeg,
        engaged: r.engaged,
        walkTime: r.walkTime,
      };
    }
    if (fn === "score") {
      return carriageScoreOf(a.pitchFrac, a.yawFrac as number | null);
    }
    if (fn === "blend") return blendPresence(a.legacy, a.carriage);
    if (fn === "stepBlend") {
      const latch = { legacy: a.legacy0 as number };
      const outputs: number[] = [];
      let prev = 0;
      for (const s of a.steps as ReadonlyArray<BlendStep>) {
        const t4 = s.target4 === null ? prev : s.target4;
        prev = stepPresenceBlend(latch, s.derived, t4, s.engaged, s.carriageScore);
        outputs.push(prev);
      }
      return { outputs, latchLegacy: latch.legacy };
    }
    if (fn === "line") {
      const stats = a.stats as CarriageStats | null;
      return a.sep !== undefined ? carriageLine(stats, a.sep) : carriageLine(stats);
    }
    if (fn === "cue") return carriagePresenceCue(a.stats as CarriageStats);
    if (fn === "markTurnFlags") {
      // The M8 yaw-flag LAW (metrics.ts wiring runs this pure function per
      // frame with a preallocated out-object; the runner may allocate).
      return markTurnFlags(
        a.markAtWalkTime as number,
        a.walkTime as number,
        a.routeOneWay as boolean,
        { returning: false, yawSuppressed: false },
      );
    }
    if (fn === "applyNotes") {
      const report = buildCoachReport(a.context as CoachContext);
      const applied = applyCarriageNotes(report, a.carriage as CarriageStats | null);
      // The identity flag IS part of the contract (adjudication §I: identity
      // unless carriage + presence note + qualifying cue all hold).
      return { identity: applied === report, report: applied };
    }
    if (fn === "tables") {
      return {
        M8_PITCH_BAND_DEG,
        M8_YAW_BAND_DEG,
        M8_GLANCE_PITCH_DEG,
        M8_GLANCE_REARM_DEG,
        M8_TURN_EXCLUDE_SEC,
        M8_ENGAGE_SEC,
        M8_NEUTRAL_FALLBACK_SEC,
        M8_NEUTRAL_SANE_DEG,
        M8_STAND_SPEED_MAX_MPS,
        M8_MIN_HORIZ,
        M8_EMA_RATE,
        M8_YAW_MIN_SEC,
        M8_PITCH_FRAC_WEIGHT,
        M8_PRESENCE_WEIGHT,
        M8_YAW_CUE_MIN_OFF_PCT,
        CARRIAGE_TOOLTIP,
        PRESENCE_EXPLAIN_WITH_CARRIAGE,
        COMPOSITE_CAPTION_WITH_CARRIAGE,
        // Source-aware tooltip variants (CARRIAGE_TOOLTIP aliases "stand").
        carriageTooltipStand: carriageTooltip("stand"),
        carriageTooltipFit: carriageTooltip("fit"),
        carriageTooltipWalk: carriageTooltip("walk"),
      };
    }
    throw new Error(`unknown head-carriage query ${fn}`);
  });
}

export function runHoldQueries(queries: ReadonlyArray<GoldenQuery>): unknown[] {
  return queries.map((q) => {
    const fn = q.fn;
    const a = (q.args ?? {}) as Record<string, never>;
    if (fn === "tape") {
      // Frames are DATA; the accumulator is the REAL production class fed by
      // the SHARED hold-helpers drivers. The copy rides along so every tape
      // also pins the line/cue rendered from its own stats + nullReason,
      // and the ARMING queries (armed/armedAtSec — the arrival law) lock
      // when the measured window opened for this input.
      const acc = newHoldAcc((a.fit ?? null) as number | null);
      if (a.markReached === true) acc.markReached(); // the wiring-side latch
      feedHoldFrames(acc, a.frames as HoldFrame[]);
      const stats = acc.finalize((a.walkBase ?? null) as number | null);
      const nullReason = acc.nullReason();
      return {
        stats,
        nullReason,
        liveStill01: acc.liveStill01,
        armed: acc.armed,
        armedAtSec: acc.armedAtSec,
        line: holdStatLine(stats, nullReason),
        cue: holdCue(stats, nullReason),
      };
    }
    if (fn === "copy") {
      const stats = a.stats as HoldStats | null;
      const nullReason = a.nullReason as HoldNullReason;
      return { line: holdStatLine(stats, nullReason), cue: holdCue(stats, nullReason) };
    }
    if (fn === "tables") {
      return {
        HOLD_WINDOW_SEC,
        HOLD_REF_HEAD_M,
        HOLD_STILL_GOOD_NORM_CM,
        HOLD_STILL_FAULT_NORM_CM,
        HOLD_MARK_GOOD_CM,
        HOLD_MARK_FAULT_CM,
        HOLD_ARRIVE_EPS_M,
        HOLD_SPEED_STILL_MPS,
        HOLD_SPEED_EMA_RATE,
        HOLD_RELEASE_SEC,
        HOLD_YAW_HORIZ_MIN,
        HOLD_STAND_MIN_M,
        HOLD_SPEED_CLAMP_MPS,
        HOLD_EXPLAIN,
      };
    }
    throw new Error(`unknown hold-stats query ${fn}`);
  });
}

export function runRepeatabilityQueries(
  rows: unknown[],
  queries: ReadonlyArray<GoldenQuery>,
): unknown[] {
  const r = rows as ReadonlyArray<RepeatRow>;
  return queries.map((q) => {
    const fn = q.fn;
    const a = (q.args ?? {}) as Record<string, never>;
    if (fn === "repeatabilityReport") {
      return a.window !== undefined
        ? repeatabilityReport(r, a.window)
        : repeatabilityReport(r);
    }
    if (fn === "isBenchmarkRow") return isBenchmarkRow(a.row);
    if (fn === "benchmarkRows") return benchmarkRows(r);
    if (fn === "benchmarkSeries") {
      return a.max !== undefined ? benchmarkSeries(r, a.max) : benchmarkSeries(r);
    }
    if (fn === "benchmarkHeadline") return benchmarkHeadline(r);
    if (fn === "benchmarkLine") {
      // The line is a pure function of the headline; deriving it from the
      // case's own rows keeps the query data-only (no function-valued args).
      const h = benchmarkHeadline(r);
      return h === null ? null : benchmarkLine(h);
    }
    if (fn === "benchmarkConfigAtWalkStart") {
      return benchmarkConfigAtWalkStart(a.synthetic, a.modeId, a.shapeKind);
    }
    if (fn === "benchmarkAtFinalize") {
      // An absent `stamped` key deliberately reads as undefined (the legacy
      // wire shape the predicate must reject).
      return benchmarkAtFinalize(a.stamped, a.modeId);
    }
    if (fn === "withinPct") return withinPct(a.v);
    if (fn === "rowNormalization") return rowNormalizationFallback(a.row);
    if (fn === "constants") {
      return {
        REPEAT_MIN_WALKS,
        REPEAT_WINDOW,
        REPEAT_OUTLIER_PCT,
        REPEAT_OUTLIER_DOMINANCE,
        REPEAT_DISCLOSURE,
        DEFAULT_NORMALIZATION,
        BENCHMARK_MODE_ID,
        BENCHMARK_SHAPE_KIND,
        BENCHMARK_HEADLINE_SHOWN,
        BENCHMARK_TOOLTIP,
      };
    }
    throw new Error(`unknown repeatability query ${fn}`);
  });
}

// ---------------------------------------------------------------------------
// Wave 2 families — beat-stats / turn-stats (M9 BEAT LOCK + M11 THE TURN).
//
// The same query-runner pattern as Wave 1 (runHoldQueries): pure
// JSON-in/JSON-out, shared verbatim by the emitter and the replay net. Tape
// drivers come from the SHARED helper files (test/beat-helpers.ts,
// test/turn-helpers.ts — node-loadable, no vitest; the case-helpers law);
// nothing scoring-relevant is re-implemented here. Wave 2 adjudication §F
// bootstrap order: these runners land in the CODE commit beside the
// modules; the GOLDEN_MODULES registration + golden-replay.test.ts wiring +
// the JSON families + the Swift mirror sync land in the VECTORS commit.
// ---------------------------------------------------------------------------

/** A beat tape op as vector data: the shared BeatOp stream plus the
 * `{ op: "finalize" }` marker. The adjudication-§D walk-end tape needs a
 * MID-TAPE finalize (ShowDirector at priority 0 stamps the summary BEFORE
 * MetricsSystem's finishing-frame choke point at 12, so the final strike is
 * excluded), and finalize() is the accumulator's own non-destructive
 * re-callable — the marker stays data while the REAL module does all the
 * work. */
export type BeatTapeOp = BeatOp | { op: "finalize" };

export function runBeatQueries(queries: ReadonlyArray<GoldenQuery>): unknown[] {
  return queries.map((q) => {
    const fn = q.fn;
    const a = (q.args ?? {}) as Record<string, never>;
    if (fn === "tape") {
      // Ops are DATA (serialized helper-built tapes); the accumulator is the
      // REAL production class fed by the SHARED beat-helpers driver
      // (feedBeatOps — the wiring-feed law). The copy rides along so every
      // tape also pins the line/cue rendered from its own stats + reason.
      const acc = new BeatAccumulator();
      // bpm is FIXTURE DATA (the multi-BPM wave): the historical tapes pin
      // the legacy 122 engine tempo explicitly; per-tempo cases pin their
      // own. An absent field reads 122 so pre-wave JSON stays replayable.
      acc.reset(
        (a.goValid ?? true) as boolean,
        (a.bpm ?? 122) as number,
        (a.fit ?? null) as number | null,
      );
      const finals: Array<{
        stats: BeatStats | null;
        nullReason: BeatNullReason;
      }> = [];
      let seg: BeatOp[] = [];
      for (const raw of a.ops as ReadonlyArray<BeatTapeOp>) {
        if (raw.op === "finalize") {
          feedBeatOps(acc, seg);
          seg = [];
          finals.push({ stats: acc.finalize(), nullReason: acc.nullReason() });
        } else {
          seg.push(raw);
        }
      }
      feedBeatOps(acc, seg);
      const stats = acc.finalize();
      const nullReason = acc.nullReason();
      const out: Record<string, unknown> = {
        stats,
        nullReason,
        line: beatStatLine(stats, nullReason),
        cue: beatCue(stats, nullReason),
      };
      // Shape rule (the runWalkStatsOps precedent): `finals` rides along
      // only when the tape carries at least one mid-tape finalize marker.
      if (finals.length) out.finals = finals;
      return out;
    }
    if (fn === "copy") {
      const stats = a.stats as BeatStats | null;
      const nullReason = a.nullReason as BeatNullReason;
      return {
        line:
          a.sep !== undefined
            ? beatStatLine(stats, nullReason, a.sep)
            : beatStatLine(stats, nullReason),
        cue: beatCue(stats, nullReason),
      };
    }
    // `go` is deliberately unknown-typed data (the durable untyped global's
    // junk shapes — null / NaN / strings — are the point of the case).
    if (fn === "goFresh") return goAudioTimeFresh(a.now, a.go);
    if (fn === "wrap") return wrapPhaseBeats(a.x);
    if (fn === "chooser") {
      return chooseSubdivision(
        a.cadence as number | null,
        a.fit as number | null,
        (a.bpm ?? 122) as number,
      );
    }
    if (fn === "score") return beatScoreOf(a.r);
    if (fn === "firstTick") {
      const beatSec = 60 / ((a.bpm ?? 122) as number);
      return a.lead !== undefined
        ? firstPulseTick(a.now, a.go, beatSec, a.lead)
        : firstPulseTick(a.now, a.go, beatSec);
    }
    if (fn === "advanceTick") {
      const beatSec = 60 / ((a.bpm ?? 122) as number);
      return a.lead !== undefined
        ? advancePulseTick(a.next, a.now, beatSec, a.lead)
        : advancePulseTick(a.next, a.now, beatSec);
    }
    if (fn === "flam") {
      return a.countdown !== undefined
        ? countdownFlamSuppressed(a.pulse, a.go, a.countdown)
        : countdownFlamSuppressed(a.pulse, a.go);
    }
    if (fn === "tables") {
      return {
        BEAT_GRID_SPM_MIN,
        BEAT_GRID_SPM_MAX,
        // The candidate derivation byte-pinned per deliverable tempo (+ the
        // legacy fixture tempo) — the multi-BPM wave's drift lock.
        gridCandidates: {
          62: beatGridCandidates(62),
          100: beatGridCandidates(100),
          122: beatGridCandidates(122),
          125: beatGridCandidates(125),
        },
        BEAT_SUBDIV_DEADZONE_SPM,
        BEAT_MIN_STRIKES,
        BEAT_RAYLEIGH_DIRECTION_MIN,
        BEAT_DRIFT_MIN_SPM,
        BEAT_CADENCE_MIN_INTERVALS,
        BEAT_STRIKE_DEBOUNCE_SEC,
        BEAT_GO_STALE_BEFORE_SEC,
        BEAT_GO_FRESH_AFTER_SEC,
        BEAT_LOCK_GOOD_R,
        BEAT_LOCK_FAULT_R,
        BEAT_PULSE_LEAD_SEC,
        BEAT_PULSE_SEC,
        BEAT_PULSE_INTENSITY,
        BEAT_EARCON_LEAD_SEC,
        BEAT_EARCON_HZ,
        BEAT_EARCON_ATTACK_SEC,
        BEAT_EARCON_DECAY_SEC,
        BEAT_EARCON_LEVEL,
        BEAT_FLAM_SUPPRESS_SEC,
        BEAT_EXPLAIN,
        BEAT_SETTING_TIP,
      };
    }
    throw new Error(`unknown beat-stats query ${fn}`);
  });
}

export function runTurnQueries(queries: ReadonlyArray<GoldenQuery>): unknown[] {
  return queries.map((q) => {
    const fn = q.fn;
    const a = (q.args ?? {}) as Record<string, never>;
    if (fn === "tape") {
      // Ops are DATA; the tracker is the REAL production class replayed by
      // the SHARED turn-helpers runner (double-cover dither and all). The
      // copy rides along so every tape also pins the line/cue rendered from
      // its own stats + nullReason; walkTime pins the tape clock (dyadic
      // dt sums — exact by construction).
      const r = runTurnTape(a.ops as ReadonlyArray<TurnOp>, {
        walkBase: (a.walkBase ?? null) as number | null,
      });
      return {
        stats: r.stats,
        nullReason: r.reason,
        walkTime: r.walkTime,
        line: turnStatLine(r.stats, r.reason),
        cue: turnCue(r.stats, r.reason),
      };
    }
    if (fn === "copy") {
      const stats = a.stats as TurnStats | null;
      const nullReason = a.nullReason as TurnNullReason;
      return {
        line:
          a.sep !== undefined
            ? turnStatLine(stats, nullReason, a.sep)
            : turnStatLine(stats, nullReason),
        cue: turnCue(stats, nullReason),
      };
    }
    if (fn === "band") return turnDurBand(a.pace);
    if (fn === "tables") {
      return {
        TURN_ENTER_DEG,
        TURN_COMMIT_DEG,
        TURN_EXIT_DEG,
        TURN_REV_DEADBAND_DEG,
        TURN_DUR_BASE_PACE_MPS,
        TURN_DUR_BASE_LO_SEC,
        TURN_DUR_BASE_HI_SEC,
        TURN_DIP_FAULT_FRAC,
        TURN_DIP_EMA_RATE,
        TURN_REACQ_BAR_M,
        TURN_REACQ_SUSTAIN_SEC,
        TURN_RETURN_MIN_SEC,
        TURN_MIN_MEASURED_SEC,
        TURN_REACQ_CUE_SEC,
        TURN_EXPLAIN,
        PRESENTATION_EXPLAIN_WITH_TURN,
      };
    }
    throw new Error(`unknown turn-stats query ${fn}`);
  });
}
