import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  applauseDurationSec,
  applauseGrains,
  applauseIntensity,
  HOUSE_BED_LEVELS,
  HOUSE_HUSH_TAU_SEC,
  HOUSE_MASTER_LEVEL,
  HOUSE_SWELL_TAU_SEC,
  houseBedLevel,
  houseBedTau,
} from "../src/house-reacts-core.js";

// THE HOUSE REACTS (display/audio-only theatrics): the pure curves + the
// wiring seams. WebAudio itself can't run in vitest — the graph/bus laws
// are file-scan pinned (the sfx.ts precedent) and verified live headless.

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("house-reacts core: the room's curves", () => {
  it("the countdown is the hush — the quietest beat of the show", () => {
    const phases = Object.keys(HOUSE_BED_LEVELS);
    for (const p of phases) {
      expect(houseBedLevel("countdown")).toBeLessThanOrEqual(
        houseBedLevel(p),
      );
    }
    // The walk stays attentive-quiet, under the social phases.
    expect(houseBedLevel("walk")).toBeLessThan(houseBedLevel("brief"));
    expect(houseBedLevel("walk")).toBeLessThan(houseBedLevel("summary"));
    // Unknown phases read as idle (defensive).
    expect(houseBedLevel("???")).toBe(houseBedLevel("idle"));
  });

  it("hushes fast, swells slow; the bed sits under the music", () => {
    expect(houseBedTau(0.5, 0.08)).toBe(HOUSE_HUSH_TAU_SEC);
    expect(houseBedTau(0.08, 0.42)).toBe(HOUSE_SWELL_TAU_SEC);
    expect(HOUSE_HUSH_TAU_SEC).toBeLessThan(HOUSE_SWELL_TAU_SEC);
    expect(HOUSE_MASTER_LEVEL).toBeLessThan(0.5); // a bed, not a voice
  });

  it("applause scales with the walk's own score - polite floor, ovation cap", () => {
    const bar = 78;
    const below = applauseIntensity(70, bar);
    const at = applauseIntensity(78, bar);
    const above = applauseIntensity(88, bar);
    const ovation = applauseIntensity(100, bar);
    expect(below).toBeCloseTo(0.35, 6); // a real house never boos a trainee
    expect(at).toBeCloseTo(0.7, 6);
    expect(above).toBeGreaterThan(at);
    expect(ovation).toBe(1);
    expect(applauseIntensity(Number.NaN, bar)).toBe(0);
    // Longer hands for bigger scores.
    expect(applauseDurationSec(1)).toBeGreaterThan(applauseDurationSec(0.35));
  });

  it("clap grains are deterministic per seed, bounded, and time-ordered", () => {
    const a = applauseGrains(0.8, 1234);
    const b = applauseGrains(0.8, 1234);
    const c = applauseGrains(0.8, 4321);
    expect(a).toEqual(b); // seeded — reproducible
    expect(a).not.toEqual(c); // varied across walks
    expect(a.length).toBeGreaterThan(50);
    const dur = applauseDurationSec(0.8);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].t).toBeGreaterThanOrEqual(0);
      expect(a[i].t).toBeLessThanOrEqual(dur);
      expect(a[i].level).toBeGreaterThan(0);
      expect(a[i].level).toBeLessThanOrEqual(1);
      if (i > 0) expect(a[i].t).toBeGreaterThanOrEqual(a[i - 1].t);
    }
    expect(applauseGrains(0, 1)).toEqual([]);
  });
});

describe("house-reacts wiring seams (file-scan pins)", () => {
  const system = read("../src/house-reacts.ts");
  const indexTs = read("../src/index.ts");

  it("registered on the shared-context phase chain, prefs-gated", () => {
    expect(indexTs).toContain("registerSystem(HouseReactsSystem");
    expect(system).toContain("acquireAudioContext");
    expect(system).toContain("sharedNoiseBuffer");
    expect(system).toContain("sfxLevel(prefs)");
    // The reset law: pending applause dies with its retired bus.
    expect(system).toContain("retireApplause");
    expect(system).toMatch(/if \(phase === "idle"\) this\.retireApplause\(\);/);
    // Reveal-anchored, graded off the summary's own bar.
    expect(system).toContain("REVEAL_DELAY_SEC");
    expect(system).toContain("applauseIntensity(");
  });
});
