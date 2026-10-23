/**
 * Deterministic synthetic frame TAPES + the tape driver for the world-pose
 * derivation (SOLO-MODE.md §6.2 characterization step, Phase A1a).
 *
 * One driver, two consumers:
 * - test/pose-derive-tape.mjs (the A/B characterization harness) drives the
 *   PRE-refactor MetricsSystem.deriveFromPoseWorld (sliced out of a git
 *   worktree's metrics.ts source and executed verbatim) and the POST-refactor
 *   pose-derive.ts through the SAME tapes and records byte-comparable JSON.
 * - test/pose-derive-world.test.ts replays the tapes against pose-derive.ts in
 *   vitest and asserts the recorded golden outputs exactly.
 *
 * The driver replicates ONLY the two seams metrics.ts keeps around the
 * extracted function (both staying in update()/resetCadence there):
 * - fresh-frame gating: derive once per DISTINCT frame.t with
 *   poseDt = (frame.t - poseLastT) / 1000, first frame poseDt = 0
 *   (metrics.ts update()).
 * - a "gap" event models a camera dropout + resume: during the outage the
 *   head path owns scoring (camera->head resetCadence), and the resume frame
 *   fires resetCadence again (head->camera) with poseLastT re-armed to -1, so
 *   the first resumed frame carries zero stats weight. No head frames are
 *   simulated — only the pose-state effect of the round trip.
 *
 * Everything here is allocation-happy plain TS — it runs in node/vitest, not
 * in the app. Determinism matters (no Date/random); byte-identical JSON out.
 */

import { NEUTRAL } from "../src/metrics-wiring.ts";
import {
  PoseDeriveState,
  deriveWorld,
  soloDeriveWorld,
} from "../src/pose-derive.ts";
import { WalkStatsAccumulator } from "../src/walk-stats.ts";
import type { PoseFrame, PoseKeypoint } from "../src/external-tracker.ts";

// NEUTRAL is imported from the REAL wiring module (metrics-wiring.ts) — the
// hand-replicated literal that used to live here could drift from metrics.ts
// with everything green (finding #12). Re-exported for the test suites.
export { NEUTRAL };

export interface TapeFrameEvent {
  kind: "frame";
  /** frame.t in ms (performance-clock domain). */
  t: number;
  /** Seconds since walk start when update() would derive this frame. */
  walkTime: number;
  keypoints: Record<string, PoseKeypoint>;
  /** SOLO tapes only: the caller's turn-window flag (SOLO-MODE §3 — the
   *  lateral channel is excluded while the heading EMA flips). The web
   *  session ignores it. Omitted = false. */
  turnExcluded?: boolean;
}

export interface TapeGapEvent {
  kind: "gap";
  walkTime: number;
}

export type TapeEvent = TapeFrameEvent | TapeGapEvent;

export interface Tape {
  name: string;
  idealPace: number;
  durationSec: number;
  events: TapeEvent[];
}

/**
 * One derivation session — the pose-state slice of a walk. The pre-refactor
 * harness backs this with the sliced MetricsSystem source; the post-refactor
 * implementation is makeRealSession below.
 */
export interface DeriveSession {
  derive(
    frame: PoseFrame,
    poseDt: number,
    walkTime: number,
    turnExcluded?: boolean,
  ): void;
  resetCadence(): void;
  /** Plain-object dump of every pose-state field (for byte comparison). */
  snapshot(): Record<string, unknown>;
  targets(): number[];
  live(): { pace: number | null; lat: number | null; post: number | null };
  finalize(durationSec: number): unknown;
}

/** rampSeconds = the walk length the confidence ramp spans (the perfect=100
 * rescale) — REQUIRED, no default: a silent 45 is the bug the rescale fixed.
 * Tape-driven runs pass tape.durationSec (self-describing fixtures; the
 * Swift harness reads the same field). */
export type SessionFactory = (
  idealPace: number,
  rampSeconds: number,
) => DeriveSession;

// ---------------------------------------------------------------------------
// POST-refactor session: the real extracted module + the real accumulator.
// ---------------------------------------------------------------------------

export function makeRealSession(
  idealPace: number,
  rampSeconds: number,
): DeriveSession {
  const state = new PoseDeriveState();
  const stats = new WalkStatsAccumulator();
  const target = new Float32Array(7);
  // The walk-start arming MetricsSystem.beginWalkTracking performs for this
  // path: lock the mode pace into the accumulator, neutral targets, pose reset.
  stats.reset(idealPace);
  target.fill(NEUTRAL);
  state.reset();
  return {
    derive: (frame, poseDt, walkTime) =>
      deriveWorld(
        frame,
        poseDt,
        walkTime,
        idealPace,
        rampSeconds,
        state,
        stats,
        target,
      ),
    resetCadence: () => state.resetCadence(),
    snapshot: () => ({
      posePrevHipX: state.posePrevHipX,
      posePrevHipZ: state.posePrevHipZ,
      poseHavePrev: state.poseHavePrev,
      poseSpeedEma: state.poseSpeedEma,
      poseLatEma: state.poseLatEma,
      poseUprightEma: state.poseUprightEma,
      poseHeadingX: state.poseHeadingX,
      poseHeadingZ: state.poseHeadingZ,
      poseHeadingValid: state.poseHeadingValid,
      poseBobBaseline: state.poseBobBaseline,
      poseBobHavePrev: state.poseBobHavePrev,
      poseBobSign: state.poseBobSign,
      poseLastCross: state.poseLastCross,
      posePendingDt: state.posePendingDt,
      intervals: Array.from(state.intervals),
      intervalIdx: state.intervalIdx,
      intervalCount: state.intervalCount,
    }),
    targets: () => Array.from(target),
    live: () => ({
      pace: stats.livePaceMps,
      lat: stats.liveLateralM,
      post: stats.livePostureM,
    }),
    finalize: (durationSec) => stats.finalize(durationSec),
  };
}

/**
 * SOLO session — the §3 producer (pose-derive.ts soloDeriveWorld) behind the
 * SAME walk-start arming and seam as makeRealSession, plus the solo state
 * channels in its snapshot. The tape's per-frame turnExcluded flag reaches
 * the derive call (the future SoloSessionEngine's turn-window seam).
 */
export function makeSoloSession(
  idealPace: number,
  rampSeconds: number,
): DeriveSession {
  const state = new PoseDeriveState();
  const stats = new WalkStatsAccumulator();
  const target = new Float32Array(7);
  stats.reset(idealPace);
  target.fill(NEUTRAL);
  state.reset();
  return {
    derive: (frame, poseDt, walkTime, turnExcluded) =>
      soloDeriveWorld(
        frame,
        poseDt,
        walkTime,
        idealPace,
        rampSeconds,
        state,
        stats,
        target,
        turnExcluded === true,
      ),
    resetCadence: () => state.resetCadence(),
    snapshot: () => ({
      posePrevHipX: state.posePrevHipX,
      posePrevHipZ: state.posePrevHipZ,
      poseHavePrev: state.poseHavePrev,
      poseSpeedEma: state.poseSpeedEma,
      poseLatEma: state.poseLatEma,
      poseUprightEma: state.poseUprightEma,
      poseHeadingX: state.poseHeadingX,
      poseHeadingZ: state.poseHeadingZ,
      poseHeadingValid: state.poseHeadingValid,
      poseBobBaseline: state.poseBobBaseline,
      poseBobHavePrev: state.poseBobHavePrev,
      poseBobSign: state.poseBobSign,
      poseLastCross: state.poseLastCross,
      posePendingDt: state.posePendingDt,
      soloBaseY: state.soloBaseY,
      soloBaseSamples: state.soloBaseSamples,
      soloHipDevEma: state.soloHipDevEma,
      soloLatOffset: state.soloLatOffset,
      soloLatStartT: state.soloLatStartT,
      soloLatBaseline: state.soloLatBaseline,
      soloLatBaseSamples: state.soloLatBaseSamples,
      intervals: Array.from(state.intervals),
      intervalIdx: state.intervalIdx,
      intervalCount: state.intervalCount,
    }),
    targets: () => Array.from(target),
    live: () => ({
      pace: stats.livePaceMps,
      lat: stats.liveLateralM,
      post: stats.livePostureM,
    }),
    finalize: (durationSec) => stats.finalize(durationSec),
  };
}

// ---------------------------------------------------------------------------
// The driver — replicates the metrics.ts fresh-frame seam around the derive.
// ---------------------------------------------------------------------------

export interface TapeRecord {
  name: string;
  idealPace: number;
  durationSec: number;
  initial: { targets: number[]; state: Record<string, unknown> };
  steps: Array<Record<string, unknown>>;
  final: unknown;
}

export function runTape(makeSession: SessionFactory, tape: Tape): TapeRecord {
  const session = makeSession(tape.idealPace, tape.durationSec);
  let poseLastT = -1;
  const rec: TapeRecord = {
    name: tape.name,
    idealPace: tape.idealPace,
    durationSec: tape.durationSec,
    initial: { targets: session.targets(), state: session.snapshot() },
    steps: [],
    final: null,
  };
  for (const ev of tape.events) {
    if (ev.kind === "gap") {
      session.resetCadence();
      poseLastT = -1;
      rec.steps.push({
        ev: "gap",
        walkTime: ev.walkTime,
        targets: session.targets(),
        live: session.live(),
        state: session.snapshot(),
      });
      continue;
    }
    // metrics.ts update(): derive ONLY on a fresh frame.t, with the TRUE
    // inter-pose interval (first frame after (re)arm carries poseDt = 0).
    let derived = false;
    if (ev.t !== poseLastT) {
      const poseDt = poseLastT >= 0 ? (ev.t - poseLastT) / 1000 : 0;
      poseLastT = ev.t;
      session.derive(
        { t: ev.t, source: "tape", space: "world", keypoints: ev.keypoints },
        poseDt,
        ev.walkTime,
        ev.turnExcluded === true,
      );
      derived = true;
    }
    rec.steps.push({
      ev: "frame",
      t: ev.t,
      walkTime: ev.walkTime,
      derived,
      targets: session.targets(),
      live: session.live(),
      state: session.snapshot(),
    });
  }
  rec.final = session.finalize(tape.durationSec);
  return rec;
}

// ---------------------------------------------------------------------------
// Byte-stable serialization ({"$num":...} sentinels for non-finite numbers).
// ---------------------------------------------------------------------------

export function sanitize(v: unknown): unknown {
  if (typeof v === "number") {
    if (Number.isFinite(v)) return v;
    if (Number.isNaN(v)) return { $num: "nan" };
    return { $num: v > 0 ? "+inf" : "-inf" };
  }
  if (Array.isArray(v)) return v.map(sanitize);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = sanitize(val);
    return out;
  }
  return v;
}

/** Pretty at the tape level, one compact line per step — diffable AND small. */
export function serializeRecords(records: TapeRecord[]): string {
  const lines: string[] = ["["];
  records.forEach((rec, ri) => {
    const s = sanitize(rec) as {
      steps: unknown[];
      [k: string]: unknown;
    };
    lines.push(" {");
    lines.push(`  "name": ${JSON.stringify(s.name)},`);
    lines.push(`  "idealPace": ${JSON.stringify(s.idealPace)},`);
    lines.push(`  "durationSec": ${JSON.stringify(s.durationSec)},`);
    lines.push(`  "initial": ${JSON.stringify(s.initial)},`);
    lines.push('  "steps": [');
    s.steps.forEach((st, si) => {
      lines.push(
        `   ${JSON.stringify(st)}${si < s.steps.length - 1 ? "," : ""}`,
      );
    });
    lines.push("  ],");
    lines.push(`  "final": ${JSON.stringify(s.final)}`);
    lines.push(` }${ri < records.length - 1 ? "," : ""}`);
  });
  lines.push("]");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Synthetic walk model — pure trig, fully deterministic.
// ---------------------------------------------------------------------------

const POSE_HZ = 30; // production pose-stream cap (iOS sender throttle)
const FRAME_MS = 1000 / POSE_HZ;

export function kpt(x: number, y: number, z: number, score = 0.9): PoseKeypoint {
  return { x, y, z, score };
}

export interface WalkPoseOpts {
  /** Walk-clock seconds for this frame (drives gait phase). */
  time: number;
  /** Hip-center position on the floor plane. */
  posX: number;
  posZ: number;
  /** Unit travel direction on the floor plane. */
  dirX: number;
  dirZ: number;
  stepHz: number;
  bobAmp: number;
  /** Lateral sway amplitude of the hip around the travel line (m). */
  swayAmp: number;
  /** Torso lean magnitude oscillation (m of horizontal shoulder offset). */
  leanAmp: number;
}

/**
 * A full skeleton frame for a walker at `pos` heading `dir`. Hip bobs at
 * stepHz (one bob per step), ankles alternate around the travel line with the
 * stride, shoulders sit 0.45 m above the hips with a slight oscillating lean.
 * Exported: the golden-vector generator's walk-replay/gap-tape builders reuse
 * this exact walker (scripts/gen-golden-vectors.mjs).
 */
export function walkKeypoints(o: WalkPoseOpts): Record<string, PoseKeypoint> {
  const phase = 2 * Math.PI * o.stepHz * o.time;
  // Perpendicular to travel on the floor plane (right-hand side).
  const perpX = -o.dirZ;
  const perpZ = o.dirX;
  const sway = o.swayAmp * Math.sin(phase * 0.5);
  const hipY = 0.95 + o.bobAmp * Math.sin(phase);
  const hipCX = o.posX + perpX * sway;
  const hipCZ = o.posZ + perpZ * sway;
  const hipHalf = 0.11; // half hip width along perp
  const lean = o.leanAmp * Math.sin(phase * 0.5 + 0.7);
  const shY = hipY + 0.45;
  const shCX = hipCX + o.dirX * lean;
  const shCZ = hipCZ + o.dirZ * lean;
  const shHalf = 0.17;
  // Ankles: alternate stride along travel, planted ~0.09 m either side.
  const stride = 0.3 * Math.sin(phase * 0.5);
  const ankleY = 0.08 + Math.max(0, o.bobAmp * 2 * Math.sin(phase)) * 0.5;
  return {
    leftHip: kpt(hipCX - perpX * hipHalf, hipY, hipCZ - perpZ * hipHalf),
    rightHip: kpt(hipCX + perpX * hipHalf, hipY, hipCZ + perpZ * hipHalf),
    leftShoulder: kpt(shCX - perpX * shHalf, shY, shCZ - perpZ * shHalf),
    rightShoulder: kpt(shCX + perpX * shHalf, shY, shCZ + perpZ * shHalf),
    leftAnkle: kpt(
      hipCX - perpX * 0.09 + o.dirX * stride,
      ankleY,
      hipCZ - perpZ * 0.09 + o.dirZ * stride,
    ),
    rightAnkle: kpt(
      hipCX + perpX * 0.09 - o.dirX * stride,
      0.08,
      hipCZ + perpZ * 0.09 - o.dirZ * stride,
    ),
  };
}

/** frame.t for pose index i, plus the walk-clock time update() derives it at. */
function stamp(i: number): { t: number; walkTime: number } {
  const t = i * FRAME_MS;
  return { t, walkTime: t / 1000 + 1 / POSE_HZ };
}

function straightWalkEvents(
  seconds: number,
  speed: number,
  mutate?: (
    kp: Record<string, PoseKeypoint>,
    i: number,
  ) => Record<string, PoseKeypoint> | null,
  gait?: { swayAmp?: number; leanAmp?: number },
): TapeEvent[] {
  const events: TapeEvent[] = [];
  const n = Math.round(seconds * POSE_HZ);
  for (let i = 0; i < n; i++) {
    const { t, walkTime } = stamp(i);
    const time = t / 1000;
    let kp: Record<string, PoseKeypoint> | null = walkKeypoints({
      time,
      posX: speed * time,
      posZ: 0,
      dirX: 1,
      dirZ: 0,
      stepHz: 1.8,
      bobAmp: 0.02,
      swayAmp: gait?.swayAmp ?? 0.03,
      leanAmp: gait?.leanAmp ?? 0.05,
    });
    if (mutate) kp = mutate(kp, i);
    if (kp === null) continue; // dropped frame (no event at all)
    events.push({ kind: "frame", t, walkTime, keypoints: kp });
  }
  return events;
}

export function buildTapes(): Tape[] {
  const tapes: Tape[] = [];

  // 1) Normal steady walk — the baseline: EMAs warm up, ring rolls over.
  tapes.push({
    name: "normal-walk",
    idealPace: 0.85,
    durationSec: 6,
    events: straightWalkEvents(6, 1.1),
  });

  // 2) Single-hip stretches — ARKit occlusion: the far hip drops under the
  //    0.3 confidence gate for 1.5 s per side (plus one boundary-score frame).
  tapes.push({
    name: "single-hip",
    idealPace: 0.85,
    durationSec: 6,
    events: straightWalkEvents(6, 1.0, (kp, i) => {
      if (i >= 45 && i < 90) kp.rightHip = { ...kp.rightHip, score: 0.12 };
      if (i >= 120 && i < 165) kp.leftHip = { ...kp.leftHip, score: 0.05 };
      if (i === 100) kp.rightHip = { ...kp.rightHip, score: 0.3 }; // boundary: passes
      if (i === 101) kp.rightHip = { ...kp.rightHip, score: 0.29999 }; // fails
      return kp;
    }),
  });

  // 3) Camera dropout + resume — 3 s walking, 1.5 s outage (head path owns the
  //    walk; resetCadence round trip), resume mid-walk near the drop point.
  {
    const before = straightWalkEvents(3, 1.1);
    const after: TapeEvent[] = [];
    const resumeFrom = Math.round(4.5 * POSE_HZ);
    const total = Math.round(7 * POSE_HZ);
    for (let i = resumeFrom; i < total; i++) {
      const { t, walkTime } = stamp(i);
      const time = t / 1000;
      after.push({
        kind: "frame",
        t,
        walkTime,
        keypoints: walkKeypoints({
          time,
          posX: 1.1 * time,
          posZ: 0,
          dirX: 1,
          dirZ: 0,
          stepHz: 1.8,
          bobAmp: 0.02,
          swayAmp: 0.03,
          leanAmp: 0.05,
        }),
      });
    }
    tapes.push({
      name: "dropout-resume",
      idealPace: 0.95,
      durationSec: 7,
      events: [...before, { kind: "gap", walkTime: 4.5 }, ...after],
    });
  }

  // 4) Mid-walk heading drift — straight +x for 3.5 s, a smooth 90° turn over
  //    2 s, then straight +z: the heading EMA lags the turn and transiently
  //    inflates ankle lateral (the documented out-and-back behavior).
  {
    const events: TapeEvent[] = [];
    const n = Math.round(9 * POSE_HZ);
    const speed = 1.0;
    let posX = 0;
    let posZ = 0;
    let prevTime = 0;
    for (let i = 0; i < n; i++) {
      const { t, walkTime } = stamp(i);
      const time = t / 1000;
      const turnT = Math.min(Math.max((time - 3.5) / 2, 0), 1);
      const theta = (turnT * Math.PI) / 2;
      const dirX = Math.cos(theta);
      const dirZ = Math.sin(theta);
      posX += speed * (time - prevTime) * dirX;
      posZ += speed * (time - prevTime) * dirZ;
      prevTime = time;
      events.push({
        kind: "frame",
        t,
        walkTime,
        keypoints: walkKeypoints({
          time,
          posX,
          posZ,
          dirX,
          dirZ,
          stepHz: 1.8,
          bobAmp: 0.02,
          swayAmp: 0.03,
          leanAmp: 0.05,
        }),
      });
    }
    tapes.push({
      name: "heading-drift",
      idealPace: 1.05,
      durationSec: 9,
      events,
    });
  }

  // 5) Sparse keypoints — deterministic dropout pattern: ankles missing every
  //    3rd frame, shoulders every 4th, BOTH hips gone every 11th (bail: the
  //    frame holds previous targets), and a stationary first second (heading
  //    stays invalid, footwork unmeasured).
  tapes.push({
    name: "sparse-keypoints",
    idealPace: 0.85,
    durationSec: 5,
    events: straightWalkEvents(5, 0.9, (kp, i) => {
      const time = i / POSE_HZ;
      if (time < 1) {
        // Stationary warm-up: same hip position each frame (mag = 0).
        return walkKeypoints({
          time: 0,
          posX: 0,
          posZ: 0,
          dirX: 1,
          dirZ: 0,
          stepHz: 1.8,
          bobAmp: 0.02,
          swayAmp: 0,
          leanAmp: 0,
        });
      }
      if (i % 3 === 0) {
        delete kp.leftAnkle;
        delete kp.rightAnkle;
      }
      if (i % 4 === 0) {
        delete kp.leftShoulder;
        delete kp.rightShoulder;
      }
      if (i % 11 === 0) {
        delete kp.leftHip;
        delete kp.rightHip;
      }
      return kp;
    }),
  });

  // 6) NaN / junk keypoints — non-finite coordinates are NOT measurements:
  //    kpOk's finiteness gate treats them as absent, exactly like a low-score
  //    keypoint. A NaN-coordinate hip pair (good scores) is a bail frame
  //    (targets hold, EMAs stay finite, recovery on the next clean frame); an
  //    Infinity ankle drops to the single-ankle lateral fallback; NaN scores
  //    fail the confidence gate as before. (The pre-gate recording of this
  //    tape pinned the NaN-poisoning bug AS-IS; the golden was deliberately
  //    regenerated when the gate landed.)
  tapes.push({
    name: "nan-junk",
    idealPace: 0.85,
    durationSec: 6,
    events: straightWalkEvents(6, 1.1, (kp, i) => {
      if (i === 60) {
        kp.leftHip = kpt(NaN, NaN, NaN);
        kp.rightHip = kpt(NaN, NaN, NaN);
      }
      if (i === 90) kp.leftAnkle = kpt(Infinity, 0.08, 0);
      if (i === 120) {
        for (const name of Object.keys(kp)) {
          kp[name] = { ...kp[name], score: NaN };
        }
      }
      return kp;
    }),
  });

  // 7) Bail dt/anchor semantics — the anchor owns its timestamp. A bail frame
  //    (no usable hip) banks its dt (posePendingDt) and the next clean frame
  //    measures the FULL gap displacement over the FULL gap time. Three
  //    phases pin the law: a SINGLE bail frame (recovery divides 2 intervals
  //    of displacement by 2 intervals of time — no 2x pace spike), a 5-frame
  //    bail RUN (multi-bail resume — no double-count), and a REAL outage (gap
  //    event: resetCadence + re-armed frame gate) whose resume still re-seeds
  //    with ZERO stats weight — the span math applies only WITHIN a walk's
  //    tolerated bails, never across a resetCadence gap.
  {
    const before = straightWalkEvents(4.5, 1.1, (kp, i) => {
      if (i === 60 || (i >= 100 && i < 105)) {
        kp.leftHip = { ...kp.leftHip, score: 0.1 };
        kp.rightHip = { ...kp.rightHip, score: 0.1 };
      }
      return kp;
    });
    const after: TapeEvent[] = [];
    const resumeFrom = Math.round(5 * POSE_HZ);
    const total = Math.round(6.5 * POSE_HZ);
    for (let i = resumeFrom; i < total; i++) {
      const { t, walkTime } = stamp(i);
      const time = t / 1000;
      after.push({
        kind: "frame",
        t,
        walkTime,
        keypoints: walkKeypoints({
          time,
          posX: 1.1 * time,
          posZ: 0,
          dirX: 1,
          dirZ: 0,
          stepHz: 1.8,
          bobAmp: 0.02,
          swayAmp: 0.03,
          leanAmp: 0.05,
        }),
      });
    }
    tapes.push({
      name: "bail-dt-semantics",
      idealPace: 0.85,
      durationSec: 6.5,
      events: [...before, { kind: "gap", walkTime: 5 }, ...after],
    });
  }

  // 8) Junk deltas — the caller-supplied dt is sanitized at the top of
  //    deriveWorld: a non-finite or non-positive delta is treated as 0 (a
  //    dark frame — every EMA holds, the anchor still updates, walk-stats
  //    rejects the zero weight). Two junk timestamps drive it through the
  //    metrics.ts fresh-frame seam: a BACKWARD frame.t (negative poseDt ->
  //    0) mid-walk, and a NaN frame.t near the end (NaN poseDt -> 0; the
  //    NEXT frame's dt is (t - NaN) = NaN -> 0 too, then poseLastT re-arms
  //    to that frame's finite t and measurement resumes — two dark frames,
  //    contained recovery, every EMA finite). Keypoints stay clean
  //    throughout: only the CLOCK is junk.
  {
    const events = straightWalkEvents(3, 1.0);
    const backward = events[45] as TapeFrameEvent;
    events[45] = { ...backward, t: (events[44] as TapeFrameEvent).t - 200 };
    const nanT = events[80] as TapeFrameEvent;
    events[80] = { ...nanT, t: NaN };
    tapes.push({
      name: "delta-junk",
      idealPace: 0.85,
      durationSec: 3,
      events,
    });
  }

  return tapes;
}

/**
 * SOLO tapes (SOLO-MODE §3) — driven through makeSoloSession/soloDeriveWorld.
 * Four shared scenarios re-derive under the Solo producer (same inputs, the
 * §3 channels now live), plus three Solo-specific walks: an analytic clean
 * line (zero sway -> lateral channels exactly 0), a mid-walk slouch (the
 * signed hip-height drift channel + M1 respond), and an out-and-back with a
 * marked turn window (the turnExcluded seam: offset frozen, tap dark, mean
 * unpolluted).
 */
export function buildSoloTapes(): Tape[] {
  const keep = new Set([
    "normal-walk",
    "sparse-keypoints",
    "nan-junk",
    "bail-dt-semantics",
  ]);
  const tapes: Tape[] = buildTapes().filter((t) => keep.has(t.name));

  // S1) Clean line — zero sway/lean at 1.0 m/s: the analytic anchor. The
  //     hip path IS the travel line, so soloLatOffset stays exactly 0 and
  //     meanLateralM/meanAbsLateralM finalize to 0; postureDriftM ~ 0.
  tapes.push({
    name: "solo-clean-line",
    idealPace: 0.95,
    durationSec: 6,
    events: straightWalkEvents(6, 1.0, undefined, { swayAmp: 0, leanAmp: 0 }),
  });

  // S2) Slouch — hips AND shoulders drop 5 cm from t = 3 s (frame 90): the
  //     signed drift channel reads ~0 for the first half and ~-0.05 for the
  //     second -> postureDriftM ~ -0.025 over the 6 s walk; M1 sinks.
  tapes.push({
    name: "solo-slouch",
    idealPace: 0.85,
    durationSec: 6,
    events: straightWalkEvents(6, 0.9, (kp, i) => {
      if (i >= 90) {
        for (const n of [
          "leftHip",
          "rightHip",
          "leftShoulder",
          "rightShoulder",
        ]) {
          kp[n] = { ...kp[n], y: kp[n].y - 0.05 };
        }
      }
      return kp;
    }),
  });

  // S3) Turn exclusion — out-and-back on a 3 m line at 1.0 m/s (reversal at
  //     t = 3 s); frames with time in [2.5, 4.5] carry turnExcluded (the
  //     SoloSessionEngine's turn-window seam; the heading EMA is mid-flip
  //     garbage in that window).
  {
    const events: TapeEvent[] = [];
    const n = Math.round(6 * POSE_HZ);
    for (let i = 0; i < n; i++) {
      const { t, walkTime } = stamp(i);
      const time = t / 1000;
      const out = time < 3;
      const ev: TapeFrameEvent = {
        kind: "frame",
        t,
        walkTime,
        keypoints: walkKeypoints({
          time,
          posX: out ? time : 6 - time,
          posZ: 0,
          dirX: out ? 1 : -1,
          dirZ: 0,
          stepHz: 1.8,
          bobAmp: 0.02,
          swayAmp: 0.02,
          leanAmp: 0.03,
        }),
      };
      if (time >= 2.5 && time <= 4.5) ev.turnExcluded = true;
      events.push(ev);
    }
    tapes.push({
      name: "solo-turn-exclusion",
      idealPace: 0.95,
      durationSec: 6,
      events,
    });
  }

  return tapes;
}
