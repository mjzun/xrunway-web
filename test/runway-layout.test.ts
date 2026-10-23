import { describe, expect, it } from "vitest";

import {
  alongLateralToWorld,
  DEFAULT_LAYOUT,
  layoutFromEndpoints,
  layoutsEqual,
  LAYOUT_LIMITS,
  loadLayout,
  poseAlong,
  POSE_INSET,
  RunwayProjector,
  sanitizeLayout,
  startAlong,
  START_INSET,
  type RunwayLayout,
} from "../src/runway-layout.ts";
import { DECK_CENTER_Z, DECK_FAR_Z, DECK_NEAR_Z, STAGE } from "../src/theme.ts";

describe("DEFAULT_LAYOUT", () => {
  it("reproduces the REV2 placement", () => {
    expect(DEFAULT_LAYOUT.centerX).toBe(0);
    expect(DEFAULT_LAYOUT.centerZ).toBeCloseTo(DECK_CENTER_Z, 6);
    expect(DEFAULT_LAYOUT.yaw).toBe(0);
    expect(DEFAULT_LAYOUT.length).toBe(STAGE.deckLength);
    expect(DEFAULT_LAYOUT.width).toBe(STAGE.deckWidth);
  });
});

describe("RunwayProjector (default, yaw 0)", () => {
  const p = new RunwayProjector(DEFAULT_LAYOUT);
  it("near edge -> along 0, far edge -> along length", () => {
    expect(p.along(0, DECK_NEAR_Z)).toBeCloseTo(0, 4);
    expect(p.along(0, DECK_FAR_Z)).toBeCloseTo(STAGE.deckLength, 4);
  });
  it("origin sits nearGap behind the near edge", () => {
    expect(p.along(0, 0)).toBeCloseTo(-STAGE.nearGap, 4);
  });
  it("pose mark is length - POSE_INSET", () => {
    expect(p.along(0, DECK_FAR_Z + POSE_INSET)).toBeCloseTo(
      STAGE.deckLength - POSE_INSET,
      4,
    );
  });
  it("lateral is signed distance from the centerline (+x = +lateral)", () => {
    expect(p.lateral(0, DECK_CENTER_Z)).toBeCloseTo(0, 4);
    expect(p.lateral(0.5, DECK_CENTER_Z)).toBeCloseTo(0.5, 4);
    expect(p.lateral(-0.3, DECK_CENTER_Z)).toBeCloseTo(-0.3, 4);
  });
  it("alongFraction clamps to 0..1", () => {
    expect(p.alongFraction(0, DECK_NEAR_Z)).toBeCloseTo(0, 4);
    expect(p.alongFraction(0, DECK_FAR_Z)).toBeCloseTo(1, 4);
    expect(p.alongFraction(0, 0)).toBe(0); // behind near edge -> clamped
    expect(p.alongFraction(0, DECK_FAR_Z - 5)).toBe(1); // past far edge
  });
});

describe("alongLateralToWorld is the exact inverse of RunwayProjector", () => {
  const layouts: RunwayLayout[] = [
    DEFAULT_LAYOUT,
    { centerX: 1.2, centerZ: -2, yaw: 0.5, length: 9, width: 2 },
    { centerX: -3, centerZ: 1.5, yaw: -1.7, length: 4, width: 1 },
    { centerX: 0, centerZ: 0, yaw: Math.PI / 2, length: 12, width: 2.5 },
    { centerX: 2, centerZ: 2, yaw: Math.PI, length: 6, width: 1.4 },
  ];
  it("round-trips world->local->world for many points", () => {
    for (const layout of layouts) {
      const proj = new RunwayProjector(layout);
      for (let i = 0; i < 25; i++) {
        const along = (i / 24) * layout.length;
        const lateral = (((i * 37) % 11) / 10 - 0.5) * layout.width;
        const w = alongLateralToWorld(layout, along, lateral);
        expect(proj.along(w.x, w.z)).toBeCloseTo(along, 5);
        expect(proj.lateral(w.x, w.z)).toBeCloseTo(lateral, 5);
      }
    }
  });
});

describe("layoutFromEndpoints", () => {
  it("straight -Z run: start/end land at the right along, on the centerline", () => {
    const lay = layoutFromEndpoints(1, 2, 1, -4, 1.4);
    const proj = new RunwayProjector(lay);
    // walked 6m + insets -> length 6.75
    expect(lay.length).toBeCloseTo(6 + START_INSET + POSE_INSET, 5);
    expect(proj.along(1, 2)).toBeCloseTo(START_INSET, 4); // marked start
    expect(proj.along(1, -4)).toBeCloseTo(poseAlong(lay), 4); // marked end == pose mark
    expect(proj.lateral(1, 2)).toBeCloseTo(0, 4);
    expect(proj.lateral(1, -4)).toBeCloseTo(0, 4);
  });
  it("rotated run (+X): start/end + lateral sign are correct", () => {
    const lay = layoutFromEndpoints(0, 0, 3, 0, 1.2);
    const proj = new RunwayProjector(lay);
    expect(proj.along(0, 0)).toBeCloseTo(START_INSET, 4);
    expect(proj.along(3, 0)).toBeCloseTo(poseAlong(lay), 4);
    // a point to the "right" of a +X-forward walk is +Z
    expect(proj.lateral(1.5, 0.4)).toBeCloseTo(0.4, 4);
  });
  it("clamps a too-long walk to the max length", () => {
    const lay = layoutFromEndpoints(0, 0, 0, -100, 1.4);
    expect(lay.length).toBe(LAYOUT_LIMITS.maxLength);
  });
});

describe("sanitizeLayout", () => {
  it("clamps length/width/offset into the editable bounds", () => {
    const s = sanitizeLayout({ length: 999, width: 999, centerX: 999, centerZ: -999 });
    expect(s.length).toBe(LAYOUT_LIMITS.maxLength);
    expect(s.width).toBe(LAYOUT_LIMITS.maxWidth);
    expect(s.centerX).toBe(LAYOUT_LIMITS.maxOffset);
    expect(s.centerZ).toBe(-LAYOUT_LIMITS.maxOffset);
  });
  it("clamps below the minimums", () => {
    const s = sanitizeLayout({ length: 0.1, width: 0.1 });
    expect(s.length).toBe(LAYOUT_LIMITS.minLength);
    expect(s.width).toBe(LAYOUT_LIMITS.minWidth);
  });
  it("wraps yaw into (-2pi, 2pi) via JS modulo and fills defaults", () => {
    expect(sanitizeLayout({ yaw: Math.PI * 2.5 }).yaw).toBeCloseTo(Math.PI * 0.5, 6);
    const d = sanitizeLayout({});
    expect(d.length).toBe(DEFAULT_LAYOUT.length);
    expect(d.width).toBe(DEFAULT_LAYOUT.width);
  });
  it("coerces corrupt non-numeric stored values instead of producing NaN", () => {
    // Corrupt JSON (manual edit / schema drift) passes the `?? default` guard.
    const s = sanitizeLayout({
      length: "abc",
      width: "x",
      centerX: null as unknown as number,
      yaw: "nope",
    } as unknown as Record<string, number>);
    expect(Number.isFinite(s.length)).toBe(true);
    expect(Number.isFinite(s.width)).toBe(true);
    expect(Number.isFinite(s.centerX)).toBe(true);
    expect(Number.isFinite(s.yaw)).toBe(true);
  });
});

describe("along helpers + equality", () => {
  it("poseAlong / startAlong", () => {
    expect(poseAlong(DEFAULT_LAYOUT)).toBeCloseTo(STAGE.deckLength - POSE_INSET, 6);
    expect(poseAlong({ ...DEFAULT_LAYOUT, length: 0.2 })).toBe(0); // never negative
    expect(startAlong()).toBe(START_INSET);
  });
  it("layoutsEqual within tolerance", () => {
    expect(layoutsEqual(DEFAULT_LAYOUT, { ...DEFAULT_LAYOUT })).toBe(true);
    expect(layoutsEqual(DEFAULT_LAYOUT, { ...DEFAULT_LAYOUT, length: 8 })).toBe(false);
    expect(
      layoutsEqual(DEFAULT_LAYOUT, { ...DEFAULT_LAYOUT, centerX: 1e-6 }),
    ).toBe(true); // sub-tolerance
  });
  it("loadLayout returns the default when storage is unavailable (node)", () => {
    expect(layoutsEqual(loadLayout(), DEFAULT_LAYOUT)).toBe(true);
  });
});
