import { describe, it, expect } from "vitest";
import {
  HEAVE_SEG_X,
  HEAVE_SEG_Y,
  SEAT_STEP,
  AUDIENCE_MAX_COL,
  LAMPS_MAX_PER_SEG,
  unifiedFloorGridSize,
  audienceColumnCount,
  lampCount,
} from "../src/stage-budget.js";
import {
  compileShape,
  shapeFloorPlan,
  shapeOutline,
  roundOutline,
  sanitizeShape,
  PRESET_RUNWAYS,
  type RunwayShape,
} from "../src/runway-shape.js";

// Guards the crash-proofing budget (BUDGET.md): every size-scaling stage contributor
// must stay bounded so no preset / slider extreme can re-create a GPU/main-thread
// overrun on the Quest. These mirror the worst-case numbers in BUDGET.md.

const FLOOR_TRIS_CAP = HEAVE_SEG_X * HEAVE_SEG_Y * 2; // 9216

const perimeter = (outline: Array<[number, number]>): number => {
  let L = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    L += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return L;
};

// The perimeter the audience builder ACTUALLY walks — the ROUNDED outline, exactly
// as stage.ts buildShapeAudience computes it (roundOutline with the straight branch).
// Using the raw shapeOutline would measure a different, longer contour.
const audienceContourLen = (shape: RunwayShape): number => {
  const plan = shapeFloorPlan(compileShape(shape));
  const isStraight = shape.kind === "straight";
  const outline = roundOutline(
    shapeOutline(plan),
    isStraight ? 0 : 0.6,
    isStraight ? 0 : 0.3,
  );
  return perimeter(outline);
};

const MAX_SHAPES: Array<[string, Partial<RunwayShape>]> = [
  ["straight max", { kind: "straight", spineLength: 80, spineWidth: 3 }],
  ["T max", { kind: "T", spineLength: 80, spineWidth: 3, armSpan: 24, armWidth: 6, crossAt: 0.9 }],
  ["X max", { kind: "X", spineLength: 80, spineWidth: 3, armSpan: 24, armWidth: 6, crossAt: 0.5 }],
  ["U max", { kind: "U", spineLength: 80, spineWidth: 3, armSpan: 24, armWidth: 6 }],
];

describe("stage budget — floor grid (H1)", () => {
  it("a default 1.4x7 deck keeps the full intended density (unchanged by the cap)", () => {
    const g = unifiedFloorGridSize(1.4, 7);
    expect(g.nx).toBe(HEAVE_SEG_X);
    expect(g.nz).toBe(HEAVE_SEG_Y);
  });

  it("SATURATES at the cap on a large footprint — the cap does real work", () => {
    // The teeth of the suite: g.tris <= cap is tautological (the helper min()s it),
    // so instead assert the grid actually SATURATES at the cap. Dropping the min()
    // from unifiedFloorGridSize (the H1 fix) makes nx/nz blow past the cap and this
    // fails — whereas a `<= cap` assertion never could.
    const g = unifiedFloorGridSize(500, 500);
    expect(g.nx).toBe(HEAVE_SEG_X);
    expect(g.nz).toBe(HEAVE_SEG_Y);
    expect(g.tris).toBe(FLOOR_TRIS_CAP);
    // And confirm an uncapped grid WOULD have exceeded the cap (so the bound matters).
    const uncappedTris = Math.round(500 / (1.4 / HEAVE_SEG_X)) *
      Math.round(500 / (7 / HEAVE_SEG_Y)) * 2;
    expect(uncappedTris).toBeGreaterThan(FLOOR_TRIS_CAP * 100);
  });

  it("every slider extreme engages the cap on its long axis (and stays bounded)", () => {
    for (const [name, shp] of MAX_SHAPES) {
      const plan = shapeFloorPlan(compileShape(sanitizeShape(shp)));
      const g = unifiedFloorGridSize(plan.width, plan.length);
      // An 80 m maxed shape is long enough to saturate the along axis at the cap.
      expect(g.nz, `${name} floor nz`).toBe(HEAVE_SEG_Y);
      expect(g.tris, `${name} floor tris`).toBeLessThanOrEqual(FLOOR_TRIS_CAP);
    }
  });

  it("every preset's floor stays within the triangle cap", () => {
    for (const p of PRESET_RUNWAYS) {
      const plan = shapeFloorPlan(compileShape(sanitizeShape(p.shape)));
      const g = unifiedFloorGridSize(plan.width, plan.length);
      expect(g.tris, `${p.name} floor tris`).toBeLessThanOrEqual(FLOOR_TRIS_CAP);
    }
  });
});

describe("stage budget — audience columns", () => {
  it("the cap is chosen so NO shipped preset is thinned", () => {
    for (const p of PRESET_RUNWAYS) {
      const shape = sanitizeShape(p.shape);
      // Measure the SAME rounded contour the audience builder walks (not the raw
      // outline) so this reflects the runtime Ncol, not a longer phantom perimeter.
      const cols = audienceColumnCount(audienceContourLen(shape));
      // If a future preset exceeds the cap this trips — raise the cap deliberately
      // (and re-check the Quest budget) rather than silently thinning the crowd.
      expect(cols, `${p.name} audience columns`).toBeLessThan(AUDIENCE_MAX_COL);
    }
  });

  it("beyond-preset extremes saturate at the cap", () => {
    for (const [name, shp] of MAX_SHAPES) {
      const cols = audienceColumnCount(audienceContourLen(sanitizeShape(shp)));
      expect(cols, `${name} audience columns`).toBe(AUDIENCE_MAX_COL);
    }
  });

  it("never drops below a sensible floor", () => {
    expect(audienceColumnCount(0)).toBe(8);
    expect(audienceColumnCount(1)).toBe(8);
  });
});

describe("stage budget — overhead lamps", () => {
  it("saturate at the per-segment cap on a long segment, floor at 2 on a short one", () => {
    expect(lampCount(80)).toBe(LAMPS_MAX_PER_SEG);
    expect(lampCount(1000)).toBe(LAMPS_MAX_PER_SEG);
    expect(lampCount(0.5)).toBe(2);
  });
});
