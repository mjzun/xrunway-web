/**
 * (X)RUNWAY — Preview-walk demo (hands-free auto-pilot).
 *
 * A "PREVIEW WALK" button that simulates the whole experience on the desktop
 * landing with no headset and no trainee: it drives the VIEWER (the player rig)
 * in first person down the runway centerline, turns 180 at the pose mark, and
 * walks back to the start. Because the rig carries both the camera and the
 * tracked head, the existing systems respond for free — the show runs
 * (lights/floor/audience), `ShowDirector` advances walkProgress from the head,
 * `MetricsSystem` derives real scores from the head motion, and the round-trip
 * ends the walk into a scored summary. Browser-only (in XR the headset owns the
 * rig). Restores the camera/rig on finish.
 */

import {
  createSystem,
  LocomotionSystem,
  Quaternion,
  SlideSystem,
  TeleportSystem,
  TurnSystem,
  Vector3,
  VisibilityState,
} from "@iwsdk/core";
import type { Signal } from "@preact/signals-core";

import { startAlong } from "./runway-layout.js";
import { routeToWorld, type RoutePoint, type SegmentedPath } from "./runway-shape.js";
import type { ShowControls, ShowPhaseValue } from "./show.js";

/** Eye height while previewing (camera local Y). */
const EYE_HEIGHT = 1.5;
/** Slight downward pitch so the runway fills the view (camera local X rot). */
// Tilt the gaze DOWN the runway (not at the horizon) so the reactive floor —
// the footstep ripples + heave — fills the lower half of the view. A model
// glances at their footing; here it also showcases the live floor. (~-23°)
const EYE_PITCH = -0.4;
/** Catwalk speed (m/s) — picked so the simulated pace reads near ideal. */
const WALK_SPEED = 0.85;
/** 180 turn duration at the pose mark (s). */
const TURN_SEC = 0.9;
/** Pause at the pose mark before/after the turn (s). */
const POSE_HOLD = 0.6;
/** Head-bob for a believable gait (drives the rhythm metric). */
const BOB_AMP = 0.018;
const STEP_HZ = 1.9;
/** Heading smoothing rate (1/s). routeToWorld returns the active segment's yaw,
 * so a U's legA→base→legB corners are 90° jumps; ease through them instead of
 * snapping the camera. Straight/T/X have a constant route heading, so this is a
 * no-op after the initial snap. */
const HEADING_RATE = 6;

function smooth(p: number): number {
  const c = p < 0 ? 0 : p > 1 ? 1 : p;
  return c * c * (3 - 2 * c);
}

export interface DemoControls {
  /** Start the preview walk (no-op if already running or in XR). */
  start(): void;
  /** Stop + restore (also resets the show). */
  stop(): void;
}

export class DemoWalkSystem extends createSystem({}, {}) {
  private phaseSig!: Signal<ShowPhaseValue>;
  private pathSig!: Signal<SegmentedPath>;

  private active = false;
  private demoTime = 0;
  /** Compiled path snapshotted at start — drives the route walk (U-aware). */
  private path!: SegmentedPath;
  /** U is a one-way horseshoe: walk legA→base→legB, pose at the far end, done —
   * no walk back (matches show.ts oneWay). Straight/T/X do the out-and-back. */
  private isU = false;
  private routeStart = 0;
  private routePose = 0;
  private tLeg = 1;

  // Saved view to restore on finish.
  private savedCamPos = new Vector3();
  private savedCamQuat = new Quaternion();
  private savedPlayerPos = new Vector3();
  private savedPlayerRotY = 0;

  private worldPt: RoutePoint = { x: 0, z: 0, yaw: 0 };

  /** Smoothed route heading (rad) + a first-placement snap flag, so the U's
   * per-segment yaw jumps ease in rather than snapping the camera. */
  private headingYaw = 0;
  private headingReady = false;

  init(): void {
    const g = this.globals;
    this.phaseSig = g.showPhase as Signal<ShowPhaseValue>;
    this.pathSig = g.compiledPath as Signal<SegmentedPath>;

    const controls: DemoControls = {
      start: () => this.start(),
      stop: () => this.stopDemo(),
    };
    g.demoControls = controls;
    this.cleanupFuncs.push(() => {
      if (g.demoControls === controls) g.demoControls = null;
    });

    // The demo owns the rig only in the browser. If the headset takes over
    // (XR session starts) mid-preview, tear down + restore immediately so the
    // auto-pilot never fights / teleports the XR origin.
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((vs) => {
        if (vs !== VisibilityState.NonImmersive && this.active) {
          this.stopDemo();
        }
      }),
    );

    // start() snapshots the compiled route into this.path. If the runway SHAPE
    // changes mid-preview, that snapshot (driving the rig) desyncs from the live
    // compiledPath (driving ShowDirector + scoring) — stop + restore cleanly
    // rather than stride a stale route. (subscribe fires once immediately; active
    // is false at init, so that first call is a no-op.)
    this.cleanupFuncs.push(
      this.pathSig.subscribe(() => {
        if (this.active) this.stopDemo();
      }),
    );
  }

  private start(): void {
    if (this.active) return;
    if (this.world.visibilityState.peek() !== VisibilityState.NonImmersive) {
      return; // in XR the trainee walks for real
    }

    // Snapshot the compiled path (route). For straight/T/X it's the spine; for a
    // U it's legA -> base -> legB, so the demo strides the whole horseshoe.
    this.path = this.pathSig.peek();
    this.isU = this.path.kind === "U";
    this.routeStart = startAlong();
    this.routePose = this.path.poseRouteAlong;
    const dist = Math.max(0.5, this.routePose - this.routeStart);
    this.tLeg = dist / WALK_SPEED;

    // Save + set a clean first-person camera local transform.
    this.savedCamPos.copy(this.camera.position);
    this.savedCamQuat.copy(this.camera.quaternion);
    this.savedPlayerPos.copy(this.player.position);
    this.savedPlayerRotY = this.player.rotation.y;
    this.camera.position.set(0, EYE_HEIGHT, 0);
    this.camera.rotation.set(EYE_PITCH, 0, 0);

    // The Locomotor physics engine asserts world.player every frame, which
    // fights placeRig (the camera ends up frozen, jittering between the demo's
    // target and the engine's hold). Pause locomotion so the auto-pilot owns
    // the rig; finish() restores it so XR thumbstick / WASD work again after.
    this.setLocomotion(false);

    // Place the viewer at the start, facing down the runway, then run the show.
    // Snap the smoothed heading to the start heading for this run.
    this.headingReady = false;
    this.placeRig(this.routeStart, 0, 0, 0);
    this.active = true;
    this.demoTime = 0;
    // Mark the run SYNTHETIC before the show starts: the session recorder tags
    // the record (kept out of the coach's baselines/filters/summary CSV) and
    // ShowDirector skips the deltaVsLast baseline update. Cleared in finish().
    this.globals.demoActive = true;
    (this.globals.showControls as ShowControls | null)?.beginWalk();
  }

  /** Pause (run=false) or resume (run=true) IWSDK's locomotion systems.
   * Resolved by CLASS REFERENCE (not `constructor.name`): the systems are
   * registered internally by the world initializer, and `vite build` minifies
   * class names, so a name match silently fails in the production bundle. Any
   * system that isn't registered (locomotion feature disabled) resolves to
   * `undefined` and is skipped. */
  private setLocomotion(run: boolean): void {
    const systems = [
      this.world.getSystem(LocomotionSystem),
      this.world.getSystem(SlideSystem),
      this.world.getSystem(TurnSystem),
      this.world.getSystem(TeleportSystem),
    ];
    for (const s of systems) {
      if (!s) continue;
      if (run) s.play();
      else s.stop();
    }
  }

  private stopDemo(): void {
    if (!this.active) return;
    (this.globals.showControls as ShowControls | null)?.reset();
    this.finish();
  }

  update(delta: number): void {
    if (!this.active) return;
    // Belt-and-suspenders for the visibility subscription: never drive the rig
    // outside the browser.
    if (this.world.visibilityState.peek() !== VisibilityState.NonImmersive) {
      this.stopDemo();
      return;
    }
    const phase = this.phaseSig.peek();

    // The show ended (round-trip or reset) -> restore the view.
    if (phase === "summary" || phase === "idle") {
      this.finish();
      return;
    }
    // Pre-walk (brief / countdown): stand at the start, facing down the route.
    if (phase !== "walk") {
      this.placeRig(this.routeStart, 0, 0, delta);
      return;
    }

    // Walk phase: down the route -> hold -> turn -> hold -> back -> hold at start.
    // `facingOffset` is RELATIVE to the active route segment's heading (0 =
    // forward, π = facing back the way you came), so the gaze stays correct as
    // the U bends through its corners.
    this.demoTime += delta;
    const t = this.demoTime;
    const tDownEnd = this.tLeg;
    const tHold1End = tDownEnd + POSE_HOLD;
    const tTurnEnd = tHold1End + TURN_SEC;
    const tHold2End = tTurnEnd + POSE_HOLD;
    const tBackEnd = tHold2End + this.tLeg;
    const span = this.routePose - this.routeStart;

    let routeAlong: number;
    let facingOffset: number;
    let moving = true;

    if (t < tDownEnd) {
      routeAlong = this.routeStart + span * smooth(t / this.tLeg);
      facingOffset = 0;
    } else if (t < tHold1End) {
      routeAlong = this.routePose;
      facingOffset = 0;
      moving = false; // pose at the mark
    } else if (t < tTurnEnd) {
      routeAlong = this.routePose;
      facingOffset = Math.PI * smooth((t - tHold1End) / TURN_SEC);
      moving = false; // the fashion turn
    } else if (this.isU) {
      // U is ONE-WAY: pose + turn at the far end, then hold there until show.ts's
      // one-way finish (pose dwell) flips phase→summary and finish() restores.
      // No walk back — retracing the horseshoe would contradict the scored model.
      routeAlong = this.routePose;
      facingOffset = Math.PI;
      moving = false;
    } else if (t < tHold2End) {
      routeAlong = this.routePose;
      facingOffset = Math.PI;
      moving = false;
    } else if (t < tBackEnd) {
      routeAlong = this.routePose - span * smooth((t - tHold2End) / this.tLeg);
      facingOffset = Math.PI;
    } else {
      // Home: hold at the start so ShowDirector's round-trip check fires.
      routeAlong = this.routeStart;
      facingOffset = Math.PI;
      moving = false;
    }

    const bob = moving
      ? BOB_AMP * Math.abs(Math.sin(Math.PI * STEP_HZ * t))
      : 0;
    this.placeRig(routeAlong, facingOffset, bob, delta);
  }

  private placeRig(
    routeAlong: number,
    facingOffset: number,
    bobY: number,
    delta: number,
  ): void {
    const w = routeToWorld(this.path, routeAlong, 0, this.worldPt);
    this.player.position.set(w.x, bobY, w.z);
    // Smooth the discrete per-segment route heading (a U's corners are 90°
    // jumps) with a shortest-angle approach; snap on the first placement.
    if (!this.headingReady) {
      this.headingYaw = w.yaw;
      this.headingReady = true;
    } else if (delta > 0) {
      let d = w.yaw - this.headingYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d)); // shortest signed angle
      this.headingYaw += d * (1 - Math.exp(-HEADING_RATE * delta));
    }
    this.player.rotation.y = this.headingYaw + facingOffset;
  }

  private finish(): void {
    this.active = false;
    // The auto-pilot no longer owns the rig — subsequent walks are real again.
    // (Safe here: ShowDirector finalizes the summary BEFORE the phase flips to
    // "summary", and this runs on the frame AFTER that flip.)
    this.globals.demoActive = false;
    this.camera.position.copy(this.savedCamPos);
    this.camera.quaternion.copy(this.savedCamQuat);
    this.player.position.copy(this.savedPlayerPos);
    this.player.rotation.y = this.savedPlayerRotY;
    // Hand movement back to the user (XR thumbstick / browser WASD).
    this.setLocomotion(true);
  }
}
