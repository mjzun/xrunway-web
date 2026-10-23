/**
 * (X)RUNWAY — A Crowd That Watches You (the ECS side; pure math in
 * crowd-gaze-core.ts).
 *
 * During the countdown + walk, every SEATED figure turns subtly toward the
 * walker (whole-figure yaw — heads are baked into the instanced bodies);
 * during the pose hold the crowd leans in with the hold's own ramp
 * (globals.holdLive.t01). Outside a run the same ease settles everyone back
 * to their base pose. The photographer pit never registers (it already
 * faces the pose mark).
 *
 * GPU discipline (the crash history's law):
 * - NO rebuilds, ever — only instance-matrix rewrites of seats the stage
 *   exported at build time (globals.audienceLive, published by
 *   buildShapeAudience for BOTH the GLB and procedural crowds).
 * - Throttled to CROWD_TICK_SEC (~10 Hz); a settled seat (delta under
 *   CROWD_SETTLE_EPS_RAD) is not rewritten and its buffer not re-uploaded.
 * - Zero per-frame allocation: three scratch matrices + one vector.
 * - Rebuild-safe: the stage nulls audienceLive before every rebuild and
 *   publishes a fresh seats array after; identity change here just swaps
 *   the pointer (fresh state, disposed meshes never touched again).
 * - crowdVisible gating is free: a hidden crowd never publishes seats.
 *
 * Display-only spectacle — nothing here reads into scoring.
 */

import { createSystem, Matrix4, Vector3 } from "@iwsdk/core";
import type { Signal } from "@preact/signals-core";

import {
  CROWD_LEAN_MAX_RAD,
  CROWD_SETTLE_EPS_RAD,
  CROWD_TICK_SEC,
  crowdTracksPhase,
  easeAngle,
  seatTurnTarget,
  type AudienceLive,
} from "./crowd-gaze-core.js";
import type { SegmentedPath } from "./runway-shape.js";
import type { ShowPhaseValue } from "./show.js";

export class CrowdGazeSystem extends createSystem({}, {}) {
  private phaseSig!: Signal<ShowPhaseValue>;
  private pathSig!: Signal<SegmentedPath>;

  private tickAcc = 0;
  private live: AudienceLive | null = null;

  private headWorld!: Vector3;
  private mRot!: Matrix4;
  private mLean!: Matrix4;
  private mOut!: Matrix4;

  init(): void {
    this.phaseSig = this.globals.showPhase as Signal<ShowPhaseValue>;
    this.pathSig = this.globals.compiledPath as Signal<SegmentedPath>;
    this.headWorld = new Vector3();
    this.mRot = new Matrix4();
    this.mLean = new Matrix4();
    this.mOut = new Matrix4();
  }

  update(delta: number): void {
    const live = this.globals.audienceLive as AudienceLive | null | undefined;
    if (!live || live.seats.length === 0) {
      this.live = null;
      return;
    }
    if (live !== this.live) {
      // Fresh build — fresh per-seat state ships inside the seats array.
      this.live = live;
      this.tickAcc = 0;
    }

    // ~10 Hz: accumulate real time, run one pass per tick window.
    this.tickAcc += delta;
    if (this.tickAcc < CROWD_TICK_SEC) return;
    const dt = this.tickAcc;
    this.tickAcc = 0;

    const tracking = crowdTracksPhase(this.phaseSig.peek());
    // Walker head in the STAGE-ROOT (spine-local) frame — the seats' frame.
    // (head world y is irrelevant: the turn is yaw-only.)
    let wx = 0;
    let wz = 0;
    if (tracking) {
      this.player.head.getWorldPosition(this.headWorld);
      const spine = this.pathSig.peek().segments[0].rect;
      const c = Math.cos(spine.yaw);
      const s = Math.sin(spine.yaw);
      const dx = this.headWorld.x - spine.centerX;
      const dz = this.headWorld.z - spine.centerZ;
      // Inverse of the stage-root placement (world = R_y(yaw)·local + center).
      wx = dx * c - dz * s;
      wz = dx * s + dz * c;
    }
    // Pose-hold lean ramp (0..1) — only meaningful mid-walk; the plain-ref
    // holdLive is nulled outside a run (show.ts).
    const holdLive = this.globals.holdLive as { t01: number } | null | undefined;
    const leanTarget =
      tracking && holdLive ? CROWD_LEAN_MAX_RAD * holdLive.t01 : 0;

    for (const seat of live.seats) {
      const yawTarget = tracking
        ? seatTurnTarget(seat.baseYaw, seat.px, seat.pz, wx, wz)
        : 0;
      const nextYaw = easeAngle(seat.curYaw, yawTarget, dt);
      const nextLean = easeAngle(seat.curLean, leanTarget, dt);
      // Settled seat (at target, delta negligible) — skip the rewrite AND
      // the buffer upload entirely.
      if (
        Math.abs(nextYaw - seat.curYaw) < CROWD_SETTLE_EPS_RAD &&
        Math.abs(nextLean - seat.curLean) < CROWD_SETTLE_EPS_RAD &&
        Math.abs(nextYaw - yawTarget) < CROWD_SETTLE_EPS_RAD &&
        Math.abs(nextLean - leanTarget) < CROWD_SETTLE_EPS_RAD
      ) {
        continue;
      }
      seat.curYaw = nextYaw;
      seat.curLean = nextLean;

      // Recompose about the seat's own origin: M' = T(p)·R·T(-p)·base.
      // R = yaw about +Y, then the lean about the CURRENT facing's lateral
      // axis (a rotation-X in the figure's yawed frame). Built from scratch
      // matrices — zero allocation.
      const facing = seat.baseYaw + nextYaw;
      this.mRot.makeRotationY(nextYaw);
      if (nextLean !== 0) {
        // Lean axis = the figure's local X after facing: pre-rotate into the
        // facing frame, pitch, rotate back — R_y(f)·R_x(lean)·R_y(-f) —
        // then compose with the yaw delta. Equivalent compact form:
        // R = R_y(nextYaw) · [R_y(bf)·R_x(lean)·R_y(-bf)] with bf = baseYaw;
        // built as R_y(facing)·R_x(lean)·R_y(-baseYaw).
        this.mRot.makeRotationY(facing);
        this.mLean.makeRotationX(nextLean);
        this.mRot.multiply(this.mLean);
        this.mLean.makeRotationY(-seat.baseYaw);
        this.mRot.multiply(this.mLean);
      }
      // Rotate about the seat origin (px, 0, pz): fold T(p)·R·T(-p) into
      // mRot by rewriting its translation column: t = p - R·p.
      const e = this.mRot.elements;
      const rx = e[0] * seat.px + e[8] * seat.pz;
      const ry = e[1] * seat.px + e[9] * seat.pz;
      const rz = e[2] * seat.px + e[10] * seat.pz;
      e[12] = seat.px - rx;
      e[13] = -ry;
      e[14] = seat.pz - rz;

      for (const entry of seat.entries) {
        this.mOut.multiplyMatrices(this.mRot, seat.base);
        if (entry.local !== null) this.mOut.multiply(entry.local);
        entry.im.setMatrixAt(entry.index, this.mOut);
        entry.im.instanceMatrix.needsUpdate = true;
      }
    }
  }
}
