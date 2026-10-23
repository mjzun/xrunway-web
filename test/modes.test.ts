import { describe, expect, it } from "vitest";

import { DEFAULT_MODE, getMode, MODES, type ModeId } from "../src/modes.ts";

const METRIC_KEYS = [
  "posture",
  "pace",
  "rhythm",
  "footPlacement",
  "presence",
  "confidence",
  "presentation",
] as const;

describe("training modes", () => {
  it("has the four business-model modes with unique ids", () => {
    const ids = MODES.map((m) => m.id);
    expect(ids).toEqual(["beginner", "highfashion", "commercial", "challenge"]);
    expect(new Set(ids).size).toBe(4);
  });

  it("every mode's overall weights sum to 1 over exactly the 7 metrics", () => {
    for (const m of MODES) {
      const keys = Object.keys(m.weights).sort();
      expect(keys).toEqual([...METRIC_KEYS].sort());
      const sum = METRIC_KEYS.reduce((a, k) => a + m.weights[k], 0);
      expect(sum).toBeCloseTo(1, 6);
    }
  });

  it("has sane pacing / ideal-pace / thresholds per mode", () => {
    for (const m of MODES) {
      expect(m.walkSeconds).toBeGreaterThanOrEqual(15);
      expect(m.walkSeconds).toBeLessThanOrEqual(120);
      expect(m.idealPace).toBeGreaterThan(0.4);
      expect(m.idealPace).toBeLessThan(1.6);
      expect(m.passThreshold).toBeGreaterThanOrEqual(60);
      expect(m.passThreshold).toBeLessThanOrEqual(95);
      expect(m.intensity).toBeGreaterThanOrEqual(0);
      expect(m.intensity).toBeLessThanOrEqual(1);
      expect(m.number).toMatch(/^0[1-4]$/);
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.instruction.length).toBeGreaterThan(10);
    }
  });

  it("getMode resolves by id and falls back to the default", () => {
    expect(getMode("challenge").id).toBe("challenge");
    expect(getMode("nope" as ModeId).id).toBe(DEFAULT_MODE.id);
  });
});
