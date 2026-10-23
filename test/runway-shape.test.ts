import { describe, expect, it } from "vitest";

import {
  alongLateralToWorld,
  DEFAULT_LAYOUT,
  LAYOUT_LIMITS,
  layoutsEqual,
  poseAlong,
  START_INSET,
  type RunwayLayout,
} from "../src/runway-layout.ts";
import {
  anchorStartOnLengthEdit,
  compileShape,
  shapeFloorPlan,
  shapeOutline,
  roundOutline,
  pointInPolygon,
  fitShapeToFloorPlane,
  DEFAULT_SHAPE,
  PRESET_RUNWAYS,
  RunwayPathProjector,
  routeToWorld,
  sanitizeShape,
  SavedRunwaysStore,
  SHAPE_LIMITS,
  shapeToActiveLayout,
  straightShapeFromLayout,
  type RunwayShape,
} from "../src/runway-shape.ts";

describe("straight is byte-identical to the legacy layout", () => {
  it("DEFAULT_SHAPE is straight", () => {
    expect(DEFAULT_SHAPE.kind).toBe("straight");
    expect(DEFAULT_SHAPE.armSpan).toBe(0);
  });

  it("compileShape(DEFAULT_SHAPE).segments[0].rect deep-equals DEFAULT_LAYOUT", () => {
    const path = compileShape(DEFAULT_SHAPE);
    expect(path.segments).toHaveLength(1);
    expect(path.segments[0].rect).toEqual(DEFAULT_LAYOUT);
    expect(path.walkRoute).toEqual([0]);
    expect(path.totalAlong).toBe(DEFAULT_LAYOUT.length);
    expect(path.poseRouteAlong).toBeCloseTo(poseAlong(DEFAULT_LAYOUT), 9);
  });

  it("round-trips an arbitrary straight layout through the shape model", () => {
    const layout: RunwayLayout = {
      centerX: 1.5,
      centerZ: -2.25,
      yaw: 0.4,
      length: 9.3,
      width: 1.1,
    };
    const back = shapeToActiveLayout(straightShapeFromLayout(layout));
    expect(layoutsEqual(back, layout)).toBe(true);
  });
});

describe("sanitizeShape", () => {
  it("clamps crossAt into [minCrossAt, maxCrossAt]", () => {
    expect(sanitizeShape({ kind: "T", crossAt: 0.99 }).crossAt).toBe(
      SHAPE_LIMITS.maxCrossAt,
    );
    expect(sanitizeShape({ kind: "T", crossAt: 0.01 }).crossAt).toBe(
      SHAPE_LIMITS.minCrossAt,
    );
  });

  it("forces armSpan >= armWidth and zeroes arms for straight", () => {
    const t = sanitizeShape({ kind: "T", armSpan: 0.1, armWidth: 1.4 });
    expect(t.armSpan).toBeGreaterThanOrEqual(t.armWidth);
    expect(sanitizeShape({ kind: "straight", armSpan: 5 }).armSpan).toBe(0);
  });

  it("clamps the spine length to the (raised) true-size limits", () => {
    expect(sanitizeShape({ spineLength: 999 }).spineLength).toBe(
      LAYOUT_LIMITS.maxLength,
    );
    expect(sanitizeShape({ spineLength: 0.1 }).spineLength).toBe(
      LAYOUT_LIMITS.minLength,
    );
  });

  it("rejects an unknown kind down to straight", () => {
    expect(sanitizeShape({ kind: "blob" as never }).kind).toBe("straight");
  });

  it("coerces corrupt non-numeric stored values instead of producing NaN", () => {
    const s = sanitizeShape({
      spineLength: "abc",
      spineWidth: "x",
      centerX: "y",
      yaw: "nope",
      armSpan: "z",
      crossAt: "w",
    } as unknown as Record<string, number>);
    for (const v of [s.spineLength, s.spineWidth, s.centerX, s.yaw, s.armSpan, s.crossAt]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe("preset library", () => {
  it("ids are unique", () => {
    const ids = PRESET_RUNWAYS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every preset sanitizes to itself (already in-bounds, true-size)", () => {
    for (const p of PRESET_RUNWAYS) {
      const s = sanitizeShape(p.shape);
      expect(s.spineLength).toBeCloseTo(p.shape.spineLength, 6);
      expect(s.spineWidth).toBeCloseTo(p.shape.spineWidth, 6);
      expect(s.spineLength).toBeLessThanOrEqual(LAYOUT_LIMITS.maxLength);
      expect(s.spineLength).toBeGreaterThanOrEqual(LAYOUT_LIMITS.minLength);
    }
  });

  it("keeps famous runways at true size (Grand Palais = 60 m)", () => {
    const gp = PRESET_RUNWAYS.find((p) => p.id === "famous-grand-palais-chanel");
    expect(gp?.shape.spineLength).toBe(60);
  });

  it("straight presets carry no arms; T presets do", () => {
    for (const p of PRESET_RUNWAYS) {
      if (p.shape.kind === "straight") expect(p.shape.armSpan).toBe(0);
      if (p.shape.kind === "T") expect(p.shape.armSpan).toBeGreaterThan(0);
    }
  });
});

describe("compileShape T", () => {
  const t = sanitizeShape({
    kind: "T",
    spineLength: 20,
    spineWidth: 1.2,
    armSpan: 3,
    armWidth: 1.2,
    yaw: 0,
    centerX: 0,
    centerZ: 0,
  });

  it("produces spine + arm, and the scored walk stays the spine", () => {
    const p = compileShape(t);
    expect(p.segments).toHaveLength(2);
    expect(p.segments[0].role).toBe("spine");
    expect(p.segments[1].role).toBe("arm");
    expect(p.walkRoute).toEqual([0]);
    expect(p.totalAlong).toBe(20);
    expect(p.poseRouteAlong).toBeCloseTo(poseAlong(p.segments[0].rect), 9);
    // spine is byte-identical to a straight runway of the same dims
    expect(p.segments[0].rect.length).toBe(20);
    expect(p.segments[0].rect.width).toBe(1.2);
  });

  it("places a perpendicular crossbar spanning both arms at the far end", () => {
    const p = compileShape(t);
    const arm = p.segments[1].rect;
    expect(arm.yaw).toBeCloseTo(Math.PI / 2, 6);
    expect(arm.length).toBeCloseTo(6, 6); // 2 * armSpan
    expect(arm.width).toBeCloseTo(1.2, 6);
    // centered at the spine's far end
    const farEnd = alongLateralToWorld(p.segments[0].rect, 20, 0);
    expect(arm.centerX).toBeCloseTo(farEnd.x, 6);
    expect(arm.centerZ).toBeCloseTo(farEnd.z, 6);
  });
});

describe("compileShape X", () => {
  it("places the crossbar at crossAt (mid-spine), full spine walk", () => {
    const x = sanitizeShape({
      kind: "X",
      spineLength: 20,
      spineWidth: 1.2,
      armSpan: 3,
      armWidth: 1.2,
      crossAt: 0.5,
      yaw: 0,
      centerX: 0,
      centerZ: 0,
    });
    const p = compileShape(x);
    expect(p.segments).toHaveLength(2);
    expect(p.walkRoute).toEqual([0]);
    expect(p.totalAlong).toBe(20);
    const arm = p.segments[1].rect;
    expect(arm.yaw).toBeCloseTo(Math.PI / 2, 6);
    const mid = alongLateralToWorld(p.segments[0].rect, 0.5 * 20, 0);
    expect(arm.centerX).toBeCloseTo(mid.x, 6);
    expect(arm.centerZ).toBeCloseTo(mid.z, 6);
  });
});

describe("shapeFloorPlan (unified deck/floor frame)", () => {
  it("straight: reduces to the spine rect, bbox = width x length", () => {
    const fp = shapeFloorPlan(
      compileShape(sanitizeShape({ kind: "straight", spineLength: 20, spineWidth: 1.4 })),
    );
    expect(fp.segments).toHaveLength(1);
    expect(fp.segments[0].cx).toBeCloseTo(0, 6);
    expect(fp.segments[0].cz).toBeCloseTo(0, 6);
    expect(fp.segments[0].yaw).toBeCloseTo(0, 6);
    expect(fp.width).toBeCloseTo(1.4, 6);
    expect(fp.length).toBeCloseTo(20, 6);
  });

  it("X: bbox widens to the crossbar; length stays the spine", () => {
    const sx = sanitizeShape({
      kind: "X", spineLength: 16, spineWidth: 1.4, armSpan: 3, armWidth: 1.4, crossAt: 0.5,
    });
    const fp = shapeFloorPlan(compileShape(sx));
    const crossbarLen = Math.max(2 * sx.armSpan, sx.armWidth);
    expect(fp.segments).toHaveLength(2);
    expect(fp.width).toBeGreaterThan(sx.spineWidth + 0.5); // arm extends laterally
    expect(fp.width).toBeCloseTo(crossbarLen, 4);
    expect(fp.length).toBeCloseTo(sx.spineLength, 4);
  });

  it("U: bbox spans both legs (~2*armSpan + legWidth) and one leg length", () => {
    const su = sanitizeShape({
      kind: "U", spineLength: 12, spineWidth: 1.2, armSpan: 3, armWidth: 1.2,
    });
    const fp = shapeFloorPlan(compileShape(su));
    expect(fp.segments).toHaveLength(3);
    expect(fp.width).toBeCloseTo(2 * su.armSpan + su.spineWidth, 4); // legs + width
    expect(fp.length).toBeGreaterThan(su.spineLength - 0.01);
  });
});

describe("shapeOutline (rectilinear union boundary)", () => {
  const shoelace = (pts: Array<[number, number]>): number => {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, z1] = pts[i];
      const [x2, z2] = pts[(i + 1) % pts.length];
      a += x1 * z2 - x2 * z1;
    }
    return a / 2;
  };
  it("straight: a 4-corner rectangle of area width*length", () => {
    const fp = shapeFloorPlan(compileShape(sanitizeShape({ kind: "straight", spineLength: 20, spineWidth: 1.4 })));
    const o = shapeOutline(fp);
    expect(o.length).toBe(4);
    expect(Math.abs(shoelace(o))).toBeCloseTo(1.4 * 20, 4);
  });
  it("X: a 12-corner plus whose area = union of spine + crossbar", () => {
    const sx = sanitizeShape({ kind: "X", spineLength: 12, spineWidth: 1.4, armSpan: 3, armWidth: 1.4, crossAt: 0.5 });
    const o = shapeOutline(shapeFloorPlan(compileShape(sx)));
    expect(o.length).toBe(12);
    const crossLen = Math.max(2 * sx.armSpan, sx.armWidth);
    const union = sx.spineLength * sx.spineWidth + crossLen * sx.armWidth - sx.spineWidth * sx.armWidth;
    expect(Math.abs(shoelace(o))).toBeCloseTo(union, 3);
  });
  it("U: a single horseshoe loop whose bbox matches the floor plan", () => {
    const fp = shapeFloorPlan(compileShape(sanitizeShape({ kind: "U", spineLength: 10, spineWidth: 1.4, armSpan: 2.5, armWidth: 1.4 })));
    const o = shapeOutline(fp);
    expect(o.length).toBeGreaterThan(4); // not a simple rectangle
    const xs = o.map((p) => p[0]);
    const zs = o.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(fp.minX, 4);
    expect(Math.max(...xs)).toBeCloseTo(fp.maxX, 4);
    expect(Math.min(...zs)).toBeCloseTo(fp.minZ, 4);
    expect(Math.max(...zs)).toBeCloseTo(fp.maxZ, 4);
  });
});

describe("compileShape U", () => {
  const u = sanitizeShape({
    kind: "U",
    spineLength: 12,
    spineWidth: 1.2,
    armSpan: 3,
    armWidth: 1.2,
    yaw: 0,
    centerX: 0,
    centerZ: 0,
  });

  it("builds three route segments with cumulative along0", () => {
    const p = compileShape(u);
    expect(p.segments).toHaveLength(3);
    expect(p.walkRoute).toEqual([0, 1, 2]);
    expect(p.totalAlong).toBeCloseTo(2 * 12 + 2 * 3, 6); // 30
    expect(p.segments[1].along0).toBeCloseTo(12, 6);
    expect(p.segments[2].along0).toBeCloseTo(12 + 6, 6);
  });

  it("legs use spineWidth; the base uses armWidth", () => {
    const uw = sanitizeShape({
      kind: "U",
      spineLength: 12,
      spineWidth: 1.2,
      armSpan: 3,
      armWidth: 2.5,
      yaw: 0,
      centerX: 0,
      centerZ: 0,
    });
    expect(uw.armWidth).not.toBeCloseTo(uw.spineWidth, 3); // test is meaningful
    const p = compileShape(uw);
    expect(p.segments[0].rect.width).toBeCloseTo(uw.spineWidth, 6); // legA
    expect(p.segments[1].rect.width).toBeCloseTo(uw.armWidth, 6); //  base
    expect(p.segments[2].rect.width).toBeCloseTo(uw.spineWidth, 6); // legB
  });

  it("routeToWorld is continuous at the corners and finishes across from start", () => {
    const p = compileShape(u);
    const start = routeToWorld(p, 0, 0);
    const cornerA = routeToWorld(p, 12, 0); // end of legA
    const cornerB = routeToWorld(p, 12.0001, 0); // start of base
    expect(Math.hypot(cornerA.x - cornerB.x, cornerA.z - cornerB.z)).toBeLessThan(
      0.01,
    );
    const finish = routeToWorld(p, p.totalAlong, 0);
    // the finish is across the horseshoe (~2*armSpan away), not back at start
    expect(Math.hypot(finish.x - start.x, finish.z - start.z)).toBeGreaterThan(
      2 * 3 - 0.5,
    );
  });
});

describe("RunwayPathProjector", () => {
  it("routes points to the nearest segment of a T", () => {
    const t = sanitizeShape({
      kind: "T",
      spineLength: 20,
      spineWidth: 1.2,
      armSpan: 4,
      armWidth: 1.2,
      yaw: 0,
      centerX: 0,
      centerZ: 0,
    });
    const path = compileShape(t);
    const proj = new RunwayPathProjector();
    proj.set(path);

    // mid-spine -> the spine segment
    const onSpine = proj.project(
      path.segments[0].rect.centerX,
      path.segments[0].rect.centerZ,
    );
    expect(onSpine.segIndex).toBe(0);
    expect(onSpine.localFrac).toBeCloseTo(0.5, 2);

    // a tip of the crossbar -> the arm segment
    const arm = path.segments[1].rect;
    const tip = alongLateralToWorld(arm, arm.length, 0);
    const onArm = proj.project(tip.x, tip.z);
    expect(onArm.segIndex).toBe(1);
  });

  it("degenerates to one segment for a straight runway", () => {
    const proj = new RunwayPathProjector();
    proj.set(compileShape(DEFAULT_SHAPE));
    const r = proj.project(0, DEFAULT_LAYOUT.centerZ);
    expect(r.segIndex).toBe(0);
  });
});

describe("projectRoute yaw (M8: the active segment's WALK-direction heading)", () => {
  it("straight: yaw is the spine's walk heading everywhere on the route", () => {
    const shape = sanitizeShape({ ...DEFAULT_SHAPE, yaw: 0.7 });
    const path = compileShape(shape);
    const proj = new RunwayPathProjector();
    proj.set(path);
    const r = proj.projectRoute(shape.centerX, shape.centerZ);
    expect(r.yaw).toBe(path.segments[0].rect.yaw);
    expect(r.yaw).toBeCloseTo(0.7, 9);
  });

  it("U: each leg reports ITS segment's heading (legB flipped PI vs legA)", () => {
    const u = sanitizeShape({
      kind: "U",
      spineLength: 12,
      spineWidth: 1.2,
      armSpan: 3,
      armWidth: 1.2,
      yaw: 0,
      centerX: 0,
      centerZ: 0,
    });
    const path = compileShape(u);
    const proj = new RunwayPathProjector();
    proj.set(path);
    // Mid-legA and mid-legB world points via the forward map.
    const onLegA = routeToWorld(path, 6, 0);
    const onLegB = routeToWorld(path, path.totalAlong - 6, 0);
    // projectRoute returns ONE reused result object (the zero-alloc law) —
    // capture the scalar before the next call mutates it.
    const yawA = proj.projectRoute(onLegA.x, onLegA.z).yaw;
    expect(yawA).toBe(path.segments[0].rect.yaw);
    const yawB = proj.projectRoute(onLegB.x, onLegB.z).yaw;
    expect(yawB).toBe(path.segments[2].rect.yaw);
    // The two legs are walked in opposite directions.
    const dYaw = Math.abs(yawB - yawA) % (2 * Math.PI);
    expect(Math.min(dYaw, 2 * Math.PI - dYaw)).toBeCloseTo(Math.PI, 6);
  });

  it("agrees with routeToWorld's yaw at the same route point (one heading law)", () => {
    const u = sanitizeShape({
      kind: "U",
      spineLength: 10,
      spineWidth: 1.2,
      armSpan: 3,
      armWidth: 1.4,
      yaw: 0.4,
      centerX: 1,
      centerZ: -2,
    });
    const path = compileShape(u);
    const proj = new RunwayPathProjector();
    proj.set(path);
    for (const along of [1, 5, 11.5, path.totalAlong - 2]) {
      const w = routeToWorld(path, along, 0);
      expect(proj.projectRoute(w.x, w.z).yaw).toBe(w.yaw);
    }
  });

  it("is additive: the existing projectRoute fields are untouched", () => {
    const proj = new RunwayPathProjector();
    proj.set(compileShape(DEFAULT_SHAPE));
    const r = proj.projectRoute(DEFAULT_LAYOUT.centerX, DEFAULT_LAYOUT.centerZ);
    expect(Object.keys(r).sort()).toEqual([
      "alongFrac",
      "globalAlong",
      "lateral",
      "yaw",
    ]);
  });
});

describe("SavedRunwaysStore", () => {
  it("saves, lists newest-first, renames and removes", () => {
    let t = 1000;
    const store = new SavedRunwaysStore(() => (t += 10));
    const a = store.save("My T", sanitizeShape({ kind: "T", spineLength: 18 }));
    const b = store.save("Studio", sanitizeShape({ spineLength: 12 }));
    expect(store.count()).toBe(2);
    expect(store.list()[0].id).toBe(b.id); // newest first
    expect(store.rename(a.id, "Renamed")).toBe(true);
    expect(store.get(a.id)?.name).toBe("Renamed");
    expect(store.remove(b.id)).toBe(true);
    expect(store.count()).toBe(1);
    expect(store.remove("nope")).toBe(false);
  });

  it("never reuses an id for a delete-then-save in the same millisecond", () => {
    const store = new SavedRunwaysStore(() => 1000); // frozen clock
    const a = store.save("A", sanitizeShape({ kind: "T" }));
    expect(store.remove(a.id)).toBe(true);
    const b = store.save("B", sanitizeShape({ kind: "X" }));
    expect(b.id).not.toBe(a.id); // monotonic seq, not items.length
  });
});

describe("roundOutline", () => {
  // CCW unit-ish square (a deck rect)
  const square: Array<[number, number]> = [
    [-1, -2],
    [1, -2],
    [1, 2],
    [-1, 2],
  ];

  it("returns the polygon unchanged when radius is 0", () => {
    const out = roundOutline(square, 0);
    expect(out).toHaveLength(4);
    expect(out).toEqual(square);
  });

  it("rounds every convex corner into an arc (more points, same bbox)", () => {
    const out = roundOutline(square, 0.4, 0, 5);
    // 4 convex corners -> each replaced by (steps+1)=6 arc points
    expect(out.length).toBe(4 * 6);
    const xs = out.map((p) => p[0]);
    const zs = out.map((p) => p[1]);
    // bbox is preserved (rounding cuts inward, the extremes stay on the edges)
    expect(Math.min(...xs)).toBeCloseTo(-1, 5);
    expect(Math.max(...xs)).toBeCloseTo(1, 5);
    expect(Math.min(...zs)).toBeCloseTo(-2, 5);
    expect(Math.max(...zs)).toBeCloseTo(2, 5);
    // no point pokes outside the original square
    for (const [x, z] of out) {
      expect(Math.abs(x)).toBeLessThanOrEqual(1 + 1e-9);
      expect(Math.abs(z)).toBeLessThanOrEqual(2 + 1e-9);
    }
  });

  it("clamps the radius to half the shorter adjacent edge", () => {
    // edge length 2 across, 4 along -> max radius 1; ask for 10
    const out = roundOutline(square, 10, 0, 4);
    for (const [x, z] of out) {
      expect(Math.abs(x)).toBeLessThanOrEqual(1 + 1e-9);
      expect(Math.abs(z)).toBeLessThanOrEqual(2 + 1e-9);
    }
  });

  it("leaves concave corners sharp when concaveR is 0", () => {
    // CCW L (one concave corner at [1,1])
    const L: Array<[number, number]> = [
      [0, 0],
      [2, 0],
      [2, 1],
      [1, 1], // concave
      [1, 2],
      [0, 2],
    ];
    const out = roundOutline(L, 0.3, 0, 4);
    // the concave vertex survives verbatim
    expect(out.some((p) => p[0] === 1 && p[1] === 1)).toBe(true);
  });

  it("rounds concave (reflex) corners when concaveR > 0 — kills the L-notch", () => {
    const L: Array<[number, number]> = [
      [0, 0],
      [2, 0],
      [2, 1],
      [1, 1], // concave / reflex
      [1, 2],
      [0, 2],
    ];
    const out = roundOutline(L, 0.3, 0.3, 5);
    // the sharp reflex vertex is gone, replaced by an arc of points...
    expect(out.some((p) => p[0] === 1 && p[1] === 1)).toBe(false);
    // ...whose points sit near the corner but filleted across the notch (the
    // fillet bulges toward the material, so points land at x>1 or z>1 near it).
    const near = out.filter(
      (p) => Math.hypot(p[0] - 1, p[1] - 1) < 0.5,
    );
    expect(near.length).toBeGreaterThanOrEqual(4); // an arc, not a point
    // every filleted point stays in the corner neighbourhood (no blow-up)
    for (const p of near) {
      expect(p[0]).toBeGreaterThan(0.6);
      expect(p[1]).toBeGreaterThan(0.6);
    }
  });
});

describe("fitShapeToFloorPlane", () => {
  // World footprint bbox of a shape (transform its root-local bbox by the root
  // placement) — the actual on-floor footprint.
  const worldFootprint = (shape: RunwayShape) => {
    const plan = shapeFloorPlan(compileShape(shape));
    const c = Math.cos(shape.yaw);
    const s = Math.sin(shape.yaw);
    const corners: Array<[number, number]> = [
      [plan.minX, plan.minZ],
      [plan.maxX, plan.minZ],
      [plan.maxX, plan.maxZ],
      [plan.minX, plan.maxZ],
    ];
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [lx, lz] of corners) {
      const wx = shape.centerX + (c * lx + s * lz);
      const wz = shape.centerZ + (-s * lx + c * lz);
      minX = Math.min(minX, wx);
      maxX = Math.max(maxX, wx);
      minZ = Math.min(minZ, wz);
      maxZ = Math.max(maxZ, wz);
    }
    return { minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
  };

  it("scales + centers a straight shape inside an axis-aligned floor", () => {
    const shape = sanitizeShape({
      kind: "straight",
      spineLength: 12,
      spineWidth: 1.5,
      centerX: 9,
      centerZ: -4,
      yaw: 0.6,
    });
    const floor = { centerX: 1, centerZ: 2, yaw: 0, extentX: 4, extentZ: 3 };
    const fit = fitShapeToFloorPlane(shape, floor, 0.3);
    expect(fit.kind).toBe("straight");
    const fp = worldFootprint(fit);
    // centred on the floor
    expect(fp.cx).toBeCloseTo(1, 1);
    expect(fp.cz).toBeCloseTo(2, 1);
    // fits within the floor rect (centre ± extent/2)
    expect(fp.minX).toBeGreaterThanOrEqual(1 - 4 / 2 - 1e-6);
    expect(fp.maxX).toBeLessThanOrEqual(1 + 4 / 2 + 1e-6);
    expect(fp.minZ).toBeGreaterThanOrEqual(2 - 3 / 2 - 1e-6);
    expect(fp.maxZ).toBeLessThanOrEqual(2 + 3 / 2 + 1e-6);
  });

  it("preserves a U and centres its (offset) footprint on the floor", () => {
    const shape = sanitizeShape({
      kind: "U",
      spineLength: 10,
      spineWidth: 1.4,
      armSpan: 3,
      armWidth: 1.4,
      centerX: -6,
      centerZ: 8,
      yaw: 1.2,
    });
    const floor = { centerX: 0, centerZ: 0, yaw: 0, extentX: 5, extentZ: 5 };
    const fit = fitShapeToFloorPlane(shape, floor, 0.3);
    expect(fit.kind).toBe("U"); // shape preserved, not flattened to a straight
    const fp = worldFootprint(fit);
    // the U's footprint centre (not its spine) lands EXACTLY on the floor centre.
    // This 5x5 floor scales spineWidth (1.4*scale) below the 0.8 min, so the fit
    // clamps — the centre must be solved from the CLAMPED footprint (M7), else an
    // asymmetric U drifts ~0.05 m off (the old tolerance barely hid it).
    expect(fp.cx).toBeCloseTo(0, 5);
    expect(fp.cz).toBeCloseTo(0, 5);
    // and it fits inside the 5x5 floor
    expect(fp.maxX - fp.minX).toBeLessThanOrEqual(5 + 1e-6);
    expect(fp.maxZ - fp.minZ).toBeLessThanOrEqual(5 + 1e-6);
  });

  it("centres an asymmetric T exactly even when a tiny floor clamps its width (M7)", () => {
    // A T whose crossbar sits at the spine's far end → footprint offset from the
    // spine along Z. A 3x3 floor forces spineWidth/armWidth below their minima, so
    // the scaled dims clamp; centering must use the post-clamp footprint. The floor
    // is too small to host the T at min dims, so it necessarily spills — but the
    // fix makes it spill SYMMETRICALLY (centred) rather than off to one side, which
    // is the M7 win. Pre-fix this centre drifted off by the clamp delta.
    const shape = sanitizeShape({
      kind: "T",
      spineLength: 14,
      spineWidth: 1.2,
      armSpan: 5,
      armWidth: 1.2,
      crossAt: 1,
      centerX: 4,
      centerZ: -7,
      yaw: 0.9,
    });
    const floor = { centerX: 2, centerZ: -1, yaw: 0.4, extentX: 3, extentZ: 3 };
    const fit = fitShapeToFloorPlane(shape, floor, 0.3);
    const fp = worldFootprint(fit);
    expect(fp.cx).toBeCloseTo(2, 5);
    expect(fp.cz).toBeCloseTo(-1, 5);
    // symmetric spill: the footprint extends equally on both sides of the centre.
    expect(fp.maxX - 2).toBeCloseTo(2 - fp.minX, 5);
    expect(fp.maxZ - -1).toBeCloseTo(-1 - fp.minZ, 5);
  });

  it("fits an asymmetric T inside a floor large enough at min dims, centred", () => {
    // Same T, but a floor big enough to host it at min dims AND still force a clamp
    // on the long axis — the footprint must both fit AND sit centred.
    const shape = sanitizeShape({
      kind: "T",
      spineLength: 14,
      spineWidth: 1.2,
      armSpan: 5,
      armWidth: 1.2,
      crossAt: 1,
      centerX: 0,
      centerZ: 0,
      yaw: 0,
    });
    const floor = { centerX: 3, centerZ: 5, yaw: 0, extentX: 14, extentZ: 14 };
    const fit = fitShapeToFloorPlane(shape, floor, 0.3);
    const fp = worldFootprint(fit);
    expect(fp.cx).toBeCloseTo(3, 5);
    expect(fp.cz).toBeCloseTo(5, 5);
    expect(fp.maxX - fp.minX).toBeLessThanOrEqual(14 + 1e-6);
    expect(fp.maxZ - fp.minZ).toBeLessThanOrEqual(14 + 1e-6);
  });

  it("never spills T/X/U past a floor big enough to host the shape at min dims", () => {
    // The scale is solved from the PRE-clamp footprint; sanitizeShape's min-dim
    // clamps used to inflate the footprint past the floor (cm-scale overshoot of
    // the real edge). The corrective re-scale pulls it back in. Sweep T/X/U on a
    // range of floors that ARE big enough for the min-dim shape, asserting the
    // fitted footprint stays within the floor extent.
    const margin = 0.3;
    for (const kind of ["T", "X", "U"] as const) {
      const shape = sanitizeShape({
        kind, spineLength: 50, spineWidth: 1.5, armSpan: 3.5, armWidth: 1.5, crossAt: 0.88,
      });
      for (let fLong = 5; fLong <= 13; fLong += 1) {
        for (let fShort = 4; fShort <= fLong; fShort += 1) {
          const floor = { centerX: 0, centerZ: 0, yaw: 0, extentX: fShort, extentZ: fLong };
          const fp = worldFootprint(fitShapeToFloorPlane(shape, floor, margin));
          // floor is axis-aligned (yaw 0) so world spans == floor-frame spans
          expect(fp.maxX - fp.minX).toBeLessThanOrEqual(fShort + 1e-6);
          expect(fp.maxZ - fp.minZ).toBeLessThanOrEqual(fLong + 1e-6);
        }
      }
    }
  });

  it("corrective loop does NOT shrink the width when only the length axis is pinned", () => {
    // A 2:1 straight runway on a 3x3 floor: the floor (3 m) is shorter than the
    // runway's minLength, so the spine pins at min (3) and the over-factor is
    // driven by the (un-shrinkable) length. The width (1.35, above min) already
    // fits, so the corrective must leave it intact — not keep shrinking it.
    const shape = sanitizeShape({ kind: "straight", spineLength: 6, spineWidth: 3 });
    const floor = { centerX: 0, centerZ: 0, yaw: 0, extentX: 3, extentZ: 3 };
    const fp = worldFootprint(fitShapeToFloorPlane(shape, floor, 0.3));
    const shortSpan = Math.min(fp.maxX - fp.minX, fp.maxZ - fp.minZ);
    // width = spineWidth*scale = 3 * min(2.7/6, 2.7/3) = 1.35, left intact
    // (the pre-fix loop drove this down toward ~0.89).
    expect(shortSpan).toBeCloseTo(1.35, 3);
  });
});

describe("pointInPolygon", () => {
  const square: Array<[number, number]> = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  it("is true for interior points, false for exterior", () => {
    expect(pointInPolygon(0, 0, square)).toBe(true);
    expect(pointInPolygon(0.9, 0.9, square)).toBe(true);
    expect(pointInPolygon(2, 0, square)).toBe(false);
    expect(pointInPolygon(0, -5, square)).toBe(false);
  });
  it("excludes the rounded corner of a square (point outside the arc)", () => {
    const rounded = roundOutline(square, 0.5, 0, 6);
    // the far corner (0.95,0.95) is inside the square but cut off by the round
    expect(pointInPolygon(0, 0, rounded)).toBe(true);
    expect(pointInPolygon(0.95, 0.95, rounded)).toBe(false);
  });
});

// The Quest tester's short-runway fix (2026-07-09): length edits used to
// grow/shrink about the CENTER, pulling the start line away from the trainee
// standing on it (7 m -> 3 m moved it 2 m). anchorStartOnLengthEdit keeps the
// START world point (along = START_INSET on the active layout) fixed.
describe("anchorStartOnLengthEdit (start-anchored length edits)", () => {
  const startPoint = (shape: RunwayShape) =>
    alongLateralToWorld(shapeToActiveLayout(shape), START_INSET, 0);

  it("keeps the start line fixed across shrink AND grow, at any yaw", () => {
    for (const yaw of [0, 0.7, Math.PI / 2, -1.3]) {
      const base = sanitizeShape({ ...DEFAULT_SHAPE, yaw });
      const before = startPoint(base);
      for (const len of [3, 4.5, 12, 30]) {
        const next = anchorStartOnLengthEdit(base, len);
        expect(next.spineLength).toBe(len);
        const after = startPoint(next);
        expect(after.x).toBeCloseTo(before.x, 9);
        expect(after.z).toBeCloseTo(before.z, 9);
      }
    }
  });

  it("the tester's exact case: 7 m -> 3 m no longer strands the trainee", () => {
    // Center-anchored (the OLD behavior) put the near edge ~2 m away; the
    // anchored edit keeps the start still and moves the CENTER instead.
    const next = anchorStartOnLengthEdit(DEFAULT_SHAPE, 3);
    expect(next.centerZ).toBeCloseTo(DEFAULT_SHAPE.centerZ + 2, 9);
    const before = startPoint(DEFAULT_SHAPE);
    const after = startPoint(next);
    expect(after.z).toBeCloseTo(before.z, 9);
  });

  it("anchors against the CLAMPED length, so a clamped drag never walks the start", () => {
    const under = anchorStartOnLengthEdit(DEFAULT_SHAPE, 0.5); // clamps to min 3
    expect(under.spineLength).toBe(LAYOUT_LIMITS.minLength);
    expect(startPoint(under).z).toBeCloseTo(startPoint(DEFAULT_SHAPE).z, 9);
    const over = anchorStartOnLengthEdit(DEFAULT_SHAPE, 500); // clamps to max 80
    expect(over.spineLength).toBe(LAYOUT_LIMITS.maxLength);
    expect(startPoint(over).z).toBeCloseTo(startPoint(DEFAULT_SHAPE).z, 9);
  });

  it("a no-op length returns the same shape (change-gating stays intact)", () => {
    expect(anchorStartOnLengthEdit(DEFAULT_SHAPE, DEFAULT_SHAPE.spineLength)).toBe(
      DEFAULT_SHAPE,
    );
  });

  it("translates composite shapes rigidly (a U's route start stays put)", () => {
    const u = sanitizeShape({ ...DEFAULT_SHAPE, kind: "U", armSpan: 3, yaw: 0.4 });
    const before = routeToWorld(compileShape(u), START_INSET, 0);
    const next = anchorStartOnLengthEdit(u, 5);
    const after = routeToWorld(compileShape(next), START_INSET, 0);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.z).toBeCloseTo(before.z, 9);
  });

  it("the center clamp can bite only at the +-maxOffset extremes (bounds law)", () => {
    // Park the shape near the offset boundary, then grow hugely: the center
    // clamp saturates and the start CAN shift — but stays within bounds.
    const parked = sanitizeShape({ ...DEFAULT_SHAPE, centerZ: -44.5 });
    const grown = anchorStartOnLengthEdit(parked, 80);
    expect(Math.abs(grown.centerZ)).toBeLessThanOrEqual(LAYOUT_LIMITS.maxOffset);
  });
});
