import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { HOLD_WINDOW_SEC } from "../src/hold-stats.js";
import { MUSIC_BPM_OPTIONS } from "../src/music-prefs.js";
import {
  alignGridToGo,
  barSecOf,
  beatSecOf,
  countdownTickTimes,
  COUNTDOWN_SEC,
  stepSecOf,
  STEPS_PER_BAR,
} from "../src/show-timing.js";

// #44 — ONE clock: GO must land exactly on a bar boundary of the re-anchored
// grid, so THE DROP coincides with the countdown→walk flip instead of trailing
// it by 0.15–2.1 s. The tempo is now a RUNTIME value (the multi-BPM founder
// call), so every grid law is pinned across ALL deliverable tempos — plus the
// legacy 122 the golden tapes were recorded at.

const TEMPOS = [...MUSIC_BPM_OPTIONS, 122];

describe("show-timing tempo derivations", () => {
  it("beat/bar/step derive from the ONE bpm argument", () => {
    for (const bpm of TEMPOS) {
      expect(beatSecOf(bpm)).toBeCloseTo(60 / bpm, 10);
      expect(barSecOf(bpm)).toBeCloseTo((60 / bpm) * 4, 10);
      expect(stepSecOf(bpm)).toBeCloseTo(beatSecOf(bpm) / 2, 10);
    }
    expect(STEPS_PER_BAR).toBe(8);
  });

  it("keeps the countdown at 3 WHOLE seconds (HUD digits 3-2-1 mirror it)", () => {
    expect(COUNTDOWN_SEC).toBe(3);
    expect(Number.isInteger(COUNTDOWN_SEC)).toBe(true);
  });
});

describe("alignGridToGo (per deliverable tempo)", () => {
  const clocks: Array<[string, number]> = [
    ["cold start", 0.06],
    ["mid-session rerun (arbitrary clock)", 137.4182],
    ["late-night kiosk clock", 9007.333],
  ];
  const cases: Array<[string, number, number]> = TEMPOS.flatMap((bpm) =>
    clocks.map(
      ([name, now]) =>
        [`${name} @ ${bpm} BPM`, now, bpm] as [string, number, number],
    ),
  );

  it.each(cases)("%s: GO is an exact whole-bar multiple past gridStart", (_n, now, bpm) => {
    const go = now + COUNTDOWN_SEC;
    const bar = barSecOf(bpm);
    const a = alignGridToGo(now, go, bar, stepSecOf(bpm));
    const bars = (go - a.gridStart) / bar;
    expect(Math.abs(bars - Math.round(bars))).toBeLessThan(1e-9);
    expect(Math.round(bars)).toBeGreaterThanOrEqual(1);
  });

  it.each(cases)("%s: gridStart sits at-or-before now (step indices stay ≥ 0)", (_n, now, bpm) => {
    const go = now + COUNTDOWN_SEC;
    const a = alignGridToGo(now, go, barSecOf(bpm), stepSecOf(bpm));
    expect(a.gridStart).toBeLessThanOrEqual(now);
    expect(a.step).toBeGreaterThanOrEqual(0);
  });

  it.each(cases)("%s: the first scheduled step is on-grid and never in the past", (_n, now, bpm) => {
    const go = now + COUNTDOWN_SEC;
    const step = stepSecOf(bpm);
    const a = alignGridToGo(now, go, barSecOf(bpm), step);
    expect(a.nextStepTime).toBeGreaterThanOrEqual(now);
    expect(a.nextStepTime).toBeCloseTo(a.gridStart + a.step * step, 9);
    // Walking the 8th-note grid from nextStepTime lands a step EXACTLY on GO
    // (GO is a bar boundary, bars are whole numbers of steps).
    const stepsToGo = (go - a.nextStepTime) / step;
    expect(Math.abs(stepsToGo - Math.round(stepsToGo))).toBeLessThan(1e-9);
  });

  it("a 3 s countdown at 122 BPM reaches back exactly 2 bars (the legacy pin)", () => {
    const a = alignGridToGo(100, 103, barSecOf(122), stepSecOf(122));
    expect((103 - a.gridStart) / barSecOf(122)).toBeCloseTo(2, 9);
  });

  it("at 62 BPM a bar (~3.87 s) is LONGER than the countdown — one bar reaches back", () => {
    // The half-time option's regime: bars = ceil(3 / 3.871) = 1, and the
    // grid origin still sits at-or-before now.
    const bar = barSecOf(62);
    expect(bar).toBeGreaterThan(COUNTDOWN_SEC);
    const a = alignGridToGo(100, 103, bar, stepSecOf(62));
    expect((103 - a.gridStart) / bar).toBeCloseTo(1, 9);
    expect(a.gridStart).toBeLessThanOrEqual(100);
  });

  it("degenerate go ≤ now still yields a valid (≥ 1 bar) grid at every tempo", () => {
    for (const bpm of TEMPOS) {
      const bar = barSecOf(bpm);
      const a = alignGridToGo(50, 50, bar, stepSecOf(bpm));
      expect(a.gridStart).toBeLessThanOrEqual(50);
      expect((50 - a.gridStart) / bar).toBeCloseTo(1, 9);
    }
  });
});

describe("countdownTickTimes", () => {
  it("one tick per displayed digit, on the digit-flip second boundaries", () => {
    const go = 42;
    expect(countdownTickTimes(go)).toEqual([go - 3, go - 2, go - 1]);
  });

  it("matches the HUD digit rule: digit N displays while remaining ∈ (N-1, N]", () => {
    const go = 10;
    const ticks = countdownTickTimes(go, COUNTDOWN_SEC);
    ticks.forEach((t, i) => {
      const remaining = go - t;
      const digit = Math.max(1, Math.ceil(remaining - 1e-9));
      expect(digit).toBe(COUNTDOWN_SEC - i);
    });
  });

  it("degenerate zero-length countdown ticks nothing", () => {
    expect(countdownTickTimes(5, 0)).toEqual([]);
  });
});

// M10 — the ONE hold window (single-source identity): show.ts's POSE_HOLD_SEC
// (the one-way U's pose dwell before the finish) must BE hold-stats.ts's
// HOLD_WINDOW_SEC, by import alias. Moving either changes the U walk protocol
// for every trainee (a reserved founder call). ShowDirectorSystem itself is
// not vitest-loadable (@iwsdk/core), so the alias is pinned at the source
// text — the panel-ascii file-scan precedent.

describe("POSE_HOLD_SEC === HOLD_WINDOW_SEC (M10 import-alias law)", () => {
  it("hold-stats.ts owns the 1.6 s constant", () => {
    expect(HOLD_WINDOW_SEC).toBe(1.6);
  });

  it("show.ts defines POSE_HOLD_SEC as the import alias, never a literal", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/show.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toContain("const POSE_HOLD_SEC = HOLD_WINDOW_SEC;");
    // No second definition/reassignment may shadow the alias.
    const defs = src.match(/POSE_HOLD_SEC\s*=/g) ?? [];
    expect(defs).toHaveLength(1);
  });
});
