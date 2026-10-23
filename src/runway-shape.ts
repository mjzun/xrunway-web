/**
 * (X)RUNWAY — Parametric runway SHAPE model (straight / T / X / U).
 *
 * This is the EDITABLE model the user, HUD, presets, and persistence touch. It
 * sits ON TOP of the proven per-segment primitive in runway-layout.ts: a
 * `RunwayShape` is compiled (once per remap, never per-frame) into a
 * `SegmentedPath` — N straight `RunwayLayout` rectangles laid along a walk
 * route. The straight case is the degenerate single-segment path, so straight
 * runways stay byte-identical to today (compileShape(DEFAULT_SHAPE).segments[0]
 * .rect deep-equals DEFAULT_LAYOUT — locked by a unit test).
 *
 * All kinds are fully compiled: straight = one spine; T/X = spine + crossbar
 * arm(s); U = legA → base → legB (walkRoute = [0,1,2]). The stage, projector,
 * floor and scored walk all consume the multi-segment route, so a T/X/U renders
 * + walks its whole geometry. Straight remains the degenerate single-segment
 * case (byte-identical to the original app).
 */

import {
  alongLateralToWorld,
  DEFAULT_LAYOUT,
  LAYOUT_LIMITS,
  loadLayout,
  POSE_INSET,
  poseAlong,
  RunwayProjector,
  type RunwayLayout,
  type RunwayPoint,
} from "./runway-layout.js";

export type RunwayShapeKind = "straight" | "T" | "X" | "U";

/** The editable runway model (same floor frame as RunwayLayout). */
export interface RunwayShape {
  kind: RunwayShapeKind;
  /** World X/Z of the shape's reference center; rotation about +Y (radians). */
  centerX: number;
  centerZ: number;
  yaw: number;
  /** Spine length / width (m). For "straight" these ARE length/width. */
  spineLength: number;
  spineWidth: number;
  /** Arm reach per side + arm deck width (m) — T/X/U only; 0 for straight. */
  armSpan: number;
  armWidth: number;
  /** Fraction 0..1 of spineLength where the arms branch (T/X). */
  crossAt: number;
}

/** One compiled straight piece — IS a localized RunwayLayout. */
export interface RunwaySegment {
  rect: RunwayLayout;
  /** Cumulative WALK-ROUTE arc-length where this segment's local along=0. */
  along0: number;
  role: "spine" | "arm";
  armSide: -1 | 0 | 1;
}

/** The compiled runtime model every SYSTEM consumes. */
export interface SegmentedPath {
  kind: RunwayShapeKind;
  segments: RunwaySegment[];
  /** Ordered segment indices the SCORED walk follows. */
  walkRoute: number[];
  /** Σ route-segment lengths — the 0..1 progress denominator. */
  totalAlong: number;
  /** Route-along of the pose mark (on the terminal route segment). */
  poseRouteAlong: number;
}

/** Arm bounds (added alongside LAYOUT_LIMITS; spine reuses LAYOUT_LIMITS). */
export const SHAPE_LIMITS = {
  minArmSpan: 0,
  maxArmSpan: 24,
  minArmWidth: 0.8,
  maxArmWidth: 6,
  minCrossAt: 0.15,
  maxCrossAt: 0.9,
} as const;

/** World Z of the default runway's NEAR (start) end — presets align here. */
const NEAR_END_Z = DEFAULT_LAYOUT.centerZ + DEFAULT_LAYOUT.length / 2;

function clamp(v: number, lo: number, hi: number): number {
  // Coerce first: corrupt stored JSON can reach here as a non-number through
  // `?? default`. Without `+v`, a string like "abc" slips past the comparisons
  // unclamped → NaN compile/projection. `+"abc"` is NaN and `NaN >= lo` is
  // false, so it falls to `lo`.
  const n = +v;
  return n >= lo ? (n <= hi ? n : hi) : lo;
}

/** The straight default — provably reproduces DEFAULT_LAYOUT. */
export const DEFAULT_SHAPE: RunwayShape = straightShapeFromLayout(DEFAULT_LAYOUT);

/** Lift a (legacy) RunwayLayout to the degenerate straight shape. */
export function straightShapeFromLayout(layout: RunwayLayout): RunwayShape {
  return {
    kind: "straight",
    centerX: layout.centerX,
    centerZ: layout.centerZ,
    yaw: layout.yaw,
    spineLength: layout.length,
    spineWidth: layout.width,
    armSpan: 0,
    armWidth: layout.width,
    crossAt: 0.5,
  };
}

/** Clamp any (user/preset/auto) shape into the editable bounds. */
export function sanitizeShape(p: Partial<RunwayShape>): RunwayShape {
  const L = LAYOUT_LIMITS;
  const S = SHAPE_LIMITS;
  const kind: RunwayShapeKind =
    p.kind === "T" || p.kind === "X" || p.kind === "U" ? p.kind : "straight";
  const spineWidth = clamp(
    p.spineWidth ?? DEFAULT_SHAPE.spineWidth,
    L.minWidth,
    L.maxWidth,
  );
  // Arms must be at least as long as they are wide (no degenerate stub).
  const armWidth = clamp(
    p.armWidth ?? spineWidth,
    S.minArmWidth,
    S.maxArmWidth,
  );
  const armSpan =
    kind === "straight"
      ? 0
      : clamp(
          Math.max(p.armSpan ?? 0, armWidth),
          S.minArmSpan,
          S.maxArmSpan,
        );
  return {
    kind,
    centerX: clamp(p.centerX ?? DEFAULT_SHAPE.centerX, -L.maxOffset, L.maxOffset),
    centerZ: clamp(p.centerZ ?? DEFAULT_SHAPE.centerZ, -L.maxOffset, L.maxOffset),
    // yaw isn't clamped, so coerce a corrupt non-number to 0 (else NaN yaw).
    yaw: (Number.isFinite(p.yaw as number) ? (p.yaw as number) : 0) % (Math.PI * 2),
    spineLength: clamp(
      p.spineLength ?? DEFAULT_SHAPE.spineLength,
      L.minLength,
      L.maxLength,
    ),
    spineWidth,
    armSpan,
    armWidth,
    crossAt: clamp(p.crossAt ?? 0.5, S.minCrossAt, S.maxCrossAt),
  };
}

/**
 * Re-anchor a LENGTH edit to the START LINE (the Quest tester's "the smaller
 * you make it, once you get to the end it throws you off"): length edits used
 * to grow/shrink the runway about its CENTER, so shrinking the default 7 m to
 * 3 m pulled the near end 2 m AWAY from the trainee standing at the start —
 * and every origin-pivoting gesture then threw farther (the rig pivots about
 * the XR origin, not the head). Keep the START world point (along =
 * START_INSET, the line the trainee stands on) FIXED instead, by shifting the
 * center half the CLAMPED length delta along the walk axis
 * (-sin yaw, -cos yaw): worldStart = center + walkAxis * (START_INSET - L/2),
 * so center' = center + walkAxis * (L' - L) / 2 keeps it still.
 *
 * LENGTH edits only — the callers guard: width/yaw/arm edits and the explicit
 * POSITION sliders must not shift the center. Composite shapes (T/X/U)
 * translate rigidly with the center, so the same shift anchors their route
 * start. The preset library is already near-end-anchored (straightShape);
 * this extends the same law to the editors. Pure; clamps the requested
 * length FIRST so a clamped drag never walks the start line
 * (sanitizeShape's ±maxOffset center clamp can still bite at the extremes —
 * bounds-tested, acceptable).
 */
export function anchorStartOnLengthEdit(
  prev: RunwayShape,
  nextLength: number,
): RunwayShape {
  const L = LAYOUT_LIMITS;
  const newLen = clamp(nextLength, L.minLength, L.maxLength);
  const dL = newLen - prev.spineLength;
  if (dL === 0) return prev;
  return sanitizeShape({
    ...prev,
    spineLength: newLen,
    centerX: prev.centerX - Math.sin(prev.yaw) * (dL / 2),
    centerZ: prev.centerZ - Math.cos(prev.yaw) * (dL / 2),
  });
}

/** A detected real-world floor plane to fit a runway into. centerX/Z + yaw are
 * the plane's world placement; extentX/Z are its size along the plane's local
 * axes (meters). */
export interface FloorFit {
  centerX: number;
  centerZ: number;
  yaw: number;
  extentX: number;
  extentZ: number;
}

/**
 * Scale + center + orient a runway SHAPE to fit within a detected floor plane,
 * PRESERVING the shape (straight/T/X/U). The shape's footprint (the bbox of its
 * compiled outline) is scaled uniformly to fit the floor extent (with a margin),
 * its long axis aligned to the floor's long axis, and the footprint centered on
 * the floor. Returns a new sanitized shape; never mutates the input. Pure.
 */
export function fitShapeToFloorPlane(
  shape: RunwayShape,
  floor: FloorFit,
  margin = 0.3,
): RunwayShape {
  const plan = shapeFloorPlan(compileShape(shape));
  const footW = plan.width || 0.1; // footprint across (root-local x)
  const footL = plan.length || 0.1; // footprint along (root-local z, the spine)
  const footLong = Math.max(footW, footL);
  const footShort = Math.min(footW, footL);

  const fLong = Math.max(floor.extentX, floor.extentZ);
  const fShort = Math.min(floor.extentX, floor.extentZ);
  const floorLongAlongX = floor.extentX >= floor.extentZ;

  // Uniform scale so the footprint fits the floor (long->long, short->short).
  let scale = Math.min((fLong - margin) / footLong, (fShort - margin) / footShort);
  if (!(scale > 0)) scale = 0.1; // degenerate-floor guard

  // Spine yaw that lays the footprint's LONG axis along the floor's long axis.
  // The runway spine runs along root-local z; floor.yaw (+90° if the long extent
  // is the plane's local X) is the long-axis world yaw. If the footprint's long
  // axis is the spine (footL>=footW) align spine->long; else add 90°.
  const floorSpineYaw = floor.yaw + (floorLongAlongX ? Math.PI / 2 : 0);
  const yaw = footL >= footW ? floorSpineYaw : floorSpineYaw + Math.PI / 2;

  // Scale the dimensions and CLAMP them (sanitizeShape enforces the size limits)
  // BEFORE solving the centre. Centering off the pre-clamp footprint would land an
  // asymmetric T/X/U off-centre — its footprint is offset from the spine, so when
  // a small floor forces a width/length clamp the real footprint centre shifts and
  // the deck spills past the floor edge it was meant to fit inside.
  let scaled = sanitizeShape({
    ...shape,
    spineLength: shape.spineLength * scale,
    spineWidth: shape.spineWidth * scale,
    armSpan: shape.armSpan * scale,
    armWidth: shape.armWidth * scale,
    yaw,
  });

  // The scale above was solved from the PRE-clamp footprint, but sanitizeShape's
  // min-dimension clamps can INFLATE the actual footprint past the floor for a
  // T/X/U on a small floor (e.g. armWidth/armSpan pinned to their minima add deck
  // the scale didn't budget for) — so the runway pokes past the real floor edge.
  // Iteratively pull the dims back in until the CLAMPED footprint fits, stopping
  // if a dimension is pinned at its minimum (a genuinely-too-small floor, which
  // then spills but stays centred below, exactly as before this refinement).
  const availLong = fLong - margin;
  const availShort = fShort - margin;
  if (availLong > 0 && availShort > 0) {
    const overOf = (sh: RunwayShape): number => {
      const p = shapeFloorPlan(compileShape(sh));
      return Math.max(
        Math.max(p.width, p.length) / availLong,
        Math.min(p.width, p.length) / availShort,
      );
    };
    for (let i = 0; i < 4; i++) {
      const over = overOf(scaled);
      if (over <= 1 + 1e-6) break;
      const k = 1 / over;
      const next = sanitizeShape({
        ...scaled,
        spineLength: scaled.spineLength * k,
        spineWidth: scaled.spineWidth * k,
        armSpan: scaled.armSpan * k,
        armWidth: scaled.armWidth * k,
        yaw,
      });
      // Only keep the shrink if it actually reduced the overflow. If it didn't,
      // the binding (over-driving) dimension is pinned at its minimum — the floor
      // is genuinely too small on that axis, so stop rather than uselessly
      // shrinking the OTHER (already-fitting) axis (which would under-size the
      // runway; e.g. a wide straight runway on a floor shorter than minLength).
      if (overOf(next) >= over - 1e-4) break;
      scaled = next;
    }
  }

  // Centre the FOOTPRINT (not the spine) on the floor centre, using the footprint
  // of the CLAMPED shape. shapeFloorPlan is spine-local (offsets from the spine
  // centre, un-rotated), so (lx,lz) is placement-independent; this inverts the
  // world-footprint transform exactly, so the fitted footprint centre == floor
  // centre regardless of any clamp.
  const fitPlan = shapeFloorPlan(compileShape(scaled));
  const lx = (fitPlan.minX + fitPlan.maxX) / 2;
  const lz = (fitPlan.minZ + fitPlan.maxZ) / 2;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const centerX = floor.centerX - (c * lx + s * lz);
  const centerZ = floor.centerZ - (-s * lx + c * lz);

  return sanitizeShape({ ...scaled, centerX, centerZ });
}

/** The spine as a plain RunwayLayout rectangle (no inset — insets are applied
 * by poseAlong/startAlong, exactly as the straight runway does today). */
function spineRect(shape: RunwayShape): RunwayLayout {
  return {
    centerX: shape.centerX,
    centerZ: shape.centerZ,
    yaw: shape.yaw,
    length: shape.spineLength,
    width: shape.spineWidth,
  };
}

/**
 * Compile a RunwayShape into the runtime SegmentedPath. Pure — call once per
 * (re)map, NEVER in update().
 *
 * ALL kinds compile to their full geometry + a multi-segment walk route:
 * straight = one spine; T/X = spine + crossbar arm(s); U = legA → base → legB
 * (walkRoute = [0,1,2]) with cumulative `along0` per segment, so routeToWorld
 * (forward) and projectRoute/globalAlong (inverse) sweep continuously across
 * every segment. poseRouteAlong = the pose mark's distance ALONG that route
 * (far end of legB for a U), so the demo + scored walk traverse the whole shape.
 */
export function compileShape(shape: RunwayShape): SegmentedPath {
  const spine = spineRect(shape);
  const spineSeg: RunwaySegment = {
    rect: spine,
    along0: 0,
    role: "spine",
    armSide: 0,
  };
  const path: SegmentedPath = {
    kind: shape.kind,
    segments: [spineSeg],
    walkRoute: [0],
    totalAlong: spine.length,
    poseRouteAlong: poseAlong(spine),
  };

  if (shape.kind === "T" || shape.kind === "X") {
    // A perpendicular crossbar segment: at the spine's FAR end for a classic T,
    // or at `crossAt` along the spine for an X (a "+" you walk straight through,
    // the (X) mark landing on the crossing). The SCORED walk is still the full
    // spine — the crossbar is a show reveal you can step onto — so the walk/pose
    // math is unchanged vs a straight runway.
    const crossPos =
      shape.kind === "T" ? spine.length : shape.crossAt * spine.length;
    const j = alongLateralToWorld(spine, crossPos, 0);
    const armRect: RunwayLayout = {
      centerX: j.x,
      centerZ: j.z,
      yaw: spine.yaw + Math.PI / 2,
      length: Math.max(2 * shape.armSpan, shape.armWidth),
      width: shape.armWidth,
    };
    path.segments = [
      spineSeg,
      { rect: armRect, along0: 0, role: "arm", armSide: 0 },
    ];
  }

  if (shape.kind === "U") {
    // Horseshoe: two parallel legs joined by a base, walked legA -> base -> legB
    // (a true different-start/finish round trip). Build each segment in the
    // shape's local frame ((lx, lz) with local -z forward, +x right), then map
    // to world. Each segment's yaw points along its WALK direction so demo-walk
    // + the route projector get the heading for free.
    const half = spine.length / 2;
    const arm = shape.armSpan; // half the leg separation (base half-length)
    const cs = Math.cos(shape.yaw);
    const sn = Math.sin(shape.yaw);
    const local = (
      lx: number,
      lz: number,
      yawLocal: number,
      len: number,
      along0: number,
      role: "spine" | "arm",
      width: number,
    ): RunwaySegment => ({
      rect: {
        centerX: shape.centerX + lx * cs + lz * sn,
        centerZ: shape.centerZ - lx * sn + lz * cs,
        yaw: shape.yaw + yawLocal,
        length: len,
        width,
      },
      along0,
      role,
      armSide: 0,
    });
    // legA: left side, forward (local -z). base: bottom, rightward (+x).
    // legB: right side, backward (local +z) up to the finish. The two legs are
    // the runway proper (spineWidth); the base is the connector (armWidth).
    const legA = local(-arm, 0, 0, spine.length, 0, "spine", shape.spineWidth);
    const base = local(0, -half, -Math.PI / 2, 2 * arm, spine.length, "arm", shape.armWidth);
    const legB = local(
      arm,
      0,
      Math.PI,
      spine.length,
      spine.length + 2 * arm,
      "arm",
      shape.spineWidth,
    );
    path.segments = [legA, base, legB];
    path.walkRoute = [0, 1, 2];
    path.totalAlong = 2 * spine.length + 2 * arm;
    path.poseRouteAlong = Math.max(0, path.totalAlong - POSE_INSET);
  }

  return path;
}

/** The active spine RunwayLayout for a shape — what today's systems consume. */
export function shapeToActiveLayout(shape: RunwayShape): RunwayLayout {
  return compileShape(shape).segments[0].rect;
}

/** One segment of a shape resolved into the STAGE-ROOT-LOCAL frame. */
export interface FloorPlanSegment {
  /** Center in stage-root-local space (root = segments[0] center + yaw). */
  cx: number;
  cz: number;
  /** Yaw relative to the stage root. */
  yaw: number;
  length: number;
  width: number;
  role: "spine" | "arm";
}

/**
 * A shape resolved for the UNIFIED deck/floor: every segment in stage-root-local
 * space plus the axis-aligned bounding box in that frame. The single continuous
 * floor mesh is tessellated over these segments (arms notched against the spine
 * so nothing overlaps), and every vertex's `uv` is its position normalized into
 * this bbox — the shared coordinate space the reactive-floor shader reads
 * (`uDeck` = { width, length }). For a straight runway this reduces to the spine
 * rect, byte-for-byte as before.
 */
export interface FloorPlan {
  segments: FloorPlanSegment[];
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** Bounding-box size in meters — the reactive floor's `uDeck`. */
  width: number;
  length: number;
}

/**
 * The shape's OUTLINE as one closed loop of [x, z] points in stage-root-local
 * space, CCW. The segments are axis-aligned in that frame (yaw is a multiple of
 * 90°), so the union of their rectangles is a rectilinear polygon computed
 * exactly (no grid artifacts): take every rect edge as a grid line, mark which
 * cells are covered, and trace the boundary (shared edges between two covered
 * cells cancel). Drives the perimeter edge-strips + the extruded deck outline;
 * collinear run points are kept so corner-rounding can pick the true corners.
 */
export function shapeOutline(plan: FloorPlan): Array<[number, number]> {
  const rects = plan.segments.map((s) => {
    const cx = Math.abs(Math.cos(s.yaw));
    const sx = Math.abs(Math.sin(s.yaw));
    const hx = cx * (s.width / 2) + sx * (s.length / 2);
    const hz = sx * (s.width / 2) + cx * (s.length / 2);
    return { x0: s.cx - hx, x1: s.cx + hx, z0: s.cz - hz, z1: s.cz + hz };
  });
  const uniq = (vals: number[]): number[] =>
    [...new Set(vals.map((v) => +v.toFixed(5)))].sort((a, b) => a - b);
  const xs = uniq(rects.flatMap((r) => [r.x0, r.x1]));
  const zs = uniq(rects.flatMap((r) => [r.z0, r.z1]));
  const nx = xs.length - 1;
  const nz = zs.length - 1;
  const covered = (i: number, j: number): boolean => {
    const mx = (xs[i] + xs[i + 1]) / 2;
    const mz = (zs[j] + zs[j + 1]) / 2;
    return rects.some((r) => mx > r.x0 && mx < r.x1 && mz > r.z0 && mz < r.z1);
  };
  // Directed boundary edges keyed by grid index; opposite directions cancel.
  const edges = new Map<string, [number, number, number, number]>();
  const key = (ax: number, az: number, bx: number, bz: number): string =>
    `${ax},${az}->${bx},${bz}`;
  const addEdge = (ax: number, az: number, bx: number, bz: number): void => {
    const opp = key(bx, bz, ax, az);
    if (edges.has(opp)) edges.delete(opp);
    else edges.set(key(ax, az, bx, bz), [ax, az, bx, bz]);
  };
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      if (!covered(i, j)) continue;
      addEdge(i, j, i + 1, j); // bottom (+x)
      addEdge(i + 1, j, i + 1, j + 1); // right (+z)
      addEdge(i + 1, j + 1, i, j + 1); // top (-x)
      addEdge(i, j + 1, i, j); // left (-z)
    }
  }
  // Stitch the directed edges into a loop (from any start, follow end->start).
  if (edges.size === 0) return [];
  const startFrom = new Map<string, [number, number, number, number]>();
  for (const e of edges.values()) startFrom.set(`${e[0]},${e[1]}`, e);
  const loop: Array<[number, number]> = [];
  let cur = edges.values().next().value as [number, number, number, number];
  const first = `${cur[0]},${cur[1]}`;
  for (let guard = 0; guard < edges.size + 1; guard++) {
    loop.push([xs[cur[0]], zs[cur[1]]]);
    const nextKey = `${cur[2]},${cur[3]}`;
    if (nextKey === first) break;
    const next = startFrom.get(nextKey);
    if (!next) break;
    cur = next;
  }
  return loop;
}

/**
 * Round the corners of a CCW outline loop into short circular arcs. CONVEX
 * corners (the outer silhouette) round by `convexR`; CONCAVE corners (a T/X/U's
 * re-entrant junction notches + the U courtyard) round by `concaveR`. Each
 * radius is clamped to half the shorter adjacent edge. Rounding BOTH is what
 * removes the hard 90° L-notches at junctions — without the concave pass a T/X/U
 * deck still reads as boxes fused at sharp interior corners. `concaveR <= 0`
 * keeps concave corners sharp (the straight runway uses convexR=0 too -> no-op).
 */
export function roundOutline(
  pts: Array<[number, number]>,
  convexR: number,
  concaveR = 0,
  steps = 5,
): Array<[number, number]> {
  const n = pts.length;
  if (n < 3 || (convexR <= 0 && concaveR <= 0)) {
    return pts.map((p) => [p[0], p[1]] as [number, number]);
  }
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    let ix = p1[0] - p0[0];
    let iy = p1[1] - p0[1];
    const li = Math.hypot(ix, iy) || 1;
    ix /= li;
    iy /= li;
    let ox = p2[0] - p1[0];
    let oy = p2[1] - p1[1];
    const lo = Math.hypot(ox, oy) || 1;
    ox /= lo;
    oy /= lo;
    const cross = ix * oy - iy * ox; // > 0 = convex (left turn) for a CCW loop
    const convex = cross > 1e-6;
    const concave = cross < -1e-6;
    const want = convex ? convexR : concave ? concaveR : 0;
    const rr = Math.min(want, li / 2, lo / 2);
    if (rr < 1e-4) {
      out.push([p1[0], p1[1]]); // straight, or this radius disabled -> sharp
      continue;
    }
    // arc center = a + (left normal of incoming edge) * rr, flipped to the void
    // side for a concave (reflex) corner so the fillet bulges across the notch.
    const s = convex ? 1 : -1;
    const a: [number, number] = [p1[0] - ix * rr, p1[1] - iy * rr];
    const cx = a[0] + -iy * rr * s;
    const cz = a[1] + ix * rr * s;
    const b: [number, number] = [p1[0] + ox * rr, p1[1] + oy * rr];
    const a0 = Math.atan2(a[1] - cz, a[0] - cx);
    let dA = Math.atan2(b[1] - cz, b[0] - cx) - a0;
    while (dA > Math.PI) dA -= 2 * Math.PI;
    while (dA < -Math.PI) dA += 2 * Math.PI;
    for (let k = 0; k <= steps; k++) {
      const t = a0 + dA * (k / steps);
      out.push([cx + Math.cos(t) * rr, cz + Math.sin(t) * rr]);
    }
  }
  return out;
}

/** Point-in-polygon (ray cast) for a loop of [x, z] points. */
export function pointInPolygon(
  x: number,
  z: number,
  poly: Array<[number, number]>,
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function shapeFloorPlan(path: SegmentedPath): FloorPlan {
  const root = path.segments[0].rect;
  const cs = Math.cos(root.yaw);
  const sn = Math.sin(root.yaw);
  const segments: FloorPlanSegment[] = [];
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const s of path.segments) {
    const r = s.rect;
    const dx = r.centerX - root.centerX;
    const dz = r.centerZ - root.centerZ;
    // Match the stage sub-root placement: rotate (Δcenter) into spine-local.
    const cx = dx * cs - dz * sn;
    const cz = dx * sn + dz * cs;
    const yaw = r.yaw - root.yaw;
    segments.push({ cx, cz, yaw, length: r.length, width: r.width, role: s.role });
    // 4 corners in root-local (along dir = (-sin,-cos), lateral dir = (cos,-sin)).
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);
    const hl = r.length / 2;
    const hw = r.width / 2;
    for (const dA of [-hl, hl]) {
      for (const dL of [-hw, hw]) {
        const px = cx + dA * -sy + dL * cy;
        const pz = cz + dA * -cy + dL * -sy;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (pz < minZ) minZ = pz;
        if (pz > maxZ) maxZ = pz;
      }
    }
  }
  return {
    segments,
    minX,
    minZ,
    maxX,
    maxZ,
    width: maxX - minX,
    length: maxZ - minZ,
  };
}

/** A world point plus a heading (yaw) — the result of {@link routeToWorld}. */
export interface RoutePoint {
  x: number;
  z: number;
  yaw: number;
}

/**
 * Inverse of the route projection: a route-along distance [0, totalAlong] + a
 * lateral offset -> world point + heading (the active segment's yaw), walking
 * the walkRoute segment by segment. Drives demo-walk (and any scripted walk)
 * along a multi-segment route such as a U. For straight/T/X the route is one
 * segment, so this reduces to alongLateralToWorld on the spine.
 *
 * Writes into `out` (the heading too) and returns it — zero allocation, so it's
 * safe in the per-frame demo update path. A fresh `out` is allocated only when
 * the caller omits it.
 */
export function routeToWorld(
  path: SegmentedPath,
  routeAlong: number,
  lateral: number,
  out: RoutePoint = { x: 0, z: 0, yaw: 0 },
): RoutePoint {
  let r = routeAlong < 0 ? 0 : routeAlong;
  for (let k = 0; k < path.walkRoute.length; k++) {
    const seg = path.segments[path.walkRoute[k]];
    const len = seg.rect.length;
    const last = k === path.walkRoute.length - 1;
    if (r <= len || last) {
      const a = r < 0 ? 0 : r > len ? len : r;
      alongLateralToWorld(seg.rect, a, lateral, out); // writes x,z into out
      out.yaw = seg.rect.yaw;
      return out;
    }
    r -= len;
  }
  const r0 = path.segments[0].rect;
  out.x = r0.centerX;
  out.z = r0.centerZ;
  out.yaw = r0.yaw;
  return out;
}

/**
 * Projects world (x, z) onto a compiled SegmentedPath: composes one
 * RunwayProjector per segment and picks the NEAREST, with hysteresis so the
 * chosen segment doesn't flicker at a junction and a route-order tie-break for
 * colinear segments (an X's spine-near vs spine-far). Reuses its result object
 * (zero allocation in project()). Drives per-segment footstep ripples.
 */
export class RunwayPathProjector {
  private projs: RunwayProjector[] = [];
  private segs: RunwaySegment[] = [];
  private route: number[] = [0];
  private total = 1;
  private lastSeg = 0;
  private lastRouteK = 0;
  private readonly out = { segIndex: 0, alongLocal: 0, lateral: 0, localFrac: 0 };
  private readonly outRoute = { globalAlong: 0, lateral: 0, alongFrac: 0, yaw: 0 };

  set(path: SegmentedPath): void {
    this.segs = path.segments;
    this.route = path.walkRoute;
    this.total = path.totalAlong;
    while (this.projs.length < this.segs.length) {
      this.projs.push(new RunwayProjector());
    }
    for (let i = 0; i < this.segs.length; i++) {
      this.projs[i].set(this.segs[i].rect);
    }
    if (this.lastSeg >= this.segs.length) this.lastSeg = 0;
    if (this.lastRouteK >= this.route.length) this.lastRouteK = 0;
  }

  /**
   * Projects onto the WALK ROUTE only (the scored path) and returns the
   * CUMULATIVE route-along (globalAlong) + signed lateral. For straight/T/X the
   * route is one segment, so this matches RunwayProjector.along/lateral on the
   * spine; for a U it spans legA -> base -> legB continuously. Used by show +
   * metrics for progress. Reuses its result object (zero alloc).
   *
   * `yaw` (M8, additive) = the ACTIVE walk segment's rect yaw, which IS its
   * WALK-direction heading ("Each segment's yaw points along its WALK
   * direction", compileShape U) — the same heading routeToWorld reports for
   * the same route-along. On out-and-back routes the walk direction reverses
   * after the mark; that flip is the CONSUMER's (the segment itself never
   * changes heading).
   */
  projectRoute(
    px: number,
    pz: number,
  ): { globalAlong: number; lateral: number; alongFrac: number; yaw: number } {
    let bestK = 0;
    let bestScore = Infinity;
    let bestAlong = 0;
    let bestLat = 0;
    for (let k = 0; k < this.route.length; k++) {
      const seg = this.segs[this.route[k]];
      const p = this.projs[this.route[k]];
      if (!seg || !p) continue;
      const len = p.length;
      const a = p.along(px, pz);
      const clamped = a < 0 ? 0 : a > len ? len : a;
      const lat = p.lateral(px, pz);
      const over = a - clamped;
      const dist = Math.hypot(lat, over);
      // Sticky route segment (anti-flicker at a corner).
      const score = k === this.lastRouteK ? dist - 0.15 : dist;
      if (score < bestScore) {
        bestScore = score;
        bestK = k;
        bestAlong = clamped;
        bestLat = lat;
      }
    }
    this.lastRouteK = bestK;
    const seg = this.segs[this.route[bestK]];
    const globalAlong = (seg ? seg.along0 : 0) + bestAlong;
    this.outRoute.globalAlong = globalAlong;
    this.outRoute.lateral = bestLat;
    this.outRoute.alongFrac = this.total > 0 ? globalAlong / this.total : 0;
    this.outRoute.yaw = seg ? seg.rect.yaw : 0;
    return this.outRoute;
  }

  /** Nearest segment + its local along / lateral for a world point. */
  project(
    px: number,
    pz: number,
  ): { segIndex: number; alongLocal: number; lateral: number; localFrac: number } {
    let best = 0;
    let bestScore = Infinity;
    let bestAlong = 0;
    let bestLat = 0;
    for (let i = 0; i < this.segs.length; i++) {
      const p = this.projs[i];
      const len = p.length;
      const a = p.along(px, pz);
      const clamped = a < 0 ? 0 : a > len ? len : a;
      const lat = p.lateral(px, pz);
      const over = a - clamped; // 0 inside the segment, else overshoot past an end
      const dist = Math.hypot(lat, over);
      // Stick with the current segment unless clearly beaten (anti-flicker), and
      // break exact ties by ascending segment index — i.e. route order, with the
      // spine first. (along0 was used here, but an X's spine AND crossbar are both
      // along0:0, so that tie-break was a no-op and the crossing flickered.)
      let score = i === this.lastSeg ? dist - 0.15 : dist;
      score += i * 1e-6;
      if (score < bestScore) {
        bestScore = score;
        best = i;
        bestAlong = clamped;
        bestLat = lat;
      }
    }
    this.lastSeg = best;
    const len = this.segs[best]?.rect.length ?? 1;
    this.out.segIndex = best;
    this.out.alongLocal = bestAlong;
    this.out.lateral = bestLat;
    this.out.localFrac = len > 0 ? bestAlong / len : 0;
    return this.out;
  }
}

// ---------------------------------------------------------------------------
// Preset library — 14 fact-checked runways (true real-world dimensions).
// Lengths/widths are the verified spec; T/X/U presets carry arm params that
// compile to full multi-segment runways. caveat captures the honesty notes.
// ---------------------------------------------------------------------------

export type PresetCategory = "regulation" | "famous" | "training";

export interface RunwayPreset {
  id: string;
  name: string;
  category: PresetCategory;
  blurb: string;
  caveat?: string;
  shape: RunwayShape;
}

function straightShape(spineLength: number, spineWidth: number): RunwayShape {
  return {
    kind: "straight",
    centerX: 0,
    centerZ: NEAR_END_Z - spineLength / 2,
    yaw: 0,
    spineLength,
    spineWidth,
    armSpan: 0,
    armWidth: spineWidth,
    crossAt: 0.5,
  };
}

function tShape(
  spineLength: number,
  spineWidth: number,
  armSpan: number,
  armWidth: number,
): RunwayShape {
  return {
    kind: "T",
    centerX: 0,
    centerZ: NEAR_END_Z - spineLength / 2,
    yaw: 0,
    spineLength,
    spineWidth,
    armSpan,
    armWidth,
    crossAt: 0.88,
  };
}

export const PRESET_RUNWAYS: ReadonlyArray<RunwayPreset> = [
  // --- regulation / industry standard ---
  {
    id: "reg-standard-straight",
    name: "Standard Straight",
    category: "regulation",
    blurb:
      "The industry workhorse — a clean linear catwalk at the most-cited show length. Your default training stage.",
    caveat: "No global regulator exists; 20×1.2 m sits mid-range of the 15–30 m norm.",
    shape: straightShape(20, 1.2),
  },
  {
    id: "reg-compact-instudio",
    name: "Compact In-Studio",
    category: "regulation",
    blurb:
      "The intimate showroom setup — short run, front-row-close, nowhere to hide a wobble.",
    shape: straightShape(12, 1.2),
  },
  {
    id: "reg-t-runway",
    name: "Classic T-Runway",
    category: "regulation",
    blurb:
      "The signature silhouette — a long spine opening into a crossbar so you pause and turn for both sides of the house.",
    caveat: "Crossbar (≈5–10 m wide) renders in the shape update; trains on the spine for now.",
    shape: tShape(24, 1.2, 3, 1.2),
  },
  {
    id: "reg-wide-showcase",
    name: "Wide Two-Way Showcase",
    category: "regulation",
    blurb:
      "Built for volume — couture trains, paired exits, models passing without crowding.",
    shape: straightShape(18, 2),
  },
  // --- famous venues / shows ---
  {
    id: "famous-grand-palais-chanel",
    name: "Grand Palais (Chanel)",
    category: "famous",
    blurb:
      "Chanel's cathedral of fashion — under Europe's largest glass dome, the walk to match the most theatrical address in Paris.",
    caveat: "Chanel builds custom sculptural sets; 60×1.5 m is a defensible long-show value.",
    shape: straightShape(60, 1.5),
  },
  {
    id: "famous-spring-studios-nyfw",
    name: "Spring Studios (NYFW)",
    category: "famous",
    blurb:
      "The white-box heart of New York Fashion Week — a column-free Tribeca floor, minimal and modern, all about the walk.",
    caveat: "Runways are custom per show; 32 m is a defensible straight-run estimate.",
    shape: straightShape(32, 1.2),
  },
  {
    id: "famous-180-strand-lfw",
    name: "180 The Strand (LFW)",
    category: "famous",
    blurb:
      "London's brutalist runway — raw 1970s concrete off Somerset House, home of the British Fashion Council's main catwalk.",
    caveat: "Venue confirmed; 30 m length is an estimate (runways are custom-built).",
    shape: straightShape(30, 1.2),
  },
  {
    id: "famous-armani-teatro-milan",
    name: "Armani/Teatro (Milan)",
    category: "famous",
    blurb:
      "Giorgio Armani's own stage — a Tadao Ando show theatre purpose-built for one house's vision. Precision for a precision walk.",
    caveat: "Permanent venue confirmed; 36 m is an estimate (configured per collection).",
    shape: straightShape(36, 1.2),
  },
  {
    id: "famous-vs-fashion-show",
    name: "Victoria's Secret Spectacle",
    category: "famous",
    blurb:
      "The most-watched walk on television — a multi-segment spine branching through themed zones lined with wings. Pure showbiz.",
    caveat: "Layout reported, exact dimensions not published; 50×1.5 m is a training estimate.",
    shape: tShape(50, 1.5, 3.5, 1.5),
  },
  {
    id: "famous-wijnegem-record",
    name: "World's Longest Catwalk",
    category: "famous",
    blurb:
      "The Guinness World Record — the real thing ran 2,292 m through a Belgian mall; here, scaled to a stage you can finish.",
    caveat: "True record is 2,292 m (Wijnegem, 2011); capped at 60 m as a marathon preset.",
    shape: straightShape(60, 1.2),
  },
  {
    id: "famous-mcqueen-platos-atlantis",
    name: "McQueen 'Plato's Atlantis'",
    category: "famous",
    blurb:
      "The runway that went live to the world — McQueen's white-tiled lab corridor flanked by two robotic camera arms. SS10.",
    caveat: "First live-streamed show (2009); ≈30 m straight runway is approximate.",
    shape: straightShape(30, 1.2),
  },
  // --- training drills ---
  {
    id: "training-beginner-short",
    name: "Beginner Short Walk",
    category: "training",
    blurb:
      "Start here — a short, forgiving runway with room to breathe. Find your rhythm, nail the turn, then stretch out.",
    shape: straightShape(8, 1.5),
  },
  {
    id: "training-narrow-precision",
    name: "Narrow Precision Line",
    category: "training",
    blurb:
      "Walk the line — a deliberately tight strip that punishes drift and rewards a clean, straight track.",
    shape: straightShape(16, 0.8),
  },
  {
    id: "training-fullshow-endurance",
    name: "Full-Show Endurance",
    category: "training",
    blurb:
      "Go the distance — a long catwalk demanding a sustained, even cadence and a strong finish at the tip.",
    shape: straightShape(40, 1.2),
  },
];

// ---------------------------------------------------------------------------
// Persistence — the ACTIVE shape + a library of named SAVED runways.
// ---------------------------------------------------------------------------

const SHAPE_KEY = "xrunway.runwayShape.v1";
const SAVED_KEY = "xrunway.savedRunways.v1";

/**
 * Load the active runway shape. Precedence (explicit, no collision): the new
 * shape key wins; else MIGRATE the legacy single-rectangle layout; else default.
 */
export function loadShape(): RunwayShape {
  try {
    const raw =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(SHAPE_KEY)
        : null;
    if (raw) return sanitizeShape(JSON.parse(raw) as Partial<RunwayShape>);
  } catch {
    /* fall through to migration / default */
  }
  // No shape stored yet — lift the legacy RunwayLayout (or its default).
  return straightShapeFromLayout(loadLayout());
}

export function saveShape(shape: RunwayShape): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(SHAPE_KEY, JSON.stringify(shape));
    }
  } catch {
    /* storage unavailable — non-fatal */
  }
}

/** A named, saved runway in the user's library. */
export interface SavedRunway {
  id: string;
  name: string;
  shape: RunwayShape;
  savedAt: number;
}

/**
 * The user's library of named runways (localStorage-backed). Mirrors the
 * loadLayout/saveLayout pattern, plural: list / save / load / rename / delete.
 */
export class SavedRunwaysStore {
  private items: SavedRunway[] = loadSaved();
  private now: () => number;
  /** Monotonic id counter — NOT items.length, which repeats after a delete and
   * could reuse an id for a save in the same millisecond. */
  private seq = 0;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** Most-recently-saved first. */
  list(): SavedRunway[] {
    return [...this.items].sort((a, b) => b.savedAt - a.savedAt);
  }

  count(): number {
    return this.items.length;
  }

  get(id: string): SavedRunway | null {
    return this.items.find((r) => r.id === id) ?? null;
  }

  /** Save a snapshot of `shape` under `name`; returns the new id. */
  save(name: string, shape: RunwayShape): SavedRunway {
    const trimmed = name.trim() || "Untitled runway";
    const at = this.now();
    const entry: SavedRunway = {
      id: `R-${at}-${this.seq++}`,
      name: trimmed,
      shape: { ...shape },
      savedAt: at,
    };
    this.items.push(entry);
    this.persist();
    return entry;
  }

  rename(id: string, name: string): boolean {
    const r = this.get(id);
    if (!r) return false;
    r.name = name.trim() || r.name;
    this.persist();
    return true;
  }

  remove(id: string): boolean {
    const n = this.items.length;
    this.items = this.items.filter((r) => r.id !== id);
    if (this.items.length === n) return false;
    this.persist();
    return true;
  }

  private persist(): void {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(SAVED_KEY, JSON.stringify(this.items));
      }
    } catch {
      /* non-fatal */
    }
  }
}

function loadSaved(): SavedRunway[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(SAVED_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as SavedRunway[];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((r) => r && typeof r.id === "string" && r.shape)
      .map((r) => ({ ...r, shape: sanitizeShape(r.shape) }));
  } catch {
    return [];
  }
}
