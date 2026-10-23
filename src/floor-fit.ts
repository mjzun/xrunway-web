/**
 * (X)RUNWAY — floor-plane → {@link FloorFit} selection (pure, dependency-free).
 *
 * This is the load-bearing extraction behind "Fit to room": given the WebXR
 * planes the headset has detected, pick THE FLOOR and describe it as a FloorFit
 * (world center + in-plane yaw + extent) that {@link fitShapeToFloorPlane} snaps
 * the runway onto. MappingSystem.findFloorPlane() reads the live XRPlane entities
 * and delegates the geometry + selection here, so this can be unit-tested with
 * real captured plane data (plane detection can't run in a headless sandbox).
 *
 * Three correctness rules a multi-agent device review surfaced (all invisible to
 * the IWER emulator, which coincidentally dodged each):
 *
 *  • YAW from the plane's WORLD QUATERNION, not Object3D.rotation.y. The Euler
 *    'XYZ' decomposition of a pure-Y rotation flips to the complementary gimbal
 *    branch once |yaw| > 90°, returning π − yaw — so reading `.y` lands the
 *    runway up to 90° wrong for ~half of real room orientations. We instead map
 *    the plane-local +Z axis through the quaternion and project it to the world
 *    XZ plane: yaw = atan2(−x, −z), matching the runway spine's (−sin, −cos)
 *    forward convention (see runway-layout.ts).
 *
 *  • CENTER on the polygon's bbox CENTROID (in world), not the plane's pose
 *    origin. WebXR does not guarantee the pose origin sits at the polygon centre
 *    (corner-origin / offset / L-shaped floors are legal), so centring on the
 *    pose origin slides the runway off the real floor.
 *
 *  • SELECT the floor by semanticLabel when present: prefer planes labelled
 *    "floor", and never accept a plane labelled as known furniture/ceiling.
 *    Plane detection surfaces planes incrementally, so a table can be the only
 *    horizontal plane present at the instant the fit fires — without this gate
 *    the runway commits to the tabletop and disarms. When no usable floor is
 *    present we return null so the caller stays armed and re-fits when the real
 *    floor converges. Falls back to the geometric "lowest, largest horizontal"
 *    rule for runtimes that don't populate semanticLabel.
 */

import type { FloorFit } from "./runway-shape.js";

/** A 2-D point of a plane polygon, in the plane's LOCAL frame (X-Z, y ≈ 0). */
export interface PlanePoint {
  x: number;
  z: number;
}

/**
 * One detected plane, reduced to what floor selection needs. MappingSystem
 * builds these from the XRPlane entities: `position`/`quaternion` are the
 * plane's WORLD pose (object3D.getWorldPosition / getWorldQuaternion), `polygon`
 * is `plane.polygon` (plane-local X-Z), and the labels come straight off the
 * WebXR plane object.
 */
export interface PlaneSample {
  orientation: string | undefined;
  semanticLabel: string | undefined;
  polygon: ReadonlyArray<PlanePoint>;
  position: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
}

/** Horizontal labels that are explicitly NOT the floor (so we never fit to them). */
const NON_FLOOR_LABELS = new Set<string>([
  "ceiling",
  "table",
  "desk",
  "couch",
  "sofa",
  "shelf",
  "storage",
  "bed",
  "counter",
  "nightstand",
  "lamp",
  "plant",
  "screen",
  "wall art",
]);

/** Rotate vector (vx,vy,vz) by a (not-necessarily-normalized) quaternion. The
 * standard t = 2·(q_xyz × v); v' = v + q_w·t + q_xyz × t — three.js' formula. */
function rotateByQuat(
  vx: number,
  vy: number,
  vz: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): [number, number, number] {
  // Normalize the quaternion (a real-device pose quat is unit, but guard anyway).
  const n = Math.hypot(qx, qy, qz, qw) || 1;
  qx /= n;
  qy /= n;
  qz /= n;
  qw /= n;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

/** Don't let the non-rectangular inscribe shrink the floor below half its bbox. */
const MIN_FILL = 0.5;

interface FloorCandidate {
  sample: PlaneSample;
  label: string | undefined;
  /** World Y of the polygon centroid (for the lowest-plane rule). */
  worldY: number;
  /** Local polygon bbox area (selection: lowest then largest). */
  bboxArea: number;
  /** |shoelace| of the local polygon (the floor's true area, for the inscribe). */
  polyArea: number;
}

/** Reduce one PlaneSample to a floor candidate, or null if it can't be one
 * (not horizontal, no polygon, or degenerate extent). */
function toCandidate(s: PlaneSample): FloorCandidate | null {
  if (s.orientation !== "horizontal") return null;
  const poly = s.polygon;
  if (poly === undefined || poly.length === 0) return null;

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const extentX = maxX - minX;
  const extentZ = maxZ - minZ;
  if (!(extentX > 0) || !(extentZ > 0)) return null;

  // World Y of the polygon centroid (in-plane offset rotated into world).
  const [, cy] = rotateByQuat(
    (minX + maxX) / 2,
    0,
    (minZ + maxZ) / 2,
    s.quaternion.x,
    s.quaternion.y,
    s.quaternion.z,
    s.quaternion.w,
  );

  return {
    sample: s,
    label: normalizeLabel(s.semanticLabel),
    worldY: s.position.y + cy,
    bboxArea: extentX * extentZ,
    polyArea: Math.abs(shoelaceArea(poly)),
  };
}

function normalizeLabel(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  const t = label.trim().toLowerCase();
  return t.length === 0 ? undefined : t;
}

/** Signed area of a polygon in the X-Z plane (shoelace). */
function shoelaceArea(poly: ReadonlyArray<PlanePoint>): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j].x * poly[i].z - poly[i].x * poly[j].z;
  }
  return a / 2;
}

/**
 * Combine a set of coplanar floor planes into one oriented {@link FloorFit}.
 *
 * Real headsets often report the floor as SEVERAL planes (open-plan / L-shaped
 * rooms, re-scans), so fitting only the largest fragment under-sizes + off-centres
 * the runway. We pick the largest plane as the orientation reference, project every
 * plane's polygon into that reference frame, and take the union bounding box —
 * giving the whole floor's extent + centre + yaw.
 *
 * For a non-rectangular floor (one L-shaped polygon, or fragments that don't tile
 * their bbox) the axis-aligned bbox over-states the usable floor, so we shrink the
 * extent by an area-based fill factor (sqrt of covered-area / bbox-area, floored at
 * MIN_FILL). This is a conservative best-effort that only ever SHRINKS — a single
 * rectangular floor (true area == bbox area) is unaffected, so it's a no-op for the
 * common case and a safety pull-in for the rare non-rectangular one.
 */
function buildFloorFit(set: FloorCandidate[]): FloorFit {
  // Orientation reference: the largest plane (most reliable polygon + pose).
  let ref = set[0];
  for (const c of set) if (c.bboxArea > ref.bboxArea) ref = c;
  const rq = ref.sample.quaternion;
  const rp = ref.sample.position;

  // Collect every plane's polygon points in the REFERENCE plane's local frame:
  //   refLocal = R(rq)^-1 · (worldPoint - refPos),  worldPoint = pos + R(q)·local.
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let floorArea = 0;
  for (const c of set) {
    const q = c.sample.quaternion;
    const p = c.sample.position;
    floorArea += c.polyArea;
    for (const pt of c.sample.polygon) {
      const [wx, wy, wz] = rotateByQuat(pt.x, 0, pt.z, q.x, q.y, q.z, q.w);
      const [lx, , lz] = rotateByQuat(
        p.x + wx - rp.x,
        p.y + wy - rp.y,
        p.z + wz - rp.z,
        -rq.x,
        -rq.y,
        -rq.z,
        rq.w,
      );
      if (lx < minX) minX = lx;
      if (lx > maxX) maxX = lx;
      if (lz < minZ) minZ = lz;
      if (lz > maxZ) maxZ = lz;
    }
  }
  let extentX = maxX - minX;
  let extentZ = maxZ - minZ;

  // Non-rectangular inscribe: shrink toward the covered area (no-op for a rect).
  const bboxArea = extentX * extentZ;
  if (bboxArea > 0) {
    let fill = Math.sqrt(floorArea / bboxArea);
    // Snap to an exact no-op within FP tolerance: a real rectangular floor on a
    // device quaternion has area == bbox up to rounding, so this keeps a true
    // rectangle byte-identical (no microscopic shrink) while still pulling in a
    // genuinely non-rectangular floor (an L-shape fill ≈ 0.87 is well below this).
    if (fill > 1 - 1e-9) fill = 1;
    if (fill < MIN_FILL) fill = MIN_FILL;
    extentX *= fill;
    extentZ *= fill;
  }

  // Union bbox centre (ref-local) → world; yaw from the reference local +Z axis.
  const [cx, , cz] = rotateByQuat(
    (minX + maxX) / 2,
    0,
    (minZ + maxZ) / 2,
    rq.x,
    rq.y,
    rq.z,
    rq.w,
  );
  const [ax, , az] = rotateByQuat(0, 0, 1, rq.x, rq.y, rq.z, rq.w);

  return {
    centerX: rp.x + cx,
    centerZ: rp.z + cz,
    yaw: Math.atan2(-ax, -az),
    extentX,
    extentZ,
  };
}

/**
 * Choose the floor from the detected planes and describe it as a {@link FloorFit}.
 * Returns null when no usable floor is present yet (caller should stay armed):
 * either no horizontal plane at all, or the only horizontal planes are explicitly
 * non-floor (a table/ceiling/etc.) — we never fit the runway onto those.
 *
 * When several planes make up the floor (fragments / open-plan rooms) they are
 * unioned into one fit (see {@link buildFloorFit}).
 */
export function selectFloorFit(samples: Iterable<PlaneSample>): FloorFit | null {
  const cands: FloorCandidate[] = [];
  for (const s of samples) {
    const c = toCandidate(s);
    if (c !== null) cands.push(c);
  }
  if (cands.length === 0) return null;

  // 1) If anything is explicitly labelled "floor", the floor is exactly those.
  let set = cands.filter((c) => c.label === "floor");
  if (set.length === 0) {
    // 2) Otherwise drop planes labelled as known non-floor surfaces; the floor is
    //    the lowest LEVEL of what remains (unknown/unlabelled planes are eligible).
    const eligible = cands.filter(
      (c) => c.label === undefined || !NON_FLOOR_LABELS.has(c.label),
    );
    // Only non-floor furniture present → no floor yet; stay armed (return null).
    if (eligible.length === 0) return null;
    let lowestY = Number.POSITIVE_INFINITY;
    for (const c of eligible) if (c.worldY < lowestY) lowestY = c.worldY;
    // Everything within 0.1 m of the lowest plane is the floor level (union it).
    set = eligible.filter((c) => c.worldY <= lowestY + 0.1);
  }

  return buildFloorFit(set);
}

/**
 * Whether two floor fits are close enough to treat as "the same floor" — used to
 * suppress redundant re-fits while the floor converges (so the stage isn't rebuilt
 * for sub-threshold jitter). Yaw is compared in FULL (normalized to [-π, π]); we
 * deliberately do NOT fold a 180° flip to "equal": although the floor RECTANGLE
 * looks identical flipped, an asymmetric runway (a T/X/U footprint is offset from
 * the spine) lands metres away under a yaw→yaw+π flip — so a tangent-basis flip
 * (which buildFloorFit can emit when the largest fragment changes) IS a real
 * change that must re-fit. A straight runway is genuinely 180°-symmetric, so the
 * worst case there is one redundant rebuild to the identical placement.
 */
export function floorsClose(a: FloorFit, b: FloorFit): boolean {
  if (Math.abs(a.centerX - b.centerX) >= 0.04) return false;
  if (Math.abs(a.centerZ - b.centerZ) >= 0.04) return false;
  if (Math.abs(a.extentX - b.extentX) >= 0.08) return false;
  if (Math.abs(a.extentZ - b.extentZ) >= 0.08) return false;
  let d = (a.yaw - b.yaw) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d) < 0.02;
}
