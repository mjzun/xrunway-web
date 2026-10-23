/**
 * (X)RUNWAY — Show direction (REV3: live-mapped first-person training).
 *
 * ShowDirectorSystem owns the show state machine:
 *   idle → brief → countdown → walk → summary → (idle | next run)
 *
 * REV3: the walk phase belongs to THE TRAINEE, and it now runs in the USER-
 * MAPPED runway frame instead of hard-coded world -Z. The director holds one
 * `RunwayProjector`, subscribes to `globals.runwayLayout` (Signal<RunwayLayout>)
 * to keep it (and the cached start/pose along-coordinates) in sync, and each
 * update reads `this.player.head` world position (one preallocated Vector3,
 * zero per-frame allocation), projects it to the runway-local `along` axis, and
 * publishes:
 *
 *   walkProgress  — route-aware progress. Out-and-back routes (straight/T/X):
 *                   0..0.5 walking down the deck (startAlong → poseAlong),
 *                   0.5..1 walking back after reaching the pose mark. One-way
 *                   routes (U: legA→base→legB): 0..1 straight down the route to
 *                   the far end. Monotonically clamped (never published more than
 *                   0.05 below its peak, so head-tracking jitter can't run the
 *                   walk backwards). -1 outside the walk phase.
 *   walkRemaining — seconds left (LESSON.walkSeconds − elapsed, ≥ 0).
 *                   -1 outside the walk phase.
 *
 * The walk finishes when the route's finish is reached (out-and-back: reached
 * the mark AND back within FINISH_RADIUS of the start line; one-way: within
 * FINISH_RADIUS of the pose mark at the far end) OR at LESSON.walkSeconds —
 * whichever comes first.
 *
 * All phase timing is delta-accumulated in update() (no setTimeout), so the
 * show respects ECS pause. Energy is an exponential lerp toward a per-phase
 * target; sibling systems (stage mood, shaders, music) peek it every frame.
 *
 * Subscriber-throw safety: signal subscribers run synchronously inside the
 * setter and a throwing subscriber re-throws out of it. Director state is
 * therefore always settled BEFORE any signal publish, and the summary is
 * published before the phase flips so phase subscribers can read it.
 */

import { createSystem, Quaternion, Vector3 } from "@iwsdk/core";
import type { Signal } from "@preact/signals-core";

import { normalizationStamp, type BodyBaseline } from "./body-baseline.js";
import type { BeatNullReason, BeatStats } from "./beat-stats.js";
import type { CarriageStats } from "./head-carriage.js";
import {
  HOLD_WINDOW_SEC,
  HoldAccumulator,
  type HoldNullReason,
  type HoldStats,
} from "./hold-stats.js";
import { startAlong } from "./runway-layout.js";
import { holdRampT01, holdReleaseStep } from "./show-choreo.js";
import { COUNTDOWN_SEC } from "./show-timing.js";
import {
  compileShape,
  DEFAULT_SHAPE,
  RunwayPathProjector,
  type SegmentedPath,
} from "./runway-shape.js";
import { DEFAULT_MODE, type TrainingMode } from "./modes.js";
import {
  DEFAULT_WALK,
  resolveWalkSeconds,
  type WalkPrefs,
} from "./walk-prefs.js";
import type { TurnNullReason, TurnStats } from "./turn-stats.js";
import type { UserPrefs } from "./user-prefs.js";
import type { WalkStats, WalkStatsAccumulator } from "./walk-stats.js";

// ---------------------------------------------------------------------------
// Shared show types (imported by metrics / music / hud / landing / stage).
// ---------------------------------------------------------------------------

export type ShowPhaseValue = "idle" | "brief" | "countdown" | "walk" | "summary";

export interface ShowControls {
  /** Trainee walk: brief → countdown → walk (the user physically walks). */
  beginWalk(): void;
  /** Back to idle, music fades, energy settles to house level. */
  reset(): void;
}

export interface MetricSnapshot {
  pace: number;
  posture: number;
  rhythm: number;
  presence: number;
  footPlacement: number;
  confidence: number;
  presentation: number; // all 0..100
}

export interface ShowSummary {
  scores: MetricSnapshot;
  overall: number; // 0..100 weighted
  deltaVsLast: number | null; // vs previous run this session, null first time
  durationSec: number;
  /** REAL physical measurements for this walk (#8/#12/#22): true mean pace vs
   * the mode's ideal, SIGNED mean centerline offset, SIGNED posture drift,
   * step count + cadence (see walk-stats.ts for the sign conventions). Null
   * only when the walk never produced a sample (e.g. MetricsSystem absent). */
  stats: WalkStats | null;
  /** True when the route the lateral data was measured against is ONE-WAY (a
   * U: legA→base→legB). Snapshotted at WALK START (and refreshed on a
   * mid-walk remap, which also resets the lateral stats channel) — the
   * summary renderers pass THIS to the coach's left/right footwork gate, not
   * whatever shape is live at summary render time. */
  oneWayRoute: boolean;
  /** The LOCKED run mode's id + pass bar, stamped at finishWalk (mode-lock):
   * ShowDirector locks the mode for the whole run at beginWalk, so the
   * recorder row and BOTH summary renderers grade from THIS stamp — never the
   * live activeMode signal, which a brief-window mode switch can desync from
   * the mode that actually scored the walk. Null only in summaries built
   * without a director (tests / legacy fixtures); consumers fall back to
   * their live signal then. */
  modeId: string | null;
  passThreshold: number | null;
  /** The HEAD-path normalization stamp this walk was SCORED under
   * ("default.v1" | "fit.v1-<capturedAt ms>") — the modeId stamp pattern:
   * MetricsSystem locks it at walk start (globals.walkNormalization), this
   * director copies it here at finishWalk, and the recorder persists it so
   * pre-FIT and post-FIT scores are never trended as one series. Optional
   * (additive — legacy fixtures compile); null in metrics-less worlds. The
   * row-side reader (rowNormalization, session-grading.ts) treats
   * null/absent as "default.v1". */
  normalization?: string | null;
  /** The delivered music/haptic/scoring tempo (BPM) this walk ran at —
   * MetricsSystem latches it at walk start (globals.walkBpm: the armed
   * globals.goBpm under a valid clock, else the resolved pref) following
   * the walkNormalization stamp law; this director copies it here at
   * finishWalk and the recorder persists it, so walks at different tempos
   * are never silently trended as one beat series. ADDITIVE-OPTIONAL:
   * absent on legacy fixtures; null in metrics-less worlds. */
  musicBpm?: number | null;
  /** The CONFIGURED walk length this run was locked to (the user-set
   * duration pref resolved at startRun; 10-60 s, mode default 20) — distinct
   * from durationSec, the MEASURED elapsed time (a positional finish ends
   * early). The set value is the lesson parameter: it drives the export
   * column and the repeatability/benchmark group keys, so walks of
   * different lengths are never silently trended as one series (the
   * musicBpm stamp law). ADDITIVE-OPTIONAL: absent on legacy fixtures. */
  walkSecondsSet?: number;
  /** Head-carriage read for this walk (M8 — head orientation, not gaze), or
   * null/absent when the channel never engaged (short walk, no orientation
   * stream, metrics-less world, legacy fixture). ADDITIVE-OPTIONAL. Non-null
   * ALSO stamps that the M5 presence blend included measured carriage
   * (engaged <=> non-null — one criterion, head-carriage.ts M8_ENGAGE_SEC). */
  carriage?: CarriageStats | null;
  /** M10 hold read for this walk (head sensor: stillness + mark accuracy in
   * the fixed post-mark window, hold-stats.ts). ADDITIVE-OPTIONAL: absent on
   * legacy fixtures / summaries built without a director (surfaces hide the
   * row); null when the window measured nothing (see holdNullReason). */
  hold?: HoldStats | null;
  /** WHY hold is null (adjudication §K — the copy branches on it):
   * "never-marked" = the walk ended before the pose mark; "no-data" = the
   * mark was reached but the window never accepted a measured sample. Null
   * when hold is non-null; absent alongside an absent hold. */
  holdNullReason?: HoldNullReason | null;
  /** M9 beat-lock read for this walk (entrainment of detected footstrikes
   * to the DELIVERED beat reference, beat-stats.ts — head/hip-bob strikes,
   * never heel ground truth). ADDITIVE-OPTIONAL: absent on legacy fixtures
   * / summaries built without a director (surfaces hide the row); null
   * when the channel measured nothing (see beatNullReason). */
  beat?: BeatStats | null;
  /** WHY beat is null (the copy branches on it): "no-clock" = the grid
   * anchor was never valid at walk start; "no-reference" = no beat
   * reference was ever delivered; "too-few-strikes" = under the strike
   * floor. Null when beat is non-null — and null beside a null beat when
   * the metrics handle was absent (the surfaces' absent-reason fallback
   * "no-clock" then makes the weakest, internal claim). */
  beatNullReason?: BeatNullReason | null;
  /** M11 turn read for this walk (the head PATH through the out-and-back
   * 180, turn-stats.ts — feet are not tracked, never a foot pivot).
   * ADDITIVE-OPTIONAL: absent on legacy fixtures; null when no turn was
   * measured (see turnNullReason). */
  turn?: TurnStats | null;
  /** WHY turn is null (the copy branches on the 7-reason taxonomy). Null
   * when turn is non-null — AND null alongside a null turn when no tracker
   * was installed (metrics-less world): the surfaces hide the row only in
   * that both-null case (no analyzer ran, nothing to disclose —
   * turnRowStamped, summary-riders.ts). */
  turnNullReason?: TurnNullReason | null;
}

// ---------------------------------------------------------------------------
// Direction constants.
// ---------------------------------------------------------------------------

const BRIEF_SEC = 3.2;
// COUNTDOWN_SEC lives in show-timing.ts (ONE clock, #44): MusicSystem re-anchors
// its bar grid to `countdown start + COUNTDOWN_SEC`, so THE DROP lands exactly
// on the countdown→walk flip this director times with the same constant.
/** Exponential energy-lerp rate (higher = snappier). */
const ENERGY_RATE = 2.2;

/** "Reached the pose mark" radius along the walk axis (m). */
const MARK_RADIUS = 0.4;
/** "Back at the start line" radius along the walk axis (m). */
const FINISH_RADIUS = 0.4;
/** Max backwards jitter tolerated on walkProgress (monotonic clamp). */
const JITTER_BACK = 0.05;
/** One-way (U) routes finish AT the pose mark — hold there this long after
 * SETTLING on the mark (the hold accumulator's arming edge, holdStartElapsed)
 * so the trainee actually gets the documented "hold the pose" beat (paparazzi
 * burst) before the summary, instead of an instant cut. Keying the dwell off
 * the SETTLE (not the 0.4 m latch) keeps the full measured window inside the
 * walk on every honest U run; if tracking goes dark and the window never
 * arms, the U walk still ends via the walkSeconds timeout (the untouched
 * fallback). The out-and-back routes get this beat naturally during the turn
 * + return. M10 single-sourcing: this IS the measured hold window — an
 * import alias of HOLD_WINDOW_SEC (byte-identical 1.6), so the U finish
 * dwell and the hold statistic can never diverge (test/show-timing.test.ts
 * pins the alias). */
const POSE_HOLD_SEC = HOLD_WINDOW_SEC;

const ENERGY_TARGET: Record<ShowPhaseValue, number> = {
  idle: 0.12,
  brief: 0.35,
  countdown: 0.6,
  walk: 1,
  summary: 0.45,
};

/**
 * Canonical metric key order for the weighted overall. The actual weights come
 * from the active mode (mode.weights, which sum to 1); this list only fixes the
 * 7 keys to roll up. The numbers here are the Beginner defaults / fallback.
 */
const OVERALL_WEIGHTS: ReadonlyArray<[keyof MetricSnapshot, number]> = [
  ["posture", 0.2],
  ["pace", 0.15],
  ["rhythm", 0.15],
  ["footPlacement", 0.2],
  ["presence", 0.1],
  ["confidence", 0.1],
  ["presentation", 0.1],
];

/** Neutral fallback if a run somehow ends before any metric tick. */
const FALLBACK_SCORE = 62;

// ---------------------------------------------------------------------------
// System.
// ---------------------------------------------------------------------------

export class ShowDirectorSystem extends createSystem({}, {}) {
  private phaseSig!: Signal<ShowPhaseValue>;
  private energySig!: Signal<number>;
  private walkProgressSig!: Signal<number>;
  private walkRemainingSig!: Signal<number>;
  private metricsSig!: Signal<MetricSnapshot | null>;
  private summarySig!: Signal<ShowSummary | null>;

  /** Seconds accumulated inside the current phase. */
  private phaseElapsed = 0;
  /** Walk: has the trainee reached the pose mark this run? */
  private reachedMark = false;
  /** Walk: phaseElapsed when the pose mark was reached (one-way pose dwell). */
  private markElapsed = 0;
  /** Walk: peak raw progress so far (monotonic-clamp reference). */
  private peakProgress = 0;
  /** Previous run's overall, for deltaVsLast. RE-SEEDED from the recorder's
   * persisted history at EVERY walk start (#21 + night-review #9) — never
   * cached for the whole page load: CLEAR HISTORY must grade the next walk
   * as "FIRST WALK - BASELINE SET" (and never leak the erased score through
   * a persisted/exported delta), a trainee switch must re-scope it, and the
   * seed must track history as it grows. Without a recorder (tests/partial
   * worlds) it falls back to the in-session update in finishWalk. */
  private lastOverall: number | null = null;
  /** Recorder handle + trainee signal for the per-walk-start baseline seed.
   * The optional 2nd arg scopes the seed to the ACTIVE normalization stamp
   * (FIT wave — adversary A: never trend across a normalization change). */
  private recorder: {
    lastRealOverall(
      traineeId?: string | null,
      normalizationStamp?: string | null,
    ): number | null;
  } | null = null;
  private userPrefsSig?: Signal<UserPrefs>;

  /** Active-mode signal (walk length + score weights). */
  private modeSig?: Signal<TrainingMode>;
  private walkPrefsSig?: Signal<WalkPrefs>;
  /** Mode snapshotted at the START of the current run — locked for the whole walk. */
  private runMode: TrainingMode = DEFAULT_MODE;

  /** Preallocated head-position scratch — never allocate in update(). */
  private headPos!: Vector3;

  /** Projects head world (x, z) onto the WALK ROUTE (route-along/lateral). */
  private projector!: RunwayPathProjector;
  /** Cached start/pose route-along coordinates — recomputed on shape change. */
  private startA = startAlong();
  private poseA = 0;
  /** One-way route (start ≠ finish): a U is walked legA→base→legB and finishes
   * at the far end of legB, NOT back at the start. straight/T/X are walked
   * there-and-back. Refreshed on every shape change in applyPath(). */
  private oneWay = false;
  /** `oneWay` snapshotted for the CURRENT run (walk start + mid-walk remaps):
   * published on ShowSummary so the coach's footwork side-naming keys off the
   * route the lateral data was actually collected on — a shape change between
   * walk start and summary render must not re-label the walked route. */
  private runOneWay = false;

  /** M10 THE HOLD — director-owned (it owns the window semantics AND the
   * head sensor keeps measuring even when an external camera owns the M1-M4
   * scores). ONE accumulator; the stagecraft reads its live outputs. */
  private hold!: HoldAccumulator;
  /** Live presentation channel published as `globals.holdLive` — a PLAIN
   * preallocated object written per frame (the walkStats handoff pattern,
   * never a signal: per-frame writes, readers peek defensively). t01 rises
   * over the MEASURED window — from the arming edge (holdStartElapsed), 0
   * before it — then releases (holdRampT01); still01 is the accumulator's
   * measured live stillness. Released over HOLD_RELEASE_SEC after the walk
   * (update()'s summary decay — the walk→summary flip must not step the
   * lights); zeroed at walk start, mid-walk remap, and every other phase. */
  private holdLive!: { t01: number; still01: number };
  /** phaseElapsed at the frame the hold accumulator's arming edge first
   * flipped true (the trainee SETTLED on the mark); -1 = not armed this
   * run. Drives the U finish dwell and the holdLive ramp. */
  private holdStartElapsed = -1;
  /** Walk-baseline head-height sampler — the SAME first-0.5-s-of-walk mean
   * law as metrics.ts baselineY, sampled here because the hold must resolve
   * a height even when the camera owns metrics' head path. */
  private holdBaseAcc = 0;
  private holdBaseN = 0;
  private holdBaseY = 0;
  /** FIT standing head height snapshotted at walk start (mode-lock: a
   * mid-run FIT rerun must not move the normalization under the walk) —
   * re-armed into the accumulator on a mid-walk remap reset. */
  private runFitHeightM: number | null = null;
  /** Preallocated head-orientation scratch (adjudication §D: ONE quaternion
   * read; raw components feed the pure accumulator). */
  private headQuat!: Quaternion;

  init(): void {
    const g = this.globals;
    this.phaseSig = g.showPhase as Signal<ShowPhaseValue>;
    this.energySig = g.showEnergy as Signal<number>;
    this.walkProgressSig = g.walkProgress as Signal<number>;
    this.walkRemainingSig = g.walkRemaining as Signal<number>;
    this.metricsSig = g.metrics as Signal<MetricSnapshot | null>;
    this.summarySig = g.summary as Signal<ShowSummary | null>;
    this.modeSig = g.activeMode as Signal<TrainingMode> | undefined;
    this.walkPrefsSig = g.walkPrefs as Signal<WalkPrefs> | undefined;

    this.headPos = new Vector3();
    this.headQuat = new Quaternion();
    this.projector = new RunwayPathProjector();
    this.hold = new HoldAccumulator();
    this.holdLive = { t01: 0, still01: 0 };
    // Publish the live hold channel (plain ref, walkStats-style — never a
    // signal). Cleanup guard mirrors showControls: only remove OUR object.
    g.holdLive = this.holdLive;
    this.cleanupFuncs.push(() => {
      if (g.holdLive === this.holdLive) {
        g.holdLive = null;
      }
    });

    // #21 + night-review #9: deltaVsLast must survive reloads AND respect
    // every history mutation. installSessionRecorder() runs before any system
    // registers (index.ts), so the recorder — and with it the persisted walk
    // history — is on globals by init time; read defensively anyway (tests /
    // partial worlds run without it). The baseline itself is read in
    // reseedBaseline() at EVERY walk start, not cached here: CLEAR HISTORY
    // mid-session must make the next walk a fresh baseline (the erased score
    // must not survive as a ghost delta on the new row/export), and a
    // trainee switch must re-scope it. Synthetic Preview Walk rows never
    // seed the baseline (lastRealOverall skips them), and the seed is scoped
    // to the CURRENT trainee (rowMatchesTrainee, session-grading.ts) so a
    // shared device never grades student B's first walk against student A.
    const recorder = g.sessionRecorder as
      | {
          lastRealOverall(
            traineeId?: string | null,
            normalizationStamp?: string | null,
          ): number | null;
        }
      | undefined;
    if (recorder && typeof recorder.lastRealOverall === "function") {
      this.recorder = recorder;
    }
    this.userPrefsSig = g.userPrefs as Signal<UserPrefs> | undefined;

    // Track the user-mapped runway SHAPE: keep the route projector + the cached
    // start/pose route-along coordinates in sync with globals.compiledPath
    // (straight/T/X = one route segment; U = legA->base->legB). Seed now, then
    // subscribe (cleanupFuncs) so a remap re-fits the walk live.
    const pathSig = g.compiledPath as Signal<SegmentedPath> | undefined;
    if (pathSig !== undefined) {
      this.applyPath(pathSig.peek());
      this.cleanupFuncs.push(pathSig.subscribe((p) => this.applyPath(p)));
    } else {
      this.applyPath(compileShape(DEFAULT_SHAPE));
    }

    // Finale flag (#18): set TRUE the instant the walk finishes (mirroring
    // poseBurst's durable-flag contract) — ShaderTimeSystem re-fires the
    // paparazzi storm off its rising edge, StageMoodSystem plays the finale
    // spotlight beat, the SFX layer lands the finale hit. Readers edge-detect
    // with PRIVATE prev latches and never clear it; this director owns its
    // lifecycle (set in finishWalk, cleared at the next walk start).
    g.finishBurst = false;

    // M11: the hold ARMING fact as a durable flag (the poseBurst contract —
    // readers edge-detect privately, never clear it; this director owns its
    // lifecycle: seeded here, re-armed at walk start + mid-walk remap, set
    // TRUE at the accumulator's arming edge). Metrics' private latch turns
    // the edge into TurnTracker.noteHoldArmed — the turn window opens at
    // arm + HOLD_WINDOW_SEC (the hold-then-turn beat partition).
    g.holdArmed = false;

    const controls: ShowControls = {
      beginWalk: () => this.startRun(),
      reset: () => this.resetShow(),
    };
    g.showControls = controls;

    this.cleanupFuncs.push(() => {
      if (g.showControls === controls) {
        g.showControls = null;
      }
    });
  }

  /** Re-fit the route projector + cached marks to a (new) compiled path. */
  private applyPath(path: SegmentedPath): void {
    this.projector.set(path);
    this.startA = startAlong();
    this.poseA = path.poseRouteAlong;
    // A U is a one-way traverse; straight/T/X are walked out-and-back.
    this.oneWay = path.kind === "U";
    // A remap MID-WALK just moved startA/poseA (and possibly the route topology)
    // under the live trackers. A latched `reachedMark` would mis-map progress on
    // the new route, and a high `peakProgress` would pin the monotonic floor —
    // potentially finishing the walk instantly against the new marks. Re-arm the
    // trackers so the walk re-derives cleanly from the new geometry (the walk
    // TIMER, phaseElapsed, intentionally keeps running).
    if (this.phaseSig.peek() === "walk") {
      this.reachedMark = false;
      this.peakProgress = 0;
      this.globals.poseBurst = false;
      this.walkProgressSig.value = 0;
      // MetricsSystem's own compiledPath subscription resets the lateral stats
      // channel on this same remap, so from here on the walk's lateral data is
      // measured against the NEW route — refresh the run's route snapshot to
      // match it.
      this.runOneWay = this.oneWay;
      // M10: the pose mark just MOVED — a half-filled window measured against
      // the old mark would blend two geometries. Re-arm (the LAST window wins,
      // the same "the summary describes the route the walk finished on" law
      // as runOneWay above); the FIT height snapshot stays run-locked.
      this.hold.reset(this.runFitHeightM);
      this.holdStartElapsed = -1;
      // M11: the published arming fact re-arms with the hold — the turn
      // tracker discards its half-measured window on this same remap
      // (metrics' compiledPath subscription calls resetRoute), so the flag
      // and the machine re-arm in step.
      this.globals.holdArmed = false;
      this.holdLive.t01 = 0;
      this.holdLive.still01 = 0;
    }
  }

  update(delta: number): void {
    const phase = this.phaseSig.peek();

    // Energy: exponential ease toward the per-phase target. Zero alloc.
    const target = ENERGY_TARGET[phase];
    const energy = this.energySig.peek();
    const blend = 1 - Math.exp(-ENERGY_RATE * delta);
    const next = energy + (target - energy) * blend;
    if (Math.abs(next - energy) > 1e-5) {
      this.energySig.value = next < 0 ? 0 : next > 1 ? 1 : next;
    }

    // Phase timing — delta-accumulated, pause-safe.
    this.phaseElapsed += delta;
    switch (phase) {
      case "brief":
        if (this.phaseElapsed >= BRIEF_SEC) {
          this.setPhase("countdown");
        }
        break;
      case "countdown":
        if (this.phaseElapsed >= COUNTDOWN_SEC) {
          this.setPhase("walk");
        }
        break;
      case "walk":
        this.updateWalk(delta);
        break;
      case "summary":
        // M10: let the documented HOLD_RELEASE_SEC release play across the
        // walk→summary flip — a U finish (and a mid-hold timeout) lands here
        // with t01 still ~1.0, and the old hard zero stepped the spot cone
        // HOLD_SPOT_TIGHTEN wider and popped the floor ring in one frame at
        // the hero moment. Linear decay (holdReleaseStep) reproduces
        // holdRampT01's release tail; still01 decays with it, zeroed once
        // the ramp is out. Plain per-frame writes, zero alloc; the stats
        // were already finalized by finishWalk, so this is presentation
        // only. Otherwise the phase holds until controls move us.
        if (this.holdLive.t01 > 0) {
          this.holdLive.t01 = holdReleaseStep(this.holdLive.t01, delta);
          this.holdLive.still01 =
            this.holdLive.t01 > 0
              ? holdReleaseStep(this.holdLive.still01, delta)
              : 0;
        }
        break;
      // idle: hold until controls move us.
    }
  }

  // -- the trainee's walk -----------------------------------------------------

  private updateWalk(delta: number): void {
    this.player.head.getWorldPosition(this.headPos);
    // M10 walk-baseline height sampler — the SAME mean-head-y-over-the-first-
    // 0.5-s law as metrics.ts baselineY, sampled by the director because the
    // hold must resolve a standing height even when an external camera owns
    // metrics' head path. Finiteness-gated (a dark frame contributes nothing).
    if (this.phaseElapsed < 0.5 && Number.isFinite(this.headPos.y)) {
      this.holdBaseAcc += this.headPos.y;
      this.holdBaseN++;
      this.holdBaseY = this.holdBaseAcc / this.holdBaseN;
    }
    // Project the head onto the WALK ROUTE. `along` is route-along: grows from
    // ~startA at the start to ~poseA at the pose mark (legA->base->legB on a U).
    // The projector reuses one out object (runway-shape.ts) — zero alloc.
    const proj = this.projector.projectRoute(this.headPos.x, this.headPos.z);
    const along = proj.globalAlong;
    const startA = this.startA;
    const poseA = this.poseA;
    const span = poseA - startA;

    // One-way latch: the trainee has reached the pose mark. Fire the audience
    // paparazzi burst (ShaderTimeSystem consumes this rising edge) — the
    // signature "hit your mark, hold the pose" moment.
    if (!this.reachedMark && along >= poseA - MARK_RADIUS) {
      this.reachedMark = true;
      this.markElapsed = this.phaseElapsed;
      this.globals.poseBurst = true;
      // M10 discriminator: latch the marked FACT on the accumulator here,
      // BEFORE the per-frame finiteness gate below can withhold add() — a
      // walk whose whole post-mark stretch is dark must read "no-data",
      // never the false "never-marked".
      this.hold.markReached();
    }

    // M10 hold feed — every frame after the latch. The accumulator owns the
    // ARMING law (hold-stats.ts): pre-arrival frames fold nothing but feed
    // its arrival detector, so they must ALL be delivered. Runs BEFORE the
    // finish evaluation so the final U frame still contributes its window
    // sliver.
    if (this.reachedMark) {
      const tSince = this.phaseElapsed - this.markElapsed;
      // Feed gate, keyed off the accumulator's arming (zero alloc: one
      // boolean getter + scalar compares). While !armed, EVERY post-latch
      // frame is fed — the arrival law needs the position/speed stream and
      // folds nothing, so the frames are cheap. Once armed, only frames
      // whose [windowTime - delta, windowTime] span can still overlap the
      // REBASED window [0, HOLD_WINDOW_SEC] pay the quaternion read
      // (windowTime = phaseElapsed - holdStartElapsed equals the
      // accumulator's own tSince - tArm exactly: holdStartElapsed is
      // snapshotted on the arming frame below).
      if (
        !this.hold.armed ||
        this.phaseElapsed - this.holdStartElapsed - delta < HOLD_WINDOW_SEC
      ) {
        this.player.head.getWorldQuaternion(this.headQuat);
        const q = this.headQuat;
        // Finiteness gate (the metrics.ts M8 ingest law): a dark frame —
        // non-finite head position or orientation — skips the feed entirely.
        // The accumulator ALSO self-guards (belt and suspenders); this gate
        // keeps a non-finite projection from ever reaching it. (The marked
        // FACT is latched at the reachedMark edge above, so an all-dark
        // window still reads "no-data".)
        if (
          Number.isFinite(this.headPos.x) &&
          Number.isFinite(this.headPos.z) &&
          Number.isFinite(q.x) &&
          Number.isFinite(q.y) &&
          Number.isFinite(q.z) &&
          Number.isFinite(q.w)
        ) {
          // dAlong pre-centered on the pose mark (cancellation safety —
          // hold-stats.ts header); lateral is the signed route lateral.
          this.hold.add(
            tSince,
            delta,
            along - poseA,
            proj.lateral,
            q.x,
            q.y,
            q.z,
            q.w,
          );
          // Arming EDGE: snapshot phaseElapsed the first frame the
          // accumulator arms — the U finish dwell and the holdLive ramp key
          // off this settle time, never the 0.4 m latch.
          if (this.holdStartElapsed < 0 && this.hold.armed) {
            this.holdStartElapsed = this.phaseElapsed;
            // M11: publish the arming edge as the durable flag (set-only
            // here; lifecycle owned above). Metrics observes it the same
            // frame or one frame later — the turn window can only open AT
            // or AFTER the true hold close, never before.
            this.globals.holdArmed = true;
          }
        }
      }
      // Presentation channel (plain per-frame writes, zero alloc): rise over
      // the MEASURED window — from the settle, 0 before it — release over
      // HOLD_RELEASE_SEC (holdRampT01), stillness from the accumulator's
      // measured live tap.
      this.holdLive.t01 =
        this.holdStartElapsed >= 0
          ? holdRampT01(this.phaseElapsed - this.holdStartElapsed)
          : 0;
      this.holdLive.still01 = this.hold.liveStill01;
    }

    // Raw progress + finish condition are route-aware:
    //   One-way (U): startA → poseA mapped 0..1; finish at the far end (poseA),
    //     there is no walk back.
    //   Out-and-back (straight/T/X): down startA→poseA = 0..0.5, back
    //     poseA→startA = 0.5..1; finish back at the start line.
    let raw: number;
    let reachedFinish: boolean;
    if (this.oneWay) {
      const down = span > 0 ? (along - startA) / span : 0;
      raw = down < 0 ? 0 : down > 1 ? 1 : down;
      // Reached the pose, SETTLED on it (the hold arming edge), and held it
      // for the pose-beat (the documented "hold the pose" moment) — then
      // finish at the far end. There is no walk back. Keying the dwell off
      // the settle keeps the full measured window inside the walk; a walk
      // whose tracking goes dark never arms and ends via the walkSeconds
      // TIMEOUT below (the untouched fallback).
      reachedFinish =
        this.reachedMark &&
        this.holdStartElapsed >= 0 &&
        this.phaseElapsed - this.holdStartElapsed >= POSE_HOLD_SEC;
    } else if (!this.reachedMark) {
      const down = span > 0 ? (along - startA) / span : 0;
      raw = 0.5 * (down < 0 ? 0 : down > 1 ? 1 : down);
      reachedFinish = false;
    } else {
      const back = span > 0 ? (poseA - along) / span : 0;
      raw = 0.5 + 0.5 * (back < 0 ? 0 : back > 1 ? 1 : back);
      reachedFinish = along <= startA + FINISH_RADIUS;
    }

    // Monotonic clamp: tracking jitter may dip at most JITTER_BACK below the
    // peak — the published walk never visibly runs backwards.
    if (raw > this.peakProgress) {
      this.peakProgress = raw;
    }
    const floor = this.peakProgress - JITTER_BACK;
    const progress = raw < floor ? floor : raw;

    const walkSec = this.runMode.walkSeconds;
    const remaining = walkSec - this.phaseElapsed;

    // Settle finish conditions BEFORE publishing — a throwing subscriber
    // re-throws out of the signal setter and must not skip or double-run
    // the finish path on the next frame. The pose mark must be reached first
    // either way (one-way reachedFinish already implies it; FINISH_RADIUS ==
    // MARK_RADIUS).
    const finished = this.reachedMark && reachedFinish;
    const timedOut = this.phaseElapsed >= walkSec;

    this.walkProgressSig.value = progress;
    this.walkRemainingSig.value = remaining > 0 ? remaining : 0;

    if (finished || timedOut) {
      this.finishWalk();
    }
  }

  // -- internals ------------------------------------------------------------

  private startRun(): void {
    // Lock the active mode for the whole run (brief → walk → summary), so a
    // mid-run picker change can't retune the walk length or scoring weights.
    // The user-set walk duration (founder call 2026-07-09) composes an
    // EFFECTIVE run mode here — the golden generator's own override pattern
    // (gen-golden-vectors.mjs REPLAY_MODE): every internal read (the timeout,
    // walkRemaining, the stats windows) sees the chosen length, while
    // modes.ts stays untouched (the modes.json golden + Swift mirror).
    const base = this.modeSig?.peek() ?? DEFAULT_MODE;
    const secs = resolveWalkSeconds(
      this.walkPrefsSig?.peek() ?? DEFAULT_WALK,
      base,
    );
    this.runMode =
      secs === base.walkSeconds ? base : { ...base, walkSeconds: secs };
    this.summarySig.value = null;
    this.metricsSig.value = null;
    this.setPhase("brief");
  }

  private resetShow(): void {
    this.metricsSig.value = null;
    this.setPhase("idle");
  }

  /** Re-read the deltaVsLast baseline from the persisted history: the
   * CURRENT trainee's most recent REAL walk, or null (first walk). Called at
   * every walk start so a mid-session CLEAR HISTORY, a trainee switch, or a
   * freshly recorded walk all take effect on the NEXT walk without a reload
   * (night-review #9). No recorder (tests / partial worlds): keep the
   * in-session value finishWalk maintains. */
  private reseedBaseline(): void {
    if (this.recorder === null) {
      return;
    }
    const user = this.userPrefsSig?.peek();
    // FIT wave: scope the seed to the ACTIVE normalization stamp too, so the
    // first post-FIT walk reads "FIRST WALK - BASELINE SET" instead of
    // grading against a row scored under different constants. Same-frame
    // consistency with the metrics lock: both bodyBaseline peeks happen
    // synchronously inside the same setPhase("walk") call — reseedBaseline
    // here, the metrics phase subscriber during the phase publish below —
    // with no task boundary between them, so the two reads cannot diverge.
    // Rows persisted before the wave (absent field) read "default.v1" via
    // rowNormalization, matching the no-baseline stamp — legacy behavior is
    // unchanged for anyone who never runs FIT.
    const g = this.globals as Record<string, unknown>;
    const stamp = normalizationStamp(
      (g.bodyBaseline as Signal<BodyBaseline | null> | undefined)?.peek() ??
        null,
      user ? user.id : null,
    );
    this.lastOverall = this.recorder.lastRealOverall(
      user ? user.id : null,
      stamp,
    );
  }

  private setPhase(phase: ShowPhaseValue): void {
    // Internal state first, walk trackers second, phase LAST — so phase
    // subscribers (HUD / landing) synchronously read initialized trackers,
    // and a throwing tracker subscriber can't leave director state torn.
    this.phaseElapsed = 0;
    if (phase === "walk") {
      this.reseedBaseline(); // read the delta baseline off the LIVE history
      this.reachedMark = false;
      this.peakProgress = 0;
      this.globals.poseBurst = false; // clear any stale burst from a prior run
      this.globals.finishBurst = false; // re-arm the finale for this run (#18)
      // Snapshot the route topology the walk STARTS on (see runOneWay) — the
      // summary must describe the walked route, not the shape at render time.
      this.runOneWay = this.oneWay;
      // M10: snapshot the FIT standing head height for THIS run (adjudication
      // §C: peek globals.bodyBaseline.standHeightM; the mode-lock pattern —
      // a mid-run FIT rerun must not move the normalization under the walk).
      // Same-frame consistency with reseedBaseline's own bodyBaseline peek:
      // both happen synchronously inside this setPhase call. Defensive read —
      // tests / partial worlds run without the FIT publisher.
      const bb = (this.globals as Record<string, unknown>).bodyBaseline as
        | Signal<BodyBaseline | null>
        | undefined;
      const base = bb?.peek() ?? null;
      this.runFitHeightM = base ? base.standHeightM : null;
      this.hold.reset(this.runFitHeightM);
      this.holdStartElapsed = -1;
      // M11: re-arm the published hold-arming fact for this run (the
      // durable-flag lifecycle — the poseBurst clear above is the model).
      this.globals.holdArmed = false;
      this.holdLive.t01 = 0;
      this.holdLive.still01 = 0;
      this.holdBaseAcc = 0;
      this.holdBaseN = 0;
      this.holdBaseY = 0;
      this.walkProgressSig.value = 0;
      this.walkRemainingSig.value = this.runMode.walkSeconds;
    } else {
      // M10: leaving the walk releases the stagecraft (the stats were
      // already finalized into the summary by finishWalk before this flip).
      // Into SUMMARY the channel is handed to update()'s holdReleaseStep
      // decay instead of a hard zero — a U finish flips phases at t01 ~1.0
      // and the documented 0.6 s release must play (idle/brief/countdown
      // keep the hard zero; the walk-entry and mid-walk-remap zeroes above
      // stay).
      if (phase !== "summary") {
        this.holdLive.t01 = 0;
        this.holdLive.still01 = 0;
      }
      this.walkProgressSig.value = -1;
      this.walkRemainingSig.value = -1;
    }

    this.phaseSig.value = phase;
  }

  /** Freeze live metrics into a ShowSummary, then enter the summary phase. */
  private finishWalk(): void {
    const durationSec = Math.round(this.phaseElapsed * 10) / 10;
    const live = this.metricsSig.peek();

    // Freeze the run's REAL measurements (#8/#12/#22): MetricsSystem fed the
    // accumulator all walk; finalize against the TRUE elapsed time (cadence =
    // steps/min over the timed walk). Null when metrics never ran a sample.
    const acc = this.globals.walkStats as
      | WalkStatsAccumulator
      | null
      | undefined;
    const stats: WalkStats | null = acc ? acc.finalize(this.phaseElapsed) : null;

    // Freeze the M8 head-carriage read the same way (non-destructive
    // finalize; null unless the channel engaged). Defensive: tests / partial
    // worlds run without MetricsSystem, so globals.headCarriage may be absent.
    const ct = this.globals.headCarriage as
      | { finalize(): CarriageStats | null }
      | null
      | undefined;
    const carriage: CarriageStats | null = ct ? ct.finalize() : null;

    // Freeze the M10 hold (non-destructive finalize). The height ladder is
    // the accumulator's (FIT snapshot from reset -> walk baseline -> ref);
    // the wiring only hands over the sampled first-0.5-s walk baseline (null
    // when the window never got a finite head sample). When the window
    // measured nothing the reason enum says WHY (the copy branches on it).
    const hold: HoldStats | null = this.hold.finalize(
      this.holdBaseN > 0 ? this.holdBaseY : null,
    );
    const holdNullReason: HoldNullReason | null =
      hold === null ? this.hold.nullReason() : null;

    // Freeze the M9 beat-lock read the same way (non-destructive finalize;
    // defensive — metrics-less worlds run without the globals.beatLock
    // handle). Walk-end ordering (adjudication §D): this director runs at
    // priority 0, MetricsSystem at 12 — the freeze happens BEFORE the
    // finishing frame's strike choke point, so the final frame's strike
    // (and its addRefTime slice) is excluded: at most 1 strike lost,
    // matching the existing walk-stats behavior. No extra code needed.
    const bt = this.globals.beatLock as
      | { finalize(): BeatStats | null; nullReason(): BeatNullReason }
      | null
      | undefined;
    const beat: BeatStats | null = bt ? bt.finalize() : null;
    const beatNullReason: BeatNullReason | null =
      beat === null && bt ? bt.nullReason() : null;

    // Freeze the M11 turn read the same way (non-destructive finalize;
    // defensive — metrics-less worlds run without the globals.turnTrack
    // handle, and then BOTH stamps land null: the surfaces' both-null hide
    // law — no analyzer ran, nothing to disclose). ONE walk-baseline
    // sampler, two consumers: the director's first-0.5-s holdBaseY law
    // feeds the hold finalize above AND the turn's dip zero — never a
    // second sampler. The tracker discriminates its own null reasons
    // (adjudication §B: never-settled vs tracking-dark from ITS accepted
    // post-mark seconds — never inferred from the hold's null reason).
    // Walk-end ordering (§D): this director runs at priority 0, before the
    // finishing frame's metrics feed — at most one frame's sliver excluded,
    // matching the beat/walk-stats behavior.
    const tt = this.globals.turnTrack as
      | {
          finalize(walkBaseHeadYM: number | null): TurnStats | null;
          nullReason(): TurnNullReason;
        }
      | null
      | undefined;
    const turn: TurnStats | null = tt
      ? tt.finalize(this.holdBaseN > 0 ? this.holdBaseY : null)
      : null;
    const turnNullReason: TurnNullReason | null =
      turn === null && tt ? tt.nullReason() : null;

    const scores: MetricSnapshot = {
      pace: live ? live.pace : FALLBACK_SCORE,
      posture: live ? live.posture : FALLBACK_SCORE,
      rhythm: live ? live.rhythm : FALLBACK_SCORE,
      presence: live ? live.presence : FALLBACK_SCORE,
      footPlacement: live ? live.footPlacement : FALLBACK_SCORE,
      confidence: live ? live.confidence : FALLBACK_SCORE,
      presentation: live ? live.presentation : FALLBACK_SCORE,
    };

    // Roll up with the active mode's per-metric weights (they sum to 1).
    // OVERALL_WEIGHTS fixes the 7 keys; the values come from the locked run mode.
    const modeWeights = this.runMode.weights;
    let weighted = 0;
    for (let i = 0; i < OVERALL_WEIGHTS.length; i++) {
      const key = OVERALL_WEIGHTS[i][0];
      weighted += scores[key] * modeWeights[key];
    }
    const overall = Math.max(0, Math.min(100, Math.round(weighted)));

    const deltaVsLast =
      this.lastOverall === null ? null : overall - this.lastOverall;
    // A Preview Walk (DemoWalkSystem auto-pilot) is a SYNTHETIC run: it still
    // gets a scored summary, but it must never become the baseline a real
    // trainee's next walk is graded against (#3). With a recorder present the
    // walk-start reseed supersedes this in-session update (the recorder's row
    // carries the same overall); it remains the no-recorder fallback.
    if (this.globals.demoActive !== true) {
      this.lastOverall = overall;
    }

    // The finale (#18): the moment the trainee crosses the finish line IS the
    // show's climax. Raise the durable flag BEFORE the summary/phase publish so
    // every phase subscriber (stage finale beat, shader storm, SFX hit) already
    // sees it when "summary" lands. Director state is settled; readers edge-
    // detect privately and never clear it (cleared at the next walk start).
    this.globals.finishBurst = true;

    // Publish summary BEFORE the phase flips, so phase subscribers
    // (HUD / landing) can read it synchronously on "summary".
    this.summarySig.value = {
      scores,
      overall,
      deltaVsLast,
      durationSec,
      stats,
      oneWayRoute: this.runOneWay,
      // The mode that ACTUALLY scored this walk (locked at startRun) — the
      // recorder row and the summary renderers grade from this stamp.
      modeId: this.runMode.id,
      passThreshold: this.runMode.passThreshold,
      // Walk-time stamp law (FIT wave): whatever MetricsSystem locked at
      // walk start (its beginWalkTracking is the only writer of
      // walkNormalization); null in metrics-less worlds (tests / partial).
      normalization:
        ((this.globals as Record<string, unknown>).walkNormalization as
          | string
          | undefined) ?? null,
      // The delivered tempo stamp (the same walk-time stamp law): whatever
      // MetricsSystem latched at walk start; null in metrics-less worlds.
      musicBpm:
        ((this.globals as Record<string, unknown>).walkBpm as
          | number
          | undefined) ?? null,
      // The configured-duration stamp: the run-mode lock IS the walk-time
      // latch here (startRun resolved the pref onto runMode), so no globals
      // hop is needed — the same value every internal window ran against.
      walkSecondsSet: this.runMode.walkSeconds,
      // M8 walk-time stamp: the frozen carriage read (null <=> the channel
      // never engaged <=> the M5 blend never ran this walk).
      carriage,
      // M10 walk-time stamp: the frozen hold read + the reason it is null
      // (never-marked vs no-data — different facts, different copy).
      hold,
      holdNullReason,
      // M9 walk-time stamp: the frozen beat read + why it is null (an
      // absent metrics handle stamps null/null; the surfaces' "no-clock"
      // reason fallback then applies — the weakest, internal claim).
      beat,
      beatNullReason,
      // M11 walk-time stamp: the frozen turn read + why it is null (an
      // absent metrics handle stamps null/null — the both-null hide law:
      // no analyzer ran, the surfaces show no row).
      turn,
      turnNullReason,
    };
    this.setPhase("summary");
  }
}
