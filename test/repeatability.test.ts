import { describe, expect, it } from "vitest";

import { SERIES_MAX } from "../src/progress.ts";
import {
  BENCHMARK_HEADLINE_SHOWN,
  BENCHMARK_MODE_ID,
  BENCHMARK_SHAPE_KIND,
  BENCHMARK_TOOLTIP,
  benchmarkAtFinalize,
  benchmarkConfigAtWalkStart,
  benchmarkHeadline,
  benchmarkLine,
  benchmarkRows,
  benchmarkSeries,
  DEFAULT_NORMALIZATION,
  isBenchmarkRow,
  LEGACY_MUSIC_BPM,
  LEGACY_WALK_SECONDS,
  REPEAT_DISCLOSURE,
  REPEAT_MIN_WALKS,
  REPEAT_OUTLIER_DOMINANCE,
  REPEAT_OUTLIER_PCT,
  REPEAT_WINDOW,
  repeatabilityReport,
  rowMusicBpm,
  rowWalkSeconds,
  rowNormalizationFallback,
  withinPct,
} from "../src/repeatability.ts";
import { rowNormalization } from "../src/session-grading.ts";
// slice()/walkRow()/paceWalks()/fullWalks()/benchRow() are SHARED with the
// golden-vector generator (test/repeat-helpers.ts) so the vectors and this
// suite are provably the same truth (the case-helpers.ts pattern).
import { benchRow, fullWalks, paceWalks, slice, walkRow } from "./repeat-helpers.ts";

describe("constants (derivations pinned — see repeatability.ts)", () => {
  it("windows reuse the product's single definition of recent", () => {
    expect(REPEAT_MIN_WALKS).toBe(3);
    expect(REPEAT_WINDOW).toBe(5); // = TREND_WINDOW = MASTERY_WINDOW
  });

  it("outlier guard: 10% (6 pts on the pace curve) with 2x dominance", () => {
    expect(REPEAT_OUTLIER_PCT).toBe(10);
    expect(REPEAT_OUTLIER_DOMINANCE).toBe(2);
  });

  it("benchmark pins: the ungated day-0 mode on the default shape", () => {
    expect(BENCHMARK_MODE_ID).toBe("beginner");
    expect(BENCHMARK_SHAPE_KIND).toBe("straight");
  });
});

describe("hand-computed CV pin (paces 0.80/0.85/0.90)", () => {
  const rep = repeatabilityReport(paceWalks([0.8, 0.85, 0.9]))!;

  it("mean 0.85, Bessel sd 0.05, cv = agreement = 5.882...%", () => {
    expect(rep).not.toBeNull();
    expect(rep.walks).toBe(3);
    expect(rep.pace!.n).toBe(3);
    expect(rep.pace!.mean).toBeCloseTo(0.85, 9);
    // sdSample = sqrt((0.0025 + 0 + 0.0025) / 2) = 0.05
    expect(rep.pace!.sdSample).toBeCloseTo(0.05, 9);
    expect(rep.pace!.cvPct).toBeCloseTo(5.882352941176471, 9);
    expect(rep.pace!.agreementPct).toBeCloseTo(5.882352941176471, 9);
    expect(rep.cadence).toBeNull();
    expect(rep.outlier).toBeNull(); // 5.88% < REPEAT_OUTLIER_PCT
  });

  it("verdict ceils 5.88 -> WITHIN 6 (a within-claim is an upper bound)", () => {
    expect(rep.verdictLine).toBe(
      "LAST 3 MATCHED WALKS AGREED WITHIN 6% ON PACE.",
    );
    expect(rep.compactLine).toBe("3 MATCHED WALKS: PACE SPREAD 6%");
    expect(rep.detailLine).toBe("PACE CV 6%");
  });

  it("echoes the matched conditions", () => {
    expect(rep.modeId).toBe("beginner");
    expect(rep.shapeKind).toBe("straight");
    expect(rep.source).toBe("head");
  });
});

describe("outlier rule (pace only)", () => {
  it("names a newest walk 15% slow vs the others (roadmap exemplar shape)", () => {
    // NOTE: the roadmap's "12% slow" exemplar sits BELOW the derived guard
    // at n=5 with tight others (4x/(5-x) = 9.84% vs the full mean < 10%),
    // so the pinned case uses 15% — the guard is vs the FULL mean.
    const rep = repeatabilityReport(
      paceWalks([0.84, 0.85, 0.85, 0.86, 0.7225]),
    )!;
    expect(rep.outlier).not.toBeNull();
    expect(rep.outlier!.index).toBe(5);
    expect(rep.outlier!.count).toBe(5);
    expect(rep.outlier!.deltaPct).toBeCloseTo(-15, 9); // vs meanOthers 0.85
    expect(rep.outlier!.othersAgreementPct).toBeCloseTo(1.1764705882352942, 9);
    expect(rep.verdictLine).toBe(
      "WALKS 1-4 AGREED WITHIN 2% ON PACE; WALK 5 WAS 15% SLOWER.",
    );
    expect(rep.compactLine).toBe(
      "5 MATCHED WALKS: PACE SPREAD 13% - WALK 5 15% SLOW",
    );
    // Diagnosis ban (honesty law): spread is described, never explained.
    expect(rep.verdictLine).not.toMatch(/fatigue/i);
    expect(rep.compactLine).not.toMatch(/fatigue/i);
  });

  it("FASTER direction + FAST compact tag for a positive delta", () => {
    const rep = repeatabilityReport(
      paceWalks([0.85, 0.85, 0.85, 0.9775]),
    )!;
    expect(rep.outlier!.deltaPct).toBeCloseTo(15, 9);
    expect(rep.verdictLine).toBe(
      "WALKS 1-3 AGREED WITHIN 1% ON PACE; WALK 4 WAS 15% FASTER.",
    );
    expect(rep.compactLine.endsWith("- WALK 4 15% FAST")).toBe(true);
  });

  it("a NON-last outlier uses the named-exception template", () => {
    const rep = repeatabilityReport(
      paceWalks([0.85, 0.7225, 0.85, 0.85]),
    )!;
    expect(rep.outlier!.index).toBe(2);
    // othersAgreementPct = 0 -> the 1% display floor.
    expect(rep.verdictLine).toBe(
      "WALK 2 WAS 15% SLOWER ON PACE THAN THE OTHER 3, WHICH AGREED WITHIN 1%.",
    );
  });

  it("dominance guard: a uniformly spread window scapegoats nobody", () => {
    // deviations {0.15, 0, 0.15}: 17.6% > 10% but m1 == m2 < 2*m2.
    const rep = repeatabilityReport(paceWalks([0.7, 0.85, 1.0]))!;
    expect(rep.outlier).toBeNull();
    expect(rep.verdictLine).toBe(
      "LAST 3 MATCHED WALKS AGREED WITHIN 18% ON PACE.",
    );
  });

  it("requires FULL pace voting so indices map 1:1 to walks", () => {
    const rep = repeatabilityReport(
      fullWalks([
        { pace: 0.85, cadence: 100 },
        { pace: null, cadence: 100 }, // pace-dark row: indices would lie
        { pace: 0.85, cadence: 100 },
        { pace: 0.85, cadence: 100 },
        { pace: 0.7225, cadence: 100 },
      ]),
    )!;
    expect(rep.walks).toBe(5);
    expect(rep.pace!.n).toBe(4);
    expect(rep.outlier).toBeNull();
    expect(rep.verdictLine).toMatch(/^LAST 5 MATCHED WALKS AGREED WITHIN /);
  });
});

describe("qualifying window (group-scoped recency)", () => {
  it("null below REPEAT_MIN_WALKS", () => {
    expect(repeatabilityReport([])).toBeNull();
    expect(repeatabilityReport(paceWalks([0.85, 0.86]))).toBeNull();
  });

  it("only the last REPEAT_WINDOW group rows vote; interleaved other-group rows neither vote nor break the window", () => {
    const paces = [1.0, 1.0, 0.8, 0.82, 0.84, 0.86, 0.88];
    const rows = [
      walkRow(0, { stats: slice({ meanPaceMps: paces[0] }) }),
      walkRow(1, { stats: slice({ meanPaceMps: paces[1] }) }),
      walkRow(2, { modeId: "challenge", stats: slice({ meanPaceMps: 2.0 }) }),
      walkRow(3, { stats: slice({ meanPaceMps: paces[2] }) }),
      walkRow(4, { stats: slice({ meanPaceMps: paces[3] }) }),
      walkRow(5, { modeId: "challenge", stats: slice({ meanPaceMps: 2.0 }) }),
      walkRow(6, { stats: slice({ meanPaceMps: paces[4] }) }),
      walkRow(7, { stats: slice({ meanPaceMps: paces[5] }) }),
      walkRow(8, { modeId: "challenge", stats: slice({ meanPaceMps: 2.0 }) }),
      walkRow(9, { stats: slice({ meanPaceMps: paces[6] }) }),
    ];
    const rep = repeatabilityReport(rows)!;
    expect(rep.walks).toBe(5);
    // last 5 group paces: 0.80/0.82/0.84/0.86/0.88 -> mean 0.84.
    expect(rep.pace!.mean).toBeCloseTo(0.84, 9);
  });

  it("input order does not matter (list() is newest-first)", () => {
    const rows = paceWalks([0.84, 0.85, 0.85, 0.86, 0.7225]);
    const reversed = [...rows].reverse();
    expect(repeatabilityReport(reversed)).toEqual(repeatabilityReport(rows));
  });

  it("a smaller window argument narrows the vote", () => {
    const rep = repeatabilityReport(
      paceWalks([0.5, 0.5, 0.84, 0.85, 0.86]),
      3,
    )!;
    expect(rep.walks).toBe(3);
    expect(rep.pace!.mean).toBeCloseTo(0.85, 9);
  });
});

describe("reference-row guards (the newest real walk anchors the group)", () => {
  it("mixed modeId: the newest row's mode owns the window", () => {
    const rows = paceWalks([0.85, 0.85, 0.85]);
    rows.push(
      walkRow(3, {
        modeId: "challenge",
        stats: slice({ meanPaceMps: 1.05 }),
      }),
    );
    expect(repeatabilityReport(rows)).toBeNull(); // challenge group has 1 row
  });

  it("mixed shapeKind never aggregates", () => {
    const rows = paceWalks([0.85, 0.85, 0.85]);
    rows.push(
      walkRow(3, { shapeKind: "U", stats: slice({ meanPaceMps: 0.85 }) }),
    );
    expect(repeatabilityReport(rows)).toBeNull();
  });

  it("mixed primarySource: a different sensor is a different ruler", () => {
    const rows = paceWalks([0.85, 0.84, 0.86, 0.85]);
    rows[1] = walkRow(1, {
      primarySource: "iphone-arkit",
      stats: slice({ meanPaceMps: 0.84 }),
    });
    const rep = repeatabilityReport(rows)!;
    expect(rep.walks).toBe(3);
    expect(rep.source).toBe("head");
  });

  it("reference row without a usable shapeKind (legacy) -> null", () => {
    const rows = paceWalks([0.85, 0.85, 0.85, 0.85]);
    rows[3] = walkRow(3, {
      shapeKind: null,
      stats: slice({ meanPaceMps: 0.85 }),
    });
    expect(repeatabilityReport(rows)).toBeNull();
  });

  it("reference row with a junk modeId -> null", () => {
    const rows = paceWalks([0.85, 0.85, 0.85, 0.85]);
    rows[3] = walkRow(3, { modeId: "", stats: slice({ meanPaceMps: 0.85 }) });
    expect(repeatabilityReport(rows)).toBeNull();
  });

  it("a synthetic newest walk neither anchors the group nor blocks the report", () => {
    const rows = paceWalks([0.8, 0.85, 0.9]);
    rows.push(
      walkRow(3, {
        synthetic: true,
        primarySource: "preview",
        stats: slice({ meanPaceMps: 2.0 }),
      }),
    );
    const rep = repeatabilityReport(rows)!;
    expect(rep.walks).toBe(3);
    expect(rep.pace!.mean).toBeCloseTo(0.85, 9);
  });

  it("unscored rows (overall null) never qualify", () => {
    const rows = paceWalks([0.85, 0.85]);
    rows.push(
      walkRow(2, { overall: null, stats: slice({ meanPaceMps: 0.85 }) }),
    );
    expect(repeatabilityReport(rows)).toBeNull();
  });
});

describe("normalization stamp (adjudication SECTION A — literal wire rows)", () => {
  it("rowNormalizationFallback: absent / null / junk -> default.v1", () => {
    expect(rowNormalizationFallback({})).toBe(DEFAULT_NORMALIZATION);
    expect(rowNormalizationFallback({ normalization: null })).toBe(
      "default.v1",
    );
    expect(rowNormalizationFallback({ normalization: "" })).toBe("default.v1");
    expect(
      rowNormalizationFallback({
        normalization: 42 as unknown as string,
      }),
    ).toBe("default.v1");
    expect(rowNormalizationFallback({ normalization: "fit.v1-123" })).toBe(
      "fit.v1-123",
    );
  });

  it("a fit.v1 row never aggregates with default-scored rows", () => {
    const rows = paceWalks([0.85, 0.84, 0.86, 0.85]);
    rows[0] = walkRow(0, {
      normalization: "fit.v1-123",
      stats: slice({ meanPaceMps: 0.85 }),
    });
    expect(repeatabilityReport(rows)!.walks).toBe(3);
  });

  it("a re-FIT starts a fresh window (newest fit row alone -> null)", () => {
    const rows = paceWalks([0.85, 0.85, 0.85, 0.85]);
    rows[3] = walkRow(3, {
      normalization: "fit.v1-123",
      stats: slice({ meanPaceMps: 0.85 }),
    });
    expect(repeatabilityReport(rows)).toBeNull();
  });

  it("legacy (absent), null, and explicit default.v1 rows deliberately merge", () => {
    const rows = [
      walkRow(0, { stats: slice({ meanPaceMps: 0.84 }) }),
      walkRow(1, {
        normalization: null,
        stats: slice({ meanPaceMps: 0.85 }),
      }),
      walkRow(2, {
        normalization: "default.v1",
        stats: slice({ meanPaceMps: 0.86 }),
      }),
    ];
    expect(repeatabilityReport(rows)!.walks).toBe(3);
  });

  it("an injected reader owns the grouping (the wiring seam)", () => {
    const rows = paceWalks([0.85, 0.84, 0.86, 0.85]);
    rows[0] = walkRow(0, {
      normalization: "fit.v1-123",
      stats: slice({ meanPaceMps: 0.85 }),
    });
    expect(repeatabilityReport(rows)!.walks).toBe(3); // default reader splits
    const merged = repeatabilityReport(rows, REPEAT_WINDOW, () => "merged")!;
    expect(merged.walks).toBe(4); // constant reader merges
  });
});

describe("music tempo stamp (multi-BPM wave — literal wire rows)", () => {
  // Hand-mirrored in RepeatabilityTests.swift (testRowMusicBpmLaw and
  // siblings): the golden family stays frozen at its 48 legacy-shaped
  // cases — every fixture row is musicBpm-ABSENT, which is exactly why the
  // vectors rebuilt byte-identical when tempo joined the group key — so
  // the split behavior lives in paired unit tests on both sides.
  it("rowMusicBpm: absent/junk -> the deleted 122 build constant; null stays null; numbers pass through", () => {
    expect(rowMusicBpm({})).toBe(LEGACY_MUSIC_BPM);
    expect(rowMusicBpm({ musicBpm: undefined })).toBe(LEGACY_MUSIC_BPM);
    expect(rowMusicBpm({ musicBpm: null })).toBe(null);
    expect(rowMusicBpm({ musicBpm: 100 })).toBe(100);
    expect(rowMusicBpm({ musicBpm: NaN })).toBe(LEGACY_MUSIC_BPM);
    expect(rowMusicBpm({ musicBpm: Infinity })).toBe(LEGACY_MUSIC_BPM);
    expect(rowMusicBpm({ musicBpm: "fast" })).toBe(LEGACY_MUSIC_BPM);
    expect(LEGACY_MUSIC_BPM).toBe(122);
  });

  it("a deliberate tempo switch splits the window — never 'cadence inconsistency'", () => {
    // The founder-call exemplar: 3 walks at 100, then 2 at 125. The newest
    // row anchors the 125 group; 2 < REPEAT_MIN_WALKS -> no verdict.
    const rows = [
      ...paceWalks([0.84, 0.85, 0.86], { musicBpm: 100 }),
      walkRow(3, { musicBpm: 125, stats: slice({ meanPaceMps: 0.99 }) }),
      walkRow(4, { musicBpm: 125, stats: slice({ meanPaceMps: 1.01 }) }),
    ];
    expect(repeatabilityReport(rows)).toBe(null);
    // A third 125 walk re-opens the verdict on the 125 series alone.
    const report = repeatabilityReport([
      ...rows,
      walkRow(5, { musicBpm: 125, stats: slice({ meanPaceMps: 1.0 }) }),
    ])!;
    expect(report.walks).toBe(3);
    expect(report.pace!.mean).toBeCloseTo(1.0, 12);
  });

  it("legacy (absent) and an explicit 122 deliberately merge; null matches only null", () => {
    // One constant delivered every legacy walk, so absent and a literal
    // 122 are ONE series …
    const legacy = [
      walkRow(0, { stats: slice({ meanPaceMps: 0.84 }) }),
      walkRow(1, { musicBpm: 122, stats: slice({ meanPaceMps: 0.85 }) }),
      walkRow(2, { stats: slice({ meanPaceMps: 0.86 }) }),
    ];
    expect(repeatabilityReport(legacy)!.walks).toBe(3);
    // … while the recorder-minted null ("the summary carried no stamp")
    // groups only with itself: the absent (=122) row never joins.
    const nulls = [
      walkRow(0, { stats: slice({ meanPaceMps: 0.84 }) }),
      ...fullWalks([{ pace: 0.85 }, { pace: 0.86 }, { pace: 0.85 }], {
        musicBpm: null,
      }).map((r, i) => ({ ...r, startedAt: 1000 + (i + 1) * 60_000 })),
    ];
    expect(repeatabilityReport(nulls)!.walks).toBe(3);
  });

  it("a tempo change starts a FRESH benchmark series — one new-tempo walk is a baseline, not a trend", () => {
    const rows = [
      benchRow(0, 70, { musicBpm: 100 }),
      benchRow(1, 75, { musicBpm: 100 }),
      benchRow(2, 80, { musicBpm: 125 }),
    ];
    expect(benchmarkRows(rows).map((r) => r.overall)).toEqual([80]);
    expect(benchmarkHeadline(rows)).toBe(null);
  });
});

describe("walk-duration stamp (the duration wave — literal wire rows)", () => {
  // Hand-mirrored in RepeatabilityTests.swift (testRowWalkSecondsLaw and
  // siblings) — the rowMusicBpm suite's twin. The golden family stays
  // frozen at its legacy-shaped cases (every fixture row is
  // walkSecondsSet-ABSENT), so the split behavior lives in paired unit
  // tests on both sides.
  it("rowWalkSeconds: absent/junk -> the legacy 20; null stays null; numbers pass through", () => {
    expect(rowWalkSeconds({})).toBe(LEGACY_WALK_SECONDS);
    expect(rowWalkSeconds({ walkSecondsSet: undefined })).toBe(
      LEGACY_WALK_SECONDS,
    );
    expect(rowWalkSeconds({ walkSecondsSet: null })).toBe(null);
    expect(rowWalkSeconds({ walkSecondsSet: 45 })).toBe(45);
    expect(rowWalkSeconds({ walkSecondsSet: NaN })).toBe(LEGACY_WALK_SECONDS);
    expect(rowWalkSeconds({ walkSecondsSet: Infinity })).toBe(
      LEGACY_WALK_SECONDS,
    );
    expect(rowWalkSeconds({ walkSecondsSet: "long" })).toBe(
      LEGACY_WALK_SECONDS,
    );
    expect(LEGACY_WALK_SECONDS).toBe(20);
  });

  it("a deliberate duration switch splits the window — never read as inconsistency", () => {
    // 3 walks at the 20 s default, then 2 at 45 s: the newest row anchors
    // the 45 s group; 2 < REPEAT_MIN_WALKS -> no verdict.
    const rows = [
      ...paceWalks([0.84, 0.85, 0.86], { walkSecondsSet: 20 }),
      walkRow(3, { walkSecondsSet: 45, stats: slice({ meanPaceMps: 0.99 }) }),
      walkRow(4, { walkSecondsSet: 45, stats: slice({ meanPaceMps: 1.01 }) }),
    ];
    expect(repeatabilityReport(rows)).toBe(null);
    // A third 45 s walk re-opens the verdict on the 45 s series alone.
    const report = repeatabilityReport([
      ...rows,
      walkRow(5, { walkSecondsSet: 45, stats: slice({ meanPaceMps: 1.0 }) }),
    ])!;
    expect(report.walks).toBe(3);
    expect(report.pace!.mean).toBeCloseTo(1.0, 12);
  });

  it("legacy (absent) and an explicit 20 deliberately merge; null matches only null", () => {
    // Post-4ac430a every walk locked 20 s, so absent and a literal 20 are
    // ONE series (the LEGACY_WALK_SECONDS read law; the pre-4ac430a caveat
    // is documented on the constant).
    const legacy = [
      walkRow(0, { stats: slice({ meanPaceMps: 0.84 }) }),
      walkRow(1, { walkSecondsSet: 20, stats: slice({ meanPaceMps: 0.85 }) }),
      walkRow(2, { stats: slice({ meanPaceMps: 0.86 }) }),
    ];
    expect(repeatabilityReport(legacy)!.walks).toBe(3);
    // The recorder-minted null groups only with itself.
    const nulls = [
      walkRow(0, { stats: slice({ meanPaceMps: 0.84 }) }),
      ...fullWalks([{ pace: 0.85 }, { pace: 0.86 }, { pace: 0.85 }], {
        walkSecondsSet: null,
      }).map((r, i) => ({ ...r, startedAt: 1000 + (i + 1) * 60_000 })),
    ];
    expect(repeatabilityReport(nulls)!.walks).toBe(3);
  });

  it("a duration change starts a FRESH benchmark series — one new-length walk is a baseline, not a trend", () => {
    const rows = [
      benchRow(0, 70, { walkSecondsSet: 20 }),
      benchRow(1, 75, { walkSecondsSet: 20 }),
      benchRow(2, 80, { walkSecondsSet: 45 }),
    ];
    expect(benchmarkRows(rows).map((r) => r.overall)).toEqual([80]);
    expect(benchmarkHeadline(rows)).toBe(null);
  });
});

describe("channel voting", () => {
  it("cadence with fewer than 3 voters goes null; pace still reports", () => {
    const rep = repeatabilityReport(
      fullWalks([
        { pace: 0.84, cadence: 100 },
        { pace: 0.85 },
        { pace: 0.85 },
        { pace: 0.85, cadence: 102 },
        { pace: 0.86 },
      ]),
    )!;
    expect(rep.cadence).toBeNull();
    expect(rep.pace!.n).toBe(5);
    expect(rep.verdictLine).toBe(
      "LAST 5 MATCHED WALKS AGREED WITHIN 2% ON PACE.",
    );
  });

  it("cadence-only history uses the cadence templates", () => {
    const rep = repeatabilityReport(
      fullWalks([{ cadence: 96 }, { cadence: 100 }, { cadence: 104 }]),
    )!;
    expect(rep.pace).toBeNull();
    expect(rep.outlier).toBeNull(); // outlier is pace-only
    expect(rep.verdictLine).toBe(
      "LAST 3 MATCHED WALKS AGREED WITHIN 4% ON CADENCE.",
    );
    expect(rep.compactLine).toBe("3 MATCHED WALKS: CADENCE SPREAD 4%");
    expect(rep.detailLine).toBe("CADENCE CV 4%");
  });

  it("BOTH relative channels dark -> no verdict at all", () => {
    expect(
      repeatabilityReport(
        fullWalks([{ lateral: 0.02 }, { lateral: 0.03 }, { lateral: 0.04 }]),
      ),
    ).toBeNull();
  });

  it("non-finite and non-positive values never vote", () => {
    const rep = repeatabilityReport(
      fullWalks([
        { pace: 0.85, cadence: Number.NaN },
        { pace: 0.85, cadence: 0 },
        { pace: 0.85, cadence: -5 },
        { pace: 0.85, cadence: 100 },
      ]),
    )!;
    expect(rep.cadence).toBeNull();
    expect(rep.pace!.n).toBe(4);
  });
});

describe("detailLine + display floors", () => {
  it("all three segments, with (HEAD PATH) labeling only the centerline", () => {
    const rep = repeatabilityReport(
      fullWalks([
        { pace: 0.8, cadence: 96, lateral: 0.02 },
        { pace: 0.85, cadence: 100, lateral: 0.024 },
        { pace: 0.9, cadence: 104, lateral: 0.028 },
      ]),
    )!;
    // cadence: mean 100, sd sqrt((16+0+16)/2) = 4 -> CV 4%;
    // lateral: mean 0.024, sd 0.004 m -> rounds to 0 cm -> UNDER 1 CM.
    expect(rep.lateralSpreadM).toBeCloseTo(0.004, 9);
    expect(rep.detailLine).toBe(
      "PACE CV 6% - CADENCE CV 4% - CENTER SD UNDER 1 CM (HEAD PATH)",
    );
    expect(rep.verdictLine).toBe(
      "LAST 3 MATCHED WALKS AGREED WITHIN 6% ON PACE AND 4% ON CADENCE.",
    );
    expect(rep.compactLine).toBe(
      "3 MATCHED WALKS: PACE SPREAD 6%, CADENCE 4%",
    );
  });

  it("lateral below 3 voters drops the segment AND the (HEAD PATH) suffix", () => {
    const rep = repeatabilityReport(
      fullWalks([
        { pace: 0.8, cadence: 96, lateral: 0.02 },
        { pace: 0.85, cadence: 100 },
        { pace: 0.9, cadence: 104, lateral: 0.028 },
      ]),
    )!;
    expect(rep.lateralSpreadM).toBeNull();
    expect(rep.detailLine).toBe("PACE CV 6% - CADENCE CV 4%");
    expect(rep.detailLine).not.toContain("HEAD PATH");
  });

  it("a centimeter-scale spread prints whole cm", () => {
    const rep = repeatabilityReport(
      fullWalks([
        { pace: 0.85, lateral: 0.01 },
        { pace: 0.85, lateral: 0.05 },
        { pace: 0.85, lateral: 0.09 },
      ]),
    )!;
    expect(rep.lateralSpreadM).toBeCloseTo(0.04, 9);
    expect(rep.detailLine).toBe(
      "PACE CV UNDER 1% - CENTER SD 4 CM (HEAD PATH)",
    );
  });

  it("identical walks floor at WITHIN 1% / CV UNDER 1% — never a 0% claim", () => {
    const rep = repeatabilityReport(paceWalks([0.85, 0.85, 0.85]))!;
    expect(rep.verdictLine).toBe(
      "LAST 3 MATCHED WALKS AGREED WITHIN 1% ON PACE.",
    );
    expect(rep.detailLine).toBe("PACE CV UNDER 1%");
  });

  it("withinPct is ceil with a floor of 1", () => {
    expect(withinPct(0)).toBe(1);
    expect(withinPct(0.2)).toBe(1);
    expect(withinPct(4.4)).toBe(5); // rounding 4.4 down would be FALSE
    expect(withinPct(6)).toBe(6);
  });
});

describe("normalization reader — ONE implementation (override (c), option B)", () => {
  it("rowNormalizationFallback IS session-grading's rowNormalization", () => {
    // The wiring phase resolved the header's diff-and-keep-one note by
    // DELEGATION: the exported alias and the §A helper are the same function
    // object, so the contract can never fork.
    expect(rowNormalizationFallback).toBe(rowNormalization);
  });
});

describe("benchmark query layer (adjudicated override: lives HERE, not progress.ts)", () => {
  it("pins the headline chain length to the product's smallest evidence chain", () => {
    expect(BENCHMARK_HEADLINE_SHOWN).toBe(3);
  });

  it("isBenchmarkRow trusts the STAMP, never the configuration", () => {
    // A beginner+straight row WITHOUT the stamp (legacy) is NOT benchmark —
    // it cannot prove the configuration held for the whole walk.
    expect(isBenchmarkRow(walkRow(0))).toBe(false);
    expect(isBenchmarkRow(benchRow(0, 80))).toBe(true);
    // A stamped row whose modeId was later edited still IS one (stamp law:
    // walk-time truth is captured, never reinterpreted at read time).
    expect(isBenchmarkRow(benchRow(0, 80, { modeId: "challenge" }))).toBe(
      true,
    );
  });

  it("benchmarkRows: the series follows the NEWEST row's (normalization, sensor) group", () => {
    const rows = [
      benchRow(0, 70),
      benchRow(1, 72, { normalization: "fit.v1-100" }), // pre-re-FIT stray
      benchRow(2, 75),
      benchRow(3, 78),
    ];
    expect(benchmarkRows(rows).map((r) => r.overall)).toEqual([70, 75, 78]);
  });

  it("a re-FIT starts a FRESH series — one post-FIT walk is a baseline, not a trend", () => {
    const rows = [
      benchRow(0, 70),
      benchRow(1, 75),
      benchRow(2, 80, { normalization: "fit.v1-200" }),
    ];
    expect(benchmarkRows(rows).map((r) => r.overall)).toEqual([80]);
    expect(benchmarkHeadline(rows)).toBeNull();
  });

  it("a sensor change starts a fresh series too (different ruler)", () => {
    const rows = [
      benchRow(0, 70),
      benchRow(1, 75),
      benchRow(2, 80, { primarySource: "iphone-arkit" }),
    ];
    expect(benchmarkRows(rows).map((r) => r.overall)).toEqual([80]);
  });

  it("SECTION A negative control over literal wire rows: absent/null/default.v1 merge; fit splits", () => {
    const rows = [
      benchRow(0, 70, { normalization: "fit.v1-123" }),
      benchRow(1, 75), // stamp ABSENT (legacy wire shape)
      benchRow(2, 80, { normalization: null }),
      benchRow(3, 85, { normalization: "default.v1" }),
    ];
    expect(benchmarkRows(rows).map((r) => r.overall)).toEqual([75, 80, 85]);
  });

  it("synthetic stamped rows and unscored rows never enter the series", () => {
    const rows = [
      benchRow(0, 70),
      benchRow(1, 95, { synthetic: true, primarySource: "preview" }),
      { ...benchRow(2, 80), overall: null },
      benchRow(3, 78),
    ];
    expect(benchmarkRows(rows).map((r) => r.overall)).toEqual([70, 78]);
  });

  it("benchmarkSeries: last <= max group overalls, chronological, SERIES_MAX default", () => {
    const rows = Array.from({ length: SERIES_MAX + 5 }, (_, i) =>
      benchRow(i, 60 + i),
    );
    const series = benchmarkSeries(rows);
    expect(series.length).toBe(SERIES_MAX);
    expect(series[0]).toBe(65);
    expect(series[series.length - 1]).toBe(60 + SERIES_MAX + 4);
    expect(benchmarkSeries(rows, 3)).toEqual([
      60 + SERIES_MAX + 2,
      60 + SERIES_MAX + 3,
      60 + SERIES_MAX + 4,
    ]);
  });

  it("headline: null below 2 group rows", () => {
    expect(benchmarkHeadline([])).toBeNull();
    expect(benchmarkHeadline([benchRow(0, 71)])).toBeNull();
    expect(benchmarkHeadline([walkRow(0), walkRow(1)])).toBeNull(); // unstamped
  });

  it("headline: shown + delta from the ROUNDED display values (self-consistent)", () => {
    const rows = [benchRow(0, 71.4), benchRow(1, 79.2), benchRow(2, 83.6)];
    const h = benchmarkHeadline(rows)!;
    expect(h.walks).toBe(3);
    expect(h.shown).toEqual([71, 79, 84]);
    expect(h.delta).toBe(13); // 84 - 71, never the raw 12.2
    expect(h.firstShownAt).toBe(1000);
    expect(h.lastAt).toBe(1000 + 2 * 60_000);
    expect(benchmarkLine(h)).toBe("BENCHMARK 71 -> 79 -> 84 (+13)");
  });

  it("headline shows only the last 3 of a longer series; firstShownAt tracks shown[0]", () => {
    const rows = [
      benchRow(0, 60),
      benchRow(1, 71),
      benchRow(2, 79),
      benchRow(3, 84),
    ];
    const h = benchmarkHeadline(rows)!;
    expect(h.walks).toBe(4);
    expect(h.shown).toEqual([71, 79, 84]);
    expect(h.firstShownAt).toBe(1000 + 60_000);
  });

  it("2-row variant + EVEN + negative-delta lines (§6 copy)", () => {
    const two = benchmarkHeadline([benchRow(0, 78), benchRow(1, 80)])!;
    expect(two.shown).toEqual([78, 80]);
    expect(benchmarkLine(two)).toBe("BENCHMARK 78 -> 80 (+2)");
    const even = benchmarkHeadline([benchRow(0, 80), benchRow(1, 80)])!;
    expect(benchmarkLine(even)).toBe("BENCHMARK 80 -> 80 (EVEN)");
    const down = benchmarkHeadline([benchRow(0, 84), benchRow(1, 80)])!;
    expect(down.delta).toBe(-4);
    expect(benchmarkLine(down)).toBe("BENCHMARK 84 -> 80 (-4)");
  });

  it("the line is ASCII and never says improvement — the tooltip is the LAW verbatim", () => {
    const h = benchmarkHeadline([benchRow(0, 71), benchRow(1, 84)])!;
    expect(benchmarkLine(h)).toMatch(/^[\x20-\x7E]+$/);
    expect(benchmarkLine(h)).not.toMatch(/improv/i);
    expect(BENCHMARK_TOOLTIP).toBe(
      "Beginner mode on the straight runway, graded against the same bar every time. Benchmark walks are the only series compared like-for-like, so only these deltas are read as improvement. The series restarts if the scoring sensor, calibration, music tempo, walk duration or scoring scale changes.",
    );
  });
});

describe("benchmark predicates", () => {
  it("walk-start: real + beginner + straight, and nothing else", () => {
    expect(benchmarkConfigAtWalkStart(false, "beginner", "straight")).toBe(
      true,
    );
    expect(benchmarkConfigAtWalkStart(true, "beginner", "straight")).toBe(
      false, // preview auto-pilot never enters the improvement series
    );
    expect(benchmarkConfigAtWalkStart(false, "challenge", "straight")).toBe(
      false,
    );
    expect(benchmarkConfigAtWalkStart(false, "beginner", "T")).toBe(false);
    expect(benchmarkConfigAtWalkStart(false, null, "straight")).toBe(false);
    expect(benchmarkConfigAtWalkStart(false, "beginner", null)).toBe(false);
  });

  it("finalize re-derivation follows the summary-locked mode (SECTION G)", () => {
    expect(benchmarkAtFinalize(true, "beginner")).toBe(true);
    // Mode switched between beginWalk meta capture and the summary stamp:
    expect(benchmarkAtFinalize(true, "challenge")).toBe(false);
    expect(benchmarkAtFinalize(false, "beginner")).toBe(false);
    expect(benchmarkAtFinalize(undefined, "beginner")).toBe(false);
    expect(benchmarkAtFinalize(true, null)).toBe(false);
  });
});

describe("panel copy laws (ASCII + banned words)", () => {
  // One report per template branch — the sweep must cover them all.
  const reports = [
    repeatabilityReport(paceWalks([0.8, 0.85, 0.9]))!, // pace-only base
    repeatabilityReport(paceWalks([0.84, 0.85, 0.85, 0.86, 0.7225]))!, // last-walk outlier
    repeatabilityReport(paceWalks([0.85, 0.7225, 0.85, 0.85]))!, // mid outlier
    repeatabilityReport(paceWalks([0.85, 0.85, 0.85, 0.9775]))!, // FASTER outlier
    repeatabilityReport(
      fullWalks([{ cadence: 96 }, { cadence: 100 }, { cadence: 104 }]),
    )!, // cadence-only
    repeatabilityReport(
      fullWalks([
        { pace: 0.8, cadence: 96, lateral: 0.02 },
        { pace: 0.85, cadence: 100, lateral: 0.024 },
        { pace: 0.9, cadence: 104, lateral: 0.028 },
      ]),
    )!, // both channels + lateral
  ];
  const lines = reports.flatMap((r) => [
    r.verdictLine,
    r.compactLine,
    r.detailLine,
  ]);
  lines.push(REPEAT_DISCLOSURE);

  it("every string is printable ASCII (XR panel law)", () => {
    for (const line of lines) {
      expect(line).toMatch(/^[\x20-\x7E]+$/);
    }
  });

  it("no diagnosis, no improvement claims — spread only", () => {
    for (const line of lines) {
      expect(line).not.toMatch(/fatigue/i);
      expect(line).not.toMatch(/improv/i);
    }
  });

  it("the disclosure names the matched conditions and disclaims cause", () => {
    expect(REPEAT_DISCLOSURE).toBe(
      "MEASURED SPREAD ACROSS REPEAT WALKS UNDER THE SAME MODE, SHAPE, SENSOR, TEMPO AND DURATION. IT SHOWS HOW MUCH YOUR WALKS DIFFER, NOT WHY.",
    );
  });
});
