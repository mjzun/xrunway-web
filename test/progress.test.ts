import { describe, expect, it } from "vitest";

import {
  latestIsPersonalBest,
  LEGACY_MODE_BUCKET,
  MASTERY_PASS_COUNT,
  MASTERY_WINDOW,
  masteryJustEarned,
  medalRank,
  metricTrends,
  modeStats,
  overallSeries,
  personalBest,
  PROGRESS_METRIC_KEYS,
  progressReport,
  realScoredRows,
  rollingAverage,
  SERIES_MAX,
  trendDelta,
} from "../src/progress.ts";
// row()/scored()/modeRow() are SHARED with the golden-vector generator
// (test/case-helpers.ts) so the vectors and this suite are provably the same
// truth (SOLO-MODE §6.1).
import { modeRow, row, scored } from "./case-helpers.ts";

describe("realScoredRows (the qualifying set)", () => {
  it("excludes synthetic rows, null and non-finite overalls", () => {
    const rows = [
      row(0, 70),
      row(1, 90, { synthetic: true }), // Preview Walk — out
      row(2, null), // never scored — out
      row(3, Number.NaN as unknown as number), // junk — out
      row(4, 80),
    ];
    expect(realScoredRows(rows).map((r) => r.overall)).toEqual([70, 80]);
  });

  it("sorts chronologically regardless of input order (list() is newest-first)", () => {
    const rows = [row(2, 80), row(0, 70), row(1, 75)];
    expect(realScoredRows(rows).map((r) => r.overall)).toEqual([70, 75, 80]);
  });

  it("legacy rows without the synthetic flag are real walks", () => {
    expect(realScoredRows([{ startedAt: 1, overall: 66 }]).length).toBe(1);
  });

  it("junk startedAt sorts as 0 instead of throwing", () => {
    const rows = [
      row(1, 80),
      { startedAt: "bad" as unknown as number, overall: 70 },
    ];
    expect(realScoredRows(rows).map((r) => r.overall)).toEqual([70, 80]);
  });
});

describe("personalBest", () => {
  it("finds the max overall across real walks", () => {
    const best = personalBest([row(0, 70), row(1, 84), row(2, 79)]);
    expect(best).toEqual({ overall: 84, startedAt: 1000 + 60_000 });
  });

  it("a tie keeps the EARLIEST walk — matching a record is not a new one", () => {
    const best = personalBest([row(0, 84), row(1, 84)]);
    expect(best!.startedAt).toBe(1000);
  });

  it("ignores synthetic rows even when they score highest", () => {
    const best = personalBest([row(0, 70), row(1, 99, { synthetic: true })]);
    expect(best).toEqual({ overall: 70, startedAt: 1000 });
  });

  it("null on an empty / all-synthetic history", () => {
    expect(personalBest([])).toBeNull();
    expect(personalBest([row(0, 90, { synthetic: true })])).toBeNull();
  });
});

// The RANKING medal (founder ruling 2026-07-10): the medal is the walk's
// POSITION among the trainee's own walks. medalRank = 1-based position of
// `overall` among current-scale real rows (this walk already IN rows in
// production), best = 1, ties share a rank. scoreMedal(rank) maps 1/2/3 ->
// gold/silver/bronze (tested in hud-copy.test.ts).
describe("medalRank (the ranking-medal position)", () => {
  const hist = [row(0, 70), row(1, 84), row(2, 79)];

  it("the best score in the history ranks 1st (one score is always 1st)", () => {
    expect(medalRank(84, hist)).toBe(1);
    expect(medalRank(86, [row(0, 86)])).toBe(1); // the founder's one-walk case
  });

  it("ranks by strictly-better count: 2nd and 3rd place", () => {
    expect(medalRank(79, hist)).toBe(2); // only 84 beats it
    expect(medalRank(70, hist)).toBe(3); // 84 and 79 beat it
  });

  it("ties share a rank (a matching score is not beaten)", () => {
    expect(medalRank(84, [row(0, 84), row(1, 84)])).toBe(1);
  });

  it("excludes synthetic (Preview Walk) rows from the ranking pool", () => {
    expect(medalRank(70, [row(0, 70), row(1, 99, { synthetic: true })])).toBe(1);
  });

  it("excludes old-ruler rows (raw overalls only compare on one scale)", () => {
    expect(
      medalRank(70, [row(0, 70), row(1, 99, { scoreScale: "s98.v1" })]),
    ).toBe(1);
  });

  it("null on a non-finite overall", () => {
    expect(medalRank(Number.NaN, hist)).toBeNull();
    expect(medalRank(Number.POSITIVE_INFINITY, hist)).toBeNull();
  });
});

describe("rollingAverage", () => {
  it("averages the last 5 of a longer series", () => {
    expect(rollingAverage([1, 1, 1, 70, 72, 74, 76, 78])).toBe(74);
  });

  it("fewer than 5 values: averages what exists", () => {
    expect(rollingAverage([70, 80])).toBe(75);
    expect(rollingAverage([81])).toBe(81);
  });

  it("null on empty", () => {
    expect(rollingAverage([])).toBeNull();
  });
});

describe("trendDelta (the documented window rule)", () => {
  it("null with fewer than 2 values", () => {
    expect(trendDelta([])).toBeNull();
    expect(trendDelta([80])).toBeNull();
  });

  it("2 values: last vs first (w=1)", () => {
    expect(trendDelta([70, 76])).toBe(6);
    expect(trendDelta([76, 70])).toBe(-6);
  });

  it("3 values: w=1 — the last vs the one before it (the oldest is ignored)", () => {
    expect(trendDelta([99, 70, 74])).toBe(4);
  });

  it("4 values: last 2 vs previous 2", () => {
    expect(trendDelta([70, 72, 78, 80])).toBe(8); // (78+80)/2 - (70+72)/2
  });

  it("10 values: last 5 vs previous 5", () => {
    const values = [70, 70, 70, 70, 70, 75, 75, 75, 75, 75];
    expect(trendDelta(values)).toBe(5);
  });

  it("11+ values: only the last 2w walks vote — older history is ignored", () => {
    const values = [0, 70, 70, 70, 70, 70, 75, 75, 75, 75, 75];
    expect(trendDelta(values)).toBe(5); // the leading 0 changes nothing
  });
});

describe("overallSeries", () => {
  it("chronological overalls, synthetic excluded", () => {
    const rows = [row(2, 80), row(0, 70), row(1, 99, { synthetic: true })];
    expect(overallSeries(rows)).toEqual([70, 80]);
  });

  it("caps at SERIES_MAX, keeping the newest", () => {
    const rows = Array.from({ length: SERIES_MAX + 4 }, (_, i) => row(i, i));
    const series = overallSeries(rows);
    expect(series.length).toBe(SERIES_MAX);
    expect(series[0]).toBe(4); // the 4 oldest fell off
    expect(series[series.length - 1]).toBe(SERIES_MAX + 3);
  });
});

describe("metricTrends", () => {
  it("computes per-metric deltas from finalScores", () => {
    const trends = metricTrends([scored(0, 70), scored(1, 76)]);
    for (const k of PROGRESS_METRIC_KEYS) expect(trends[k]).toBe(6);
  });

  it("rows without finalScores don't vote — they can't zero a trend", () => {
    const trends = metricTrends([
      scored(0, 70),
      row(1, 74), // scored overall but no per-metric breakdown (legacy)
      scored(2, 76),
    ]);
    for (const k of PROGRESS_METRIC_KEYS) expect(trends[k]).toBe(6);
  });

  it("null per metric when fewer than 2 recorded walks carry it", () => {
    const trends = metricTrends([scored(0, 70)]);
    for (const k of PROGRESS_METRIC_KEYS) expect(trends[k]).toBeNull();
  });

  it("synthetic rows never contaminate a metric trend", () => {
    const trends = metricTrends([
      scored(0, 70),
      { ...scored(1, 100), synthetic: true },
      scored(2, 72),
    ]);
    for (const k of PROGRESS_METRIC_KEYS) expect(trends[k]).toBe(2);
  });
});

describe("latestIsPersonalBest", () => {
  it("true when the latest real walk strictly beats every earlier one", () => {
    expect(latestIsPersonalBest([row(0, 70), row(1, 78), row(2, 84)])).toBe(
      true,
    );
  });

  it("false on a tie — matching the record is not a new best", () => {
    expect(latestIsPersonalBest([row(0, 84), row(1, 84)])).toBe(false);
  });

  it("false on the very first real walk — a baseline, not a best", () => {
    expect(latestIsPersonalBest([row(0, 84)])).toBe(false);
  });

  it("false when a newer synthetic row exists — a Preview Walk after the record must not re-announce it", () => {
    expect(
      latestIsPersonalBest([
        row(0, 70),
        row(1, 84),
        row(2, 90, { synthetic: true }),
      ]),
    ).toBe(false);
  });

  it("input order doesn't matter (newest-first list() works)", () => {
    expect(latestIsPersonalBest([row(2, 84), row(1, 78), row(0, 70)])).toBe(
      true,
    );
  });
});

describe("modeStats (#38 per-mode records)", () => {
  it("groups real walks by mode: walk count, best, last, passed count", () => {
    const rows = [
      modeRow(0, "beginner", 70),
      modeRow(1, "challenge", 84, 82),
      modeRow(2, "beginner", 81),
      modeRow(3, "beginner", 76),
    ];
    const stats = modeStats(rows);
    const beginner = stats.find((s) => s.modeId === "beginner")!;
    expect(beginner.walks).toBe(3);
    expect(beginner.best).toBe(81);
    expect(beginner.last).toBe(76); // chronological, not best
    expect(beginner.passed).toBe(1); // only the 81 cleared the 78 bar
    const challenge = stats.find((s) => s.modeId === "challenge")!;
    expect(challenge).toMatchObject({ walks: 1, best: 84, last: 84, passed: 1 });
  });

  it("judges each walk against ITS OWN stored bar, fallback 75 when absent", () => {
    const stats = modeStats([
      modeRow(0, "challenge", 79, 82), // 79 fails the challenge 82 bar
      modeRow(1, "commercial", 76, 75), // 76 passes the commercial 75 bar
      modeRow(2, "commercial", 76, null), // no stored bar: legacy 75 -> pass
    ]);
    expect(stats.find((s) => s.modeId === "challenge")!.passed).toBe(0);
    expect(stats.find((s) => s.modeId === "commercial")!.passed).toBe(2);
  });

  it("rows without a modeId group under the legacy bucket", () => {
    const stats = modeStats([
      row(0, 80), // pre-mode row: no modeId, no threshold (graded at 75)
      modeRow(1, null, 80, null),
      modeRow(2, "", 60, null), // junk empty id -> legacy too
    ]);
    expect(stats.length).toBe(1);
    expect(stats[0]).toMatchObject({
      modeId: LEGACY_MODE_BUCKET,
      walks: 3,
      best: 80,
      last: 60,
      passed: 2,
    });
  });

  it("the legacy bucket is never mastered, even with 5 straight passes", () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(i, 90));
    expect(modeStats(rows)[0].mastered).toBe(false);
  });

  it("excludes synthetic and unscored rows like every other progress rule", () => {
    const stats = modeStats([
      modeRow(0, "beginner", 90, 78, { synthetic: true }),
      modeRow(1, "beginner", null),
      modeRow(2, "beginner", 80),
    ]);
    expect(stats[0]).toMatchObject({ walks: 1, best: 80, passed: 1 });
  });

  it("input order doesn't matter: last is the newest walk (list() is newest-first)", () => {
    const stats = modeStats([
      modeRow(2, "beginner", 66),
      modeRow(0, "beginner", 88),
      modeRow(1, "beginner", 77),
    ]);
    expect(stats[0].last).toBe(66);
    expect(stats[0].best).toBe(88);
  });

  it("mastered: at least 3 passing among the last 5 walks of that mode", () => {
    // Last 5 of: F F P P F P P -> P P F P P = 4 passing -> mastered.
    const rows = [60, 60, 80, 80, 60, 80, 80].map((v, i) =>
      modeRow(i, "beginner", v),
    );
    expect(modeStats(rows)[0].mastered).toBe(true);
    expect(modeStats(rows)[0].passed).toBe(4);
  });

  it("mastered boundary: exactly 3 of the last 5 earns it; 2 does not", () => {
    const three = [60, 80, 80, 60, 80].map((v, i) => modeRow(i, "beginner", v));
    expect(modeStats(three)[0].mastered).toBe(true);
    const two = [80, 80, 60, 60, 60].map((v, i) => modeRow(i, "beginner", v));
    expect(modeStats(two)[0].mastered).toBe(false);
  });

  it("recency is the point: 3 early passes buried under 5 recent fails is not mastery", () => {
    const rows = [80, 80, 80, 60, 60, 60, 60, 60].map((v, i) =>
      modeRow(i, "beginner", v),
    );
    const s = modeStats(rows)[0];
    expect(s.passed).toBe(3); // all-time count still says 3
    expect(s.mastered).toBe(false); // but none are in the last 5
  });

  it("a short history can master: 3 walks, all passing", () => {
    const rows = [80, 82, 84].map((v, i) => modeRow(i, "beginner", v));
    expect(modeStats(rows)[0].mastered).toBe(true);
  });

  it("2 passing walks can never master, whatever the window", () => {
    const rows = [90, 90].map((v, i) => modeRow(i, "beginner", v));
    expect(modeStats(rows)[0].mastered).toBe(false);
  });

  it("mastery respects each walk's own bar: three 79s never master challenge", () => {
    const rows = [79, 79, 79].map((v, i) => modeRow(i, "challenge", v, 82));
    expect(modeStats(rows)[0].mastered).toBe(false);
  });

  it("other modes' walks don't count toward a mode's window", () => {
    // beginner: P P (2 passes) + a challenge pass interleaved — beginner
    // stays unmastered; the challenge walk masters nothing either.
    const rows = [
      modeRow(0, "beginner", 80),
      modeRow(1, "challenge", 90, 82),
      modeRow(2, "beginner", 80),
    ];
    const stats = modeStats(rows);
    expect(stats.find((s) => s.modeId === "beginner")!.mastered).toBe(false);
    expect(stats.find((s) => s.modeId === "challenge")!.mastered).toBe(false);
  });

  it("empty / all-synthetic history: no buckets", () => {
    expect(modeStats([])).toEqual([]);
    expect(modeStats([modeRow(0, "beginner", 90, 78, { synthetic: true })]))
      .toEqual([]);
  });

  it("the pinned constants are the shipped rule", () => {
    expect(MASTERY_PASS_COUNT).toBe(3);
    expect(MASTERY_WINDOW).toBe(5);
  });
});

describe("masteryJustEarned (#38 the MODE MASTERED moment)", () => {
  it("true on the walk that takes the mode from 2 to 3 passes in the window", () => {
    const rows = [80, 60, 80, 80].map((v, i) => modeRow(i, "beginner", v));
    expect(masteryJustEarned(rows, "beginner")).toBe(true);
  });

  it("idempotent: an already-mastered mode never re-announces", () => {
    // Mastered at walk 3 (P P P); walk 4 keeps it mastered (last 5 has 3 P).
    const rows = [80, 80, 80, 60].map((v, i) => modeRow(i, "beginner", v));
    expect(masteryJustEarned(rows, "beginner")).toBe(false);
  });

  it("false while the mode is not mastered at all", () => {
    const rows = [80, 80, 60].map((v, i) => modeRow(i, "beginner", v));
    expect(masteryJustEarned(rows, "beginner")).toBe(false);
  });

  it("false when a newer row of ANY kind follows the mode's latest walk", () => {
    const earned = [80, 60, 80, 80].map((v, i) => modeRow(i, "beginner", v));
    // A Preview Walk after the moment must never resurface it.
    const withPreview = [
      ...earned,
      modeRow(4, "beginner", 95, 78, { synthetic: true }),
    ];
    expect(masteryJustEarned(withPreview, "beginner")).toBe(false);
    // ...nor a real walk in another mode.
    const withOtherMode = [...earned, modeRow(4, "challenge", 90, 82)];
    expect(masteryJustEarned(withOtherMode, "challenge")).toBe(false);
    expect(masteryJustEarned(withOtherMode, "beginner")).toBe(false);
  });

  it("mastery lost then re-earned announces again on the re-earning walk", () => {
    // P P P (mastered) F F F (lost: last 5 = P P F F F) P P (still 2 in
    // window) P -> last 5 = F F P P P: re-earned by the final walk.
    const rows = [80, 80, 80, 60, 60, 60, 80, 80, 80].map((v, i) =>
      modeRow(i, "beginner", v),
    );
    expect(masteryJustEarned(rows, "beginner")).toBe(true);
    // One walk earlier it was still unearned.
    expect(masteryJustEarned(rows.slice(0, -1), "beginner")).toBe(false);
  });

  it("never for the legacy bucket, an absent mode, or an unknown id", () => {
    const legacyRows = [80, 80, 80].map((v, i) => row(i, v));
    expect(masteryJustEarned(legacyRows, LEGACY_MODE_BUCKET)).toBe(false);
    expect(masteryJustEarned(legacyRows, null)).toBe(false);
    expect(masteryJustEarned(legacyRows, undefined)).toBe(false);
    expect(masteryJustEarned(legacyRows, "beginner")).toBe(false);
  });

  it("each pass judged against its own bar: an 81 cannot earn challenge mastery", () => {
    const rows = [84, 84, 81].map((v, i) => modeRow(i, "challenge", v, 82));
    expect(masteryJustEarned(rows, "challenge")).toBe(false);
    const cleared = [84, 84, 83].map((v, i) => modeRow(i, "challenge", v, 82));
    expect(masteryJustEarned(cleared, "challenge")).toBe(true);
  });
});

describe("progressReport", () => {
  it("assembles walks / series / best / rolling / trends / newBest in one pass", () => {
    const rows = [
      scored(0, 70),
      { ...scored(1, 100), synthetic: true }, // excluded everywhere
      scored(2, 74),
      scored(3, 78),
      scored(4, 86),
    ];
    const report = progressReport(rows);
    expect(report.walks).toBe(4);
    expect(report.series).toEqual([70, 74, 78, 86]);
    expect(report.best).toEqual({ overall: 86, startedAt: 1000 + 4 * 60_000 });
    expect(report.rollingAvg).toBe((70 + 74 + 78 + 86) / 4);
    expect(report.overallTrend).toBe((78 + 86) / 2 - (70 + 74) / 2);
    expect(report.metricTrends.posture).toBe(10);
    expect(report.newBest).toBe(true);
  });

  it("empty history: zeroed report, nothing to show", () => {
    const report = progressReport([]);
    expect(report.walks).toBe(0);
    expect(report.series).toEqual([]);
    expect(report.best).toBeNull();
    expect(report.rollingAvg).toBeNull();
    expect(report.overallTrend).toBeNull();
    expect(report.newBest).toBe(false);
  });
});

describe("the ruler law (perfect=100 rescale): records restart on the new scale", () => {
  it("old-ruler rows never compete for personal best", () => {
    const rows = [
      row(0, 97, { scoreScale: undefined }), // legacy: absent -> "s98.v1"
      row(1, 82),
      row(2, 88),
    ];
    // The legacy 97 is a different ruler's number — 88 is the PB.
    expect(personalBest(rows)!.overall).toBe(88);
  });

  it("a pure-legacy history has no current-ruler PB (the chip simply hides)", () => {
    const rows = [row(0, 90, { scoreScale: undefined }), row(1, 95, { scoreScale: undefined })];
    expect(personalBest(rows)).toBeNull();
  });

  it("latestIsPersonalBest is a current-ruler fact — a legacy 99 cannot deny it", () => {
    const rows = [
      row(0, 99, { scoreScale: undefined }),
      row(1, 80),
      row(2, 86),
    ];
    expect(latestIsPersonalBest(rows)).toBe(true);
  });

  it("per-mode best competes on the current ruler; a scale-less mode falls back to its newest overall", () => {
    const rows = [
      modeRow(0, "beginner", 97, 78, { scoreScale: undefined }), // old ruler
      modeRow(1, "beginner", 84, 78),
      modeRow(2, "highfashion", 91, 80, { scoreScale: undefined }),
      modeRow(3, "highfashion", 76, 80, { scoreScale: undefined }),
    ];
    const stats = modeStats(rows);
    const beginner = stats.find((m) => m.modeId === "beginner")!;
    const hf = stats.find((m) => m.modeId === "highfashion")!;
    expect(beginner.best).toBe(84); // the legacy 97 does not own the record
    expect(hf.best).toBe(76); // no current-scale walk: newest overall shown
    // Pass-based facts stay UNscoped: every row still counts.
    expect(beginner.walks).toBe(2);
    expect(hf.passed).toBe(1); // the 91 vs bar 80 still counts as a pass
  });
});
