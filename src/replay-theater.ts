/**
 * (X)RUNWAY — Replay Theater (the ECS/render side; pure core in
 * replay-core.ts).
 *
 * After a scored walk, the trainee watches a luminous GHOST of themself walk
 * the recorded trajectory back on the mapped runway, from a front-row seat.
 * As the ghost passes a moment the walk lost points, a floor ring lights up
 * at the spot (LINE drift / PACE off the band / a HEAD drop — the engine's
 * own thresholds, see replay-core.ts).
 *
 * DISPLAY-ONLY: reads the session recorder's latest full record and the
 * compiled path; never touches scoring, records, or the show FSM. The show
 * stays parked in the `summary` phase for the whole replay.
 *
 * Viewpoint law:
 * - BROWSER (NonImmersive): the system owns the rig for the replay — saves
 *   it, pauses the locomotion systems (the demo-walk class-reference
 *   pattern), seats the viewer on a front-row seat the stage computed
 *   (globals.audienceFrontRowLocal, spine-local; a computed head-on seat
 *   past the runway end when the crowd is hidden), and eases the gaze onto
 *   the ghost. Restores everything on exit.
 * - XR: the trainee's head is REAL — the rig is never moved. The ghost +
 *   rings play on the runway and the trainee watches from where they stand.
 *
 * ANY input exits (after a short arm window so the click/trigger that
 * STARTED the replay can't instantly end it): keydown / pointerdown in the
 * browser, any face button / trigger / squeeze / a thumbstick flick in XR.
 * A phase change, a runway remap, or entering/leaving XR also exits.
 */

import {
  AdditiveBlending,
  BufferGeometry,
  CircleGeometry,
  DoubleSide,
  Color,
  Float32BufferAttribute,
  LatheGeometry,
  createSystem,
  InputComponent,
  LocomotionSystem,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  RingGeometry,
  ShaderMaterial,
  SlideSystem,
  SphereGeometry,
  TeleportSystem,
  TurnSystem,
  Vector2,
  Vector3,
  VisibilityState,
} from "@iwsdk/core";
import type { Entity } from "@iwsdk/core";
import { signal, type Signal } from "@preact/signals-core";

import { M8_PITCH_BAND_DEG } from "./head-carriage.js";
import {
  buildReplayTrack,
  REPLAY_COACH_HOLD_SEC,
  REPLAY_COACH_LEAD_SEC,
  REPLAY_CUE_TEXT,
  markerDetail,
  recapCues,
  replayMarkers,
  traceFromTrack,
  traceTicks,
  trackPoseAt,
  type ReplayMarker,
  type ReplayPose,
  type ReplayTrack,
} from "./replay-core.js";
import { routeToWorld, type RoutePoint, type SegmentedPath } from "./runway-shape.js";
import {
  createBeatGemMaterial,
  createHologramMaterial,
  createTraceMaterial,
} from "./shaders.js";
import type { SessionRecord, SessionRecorder } from "./session-recorder.js";
import type { ShowPhaseValue } from "./show.js";
import { BRAND, STAGE } from "./theme.js";

/** Marker ring colors by kind — brand language (no pink, Carolina accent):
 * LINE = Carolina blue, PACE = white, HEAD = warm amber. */
export const REPLAY_MARKER_COLORS: Record<string, number> = {
  line: BRAND.accent,
  pace: 0xf2f4f8,
  head: 0xd9a441,
};

/** Seconds of playback before ANY-INPUT-EXITS arms — absorbs the click /
 * trigger release that started the replay. */
const ARM_SEC = 0.35;
/** Seated eye height above the seat surface (the stage's flash anchors put
 * heads at seat + 0.62). */
const SEAT_EYE = 0.62;
/** Gaze ease rate (1/s) — the front-row viewer tracks the ghost smoothly. */
const GAZE_RATE = 5;
/** Ghost gait bob (m) + cadence feel (Hz) while the recorded speed says the
 * trainee was moving. Display flavor only. */
const GHOST_BOB_AMP = 0.022;
const GHOST_STEP_HZ = 1.8;
/** Ring pulse decay (s) after the ghost passes its moment. */
const RING_PULSE_SEC = 1.4;

export interface ReplayControls {
  /** True when the latest recorded walk can be replayed (both surfaces gate
   * their REPLAY control on this). */
  available(): boolean;
  /** True when the walk with this id has a replayable FULL record still in
   * memory (the RUN HISTORY cards gate their per-walk REPLAY on this). */
  availableFor(id: string): boolean;
  /** Enter the replay of the LATEST walk (summary surface). Returns false
   * when unavailable / wrong phase. */
  start(): boolean;
  /** Enter the replay of a SPECIFIC recorded walk (run-history surface) —
   * allowed from idle OR summary, never mid-run. */
  startFor(id: string): boolean;
  /** Exit + restore. Safe to call when inactive. */
  stop(): void;
  // -- GHOST vs GHOST (the SimulCam pattern; founder go 2026-07-23) --------
  /** True when walk `id` can be compared against a DIFFERENT replayable
   * walk still in memory (the best-scoring other record). */
  compareAvailableFor(id: string): boolean;
  /** Start the synchronized two-ghost replay: walk `id` (Carolina) vs the
   * best OTHER in-memory walk (silver), start-aligned on one runway. */
  startCompareFor(id: string): boolean;
  // -- the PLAYER surface (the web replay bar; founder call 2026-07-23) ----
  /** Pause / resume playback (the ghost freezes in place). */
  pause(): void;
  resume(): void;
  /** Jump back to the top of the tape (rings re-arm). */
  restart(): void;
  /** Playback rate (0.5 = slow study; clamped to [0.25, 2]). */
  setSpeed(rate: number): void;
  /** Seek to a fraction [0,1] of the tape (rings re-derive). */
  seek(frac: number): void;
  /** Live playback state for the bar (one REUSED object — read, don't
   * hold), or null when inactive. */
  state(): { t: number; duration: number; playing: boolean; speed: number } | null;
}

interface RingHandle {
  marker: ReplayMarker;
  mat: MeshBasicMaterial;
  mesh: Mesh;
  /** Playback time the ghost activated it (-1 = not yet). */
  litAt: number;
}

export class ReplayTheaterSystem extends createSystem({}, {}) {
  private phaseSig!: Signal<ShowPhaseValue>;
  private pathSig!: Signal<SegmentedPath>;
  private activeSig!: Signal<boolean>;

  private active = false;
  private replayT = 0;
  private track: ReplayTrack | null = null;
  private path!: SegmentedPath;
  private cursor = { i: 0 };
  private pose: ReplayPose = { along: 0, lateral: 0, pitchDeg: 0, speed: 0, dir: 1 };
  private worldPt: RoutePoint = { x: 0, z: 0, yaw: 0 };
  /** The VS BEST comparison tape + record (null = single-ghost replay). */
  private track2: ReplayTrack | null = null;
  private compareRecord: SessionRecord | null = null;
  private cursor2 = { i: 0 };
  private pose2: ReplayPose = { along: 0, lateral: 0, pitchDeg: 0, speed: 0, dir: 1 };
  private ghost2: Object3D | null = null;
  private ghostHead2: Object3D | null = null;
  private ghostYaw2 = 0;

  /** Availability cache (per record id — buildReplayTrack is O(samples)). */
  private availId: string | null = null;
  private availTrack: ReplayTrack | null = null;
  /** The phase the running replay started in ("idle" | "summary") — any
   * change away from it exits. */
  private startPhase: ShowPhaseValue = "summary";
  /** Player state (the web replay bar; XR keeps fire-and-watch). */
  private paused = false;
  private speed = 1;
  /** Real-time since entry — gates the any-input/Escape exits so the click
   * that STARTED the replay can't end it (independent of tape pause). */
  private armClock = 0;
  /** Coached moment (research finding 5): the ring being approached under
   * the auto half-speed ramp + the speed to restore after its beat. */
  private coachMarker: ReplayMarker | null = null;
  private coachRestoreSpeed: number | null = null;
  private stateOut: {
    t: number;
    duration: number;
    playing: boolean;
    speed: number;
    /** Along-track meters between the two ghosts in a comparison (the
     * SimulCam gap made a number), or null single-ghost. */
    gapM: number | null;
  } = { t: 0, duration: 0, playing: true, speed: 1, gapM: null };
  /** Live |along| separation of the two comparison ghosts. */
  private gapM: number | null = null;

  // Replay scene graph (created per replay, disposed on exit).
  private root: Entity | null = null;
  private ghost: Object3D | null = null;
  private ghostHead: Object3D | null = null;
  private ghostMats: ShaderMaterial[] = [];
  /** The hero + comparison figure materials (uniform follow targets). */
  private ghostMat: ShaderMaterial | null = null;
  private ghostMat2: ShaderMaterial | null = null;
  /** Trailing trajectory ECHOES — the same croquis re-rendered at PAST
   * transforms sampled from the recorded track (honest re-samples, nothing
   * invented). Speed-gated; browser 2, XR 1 (overdraw budget). */
  private echoes: Array<{
    group: Object3D;
    head: Object3D;
    mat: ShaderMaterial;
    cursor: { i: number };
    pose: ReplayPose;
    baseGain: number;
    gain: number;
    yaw: number;
    lastT: number;
  }> = [];
  /** Smoothed recorded speed (0..1, tau 0.4 s) feeding uSpeedNorm. */
  private speedNorm = 0;
  private speedNorm2 = 0;
  // The floor trace (slate wave 1): the recorded path as a strip that draws
  // in behind the ghost, amber where |lateral| crossed the LINE cue gate, a
  // dim center rail to compare against, and equal-TIME pace ticks.
  private traceMesh: Mesh | null = null;
  /** The vertical light fin riding the same path (grazing-angle presence). */
  private finMesh: Mesh | null = null;
  /** Per-SEGMENT tape end time (6 verts each — drawRange bookkeeping). */
  private traceTimes: number[] = [];
  private traceShown = 0;
  private tickMesh: Mesh | null = null;
  private tickTimes: number[] = [];
  private ticksShown = 0;
  private lastTapeT = 0;
  /** Eased 0..1 out-of-M8-band head-pitch warn (fast attack, slow release). */
  private headWarn = 0;
  /** Visual clock for the hologram scanline — drifts even while paused. */
  private visClock = 0;
  private rings: RingHandle[] = [];
  private ghostYaw = 0;

  // Browser rig ownership (demo-walk pattern).
  private ownsRig = false;
  private savedCamPos = new Vector3();
  private savedCamQuat = new Quaternion();
  private savedPlayerPos = new Vector3();
  private savedPlayerRotY = 0;
  private savedCamRotX = 0;
  private gazeYaw = 0;
  private gazePitch = 0;
  private gazeReady = false;
  private seatPos = new Vector3();
  private ghostWorld = new Vector3();

  /** Web keys (the player semantics, founder call 2026-07-23): Escape
   * exits, Space toggles pause. Other keys are ignored — the replay bar
   * owns the pointer, so "any input exits" is now an XR-only law. */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.active || this.armClock <= ARM_SEC) return;
    if (e.key === "Escape") {
      this.stopReplay();
    } else if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      this.paused = !this.paused;
    }
  };

  init(): void {
    const g = this.globals;
    this.phaseSig = g.showPhase as Signal<ShowPhaseValue>;
    this.pathSig = g.compiledPath as Signal<SegmentedPath>;
    this.activeSig = (g.replayActive as Signal<boolean>) ?? signal(false);
    g.replayActive = this.activeSig;

    const controls: ReplayControls = {
      available: () => this.replayable() !== null,
      availableFor: (id) => this.replayable(id) !== null,
      start: () => this.startReplay(),
      startFor: (id) => this.startReplay(id),
      stop: () => this.stopReplay(),
      compareAvailableFor: (id) => this.bestOther(id) !== null,
      startCompareFor: (id) => this.startReplay(id, this.bestOther(id) ?? undefined),
      pause: () => {
        this.paused = true;
      },
      resume: () => {
        this.paused = false;
      },
      restart: () => this.seekTo(0),
      setSpeed: (rate) => {
        // An EXPLICIT user speed always wins: cancel any coach ramp so it
        // never "restores" over the user's choice (research finding 2's
        // over-reliance lesson applies to control too — the trainee drives).
        this.coachMarker = null;
        this.coachRestoreSpeed = null;
        this.globals.replayCue = null;
        this.speed = Math.min(2, Math.max(0.25, rate));
      },
      seek: (frac) => {
        if (this.track) {
          this.seekTo(
            this.effDuration() * Math.min(1, Math.max(0, frac)),
          );
        }
      },
      state: () => {
        if (!this.active || !this.track) return null;
        this.stateOut.t = Math.min(this.replayT, this.effDuration());
        this.stateOut.duration = this.effDuration();
        this.stateOut.playing = !this.paused;
        this.stateOut.speed = this.speed;
        this.stateOut.gapM = this.gapM;
        return this.stateOut;
      },
    };
    g.replayControls = controls;
    this.cleanupFuncs.push(() => {
      if (g.replayControls === controls) g.replayControls = null;
    });

    // Any phase change away from where the replay STARTED (a new run, a
    // reset, a summary closing) ends it — history replays start at idle,
    // summary replays at summary.
    this.cleanupFuncs.push(
      this.phaseSig.subscribe((p) => {
        if (this.active && p !== this.startPhase) this.stopReplay();
      }),
    );
    // A remap mid-replay desyncs the snapshotted path from the stage — exit.
    this.cleanupFuncs.push(
      this.pathSig.subscribe(() => {
        if (this.active) this.stopReplay();
      }),
    );
    // Crossing into/out of XR changes who owns the rig — exit cleanly.
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe(() => {
        if (this.active) this.stopReplay();
      }),
    );
  }

  /** A record's replay track — the latest walk by default, or any FULL
   * record still in memory by id (the RUN HISTORY path). Null when not
   * replayable (no along channel / record evicted). Cached per record id. */
  private replayable(
    id?: string,
  ): { record: SessionRecord; track: ReplayTrack } | null {
    const recorder = this.globals.sessionRecorder as
      | SessionRecorder
      | undefined;
    if (!recorder) return null;
    const rec = id
      ? recorder.sessions.find((s) => s.id === id)
      : recorder.latest();
    if (!rec) return null;
    if (rec.id !== this.availId) {
      this.availId = rec.id;
      this.availTrack = buildReplayTrack(rec.samples);
    }
    return this.availTrack ? { record: rec, track: this.availTrack } : null;
  }

  /** The best-scoring OTHER replayable full record (the VS BEST partner) —
   * your own past attempts are inherently ability-matched (research
   * finding 4). Null when no second replayable walk is in memory. */
  private bestOther(id: string): string | null {
    const recorder = this.globals.sessionRecorder as
      | SessionRecorder
      | undefined;
    if (!recorder) return null;
    let best: SessionRecord | null = null;
    for (const s of recorder.sessions) {
      if (s.id === id) continue;
      if (typeof s.overall !== "number") continue;
      if (best !== null && s.overall <= (best.overall as number)) continue;
      // O(samples) scan, but only on the explicit compare paths (a click /
      // a card render), never per frame.
      if (buildReplayTrack(s.samples) === null) continue;
      best = s;
    }
    return best ? best.id : null;
  }

  private startReplay(id?: string, compareId?: string): boolean {
    if (this.active) return true;
    const phase = this.phaseSig.peek();
    // The summary pill replays the walk just scored; a history/compare
    // replay may also run from IDLE. Never mid-run.
    if (
      phase !== "summary" &&
      !(id !== undefined && phase === "idle")
    ) {
      return false;
    }
    const avail = this.replayable(id);
    if (!avail) return false;
    // The comparison tape (VS BEST): start-synchronized on the same runway.
    this.track2 = null;
    this.compareRecord = null;
    if (compareId !== undefined) {
      const cmp = this.replayable(compareId);
      // replayable() caches by id — re-prime the primary's cache entry.
      this.availId = null;
      if (cmp) {
        this.track2 = cmp.track;
        this.compareRecord = cmp.record;
      }
    }
    this.startPhase = phase;

    this.path = this.pathSig.peek();
    this.track = avail.track;
    this.replayT = 0;
    this.cursor.i = 0;
    this.pose.dir = 1;
    this.gazeReady = false;

    this.paused = false;
    this.speed = 1;
    this.armClock = 0;
    this.globals.replayRecap = null;
    this.gapM = null;
    this.buildScene(avail.record);
    this.placeViewer();

    window.addEventListener("keydown", this.onKeyDown, true);
    this.active = true;
    this.activeSig.value = true;
    return true;
  }

  /** Playback length: the LONGER of the two tapes in a comparison (the
   * shorter ghost holds its final pose while the other finishes). */
  private effDuration(): number {
    const a = this.track ? this.track.duration : 0;
    const b = this.track2 ? this.track2.duration : 0;
    return a > b ? a : b;
  }

  /** Jump the tape to `t` seconds: reset the interpolation cursor and
   * re-derive every ring's lit state from the new time (a ring whose moment
   * is already behind the tape head renders settled-dim, ahead re-arms). */
  private seekTo(t: number): void {
    if (!this.track) return;
    this.replayT = Math.min(Math.max(0, t), this.effDuration());
    this.cursor.i = 0;
    this.cursor2.i = 0;
    for (const e of this.echoes) {
      e.cursor.i = 0;
      e.lastT = 0;
    }
    // A seek abandons any in-flight coached moment (its ring re-derives).
    if (this.coachRestoreSpeed !== null) this.speed = this.coachRestoreSpeed;
    this.coachMarker = null;
    this.coachRestoreSpeed = null;
    this.globals.replayCue = null;
    for (const r of this.rings) {
      if (r.marker.t <= this.replayT) {
        r.litAt = this.replayT - RING_PULSE_SEC * 3; // settled, no re-pop
        r.mat.opacity = 0.34;
        r.mesh.scale.set(1, 1, 1);
      } else {
        r.litAt = -1;
        r.mat.opacity = 0.1;
        r.mesh.scale.set(1, 1, 1);
      }
    }
  }

  private stopReplay(): void {
    if (!this.active) return;
    this.active = false;
    // The next-walk recap (wave 2): one action line per moment kind, painted
    // on the summary card by landing once the theater goes dark.
    this.globals.replayRecap =
      this.rings.length > 0
        ? recapCues(this.rings.map((r) => r.marker))
        : null;
    this.globals.replayMoments = null;
    this.gapM = null;
    window.removeEventListener("keydown", this.onKeyDown, true);
    if (this.root) {
      this.root.dispose(); // frees the ghost/ring geometries + materials
      this.root = null;
    }
    this.ghost = null;
    this.ghostHead = null;
    this.ghostMats = [];
    this.ghostMat = null;
    this.ghostMat2 = null;
    this.echoes = [];
    this.traceMesh = null;
    this.finMesh = null;
    this.traceTimes = [];
    this.tickMesh = null;
    this.tickTimes = [];
    this.traceShown = 0;
    this.ticksShown = 0;
    this.lastTapeT = 0;
    this.headWarn = 0;
    this.ghost2 = null;
    this.ghostHead2 = null;
    this.track2 = null;
    this.compareRecord = null;
    this.globals.replayCompare = null;
    this.coachMarker = null;
    this.coachRestoreSpeed = null;
    this.globals.replayCue = null;
    this.rings = [];
    this.track = null;
    if (this.ownsRig) {
      this.ownsRig = false;
      this.camera.position.copy(this.savedCamPos);
      this.camera.quaternion.copy(this.savedCamQuat);
      this.player.position.copy(this.savedPlayerPos);
      this.player.rotation.y = this.savedPlayerRotY;
      this.setLocomotion(true);
    }
    this.activeSig.value = false;
  }

  /** Build the ghost + the marker rings under one disposable root. */
  private buildScene(record: SessionRecord): void {
    const root = this.world.createTransformEntity();
    root.object3D!.name = "replay-theater-root";
    this.root = root;
    const parent = root.object3D!;

    // -- The ghost: the LIGHT CROQUIS (docs/RESEARCH-ghost-visual.md) — one
    //    additive self-lit hologram figure, Carolina for the walk being
    //    replayed; the VS BEST comparison reuses the same builder in silver.
    const fig = buildGhostFigure(BRAND.accent, "replay-ghost", {
      disc: true,
      renderOrder: 3,
    });
    parent.add(fig.group);
    this.ghost = fig.group;
    this.ghostHead = fig.head;
    this.ghostMat = fig.mat;
    this.ghostMats = [fig.mat];

    // -- Trajectory echoes: literal re-samples of the measured track a few
    //    steps behind the hero (racing-ghost motion language, no limbs).
    //    Browser 2, XR 1 — the overdraw ledger; a third shell at 0.06 gain
    //    is invisible on the Quest LCD (verified finding).
    this.echoes = [];
    const echoCount =
      this.world.visibilityState.peek() === VisibilityState.NonImmersive
        ? 2
        : 1;
    const ECHO_GAINS = [0.4, 0.15];
    for (let k = 0; k < echoCount; k += 1) {
      const efig = buildGhostFigure(BRAND.accent, `replay-ghost-echo-${k}`, {
        gain: 0,
        echoPush: 0.015 * (k + 1),
        renderOrder: 2,
      });
      parent.add(efig.group);
      this.ghostMats.push(efig.mat);
      this.echoes.push({
        group: efig.group,
        head: efig.head,
        mat: efig.mat,
        cursor: { i: 0 },
        pose: { along: 0, lateral: 0, pitchDeg: 0, speed: 0, dir: 1 },
        baseGain: ECHO_GAINS[k],
        gain: 0,
        yaw: 0,
        lastT: 0,
      });
    }
    this.speedNorm = 0;
    this.speedNorm2 = 0;

    // VS BEST comparison ghost (SILVER, same hologram builder) — start-
    // synchronized on the same runway; rings stay PRIMARY-only (the
    // comparison is a reference line, not a critique target). Subordinate
    // by construction: 0.8 gain, no disc, no echoes — the trainee's blue
    // is always the hero, and their peaks never converge (blue-white vs
    // neutral rolloff).
    if (this.track2 !== null) {
      // Steel-silver, deliberately DIMMER than the hero on every axis (tint
      // luminance, gain, hotspot): a near-white tint at equal energy dumps
      // more light than saturated Carolina and steals the stage (caught in
      // the v4 verify shots).
      const fig2 = buildGhostFigure(0x8f96a3, "replay-ghost-compare", {
        gain: 0.55,
        headHot: 0.7,
        renderOrder: 3,
      });
      parent.add(fig2.group);
      this.ghost2 = fig2.group;
      this.ghostHead2 = fig2.head;
      this.ghostMat2 = fig2.mat;
      this.ghostMats.push(fig2.mat);
      this.cursor2.i = 0;
      this.pose2.dir = 1;
      // Legend facts for the DOM chip (plain ref; landing paints it).
      this.globals.replayCompare = {
        a: record.overall,
        b: this.compareRecord ? this.compareRecord.overall : null,
      };
    } else {
      this.globals.replayCompare = null;
    }

    // -- Marker rings: one per coaching moment, dim until the ghost passes.
    const idealPace = record.stats ? record.stats.idealPaceMps : null;
    const markers = replayMarkers(
      record.samples,
      idealPace,
      record.turn ? record.turn.startAtSec : null,
    );
    this.rings = [];
    for (const m of markers) {
      const geom = new RingGeometry(0.17, 0.24, 28);
      geom.rotateX(-Math.PI / 2);
      const mat = new MeshBasicMaterial({
        color: REPLAY_MARKER_COLORS[m.kind] ?? BRAND.accent,
        transparent: true,
        opacity: 0.1,
        blending: AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new Mesh(geom, mat);
      const w = routeToWorld(this.path, clampAlong(this.path, m.along), m.lateral, this.worldPt);
      mesh.position.set(w.x, STAGE.deckHeight + 0.006, w.z);
      parent.add(mesh);
      this.rings.push({ marker: m, mat, mesh, litAt: -1 });
    }

    this.buildTrace(parent);

    // The bar's moment dots (wave 2): time + kind only, painted by landing.
    this.globals.replayMoments = markers.map((m) => ({ t: m.t, kind: m.kind }));
  }

  /** The floor trace set (wave 1): recorded-path strip (progressive, amber
   * over the cue gate) + a dim always-on center rail + pace ticks (equal
   * tape time — spacing IS speed). All one additive vertex-colored material
   * family; thin strips, negligible overdraw. */
  private buildTrace(parent: Object3D): void {
    if (!this.track) return;
    const acc = new Color(BRAND.accent);
    const yTrace = STAGE.deckHeight + 0.004;
    const makeMesh = (
      pos: number[],
      col: number[],
      name: string,
      progressive: boolean,
    ): Mesh => {
      const geom = new BufferGeometry();
      geom.setAttribute("position", new Float32BufferAttribute(pos, 3));
      geom.setAttribute("color", new Float32BufferAttribute(col, 3));
      if (progressive) geom.setDrawRange(0, 0);
      const mesh = new Mesh(
        geom,
        new MeshBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.9,
          blending: AdditiveBlending,
          depthWrite: false,
          // The strip quads wind face-DOWN from the push order (caught by
          // the isolate probe: same material rendered on a face-up test
          // quad, never on the strip) — DoubleSide instead of re-winding,
          // thin strips make the extra face cost negligible.
          side: DoubleSide,
        }),
      );
      mesh.name = name;
      mesh.renderOrder = 1;
      parent.add(mesh);
      return mesh;
    };

    // -- the walked line: a LIGHT RAIL, not a stripe (founder 2026-07-27:
    //    "tactile... not flat images"). A gaussian-core floor ribbon + a
    //    small vertical FIN along the same path — a flat floor line vanishes
    //    at grazing seat-level angles, the fin reads from everywhere. Energy
    //    pulses travel the path in RECORDED time order (aT attribute).
    const tps = traceFromTrack(this.track);
    const ws = tps.map((tp) => {
      const w = routeToWorld(
        this.path,
        clampAlong(this.path, tp.along),
        tp.lateral,
        this.worldPt,
      );
      return { x: w.x, z: w.z, warn: tp.warn, t: tp.t };
    });
    const HALF = 0.03;
    const FIN_H = 0.035;
    const ribPos: number[] = [];
    const ribUv: number[] = [];
    const ribT: number[] = [];
    const ribWarn: number[] = [];
    const finPos: number[] = [];
    const finUv: number[] = [];
    const finT: number[] = [];
    const finWarn: number[] = [];
    this.traceTimes = [];
    let px = 1;
    let pz = 0;
    for (let i = 0; i + 1 < ws.length; i += 1) {
      const a = ws[i];
      const b = ws[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len > 1e-5) {
        px = -dz / len;
        pz = dx / len;
      }
      // ribbon quad (uv.x across 0..1)
      const rib = [
        [a.x + px * HALF, a.z + pz * HALF, 0, a.t, a.warn],
        [a.x - px * HALF, a.z - pz * HALF, 1, a.t, a.warn],
        [b.x + px * HALF, b.z + pz * HALF, 0, b.t, b.warn],
        [b.x + px * HALF, b.z + pz * HALF, 0, b.t, b.warn],
        [a.x - px * HALF, a.z - pz * HALF, 1, a.t, a.warn],
        [b.x - px * HALF, b.z - pz * HALF, 1, b.t, b.warn],
      ] as const;
      for (const [vx, vz, u, vt, warn] of rib) {
        ribPos.push(vx, yTrace, vz);
        ribUv.push(u, 0);
        ribT.push(vt);
        ribWarn.push(warn ? 1 : 0);
      }
      // fin quad (uv.y up 0..1)
      const fin = [
        [a.x, a.z, yTrace, 0, a.t, a.warn],
        [b.x, b.z, yTrace, 0, b.t, b.warn],
        [a.x, a.z, yTrace + FIN_H, 1, a.t, a.warn],
        [a.x, a.z, yTrace + FIN_H, 1, a.t, a.warn],
        [b.x, b.z, yTrace, 0, b.t, b.warn],
        [b.x, b.z, yTrace + FIN_H, 1, b.t, b.warn],
      ] as const;
      for (const [vx, vz, vy, v, vt, warn] of fin) {
        finPos.push(vx, vy, vz);
        finUv.push(0, v);
        finT.push(vt);
        finWarn.push(warn ? 1 : 0);
      }
      this.traceTimes.push(b.t);
    }
    const buildRail = (
      pos: number[],
      uvA: number[],
      tA: number[],
      warnA: number[],
      kind: 0 | 1,
      name: string,
    ): Mesh => {
      const geom = new BufferGeometry();
      geom.setAttribute("position", new Float32BufferAttribute(pos, 3));
      geom.setAttribute("uv", new Float32BufferAttribute(uvA, 2));
      geom.setAttribute("aT", new Float32BufferAttribute(tA, 1));
      geom.setAttribute("aWarn", new Float32BufferAttribute(warnA, 1));
      geom.setDrawRange(0, 0);
      const mat = createTraceMaterial(kind, BRAND.accent);
      const mesh = new Mesh(geom, mat);
      mesh.name = name;
      mesh.renderOrder = 1;
      parent.add(mesh);
      this.ghostMats.push(mat); // rides the theater's visual clock (uTime)
      return mesh;
    };
    this.traceMesh = buildRail(ribPos, ribUv, ribT, ribWarn, 0, "replay-trace");
    this.finMesh = buildRail(finPos, finUv, finT, finWarn, 1, "replay-trace-fin");
    this.traceShown = 0;

    // -- the center rail (lateral 0 over the walked along-range, dim, always
    //    fully visible — the standard the trace is read against) -----------
    let alongMin = Infinity;
    let alongMax = -Infinity;
    for (const tp of tps) {
      if (tp.along < alongMin) alongMin = tp.along;
      if (tp.along > alongMax) alongMax = tp.along;
    }
    const railPos: number[] = [];
    const railCol: number[] = [];
    const RAIL_HALF = 0.008;
    const railPush = (x: number, z: number): void => {
      railPos.push(x, STAGE.deckHeight + 0.003, z);
      railCol.push(acc.r * 0.32, acc.g * 0.32, acc.b * 0.32);
    };
    const steps = Math.max(2, Math.ceil((alongMax - alongMin) / 0.5));
    let rpx = 1;
    let rpz = 0;
    for (let i = 0; i < steps; i += 1) {
      const a0 = alongMin + ((alongMax - alongMin) * i) / steps;
      const a1 = alongMin + ((alongMax - alongMin) * (i + 1)) / steps;
      const w0 = routeToWorld(this.path, clampAlong(this.path, a0), 0, this.worldPt);
      const x0 = w0.x;
      const z0 = w0.z;
      const w1 = routeToWorld(this.path, clampAlong(this.path, a1), 0, this.worldPt);
      const dx = w1.x - x0;
      const dz = w1.z - z0;
      const len = Math.hypot(dx, dz);
      if (len > 1e-5) {
        rpx = -dz / len;
        rpz = dx / len;
      }
      railPush(x0 + rpx * RAIL_HALF, z0 + rpz * RAIL_HALF);
      railPush(x0 - rpx * RAIL_HALF, z0 - rpz * RAIL_HALF);
      railPush(w1.x + rpx * RAIL_HALF, w1.z + rpz * RAIL_HALF);
      railPush(w1.x + rpx * RAIL_HALF, w1.z + rpz * RAIL_HALF);
      railPush(x0 - rpx * RAIL_HALF, z0 - rpz * RAIL_HALF);
      railPush(w1.x - rpx * RAIL_HALF, w1.z - rpz * RAIL_HALF);
    }
    makeMesh(railPos, railCol, "replay-trace-rail", false);

    // -- pace BEAT GEMS (equal tape time): crossed vertical glow quads that
    //    read from every angle — bunched gems = slow stretch, stretched =
    //    rushing. 12 verts per gem (2 crossed quads).
    const ticks = traceTicks(this.track);
    const gemPos: number[] = [];
    const gemUv: number[] = [];
    this.tickTimes = [];
    const GEM_W = 0.055;
    const GEM_H = 0.05;
    for (const tk of ticks) {
      const w0 = routeToWorld(
        this.path,
        clampAlong(this.path, tk.along),
        tk.lateral,
        this.worldPt,
      );
      const cx = w0.x;
      const cz = w0.z;
      const quad = (ax: number, az: number): void => {
        const x0 = cx - ax * GEM_W * 0.5;
        const z0 = cz - az * GEM_W * 0.5;
        const x1 = cx + ax * GEM_W * 0.5;
        const z1 = cz + az * GEM_W * 0.5;
        const yB = STAGE.deckHeight + 0.002;
        const yT = yB + GEM_H;
        gemPos.push(x0, yB, z0, x1, yB, z1, x0, yT, z0);
        gemUv.push(0, 0, 1, 0, 0, 1);
        gemPos.push(x0, yT, z0, x1, yB, z1, x1, yT, z1);
        gemUv.push(0, 1, 1, 0, 1, 1);
      };
      quad(1, 0);
      quad(0, 1);
      this.tickTimes.push(tk.t);
    }
    {
      const geom = new BufferGeometry();
      geom.setAttribute("position", new Float32BufferAttribute(gemPos, 3));
      geom.setAttribute("uv", new Float32BufferAttribute(gemUv, 2));
      geom.setDrawRange(0, 0);
      const mat = createBeatGemMaterial(0xcfe4f5);
      const mesh = new Mesh(geom, mat);
      mesh.name = "replay-trace-ticks";
      mesh.renderOrder = 1;
      parent.add(mesh);
      this.ghostMats.push(mat);
      this.tickMesh = mesh;
    }
    this.ticksShown = 0;
    this.lastTapeT = 0;
  }

  /** Seat the browser viewer front-row; XR viewers stay where they stand. */
  private placeViewer(): void {
    if (this.world.visibilityState.peek() !== VisibilityState.NonImmersive) {
      this.ownsRig = false;
      return;
    }
    const spine = this.path.segments[0].rect;
    const c = Math.cos(spine.yaw);
    const s = Math.sin(spine.yaw);
    const frontRow = this.globals.audienceFrontRowLocal as
      | Array<{ x: number; y: number; z: number; yaw: number }>
      | null
      | undefined;
    if (Array.isArray(frontRow) && frontRow.length > 0) {
      // The stage's own finale front row (spine-local → world via the spine
      // placement, the stage-root transform). Prefer the seat FARTHEST from
      // the pose mark — the band's edge gives an angled view of the whole
      // walk instead of a lens-filling head-on pass.
      const pose = routeToWorld(
        this.path,
        this.path.poseRouteAlong,
        0,
        this.worldPt,
      );
      let best = frontRow[0];
      let bestD = -1;
      let bx = 0;
      let bz = 0;
      for (const seat of frontRow) {
        const wx = spine.centerX + seat.x * c + seat.z * s;
        const wz = spine.centerZ - seat.x * s + seat.z * c;
        const d = (wx - pose.x) ** 2 + (wz - pose.z) ** 2;
        if (d > bestD) {
          bestD = d;
          best = seat;
          bx = wx;
          bz = wz;
        }
      }
      this.seatPos.set(bx, best.y, bz);
    } else {
      // No exported finale row (crowd hidden, or the photographer pit owns
      // the end-cap and no finale seat placed) — a computed SIDE front-row
      // seat beside the pose mark, at the tier-1 riser height. Head-on past
      // the end would sit inside the pit.
      // On the APRON: between the deck edge and the first row (tier 1 sits
      // ~0.55 m outside the outline; the pit stands past the end) — a clear
      // sight line to the whole walk, nobody's head in the shot.
      const side = routeToWorld(
        this.path,
        Math.max(0, this.path.poseRouteAlong - 2.4),
        spine.width / 2 + 0.45,
        this.worldPt,
      );
      this.seatPos.set(side.x, 0.34, side.z);
    }

    this.savedCamPos.copy(this.camera.position);
    this.savedCamQuat.copy(this.camera.quaternion);
    this.savedPlayerPos.copy(this.player.position);
    this.savedPlayerRotY = this.player.rotation.y;
    this.savedCamRotX = this.camera.rotation.x;
    this.setLocomotion(false);
    this.ownsRig = true;
    this.player.position.copy(this.seatPos);
    this.camera.position.set(0, SEAT_EYE, 0);
    this.camera.rotation.set(0, 0, 0);
  }

  /** Demo-walk's class-reference locomotion pause (minification-immune). */
  private setLocomotion(run: boolean): void {
    const systems = [
      this.world.getSystem(LocomotionSystem),
      this.world.getSystem(SlideSystem),
      this.world.getSystem(TurnSystem),
      this.world.getSystem(TeleportSystem),
    ];
    for (const sys of systems) {
      if (!sys) continue;
      if (run) sys.play();
      else sys.stop();
    }
  }

  /** True when any XR controller input fired this frame (exit gesture). */
  private xrInputFired(): boolean {
    const pads = [this.input.xr.gamepads.left, this.input.xr.gamepads.right];
    for (const pad of pads) {
      if (!pad) continue;
      if (
        pad.getButtonDown(InputComponent.Trigger) ||
        pad.getButtonDown(InputComponent.Squeeze) ||
        pad.getButtonDown(InputComponent.A_Button) ||
        pad.getButtonDown(InputComponent.B_Button) ||
        pad.getButtonDown(InputComponent.X_Button) ||
        pad.getButtonDown(InputComponent.Y_Button)
      ) {
        return true;
      }
      const axes = pad.getAxesValues(InputComponent.Thumbstick);
      if (axes && Math.hypot(axes.x, axes.y) > 0.6) return true;
    }
    return false;
  }

  update(delta: number): void {
    if (!this.active || !this.track || !this.ghost) return;

    // Player transport: paused freezes the TAPE; the arm clock runs on real
    // time regardless, so a fresh replay can never wedge un-exitable. The
    // hologram's scanline drifts on its own visual clock either way.
    this.armClock += delta;
    this.visClock += delta;
    for (const m of this.ghostMats) {
      m.uniforms.uTime.value = this.visClock;
    }
    this.replayT += this.paused ? 0 : delta * this.speed;
    if (this.armClock > ARM_SEC && this.xrInputFired()) {
      this.stopReplay();
      return;
    }
    // Playback ends a beat after the last sample — hold the final pose, then
    // exit back to the summary card. A PAUSED tape never auto-exits.
    if (!this.paused && this.replayT > this.effDuration() + 1.2) {
      this.stopReplay();
      return;
    }

    const t = Math.min(this.replayT, this.track.duration);
    const p = trackPoseAt(this.track, t, this.cursor, this.pose);
    const w = routeToWorld(
      this.path,
      clampAlong(this.path, p.along),
      p.lateral,
      this.worldPt,
    );
    const moving = p.speed > 0.15;
    const bob = moving
      ? GHOST_BOB_AMP * Math.abs(Math.sin(Math.PI * GHOST_STEP_HZ * t))
      : 0;
    this.ghost.position.set(w.x, STAGE.deckHeight + bob, w.z);
    // Face the direction of travel (route heading, flipped on the return
    // leg), eased shortest-angle so the 180 reads as a turn, not a snap.
    const targetYaw = w.yaw + (p.dir < 0 ? Math.PI : 0);
    if (this.replayT <= delta + 1e-6) this.ghostYaw = targetYaw;
    let dy = targetYaw - this.ghostYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.ghostYaw += dy * (1 - Math.exp(-6 * delta));
    this.ghost.rotation.y = this.ghostYaw;
    // The recorded head-pitch deviation tilts the ghost's head (a head-drop
    // moment reads as the chin dipping).
    if (this.ghostHead) {
      // pitchDeg + = above neutral; rotation.x + = tilt up (camera-forward
      // convention, and the ghost is yawed with the same forward). Halved —
      // a hint of the motion, not a literal skeleton.
      this.ghostHead.rotation.x = (p.pitchDeg * Math.PI) / 180 / 2.2;
    }
    // Hologram follow uniforms: hem height (deck + bob), the measured head
    // center (a yaw about y never moves the (0, headY, 0) local point), and
    // the smoothed recorded speed feeding the luminance gain.
    this.speedNorm +=
      (Math.min(1, p.speed / 1.2) - this.speedNorm) *
      (1 - Math.exp(-delta / 0.4));
    if (this.ghostMat) {
      this.ghostMat.uniforms.uBaseY.value = STAGE.deckHeight + bob;
      (this.ghostMat.uniforms.uHeadCenter.value as Vector3).set(
        w.x,
        STAGE.deckHeight + bob + GHOST_HEAD_Y,
        w.z,
      );
      this.ghostMat.uniforms.uSpeedNorm.value = this.speedNorm;
      // CARRIAGE amber (wave 1): the RECORDED pitch outside the M8 band
      // warms the head glow — fast attack, slow release (coaching, not a
      // strobe). Hero only; the comparison stays neutral.
      const warnTarget = Math.min(
        1,
        Math.max(0, (Math.abs(p.pitchDeg) - M8_PITCH_BAND_DEG) / 8),
      );
      const warnTau = warnTarget > this.headWarn ? 0.12 : 0.45;
      this.headWarn +=
        (warnTarget - this.headWarn) * (1 - Math.exp(-delta / warnTau));
      this.ghostMat.uniforms.uHeadWarn.value = this.headWarn;
    }

    // Floor trace + pace ticks draw in behind the tape head (seek-safe: a
    // backward jump resets the reveal cursors).
    if (t < this.lastTapeT) {
      this.traceShown = 0;
      this.ticksShown = 0;
    }
    this.lastTapeT = t;
    while (
      this.traceShown < this.traceTimes.length &&
      this.traceTimes[this.traceShown] <= t
    ) {
      this.traceShown += 1;
    }
    if (this.traceMesh) this.traceMesh.geometry.setDrawRange(0, this.traceShown * 6);
    if (this.finMesh) this.finMesh.geometry.setDrawRange(0, this.traceShown * 6);
    while (
      this.ticksShown < this.tickTimes.length &&
      this.tickTimes[this.ticksShown] <= t
    ) {
      this.ticksShown += 1;
    }
    if (this.tickMesh) this.tickMesh.geometry.setDrawRange(0, this.ticksShown * 12);

    // Trajectory echoes: each shell rides the SAME tape a fixed along-track
    // DISTANCE behind (0.35 m per shell — fixed-time echoes hide inside the
    // hero at walk pace), speed-gated with a 0.3 s fade so nothing pops at
    // walk start/stop. A cursor only ever scans forward — reset it when the
    // offset time regresses (speed changes shrink the gap).
    for (let k = 0; k < this.echoes.length; k += 1) {
      const e = this.echoes[k];
      const off =
        Math.min(0.5, Math.max(0.15, 0.35 / Math.max(p.speed, 0.2))) * (k + 1);
      const te = Math.max(0, t - off);
      if (te < e.lastT) e.cursor.i = 0;
      e.lastT = te;
      const pe = trackPoseAt(this.track, te, e.cursor, e.pose);
      const we = routeToWorld(
        this.path,
        clampAlong(this.path, pe.along),
        pe.lateral,
        this.worldPt,
      );
      const bobE =
        pe.speed > 0.15
          ? GHOST_BOB_AMP * Math.abs(Math.sin(Math.PI * GHOST_STEP_HZ * te))
          : 0;
      e.group.position.set(we.x, STAGE.deckHeight + bobE, we.z);
      const targetYawE = we.yaw + (pe.dir < 0 ? Math.PI : 0);
      if (this.replayT <= delta + 1e-6) e.yaw = targetYawE;
      let dyE = targetYawE - e.yaw;
      dyE = Math.atan2(Math.sin(dyE), Math.cos(dyE));
      e.yaw += dyE * (1 - Math.exp(-6 * delta));
      e.group.rotation.y = e.yaw;
      e.head.rotation.x = (pe.pitchDeg * Math.PI) / 180 / 2.2;
      const gainTarget = p.speed > 0.4 ? e.baseGain : 0;
      e.gain += (gainTarget - e.gain) * (1 - Math.exp(-delta / 0.3));
      e.mat.uniforms.uGhostGain.value = e.gain;
      e.mat.uniforms.uBaseY.value = STAGE.deckHeight + bobE;
      (e.mat.uniforms.uHeadCenter.value as Vector3).set(
        we.x,
        STAGE.deckHeight + bobE + GHOST_HEAD_Y,
        we.z,
      );
      e.mat.uniforms.uSpeedNorm.value = this.speedNorm;
    }

    // The VS BEST comparison ghost: SAME clock, its own tape — start-
    // synchronized, so the growing gap between the figures IS the pace
    // difference and the lateral spread IS the line difference. Holds its
    // final pose once its (possibly shorter) tape ends.
    if (this.ghost2 && this.track2) {
      const t2 = Math.min(this.replayT, this.track2.duration);
      const p2 = trackPoseAt(this.track2, t2, this.cursor2, this.pose2);
      const w2 = routeToWorld(
        this.path,
        clampAlong(this.path, p2.along),
        p2.lateral,
        this.worldPt,
      );
      const moving2 = p2.speed > 0.15 && t2 < this.track2.duration;
      const bob2 = moving2
        ? GHOST_BOB_AMP * Math.abs(Math.sin(Math.PI * GHOST_STEP_HZ * t2))
        : 0;
      this.ghost2.position.set(w2.x, STAGE.deckHeight + bob2, w2.z);
      const targetYaw2 = w2.yaw + (p2.dir < 0 ? Math.PI : 0);
      if (this.replayT <= delta + 1e-6) this.ghostYaw2 = targetYaw2;
      let dy2g = targetYaw2 - this.ghostYaw2;
      dy2g = Math.atan2(Math.sin(dy2g), Math.cos(dy2g));
      this.ghostYaw2 += dy2g * (1 - Math.exp(-6 * delta));
      this.ghost2.rotation.y = this.ghostYaw2;
      if (this.ghostHead2) {
        this.ghostHead2.rotation.x = (p2.pitchDeg * Math.PI) / 180 / 2.2;
      }
      this.gapM = Math.abs(p.along - p2.along);
      this.speedNorm2 +=
        (Math.min(1, p2.speed / 1.2) - this.speedNorm2) *
        (1 - Math.exp(-delta / 0.4));
      if (this.ghostMat2) {
        this.ghostMat2.uniforms.uBaseY.value = STAGE.deckHeight + bob2;
        (this.ghostMat2.uniforms.uHeadCenter.value as Vector3).set(
          w2.x,
          STAGE.deckHeight + bob2 + GHOST_HEAD_Y,
          w2.z,
        );
        this.ghostMat2.uniforms.uSpeedNorm.value = this.speedNorm2;
      }
    }

    // Coached moments (finding 5): approaching an un-lit ring at normal
    // speed auto-ramps to half speed + one what-to-watch line; restores the
    // user's speed a beat after the moment. An explicit speed press cancels.
    if (this.coachMarker === null) {
      if (!this.paused && this.speed === 1) {
        for (const r of this.rings) {
          if (r.litAt >= 0) continue;
          const lead = r.marker.t - t;
          if (lead >= 0 && lead <= REPLAY_COACH_LEAD_SEC) {
            this.coachMarker = r.marker;
            this.coachRestoreSpeed = this.speed;
            this.speed = 0.5;
            this.globals.replayCue = {
              kind: r.marker.kind,
              text: REPLAY_CUE_TEXT[r.marker.kind],
              // The measured value vs the engine's own bar (wave 2 - the
              // standard, not just the miss).
              detail: markerDetail(r.marker),
            };
            break;
          }
        }
      }
    } else if (t > this.coachMarker.t + REPLAY_COACH_HOLD_SEC) {
      if (this.coachRestoreSpeed !== null) this.speed = this.coachRestoreSpeed;
      this.coachMarker = null;
      this.coachRestoreSpeed = null;
      this.globals.replayCue = null;
    }

    // Marker rings: light as the ghost passes each moment, pulse, settle dim.
    for (const r of this.rings) {
      if (r.litAt < 0 && t >= r.marker.t) r.litAt = this.replayT;
      if (r.litAt >= 0) {
        const dt = this.replayT - r.litAt;
        const pulse = Math.exp(-dt / (RING_PULSE_SEC / 3));
        r.mat.opacity = 0.34 + 0.55 * pulse;
        const sc = 1 + 0.5 * pulse;
        r.mesh.scale.set(sc, 1, sc);
      }
    }

    // Front-row gaze (browser only): ease the seat's look-at onto the ghost.
    if (this.ownsRig) {
      this.ghostWorld.set(w.x, STAGE.deckHeight + 1.35, w.z);
      const dx = this.ghostWorld.x - this.seatPos.x;
      const dz = this.ghostWorld.z - this.seatPos.z;
      const dy2 = this.ghostWorld.y - (this.seatPos.y + SEAT_EYE);
      // Player forward at yaw y is (-sin y, -cos y) — face (dx, dz).
      const targetGazeYaw = Math.atan2(-dx, -dz);
      const targetGazePitch = Math.atan2(dy2, Math.hypot(dx, dz));
      if (!this.gazeReady) {
        this.gazeYaw = targetGazeYaw;
        this.gazePitch = targetGazePitch;
        this.gazeReady = true;
      } else {
        let gy = targetGazeYaw - this.gazeYaw;
        gy = Math.atan2(Math.sin(gy), Math.cos(gy));
        const k = 1 - Math.exp(-GAZE_RATE * delta);
        this.gazeYaw += gy * k;
        this.gazePitch += (targetGazePitch - this.gazePitch) * k;
      }
      this.player.rotation.y = this.gazeYaw;
      this.camera.rotation.set(this.gazePitch, 0, 0);
    }
  }
}

/** Keep a recorded along on today's route (a post-walk length edit can leave
 * the tail past the current end). */
function clampAlong(path: SegmentedPath, along: number): number {
  return along < 0 ? 0 : along > path.totalAlong ? path.totalAlong : along;
}

/** The ghost silhouette PROFILE (radius, height in meters) — the LIGHT
 * CROQUIS (docs/RESEARCH-ghost-visual.md, 2026-07-27): a ~1.80 m 9-head
 * EDITORIAL figure, widest radius <= ~12% of height (the rejected v2 hem
 * was 0.315 on 1.7 m — a squat pawn). Gown hem touches the deck (the light
 * dissolves there, the geometry never floats), sweeping up through high
 * hip, waist, bust and shoulder into a long neck. Rotationally symmetric
 * by construction (LatheGeometry) — deliberately abstract, NO limbs or
 * gait (the methodology honesty boundary), but unmistakably a figure. */
const GHOST_PROFILE: ReadonlyArray<[number, number]> = [
  [0.001, 0.0], // hem touches the deck — the light dissolve grounds it
  [0.215, 0.02], // gown hem flare
  [0.19, 0.35], // skirt
  [0.145, 0.75], // lower gown taper
  [0.105, 0.98], // high hip
  [0.088, 1.12], // waist
  [0.125, 1.32], // bust
  [0.155, 1.45], // shoulder half-width
  [0.06, 1.52], // neck base
  [0.045, 1.575], // neck top
];

/** The measured head oval's local center height (crown ~1.80 m). Also the
 * offset behind uHeadCenter — the hologram's honesty hotspot. */
const GHOST_HEAD_Y = 1.69;

interface GhostFigureOpts {
  /** Overall luminance gain (hero 1, silver 0.8, echo shells lower). */
  gain?: number;
  /** Head-hotspot gain (hero 1.6, silver 1.2). */
  headHot?: number;
  /** Echo-shell normal inflation (m) so a trailing rim peeks out. */
  echoPush?: number;
  /** Floor glow disc — hero only (echoes/silver skip it: budget + it would
   * read as extra ghosts). */
  disc?: boolean;
  /** Explicit renderOrder for the figure meshes (disc < echoes < hero — all
   * are depthWrite-off transparents; center-sorting would flip per frame). */
  renderOrder: number;
}

/** One ghost figure: the lathe croquis + a separately-pitchable head oval
 * sharing ONE additive hologram material, plus (hero only) a floor glow
 * disc. One translucent pass per mesh — the Meta overdraw law. `mat` is
 * returned so update() can follow the figure with uTime/uBaseY/uHeadCenter/
 * uSpeedNorm/uGhostGain. */
function buildGhostFigure(
  tintHex: number,
  name: string,
  opts: GhostFigureOpts,
): { group: Object3D; head: Object3D; mat: ShaderMaterial } {
  const group = new Object3D();
  group.name = name;
  const holo = createHologramMaterial(tintHex, {
    gain: opts.gain,
    headHot: opts.headHot,
    echoPush: opts.echoPush,
  });
  const profile = GHOST_PROFILE.map(([r, y]) => new Vector2(r, y));
  const body = new Mesh(new LatheGeometry(profile, 48), holo);
  body.renderOrder = opts.renderOrder;
  const head = new Mesh(new SphereGeometry(0.1, 20, 14), holo);
  head.position.y = GHOST_HEAD_Y;
  head.scale.set(0.85, 1.15, 0.9); // 0.085 x 0.115 x 0.090 oval — editorial
  head.renderOrder = opts.renderOrder;
  group.add(body, head);
  if (opts.disc) {
    // Retuned to the slim hem (r 0.25 vs the 0.215 hem, opacity up) so there
    // is no dark ring between the hem light-dissolve and the floor glow.
    const glowGeom = new CircleGeometry(0.25, 24);
    glowGeom.rotateX(-Math.PI / 2);
    const glow = new Mesh(
      glowGeom,
      new MeshBasicMaterial({
        color: tintHex,
        transparent: true,
        opacity: 0.28,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    glow.position.y = 0.012;
    glow.renderOrder = 1;
    group.add(glow);
  }
  return { group, head, mat: holo };
}
