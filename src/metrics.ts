/**
 * (X)RUNWAY — AI-coach metrics (REV3: live-mapped, trainee-only).
 *
 * MetricsSystem publishes `globals.metrics` (~6 Hz) while the show phase is
 * "walk". The demo simulation path is GONE — every score derives from the
 * trainee's real head motion (`player.head` world position), projected into
 * the USER-MAPPED runway frame (one `RunwayPathProjector`, kept in sync with
 * `globals.compiledPath` — so footPlacement projects onto the active WALK
 * SEGMENT: spine for straight/T/X, legA→base→legB for a U):
 *
 *   pace          ← horizontal head velocity vs ideal catwalk speed
 *   rhythm        ← vertical-bob zero-crossing regularity (ring buffer)
 *   posture       ← head-height stability vs walk start
 *   footPlacement ← |lateral| deviation from the runway centerline
 *   presence / confidence / presentation — composites of those four
 *
 * Footstrikes: each detected bob up-crossing IS a footstrike, feeding the
 * cadence/rhythm metrics. The live-floor ripple is driven SEPARATELY by
 * floor-ripple.ts (the sole writer of `globals.lastStep`, which routes each
 * strike to its runway segment); this system only CLEARS that ref on reset so a
 * fresh walk doesn't ripple a stale strike.
 *
 * Zero per-frame allocation: Vector3s, Float32Array ring buffers, the strike
 * ref, the projector, and ONE mutable snapshot are preallocated in init(). The
 * only allocation is the shallow copy published at the 6 Hz tick (explicitly
 * allowed by spec).
 *
 * POLISH-AUDIT #8/#12/#22: alongside the 0-100 scores, the REAL measured
 * quantities — true pace (m/s), SIGNED centerline offset (m), SIGNED
 * head-height drift (m), every footstrike — feed a WalkStatsAccumulator
 * (walk-stats.ts, exposed as `globals.walkStats`) BEFORE the Math.abs / score
 * mapping, so the signs survive. ShowDirector finalizes it into
 * `ShowSummary.stats`; the session recorder taps its live fields at 6 Hz.
 *
 * SOLO-MODE §6.2 (Phase A1a): the WORLD-pose derivation body lives in
 * pose-derive.ts (`deriveWorld` + `PoseDeriveState` — pure, engine-free,
 * vitest/golden-generator loadable). This system keeps the wiring — source
 * arbitration, fresh-frame gating (poseLastT), walk clock, per-run idealPace,
 * display smoothing, the ~6 Hz publish — and delegates the world path to it.
 * The head and image derivations stay here; they share the extracted state
 * object (the image path reuses its EMAs/bob trackers, and all three paths
 * push step intervals into the ONE ring buffer it owns, so a source handoff
 * clears cadence for every path at once).
 */

import { createSystem, Quaternion, Vector3 } from "@iwsdk/core";
import type { Signal } from "@preact/signals-core";
import { peekAudioContext } from "./audio-core.js";
import { BeatAccumulator, goAudioTimeFresh } from "./beat-stats.js";
import {
  DEFAULT_HEAD_NORMALIZATION,
  deriveHeadNormalization,
  type BodyBaseline,
  type HeadNormalization,
} from "./body-baseline.js";
import type { ExternalTracker, PoseFrame } from "./external-tracker.js";
import {
  CarriageTracker,
  markTurnFlags,
  stepPresenceBlend,
  type MarkTurnFlags,
  type PresenceBlendLatch,
} from "./head-carriage.js";
import { DEFAULT_MODE, type TrainingMode } from "./modes.js";
import {
  DEFAULT_MUSIC,
  resolveMusicBpm,
  type MusicPrefs,
} from "./music-prefs.js";
import {
  displayBlend,
  NEUTRAL,
  PUBLISH_INTERVAL,
  rampInWeight,
} from "./metrics-wiring.js";
import {
  clampScore,
  deriveWorld,
  kpOk,
  PoseDeriveState,
  RING_SIZE,
  STEP_MAX,
  STEP_MIN,
  paceBandScore,
  type PaceBandOpts,
  DEFAULT_PACE_OPTS,
} from "./pose-derive.js";
import { resolvePaceOpts, type PacePrefs } from "./pace-prefs.js";
import {
  compileShape,
  DEFAULT_SHAPE,
  RunwayPathProjector,
  type SegmentedPath,
} from "./runway-shape.js";
import type { MetricSnapshot, ShowPhaseValue } from "./show.js";
import { TurnTracker } from "./turn-stats.js";
import type { UserPrefs } from "./user-prefs.js";
import { WalkStatsAccumulator } from "./walk-stats.js";

// ---------------------------------------------------------------------------
// Metric table — single source for HUD + landing row order/labels.
// ---------------------------------------------------------------------------

export const METRICS: ReadonlyArray<{
  key: keyof MetricSnapshot;
  label: string;
  short: string;
}> = [
  { key: "posture", label: "POSTURE", short: "M1" },
  { key: "pace", label: "PACE", short: "M2" },
  { key: "rhythm", label: "RHYTHM", short: "M3" },
  // "LINE", not "FOOTWORK": a Quest 3 in the browser sees only the HEAD
  // (6DoF) — no camera on the feet. This channel measures how close the
  // HEAD tracks over the runway centerline, an honest proxy for your line;
  // it does NOT observe foot placement (that needs the iPhone companion).
  { key: "footPlacement", label: "LINE", short: "M4" },
  { key: "presence", label: "PRESENCE", short: "M5" },
  { key: "confidence", label: "CONFIDENCE", short: "M6" },
  { key: "presentation", label: "PRESENTATION", short: "M7" },
];

/**
 * THE SHIPPED HEADSET-ONLY CARD (2026-07-05 founder call): a Quest 3 in
 * WebXR honestly measures only head-derived quantities, so the public
 * shareable build shows exactly FOUR head-measured metrics and nothing
 * else — no composites (presence/confidence/presentation are re-weightings,
 * not sensors), no posture/steadiness, no camera-dependent claims. Three
 * come from the MetricSnapshot scoring keys below; CARRIAGE (chin level +
 * eyes forward) is the M8 head-carriage channel, surfaced as its own row.
 * The scoring engine still computes all seven internally (records + golden
 * unchanged); this list is the DISPLAY + coach-note allowlist the surfaces
 * filter to. Order = display order.
 */
// Only the two SNAPSHOT-KEY metrics still shown (PACE + LINE). The 3rd shown
// metric is CARRIAGE (the M8 head-carriage channel, not a MetricSnapshot key —
// surfaced as its own row + the sum-carriage line, so it isn't listed here).
// RHYTHM was dropped from the card (founder call 2026-07-08, carriage replaced
// it), so its coach notes must not surface either. This is the coach-note
// allowlist the summary filters to.
export const SHIPPED_METRIC_KEYS: ReadonlyArray<keyof MetricSnapshot> = [
  "pace",
  "footPlacement",
];

// NB: there is no global pass constant — checkboxes and verdicts gate on the
// ACTIVE mode's passThreshold (modes.ts: 75-82 depending on the lesson).

// ---------------------------------------------------------------------------
// Tuning.
// ---------------------------------------------------------------------------

// The scoring constants shared by all three derivation paths (SCORE_MIN/MAX +
// clampScore, STEP_MIN/MAX, RING_SIZE) live in pose-derive.ts, and the WIRING
// constants (NEUTRAL, PUBLISH_INTERVAL, ramp/blend display smoothing) live in
// metrics-wiring.ts — both imported above so the system, the tests, and the
// golden generator share one source.

/** Default ideal catwalk head speed (m/s) — overridden per run by the active mode. */
const IDEAL_PACE = 0.85;
// The head path's vertical-bob hysteresis + posture slope now live in
// body-baseline.ts (DEFAULT_BOB_THRESHOLD_M / DEFAULT_POSTURE_SLOPE, with the
// derivations): the FIT wave re-derives BOTH per body, and this system locks
// the pair per run via deriveHeadNormalization (byte-identical defaults when
// no baseline exists — the identity pin in test/body-baseline.test.ts).

// ---------------------------------------------------------------------------
// System.
// ---------------------------------------------------------------------------

export class MetricsSystem extends createSystem({}, {}) {
  private phaseSig!: Signal<ShowPhaseValue>;
  private metricsSig!: Signal<MetricSnapshot | null>;

  // Lifecycle.
  private active = false;
  private walkTime = 0;
  private publishAcc = 0;

  /** ONE mutable working snapshot (floats); copies go out at 6 Hz. */
  private snapshot!: MetricSnapshot;
  /** Smoothed display values, index-aligned with METRICS. */
  private smooth!: Float32Array;
  /** Raw target values for this frame, index-aligned with METRICS. */
  private target!: Float32Array;
  private keys!: ReadonlyArray<keyof MetricSnapshot>;

  /** Projects head world (x, z) into runway-local along/lateral. */
  private projector!: RunwayPathProjector;

  // Trainee derivation state.
  private headPos!: Vector3;
  private headPrev!: Vector3;
  private havePrev = false;
  private baselineY = 0;
  private baselineAcc = 0;
  private baselineSamples = 0;
  private bobBaseline = 0;
  private bobSign = 0;
  private lastCrossTime = -1;
  private speedEma = 0;
  private latEma = 0;
  private heightDevEma = 0;
  /** HEAD-path normalization (bob hysteresis + posture slope + stamp),
   * LOCKED per run in beginWalkTracking beside idealPace — a FIT save or a
   * trainee switch mid-walk never re-normalizes a running walk (the
   * mode-lock pattern). Defaults are the frozen factory object, byte- and
   * identity-identical to the deleted local constants. */
  private norm: HeadNormalization = DEFAULT_HEAD_NORMALIZATION;
  /** FIT body-baseline signal (globals.bodyBaseline) — peeked at walk start. */
  private fitSig?: Signal<BodyBaseline | null>;
  /** Trainee identity — deriveHeadNormalization rejects another trainee's
   * baseline (a falsy id filters nothing: the single-user-device law). */
  private userSig?: Signal<UserPrefs>;

  // External pose tracker (Phase 2: iPhone/webcam). When a fresh PoseFrame is
  // present, pace/posture/rhythm/footwork derive from the streamed skeleton
  // (camera-relative, normalized image coords) instead of head-only; absent or
  // stale, we fall back. Head still owns walkProgress + the floor (show.ts), so
  // the external camera only sharpens the *quality* scores.
  private tracker: ExternalTracker | null = null;
  /** All pose-stream derivation state (EMAs, travel heading, bob trackers) —
   *  extracted to pose-derive.ts (SOLO-MODE §6.2). Owns the step-interval RING
   *  BUFFER shared by all three paths, incl. deriveFromHead (poseState.intervals
   *  / intervalIdx / intervalCount replace the former instance fields). */
  private poseState!: PoseDeriveState;
  /** frame.t of the last DISTINCT pose frame derived from (-1 = none). Guards
   *  against re-deriving the same cached frame every app frame: the pose stream
   *  is <=30 Hz but update() runs at 72-90 Hz. */
  private poseLastT = -1;
  /** Which path ran last frame — drives the cadence reset on a source switch. */
  private lastUsedExternal = false;

  /** Active-mode signal; its idealPace is snapshotted per run. */
  private modeSig?: Signal<TrainingMode>;
  /** Ideal pace (m/s) the pace metric scores against — locked per run from the mode. */
  private idealPace = IDEAL_PACE;
  /** The pace band/slopes LOCKED for the current run (pace-prefs latch). */
  private paceOpts: PaceBandOpts = DEFAULT_PACE_OPTS;
  /** The LOCKED walk duration (s) this run's confidence ramp spans — the
   * perfect=100 rescale: the old hard 45 s denominator capped a perfect
   * 20 s walk's confidence at 94.4. Latched per run in beginWalkTracking
   * (never mid-walk; the duration-wave latch law). */
  private rampSeconds = 20;

  /** Per-walk REAL-measurement accumulator (#8/#12/#22) — fed the signed,
   * true-unit quantities BEFORE the Math.abs / score mapping. Preallocated;
   * every ingest is scalar math (zero per-frame allocation). */
  private stats!: WalkStatsAccumulator;

  // -- M8 head carriage (head-carriage.ts) -----------------------------------
  // Fed EVERY walk frame regardless of which derive path owns M1-M4 (the
  // headset stays on the trainee's head even when a camera owns the quality
  // scores). Own scratches — deriveFromHead's headPos/headPrev stay untouched.
  /** ONE per-walk carriage tracker, shared via globals.headCarriage. */
  private carriage!: CarriageTracker;
  /** Preallocated head world-quaternion scratch (the ONE quaternion read). */
  private headQuat!: Quaternion;
  /** Preallocated head world-position scratch for the carriage/neutral feed. */
  private carriagePos!: Vector3;
  /** Previous countdown head position — the stand-speed gate's reference. */
  private carriagePrevPos!: Vector3;
  private carriageHavePrev = false;
  /** True during the countdown phase: update() feeds stand neutral samples. */
  private calibrating = false;
  /** PRIVATE rising-edge latch over globals.poseBurst (the durable-flag law:
   * readers edge-detect privately, never clear the shared flag). */
  private prevPoseBurst = false;
  /** walkTime when the pose mark was reached this run (-1 = not yet). Drives
   * the yaw turn window + the out-and-back return flip. */
  private markAtWalkTime = -1;
  /** Live route topology (compiledPath.kind === "U"): one-way routes stay
   * yaw-suppressed from the mark to the walk's end and never flip. */
  private routeOneWay = false;
  /** Preallocated out-object for the PURE M8 yaw-flag law (markTurnFlags,
   * head-carriage.ts — extracted so vitest/golden pin the exact rule this
   * engine-coupled system runs; the out-param keeps update() zero-alloc). */
  private turnFlags: MarkTurnFlags = { returning: false, yawSuppressed: false };
  /** Adjudication §B: the last DERIVE-PATH presence composite (target[4]
   * before any blend), latched only on frames where a derive path RAN. The
   * blend always re-blends from THIS — never from its own output — so
   * repeated cached pose frames / head re-seed frames cannot compound. The
   * frame step itself is the PURE stepPresenceBlend (head-carriage.ts),
   * pin-tested in vitest; this latch object is preallocated (zero per-frame
   * allocation) and reset in beginWalkTracking. */
  private presenceBlend: PresenceBlendLatch = { legacy: NEUTRAL };

  // -- M9 beat lock (beat-stats.ts) ------------------------------------------
  /** ONE per-walk beat accumulator, shared via globals.beatLock (the
   * headCarriage handle pattern) — ShowDirector.finishWalk freezes
   * finalize() + nullReason() onto the summary. Preallocated in init(). */
  private beat!: BeatAccumulator;
  /** Run-locked validated GO anchor on the AUDIO clock (the clock bridge's
   * validation half, §4.1). NaN = "no-clock": every phase stamp would be
   * garbage, so the choke point withholds addStrike for the whole run. */
  private m9Go = NaN;
  /** Last strike stamp the M9 edge latch consumed (walk-clock s). Crossing
   * stamps are strictly increasing within a walk; resetCadence() drops the
   * source stamps to -1 and re-arms this with them, so a stale stamp can
   * never re-fire (§4.2/§4.3). */
  private m9PrevStamp = -1;
  /** Music prefs (globals.musicPrefs) — peeked per frame for the M9
   * reference gate (musicOn = enabled && volume > 0; never .value). */
  private m9MusicSig?: Signal<MusicPrefs>;

  // -- M11 the turn (turn-stats.ts) ------------------------------------------
  /** ONE per-walk turn tracker, shared via globals.turnTrack (the beatLock
   * handle pattern) — ShowDirector.finishWalk freezes finalize() +
   * nullReason() onto the summary. Preallocated in init(). */
  private turn!: TurnTracker;
  /** PRIVATE rising-edge latch over globals.holdArmed (the durable-flag law:
   * readers edge-detect privately, never clear the shared flag — the
   * prevPoseBurst pattern above). The edge feeds TurnTracker.noteHoldArmed,
   * which opens the turn window at arm + HOLD_WINDOW_SEC (the hold-then-turn
   * beat partition; observed at worst ONE frame after the director's true
   * arm — at or after the true hold close, never before). */
  private prevHoldArmed = false;

  init(): void {
    const g = this.globals;
    this.phaseSig = g.showPhase as Signal<ShowPhaseValue>;
    this.metricsSig = g.metrics as Signal<MetricSnapshot | null>;
    this.tracker = (g.externalTracker as ExternalTracker | undefined) ?? null;
    this.modeSig = g.activeMode as Signal<TrainingMode> | undefined;
    // FIT wave: the per-trainee body baseline + identity, read (peek) once
    // per walk in beginWalkTracking — never per frame, never subscribed.
    this.fitSig = g.bodyBaseline as Signal<BodyBaseline | null> | undefined;
    this.userSig = g.userPrefs as Signal<UserPrefs> | undefined;

    // Per-walk physical measurements (walk-stats.ts): fed below in the derive
    // paths, finalized by ShowDirector into `summary.stats`, live-tapped by
    // the session recorder at 6 Hz. Shared through globals (same handoff
    // pattern as showControls in show.ts).
    this.stats = new WalkStatsAccumulator();
    g.walkStats = this.stats;
    this.cleanupFuncs.push(() => {
      if (g.walkStats === this.stats) {
        g.walkStats = null;
      }
    });

    // M8 head carriage: ONE tracker instance shared through globals (the
    // walkStats handoff pattern above) — ShowDirector.finishWalk freezes
    // finalize() onto the summary; the session recorder taps the live
    // pitch/yaw deviations at 6 Hz. Guarded clear on teardown.
    this.carriage = new CarriageTracker();
    g.headCarriage = this.carriage;
    this.cleanupFuncs.push(() => {
      if (g.headCarriage === this.carriage) {
        g.headCarriage = null;
      }
    });

    // M9 beat lock: ONE accumulator shared through globals (the headCarriage
    // handle pattern above) — ShowDirector.finishWalk freezes finalize() +
    // the null reason onto the summary. Guarded clear on teardown.
    this.beat = new BeatAccumulator();
    g.beatLock = this.beat;
    this.cleanupFuncs.push(() => {
      if (g.beatLock === this.beat) {
        g.beatLock = null;
      }
    });
    this.m9MusicSig = g.musicPrefs as Signal<MusicPrefs> | undefined;

    // M11 the turn: ONE tracker shared through globals (the beatLock handle
    // pattern above) — ShowDirector.finishWalk freezes finalize() + the
    // null reason onto the summary. Guarded clear on teardown.
    this.turn = new TurnTracker();
    g.turnTrack = this.turn;
    this.cleanupFuncs.push(() => {
      if (g.turnTrack === this.turn) {
        g.turnTrack = null;
      }
    });

    this.snapshot = {
      pace: NEUTRAL,
      posture: NEUTRAL,
      rhythm: NEUTRAL,
      presence: NEUTRAL,
      footPlacement: NEUTRAL,
      confidence: NEUTRAL,
      presentation: NEUTRAL,
    };
    this.keys = METRICS.map((m) => m.key);
    this.smooth = new Float32Array(7);
    this.target = new Float32Array(7);

    this.headPos = new Vector3();
    this.headPrev = new Vector3();
    // M8 scratches — separate from headPos/headPrev so the carriage feed can
    // never perturb deriveFromHead's scoring state (byte-identical law).
    this.headQuat = new Quaternion();
    this.carriagePos = new Vector3();
    this.carriagePrevPos = new Vector3();
    this.poseState = new PoseDeriveState();
    this.projector = new RunwayPathProjector();

    // Track the user-mapped runway ROUTE so footPlacement lateral projects onto
    // the active walk segment (straight/T/X = spine; U = legA→base→legB) instead
    // of always the spine — on a U leg the spine lateral is ~armSpan, which would
    // pin footwork. Seed from the signal, then subscribe (cleanupFuncs); defensive
    // fallback to the default shape if the integrator's signal is absent.
    const pathSig = g.compiledPath as Signal<SegmentedPath> | undefined;
    if (pathSig !== undefined) {
      const seed = pathSig.peek();
      this.projector.set(seed);
      this.routeOneWay = seed.kind === "U";
      this.cleanupFuncs.push(
        pathSig.subscribe((path) => {
          this.projector.set(path);
          this.routeOneWay = path.kind === "U";
          // A remap MID-WALK (fit-to-room snap, editor) just moved the
          // centerline under the live walk: every lateral sample accumulated
          // so far was measured against the OLD centerline, so keeping it
          // would blend two geometries into the persisted meanLateralM /
          // meanAbsLateralM (and the coach's quantified footwork copy).
          // Clear the lateral stats channel + the score EMA; pace / posture /
          // steps are centerline-independent and keep accumulating.
          if (this.active) {
            this.stats.resetLateral();
            this.latEma = 0;
            // M8: every yaw sample so far was measured against the OLD route
            // heading (the resetLateral law, restated for the yaw channel);
            // pitch / neutral / head-drop state are geometry-independent and
            // survive. The director clears reachedMark/poseBurst on this same
            // remap (show.ts applyPath), so the mark edge re-arms in step —
            // clear our private latch + mark time with it.
            this.carriage.resetYawChannel();
            this.markAtWalkTime = -1;
            this.prevPoseBurst = false;
            // M9: deliberately NO action — strike timing is geometry-
            // independent (the beat grid is route-blind), the explicit
            // contrast to resetLateral()/resetYawChannel() above (§4.3).
            // M11: the route geometry (and possibly topology) moved under
            // the live walk — a half-measured turn against the OLD geometry
            // is discarded wholesale (turn-stats.ts resetRoute: full machine
            // re-arm, FIT + band snapshots kept — the M10 last-window-wins
            // law). The director re-arms globals.holdArmed on this same
            // remap (show.ts applyPath), so the private edge latch re-arms
            // in step with it.
            this.turn.resetRoute(this.routeOneWay);
            this.prevHoldArmed = false;
          }
        }),
      );
    } else {
      const fallback = compileShape(DEFAULT_SHAPE);
      this.projector.set(fallback);
      this.routeOneWay = fallback.kind === "U";
    }

    this.cleanupFuncs.push(
      this.phaseSig.subscribe((phase) => {
        if (phase === "walk") {
          this.beginWalkTracking();
        } else {
          this.active = false;
          // M8 neutral calibration runs ONLY during the countdown stand:
          // resetNeutral() on entry (a re-run recalibrates; a stale stand
          // never leaks across runs), and the walk-frame speed gate needs a
          // fresh previous-position seed.
          if (phase === "countdown") {
            this.calibrating = true;
            this.carriage.resetNeutral();
            this.carriageHavePrev = false;
          } else {
            this.calibrating = false;
          }
        }
      }),
    );
  }

  update(delta: number, time: number): void {
    if (delta <= 0) {
      return;
    }
    // M8 neutral calibration: countdown stand samples (speed-gated inside
    // sampleNeutral; armed/disarmed by the phase subscription). Runs BEFORE
    // the active gate — the walk hasn't started yet during the countdown.
    if (this.calibrating) {
      this.sampleNeutral(delta);
    }
    if (!this.active) {
      return;
    }
    this.walkTime += delta;

    // Prefer a fresh external pose stream (iPhone/webcam) for the quality
    // scores; otherwise derive from the headset alone. On a source switch the
    // two paths measure cadence differently and against different baselines, so
    // restart the cadence ring + bob trackers cleanly to avoid a phantom
    // footstrike / mixed-rhythm spike during the camera<->head handoff.
    //
    // §B (M8): `derived` tracks whether a derive path actually WROTE the
    // targets this frame — i.e. target[] holds a FRESH legacy composite (a
    // repeated cached pose frame, the head path's re-seed early-return, OR a
    // fresh-but-hipless camera frame leaves target[] carrying last frame's
    // values, which may already be blended). All three derive paths RETURN
    // the wrote-targets fact, and `derived` takes the ACTUAL return — a
    // fresh frame whose derivation bailed (both hips under the kpOk gate)
    // must not latch, or the blend compounds geometrically toward pure
    // carriageScore (the §B blocker, fresh-frame flavor). The presence
    // blend below latches its legacy input ONLY on derived frames.
    const frame = this.tracker ? this.tracker.latest() : null;
    let derived = false;
    if (frame) {
      if (!this.lastUsedExternal) {
        this.resetCadence(); // head -> camera
      }
      // latest() returns the SAME cached frame until the companion pushes a new
      // one (<=30 Hz), but update() runs at the app rate (72-90 Hz). Re-deriving
      // a repeated frame divides a zero hip displacement by the app delta and
      // decays the pace EMA toward zero. Derive ONLY on a fresh frame, using the
      // TRUE inter-pose interval; the display smoothing below keeps running every
      // frame so the bars stay smooth between poses.
      if (frame.t !== this.poseLastT) {
        const poseDt = this.poseLastT >= 0 ? (frame.t - this.poseLastT) / 1000 : 0;
        this.poseLastT = frame.t;
        derived =
          frame.space === "world"
            ? this.deriveFromPoseWorld(frame, poseDt)
            : this.deriveFromPose(frame, poseDt);
        // The replay-along tap is a HEAD-path runway projection; a camera
        // frame has none (world pose is unregistered to the runway frame —
        // pose-derive.ts owns its own live taps and never writes this one).
        // Dark it here at the wiring, not in the golden-locked pose module.
        this.stats.liveAlongM = null;
      }
      // Force the head path to re-seed (not cross against a stale baseline) if
      // it resumes after the stream drops.
      this.havePrev = false;
      this.globals.trackerActive = true;
      this.lastUsedExternal = true;
    } else {
      if (this.lastUsedExternal) {
        this.resetCadence(); // camera -> head
      }
      derived = this.deriveFromHead(delta, time);
      this.globals.trackerActive = false;
      this.lastUsedExternal = false;
    }

    // -- M8 head-carriage feed -----------------------------------------------
    // Runs AFTER source arbitration and BEFORE display smoothing, and
    // UNCONDITIONALLY on both branches: the headset stays on the trainee's
    // head even when an external camera owns M1-M4. Own scratches; all scalar
    // math (zero allocation).
    this.player.head.getWorldQuaternion(this.headQuat);
    this.player.head.getWorldPosition(this.carriagePos);
    // Mark edge via a PRIVATE latch over the durable poseBurst flag (readers
    // edge-detect privately, never clear it — show.ts law).
    const burst = this.globals.poseBurst === true;
    if (burst && !this.prevPoseBurst && this.markAtWalkTime < 0) {
      this.markAtWalkTime = this.walkTime;
      // M11: the SAME rising edge is the turn tracker's mark latch
      // (idempotent — first call wins). The §B reason floors count the
      // tracker's own accepted post-mark seconds from here.
      this.turn.noteMark(this.walkTime);
    }
    this.prevPoseBurst = burst;
    // M11 hold-arming edge via a PRIVATE latch over the durable holdArmed
    // flag (the poseBurst law above, restated for the director's arming
    // fact). Latched on METRICS' walk clock: both clocks accumulate the
    // same ECS deltas from the same synchronous phase flip, and the flag is
    // observed the same frame or one frame late — so the turn window opens
    // AT or AFTER the true hold close, never before (the beat partition).
    const armed = this.globals.holdArmed === true;
    if (armed && !this.prevHoldArmed) {
      this.turn.noteHoldArmed(this.walkTime);
    }
    this.prevHoldArmed = armed;
    const q = this.headQuat;
    const hp = this.carriagePos;
    // Finiteness gate at the boundary (brief law 6): a dark frame (non-finite
    // quaternion component or head position) skips the tracker entirely —
    // zero weight, EMAs hold, and NaN never reaches projectRoute.
    if (
      Number.isFinite(q.x) &&
      Number.isFinite(q.y) &&
      Number.isFinite(q.z) &&
      Number.isFinite(q.w) &&
      Number.isFinite(hp.x) &&
      Number.isFinite(hp.z)
    ) {
      // The active route segment's WALK heading under the head point. On the
      // head path this is an idempotent second projection of the same point
      // (sticky segment); on camera-owned frames it is the only projection.
      // Captured as SCALARS (projectRoute returns a REUSED result object —
      // the brief law): walkYaw feeds M8 + M11, the signed lateral feeds
      // M11's return-leg re-acquisition. Byte-identical walkYaw to the old
      // inline `.yaw` read.
      const proj = this.projector.projectRoute(hp.x, hp.z);
      const walkYaw = proj.yaw;
      const lat = proj.lateral;
      // The M8 yaw-flag law (return flip + turn-window/one-way suppression)
      // is the PURE markTurnFlags (head-carriage.ts) — pin-tested and
      // golden-locked there; this engine wiring only supplies the inputs
      // (the mark time from the poseBurst edge latch above, the walk clock,
      // the run's route topology) into ONE preallocated out-object.
      const flags = markTurnFlags(
        this.markAtWalkTime,
        this.walkTime,
        this.routeOneWay,
        this.turnFlags,
      );
      this.carriage.update(
        q.x,
        q.y,
        q.z,
        q.w,
        walkYaw,
        flags.returning,
        flags.yawSuppressed,
        delta,
        this.walkTime,
      );
      // M11 turn feed — AFTER carriage.update (the raw pitch tap must be
      // THIS frame's), zero allocation, ZERO new reads: the one quaternion
      // read, the captured projection scalars, the head world y (NOT gated
      // here — the existing gate checks x/z only, and the tracker owns its
      // own per-channel finiteness gates, incl. y), and M8's raw pitch tap
      // (one owner per number: the neutral chain and the pitch extraction
      // stay in head-carriage.ts; M11 only integrates the tap over its
      // window).
      this.turn.update(
        delta,
        this.walkTime,
        q.x,
        q.y,
        q.z,
        q.w,
        walkYaw,
        lat,
        hp.y,
        this.carriage.liveRawPitchDevDeg,
      );
    }
    // §B idempotent presence blend (pure frame step, pin-tested): latch the
    // legacy composite only on `derived` frames, then re-blend target[4]
    // from the LATCH while the tracker is engaged — never from target[4]
    // itself, so repeated cached frames cannot compound the blend. All three
    // derive paths leave the LEGACY composite in target[4]; the blend applies
    // identically to whichever ran (pose-derive.ts untouched).
    this.target[4] = stepPresenceBlend(
      this.presenceBlend,
      derived,
      this.target[4],
      this.carriage.engaged,
      this.carriage.liveScore(),
    );

    // -- M9 strike choke point (spec §4.2) -------------------------------------
    // The three addStep sites stay byte-identical; every derive path stamps
    // its crossing on the SAME frame it fires (this.lastCrossTime head;
    // poseState.poseLastCross camera world/image). Edge-latch on the max
    // stamp: stamps are walk-clock seconds, strictly increasing within a
    // walk; resetCadence() drops both to -1 and re-arms m9PrevStamp with
    // them, so a stale stamp can never re-fire — and the accumulator's own
    // BEAT_STRIKE_DEBOUNCE_SEC (= the stats layer's STEP_DEBOUNCE_SEC)
    // de-dupes any crossing re-fire the stats layer also debounces, keeping
    // the two streams step-for-step. Zero allocation: peeks + scalar math.
    const mp =
      this.m9MusicSig !== undefined ? this.m9MusicSig.peek() : DEFAULT_MUSIC;
    const musicOn = mp.enabled && mp.volume > 0;
    const bd = this.globals.beatDelivery as
      | { walk: "haptic" | "earcon" | null }
      | null
      | undefined;
    const hk = bd !== null && bd !== undefined ? bd.walk : null;
    const stamp = Math.max(this.lastCrossTime, this.poseState.poseLastCross);
    if (stamp > this.m9PrevStamp) {
      this.m9PrevStamp = stamp;
      if (Number.isFinite(this.m9Go)) {
        // CO-SAMPLE (the clock-bridge law, beat-stats.ts header):
        // ctx.currentTime is read IN the detection frame and stamped
        // directly — no cross-clock conversion, so accumulated rAF-vs-audio
        // skew can never reach a phase. A suspended ctx is a frozen clock
        // AND an inaudible reference: the strike is withheld entirely.
        const actx = peekAudioContext(); // never acquires (the sfx law)
        if (actx !== null && actx.state === "running") {
          this.beat.addStrike(
            actx.currentTime - this.m9Go,
            musicOn,
            hk,
            // The frame's OWN arbitration state labels the source (the
            // walk-stats labels) — no second derivation: `frame` is this
            // frame's pose, lastUsedExternal reflects this frame's branch.
            this.lastUsedExternal
              ? frame !== null && frame.space === "world"
                ? "camera-world"
                : "camera-image"
              : "head",
          );
        }
      }
    }
    // Reference-coverage disclosure, EVERY active frame (walk-wide — it
    // survives voidStrikes): refSec < duration on the row says the channel
    // was truncated (the timeInWindowSec pattern).
    this.beat.addRefTime(delta, musicOn || hk !== null);

    // Smooth raw targets into display values, ramping in from NEUTRAL over
    // the first RAMP_IN_SEC so bars never jump on incomplete data (forms
    // single-sourced in metrics-wiring.ts).
    const rampIn = rampInWeight(this.walkTime);
    const blend = displayBlend(delta);
    const snap = this.snapshot as unknown as Record<string, number>;
    for (let i = 0; i < 7; i++) {
      const goal = NEUTRAL + (clampScore(this.target[i]) - NEUTRAL) * rampIn;
      this.smooth[i] += (goal - this.smooth[i]) * blend;
      snap[this.keys[i] as string] = this.smooth[i];
    }

    // Publish a fresh rounded copy at ~6 Hz.
    this.publishAcc += delta;
    if (this.publishAcc >= PUBLISH_INTERVAL) {
      this.publishAcc %= PUBLISH_INTERVAL;
      const s = this.snapshot;
      this.metricsSig.value = {
        pace: Math.round(s.pace),
        posture: Math.round(s.posture),
        rhythm: Math.round(s.rhythm),
        presence: Math.round(s.presence),
        footPlacement: Math.round(s.footPlacement),
        confidence: Math.round(s.confidence),
        presentation: Math.round(s.presentation),
      };
    }
  }

  // -- walk start -----------------------------------------------------------

  private beginWalkTracking(): void {
    this.active = true;
    this.walkTime = 0;
    this.publishAcc = 0;
    // Lock the active mode's ideal pace for this walk.
    this.idealPace = (this.modeSig?.peek() ?? DEFAULT_MODE).idealPace;
    // Lock the pace-style band for this walk (the tempo-latch law): the
    // resolved opts come from globals.pacePrefs (pace-prefs.ts) — a mid-walk
    // toggle applies from the NEXT run. Missing/partial worlds -> defaults.
    const pp = (
      this.globals.pacePrefs as { peek(): PacePrefs } | undefined
    )?.peek();
    this.paceOpts = pp ? resolvePaceOpts(pp) : DEFAULT_PACE_OPTS;
    // Lock the confidence-ramp span to THIS run's duration: the director
    // seeds globals.walkRemaining with the EFFECTIVE runMode.walkSeconds
    // (the user duration pref resolved at its startRun lock) synchronously
    // BEFORE the phase publish, so this subscriber reads the locked value.
    // Partial worlds (tests/browser demos) fall back to the base mode.
    const lockedSecs = (
      this.globals.walkRemaining as { peek(): number } | undefined
    )?.peek();
    this.rampSeconds =
      typeof lockedSecs === "number" && Number.isFinite(lockedSecs) && lockedSecs > 0
        ? lockedSecs
        : (this.modeSig?.peek() ?? DEFAULT_MODE).walkSeconds;
    // Lock the HEAD-path normalization for this walk (FIT wave): the measured
    // bob hysteresis + posture slope when a valid same-trainee baseline is
    // published, else the byte-identical factory defaults. The stamp is
    // published as a plain ref for ShowDirector to copy onto the summary at
    // finishWalk (walk-time stamp law — this system is the ONLY writer).
    this.norm = deriveHeadNormalization(
      this.fitSig?.peek() ?? null,
      this.userSig?.peek()?.id ?? null,
    );
    this.globals.walkNormalization = this.norm.stamp;
    // M9 (spec §4.1): validate the GO anchor ONCE at walk start — the clock
    // bridge's validation half (goAudioTimeFresh, beat-stats.ts: finite AND
    // inside [now - 0.25, now + 0.05] on the audio clock) plus the running-
    // ctx gate (a suspended context is a frozen clock AND an inaudible
    // reference). peekAudioContext never creates (the sfx flag-driven law).
    // Invalid -> goValid=false -> the channel finalizes null, "no-clock".
    const actx = peekAudioContext();
    const go = this.globals.goAudioTime;
    const goValid =
      actx !== null &&
      actx.state === "running" &&
      goAudioTimeFresh(actx.currentTime, go);
    this.m9Go = goValid ? (go as number) : NaN;
    // M9 tempo latch: the delivered BPM this walk is scored against — the
    // value MusicSystem armed the GO grid with (globals.goBpm, published
    // beside goAudioTime at the countdown edge; trusted only under the same
    // goValid verdict that validated the anchor), else the resolved pref
    // (the nominal tempo — the beat channel is null without a valid clock
    // anyway, but the walk record still stamps what was intended). Published
    // as globals.walkBpm for ShowDirector to copy onto the summary at
    // finishWalk (the walkNormalization walk-time stamp law — this system
    // is the ONLY writer).
    const goBpm = this.globals.goBpm;
    const bpm =
      goValid && typeof goBpm === "number" && Number.isFinite(goBpm)
        ? goBpm
        : resolveMusicBpm(
            this.m9MusicSig !== undefined
              ? this.m9MusicSig.peek()
              : DEFAULT_MUSIC,
            (this.modeSig?.peek() ?? DEFAULT_MODE).id,
          );
    this.globals.walkBpm = bpm;
    // Run-locked FIT natural cadence peek — the subdivision chooser's
    // dead-zone tie-break (BodyBaseline.cadenceSpm, its FIRST consumer;
    // may be null). Same-trainee scoping is already handled by the FIT
    // index.ts subscription that publishes globals.bodyBaseline (the M8
    // neutral-chain precedent below).
    this.beat.reset(goValid, bpm, this.fitSig?.peek()?.cadenceSpm ?? null);
    this.m9PrevStamp = -1;
    // Arm the real-measurement accumulator for this run (#8/#12/#22).
    this.stats.reset(this.idealPace);
    this.smooth.fill(NEUTRAL);
    this.target.fill(NEUTRAL);

    this.havePrev = false;
    this.baselineY = 0;
    this.baselineAcc = 0;
    this.baselineSamples = 0;
    this.bobBaseline = 0;
    this.bobSign = 0;
    this.lastCrossTime = -1;
    this.speedEma = 0;
    this.latEma = 0;
    this.heightDevEma = 0;

    // External pose state (pose-derive.ts) — EMAs, hip anchor, bob trackers,
    // the travel heading (deliberately NOT seeded from layoutYaw — see
    // PoseDeriveState.reset), and the shared step-interval ring.
    this.poseState.reset();
    this.poseLastT = -1;
    this.lastUsedExternal = false;

    // M8: arm the carriage tracker for this walk. The neutral chain is
    // stand -> FIT -> first-0.5s-of-walk (adjudication §K): the countdown
    // stand accumulated via sampleNeutral wins when sane; else the trainee's
    // FIT BodyBaseline.neutralPitchRad (trainee scoping is already handled by
    // the FIT index.ts subscription that publishes globals.bodyBaseline);
    // else the tracker's own walk-window fallback. Countdown is over — stop
    // calibrating, and re-arm the private mark-edge latch.
    this.carriage.beginWalk(this.fitSig?.peek()?.neutralPitchRad ?? null);
    this.calibrating = false;
    this.prevPoseBurst = false;
    this.markAtWalkTime = -1;
    // M11: arm the turn tracker for this walk — the FIT standing head
    // height (peeked at the same synchronous setPhase("walk") moment as the
    // director's own snapshot, so the two reads cannot diverge), the run's
    // route topology (a U has no 180 — the tracker goes dark honestly), and
    // the walk-locked mode pace (the duration band's mode-lock law; locked
    // above with idealPace). Re-arm the private holdArmed edge latch with it.
    this.turn.beginWalk(
      this.fitSig?.peek()?.standHeightM ?? null,
      this.routeOneWay,
      this.idealPace,
    );
    this.prevHoldArmed = false;
    // §B: the presence-blend latch restarts at the display-neutral value the
    // targets were just filled with.
    this.presenceBlend.legacy = NEUTRAL;

    // Clear the previous run's strike so the floor doesn't ripple stale.
    this.globals.lastStep = null;
  }

  /**
   * One countdown stand sample for the M8 neutral (called from update() while
   * `calibrating`). Head speed vs the previous countdown frame gates out
   * approach motion (the tracker accepts speed < M8_STAND_SPEED_MAX_MPS); the
   * FIRST frame has no previous position, so it passes a FAILING speed
   * (Infinity) — the tracker discards it and the pair seeds here. A dark
   * frame (non-finite head position) contributes nothing and re-seeds the
   * speed pair rather than differencing across the gap.
   */
  private sampleNeutral(delta: number): void {
    this.player.head.getWorldQuaternion(this.headQuat);
    this.player.head.getWorldPosition(this.carriagePos);
    const q = this.headQuat;
    const p = this.carriagePos;
    if (
      !Number.isFinite(q.x) ||
      !Number.isFinite(q.y) ||
      !Number.isFinite(q.z) ||
      !Number.isFinite(q.w) ||
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.y) ||
      !Number.isFinite(p.z)
    ) {
      this.carriageHavePrev = false;
      return;
    }
    const speed = this.carriageHavePrev
      ? Math.sqrt(
          (p.x - this.carriagePrevPos.x) * (p.x - this.carriagePrevPos.x) +
            (p.y - this.carriagePrevPos.y) * (p.y - this.carriagePrevPos.y) +
            (p.z - this.carriagePrevPos.z) * (p.z - this.carriagePrevPos.z),
        ) / delta
      : Infinity;
    this.carriage.addNeutralSample(q.x, q.y, q.z, q.w, speed, delta);
    this.carriagePrevPos.copy(p);
    this.carriageHavePrev = true;
  }

  /**
   * Restart cadence detection cleanly on a camera<->head source switch: the two
   * paths push step intervals with different crossing semantics/thresholds, so
   * mixing them in one ring buffer corrupts the rhythm CV until it rolls over.
   *
   * Also re-arms the pose-frame seam for the stats taps: `poseLastT` must not
   * survive a handoff — after a camera dropout (head owned the outage), the
   * resume frame's `frame.t - poseLastT` would span the WHOLE outage, and
   * update() would feed that gap into noteSource()/addPace() — re-crediting
   * head-owned wall time to the camera (flipping WalkStats.source) and, with
   * `poseHavePrev` still true, injecting ONE outage-weighted ~0 m/s pace
   * sample (halving meanPaceMps on an out-and-back walk resumed near the drop
   * point). Resetting both makes the first resumed frame carry ZERO stats
   * weight (poseDt = 0) and re-seeds the hip anchor instead of differencing
   * across the gap — mirroring the `havePrev = false` guard the camera branch
   * already applies to the head path.
   *
   * The M8 carriage tracker is deliberately NOT reset here: the headset stays
   * on the head across a camera<->head handoff (M8 is
   * arbitration-independent — the feed in update() runs on both branches).
   * The M11 turn tracker is arbitration-independent for the same reason —
   * its feed rides the M8 block, so a handoff never touches it either.
   */
  private resetCadence(): void {
    this.bobSign = 0;
    this.lastCrossTime = -1;
    this.poseLastT = -1;
    // Shared ring + pose bob trackers + hip anchor (pose-derive.ts).
    this.poseState.resetCadence();
    // M9: a camera<->head handoff changes the strike detector's constant
    // lag (head bob vs hip crossing, camera relay latency) — phases across
    // it are NOT comparable. Void the strike-phase state (the adjudicated
    // rep-voiding rule applied to the walk channel; the surviving
    // homogeneous span scores, refSec survives — delivery disclosure is
    // walk-wide) and re-arm the edge latch with the stamps this method just
    // dropped to -1, so a stale stamp can never re-fire (§4.3).
    this.beat.voidStrikes();
    this.m9PrevStamp = -1;
  }

  // -- external camera: pose-stream derivation --------------------------------

  /**
   * Derive the quality scores from a streamed skeleton (normalized image
   * coords, origin top-left, y down — the classic side-camera setup where the
   * trainee walks across the frame). Camera-relative and uncalibrated: precise
   * world-frame scoring arrives with native ARKit world landmarks (see
   * docs/SENSORS.md). Fills this.target[]; zero allocation.
   *
   * Returns TRUE when the derivation ran to completion (target[] holds a
   * fresh legacy composite), FALSE on the both-hips-missing bail (no
   * targets written) — the deriveFromHead §B contract, mirrored: update()'s
   * `derived` flag takes this return, so the presence-blend latch never
   * captures an already-blended target[4] off a fresh-but-hipless frame. */
  private deriveFromPose(frame: PoseFrame, delta: number): boolean {
    // Junk-delta sanitize — the same law as deriveWorld (pose-derive.ts): a
    // non-finite/non-positive delta is a dark frame, all EMAs hold.
    if (!(Number.isFinite(delta) && delta > 0)) delta = 0;
    // Camera-image owns this stretch of the walk, but it measures in
    // NORMALIZED image units, not meters — no true pace or centerline channel
    // exists here, so only footstrikes + source time feed the stats (#12/#22)
    // and the live raw taps go dark.
    this.stats.noteSource("camera-image", delta);
    this.stats.livePaceMps = null;
    this.stats.liveLateralM = null;
    this.stats.livePostureM = null;
    this.stats.liveAlongM = null;
    // Shares the extracted pose state (EMAs/bob/ring) with the world path, so
    // a mid-walk world<->image space switch keeps today's carry-over behavior.
    const ps = this.poseState;
    const kp = frame.keypoints;
    const lh = kpOk(kp, "leftHip");
    const rh = kpOk(kp, "rightHip");
    if (!lh && !rh) {
      // No hip anchor at all this frame — hold the previous targets. The
      // dt/anchor law (pose-derive.ts): the anchor keeps its timestamp, so
      // this frame's dt is banked and the next measuring frame folds over
      // the full elapsed span instead of double-counting displacement.
      // No targets written -> derived=false (§B: the blend latch holds).
      ps.posePendingDt += delta;
      return false;
    }
    // The true measurement interval: now - the anchor frame's timestamp
    // (pose-derive.ts posePendingDt — the same law as the world path).
    const span = delta + ps.posePendingDt;
    ps.posePendingDt = 0;
    // Accept a single visible hip: in the side-camera framing the far hip is
    // often occluded and the contract allows a sparse skeleton, so bailing on a
    // missing hip would freeze the quality scores for seconds at a time.
    const hipX = lh && rh ? (lh.x + rh.x) * 0.5 : (lh ?? rh)!.x;
    const hipY = lh && rh ? (lh.y + rh.y) * 0.5 : (lh ?? rh)!.y;
    const ls = kpOk(kp, "leftShoulder");
    const rs = kpOk(kp, "rightShoulder");
    const la = kpOk(kp, "leftAnkle");
    const ra = kpOk(kp, "rightAnkle");

    // Pace — horizontal hip travel across the frame (normalized units/s). NOTE:
    // assumes the documented SIDE camera (walk across frame); a head-on camera
    // barely moves hipX so pace under-reads — supporting a frontal view needs a
    // torso-scale "approach" proxy with its own tuning (deferred, product call).
    if (ps.poseHavePrev && span > 0) {
      const v = Math.abs(hipX - ps.posePrevHipX) / span;
      ps.poseSpeedEma += (v - ps.poseSpeedEma) * (1 - Math.exp(-2 * span));
    }
    ps.posePrevHipX = hipX;
    ps.poseHavePrev = true;

    // Posture — torso uprightness (|vertical| / length of shoulder->hip).
    if (ls && rs) {
      const sx = (ls.x + rs.x) * 0.5;
      const sy = (ls.y + rs.y) * 0.5;
      const vx = sx - hipX;
      const vy = sy - hipY;
      const len = Math.hypot(vx, vy) || 1e-3;
      const upright = Math.abs(vy) / len;
      ps.poseUprightEma +=
        (upright - ps.poseUprightEma) * (1 - Math.exp(-1.5 * span));
    }

    // Foot placement — ankle lateral spread from the body line.
    let lat = ps.poseLatEma;
    if (la && ra) lat = (Math.abs(la.x - hipX) + Math.abs(ra.x - hipX)) * 0.5;
    else if (la) lat = Math.abs(la.x - hipX);
    else if (ra) lat = Math.abs(ra.x - hipX);
    ps.poseLatEma += (lat - ps.poseLatEma) * (1 - Math.exp(-1.5 * span));

    // Rhythm — lead-foot bob cadence (a lift = image y decreasing).
    const footY =
      la && ra ? Math.min(la.y, ra.y) : la ? la.y : ra ? ra.y : null;
    if (footY !== null) {
      if (!ps.poseBobHavePrev) {
        ps.poseBobBaseline = footY;
        ps.poseBobHavePrev = true;
      }
      ps.poseBobBaseline +=
        (footY - ps.poseBobBaseline) * (1 - Math.exp(-1.2 * span));
      const dev = footY - ps.poseBobBaseline;
      const TH = 0.012;
      if (dev < -TH && ps.poseBobSign >= 0) {
        ps.poseBobSign = -1;
        this.stats.addStep(this.walkTime); // every real strike counts (#22)
        if (ps.poseLastCross >= 0) {
          const interval = this.walkTime - ps.poseLastCross;
          if (interval >= STEP_MIN && interval <= STEP_MAX) {
            ps.intervals[ps.intervalIdx] = interval;
            ps.intervalIdx = (ps.intervalIdx + 1) % RING_SIZE;
            if (ps.intervalCount < RING_SIZE) ps.intervalCount++;
          }
        }
        ps.poseLastCross = this.walkTime;
      } else if (dev > TH && ps.poseBobSign <= 0) {
        ps.poseBobSign = 1;
      }
    }

    // Scores (camera-relative mappings; tuned for a side camera).
    const pace =
      ps.poseSpeedEma < 0.01
        ? 52
        : 100 - Math.abs(ps.poseSpeedEma - 0.18) * 180;

    let rhythm = 60;
    if (ps.intervalCount >= 3) {
      let mean = 0;
      for (let i = 0; i < ps.intervalCount; i++) mean += ps.intervals[i];
      mean /= ps.intervalCount;
      let mad = 0;
      for (let i = 0; i < ps.intervalCount; i++) {
        mad += Math.abs(ps.intervals[i] - mean);
      }
      mad /= ps.intervalCount;
      const cv = mean > 0 ? mad / mean : 1;
      rhythm = 100 - cv * 220;
    }

    const posture = 40 + ((ps.poseUprightEma - 0.82) / 0.17) * 60;
    const footPlacement = 100 - ps.poseLatEma * 260;

    const cPace = clampScore(pace);
    const cRhythm = clampScore(rhythm);
    const cPosture = clampScore(posture);
    const cFoot = clampScore(footPlacement);

    const sessionRamp = Math.min(this.walkTime / this.rampSeconds, 1);
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

    this.target[0] = posture;
    this.target[1] = pace;
    this.target[2] = rhythm;
    this.target[3] = footPlacement;
    this.target[4] = presence;
    this.target[5] = confidence;
    this.target[6] = presentation;
    return true; // full derivation ran (§B)
  }

  // -- external camera: WORLD-SPACE (native ARKit) derivation -----------------

  /**
   * Derive quality scores from a streamed skeleton in WORLD meters (native
   * ARKit body tracking). The BODY lives in pose-derive.ts (`deriveWorld`) —
   * extracted verbatim to a pure, engine-free module so the golden-vector
   * generator and vitest import the REAL code (SOLO-MODE §6.2). This thin
   * wrapper feeds it the system-owned inputs: the true inter-pose delta, the
   * walk clock, the per-run mode pace, the shared pose state (incl. the step
   * ring all paths use), the stats accumulator, and the raw target array.
   * Returns deriveWorld's §B wrote-targets fact. */
  private deriveFromPoseWorld(frame: PoseFrame, delta: number): boolean {
    return deriveWorld(
      frame,
      delta,
      this.walkTime,
      this.idealPace,
      this.rampSeconds,
      this.poseState,
      this.stats,
      this.target,
      this.paceOpts,
    );
  }

  // -- trainee: real head-motion derivation -----------------------------------

  /**
   * Returns TRUE when the derivation ran to completion (target[] holds a
   * fresh legacy composite), FALSE on the re-seed early-return frame (no
   * targets written) — the §B `derived` flag for the presence blend. The
   * return value is the ONLY M8 change in this function; every computed
   * value is byte-identical.
   */
  private deriveFromHead(delta: number, time: number): boolean {
    // The head path owns this stretch of the walk (source dominance, #12).
    this.stats.noteSource("head", delta);
    this.player.head.getWorldPosition(this.headPos);

    if (!this.havePrev) {
      this.headPrev.copy(this.headPos);
      this.bobBaseline = this.headPos.y;
      // Seed the posture baseline too if the first-0.5 s averaging window never
      // got a head sample — e.g. an external tracker owned the head path through
      // that window, then dropped, so the head path re-seeds past 0.5 s with
      // baselineY still 0. Without this, heightDev ≈ head height (~1.5) and
      // posture pins at SCORE_MIN for the rest of the walk. (`baselineSamples`
      // resets to 0 per walk in beginWalkTracking, so this only fires when the
      // head path truly never established a baseline; while the window is still
      // open the running average below refines this first estimate.)
      if (this.baselineSamples === 0) {
        this.baselineY = this.headPos.y;
      }
      // Clear the EMAs carried over from a just-dropped external stream — the
      // head path measures speed/lateral/height against different references, so
      // a stale camera EMA would score the head walk against frozen data until
      // it decayed (~1-2 s). They re-accumulate cleanly from the head samples;
      // at walk start they're already 0 (beginWalkTracking), so this is a no-op
      // there. heightDev is ~0 here (baselineY just seeded to the head height).
      this.speedEma = 0;
      this.latEma = 0;
      this.heightDevEma = 0;
      this.havePrev = true;
      return false; // re-seed frame: no targets written (§B)
    }

    // Posture baseline: average head height over the first 0.5 s.
    if (this.walkTime < 0.5) {
      this.baselineAcc += this.headPos.y;
      this.baselineSamples++;
      this.baselineY = this.baselineAcc / this.baselineSamples;
    }

    // Pace — horizontal head velocity, EMA-smoothed, tracking-jump clamped.
    const dx = this.headPos.x - this.headPrev.x;
    const dz = this.headPos.z - this.headPrev.z;
    let speed = Math.sqrt(dx * dx + dz * dz) / delta;
    if (speed > 4) speed = 4;
    this.stats.addPace(speed, delta); // true m/s, pre-score-mapping (#12)
    this.speedEma += (speed - this.speedEma) * (1 - Math.exp(-2 * delta));
    this.stats.livePaceMps = this.speedEma;

    // Rhythm — vertical bob zero crossings (up-crossings, with hysteresis).
    // Each up-crossing IS a footstrike: record the interval for rhythm scoring.
    // (The FLOOR ripple is driven by FloorRippleSystem off horizontal movement,
    // not from here, so the floor reacts in every mode incl. the XR emulator.)
    this.bobBaseline +=
      (this.headPos.y - this.bobBaseline) * (1 - Math.exp(-1.2 * delta));
    const dev = this.headPos.y - this.bobBaseline;
    if (dev > this.norm.bobThresholdM && this.bobSign <= 0) {
      this.bobSign = 1;
      this.stats.addStep(this.walkTime); // every real strike counts (#22)
      if (this.lastCrossTime >= 0) {
        const interval = this.walkTime - this.lastCrossTime;
        if (interval >= STEP_MIN && interval <= STEP_MAX) {
          // The step-interval ring is SHARED with the camera paths and lives
          // in the extracted pose state (pose-derive.ts).
          const ps = this.poseState;
          ps.intervals[ps.intervalIdx] = interval;
          ps.intervalIdx = (ps.intervalIdx + 1) % RING_SIZE;
          if (ps.intervalCount < RING_SIZE) ps.intervalCount++;
        }
      }
      this.lastCrossTime = this.walkTime;
    } else if (dev < -this.norm.bobThresholdM && this.bobSign >= 0) {
      this.bobSign = -1;
    }

    // Posture — head-height stability vs walk start. The SIGNED deviation
    // (+ = above the walk-start baseline) feeds the stats BEFORE the abs
    // collapse (#8); the score keeps the magnitude.
    const heightDevSigned = this.headPos.y - this.baselineY;
    this.stats.addPosture(heightDevSigned, delta);
    this.stats.livePostureM = heightDevSigned;
    const heightDev = Math.abs(heightDevSigned);
    this.heightDevEma +=
      (heightDev - this.heightDevEma) * (1 - Math.exp(-1.5 * delta));

    // Foot placement — lateral deviation from the active WALK-ROUTE segment
    // (projectRoute().lateral, not head.x — correct on a U's legs/base too).
    // The projection is SIGNED (+ = the trainee's right on the outbound leg);
    // the sign feeds the stats (#8), the score keeps |lateral|.
    // (Captured as SCALARS immediately — projectRoute returns a REUSED result
    // object.) globalAlong rides along for the replay ghost trajectory
    // (walk-stats liveAlongM, display-only) — same projection, no extra call.
    const projFoot = this.projector.projectRoute(
      this.headPos.x,
      this.headPos.z,
    );
    const latSigned = projFoot.lateral;
    this.stats.liveAlongM = projFoot.globalAlong;
    this.stats.addLateral(latSigned, delta);
    this.stats.liveLateralM = latSigned;
    const lat = Math.abs(latSigned);
    this.latEma += (lat - this.latEma) * (1 - Math.exp(-1.5 * delta));

    this.headPrev.copy(this.headPos);

    // Scores.
    const pace =
      this.speedEma < 0.05
        ? 44
        : paceBandScore(this.speedEma, this.idealPace, this.paceOpts);

    let rhythm = 58;
    const ring = this.poseState; // shared interval ring (pose-derive.ts)
    if (ring.intervalCount >= 3) {
      let mean = 0;
      for (let i = 0; i < ring.intervalCount; i++) mean += ring.intervals[i];
      mean /= ring.intervalCount;
      let mad = 0;
      for (let i = 0; i < ring.intervalCount; i++) {
        mad += Math.abs(ring.intervals[i] - mean);
      }
      mad /= ring.intervalCount;
      const cv = mean > 0 ? mad / mean : 1;
      rhythm = 100 - cv * 220;
    }

    const posture = 100 - this.heightDevEma * this.norm.postureSlopePerM;
    const footPlacement = 100 - this.latEma * 240;

    const cPace = clampScore(pace);
    const cRhythm = clampScore(rhythm);
    const cPosture = clampScore(posture);
    const cFoot = clampScore(footPlacement);

    // Composites of the four real signals.
    const sessionRamp = Math.min(this.walkTime / this.rampSeconds, 1);
    const presence = cPosture * 0.4 + cRhythm * 0.3 + cPace * 0.3;
    const confidence =
      cPace * 0.25 + cPosture * 0.25 + cRhythm * 0.25 + cFoot * 0.15 +
      sessionRamp * 10;
    const presentation =
      cPosture * 0.25 + cRhythm * 0.25 + cFoot * 0.2 + cPace * 0.15 +
      presence * 0.15;

    // METRICS order: posture, pace, rhythm, footPlacement, presence,
    // confidence, presentation.
    this.target[0] = posture;
    this.target[1] = pace;
    this.target[2] = rhythm;
    this.target[3] = footPlacement;
    this.target[4] = presence;
    this.target[5] = confidence;
    this.target[6] = presentation;
    return true; // full derivation ran (§B)
  }
}
