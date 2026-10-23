import {
  DomeGradient,
  IBLGradient,
  Interactable,
  LocomotionEnvironment,
  Mesh,
  MeshBasicMaterial,
  PanelUI,
  PlaneGeometry,
  SessionMode,
  VisibilityState,
  World,
} from "@iwsdk/core";
import { computed, signal, type Signal } from "@preact/signals-core";

import { BeatHapticsSystem } from "./beat-haptics.js";
import { loadBeatPrefs, saveBeatPrefs, type BeatPrefs } from "./beat-prefs.js";
import { loadFitBaseline, type BodyBaseline } from "./body-baseline.js";
import { CoachLiveSystem } from "./coach-live-system.js";
import {
  loadCoachPrefs,
  saveCoachPrefs,
  type CoachPrefs,
} from "./coach-prefs.js";
import { DemoWalkSystem } from "./demo-walk.js";
import { ReplayTheaterSystem } from "./replay-theater.js";
import { CrowdGazeSystem } from "./crowd-gaze.js";
import { JudgesPaddlesSystem } from "./judges-paddles.js";
import { HouseReactsSystem } from "./house-reacts.js";
import type { FitFlowState } from "./fit-session.js";
import { FitSessionSystem } from "./fit-session-system.js";
import { installEnvironment } from "./environment.js";
import { installExternalTracker } from "./external-tracker.js";
import { FloorRippleSystem } from "./floor-ripple.js";
import { installFreeLook } from "./freelook.js";
import { connectPoseRelay } from "./pose-ingest.js";
import { installSessionRecorder } from "./session-recorder.js";
import { mountLanding } from "./landing.js";
import { HUDSystem } from "./hud.js";
import type { FitStatus, MapNotice } from "./hud-copy.js";
import { MappingSystem, type MapMode } from "./mapping.js";
import { MetricsSystem } from "./metrics.js";
import { loadMode, type TrainingMode } from "./modes.js";
import { loadMusicPrefs, saveMusicPrefs, type MusicPrefs } from "./music-prefs.js";
import {
  loadMusicSource,
  saveMusicSource,
  type MusicSourcePrefs,
} from "./music-source.js";
import { loadPacePrefs, savePacePrefs, type PacePrefs } from "./pace-prefs.js";
import { loadWalkPrefs, saveWalkPrefs, type WalkPrefs } from "./walk-prefs.js";
import { MusicSystem } from "./music.js";
import { loadScene, type PassthroughScene } from "./scenes.js";
import { SfxSystem } from "./sfx.js";
import { loadUser, type UserPrefs } from "./user-prefs.js";
import {
  alongLateralToWorld,
  startAlong,
  type RunwayLayout,
  type RunwayPoint,
} from "./runway-layout.js";
import {
  compileShape,
  loadShape,
  SavedRunwaysStore,
  saveShape,
  type RunwayShape,
  type SegmentedPath,
} from "./runway-shape.js";
import { ShaderTimeSystem } from "./shaders.js";
import type { MetricSnapshot, ShowPhaseValue, ShowSummary } from "./show.js";
import { ShowDirectorSystem } from "./show.js";
import {
  loadAudienceModels,
  loadPitModels,
  type AudienceModel,
} from "./audience-assets.js";
import {
  createStage,
  FootprintGlowSystem,
  MapPreviewSystem,
  StageMoodSystem,
} from "./stage.js";

World.create(document.getElementById("scene-container") as HTMLDivElement, {
  xr: {
    sessionMode: SessionMode.ImmersiveAR,
    offer: "always",
    // REV3: plane detection is now CONSUMED by the runway auto-map (fit to the
    // real floor), so the Quest spatial-data prompt is justified. handTracking +
    // layers stay; we still don't request anchors/mesh/hit-test we don't use,
    // except hitTest which backs the floor reticle on devices that need it.
    features: {
      handTracking: true,
      layers: true,
      planeDetection: true,
      hitTest: true,
    },
  },
  features: {
    // Locomotion: thumbstick in XR (move, don't just look) + WASD/gamepad in the
    // browser. Camera look stays app-owned (mouse-look wired in installFreeLook).
    // Needs a LocomotionEnvironment to stand on (added below).
    locomotion: {
      browserControls: { keyboard: true, gamepad: true },
      enableJumping: false,
    },
    grabbing: false,
    physics: false,
    // Scene understanding spawns the XRPlane entities the auto-map reads.
    sceneUnderstanding: true,
    environmentRaycast: false,
  },
  render: {
    defaultLighting: false,
  },
}).then((world) => {
  // Global show state — must exist before any system registers (systems read
  // these in init()). REV3: adds the editable runway layout + mapping state.
  const g = world.globals as Record<string, unknown>;
  // Shared disposer bucket: systems (stage/environment/shaders) and the install*
  // helpers below append their unsubscribers here; the HMR dispose hook at the
  // end of init drains it so a hot-reload of this entry doesn't double-subscribe.
  if (!Array.isArray(g.cleanupFuncs)) g.cleanupFuncs = [];
  const cleanupFuncs = g.cleanupFuncs as Array<() => void>;

  g.showPhase = signal<ShowPhaseValue>("idle");
  g.showEnergy = signal(0);
  g.walkProgress = signal(-1);
  g.walkRemaining = signal(-1);
  g.lastStep = null;
  /** Rising-edge pulse: set true when the trainee reaches the pose mark
   * (ShaderTimeSystem consumes it to fire the audience paparazzi burst). */
  g.poseBurst = false;
  g.metrics = signal<MetricSnapshot | null>(null);
  g.summary = signal<ShowSummary | null>(null);
  g.showControls = null;
  /** Audience crowd visibility. The crowd (hundreds of instanced figures +
   * risers + phones + flashes) is the heaviest part of the scene AND obscures
   * passthrough on the Quest — so it's a toggle, AUTO-HIDDEN on entering
   * immersive XR (clear passthrough + GPU headroom) and shown in the browser.
   * The stage applies it to the audience meshes; web + XR controls write it. */
  g.crowdVisible = signal(true);
  /** Floor-glow toggle (founder call 2026-07-13): the always-on warp rings (the
   * "blue circles" on the live floor) can distract - a tester note. This gates
   * ONLY those rings off; the per-step footstrike ripples stay. Unlike the crowd
   * (auto-toggled on the XR crossing) this is a STICKY user preference, loaded
   * from localStorage and saved on change; ShaderTimeSystem reads it -> uRingsOn. */
  const FLOOR_RINGS_KEY = "xrunway.floorfx.v1";
  let floorRingsInit = true;
  try {
    floorRingsInit = localStorage.getItem(FLOOR_RINGS_KEY) !== "0";
  } catch {
    /* private mode / storage off - default the rings ON */
  }
  g.floorRingsVisible = signal(floorRingsInit);
  cleanupFuncs.push(
    (
      g.floorRingsVisible as {
        subscribe(fn: (v: boolean) => void): () => void;
      }
    ).subscribe((on) => {
      try {
        localStorage.setItem(FLOOR_RINGS_KEY, on ? "1" : "0");
      } catch {
        /* non-fatal */
      }
    }),
  );
  /** In-headset lesson panel visibility. The panel is XR-only (hidden in the
   * browser); in XR it side-mounts beside the runway and this toggles it
   * show/hide (a controller button flips it). Default shown. */
  g.hudVisible = signal(true);
  /** Custom audience models (the "Mixamo route"), loaded async after startup from
   * public/gltf/audience-*.glb. Empty → procedural figures. `audienceRev` bumps
   * when they arrive so the stage rebuilds the crowd with them. */
  g.audienceModels = [] as AudienceModel[];
  /** Photographer-pit figures (standing press at the runway's end), loaded async
   * from public/gltf/pit-*.glb. Empty → no pit is built. Shares audienceRev. */
  g.pitModels = [] as AudienceModel[];
  g.audienceRev = signal(0);

  // Active training mode (Beginner / Emerging / Commercial / Challenge).
  // Persisted; the landing picker writes it, ShowDirector reads its walk length
  // + score weights, MetricsSystem its ideal pace + pass threshold, and the
  // HUD/landing its copy. Created before any system registers (read in init()).
  g.activeMode = signal<TrainingMode>(loadMode());

  // Active passthrough backdrop (AR/none, Studio, Park, Skatepark, Beach).
  // Persisted; the landing picker writes it, installEnvironment() drives the
  // DomeTexture background. Auto-hidden in real AR (passthrough shows through).
  g.activeScene = signal<PassthroughScene>(loadScene());

  // Trainee identity (name + id) — replaces the hardcoded MATT/001. Persisted;
  // the landing greeting + XR HUD ident read it, the onboarding sets it.
  const userPrefsSig = signal<UserPrefs>(loadUser());
  g.userPrefs = userPrefsSig;

  // Music on/off + volume (#6) — the landing MUSIC control and the in-headset
  // settings row both write this; MusicSystem applies it to its master gain.
  // Persisted like the mode/scene prefs. Default: on at 0.7.
  const musicPrefsSig = signal<MusicPrefs>(loadMusicPrefs());
  g.musicPrefs = musicPrefsSig;
  cleanupFuncs.push(musicPrefsSig.subscribe((p) => saveMusicPrefs(p)));

  /** The MusicSource provider seam (docs/MUSIC-INTEGRATION.md scaffolding,
   * 2026-07-16): which provider feeds the walk's music, and — via
   * beatLockAvailable() — whether the scored beat grid may claim to BE the
   * audible music. Default procedural; the pickers/uploaders are follow-up
   * builds gated on the founder's Section-5 rulings. */
  const musicSourceSig = signal<MusicSourcePrefs>(loadMusicSource());
  g.musicSource = musicSourceSig;
  cleanupFuncs.push(musicSourceSig.subscribe((p) => saveMusicSource(p)));

  /** Pace-style pref (2026-07-18): which side of the target speed the
   * scoring forgives (confident stride vs take your time) + the advanced
   * band half-width. MetricsSystem latches the resolved band per run. */
  const pacePrefsSig = signal<PacePrefs>(loadPacePrefs());
  g.pacePrefs = pacePrefsSig;
  cleanupFuncs.push(pacePrefsSig.subscribe((p) => savePacePrefs(p)));

  // Coach voice on/off (#20/#48) — the landing COACH VOICE toggle and the
  // in-headset settings row both write this; CoachLiveSystem gates the
  // mid-walk spoken cues on it. Persisted like musicPrefs; HARD-PINNED OFF
  // (founder ruling 2026-07-16: the coach is text-only - see coach-prefs.ts).
  const coachPrefsSig = signal<CoachPrefs>(loadCoachPrefs());
  g.coachPrefs = coachPrefsSig;
  cleanupFuncs.push(coachPrefsSig.subscribe((p) => saveCoachPrefs(p)));

  // Beat pulse delivery (M9) — the landing BEAT PULSE control and the
  // in-headset settings pill both write this; BeatHapticsSystem peeks it per
  // frame and MetricsSystem's reference gate reads the resulting delivery
  // fact. Persisted like musicPrefs. Defaults: countdown ON (pre-scoring),
  // walk OFF (a scored condition — opt-in, stamped on the walk record).
  const beatPrefsSig = signal<BeatPrefs>(loadBeatPrefs());
  g.beatPrefs = beatPrefsSig;
  cleanupFuncs.push(beatPrefsSig.subscribe((p) => saveBeatPrefs(p)));

  // Walk duration (founder call 2026-07-09, 10-60 s, default = the mode's
  // own 20) — the in-headset settings pill writes this; ShowDirectorSystem
  // resolves it ONCE per run at the startRun mode lock (a mid-run change
  // takes effect on the NEXT run, the tempo-latch law). Persisted like
  // musicPrefs; null = mode default.
  const walkPrefsSig = signal<WalkPrefs>(loadWalkPrefs());
  g.walkPrefs = walkPrefsSig;
  cleanupFuncs.push(walkPrefsSig.subscribe((p) => saveWalkPrefs(p)));

  // FIT body baseline (Wave 1, per-trainee under "xrunway.fit.v1"). The
  // signal holds the CURRENT trainee's sanitized baseline: FitSessionSystem
  // publishes a fresh capture on save; this userPrefs subscription re-scopes
  // it on a trainee switch (@preact subscribe fires immediately -> it also
  // seeds the initial load). MetricsSystem locks the derived normalization
  // per walk; ShowDirector stamps summaries; landing/HUD render the status.
  // NOTE: globals.fitStatus belongs to the floor fit-to-room flow — every
  // body-fit global is namespaced bodyFit* / bodyBaseline (no collision).
  const bodyBaselineSig = signal<BodyBaseline | null>(null);
  g.bodyBaseline = bodyBaselineSig;
  cleanupFuncs.push(
    userPrefsSig.subscribe((u) => {
      bodyBaselineSig.value = loadFitBaseline(u.id);
    }),
  );
  /** Guided FIT flow state — stage EDGES only (FitSessionSystem publishes
   * FitCaptureMachine.takeEdge(); per-frame progress rides bodyFitProgress). */
  g.bodyFitFlow = signal<FitFlowState | null>(null);
  /** Assigned by FitSessionSystem.init (the showControls pattern). */
  g.bodyFitControls = null;
  /** 0..1 progress within the active fit stage — plain mutable ref (the
   * holdLive pattern): written per frame, polled by the landing, never a
   * signal (no stage-rebuilding publishes per frame). */
  g.bodyFitProgress = { value: 0 };
  /** The normalization stamp MetricsSystem locked for the CURRENT run —
   * plain ref (one writer per walk); ShowDirector copies it onto the
   * summary at finishWalk. */
  g.walkNormalization = undefined as string | undefined;

  // --- live runway mapping (REV3) + parametric shape model (shape phase) ---
  /** THE editable runway model. The SHAPE (straight / T / X / U) is the single
   * source of truth — the editor, mapping, and presets all write it; persisted. */
  const runwayShapeSig = signal<RunwayShape>(loadShape());
  g.runwayShape = runwayShapeSig;
  /** The shape compiled into N straight segments on a walk route — what the
   * stage / projector / systems consume. Recomputes on every remap. */
  const compiledPathSig = computed<SegmentedPath>(() =>
    compileShape(runwayShapeSig.value),
  );
  g.compiledPath = compiledPathSig;
  /** Derived spine layout (segment[0].rect) — the byte-identical straight layout
   * every existing system still reads. Computed, so it re-fits on every remap. */
  g.runwayLayout = computed<RunwayLayout>(
    () => compiledPathSig.value.segments[0].rect,
  );
  // Persist the shape on every change (replaces the old saveLayout path).
  cleanupFuncs.push(runwayShapeSig.subscribe((s) => saveShape(s)));
  /** The user's library of named runways + the preset catalog (WS1). */
  g.savedRunways = new SavedRunwaysStore();
  /** id of the preset/saved runway currently loaded (UI highlight), or null. */
  g.activeRunwayId = signal<string | null>(null);
  /** Mapping flow state, owned by MappingSystem. */
  g.mapMode = signal<MapMode>("off");
  /** Fit-to-room status feedback (#15) — MappingSystem writes the edges
   * (searching / no-floor hint / fitted); the XR panel renders the line. */
  g.fitStatus = signal<FitStatus>("idle");
  /** One-shot mapping notices (#17, e.g. a rejected too-short placement) —
   * MappingSystem posts, the XR panel flashes them over the map prompt. */
  g.mapNotice = signal<MapNotice | null>(null);
  /** Live floor cursor + placed endpoints + forming draft (plain refs). */
  g.reticle = null as RunwayPoint | null;
  g.mapPoints = { start: null as RunwayPoint | null, end: null as RunwayPoint | null };
  g.draftLayout = null as RunwayLayout | null;
  /** Mapping controls assigned by MappingSystem.init(); UI reads defensively. */
  g.mapControls = null;
  /** Preview-walk demo controls (assigned by DemoWalkSystem). */
  g.demoControls = null;
  /** Replay Theater controls (assigned by ReplayTheaterSystem) + the active
   * flag both summary surfaces observe (landing hides its overlay while the
   * ghost plays). Display-only — never touches scoring. */
  g.replayControls = null;
  g.replayActive = signal(false);
  /** VS BEST legend facts during a two-ghost replay (plain ref, painted by
   * the landing chip): { a: this walk's overall, b: the best's } | null. */
  g.replayCompare = null;
  /** Coached-moment cue during a replay ({kind, text} | null, plain ref) —
   * the web bar paints it; one line of the engine's own coach copy. */
  g.replayCue = null;
  /** Finale front-row seat slots (SPINE-LOCAL — the stage-root frame),
   * exported by the stage's audience build for Replay Theater's viewpoint;
   * null while the crowd is hidden / not built. */
  g.audienceFrontRowLocal = null;
  /** Live seated-crowd export (CROWD GAZE build): base matrices + instanced
   * slots per seat, published by the stage after each audience build so
   * CrowdGazeSystem can turn figures toward the walker. Null while the
   * crowd is hidden / not built; the pit press never registers. */
  g.audienceLive = null;
  g.__audienceLiveRev = 0;
  /** Judges' paddle anchors (ROOT-LOCAL, stage export — buildJudgesTable);
   * null while the judges never built (crowd hidden / no models). */
  g.judgesPaddles = null;
  g.__judgesPaddlesRev = 0;
  /** True while the Preview Walk auto-pilot drives the rig (DemoWalkSystem).
   * The recorder tags such runs `synthetic` (badged in history, excluded from
   * baselines/filters/summary CSV) and ShowDirector skips the deltaVsLast
   * baseline update — an autopilot walk must never grade a real trainee. */
  g.demoActive = false;

  // Phase-2 seam: external pose tracker (iPhone/webcam). The companion capture
  // page (/companion/) streams a skeleton through the pose relay; MetricsSystem
  // consults it and falls back to head-only. Non-fatal if no relay/companion is
  // present — it retries quietly in the background.
  g.trackerActive = false;
  const tracker = installExternalTracker(g);
  cleanupFuncs.push(connectPoseRelay(tracker, { log: (m) => console.info(m) }));

  // Session data capture: record every walk's metric time-series + summary,
  // exportable as CSV/JSON. (Non-negotiable data-collection requirement.)
  installSessionRecorder(g);

  // Black-stage world, cool-toned: near-black navy dome (auto-hidden in AR)
  // + dim studio IBL with a Carolina-blue floor bounce.
  const levelRoot = world.activeLevel.value;
  levelRoot.addComponent(DomeGradient, {
    sky: [0.024, 0.032, 0.045, 1.0],
    equator: [0.032, 0.045, 0.062, 1.0],
    ground: [0.014, 0.02, 0.03, 1.0],
    intensity: 1.0,
  });
  levelRoot.addComponent(IBLGradient, {
    sky: [0.2, 0.23, 0.28, 1.0],
    equator: [0.12, 0.15, 0.2, 1.0],
    ground: [0.08, 0.12, 0.17, 1.0],
    intensity: 0.9,
  });

  // Browser vantage: the trainee's start position, looking down the MAPPED
  // runway. Derived from the SAVED layout — the old hard-coded default-frame
  // vantage (0,1.6,0.35 → deck center) left every refresh facing away from a
  // stored rotated/moved runway (founder report 2026-07-22). Byte-identical
  // for the default layout: along startAlong()-0.75 = z 0.35, aim = the deck
  // center at y 0.8.
  {
    const vantageLayout = (g.runwayLayout as Signal<RunwayLayout>).peek();
    const eye = alongLateralToWorld(vantageLayout, startAlong() - 0.75, 0);
    const aim = alongLateralToWorld(vantageLayout, vantageLayout.length / 2, 0);
    world.camera.position.set(eye.x, 1.6, eye.z);
    world.camera.lookAt(aim.x, 0.8, aim.z);
  }

  // Walkable ground for locomotion so the player doesn't fall through when
  // moving (WASD in the browser, thumbstick in XR). A large INVISIBLE plane at
  // y=0; the locomotion engine raycasts onto its geometry (visibility is a
  // render flag only). In real AR the user physically walks; this backs the
  // emulator/desktop "move around" path.
  const locoGround = new Mesh(
    new PlaneGeometry(80, 80),
    new MeshBasicMaterial({ visible: false }),
  );
  locoGround.rotation.x = -Math.PI / 2;
  locoGround.name = "locomotion-ground";
  world
    .createTransformEntity(locoGround, {
      parent: world.sceneEntity,
      persistent: true,
    })
    .addComponent(LocomotionEnvironment);

  // Mouse-look in the browser (locomotion owns movement, the app owns the look).
  cleanupFuncs.push(installFreeLook(world));

  // The set (layout-driven) and the lesson panel. (No digital model — first person.)
  createStage(world);

  // Custom audience models (the "Mixamo route") — load async so a missing file (the
  // default) never blocks startup; the stage shows procedural figures until they
  // arrive, then rebuilds with them. Errors (no GLBs) are expected → swallow.
  void loadAudienceModels()
    .then((models) => {
      if (models.length === 0) return;
      (g.audienceModels as AudienceModel[]).push(...models);
      (g.audienceRev as { value: number }).value++;
    })
    .catch(() => {});
  // The photographer pit (standing press at the runway's end) — same contract:
  // async, missing files are the no-pit default, arrival rebuilds the crowd.
  void loadPitModels()
    .then((models) => {
      if (models.length === 0) return;
      (g.pitModels as AudienceModel[]).push(...models);
      (g.audienceRev as { value: number }).value++;
    })
    .catch(() => {});

  // Auto-hide the crowd on entering immersive XR (clear passthrough + reclaim the
  // GPU budget that was killing the session mid-walk), show it again in the
  // browser. An in-XR / web toggle can still override within a session — so only
  // auto-toggle on the actual NonImmersive<->immersive CROSSING, never on a
  // Visible<->VisibleBlurred<->Hidden blink (system menu, headset off-and-on,
  // sleep), which fires constantly on a Quest and would otherwise clobber a
  // manual "Crowd: on" every time the user glanced at the system UI.
  const crowdSig = g.crowdVisible as { value: boolean };
  let wasImmersive: boolean | null = null;
  cleanupFuncs.push(
    world.visibilityState.subscribe((vs) => {
      const isImmersive = vs !== VisibilityState.NonImmersive;
      if (isImmersive !== wasImmersive) {
        crowdSig.value = !isImmersive;
        wasImmersive = isImmersive;
      }
    }),
  );

  world
    .createTransformEntity()
    .addComponent(PanelUI, {
      // Enlarged (founder call 2026-07-08): the in-headset panel text was hard
      // to read. maxWidth/maxHeight scale the WHOLE rendered panel — pure
      // magnification, no layout change (per-row overflow fixes live in
      // ui/lesson.uikitml).
      config: "./ui/lesson.json",
      maxWidth: 1.1,
      maxHeight: 1.3,
    })
    .addComponent(Interactable);

  // Pipeline: direction → mapping → coaching → look → sound → UI.
  world
    // Demo runs first so the rig is moved before the director/metrics read the head.
    .registerSystem(DemoWalkSystem, { priority: -1 })
    // Replay Theater owns the rig only at `summary` (the demo owns it only
    // during a preview run — the two can never overlap); before the director
    // so an exit-input reset is observed the same frame.
    .registerSystem(ReplayTheaterSystem, { priority: -1 })
    .registerSystem(ShowDirectorSystem, { priority: 0 })
    .registerSystem(MappingSystem, { priority: 5 })
    .registerSystem(MetricsSystem, { priority: 12 })
    // Always-on: floor ripples follow horizontal movement (demo/XR/WASD).
    .registerSystem(FloorRippleSystem, { priority: 13 })
    // Guided FIT capture (Wave 1) — idle-only own runner, order-insensitive
    // (it early-returns unless a fit flow is live; showPhase never leaves
    // "idle" during one).
    .registerSystem(FitSessionSystem, { priority: 14 })
    .registerSystem(StageMoodSystem, { priority: 20 })
    // The watching crowd: ~10 Hz instance-matrix nudges toward the walker.
    // After the director/metrics (fresh head), before the shader clock.
    .registerSystem(CrowdGazeSystem, { priority: 21 })
    // The judges' scored paddles (display-only; raises at the reveal anchor).
    .registerSystem(JudgesPaddlesSystem, { priority: 21 })
    .registerSystem(FootprintGlowSystem, { priority: 21 })
    .registerSystem(ShaderTimeSystem, { priority: 22 })
    .registerSystem(MapPreviewSystem, { priority: 23 })
    .registerSystem(MusicSystem, { priority: 30 })
    // After MusicSystem: its phase subscriber arms globals.goAudioTime first,
    // so the SFX layer's countdown ticks/GO hit align to the same instant.
    .registerSystem(SfxSystem, { priority: 31 })
    // THE HOUSE REACTS: the murmur/hush/applause bed — after SfxSystem so
    // the shared context exists by the time its phase edge fires.
    .registerSystem(HouseReactsSystem, { priority: 32 })
    // Live audio coaching — DISABLED (2026-07-05 founder call: "coach should
    // be just text"). The spoken/earcon coach (CoachLiveSystem) is NOT
    // registered, so nothing narrates mid-walk regardless of any stored pref;
    // the coach still appears as TEXT (the post-walk summary notes, rendered
    // by landing.ts/hud.ts, independent of this system). Re-register to
    // restore the voice.
    // .registerSystem(CoachLiveSystem, { priority: 32 })
    // M9 beat delivery: after MusicSystem (its countdown-edge subscriber
    // arms globals.goAudioTime first — the SfxSystem ordering precedent) and
    // after MetricsSystem in the frame, so the delivery fact it publishes
    // (globals.beatDelivery) is stable when the metrics reference gate
    // reads it the next frame.
    .registerSystem(BeatHapticsSystem, { priority: 33 })
    .registerSystem(HUDSystem, { priority: 35 });

  mountLanding(world);

  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__XRUNWAY_WORLD = world;
  }

  // Passthrough backdrop simulation LAST: drives a photoreal DomeTexture from
  // g.activeScene. Deferred to the end so the (heavy) panorama load never
  // competes with the stage build during init. AR-hidden by EnvironmentSystem.
  installEnvironment(world);

  // HMR / teardown: drain every registered disposer (the install* unsubscribers
  // above + the systems' own pushes) before this entry is replaced, so a dev
  // hot-reload doesn't leave the old subscriptions live and double-subscribe on
  // re-init.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      for (const fn of cleanupFuncs.splice(0)) {
        try {
          fn();
        } catch (err) {
          console.warn("[cleanup] disposer threw:", err);
        }
      }
    });
  }
});
