import { describe, expect, it } from "vitest";

import {
  buildCoachReport,
  CLEAN_WALK_CUE,
  LATERAL_SIDE_CONSISTENCY,
  METRIC_COACH,
  METRIC_EXPLAIN,
  passBarLabel,
  targetPaceLabel,
  verdictLine,
  walkStatLine,
  type CoachContext,
  type CoachReport,
  type MetricKey,
} from "../src/coach.ts";
import { MODES } from "../src/modes.ts";
import type { WalkStats } from "../src/walk-stats.ts";
// snap()/stats() and the report/note context defaults are SHARED with the
// golden-vector generator (test/case-helpers.ts) so the vectors and this
// suite are provably the same truth (SOLO-MODE §6.1).
import { coachContext, noteContext, snap, stats } from "./case-helpers.ts";

const BEGINNER = MODES[0]; // passThreshold 78

function report(over: Partial<CoachContext> = {}): CoachReport {
  return buildCoachReport(coachContext(over));
}

/** The single note produced when only `key` is below the line. */
function noteFor(
  key: MetricKey,
  walkStats: WalkStats | null,
  oneWayRoute = false,
) {
  const r = buildCoachReport(noteContext(key, walkStats, oneWayRoute));
  expect(r.notes).toHaveLength(1);
  expect(r.notes[0].key).toBe(key);
  return r.notes[0];
}

describe("coach verdict", () => {
  it("passes exactly at the mode's bar and rounds like the UIs do", () => {
    expect(report({ overall: 78 }).passed).toBe(true);
    expect(report({ overall: 77.5 }).passed).toBe(true); // rounds to 78
    expect(report({ overall: 77.49 }).passed).toBe(false);
    expect(report({ overall: 77 }).verdict).toBe("NEEDS WORK");
    expect(report({ overall: 78 }).verdict).toBe("PASS");
  });

  it("judges against each mode's OWN pass bar", () => {
    for (const m of MODES) {
      const pass = report({ mode: m, overall: m.passThreshold });
      const fail = report({ mode: m, overall: m.passThreshold - 1 });
      expect(pass.passed).toBe(true);
      expect(fail.passed).toBe(false);
      expect(pass.passThreshold).toBe(m.passThreshold);
      expect(verdictLine(pass)).toBe(`PASS - BAR ${m.passThreshold}`);
      expect(verdictLine(fail)).toBe(`NEEDS WORK - BAR ${m.passThreshold}`);
    }
  });

  it("reports the rounded overall the summary UIs display", () => {
    expect(report({ overall: 83.6 }).overall).toBe(84);
  });
});

describe("coach note selection (weight x shortfall)", () => {
  it("is empty when every metric clears the line", () => {
    expect(report({ scores: snap(90) }).notes).toHaveLength(0);
    // exactly at the bar is NOT below it
    expect(report({ scores: snap(78) }).notes).toHaveLength(0);
    // 77.6 rounds to 78 — clears
    expect(report({ scores: snap(77.6) }).notes).toHaveLength(0);
  });

  it("ranks below-line metrics by weight x shortfall, most costly first", () => {
    // Beginner weights: posture .2, pace .15 -> impacts 8*.2=1.6 vs 18*.15=2.7,
    // presence .1 * 1 = 0.1: expect pace, posture, presence.
    const r = report({
      scores: snap(95, { posture: 70, pace: 60, presence: 77 }),
      overall: 70,
    });
    expect(r.notes.map((n) => n.key)).toEqual(["pace", "posture", "presence"]);
  });

  it("caps at three notes", () => {
    const r = report({ scores: snap(50), overall: 50 });
    expect(r.notes).toHaveLength(3);
  });

  it("breaks impact ties in M1..M7 order", () => {
    // presence & confidence share weight .1 in Beginner; same score = same
    // impact, so the stable sort keeps presence (M5) before confidence (M6).
    const r = report({
      scores: snap(95, { presence: 70, confidence: 70 }),
      overall: 85,
    });
    expect(r.notes.map((n) => n.key)).toEqual(["presence", "confidence"]);
  });
});

describe("directional pace copy", () => {
  it("says slow down with the real numbers when too fast", () => {
    const n = noteFor(
      "pace",
      stats({ meanPaceMps: 1.1, idealPaceMps: 0.72, paceDeltaMps: 0.38 }),
    );
    expect(n.cue).toBe(
      "You averaged 1.10 m/s against a 0.72 m/s target - slow every stride down.",
    );
    expect(n.directional).toBe(true);
  });

  it("says pick it up when too slow", () => {
    const n = noteFor(
      "pace",
      stats({ meanPaceMps: 0.55, idealPaceMps: 0.85, paceDeltaMps: -0.3 }),
    );
    expect(n.cue).toBe(
      "You averaged 0.55 m/s against a 0.85 m/s target - pick every stride up.",
    );
  });

  it("falls back to the band cue when the channel is null or dead-on", () => {
    expect(noteFor("pace", stats()).cue).toBe(METRIC_COACH.pace);
    expect(
      noteFor(
        "pace",
        stats({ meanPaceMps: 0.85, idealPaceMps: 0.85, paceDeltaMps: 0 }),
      ).cue,
    ).toBe(METRIC_COACH.pace);
    const n = noteFor("pace", null);
    expect(n.cue).toBe(METRIC_COACH.pace);
    expect(n.directional).toBe(false);
  });

  it("falls back when the delta is below display resolution (identical rounded numbers)", () => {
    // 0.853 vs 0.85 both render "0.85" at toFixed(2): a directional command
    // against two identical cited numbers would contradict itself.
    const n = noteFor(
      "pace",
      stats({ meanPaceMps: 0.853, idealPaceMps: 0.85, paceDeltaMps: 0.003 }),
    );
    expect(n.cue).toBe(METRIC_COACH.pace);
    expect(n.directional).toBe(false);
    // Just past display resolution the directional claim is honest again.
    expect(
      noteFor(
        "pace",
        stats({ meanPaceMps: 0.86, idealPaceMps: 0.85, paceDeltaMps: 0.01 }),
      ).cue,
    ).toBe("You averaged 0.86 m/s against a 0.85 m/s target - slow every stride down.");
  });
});

describe("directional posture copy", () => {
  it("says rode above from a positive drift, in cm", () => {
    const n = noteFor("posture", stats({ postureDriftM: 0.035 }));
    expect(n.cue).toBe(
      "You rode 4 cm above your start height - settle down, no bounce.",
    );
    expect(n.directional).toBe(true);
  });

  it("says sank below from a negative drift", () => {
    expect(noteFor("posture", stats({ postureDriftM: -0.02 })).cue).toBe(
      "You sank 2 cm below your start height - lift through the crown.",
    );
  });

  it("falls back when null or sub-centimeter", () => {
    expect(noteFor("posture", stats()).cue).toBe(METRIC_COACH.posture);
    expect(noteFor("posture", stats({ postureDriftM: 0.004 })).cue).toBe(
      METRIC_COACH.posture,
    );
    expect(noteFor("posture", null).cue).toBe(METRIC_COACH.posture);
  });
});

describe("footwork lateral honesty gate", () => {
  const consistent = stats({ meanLateralM: 0.08, meanAbsLateralM: 0.09 });

  it("names a side ONLY on a one-way route with a consistent side", () => {
    const n = noteFor("footPlacement", consistent, true);
    expect(n.cue).toBe(
      "You drifted 9 cm right of the centerline - pull it back to center.",
    );
    expect(n.directional).toBe(true);
  });

  it("says left for a negative consistent mean on a one-way route", () => {
    expect(
      noteFor(
        "footPlacement",
        stats({ meanLateralM: -0.08, meanAbsLateralM: 0.09 }),
        true,
      ).cue,
    ).toBe("You drifted 9 cm left of the centerline - pull it back to center.");
  });

  it("NEVER names a side on an out-and-back route (sign flips on the return)", () => {
    expect(noteFor("footPlacement", consistent, false).cue).toBe(
      "You averaged 9 cm off the centerline - tighten your line.",
    );
  });

  it("stays magnitude-only when the side was not consistent enough", () => {
    // |0.02| / 0.09 = 0.22 < 0.6 — weaving, not holding a side.
    expect(
      noteFor(
        "footPlacement",
        stats({ meanLateralM: 0.02, meanAbsLateralM: 0.09 }),
        true,
      ).cue,
    ).toBe("You averaged 9 cm off the centerline - tighten your line.");
  });

  it("names a side exactly AT the consistency bound", () => {
    // 0.06 / 0.10 = LATERAL_SIDE_CONSISTENCY exactly (gate is >=).
    expect(LATERAL_SIDE_CONSISTENCY).toBeCloseTo(0.06 / 0.1, 12);
    expect(
      noteFor(
        "footPlacement",
        stats({ meanLateralM: 0.06, meanAbsLateralM: 0.1 }),
        true,
      ).cue,
    ).toContain("right of the centerline");
  });

  it("falls back when null or sub-centimeter", () => {
    expect(noteFor("footPlacement", stats(), true).cue).toBe(
      METRIC_COACH.footPlacement,
    );
    expect(
      noteFor(
        "footPlacement",
        stats({ meanLateralM: 0.002, meanAbsLateralM: 0.004 }),
        true,
      ).cue,
    ).toBe(METRIC_COACH.footPlacement);
    expect(noteFor("footPlacement", null).cue).toBe(
      METRIC_COACH.footPlacement,
    );
  });
});

describe("rhythm copy", () => {
  it("cites the real step count and cadence when available", () => {
    const n = noteFor("rhythm", stats({ steps: 58, cadenceSpm: 96.2 }));
    expect(n.cue).toBe("58 steps at 96 per minute - keep the interval even.");
    expect(n.directional).toBe(true);
  });

  it("falls back when no steps were detected", () => {
    expect(noteFor("rhythm", stats()).cue).toBe(METRIC_COACH.rhythm);
    expect(noteFor("rhythm", null).cue).toBe(METRIC_COACH.rhythm);
  });
});

describe("composite metrics never claim measurements", () => {
  const COMPOSITES = ["presence", "confidence", "presentation"] as const;

  it("M5-M7 explainers say COMPOSITE outright and disclaim separate measurement (#10)", () => {
    for (const key of COMPOSITES) {
      const copy = METRIC_EXPLAIN[key].toLowerCase();
      expect(copy, key).toContain("composite");
      expect(copy, key).toContain("not separately measured");
    }
  });

  it("M5-M7 explainers/cues never sell qualities nothing observes", () => {
    // The old copy claimed eyeline, command, hesitation, and the turn — none
    // of which any derivation path reads (metrics.ts: pure re-weightings of
    // posture/pace/rhythm/footwork; no head-orientation input exists). The
    // only permitted mentions are explicit disclaimers ("not tracked" /
    // "not analyzed").
    for (const key of COMPOSITES) {
      for (const copy of [METRIC_EXPLAIN[key], METRIC_COACH[key]]) {
        const lower = copy.toLowerCase();
        for (const claim of ["eyeline", "turn", "hesitation", "wobble"]) {
          if (!lower.includes(claim)) continue;
          expect(
            lower.includes(`${claim} is not tracked`) ||
              lower.includes(`${claim} is not analyzed`),
            `${key} copy sells "${claim}" without a disclaimer: ${copy}`,
          ).toBe(true);
        }
      }
    }
  });

  it("M5-M7 cues coach the measured channels the composite is built from", () => {
    // metrics.ts blends: presence <- posture/rhythm/pace; confidence <- all
    // four; presentation <- all four. A cue must name at least one of its
    // real inputs so "how do I improve it" has an honest answer.
    for (const key of COMPOSITES) {
      const cue = METRIC_COACH[key].toLowerCase();
      expect(
        ["posture", "pace", "rhythm", "footwork", "measured channels"].some(
          (channel) => cue.includes(channel),
        ),
        `${key} cue points at no measured channel: ${cue}`,
      ).toBe(true);
    }
  });

  it("presence/confidence/presentation always take the generic band cue", () => {
    const full = stats({
      meanPaceMps: 1.1,
      paceDeltaMps: 0.25,
      meanLateralM: 0.08,
      meanAbsLateralM: 0.09,
      postureDriftM: -0.03,
      steps: 58,
      cadenceSpm: 96,
    });
    for (const key of ["presence", "confidence", "presentation"] as const) {
      const n = noteFor(key, full, true);
      expect(n.cue).toBe(METRIC_COACH[key]);
      expect(n.directional).toBe(false);
    }
  });
});

describe("shared labels + summary lines", () => {
  it("formats the pass bar and honest target-pace chips", () => {
    expect(passBarLabel(78)).toBe("PASS AT 78");
    expect(targetPaceLabel(0.85)).toBe("TARGET 0.85 M/S");
    expect(targetPaceLabel(0.72)).toBe("TARGET 0.72 M/S");
    expect(targetPaceLabel(1.05)).toBe("TARGET 1.05 M/S");
  });

  it("builds the duration + real steps/cadence line", () => {
    expect(
      walkStatLine(58.4, stats({ steps: 58, cadenceSpm: 96.2 })),
    ).toBe("58S ON THE RUNWAY - 58 STEPS - 96/MIN");
    expect(walkStatLine(58.4, null)).toBe("58S ON THE RUNWAY");
    expect(walkStatLine(41, stats({ steps: 0 }))).toBe("41S ON THE RUNWAY");
    expect(walkStatLine(41, stats({ steps: 12, cadenceSpm: null }))).toBe(
      "41S ON THE RUNWAY - 12 STEPS",
    );
  });

  it("takes a separator for DOM surfaces; the ASCII default is the XR-panel constraint", () => {
    // The landing passes " · " to keep its middle-dot typography; hud.ts
    // stays on the default because the panel font has no middle-dot glyph.
    expect(
      walkStatLine(58.4, stats({ steps: 58, cadenceSpm: 96.2 }), " · "),
    ).toBe("58S ON THE RUNWAY · 58 STEPS · 96/MIN");
    expect(walkStatLine(41, stats({ steps: 12, cadenceSpm: null }), " · ")).toBe(
      "41S ON THE RUNWAY · 12 STEPS",
    );
    // No stats -> no separator in play; the base line is surface-agnostic.
    expect(walkStatLine(58.4, null, " · ")).toBe("58S ON THE RUNWAY");
  });
});

describe("panel-safe copy (ASCII punctuation only)", () => {
  it("every string the coach can emit renders on the XR panel font", () => {
    const ascii = /^[\x20-\x7E]+$/;
    const cues: string[] = [
      ...Object.values(METRIC_EXPLAIN),
      ...Object.values(METRIC_COACH),
      CLEAN_WALK_CUE,
      passBarLabel(82),
      targetPaceLabel(1.05),
      walkStatLine(58.4, stats({ steps: 58, cadenceSpm: 96.2 })),
      walkStatLine(58.4, null),
    ];
    // every directional variant
    const variants: Array<[MetricKey, WalkStats, boolean]> = [
      ["pace", stats({ meanPaceMps: 1.1, paceDeltaMps: 0.25 }), false],
      ["pace", stats({ meanPaceMps: 0.5, paceDeltaMps: -0.35 }), false],
      ["posture", stats({ postureDriftM: 0.03 }), false],
      ["posture", stats({ postureDriftM: -0.03 }), false],
      ["footPlacement", stats({ meanLateralM: 0.08, meanAbsLateralM: 0.09 }), true],
      ["footPlacement", stats({ meanLateralM: -0.08, meanAbsLateralM: 0.09 }), true],
      ["footPlacement", stats({ meanLateralM: 0.01, meanAbsLateralM: 0.09 }), false],
      ["rhythm", stats({ steps: 58, cadenceSpm: 96.2 }), false],
    ];
    for (const [key, st, oneWay] of variants) {
      cues.push(noteFor(key, st, oneWay).cue);
    }
    const passing = report({ overall: 90 });
    const failing = report({ overall: 40, scores: snap(50) });
    cues.push(passing.verdict, failing.verdict);
    cues.push(verdictLine(passing), verdictLine(failing));
    for (const s of cues) {
      expect(s, `non-ASCII in: ${s}`).toMatch(ascii);
    }
  });
});
