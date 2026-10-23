/**
 * (X)RUNWAY — FitSessionSystem: the engine wrapper around the PURE guided
 * FIT capture (fit-session.ts FitCaptureMachine). Wiring only — nothing here
 * measures or decides; it feeds the machine head samples and publishes its
 * edges.
 *
 * WHY AN OWN SYSTEM (spec §4.1, settled): a "fit" show-phase variant would
 * NaN the director's energy lerp (ENERGY_TARGET is indexed raw), arm
 * MetricsSystem, open a recorder row, and re-anchor the music bar grid.
 * showPhase stays "idle" for the whole flow — house energy + idle music are
 * the right calibration atmosphere for free, and "walk" keeps meaning
 * SCORED walk everywhere.
 *
 * Surface (globals):
 * - bodyFitFlow      Signal<FitFlowState | null> — stage EDGES only (the
 *                    machine's takeEdge(); progress never rides on it).
 * - bodyFitControls  { start(): boolean; cancel(): void } — assigned in
 *                    init() (the showControls pattern), cleanup-guarded.
 * - bodyFitProgress  { value: number } plain mutable ref, written per frame
 *                    (the holdLive pattern) — pollers read it, no signal churn.
 * - bodyBaseline     Signal<BodyBaseline | null> — written ONCE on a
 *                    successful save, AFTER persistence (signal write last,
 *                    the subscriber-throw safety law).
 *
 * Laws wired here:
 * - Caller-side refusals (fit-wiring.ts fitStartRefusal, pure + tested):
 *   idle-only, no demo auto-pilot, no mapping, no double-start.
 * - Abort-on-interruption via machine.cancel(): showPhase leaves "idle",
 *   mapMode leaves "off", a compiledPath change mid-fit (the runway moved
 *   under the measurement — fit aborts instead of partial-resetting: the
 *   flow is ~60 s and re-runnable), XR exit (NonImmersive), a trainee
 *   switch mid-fit. Nothing is ever persisted on an abort.
 * - Finiteness at the boundary: the head position is gated with
 *   Number.isFinite BEFORE projectRoute; a dark frame feeds NaN through to
 *   the machine (whose ingest drops the sample) so the stage timeout clocks
 *   keep running — an interruption that blinds tracking must not also
 *   freeze the abort clock.
 * - Zero per-frame allocation: ONE Vector3 + ONE Quaternion + the projector
 *   are preallocated in init(); update() is scalar math; the only
 *   allocations are the edge objects (a handful per session) and the one
 *   BodyBaseline at save. PoseFrame is never consumed; all timing is ECS
 *   delta (PoseFrame.t is wall-clock — the law).
 * - Terminal stages hold FIT_TERMINAL_HOLD_SEC, then machine.reset() and
 *   the flow signal clears to null.
 * - Voice: every published edge line is also spoken via speakFitLine
 *   (coach-voice.ts — the speakCue path minus the earcon; the musicPrefs
 *   mute law lives there, the coachPrefs on/off gate lives here).
 */

import {
  createSystem,
  Quaternion,
  Vector3,
  VisibilityState,
} from "@iwsdk/core";
import type { Signal } from "@preact/signals-core";

import { saveFitBaseline, type BodyBaseline } from "./body-baseline.js";
import type { CoachPrefs } from "./coach-prefs.js";
import {
  speakFitLine,
  type MusicDuckControls,
} from "./coach-voice.js";
import {
  FIT_LINES,
  FIT_TERMINAL_HOLD_SEC,
  FitCaptureMachine,
  type FitFlowState,
} from "./fit-session.js";
import { fitStartRefusal } from "./fit-wiring.js";
import { DEFAULT_MUSIC, type MusicPrefs } from "./music-prefs.js";
import { startAlong } from "./runway-layout.js";
import {
  compileShape,
  DEFAULT_SHAPE,
  RunwayPathProjector,
  type SegmentedPath,
} from "./runway-shape.js";
import type { ShowPhaseValue } from "./show.js";
import { DEFAULT_USER, type UserPrefs } from "./user-prefs.js";

/** Controls published as globals.bodyFitControls. start() returns false when
 * refused (the CALLER shows the reason line — spec §4.3). */
export interface FitControls {
  start(): boolean;
  cancel(): void;
}

export class FitSessionSystem extends createSystem({}, {}) {
  /** The pure flow runner — every measurement/decision lives in it. */
  private readonly machine = new FitCaptureMachine();

  private headPos!: Vector3;
  private headQuat!: Quaternion;
  private projector!: RunwayPathProjector;
  /** Pose mark's route-along coordinate — refreshed on every remap. */
  private poseA = 0;

  private phaseSig!: Signal<ShowPhaseValue>;
  private flowSig!: Signal<FitFlowState | null>;
  private baselineSig?: Signal<BodyBaseline | null>;
  private mapModeSig?: Signal<string>;
  private userSig?: Signal<UserPrefs>;
  private coachSig?: Signal<CoachPrefs>;
  private musicSig?: Signal<MusicPrefs>;

  /** Per-frame 0..1 stage progress (globals.bodyFitProgress — plain ref). */
  private progressRef: { value: number } = { value: 0 };

  /** Seconds spent in a terminal stage (saved/aborted) before the flow
   * signal clears (FIT_TERMINAL_HOLD_SEC — presentation, engine-owned). */
  private terminalElapsed = 0;

  /** Trainee id seen by the userPrefs subscription (a mid-fit id CHANGE
   * aborts; the immediate subscribe fire only seeds this). */
  private lastTraineeId: string | null = null;

  init(): void {
    const g = this.globals;
    this.headPos = new Vector3();
    this.headQuat = new Quaternion();
    this.projector = new RunwayPathProjector();

    this.phaseSig = g.showPhase as Signal<ShowPhaseValue>;
    this.flowSig = g.bodyFitFlow as Signal<FitFlowState | null>;
    this.baselineSig = g.bodyBaseline as
      | Signal<BodyBaseline | null>
      | undefined;
    this.mapModeSig = g.mapMode as Signal<string> | undefined;
    this.userSig = g.userPrefs as Signal<UserPrefs> | undefined;
    this.coachSig = g.coachPrefs as Signal<CoachPrefs> | undefined;
    this.musicSig = g.musicPrefs as Signal<MusicPrefs> | undefined;

    // Progress rides a plain mutable ref (adjudication §K / the holdLive
    // pattern) — reuse the ref index.ts seeded so early readers keep their
    // handle; publish one if this system boots first (tests/partial worlds).
    const ref = g.bodyFitProgress as { value: number } | undefined;
    if (ref && typeof ref.value === "number") {
      this.progressRef = ref;
    } else {
      g.bodyFitProgress = this.progressRef;
    }

    // Route geometry: keep the projector + the cached pose mark in sync with
    // the compiled path (the metrics.ts pattern). A remap MID-FIT moved the
    // runway under the measurement -> abort (nothing persisted).
    const pathSig = g.compiledPath as Signal<SegmentedPath> | undefined;
    if (pathSig !== undefined) {
      const seed = pathSig.peek();
      this.projector.set(seed);
      this.poseA = seed.poseRouteAlong;
      let first = true; // @preact subscribe fires immediately — not a remap
      this.cleanupFuncs.push(
        pathSig.subscribe((path) => {
          this.projector.set(path);
          this.poseA = path.poseRouteAlong;
          if (!first) this.cancelFit();
          first = false;
        }),
      );
    } else {
      const fallback = compileShape(DEFAULT_SHAPE);
      this.projector.set(fallback);
      this.poseA = fallback.poseRouteAlong;
    }

    // Abort-on-interruption subscriptions. machine.cancel() no-ops when the
    // flow is inactive or already terminal, so the immediate subscribe fire
    // (and every unrelated edge) is safe.
    this.cleanupFuncs.push(
      this.phaseSig.subscribe((phase) => {
        if (phase !== "idle") this.cancelFit();
      }),
    );
    if (this.mapModeSig) {
      this.cleanupFuncs.push(
        this.mapModeSig.subscribe((m) => {
          if (m !== "off") this.cancelFit();
        }),
      );
    }
    if (this.userSig) {
      this.cleanupFuncs.push(
        this.userSig.subscribe((u) => {
          if (this.lastTraineeId !== null && u.id !== this.lastTraineeId) {
            this.cancelFit(); // trainee switch mid-fit — measurement is void
          }
          this.lastTraineeId = u.id;
        }),
      );
    }
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((vs) => {
        if (vs === VisibilityState.NonImmersive) this.cancelFit(); // headset off
      }),
    );

    const controls: FitControls = {
      start: () => this.startFit(),
      cancel: () => this.cancelFit(),
    };
    g.bodyFitControls = controls;
    this.cleanupFuncs.push(() => {
      if (g.bodyFitControls === controls) {
        g.bodyFitControls = null;
      }
    });
  }

  update(delta: number): void {
    const stage = this.machine.stage;
    if (stage === null) {
      return; // zero cost outside a fit
    }

    if (stage === "saved" || stage === "aborted") {
      // Terminal hold: keep the line readable, then clear the flow.
      this.terminalElapsed += delta;
      if (this.terminalElapsed >= FIT_TERMINAL_HOLD_SEC) {
        this.machine.reset();
        this.progressRef.value = 0;
        this.flowSig.value = null;
      }
      return;
    }

    // Live stages — feed the machine one head sample. Finiteness gate at the
    // boundary: a non-finite head position must not reach projectRoute; the
    // NaN route feeds through so the machine's ingest drops the sample while
    // its stage timeout clock still advances (dark frames never freeze the
    // abort clock).
    this.player.head.getWorldPosition(this.headPos);
    this.player.head.getWorldQuaternion(this.headQuat);
    const x = this.headPos.x;
    const y = this.headPos.y;
    const z = this.headPos.z;
    let along = NaN;
    let lateral = NaN;
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      const r = this.projector.projectRoute(x, z);
      along = r.globalAlong;
      lateral = r.lateral;
    }
    this.machine.push(
      delta,
      x,
      y,
      z,
      this.headQuat.x,
      this.headQuat.y,
      this.headQuat.z,
      this.headQuat.w,
      along,
      lateral,
    );
    this.progressRef.value = this.machine.progress;
    this.drainEdge();
  }

  // -- controls ---------------------------------------------------------------

  /** Arm the guided flow. Returns false on a caller-side refusal (idle-only /
   * demo / mapping / already running — fit-wiring.ts) or junk geometry
   * (machine.start). The CALLER surfaces the reason line. */
  private startFit(): boolean {
    const refusal = fitStartRefusal({
      phase: this.phaseSig.peek(),
      demoActive: this.globals.demoActive === true,
      mapMode: this.mapModeSig?.peek() ?? "off",
      flowActive: this.machine.stage !== null,
    });
    if (refusal !== null) {
      return false;
    }
    const ok = this.machine.start({
      startA: startAlong(),
      poseA: this.poseA,
      traineeId: this.userSig?.peek().id ?? DEFAULT_USER.id,
      nowMs: Date.now(), // record timestamp only — flow timing is ECS delta
    });
    if (ok) {
      this.terminalElapsed = 0;
      this.progressRef.value = 0;
      this.drainEdge(); // publish the "mark" edge (+ speak it) synchronously
    }
    return ok;
  }

  /** External interruption / user cancel — no-op when inactive or terminal.
   * The aborted edge publishes immediately (subscribers must not wait a
   * frame for "Fit cancelled"). Nothing is persisted. */
  private cancelFit(): void {
    this.machine.cancel();
    this.drainEdge();
  }

  // -- internals ----------------------------------------------------------------

  /** Publish the machine's pending EDGE (stage transition / line change) on
   * the flow signal, persisting the baseline first on "saved". Edges are the
   * ONLY signal writes this system makes — never per frame. */
  private drainEdge(): void {
    const edge = this.machine.takeEdge();
    if (edge === null) {
      return;
    }
    if (edge.stage === "saved" || edge.stage === "aborted") {
      this.terminalElapsed = 0;
    }
    if (edge.stage === "saved" && this.machine.baseline !== null) {
      // ATOMIC save order: persist FIRST, publish the baseline signal LAST
      // (subscriber-throw safety — a throwing subscriber must not be able to
      // skip the localStorage write), THEN the flow edge below so any flow
      // subscriber reading globals.bodyBaseline sees the fresh capture.
      const persisted = saveFitBaseline(this.machine.baseline);
      if (this.baselineSig) {
        // Published EVEN when the persist failed: the in-memory baseline
        // honestly scores THIS session either way.
        this.baselineSig.value = this.machine.baseline;
      }
      if (!persisted) {
        // Storage-honest terminal line (records lens): the trainee must
        // never be told a failed persist was saved — the session is usable
        // NOW, but a reload will revert to the prior baseline. Edge objects
        // allocate on edges only, so the swap allocation is fine.
        const honest: FitFlowState = {
          stage: edge.stage,
          line: FIT_LINES.savedNotStored,
          detail: edge.detail,
        };
        this.flowSig.value = honest;
        this.speak(honest.line);
        return;
      }
    }
    this.flowSig.value = edge;
    this.speak(edge.line);
  }

  /** Speak one guidance line through the coach-voice path. The coachPrefs
   * on/off gate lives here (the CoachLiveSystem pattern); the musicPrefs
   * mute law + cancel-never-queue live in speakFitLine. */
  private speak(line: string): void {
    const coachOn = this.coachSig?.peek().enabled ?? true;
    if (!coachOn) {
      return;
    }
    const music = this.musicSig?.peek() ?? DEFAULT_MUSIC;
    const duck =
      (this.globals.musicDuck as MusicDuckControls | null | undefined) ?? null;
    speakFitLine(line, music, duck);
  }
}
