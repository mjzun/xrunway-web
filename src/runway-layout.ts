/**
 * (X)RUNWAY — Live runway mapping model.
 *
 * The whole point of (X)RUNWAY's licensing tier: a user (or an agency) maps the
 * virtual runway onto THEIR real floor. Everything that used to be hard-coded to
 * "runs down world -Z, centered on x=0" now reads from a single editable
 * `RunwayLayout`, so the deck, live-floor shader, footprints, pose mark,
 * audience, lights, AND the head-tracked walk all re-fit together.
 *
 * Frame convention (yaw = 0 reproduces the original fixed layout):
 *   - The layout is a rectangle on the floor (y = 0): center (cx, cz), rotation
 *     `yaw` about Y, `length` along the walk axis, `width` across.
 *   - FORWARD (start end -> pose end) unit vector  f(yaw) = (-sin, 0, -cos)
 *       yaw 0  -> (0, 0, -1)   (away from the trainee, original behaviour)
 *   - RIGHT (lateral +) unit vector               r(yaw) = ( cos, 0, -sin)
 *       yaw 0  -> (1, 0,  0)   (+X)
 *   - `along`   in [0, length]: 0 at the START (near) end, length at the POSE
 *     (far) end.  `lateral` is the signed distance from the centerline.
 *
 * The trainee begins just behind the start end and walks along 0 -> POSE_ALONG
 * and back. show.ts/metrics.ts project the head into (along, lateral) every
 * frame via a reusable {@link RunwayProjector} (zero allocation).
 */

import { DECK_CENTER_Z, STAGE } from "./theme.js";

/** A point on the floor (world meters), y implied 0. */
export interface RunwayPoint {
  x: number;
  z: number;
}

export interface RunwayLayout {
  /** World X of the runway center, on the floor. */
  centerX: number;
  /** World Z of the runway center, on the floor. */
  centerZ: number;
  /** Rotation about +Y, radians. 0 = walk toward -Z (original layout). */
  yaw: number;
  /** Length along the walk axis, meters. */
  length: number;
  /** Width across, meters. */
  width: number;
}

/** Pose mark inset from the FAR end (m) — "walk to the mark". */
export const POSE_INSET = 0.6;
/** Start/finish line inset from the NEAR end (m). */
export const START_INSET = 0.15;

/** Editable bounds (HUD sliders + walk-and-place clamp to these). */
export const LAYOUT_LIMITS = {
  minLength: 3,
  // True-to-size: real runways run long (Grand Palais / VS ≈ 50–60 m). We render
  // and SCORE at true length and assume the user has the space (their call).
  maxLength: 80,
  minWidth: 0.8,
  maxWidth: 3,
  /** How far from the AR origin the center may sit. Raised with maxLength so a
   * long runway can be positioned with its start near the user. */
  maxOffset: 45,
} as const;

/** The original REV2 placement, expressed as a layout. */
export const DEFAULT_LAYOUT: RunwayLayout = {
  centerX: 0,
  centerZ: DECK_CENTER_Z,
  yaw: 0,
  length: STAGE.deckLength,
  width: STAGE.deckWidth,
};

/** Along-coordinate of the pose mark for a given layout. */
export function poseAlong(layout: RunwayLayout): number {
  return Math.max(0, layout.length - POSE_INSET);
}

/**
 * Runway-local (along, lateral) -> world floor point. Inverse of
 * {@link RunwayProjector} (same unit-tested frame). Used by the preview-walk
 * demo to drive the viewer down the centerline.
 */
export function alongLateralToWorld(
  layout: RunwayLayout,
  along: number,
  lateral: number,
  out?: RunwayPoint,
): RunwayPoint {
  const s = Math.sin(layout.yaw);
  const c = Math.cos(layout.yaw);
  const d = along - layout.length / 2;
  const x = layout.centerX + -s * d + c * lateral;
  const z = layout.centerZ + -c * d + -s * lateral;
  if (out) {
    out.x = x;
    out.z = z;
    return out;
  }
  return { x, z };
}

/** Along-coordinate of the start/finish line (layout-independent). */
export function startAlong(): number {
  return START_INSET;
}

function clamp(v: number, lo: number, hi: number): number {
  // Coerce first: corrupt stored JSON can reach here as a non-number through
  // `?? default` (which only catches null/undefined). Without `+v`, a string
  // like "abc" slips past the comparisons unclamped → NaN projection → the walk
  // gets stuck. `+"abc"` is NaN, and `NaN >= lo` is false, so it falls to `lo`.
  const n = +v;
  return n >= lo ? (n <= hi ? n : hi) : lo;
}

/** Clamp a (possibly user/auto supplied) layout into the editable bounds. */
export function sanitizeLayout(p: Partial<RunwayLayout>): RunwayLayout {
  const L = LAYOUT_LIMITS;
  return {
    centerX: clamp(p.centerX ?? DEFAULT_LAYOUT.centerX, -L.maxOffset, L.maxOffset),
    centerZ: clamp(p.centerZ ?? DEFAULT_LAYOUT.centerZ, -L.maxOffset, L.maxOffset),
    // yaw isn't clamped, so coerce a corrupt non-number to 0 (else NaN yaw).
    yaw: (Number.isFinite(p.yaw as number) ? (p.yaw as number) : 0) % (Math.PI * 2),
    length: clamp(p.length ?? DEFAULT_LAYOUT.length, L.minLength, L.maxLength),
    width: clamp(p.width ?? DEFAULT_LAYOUT.width, L.minWidth, L.maxWidth),
  };
}

export function layoutsEqual(a: RunwayLayout, b: RunwayLayout): boolean {
  return (
    Math.abs(a.centerX - b.centerX) < 1e-4 &&
    Math.abs(a.centerZ - b.centerZ) < 1e-4 &&
    Math.abs(a.yaw - b.yaw) < 1e-4 &&
    Math.abs(a.length - b.length) < 1e-4 &&
    Math.abs(a.width - b.width) < 1e-4
  );
}

/**
 * Build a layout from two floor points (the walk-and-place flow): the trainee
 * marks where they START and where they END (the pose mark). The runway is the
 * rectangle whose centerline runs start -> end, with the given width.
 */
export function layoutFromEndpoints(
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
  width: number,
): RunwayLayout {
  const dx = endX - startX;
  const dz = endZ - startZ;
  // Walked distance is START_INSET .. (length - POSE_INSET); recover full length.
  const walked = Math.hypot(dx, dz);
  const length = walked + START_INSET + POSE_INSET;
  // forward = normalize(end - start); solve yaw from f = (-sin, 0, -cos).
  const yaw = Math.atan2(-dx, -dz);
  // Center is the midpoint of the FULL rectangle (push back by START_INSET at
  // the near end and forward by POSE_INSET at the far end -> net shift along f).
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  // start end of the rectangle sits START_INSET behind the marked start point.
  const rectStartX = startX - fx * START_INSET;
  const rectStartZ = startZ - fz * START_INSET;
  const centerX = rectStartX + fx * (length / 2);
  const centerZ = rectStartZ + fz * (length / 2);
  return sanitizeLayout({ centerX, centerZ, yaw, length, width });
}

/**
 * Reusable projector: world (x, z) -> runway-local (along, lateral). Hold ONE
 * per system, call {@link set} whenever the layout signal changes, and call
 * {@link along}/{@link lateral} in update() — pure scalar math, zero allocation.
 */
export class RunwayProjector {
  private fx = 0;
  private fz = -1;
  private rx = 1;
  private rz = 0;
  private cx = 0;
  private cz = DEFAULT_LAYOUT.centerZ;
  length = DEFAULT_LAYOUT.length;
  width = DEFAULT_LAYOUT.width;

  constructor(layout: RunwayLayout = DEFAULT_LAYOUT) {
    this.set(layout);
  }

  set(layout: RunwayLayout): void {
    const s = Math.sin(layout.yaw);
    const c = Math.cos(layout.yaw);
    this.fx = -s;
    this.fz = -c;
    this.rx = c;
    this.rz = -s;
    this.cx = layout.centerX;
    this.cz = layout.centerZ;
    this.length = layout.length;
    this.width = layout.width;
  }

  /** along in [0, length]: 0 at the start (near) end, length at the pose end. */
  along(px: number, pz: number): number {
    const dx = px - this.cx;
    const dz = pz - this.cz;
    return dx * this.fx + dz * this.fz + this.length / 2;
  }

  /** Signed lateral distance from the centerline (m). */
  lateral(px: number, pz: number): number {
    const dx = px - this.cx;
    const dz = pz - this.cz;
    return dx * this.rx + dz * this.rz;
  }

  /** along as a 0..1 fraction (clamped) — for the floor shader's uStepZ. */
  alongFraction(px: number, pz: number): number {
    const a = this.along(px, pz) / this.length;
    return a < 0 ? 0 : a > 1 ? 1 : a;
  }
}

// ---------------------------------------------------------------------------
// Persistence — survives reloads and the work-laptop -> home-Mac handoff.
// ---------------------------------------------------------------------------

const STORAGE_KEY = "xrunway.runwayLayout.v1";

export function loadLayout(): RunwayLayout {
  try {
    const raw =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(STORAGE_KEY)
        : null;
    if (!raw) return { ...DEFAULT_LAYOUT };
    return sanitizeLayout(JSON.parse(raw) as Partial<RunwayLayout>);
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function saveLayout(layout: RunwayLayout): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    }
  } catch {
    /* storage unavailable (private mode / headless) — non-fatal. */
  }
}
