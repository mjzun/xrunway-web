import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  PADDLE_METRICS,
  PADDLE_RAISE_SEC,
  PADDLE_STAGGER_SEC,
  paddleRaise01,
  paddleValues,
} from "../src/judges-core.js";
import type { ShowSummary } from "../src/show.js";

// THE JUDGES' TABLE (display-only theatrics): the pure paddle pieces + the
// wiring seams (the dead-pill lesson — markup AND consumer pinned).

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const SUMMARY = {
  scores: {
    posture: 80,
    pace: 88.4,
    rhythm: 70,
    footPlacement: 99.6,
    presence: 80,
    confidence: 80,
    presentation: 80,
  },
  overall: 90,
  carriage: { carriageScore: 96.7 },
} as unknown as ShowSummary;

describe("judges' paddles: the pure pieces", () => {
  it("shows the SAME three numbers the summary card shows (honest '-' for a dark carriage)", () => {
    const v = paddleValues(SUMMARY);
    expect(v.map((x) => x.label)).toEqual(["PACE", "CARRIAGE", "LINE"]);
    expect(v.map((x) => x.value)).toEqual([88, 97, 100]);
    const dark = paddleValues({ ...SUMMARY, carriage: null } as ShowSummary);
    expect(dark[1].value).toBeNull();
    expect(PADDLE_METRICS.map((m) => m.label)).toEqual([
      "PACE",
      "CARRIAGE",
      "LINE",
    ]);
  });

  it("raises left to right, eased, bounded [0,1]", () => {
    expect(paddleRaise01(-0.1, 0)).toBe(0);
    // Judge 2's paddle has not started before its stagger.
    expect(paddleRaise01(PADDLE_STAGGER_SEC * 2 - 0.01, 2)).toBe(0);
    // Fully up after its own raise window.
    expect(paddleRaise01(PADDLE_RAISE_SEC, 0)).toBe(1);
    expect(
      paddleRaise01(PADDLE_STAGGER_SEC * 2 + PADDLE_RAISE_SEC, 2),
    ).toBe(1);
    // Monotone mid-raise.
    const a = paddleRaise01(0.2, 0);
    const b = paddleRaise01(0.3, 0);
    expect(b).toBeGreaterThan(a);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeLessThan(1);
  });
});

describe("judges' table: the wiring seams (file-scan pins)", () => {
  const stage = read("../src/stage.ts");
  const system = read("../src/judges-paddles.ts");
  const indexTs = read("../src/index.ts");

  it("the stage builds the table, clears the contour seats, exports anchors", () => {
    expect(stage).toContain("function buildJudgesTable");
    // Exclusion disc in the placement loop (the pit pattern).
    expect(stage).toContain("judgesR2 > 0");
    // Judges register with the crowd gaze, WITHOUT statement accents.
    expect(stage).toContain(
      "instanceAudienceModels(models, judgeSlots, add, dum, liveSeats, false)",
    );
    // Anchors exported + stale-cleared before every rebuild.
    expect(stage).toContain("g.judgesPaddles = {");
    expect(stage).toContain("g.judgesPaddles = null;");
  });

  it("the paddle system is registered and reveal-anchored", () => {
    expect(indexTs).toContain("registerSystem(JudgesPaddlesSystem");
    expect(system).toContain("REVEAL_DELAY_SEC");
    // Mid-summary rebuild lowers rather than floats stale paddles.
    expect(system).toContain("this.globals.judgesPaddles !== this.anchorsRef");
  });
});
