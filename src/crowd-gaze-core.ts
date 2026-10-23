/**
 * (X)RUNWAY — A Crowd That Watches You: the pure math (Build: CROWD GAZE).
 *
 * During the countdown + walk, seated figures turn subtly toward the walker;
 * during the pose hold they lean in. The figures are INSTANCED GLB bodies
 * (heads baked into the body sub-meshes), so this is a WHOLE-FIGURE yaw per
 * seat via instance-matrix recomposition — the render side lives in
 * crowd-gaze.ts. Dependency-free (the stage-budget.ts pattern) so the angle
 * laws load in vitest.
 *
 * Display-only spectacle: nothing here feeds scoring.
 */

// Type-only imports — erased at runtime, so this module stays vitest-loadable.
import type { InstancedMesh, Matrix4 } from "@iwsdk/core";

/** One instanced-mesh slot a seat writes (a figure spans several sub-mesh
 * InstancedMeshes at the same instance index; `local` composes an attached
 * prop — the pose-3 phone — after the seat matrix). */
export interface AudienceSeatEntry {
  im: InstancedMesh;
  index: number;
  local: Matrix4 | null;
}

/** One live crowd seat: the frozen base transform + the mesh slots to
 * rewrite, plus the eased turn state (reset naturally on rebuild — the
 * seats array is rebuilt with the stage). All positions/yaws are in the
 * stage-root (spine-local) frame. */
export interface AudienceLiveSeat {
  px: number;
  pz: number;
  baseYaw: number;
  /** The full build-time seat matrix (T·R·S) — recompositions pre-multiply
   * a rotation about the seat origin, never re-derive the base. */
  base: Matrix4;
  entries: AudienceSeatEntry[];
  /** Eased current yaw delta / lean (rad) — CrowdGazeSystem state. */
  curYaw: number;
  curLean: number;
}

/** The live-crowd export the stage publishes on globals.audienceLive after
 * each audience build (null while the crowd is hidden / not built). `rev`
 * bumps per build so the system can drop stale per-run assumptions. */
export interface AudienceLive {
  rev: number;
  seats: AudienceLiveSeat[];
}

/** Max whole-figure turn away from the seated base facing (rad, ±). A seated
 * person swivels their shoulders a little — never an owl. ~30 deg. */
export const CROWD_TURN_MAX_RAD = 0.52;

/** Lean-in pitch during the pose hold (rad, toward the runway). ~7 deg —
 * legible at crowd scale without reading as a bow. */
export const CROWD_LEAN_MAX_RAD = 0.12;

/** Ease rate (1/s) for both channels — a slow, human head-turn feel. */
export const CROWD_EASE_RATE = 2.2;

/** Seconds between crowd matrix passes (~10 Hz — the GPU-crash history's
 * law: never per-frame full-crowd work). */
export const CROWD_TICK_SEC = 0.1;

/** Below this |delta| (rad) a seat is considered settled — its matrix is
 * not rewritten and its mesh not re-uploaded. */
export const CROWD_SETTLE_EPS_RAD = 0.004;

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * The clamped yaw DELTA (rad) a seat applies to face the walker: the
 * shortest signed angle from the seated base facing to the walker bearing,
 * clamped to ±CROWD_TURN_MAX_RAD. Frames: seat position + base yaw and the
 * walker position share one frame (the stage-root local frame); a +Z-facing
 * figure under rotation.y = a looks toward (sin a, cos a) — the pit's
 * convention.
 */
export function seatTurnTarget(
  baseYaw: number,
  seatX: number,
  seatZ: number,
  walkerX: number,
  walkerZ: number,
): number {
  const desired = Math.atan2(walkerX - seatX, walkerZ - seatZ);
  const delta = wrapAngle(desired - baseYaw);
  return delta > CROWD_TURN_MAX_RAD
    ? CROWD_TURN_MAX_RAD
    : delta < -CROWD_TURN_MAX_RAD
      ? -CROWD_TURN_MAX_RAD
      : delta;
}

/** Frame-rate-independent exponential ease of `cur` toward `target`. */
export function easeAngle(cur: number, target: number, dtSec: number): number {
  return cur + (target - cur) * (1 - Math.exp(-CROWD_EASE_RATE * dtSec));
}

/** True while the show phase has a walker to watch (countdown + walk). The
 * summary/idle path targets 0 so the crowd settles back to its base pose —
 * the "reset at walk end" law, via the same ease. */
export function crowdTracksPhase(phase: string): boolean {
  return phase === "countdown" || phase === "walk";
}
