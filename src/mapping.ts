/**
 * (X)RUNWAY — Live runway MAPPING (REV3, Agent MAPPING).
 *
 * The licensing pitch is "map your unique runway." This system lets the trainee
 * WALK their real floor and PLACE the two ends of the virtual runway onto it.
 * It owns the mapping state machine and publishes the forming layout through the
 * REV3 mapping globals; stage.ts (MapPreviewSystem) renders the live preview
 * from those globals, so this module ships ZERO visuals of its own.
 *
 * STATE — globals.mapMode : Signal<"off"|"placing-start"|"placing-end"|"adjust">
 *   off            idle; reticle/points/draft cleared, committed layout shown.
 *   placing-start  reticle tracks the right controller ray on the floor; the
 *                  next placePoint() drops the START point.
 *   placing-end    reticle continues; the next placePoint() drops the END,
 *                  builds a DRAFT via layoutFromEndpoints and enters "adjust".
 *   adjust         draft is formed; setWidth() nudges width (clamped); the UI
 *                  commit() writes runwayLayout + saveLayout and returns to off.
 *
 * RETICLE — while mapping, intersect the RIGHT controller's target ray with the
 * floor plane y = 0 (preallocated Ray/Vector3 scratch, zero per-frame alloc) and
 * write the (x, z) hit to globals.reticle. With no XR controller present
 * (browser/desktop) the reticle stays null and the system no-ops gracefully —
 * the desktop editor drives globals.runwayLayout directly, which is not our
 * concern. A trigger / select press on the right controller calls the same logic
 * as placePoint(), so the user can place points in-headset; the A button commits
 * while in "adjust".
 *
 * mapControls (assigned to globals.mapControls in init(), nulled on cleanup):
 *   startMapping()      -> "placing-start", clears points/draft/reticle.
 *   cancelMapping()     -> "off", restores the committed layout, clears state.
 *   placePoint()        -> drop the reticle point (start then end); after the
 *                          end, build the draft and go "adjust".
 *   setWidth(w)         -> during "adjust": clamp w into LAYOUT_LIMITS and
 *                          rebuild the draft from the two points.
 *   commit()            -> runwayLayout.value = sanitize(draft); saveLayout(...);
 *                          mapMode = "off"; clears reticle/points/draft.
 *   autoMapFromFloor()  -> WebXR plane-detection fit (see below).
 *
 * autoMapFromFloor() — IMPLEMENTED PATH: real WebXR plane detection with a
 * graceful default fallback. When the integrator enables `planeDetection` +
 * `sceneUnderstanding`, IWSDK's SceneUnderstandingSystem spawns entities carrying
 * the {@link XRPlane} component (one per detected real-world plane). This system
 * holds a query over those entities; autoMapFromFloor() picks the largest
 * HORIZONTAL plane nearest the floor (lowest world Y), centers the runway on it,
 * fits length/width to the plane's polygon extent (clamped to LAYOUT_LIMITS), and
 * commits + saves. If NO floor plane is available (feature off, no scene-
 * understanding system, or browser/desktop with no plane data) it logs ONCE and
 * drops a sensible DEFAULT_LAYOUT centered just in front of the trainee — so the
 * button always does something visible.
 *
 * Law: cleanupFuncs for every subscription/teardown; subscribe over poll where a
 * subscribe fits; zero per-frame allocation in update(); no banned tokens.
 */

import {
  createSystem,
  InputComponent,
  Quaternion,
  Ray,
  Vector3,
  XRPlane,
} from "@iwsdk/core";
import type { Signal } from "@preact/signals-core";

import { floorsClose, selectFloorFit, type PlaneSample } from "./floor-fit.js";
import {
  MAP_FIT_BLOCKED_NOTICE,
  MAP_TOO_SHORT_NOTICE,
  type FitStatus,
  type MapNotice,
} from "./hud-copy.js";
import {
  DEFAULT_LAYOUT,
  LAYOUT_LIMITS,
  layoutFromEndpoints,
  sanitizeLayout,
  type RunwayLayout,
} from "./runway-layout.js";
import {
  fitShapeToFloorPlane,
  straightShapeFromLayout,
  type FloorFit,
  type RunwayShape,
} from "./runway-shape.js";

export type MapMode = "off" | "placing-start" | "placing-end" | "adjust";

/** Plain (x, z) floor point — matches the mapPoints / reticle global shape. */
interface FloorPoint {
  x: number;
  z: number;
}

/** The mapControls object the UI (HUD + landing) drives. */
export interface MapControls {
  startMapping(): void;
  cancelMapping(): void;
  placePoint(): void;
  setWidth(w: number): void;
  commit(): void;
  autoMapFromFloor(): void;
}

/** Re-fit cadence while "Fit to room" is armed + converging (seconds). */
const FIT_REEVAL_SEC = 0.3; // re-poll the floor at ~3 Hz (cheap, not per-frame)
const FIT_SETTLE_SEC = 1.2; // disarm once the fit hasn't changed for this long
const FIT_MAX_SETTLE_SEC = 6; // hard cap on settling after the first fit landed
/** #15: armed this long with NO plane at all -> escalate the panel status from
 * "searching" to the actionable no-floor hint (saved Space + spatial data). */
const FIT_NO_FLOOR_HINT_SEC = 6;

export class MappingSystem extends createSystem({
  /**
   * Detected real-world planes (floor/walls/ceiling). Populated by IWSDK's
   * SceneUnderstandingSystem when the integrator enables planeDetection +
   * sceneUnderstanding. Empty otherwise — autoMapFromFloor() degrades cleanly.
   */
  planes: { required: [XRPlane] },
}) {
  // --- mapping globals (created in index.ts; read defensively) -------------
  private layoutSig: Signal<RunwayLayout> | undefined;
  /** The SHAPE source of truth — mapping commits write this (it persists). */
  private shapeSig: Signal<RunwayShape> | undefined;
  private modeSig: Signal<MapMode> | undefined;
  /** #15: fit-to-room status line the XR panel renders (edge-written only). */
  private fitStatusSig: Signal<FitStatus> | undefined;
  /** #17: one-shot mapping notices the XR panel flashes (event-written only). */
  private noticeSig: Signal<MapNotice | null> | undefined;
  private noticeSeq = 0;

  /** Width carried through placing/adjust; seeded from the committed layout. */
  private draftWidth = DEFAULT_LAYOUT.width;

  // --- preallocated scratch — NEVER allocate in update() -------------------
  private ray!: Ray;
  private rayOrigin!: Vector3;
  private rayDir!: Vector3;
  private hit!: Vector3;
  private planeCenter!: Vector3;
  private planeQuat!: Quaternion;
  /** Reused reticle point — published as globals.reticle, never reallocated. */
  private reticlePt: FloorPoint = { x: 0, z: 0 };

  /** Throttle the autoMapFromFloor "no planes" notice to once per load. */
  private warnedNoPlane = false;
  /** "Fit to room" is armed: fit the runway to the floor as soon as a usable
   * floor plane is available. Quest planes populate a second+ after entry, so
   * the button arms this and the planes-query 'qualify' fires the fit when ready
   * — instead of snapping to fixed numbers against an empty query.
   *
   * While armed we keep RE-FITTING as the floor converges: a real floor plane's
   * polygon grows/refines in place over the first seconds (and fragments arrive),
   * but that does NOT re-fire 'qualify', so a one-shot fit would lock onto the
   * incomplete early extent. We therefore re-poll on a coarse timer + on every
   * 'qualify', re-apply ONLY when the fit meaningfully changes (so the stage isn't
   * rebuilt every frame — that was the GPU overrun), and disarm once it settles. */
  private autoFitArmed = false;
  /** The fit currently applied (so we only re-apply on a meaningful change). */
  private lastFit: FloorFit | null = null;
  /** Seconds since the last meaningful fit change / since the first fit / since
   * the last periodic re-poll. Drive the settle + disarm timing in update(). */
  private settleSince = 0;
  private firstFitSince = 0;
  private reEvalSince = 0;
  /** #15: seconds armed with NO fit landed yet — drives the no-floor hint. */
  private noFloorSince = 0;
  /** A new plane qualified — coalesce a same-frame burst of 'qualify' events into
   * ONE fit step in update() (instead of N synchronous stage rebuilds). */
  private refitPending = false;

  init(): void {
    this.ray = new Ray();
    this.rayOrigin = new Vector3();
    this.rayDir = new Vector3();
    this.hit = new Vector3();
    this.planeCenter = new Vector3();
    this.planeQuat = new Quaternion();

    const g = this.globals;
    this.layoutSig = g.runwayLayout as Signal<RunwayLayout> | undefined;
    this.shapeSig = g.runwayShape as Signal<RunwayShape> | undefined;
    this.modeSig = g.mapMode as Signal<MapMode> | undefined;
    this.fitStatusSig = g.fitStatus as Signal<FitStatus> | undefined;
    this.noticeSig = g.mapNotice as Signal<MapNotice | null> | undefined;

    // Seed the working width from the committed layout (if present).
    if (this.layoutSig !== undefined) {
      this.draftWidth = this.layoutSig.peek().width;
    }

    // Ensure the mapping refs exist with sane defaults (the integrator may have
    // created them already; assigning plain refs is idempotent).
    if (g.reticle === undefined) g.reticle = null;
    if (g.mapPoints === undefined) {
      g.mapPoints = { start: null, end: null } as MapPointsRef;
    }
    if (g.draftLayout === undefined) g.draftLayout = null;

    const controls: MapControls = {
      startMapping: () => this.startMapping(),
      cancelMapping: () => this.cancelMapping(),
      placePoint: () => this.placePoint(),
      setWidth: (w: number) => this.setWidth(w),
      commit: () => this.commit(),
      autoMapFromFloor: () => this.autoMapFromFloor(),
    };
    g.mapControls = controls;

    // Fit-to-room: when a real floor plane appears (Quest plane polygons converge
    // a beat after session start), fit the runway to it — but only if the user
    // has armed it via "Fit to room". This is what makes the button reliable
    // instead of snapping to fixed numbers against a not-yet-populated query.
    // A new plane (the floor, or a floor fragment) requests a re-fit; in-place
    // polygon growth (which fires NO 'qualify') is caught by update()'s re-poll.
    // We only FLAG here — many planes can qualify in a single frame at session
    // start, and update() coalesces the burst into one fit step (one rebuild).
    this.queries.planes.subscribe("qualify", () => {
      if (this.autoFitArmed) this.refitPending = true;
    });

    // Teardown: drop the controls + any in-flight mapping state.
    this.cleanupFuncs.push(() => {
      if (g.mapControls === controls) {
        g.mapControls = null;
      }
      g.reticle = null;
      g.draftLayout = null;
      const pts = g.mapPoints as MapPointsRef | undefined;
      if (pts !== undefined) {
        pts.start = null;
        pts.end = null;
      }
      this.setFitStatus("idle");
    });
  }

  // -- per-frame: drive the floor reticle + in-headset placement gestures ----

  update(delta: number): void {
    // "Fit to room" gesture: EITHER face button (X or Y) on the LEFT
    // controller. Arms the floor fit — fits now if a plane is ready, else the
    // moment one appears. No-ops in the browser (no left XR gamepad).
    // ID FIX (2026-07-10): Quest-family LEFT layouts expose 'x-button'/
    // 'y-button' — the old A_Button/B_Button lookups never resolved on the
    // left pad, so this gesture was DEAD on-device. A/B kept as extra ORs for
    // exotic non-Quest lefts (valve-index's left exposes only 'a-button').
    // Ships in the SAME commit as autoMapFromFloor's mid-mapping gate: making
    // the gesture live without the gate is what would materialize the
    // tester's force-cancel trap.
    const leftPad = this.input.xr.gamepads.left;
    if (
      leftPad !== undefined &&
      (leftPad.getButtonDown(InputComponent.X_Button) ||
        leftPad.getButtonDown(InputComponent.Y_Button) ||
        leftPad.getButtonDown(InputComponent.A_Button) ||
        leftPad.getButtonDown(InputComponent.B_Button))
    ) {
      this.autoMapFromFloor();
    }

    // While armed, keep re-fitting as the floor converges. Two triggers:
    //  • a new plane qualified (refitPending) — coalesced to ONE step per frame,
    //  • a coarse periodic re-poll, ONLY after the first fit landed, to catch the
    //    floor polygon growing IN PLACE (which fires no 'qualify').
    // Before any floor exists we just wait on 'qualify' (no idle per-frame poll /
    // allocation). applyFitStep writes the shape signal at most once per real
    // change, so the stage is never rebuilt every frame. Disarm once it settles.
    if (this.autoFitArmed) {
      let doStep = false;
      if (this.refitPending) {
        this.refitPending = false;
        doStep = true;
      }
      if (this.lastFit !== null) {
        this.reEvalSince += delta;
        if (this.reEvalSince >= FIT_REEVAL_SEC) {
          this.reEvalSince = 0;
          doStep = true;
        }
      }
      if (doStep && this.applyFitStep()) this.settleSince = 0;
      // #15: still no plane at all after the grace period — escalate the panel
      // status ONCE from "searching" to the actionable no-floor hint. Stays
      // armed: the moment a plane qualifies, the fit lands and flips it to
      // "fitted". Scalar timer math only; setFitStatus is change-gated.
      if (this.lastFit === null) {
        this.noFloorSince += delta;
        if (this.noFloorSince >= FIT_NO_FLOOR_HINT_SEC) {
          this.setFitStatus("no-floor");
        }
      }
      if (this.lastFit !== null) {
        this.settleSince += delta;
        this.firstFitSince += delta;
        if (
          this.settleSince >= FIT_SETTLE_SEC ||
          this.firstFitSince >= FIT_MAX_SETTLE_SEC
        ) {
          this.autoFitArmed = false; // converged → stop tracking
        }
      }
    }

    const mode = this.modeSig !== undefined ? this.modeSig.peek() : "off";
    if (mode === "off") return;

    // Reticle only tracks while we are PLACING (not during width adjust).
    const placing = mode === "placing-start" || mode === "placing-end";
    if (placing) {
      const hit = this.castRightRayToFloor();
      const g = this.globals;
      if (hit !== null) {
        // Write into the reused scratch (zero-alloc per frame) and publish it.
        this.reticlePt.x = hit.x;
        this.reticlePt.z = hit.z;
        g.reticle = this.reticlePt;
      } else {
        // No XR controller (browser/desktop) — no reticle, no-op gracefully.
        g.reticle = null;
      }

      // In-headset placement: trigger / select on the RIGHT controller drops
      // the current point (same path as the UI placePoint()).
      const right = this.input.xr.gamepads.right;
      if (right !== undefined) {
        if (right.getSelectStart() || right.getButtonDown(InputComponent.Trigger)) {
          this.placePoint();
        }
      }
    } else if (mode === "adjust") {
      // Right thumbstick X nudges the draft width; A button commits (clean,
      // optional headset gesture). Reticle is hidden during adjust.
      const right = this.input.xr.gamepads.right;
      if (right !== undefined) {
        const axes = right.getAxesValues(InputComponent.Thumbstick);
        if (axes !== undefined && Math.abs(axes.x) > 0.15) {
          // ~0.6 m/s nudge feel; deadzoned, clamped inside setWidth().
          // Delta-scaled — the old per-frame +0.012 ran 1.4-2.4x faster on
          // the Quest's 90/120 Hz than the 72 Hz it was tuned at. (While
          // adjusting, the HUD reconciler pauses snap turn: this same stick
          // used to ALSO yank the room 45 degrees at full tilt.)
          this.setWidth(this.draftWidth + axes.x * 0.6 * delta);
        }
        if (right.getButtonDown(InputComponent.A_Button)) {
          this.commit();
        }
      }
    }
  }

  /**
   * Intersect the RIGHT controller's target ray with the floor plane y = 0.
   * Returns the preallocated hit Vector3, or null when there is no XR
   * controller / the ray is parallel-or-pointing-up (no floor hit). Zero alloc.
   */
  private castRightRayToFloor(): Vector3 | null {
    // No live controller -> no reticle. The right ray-space is always parented
    // in the rig (so a parent check never fires), so gate on the actual
    // gamepad handle, which the input manager nulls when no source is present.
    if (this.input.xr.gamepads.right === undefined) return null;
    const raySpace = this.player.raySpaces.right;
    if (raySpace === undefined) return null;

    raySpace.getWorldPosition(this.rayOrigin);
    // WebXR ray space points down its local -Z.
    raySpace.getWorldDirection(this.rayDir).multiplyScalar(-1);

    this.ray.origin.copy(this.rayOrigin);
    this.ray.direction.copy(this.rayDir).normalize();

    // Intersect with y = 0. Need the ray to travel downward toward the floor.
    const dy = this.ray.direction.y;
    if (dy >= -1e-4) return null; // parallel or pointing up — no floor hit
    const t = -this.ray.origin.y / dy;
    if (t <= 0) return null;
    this.hit
      .copy(this.ray.direction)
      .multiplyScalar(t)
      .add(this.ray.origin);
    return this.hit;
  }

  // -- mapControls implementation -------------------------------------------

  private startMapping(): void {
    // Starting a manual map cancels any in-flight auto-fit settle, so a settle
    // re-fit can't yank the user out of placing mid-mapping. The fit status
    // line clears with it (#15) — mapping owns the panel now.
    this.autoFitArmed = false;
    this.setFitStatus("idle");
    // Seed working width from the committed layout so the draft inherits it.
    if (this.layoutSig !== undefined) {
      this.draftWidth = this.layoutSig.peek().width;
    }
    this.clearPoints();
    this.setDraft(null);
    this.setReticle(null);
    this.setMode("placing-start");
  }

  private cancelMapping(): void {
    // Restore the committed layout (it was never overwritten — just clear the
    // forming state and hide the preview by returning to "off").
    this.clearPoints();
    this.setDraft(null);
    this.setReticle(null);
    this.setMode("off");
  }

  private placePoint(): void {
    const mode = this.modeSig !== undefined ? this.modeSig.peek() : "off";
    const pts = this.points();
    if (pts === null) return;

    // Need a current floor point. Prefer the live reticle; fall back to a fresh
    // cast so a UI button-press without a frame in between still lands.
    let px: number;
    let pz: number;
    const r = this.globals.reticle as FloorPoint | null | undefined;
    if (r !== null && r !== undefined) {
      px = r.x;
      pz = r.z;
    } else {
      const hit = this.castRightRayToFloor();
      if (hit === null) return; // nothing to place (no controller / no hit)
      px = hit.x;
      pz = hit.z;
    }

    if (mode === "placing-start") {
      pts.start = { x: px, z: pz };
      pts.end = null;
      this.setMode("placing-end");
    } else if (mode === "placing-end") {
      if (pts.start === null) {
        // Defensive: lost the start somehow — treat this as the start instead.
        pts.start = { x: px, z: pz };
        this.setMode("placing-end");
        return;
      }
      // Reject a degenerate (too-short) placement: keep waiting for the end.
      // The trigger DID fire, so say why nothing happened (#17) instead of
      // silently swallowing the press.
      const dx = px - pts.start.x;
      const dz = pz - pts.start.z;
      if (Math.hypot(dx, dz) < 0.4) {
        this.postNotice(MAP_TOO_SHORT_NOTICE);
        return;
      }

      pts.end = { x: px, z: pz };
      this.rebuildDraft();
      this.setReticle(null); // hide the reticle once both ends are down
      this.setMode("adjust");
    }
  }

  private setWidth(w: number): void {
    const clamped = clamp(w, LAYOUT_LIMITS.minWidth, LAYOUT_LIMITS.maxWidth);
    this.draftWidth = clamped;
    // Only meaningful with two points down (adjust); rebuild the draft.
    const pts = this.points();
    if (pts !== null && pts.start !== null && pts.end !== null) {
      this.rebuildDraft();
    }
  }

  /** Publish a (straight) mapped layout as the active SHAPE — the source of
   * truth, which persists itself. Mapping always produces straight runways. */
  private commitLayout(layout: RunwayLayout): void {
    if (this.shapeSig !== undefined) {
      this.shapeSig.value = straightShapeFromLayout(layout);
    }
  }

  private commit(): void {
    const draft = this.globals.draftLayout as RunwayLayout | null | undefined;
    if (draft === null || draft === undefined) {
      // Nothing formed — just leave mapping cleanly.
      this.cancelMapping();
      return;
    }
    const final = sanitizeLayout(draft);
    this.commitLayout(final);
    this.clearPoints();
    this.setDraft(null);
    this.setReticle(null);
    this.setMode("off");
  }

  // -- autoMapFromFloor: real plane detection + graceful default ------------

  /** "Fit to room" — ARM the fit + try immediately, then keep tracking the floor
   * as it converges (see {@link applyFitStep} + the update() settle loop). If no
   * floor plane is ready yet (Quest planes converge a beat after entry), stay
   * armed; 'qualify' + the re-poll retry the fit when one appears. NO fixed-number
   * fallback — that path (firing against an empty plane query) was exactly the
   * "snaps to set numbers" the founder reported. */
  private autoMapFromFloor(): void {
    // Refuse while the mapping flow owns the panel (hud-state.ts
    // mapFlowActive is the twin truth table on the HUD side): a landed fit
    // force-cancels the in-flight mapping and discards the placed points
    // (applyFitStep's clearPoints/setMode("off") tail). Single chokepoint —
    // covers the left X/Y gesture, the settings set-fit button, and the
    // landing AUTO-FIT. Rule #17: the press DID fire, so say why nothing
    // happened; onMapNotice flashes only while mapMode != "off", exactly when
    // this fires.
    const mode = this.modeSig !== undefined ? this.modeSig.peek() : "off";
    if (mode !== "off") {
      this.postNotice(MAP_FIT_BLOCKED_NOTICE);
      return;
    }
    this.autoFitArmed = true;
    this.lastFit = null;
    this.settleSince = 0;
    this.firstFitSince = 0;
    this.reEvalSince = 0;
    this.noFloorSince = 0;
    this.refitPending = false;
    // #15: the trainee armed the fit — say so on the panel. If a floor is
    // already usable, applyFitStep flips this to "fitted" synchronously; if
    // not, "Looking for your floor..." shows until a plane arrives or the
    // no-floor grace period escalates it to the actionable hint.
    this.setFitStatus("searching");
    if (this.applyFitStep()) this.settleSince = 0;
  }

  /** Attempt one fit step against the CURRENT detected floor. Applies the fit
   * (scaled + centred + oriented, preserving straight/T/X/U) ONLY when it has
   * meaningfully changed from the last applied fit, and returns whether it did —
   * so the caller can rebuild the stage at most once per real change. No-ops (and
   * stays armed) when no usable floor plane exists yet. */
  private applyFitStep(): boolean {
    if (!this.autoFitArmed) return false;
    const floor = this.findFloorPlane();
    if (floor === null) {
      if (!this.warnedNoPlane) {
        this.warnedNoPlane = true;
        console.info(
          "[(X)RUNWAY] Fit to room: no floor plane yet — look down at your " +
            "floor. Quest plane detection needs a saved Space + granted " +
            "spatial-data permission; the runway fits the moment one appears.",
        );
      }
      return false; // stay armed —'qualify' + the re-poll retry
    }
    // Skip if the floor hasn't meaningfully changed since the last applied fit.
    if (this.lastFit !== null && floorsClose(floor, this.lastFit)) return false;

    if (this.shapeSig !== undefined) {
      this.shapeSig.value = fitShapeToFloorPlane(this.shapeSig.peek(), floor);
    }
    this.lastFit = floor;
    this.setFitStatus("fitted"); // #15: positive confirmation on the panel
    // Clear any half-formed manual mapping state + stale preview.
    this.clearPoints();
    this.setDraft(null);
    this.setReticle(null);
    this.setMode("off");
    return true;
  }

  /**
   * Find the floor among the detected planes and return its world placement +
   * extent (a {@link FloorFit}) for fitShapeToFloorPlane, or null if no usable
   * floor plane exists yet (caller stays armed). Reads each XRPlane entity's
   * world pose + polygon + labels and delegates the geometry + selection to the
   * pure {@link selectFloorFit} (unit-tested with real captured plane data — see
   * floor-fit.ts for the yaw/centroid/label correctness rules).
   */
  private findFloorPlane(): FloorFit | null {
    const entities = this.queries.planes.entities;
    if (entities.size === 0) return null;

    // Build plane samples (fit path, not per-frame — small allocations are fine).
    const samples: PlaneSample[] = [];
    for (const entity of entities) {
      // _plane defaults to `undefined` (not null), so guard with `== null`.
      const plane = entity.getValue(XRPlane, "_plane") as XRPlane | null;
      const obj = entity.object3D;
      if (plane == null || obj === undefined) continue;
      const polygon = plane.polygon;
      if (polygon === undefined || polygon.length === 0) continue;

      obj.getWorldPosition(this.planeCenter);
      obj.getWorldQuaternion(this.planeQuat);
      const poly = polygon.map((p) => ({ x: p.x, z: p.z }));
      samples.push({
        orientation: plane.orientation,
        semanticLabel: plane.semanticLabel,
        polygon: poly,
        position: {
          x: this.planeCenter.x,
          y: this.planeCenter.y,
          z: this.planeCenter.z,
        },
        quaternion: {
          x: this.planeQuat.x,
          y: this.planeQuat.y,
          z: this.planeQuat.z,
          w: this.planeQuat.w,
        },
      });
    }

    return selectFloorFit(samples);
  }

  // -- draft + global-ref helpers (kept tiny, no per-call alloc on hot path) -

  /** Rebuild the draft layout from the two placed points + current width. */
  private rebuildDraft(): void {
    const pts = this.points();
    if (pts === null || pts.start === null || pts.end === null) return;
    const draft = layoutFromEndpoints(
      pts.start.x,
      pts.start.z,
      pts.end.x,
      pts.end.z,
      this.draftWidth,
    );
    this.setDraft(draft);
  }

  private points(): MapPointsRef | null {
    const pts = this.globals.mapPoints as MapPointsRef | undefined;
    return pts ?? null;
  }

  private clearPoints(): void {
    const pts = this.points();
    if (pts !== null) {
      pts.start = null;
      pts.end = null;
    } else {
      this.globals.mapPoints = { start: null, end: null } as MapPointsRef;
    }
  }

  private setDraft(draft: RunwayLayout | null): void {
    this.globals.draftLayout = draft;
  }

  private setReticle(value: FloorPoint | null): void {
    this.globals.reticle = value;
  }

  private setMode(mode: MapMode): void {
    if (this.modeSig !== undefined) {
      this.modeSig.value = mode;
    }
  }

  /** #15: publish a fit-status edge (change-gated — never a per-frame write). */
  private setFitStatus(status: FitStatus): void {
    if (this.fitStatusSig !== undefined && this.fitStatusSig.peek() !== status) {
      this.fitStatusSig.value = status;
    }
  }

  /** #17: publish a one-shot mapping notice (event-driven — a trigger press,
   * never per-frame). A fresh object per event so repeats re-fire subscribers. */
  private postNotice(text: string): void {
    if (this.noticeSig === undefined) return;
    this.noticeSeq += 1;
    this.noticeSig.value = { text, seq: this.noticeSeq };
  }
}

/** Shape of globals.mapPoints — mutable plain ref written as points land. */
interface MapPointsRef {
  start: FloorPoint | null;
  end: FloorPoint | null;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
