/**
 * (X)RUNWAY — Movement-driven footstep emitter (the floor's reaction trigger).
 *
 * The live floor sends an expanding ring out from each footstep (it reads
 * `globals.lastStep`). This emits a footstep every stride of HORIZONTAL travel —
 * whether you move by the preview auto-walk, the XR thumbstick, or WASD — so the
 * floor reacts to movement in every mode, like walking through a puddle. It is
 * the SOLE driver of `globals.lastStep`.
 *
 * SHAPE-AWARE: the RunwayPathProjector routes each strike to the SEGMENT it
 * landed on (spine vs a T/X/U arm) and publishes `{ time, z, seg }`, so the
 * ripple fires on the correct deck — step onto the crossbar, the crossbar
 * ripples. Zero per-frame allocation.
 */

import { createSystem, Vector3 } from "@iwsdk/core";
import type { Signal } from "@preact/signals-core";

import { RunwayPathProjector, type SegmentedPath } from "./runway-shape.js";

/** Meters of horizontal travel between emitted footsteps. */
const STRIDE = 0.6;
/** A single-frame move larger than this is a teleport (rig snap to the start
 *  line, snap-back at finish, snap-turn/teleport locomotion), not a stride —
 *  never a real footfall at 72-90 Hz, so it must not accumulate. */
const MAX_STEP_DELTA = STRIDE * 4;

export class FloorRippleSystem extends createSystem({}, {}) {
  private projector!: RunwayPathProjector;
  private head!: Vector3;
  private lastX = 0;
  private lastZ = 0;
  private have = false;
  private accum = 0;
  /** Reused step ref published as globals.lastStep (never re-allocated). */
  private step = { time: 0, z: 0, seg: 0 };

  init(): void {
    this.projector = new RunwayPathProjector();
    this.head = new Vector3();
    const pathSig = this.globals.compiledPath as
      | Signal<SegmentedPath>
      | undefined;
    if (pathSig !== undefined) {
      this.projector.set(pathSig.peek());
      this.cleanupFuncs.push(pathSig.subscribe((p) => this.projector.set(p)));
    }
  }

  update(_delta: number, time: number): void {
    this.player.head.getWorldPosition(this.head);
    const x = this.head.x;
    const z = this.head.z;
    if (!this.have) {
      this.lastX = x;
      this.lastZ = z;
      this.have = true;
      return;
    }
    // Reject teleport-sized jumps (the rig snaps to the start line at walk start
    // and back at finish; snap-turn/teleport locomotion also jumps) — they are
    // not strides and would otherwise dump a burst of phantom ripples. Always
    // advance last{X,Z} so the next frame re-seeds from the new position.
    const d = Math.hypot(x - this.lastX, z - this.lastZ);
    this.lastX = x;
    this.lastZ = z;
    if (d < MAX_STEP_DELTA) this.accum += d;
    if (this.accum >= STRIDE) {
      this.accum -= STRIDE;
      const p = this.projector.project(x, z);
      this.step.time = time;
      this.step.z = p.localFrac; // 0..1 within the struck segment
      this.step.seg = p.segIndex;
      this.globals.lastStep = this.step;
    }
  }
}
