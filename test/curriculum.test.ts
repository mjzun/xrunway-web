import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LATERAL_CUE_M, PACE_DELTA_CUE_MPS } from "../src/coach-live.js";
import { M8_PITCH_BAND_DEG } from "../src/head-carriage.js";
import {
  BANNED_EVERYWHERE,
  BANNED_IN_CRITERIA,
  COLD_GAP_MS,
  CURRICULUM_DISCLOSURES,
  CURRICULUM_LEVELS,
  DISPLAYED_CHANNELS,
  DRILLS,
  LEVEL_BANDS,
  MIN_TIB_SAMPLES,
  SESSION_SPLIT_MS,
  SHIPPED_DRILLS,
  drillForChannel,
  evaluateGate,
  gateCopy,
  latestColdBlock,
  planCopy,
  recommendedLevelIndex,
  timeInBand,
  weakestChannel,
  type ColdBlock,
  type TimeInBand,
} from "../src/curriculum-core.js";
import type { MetricSample } from "../src/session-recorder.js";

// WAVE-4 CURRICULUM pins (docs/CURRICULUM-DESIGN.md — the hostile-reviewed
// spec). These lock the design LAWS: display-before-gate, cold-block
// evidence, namesake non-compensability, soft gates, and the do-not-print
// lint the spec makes a design law (§0).

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const sample = (over: Partial<MetricSample>): MetricSample =>
  ({
    t: 0,
    alongM: 0,
    lateralM: 0,
    paceMps: 0.85,
    headPitchDeg: 0,
    ...over,
  }) as unknown as MetricSample;

describe("curriculum spine (spec §1)", () => {
  it("five levels, the spec's namesakes, gates on displayed channels only", () => {
    expect(CURRICULUM_LEVELS.map((l) => l.name)).toEqual([
      "THE LINE",
      "THE WALK",
      "THE TURN",
      "THE SHOW",
      "THE SIGNATURE",
    ]);
    expect(CURRICULUM_LEVELS.map((l) => l.namesake)).toEqual([
      "line",
      "pace",
      "carriage",
      "line",
      null,
    ]);
    expect(DISPLAYED_CHANNELS).toEqual(["pace", "line", "carriage"]);
  });

  it("Level-1 bands anchor to the ENGINE's own cue gates (never re-derived)", () => {
    expect(LEVEL_BANDS[0].lineM).toBe(LATERAL_CUE_M);
    expect(LEVEL_BANDS[0].paceMps).toBe(PACE_DELTA_CUE_MPS);
    expect(LEVEL_BANDS[2].carriageDeg).toBe(M8_PITCH_BAND_DEG);
  });

  it("bands tighten monotonically; L5's floor IS L4's pass bar (anti-gaming)", () => {
    for (let i = 1; i < 4; i += 1) {
      expect(LEVEL_BANDS[i].lineM).toBeLessThanOrEqual(LEVEL_BANDS[i - 1].lineM);
      expect(LEVEL_BANDS[i].paceMps).toBeLessThanOrEqual(LEVEL_BANDS[i - 1].paceMps);
      expect(LEVEL_BANDS[i].passPct).toBeGreaterThanOrEqual(LEVEL_BANDS[i - 1].passPct);
    }
    expect(LEVEL_BANDS[4].floorPct).toBe(LEVEL_BANDS[3].passPct);
  });

  it("drills: D1-D3 shipped on displayed channels; D4-D8 wait on surfacing", () => {
    expect(SHIPPED_DRILLS.map((d) => d.id)).toEqual(["D1", "D2", "D3"]);
    for (const d of SHIPPED_DRILLS) {
      expect(DISPLAYED_CHANNELS).toContain(d.channel);
    }
    expect(DRILLS.filter((d) => !d.shipped).map((d) => d.id)).toEqual([
      "D4",
      "D5",
      "D6",
      "D7",
      "D8",
    ]);
  });
});

describe("time-in-band (the curriculum statistic)", () => {
  const bands = LEVEL_BANDS[0];
  it("counts exact in-band fractions per channel", () => {
    const samples = [
      ...Array.from({ length: 8 }, () => sample({ lateralM: 0.05 })),
      ...Array.from({ length: 2 }, () => sample({ lateralM: 0.5 })),
    ];
    const tib = timeInBand(samples, bands, 0.85);
    expect(tib.line).toBe(80);
    expect(tib.pace).toBe(100);
    expect(tib.carriage).toBe(100);
  });
  it("never fabricates: below MIN_TIB_SAMPLES reads null; pace needs a target", () => {
    const few = Array.from({ length: MIN_TIB_SAMPLES - 1 }, () => sample({}));
    const tib = timeInBand(few, bands, 0.85);
    expect(tib.line).toBeNull();
    const noTarget = timeInBand(
      Array.from({ length: 10 }, () => sample({})),
      bands,
      null,
    );
    expect(noTarget.pace).toBeNull();
    expect(noTarget.line).toBe(100);
  });
});

describe("cold-block evidence (F4/F7; conventions DESIGN)", () => {
  const H = 3600 * 1000;
  const row = (startedAt: number, line: number): { startedAt: number; tib: TimeInBand } => ({
    startedAt,
    tib: { pace: 90, line, carriage: 85 },
  });
  it("same-day walks are never cold; a day-later session yields the median of walks 2-4", () => {
    const rows = [
      row(0, 60),
      row(10 * 60 * 1000, 62),
      // next day (> COLD_GAP_MS later): re-entry + three evidence walks
      row(COLD_GAP_MS + 2 * H, 10), // the unscored re-entry (discarded)
      row(COLD_GAP_MS + 2 * H + 5 * 60 * 1000, 80),
      row(COLD_GAP_MS + 2 * H + 10 * 60 * 1000, 70),
      row(COLD_GAP_MS + 2 * H + 15 * 60 * 1000, 90),
    ];
    const block = latestColdBlock(rows);
    expect(block).not.toBeNull();
    expect(block!.median.line).toBe(80); // median(80,70,90), re-entry excluded
    expect(block!.walks).toBe(3);
  });
  it("an incomplete cold session (under 1+3 walks) yields no evidence", () => {
    const rows = [
      row(0, 60),
      row(COLD_GAP_MS + 2 * H, 90),
      row(COLD_GAP_MS + 2 * H + 5 * 60 * 1000, 90),
      row(COLD_GAP_MS + 2 * H + 10 * 60 * 1000, 90),
    ];
    expect(latestColdBlock(rows)).toBeNull();
  });
  it("the very first session never counts as cold", () => {
    const rows = [row(0, 90), row(1000, 90), row(2000, 90), row(3000, 90)];
    expect(latestColdBlock(rows)).toBeNull();
    expect(SESSION_SPLIT_MS).toBeLessThan(COLD_GAP_MS);
  });
});

describe("gates (F12 mechanics; namesake non-compensable DESIGN)", () => {
  const L1 = CURRICULUM_LEVELS[0];
  const block = (pace: number | null, line: number | null, carriage: number | null): ColdBlock => ({
    median: { pace, line, carriage },
    at: 0,
    walks: 3,
  });
  it("namesake below the pass bar cannot be compensated", () => {
    // L1 namesake = line (pass 70); others clear their floors easily.
    expect(evaluateGate(L1, block(100, 69, 100)).pass).toBe(false);
    expect(evaluateGate(L1, block(100, 70, 100)).pass).toBe(true);
  });
  it("floors first: any other channel under its floor blocks the gate", () => {
    expect(evaluateGate(L1, block(54, 100, 100)).pass).toBe(false);
    expect(evaluateGate(L1, block(56, 100, 100)).pass).toBe(true);
  });
  it("missing evidence never passes (display-before-gate: no invisible criteria)", () => {
    expect(evaluateGate(L1, block(null, 100, 100)).pass).toBe(false);
    expect(evaluateGate(L1, null).pass).toBe(false);
  });
  it("THE SIGNATURE never auto-passes (declared bands are their own pass)", () => {
    expect(evaluateGate(CURRICULUM_LEVELS[4], block(100, 100, 100)).pass).toBe(false);
  });
  it("recommendation is sequential from the bottom", () => {
    expect(recommendedLevelIndex(null)).toBe(-1);
    expect(recommendedLevelIndex(block(100, 100, 100))).toBeGreaterThanOrEqual(0);
  });
  it("gate copy: soft 'Not yet' wording, names channel + numbers, never the banned word", () => {
    const v = evaluateGate(L1, block(100, 40, 100));
    const copy = gateCopy(v, L1.name);
    expect(copy.startsWith("Not yet.")).toBe(true);
    expect(copy).toContain("LINE 40 of 70");
    expect(/\bfail(ed|s)?\b/i.test(copy)).toBe(false);
    expect(gateCopy(evaluateGate(L1, block(100, 100, 100)), L1.name)).toContain(
      "held cold",
    );
  });
});

describe("the planner (spec §3)", () => {
  const row = (line: number, carriage: number): { startedAt: number; tib: TimeInBand } => ({
    startedAt: 0,
    tib: { pace: 90, line, carriage },
  });
  it("weakest DISPLAYED channel wins; null until enough stamped rows", () => {
    expect(weakestChannel([row(50, 90), row(52, 88)])).toBe("line");
    expect(weakestChannel([row(90, 40), row(88, 44)])).toBe("carriage");
    expect(weakestChannel([row(50, 90)])).toBeNull();
  });
  it("the plan names the weakest channel's shipped drill", () => {
    expect(drillForChannel("line")!.id).toBe("D1");
    expect(planCopy("line")).toContain("TAPE LINE");
    expect(planCopy(null)).toContain("Today:");
  });
});

describe("THE DO-NOT-PRINT LINT (spec §0 — a design law, enforced here)", () => {
  const wordRe = (w: string): RegExp => new RegExp(`\\b${w}`, "i");
  const scored = CURRICULUM_LEVELS.flatMap((l) => l.criteria);
  const learnerFacing = [
    ...scored,
    ...CURRICULUM_LEVELS.flatMap((l) => l.cueOnly),
    ...DRILLS.map((d) => d.blurb),
    ...CURRICULUM_DISCLOSURES,
    planCopy("line"),
    planCopy(null),
    gateCopy(evaluateGate(CURRICULUM_LEVELS[0], null), "THE LINE"),
  ];
  it("scored criteria are head-kinematics-only (no eye/body language)", () => {
    for (const c of scored) {
      for (const banned of BANNED_IN_CRITERIA) {
        expect(wordRe(banned).test(c), `"${banned}" in scored criterion: ${c}`).toBe(false);
      }
    }
  });
  it("no learner string carries a banned phrase (source-prominence + candor laws)", () => {
    for (const str of learnerFacing) {
      for (const banned of BANNED_EVERYWHERE) {
        expect(wordRe(banned).test(str), `"${banned}" in: ${str}`).toBe(false);
      }
      expect(/\d+\s*BPM/i.test(str), `numeric BPM in: ${str}`).toBe(false);
    }
  });
  it("the seven disclosures ship, sensing-first", () => {
    expect(CURRICULUM_DISCLOSURES).toHaveLength(7);
    expect(CURRICULUM_DISCLOSURES[0]).toContain(
      "does not see your eyes, feet, hips, arms, or face",
    );
  });
});

describe("wiring seams (the dead-pill lesson)", () => {
  it("the recorder latches the drill and stamps tib + drillScore", () => {
    const rec = read("../src/session-recorder.ts");
    for (const pin of [
      "drillId: meta.drillId ?? null",
      "timeInBand(",
      "drillById(this.current.drillId)",
      "drillScore,",
      "tib,",
    ]) {
      expect(rec).toContain(pin);
    }
  });
  it("the landing paints the card and wires the three drill chips", () => {
    const landing = read("../src/landing.ts");
    for (const pin of [
      "renderCurriculum",
      'byId("cur-level-line")',
      'byId("cur-record-line")',
      'byId("cur-plan-line")',
      "g.activeDrill",
      "`drill-${d.id}`",
    ]) {
      expect(landing).toContain(pin);
    }
  });
  it("index.html carries the static shell with the [hidden] law", () => {
    const html = read("../index.html");
    for (const pin of [
      'id="curriculum-block"',
      'id="cur-level-line"',
      'id="drill-D1"',
      'id="drill-D2"',
      'id="drill-D3"',
      'id="cur-drill-note"',
    ]) {
      expect(html).toContain(pin);
    }
    const css = html.slice(html.indexOf("#curriculum-block {"));
    expect(css.slice(0, 2000)).toContain("display: none !important");
  });
});
