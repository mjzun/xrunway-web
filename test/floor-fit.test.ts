import { describe, expect, it } from "vitest";

import {
  floorsClose,
  selectFloorFit,
  type PlaneSample,
  type PlanePoint,
} from "../src/floor-fit.ts";
import {
  compileShape,
  fitShapeToFloorPlane,
  sanitizeShape,
  shapeFloorPlan,
  type FloorFit,
  type RunwayShape,
} from "../src/runway-shape.ts";

// --- small local helpers (independent of the code under test) ----------------

/** Rotate a vector by a quaternion (independent ground-truth implementation). */
function qrot(
  vx: number,
  vy: number,
  vz: number,
  q: { x: number; y: number; z: number; w: number },
): [number, number, number] {
  const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  const qx = q.x / n,
    qy = q.y / n,
    qz = q.z / n,
    qw = q.w / n;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

/** Quaternion for a pure rotation about world +Y by `yaw` (an up-normal floor). */
function yawQuat(yaw: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

/** A rectangular plane polygon (plane-local X-Z) from offset + extent. */
function rectPolygon(
  offX: number,
  offZ: number,
  w: number,
  h: number,
): PlanePoint[] {
  return [
    { x: offX, z: offZ },
    { x: offX + w, z: offZ },
    { x: offX + w, z: offZ + h },
    { x: offX, z: offZ + h },
  ];
}

interface RawPlane {
  pos: [number, number, number];
  quat: { x: number; y: number; z: number; w: number };
  offset: [number, number];
  extent: [number, number];
  orientation?: string;
  label?: string;
}

function sample(r: RawPlane): PlaneSample {
  return {
    orientation: r.orientation ?? "horizontal",
    semanticLabel: r.label,
    polygon: rectPolygon(r.offset[0], r.offset[1], r.extent[0], r.extent[1]),
    position: { x: r.pos[0], y: r.pos[1], z: r.pos[2] },
    quaternion: r.quat,
  };
}

/** Ground-truth world centroid + world long-axis (unit) of a plane's polygon. */
function groundTruth(r: RawPlane) {
  const [ox, oz] = r.offset;
  const [w, h] = r.extent;
  const [cx, cy, cz] = qrot(ox + w / 2, 0, oz + h / 2, r.quat);
  const longLocal: [number, number, number] =
    h >= w ? [0, 0, 1] : [1, 0, 0];
  const [lx, , lz] = qrot(longLocal[0], 0, longLocal[2], r.quat);
  const len = Math.hypot(lx, lz) || 1;
  return {
    cx: r.pos[0] + cx,
    cy: r.pos[1] + cy,
    cz: r.pos[2] + cz,
    longX: lx / len,
    longZ: lz / len,
  };
}

/** World footprint bbox of a fitted shape. */
function worldFootprint(shape: RunwayShape) {
  const plan = shapeFloorPlan(compileShape(shape));
  const c = Math.cos(shape.yaw);
  const s = Math.sin(shape.yaw);
  const corners: Array<[number, number]> = [
    [plan.minX, plan.minZ],
    [plan.maxX, plan.minZ],
    [plan.maxX, plan.maxZ],
    [plan.minX, plan.maxZ],
  ];
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const [lx, lz] of corners) {
    const wx = shape.centerX + (c * lx + s * lz);
    const wz = shape.centerZ + (-s * lx + c * lz);
    minX = Math.min(minX, wx);
    maxX = Math.max(maxX, wx);
    minZ = Math.min(minZ, wz);
    maxZ = Math.max(maxZ, wz);
  }
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    cx: (minX + maxX) / 2,
    cz: (minZ + maxZ) / 2,
    spanX: maxX - minX,
    spanZ: maxZ - minZ,
  };
}

/** End-to-end: fit a straight runway to the FloorFit, return alignment + center error. */
function fitMetrics(fit: FloorFit, gt: ReturnType<typeof groundTruth>) {
  const shape = sanitizeShape({ kind: "straight", spineLength: 12, spineWidth: 1.2 });
  const out = fitShapeToFloorPlane(shape, fit, 0.3);
  const fp = worldFootprint(out);
  // spine world forward = (-sin yaw, -cos yaw)
  const sx = -Math.sin(out.yaw);
  const sz = -Math.cos(out.yaw);
  const dot = Math.abs(sx * gt.longX + sz * gt.longZ);
  const centerErr = Math.hypot(fp.cx - gt.cx, fp.cz - gt.cz);
  return { dot, centerErr, fp };
}

// --- real IWER living_room capture fixtures (captures/living_room.json) -------
// Floor: pose ~at polygon centroid, flipped-DOWN normal. Ceiling higher + larger.
// Table: small, ~0.79 m up.
const REAL_FLOOR: RawPlane = {
  pos: [0.05446946620941162, -0.0038210153579711914, -0.18400149047374725],
  quat: { x: 0.6994034415591134, y: 6.867283442306761e-8, z: 0.7147270989232626, w: -5.787468137854768e-9 },
  offset: [-2.2806735038757324, -2.99698543548584],
  extent: [4.562091827392578, 5.989412307739258],
  label: "floor",
};
const REAL_CEILING: RawPlane = {
  pos: [0.021307647228240967, 3.8831064701080322, -0.17037333548069],
  quat: { x: 0.0002287579349543537, y: -0.720335665320115, z: -4.604010135732225e-5, w: 0.6936256013282264 },
  offset: [-2.3142857551574707, -3.0009231567382812],
  extent: [4.627810478210449, 5.99816370010376],
  label: "ceiling",
};
const REAL_TABLE: RawPlane = {
  pos: [-1.539086103439331, 0.7892325262126634, 0.204374760389328],
  quat: { x: 0.7072194217567858, y: -2.66950001213172e-8, z: -0.7069941226700521, w: 1.5456767932218967e-8 },
  offset: [-0.6508874893188477, -0.3770488500595093],
  extent: [1.3017747402191162, 0.7540977597236633],
  label: "table",
};

describe("selectFloorFit — floor selection", () => {
  it("picks the floor out of the real living_room planes (floor + ceiling + table)", () => {
    const fit = selectFloorFit([REAL_FLOOR, REAL_CEILING, REAL_TABLE].map(sample));
    expect(fit).not.toBeNull();
    // extent is the floor's local polygon bbox
    expect(fit!.extentX).toBeCloseTo(4.562, 2);
    expect(fit!.extentZ).toBeCloseTo(5.989, 2);
    // centered on the floor (its pose ~= centroid here)
    const gt = groundTruth(REAL_FLOOR);
    expect(Math.hypot(fit!.centerX - gt.cx, fit!.centerZ - gt.cz)).toBeLessThan(0.05);
  });

  it("end-to-end: the real floor fit lands the runway centered + aligned on the floor", () => {
    const fit = selectFloorFit([REAL_FLOOR, REAL_CEILING, REAL_TABLE].map(sample))!;
    const m = fitMetrics(fit, groundTruth(REAL_FLOOR));
    expect(m.dot).toBeGreaterThan(0.999);
    expect(m.centerErr).toBeLessThan(0.05);
    // and the runway fits within the floor extent
    expect(m.fp.spanX).toBeLessThanOrEqual(Math.max(REAL_FLOOR.extent[0], REAL_FLOOR.extent[1]) + 1e-6);
  });

  it("prefers the floor-labelled plane even over a LOWER, LARGER non-floor plane", () => {
    // A big 'table' plane sitting BELOW the floor and larger than it must NOT win.
    const lowBigTable: RawPlane = {
      pos: [0, -0.05, 0],
      quat: yawQuat(0),
      offset: [-5, -5],
      extent: [10, 10],
      label: "table",
    };
    const fit = selectFloorFit([lowBigTable, REAL_FLOOR].map(sample));
    expect(fit).not.toBeNull();
    expect(fit!.extentX).toBeCloseTo(4.562, 2); // the real floor, not the 10x10 table
  });

  it("returns null when only non-floor horizontal planes are present (stay armed, don't fit a table)", () => {
    expect(selectFloorFit([REAL_TABLE, REAL_CEILING].map(sample))).toBeNull();
  });

  it("returns null for an empty set or planes with no horizontal surface", () => {
    expect(selectFloorFit([])).toBeNull();
    const wall: RawPlane = { pos: [0, 1, 0], quat: yawQuat(0), offset: [-1, -1], extent: [2, 2], orientation: "vertical", label: "wall" };
    expect(selectFloorFit([wall].map(sample))).toBeNull();
  });

  it("falls back to lowest+largest horizontal when no semanticLabels are present (label-less runtime)", () => {
    const lowFloor: RawPlane = { pos: [3, 0, 1], quat: yawQuat(0.7), offset: [-2, -3], extent: [4, 6] };
    const highCeil: RawPlane = { pos: [3, 2.6, 1], quat: yawQuat(0.7), offset: [-2, -3], extent: [4, 6] };
    const fit = selectFloorFit([highCeil, lowFloor].map(sample));
    expect(fit).not.toBeNull();
    const gt = groundTruth(lowFloor);
    expect(Math.hypot(fit!.centerX - gt.cx, fit!.centerZ - gt.cz)).toBeLessThan(0.05); // chose the LOW one
  });
});

describe("selectFloorFit — yaw + centering correctness (the device-review regressions)", () => {
  // A CLEAN up-normal floor at yaw in the Euler-gimbal-bad region (>90deg) with a
  // polygon OFFSET from the pose origin. The old code (obj.rotation.y + pose
  // origin) landed this ~90deg off and meters off-center; this locks the fix.
  for (const yaw of [2.5, -2.5, 3.0, 1.9]) {
    it(`clean up-normal floor at yaw=${yaw} rad: aligned + centered`, () => {
      const floor: RawPlane = {
        pos: [5, 0, -3],
        quat: yawQuat(yaw),
        offset: [1.0, -0.5], // local centre (3, 2.5) — far from the pose origin
        extent: [4, 6],
        label: "floor",
      };
      const fit = selectFloorFit([sample(floor)])!;
      const m = fitMetrics(fit, groundTruth(floor));
      expect(m.dot).toBeGreaterThan(0.999);
      expect(m.centerErr).toBeLessThan(0.01);
    });
  }

  it("handles a floor whose LONG axis is local X (extentX > extentZ)", () => {
    const floor: RawPlane = {
      pos: [-2, 0, 4],
      quat: yawQuat(2.2),
      offset: [-3, -1],
      extent: [6, 2], // long axis is local X
      label: "floor",
    };
    const fit = selectFloorFit([sample(floor)])!;
    const m = fitMetrics(fit, groundTruth(floor));
    expect(m.dot).toBeGreaterThan(0.999);
    expect(m.centerErr).toBeLessThan(0.01);
  });

  it("centers on the polygon centroid, not the pose origin (corner-origin floor)", () => {
    // Pose origin at a CORNER of the floor polygon — origin is 3.6 m from centre.
    const floor: RawPlane = {
      pos: [0, 0, 0],
      quat: yawQuat(0),
      offset: [0, 0], // polygon spans local x[0,4], z[0,6] -> centre (2,3)
      extent: [4, 6],
      label: "floor",
    };
    const fit = selectFloorFit([sample(floor)])!;
    // centre must be the polygon centre (2,3), NOT the pose origin (0,0)
    expect(fit.centerX).toBeCloseTo(2, 5);
    expect(fit.centerZ).toBeCloseTo(3, 5);
  });
});

describe("selectFloorFit — union of split floor planes (#6)", () => {
  it("unions two coplanar floor fragments into the whole floor extent", () => {
    // Two 4x6 floor planes side by side along world X -> a single 8x6 floor.
    const a: RawPlane = { pos: [0, 0, 0], quat: yawQuat(0), offset: [-2, -3], extent: [4, 6], label: "floor" };
    const b: RawPlane = { pos: [4, 0, 0], quat: yawQuat(0), offset: [-2, -3], extent: [4, 6], label: "floor" };
    const fit = selectFloorFit([a, b].map(sample))!;
    // union spans world x[-2,6] (8 m) and z[-3,3] (6 m), centred at (2,0)
    expect(fit.extentX).toBeCloseTo(8, 4);
    expect(fit.extentZ).toBeCloseTo(6, 4);
    expect(fit.centerX).toBeCloseTo(2, 4);
    expect(fit.centerZ).toBeCloseTo(0, 4);
  });

  it("a single fragment alone is unchanged (union is a no-op for one plane)", () => {
    const a: RawPlane = { pos: [0, 0, 0], quat: yawQuat(0), offset: [-2, -3], extent: [4, 6], label: "floor" };
    const fit = selectFloorFit([sample(a)])!;
    expect(fit.extentX).toBeCloseTo(4, 5);
    expect(fit.extentZ).toBeCloseTo(6, 5);
  });
});

describe("selectFloorFit — non-rectangular inscribe (#8)", () => {
  // Build a sample with an arbitrary polygon (not necessarily a rectangle).
  function poly(points: PlanePoint[], label = "floor"): PlaneSample {
    return {
      orientation: "horizontal",
      semanticLabel: label,
      polygon: points,
      position: { x: 0, y: 0, z: 0 },
      quaternion: yawQuat(0),
    };
  }

  it("shrinks the extent for an L-shaped floor (area < bbox)", () => {
    // L: area = 27 m^2 in a 6x6 bbox -> fill = sqrt(27/36) = 0.866.
    const l = poly([
      { x: 0, z: 0 }, { x: 6, z: 0 }, { x: 6, z: 3 },
      { x: 3, z: 3 }, { x: 3, z: 6 }, { x: 0, z: 6 },
    ]);
    const fit = selectFloorFit([l])!;
    expect(fit.extentX).toBeLessThan(6); // shrunk below the bbox
    expect(fit.extentX).toBeCloseTo(6 * Math.sqrt(27 / 36), 3);
    expect(fit.extentZ).toBeCloseTo(6 * Math.sqrt(27 / 36), 3);
    // still centred on the bbox centre (3,3)
    expect(fit.centerX).toBeCloseTo(3, 4);
    expect(fit.centerZ).toBeCloseTo(3, 4);
  });

  it("does NOT shrink a rectangular floor (fill factor is 1 — common-case no-op)", () => {
    const rect = poly([
      { x: -2, z: -3 }, { x: 2, z: -3 }, { x: 2, z: 3 }, { x: -2, z: 3 },
    ]);
    const fit = selectFloorFit([rect])!;
    expect(fit.extentX).toBeCloseTo(4, 5);
    expect(fit.extentZ).toBeCloseTo(6, 5);
  });

  it("a rectangular floor on a ROTATED device quaternion is still an exact no-op", () => {
    // Real device floors arrive on non-axis-aligned quaternions; FP error in the
    // union projection must not microscopically shrink a true rectangle (the fill
    // snap to 1 guards this). Extent must equal the rect dims to high precision.
    const rect: PlaneSample = {
      orientation: "horizontal",
      semanticLabel: "floor",
      polygon: [
        { x: -2, z: -3 }, { x: 2, z: -3 }, { x: 2, z: 3 }, { x: -2, z: 3 },
      ],
      position: { x: 1.3, y: -0.01, z: -0.7 },
      quaternion: yawQuat(0.7),
    };
    const fit = selectFloorFit([rect])!;
    expect(fit.extentX).toBeCloseTo(4, 9);
    expect(fit.extentZ).toBeCloseTo(6, 9);
  });
});

describe("floorsClose — the re-fit change gate (#4)", () => {
  const base: FloorFit = { centerX: 1, centerZ: -2, yaw: 0.5, extentX: 4, extentZ: 6 };
  it("treats an identical fit as close", () => {
    expect(floorsClose(base, { ...base })).toBe(true);
  });
  it("treats sub-threshold jitter as close (no rebuild)", () => {
    expect(floorsClose(base, { ...base, centerX: 1.02, extentZ: 6.05, yaw: 0.51 })).toBe(true);
  });
  it("treats a meaningful center move as NOT close (re-fit)", () => {
    expect(floorsClose(base, { ...base, centerX: 1.3 })).toBe(false);
  });
  it("treats a meaningful extent growth as NOT close (re-fit as the floor grows)", () => {
    expect(floorsClose(base, { ...base, extentX: 5 })).toBe(false);
  });
  it("treats a 180-degree yaw flip as NOT close (asymmetric T/X/U moves metres)", () => {
    // We deliberately do NOT fold 180°: a tangent-basis flip lands a T/U runway
    // far from where it was, so it must re-fit (a straight runway just re-applies
    // the same placement — one harmless rebuild).
    expect(floorsClose(base, { ...base, yaw: 0.5 + Math.PI })).toBe(false);
    expect(floorsClose(base, { ...base, yaw: 0.5 - Math.PI })).toBe(false);
  });
  it("treats a 45-degree rotation as NOT close", () => {
    expect(floorsClose(base, { ...base, yaw: 0.5 + Math.PI / 4 })).toBe(false);
  });
  it("normalizes the yaw seam (2π wrap is close)", () => {
    expect(floorsClose(base, { ...base, yaw: 0.5 + 2 * Math.PI })).toBe(true);
  });
});
