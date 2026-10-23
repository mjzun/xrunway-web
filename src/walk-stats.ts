/**
 * (X)RUNWAY — per-walk physical measurement layer (POLISH-AUDIT #8/#12/#22).
 *
 * Pure scalar accumulator + summary contract for the REAL measured quantities
 * MetricsSystem derives every frame and previously threw away after mapping
 * them into 0-100 scores: true horizontal pace (m/s), the SIGNED centerline
 * offset (m), the SIGNED head-height drift from the walk-start baseline (m),
 * and every detected footstrike. MetricsSystem feeds one accumulator per walk
 * (exposed as `globals.walkStats`), ShowDirector finalizes it into a
 * `WalkStats` on `ShowSummary.stats`, and the session recorder persists it per
 * walk and taps the live fields for the 6 Hz raw sample channels.
 *
 * Dependency-free by design (no @iwsdk/core, no DOM) so it loads in vitest —
 * the stage-budget.ts / floor-fit.ts pattern. Zero per-frame allocation: every
 * ingest method is scalar math on plain number fields, reset once per walk;
 * the only allocation is the single WalkStats object built by finalize() at
 * walk end.
 */

/** Which derivation path produced (most of) a walk's measurements. */
export type WalkStatsSource = "head" | "camera-world" | "camera-image";

/**
 * Real physical measurements for one walk (true units, signed).
 *
 * Sign conventions:
 * - `meanLateralM` / `meanAbsLateralM`: time-weighted means of the SIGNED
 *   centerline offset in the mapped runway frame (runway-layout.ts: RIGHT =
 *   (cos yaw, 0, -sin yaw), the same sign `projectRoute().lateral` returns).
 *   POSITIVE = the trainee's RIGHT while walking the route OUTBOUND (start ->
 *   pose mark); on the return leg of an out-and-back walk that same positive
 *   sign is the trainee's left. A `meanLateralM` near zero next to a large
 *   `meanAbsLateralM` means weaving that averaged out.
 * - `postureDriftM`: time-weighted mean of the SIGNED head-height deviation
 *   from the walk-start baseline. POSITIVE = above the baseline (rose /
 *   on-toes), NEGATIVE = below it (slouching, dropped chin).
 * - `paceDeltaMps` = meanPaceMps - idealPaceMps. POSITIVE = walked faster
 *   than the mode's ideal pace, NEGATIVE = slower.
 * - `cadenceSpm` = steps per minute over the timed walk, i.e.
 *   steps / (durationSec / 60); null when no step was detected or the
 *   duration is not positive.
 * - `source`: the derivation path that owned the most walk time (ties resolve
 *   head > camera-image > camera-world, i.e. toward the always-on path).
 *
 * A nullable field is null when its underlying channel never produced a
 * sample this walk — e.g. an external camera owned scoring for the whole walk
 * (the head-path centerline channel never ran), or the camera dropped before
 * measuring anything.
 */
export interface WalkStats {
  meanPaceMps: number | null;
  idealPaceMps: number;
  paceDeltaMps: number | null;
  meanLateralM: number | null;
  meanAbsLateralM: number | null;
  postureDriftM: number | null;
  steps: number;
  cadenceSpm: number | null;
  source: WalkStatsSource;
}

/**
 * Minimum seconds between COUNTED footstrikes (mirrors metrics.ts STEP_MIN).
 * A strike that re-fires faster than a physically plausible step — including
 * the freshly re-seeded detector right after a camera<->head source handoff —
 * is the same physical step, not a new one. Unlike the cadence ring buffer
 * there is no upper bound: a strike after a long pause is still a real step.
 */
export const STEP_DEBOUNCE_SEC = 0.15;

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Per-walk accumulator. MetricsSystem calls reset() at walk start, then feeds
 * each channel at whatever cadence its derivation path runs (head: app frames;
 * camera: fresh pose frames with the true inter-pose interval). All samples
 * are duration-weighted, so mixed cadences average correctly.
 */
export class WalkStatsAccumulator {
  /**
   * Live raw channels for the session recorder's 6 Hz MetricSample tap and
   * the live audio coach's 2 Hz policy sample (coach-live.ts, #20/#48) —
   * written by MetricsSystem where the smoothed values live (paceMps = the
   * speed EMA the pace score maps from; lateralM = the latest SIGNED
   * centerline offset; postureM = the latest SIGNED head-height deviation
   * from the walk-start baseline, + = above it). Null while the active
   * source doesn't measure the channel (camera-image measures none of them;
   * camera-world has pace but no centerline, and its posture read is torso
   * tilt — a different quantity than head-height drift, so the posture tap
   * goes dark there too).
   */
  livePaceMps: number | null = null;
  liveLateralM: number | null = null;
  livePostureM: number | null = null;
  /** Route-along distance (m) of the head's projection on the walk route —
   * the SAME projectRoute().globalAlong the LINE channel's projection already
   * computes (captured beside liveLateralM, no extra projection). Feeds the
   * recorder's 6 Hz alongM sample channel so a finished walk can be REPLAYED
   * as a ghost trajectory (Replay Theater — display-only, never scored).
   * Null while the head path doesn't own the channel (camera-owned frames
   * have no runway-frame projection). Live-tap only: finalize() ignores it. */
  liveAlongM: number | null = null;

  private idealPace = 0;
  private paceSum = 0;
  private paceTime = 0;
  private latSum = 0;
  private latAbsSum = 0;
  private latTime = 0;
  private postSum = 0;
  private postTime = 0;
  private stepCount = 0;
  private lastStepAt = -1;
  private tHead = 0;
  private tImage = 0;
  private tWorld = 0;

  /** Arm for a new walk, locking the mode's ideal pace (m/s) for this run. */
  reset(idealPaceMps: number): void {
    this.idealPace = idealPaceMps;
    this.paceSum = 0;
    this.paceTime = 0;
    this.latSum = 0;
    this.latAbsSum = 0;
    this.latTime = 0;
    this.postSum = 0;
    this.postTime = 0;
    this.stepCount = 0;
    this.lastStepAt = -1;
    this.tHead = 0;
    this.tImage = 0;
    this.tWorld = 0;
    this.livePaceMps = null;
    this.liveLateralM = null;
    this.livePostureM = null;
    this.liveAlongM = null;
  }

  /**
   * Clear ONLY the lateral (centerline) channel. Called by MetricsSystem when
   * the runway is REMAPPED mid-walk (fit-to-room / editor): every accumulated
   * lateral sample was measured against the old centerline, so keeping it
   * would blend two geometries into one persisted mean. Pace / posture /
   * steps / source time are centerline-independent and survive the remap.
   */
  resetLateral(): void {
    this.latSum = 0;
    this.latAbsSum = 0;
    this.latTime = 0;
  }

  /** Credit `dtSec` of walk time to a derivation path (source dominance). */
  noteSource(source: WalkStatsSource, dtSec: number): void {
    if (!(dtSec > 0)) return;
    if (source === "head") this.tHead += dtSec;
    else if (source === "camera-world") this.tWorld += dtSec;
    else this.tImage += dtSec;
  }

  /** One horizontal-speed sample (TRUE m/s), weighted by its interval. */
  addPace(speedMps: number, dtSec: number): void {
    if (!(dtSec > 0) || !Number.isFinite(speedMps)) return;
    this.paceSum += speedMps * dtSec;
    this.paceTime += dtSec;
  }

  /** One SIGNED centerline offset sample (m) — see WalkStats.meanLateralM. */
  addLateral(lateralM: number, dtSec: number): void {
    if (!(dtSec > 0) || !Number.isFinite(lateralM)) return;
    this.latSum += lateralM * dtSec;
    this.latAbsSum += (lateralM < 0 ? -lateralM : lateralM) * dtSec;
    this.latTime += dtSec;
  }

  /** One SIGNED head-height deviation sample (m, + = above the baseline). */
  addPosture(deviationM: number, dtSec: number): void {
    if (!(dtSec > 0) || !Number.isFinite(deviationM)) return;
    this.postSum += deviationM * dtSec;
    this.postTime += dtSec;
  }

  /**
   * One detected footstrike at `atSec` (seconds into the walk). Strikes
   * closer than STEP_DEBOUNCE_SEC to the previous one are the same physical
   * step (detector jitter / source-handoff re-fire) and are not re-counted.
   */
  addStep(atSec: number): void {
    if (this.lastStepAt >= 0 && atSec - this.lastStepAt < STEP_DEBOUNCE_SEC) {
      return;
    }
    this.lastStepAt = atSec;
    this.stepCount++;
  }

  /**
   * Freeze the walk into a WalkStats (non-destructive — the accumulator keeps
   * its state until the next reset()). Returns null only when the walk never
   * produced a sample on ANY channel (no derivation path ever ran).
   */
  finalize(durationSec: number): WalkStats | null {
    const ranAtAll =
      this.paceTime > 0 ||
      this.latTime > 0 ||
      this.postTime > 0 ||
      this.stepCount > 0 ||
      this.tHead > 0 ||
      this.tImage > 0 ||
      this.tWorld > 0;
    if (!ranAtAll) return null;

    // Dominant source by accumulated derivation time; ties keep the
    // earlier-checked (always-on head first, then camera-image).
    let source: WalkStatsSource = "head";
    let best = this.tHead;
    if (this.tImage > best) {
      source = "camera-image";
      best = this.tImage;
    }
    if (this.tWorld > best) {
      source = "camera-world";
    }

    const meanPace = this.paceTime > 0 ? this.paceSum / this.paceTime : null;
    return {
      meanPaceMps: meanPace === null ? null : round3(meanPace),
      idealPaceMps: this.idealPace,
      paceDeltaMps:
        meanPace === null ? null : round3(meanPace - this.idealPace),
      meanLateralM:
        this.latTime > 0 ? round3(this.latSum / this.latTime) : null,
      meanAbsLateralM:
        this.latTime > 0 ? round3(this.latAbsSum / this.latTime) : null,
      postureDriftM:
        this.postTime > 0 ? round3(this.postSum / this.postTime) : null,
      steps: this.stepCount,
      cadenceSpm:
        this.stepCount > 0 && durationSec > 0
          ? round1(this.stepCount / (durationSec / 60))
          : null,
      source,
    };
  }
}
