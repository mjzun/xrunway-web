/**
 * (X)RUNWAY — live audio coaching system (POLISH-AUDIT #20/#48).
 *
 * During a scored walk the trainee physically walks AWAY from the HUD panel;
 * mid-walk the only channel that can coach them is AUDIO. This system is the
 * glue between the measurement layer and the pure policy:
 *
 *   walk-stats live taps ──2 Hz──▶ coach-live.ts policy ──▶ coach-voice.ts
 *   (livePaceMps/LateralM/          (decideLiveCue: all       (earcon lead-in
 *    PostureM, via globals)          rules + hysteresis)       + speech + duck)
 *
 * A dedicated system (not folded into MetricsSystem or SfxSystem) because it
 * spans concerns neither owns: MetricsSystem derives measurements and must
 * stay delivery-free; SfxSystem voices SHOW beats (phase edges/bursts), not
 * trainee-fault decisions. One system per file, single purpose.
 *
 * Zero per-frame allocation: update() is number compares + one shared-flag
 * read; the 2 Hz sample mutates ONE preallocated LiveCueInput and peek()s
 * signals (never .value). The only allocations are the LiveCue on an actual
 * fire (rare, event-scoped — the sfx.ts precedent) and speech/earcon nodes
 * inside coach-voice.
 *
 * Laws honored here:
 *  - poseBurst is a SHARED durable flag with multiple readers — this system
 *    edge-detects with a PRIVATE prev latch and NEVER writes it (sfx.ts law).
 *  - The mode is locked per run at the walk edge (idealPace), matching
 *    MetricsSystem's own per-run lock — a mid-run picker change can't move
 *    the pace target under the policy.
 *  - Mid-walk remap (fit-to-room/editor): globals.compiledPath fires; the
 *    centerline (and possibly route topology) moved under the live walk, so
 *    the fault clocks clear (counters/cooldown survive) and the mark latch
 *    re-arms — mirroring MetricsSystem.resetLateral() + show.ts applyPath().
 *  - Trainee OFF switch: globals.coachPrefs (persisted, default ON); and
 *    the musicPrefs mute law ALSO silences coaching (#6 — mute means
 *    silence), where "mute" is sfxLevel() <= 0: enabled === false OR volume
 *    dragged to 0 behave identically. Both are peeked at the 2 Hz gate, so
 *    toggles apply mid-walk — and a CLOSED gate clears the policy's fault
 *    clocks (a suppression window, never a mute-only window that ages a
 *    fault unobserved: the test/coach-live.test.ts law).
 *  - Demo honesty: the Preview Walk auto-pilot (globals.demoActive) is a
 *    scripted bot, not a trainee — the coach never critiques it. (This
 *    REVERSES an earlier deliberate call; the night review adjudicated it:
 *    the smoothstep leg kinematics trip the pace gates on most runway
 *    lengths, barking corrections over the founder's pitch.)
 *  - Platform-neutral: desktop and XR take the identical path (audio needs
 *    no camera rig), so the coach works wherever the walk does.
 */

import { createSystem } from "@iwsdk/core";
import type { Signal } from "@preact/signals-core";

import type { CoachPrefs } from "./coach-prefs.js";
import {
  COACH_SAMPLE_SEC,
  LiveCoachPolicy,
  type LiveCueInput,
} from "./coach-live.js";
import {
  cancelCoachVoice,
  speakCue,
  type MusicDuckControls,
} from "./coach-voice.js";
import { DEFAULT_MODE, type TrainingMode } from "./modes.js";
import { DEFAULT_MUSIC, type MusicPrefs } from "./music-prefs.js";
import type { SegmentedPath } from "./runway-shape.js";
import { sfxLevel } from "./sfx-timeline.js";
import type { ShowPhaseValue } from "./show.js";
import type { WalkStatsAccumulator } from "./walk-stats.js";

// COACH_SAMPLE_SEC moved to the pure coach-live.ts (single-sourcing for the
// golden generator, finding #12); re-exported for existing importers.
export { COACH_SAMPLE_SEC } from "./coach-live.js";

export class CoachLiveSystem extends createSystem({}, {}) {
  private phaseSig!: Signal<ShowPhaseValue>;
  private walkRemainingSig: Signal<number> | null = null;
  private walkProgressSig: Signal<number> | null = null;
  private modeSig: Signal<TrainingMode> | null = null;
  private coachSig: Signal<CoachPrefs> | null = null;
  private musicSig: Signal<MusicPrefs> | null = null;

  private walking = false;
  private walkTime = 0;
  private sampleAcc = 0;
  /** The run mode's ideal pace, locked at the walk edge. */
  private idealPace = DEFAULT_MODE.idealPace;
  /** One-way route (U) — refreshed from compiledPath (walk edge + remaps). */
  private oneWay = false;
  /** Walk-time when the pose mark was hit this run, or null. */
  private markAt: number | null = null;
  /** PRIVATE rising-edge latch for the shared poseBurst flag (never written). */
  private posePrev = false;

  private policy!: LiveCoachPolicy;
  /** ONE mutable input snapshot, reused every sample (zero alloc). */
  private cueInput!: LiveCueInput;

  init(): void {
    const g = this.globals;
    this.phaseSig = g.showPhase as Signal<ShowPhaseValue>;
    this.walkRemainingSig =
      (g.walkRemaining as Signal<number> | undefined) ?? null;
    this.walkProgressSig =
      (g.walkProgress as Signal<number> | undefined) ?? null;
    this.modeSig = (g.activeMode as Signal<TrainingMode> | undefined) ?? null;
    this.coachSig = (g.coachPrefs as Signal<CoachPrefs> | undefined) ?? null;
    this.musicSig = (g.musicPrefs as Signal<MusicPrefs> | undefined) ?? null;

    this.policy = new LiveCoachPolicy();
    this.cueInput = {
      walking: false,
      walkRemainingSec: Number.POSITIVE_INFINITY,
      markAtSec: null,
      walkProgress01: 0,
      oneWayRoute: false,
      paceDeltaMps: null,
      absLateralM: null,
      postureM: null,
    };

    const pathSig = g.compiledPath as Signal<SegmentedPath> | undefined;
    if (pathSig !== undefined) {
      this.oneWay = pathSig.peek().kind === "U";
      this.cleanupFuncs.push(
        pathSig.subscribe((p) => {
          this.oneWay = p.kind === "U";
          if (this.walking) {
            // Remap mid-walk: the route just moved under the live walk (the
            // director re-armed poseBurst; metrics reset its lateral stats).
            // posePrev must re-arm WITH markAt — the director clears and
            // re-latches the shared flag around this remap, and a stale
            // private latch would swallow the rising edge, losing the
            // turn-suppress window for the rest of the walk (night-review).
            this.markAt = null;
            this.posePrev = false;
            this.policy.clearFaults();
          }
        }),
      );
    }

    this.cleanupFuncs.push(
      this.phaseSig.subscribe((phase) => {
        const walking = phase === "walk";
        if (walking && !this.walking) {
          this.walkTime = 0;
          this.sampleAcc = 0;
          this.markAt = null;
          this.posePrev = false; // director cleared poseBurst before the flip
          this.idealPace = (this.modeSig?.peek() ?? DEFAULT_MODE).idealPace;
          this.policy.reset();
        } else if (!walking && this.walking) {
          // Finish/reset: silence a mid-utterance cue immediately — the
          // summary (or the house) must not carry a stale correction.
          cancelCoachVoice();
        }
        this.walking = walking;
      }),
    );

    this.cleanupFuncs.push(() => cancelCoachVoice());
  }

  update(delta: number): void {
    if (!this.walking || delta <= 0) {
      return;
    }
    // The Preview Walk auto-pilot is a scripted bot (globals.demoActive, the
    // convention session-recorder/show/landing already honor) — trainee-fault
    // decisions about it are meaningless, so the coach sits the demo out.
    if (this.globals.demoActive === true) {
      return;
    }
    this.walkTime += delta;

    // Pose-mark rising edge, PRIVATE latch (the shared flag stays untouched).
    const pose = this.globals.poseBurst === true;
    if (pose && !this.posePrev) {
      this.markAt = this.walkTime;
    }
    this.posePrev = pose;

    // 2 Hz gate — everything below runs at most twice a second.
    this.sampleAcc += delta;
    if (this.sampleAcc < COACH_SAMPLE_SEC) {
      return;
    }
    this.sampleAcc %= COACH_SAMPLE_SEC;

    // Trainee OFF switch + the product mute law (#6). Peeked live so both
    // toggles take effect mid-walk. sfxLevel() <= 0 makes volume 0 behave
    // EXACTLY like the enabled=false mute — the old !music.enabled gate let
    // a volume-0 walk keep sampling, so inaudible cues silently burned the
    // per-kind budget/cooldown/no-repeat latch (night-review). Every closed
    // gate CLEARS the fault clocks: re-enabling mid-walk needs a fresh
    // FAULT_HOLD_SEC hold, because clean samples that would have reset the
    // clocks were never taken while the gate was shut.
    const coachOn = this.coachSig === null || this.coachSig.peek().enabled;
    const music = this.musicSig !== null ? this.musicSig.peek() : DEFAULT_MUSIC;
    if (!coachOn || sfxLevel(music) <= 0) {
      this.policy.clearFaults();
      return;
    }

    const acc =
      (this.globals.walkStats as WalkStatsAccumulator | null | undefined) ??
      null;
    if (acc === null) {
      this.policy.clearFaults(); // same freeze law as the pref gate above
      return; // no measurement layer, nothing honest to say
    }

    const input = this.cueInput;
    input.walking = true;
    input.walkRemainingSec =
      this.walkRemainingSig !== null
        ? this.walkRemainingSig.peek()
        : Number.POSITIVE_INFINITY;
    input.markAtSec = this.markAt;
    input.walkProgress01 =
      this.walkProgressSig !== null ? this.walkProgressSig.peek() : 0;
    input.oneWayRoute = this.oneWay;
    // Channel honesty, defense in depth: the policy has its own
    // Number.isFinite gates, but a poisoned upstream EMA (sticky-NaN
    // pose-speed, metrics.ts) must read as "not measured" at the tap too.
    const pace = acc.livePaceMps;
    input.paceDeltaMps =
      pace !== null && Number.isFinite(pace) ? pace - this.idealPace : null;
    const lat = acc.liveLateralM;
    input.absLateralM =
      lat !== null && Number.isFinite(lat) ? (lat < 0 ? -lat : lat) : null;
    const post = acc.livePostureM;
    input.postureM = post !== null && Number.isFinite(post) ? post : null;

    const cue = this.policy.decideLiveCue(input, this.walkTime);
    if (cue !== null) {
      // Read the duck handle lazily/defensively — MusicSystem registers
      // before this system, but tests and partial worlds may lack it.
      const duck =
        (this.globals.musicDuck as MusicDuckControls | null | undefined) ??
        null;
      speakCue(cue, music, duck);
    }
  }
}
