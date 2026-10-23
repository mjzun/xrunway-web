import { describe, expect, it } from "vitest";

import {
  filterHistoryRows,
  isSyntheticRow,
  LEGACY_PASS_THRESHOLD,
  recentActivityTitle,
  rowMatchesTrainee,
  rowNormalization,
  rowPassed,
  rowPassThreshold,
  scopeRowsToNormalization,
  SINCE_FIT_TITLE_SUFFIX,
} from "../src/session-grading.ts";

describe("isSyntheticRow", () => {
  it("only an explicit true counts as synthetic", () => {
    expect(isSyntheticRow({ synthetic: true })).toBe(true);
    expect(isSyntheticRow({ synthetic: false })).toBe(false);
  });

  it("legacy persisted rows (no field) are real walks", () => {
    expect(isSyntheticRow({})).toBe(false);
  });
});

describe("rowMatchesTrainee (trainee scoping for baseline + trends — pinned rule)", () => {
  it("a falsy CURRENT trainee id filters nothing", () => {
    expect(rowMatchesTrainee({ trainee: { id: "A" } }, null)).toBe(true);
    expect(rowMatchesTrainee({ trainee: { id: "A" } }, undefined)).toBe(true);
    expect(rowMatchesTrainee({ trainee: { id: "A" } }, "")).toBe(true);
  });

  it("otherwise matches on the row's trainee id", () => {
    expect(rowMatchesTrainee({ trainee: { id: "A" } }, "A")).toBe(true);
    expect(rowMatchesTrainee({ trainee: { id: "B" } }, "A")).toBe(false);
  });

  it("unattributed rows always match (legacy single-user history)", () => {
    expect(rowMatchesTrainee({}, "A")).toBe(true);
    expect(rowMatchesTrainee({ trainee: null }, "A")).toBe(true);
  });

  it("junk attribution is tolerated as unattributed — never thrown on, never dropped", () => {
    expect(rowMatchesTrainee({ trainee: {} }, "A")).toBe(true);
    expect(
      rowMatchesTrainee({ trainee: { id: 7 as unknown as string } }, "A"),
    ).toBe(true);
    expect(
      rowMatchesTrainee({ trainee: "bob" as unknown as null }, "A"),
    ).toBe(true);
  });
});

describe("rowPassThreshold", () => {
  it("uses the row's own stored threshold", () => {
    expect(rowPassThreshold({ overall: 80, passThreshold: 82 })).toBe(82);
    expect(rowPassThreshold({ overall: 80, passThreshold: 78 })).toBe(78);
  });

  it("falls back to the legacy 75 for rows that predate the field", () => {
    expect(LEGACY_PASS_THRESHOLD).toBe(75);
    expect(rowPassThreshold({ overall: 80 })).toBe(75);
    expect(rowPassThreshold({ overall: 80, passThreshold: null })).toBe(75);
    expect(rowPassThreshold({ overall: 80, passThreshold: Number.NaN })).toBe(
      75,
    );
  });
});

describe("rowPassed", () => {
  it("grades each row against ITS OWN threshold — the Beginner-76 case", () => {
    // 76 was a green PASS under the old hardcoded 75 while the summary card
    // said NEEDS WORK (Beginner bar = 78). Both surfaces now agree.
    expect(rowPassed({ overall: 76, passThreshold: 78 })).toBe(false);
    expect(rowPassed({ overall: 78, passThreshold: 78 })).toBe(true);
    expect(rowPassed({ overall: 81, passThreshold: 82 })).toBe(false);
  });

  it("grades legacy rows against the historical fixed line", () => {
    expect(rowPassed({ overall: 75 })).toBe(true);
    expect(rowPassed({ overall: 74 })).toBe(false);
  });

  it("a row with no recorded overall never passes", () => {
    expect(rowPassed({ overall: null })).toBe(false);
    expect(rowPassed({ overall: null, passThreshold: 78 })).toBe(false);
  });
});

describe("filterHistoryRows", () => {
  const rows = [
    { id: "real-pass", overall: 80 },
    { id: "real-low", overall: 60 },
    { id: "real-null", overall: null },
    { id: "preview-pass", overall: 92, synthetic: true },
    { id: "preview-low", overall: 40, synthetic: true },
    // Per-row thresholds: a Beginner 76 is below ITS bar (78) even though it
    // clears the legacy 75; a Commercial 76 clears its bar (75).
    { id: "beginner-76", overall: 76, passThreshold: 78 },
    { id: "commercial-76", overall: 76, passThreshold: 75 },
  ];
  const ids = (f: "all" | "pass" | "low"): string[] =>
    filterHistoryRows(rows, f).map((r) => r.id);

  it("ALL keeps everything, synthetic included (badged in the UI)", () => {
    expect(ids("all")).toEqual([
      "real-pass",
      "real-low",
      "real-null",
      "preview-pass",
      "preview-low",
      "beginner-76",
      "commercial-76",
    ]);
  });

  it("PASSED excludes synthetic rows and grades per-row thresholds", () => {
    expect(ids("pass")).toEqual(["real-pass", "commercial-76"]);
  });

  it("NEEDS WORK excludes synthetic rows too; null overall counts as below the line", () => {
    expect(ids("low")).toEqual(["real-low", "real-null", "beginner-76"]);
  });

  it("does not mutate the input", () => {
    const before = rows.length;
    filterHistoryRows(rows, "pass");
    expect(rows.length).toBe(before);
  });
});

describe("rowNormalization (the ONE stamp reader — adjudication §A)", () => {
  it("reads a stamped row's token verbatim (literal wire-format rows)", () => {
    expect(rowNormalization({ normalization: "fit.v1-123" })).toBe(
      "fit.v1-123",
    );
    expect(rowNormalization({ normalization: "default.v1" })).toBe(
      "default.v1",
    );
  });

  it("absent / null / empty / non-string all read as default.v1 — legacy rows were scored with exactly the factory constants", () => {
    expect(rowNormalization({})).toBe("default.v1");
    expect(rowNormalization({ normalization: null })).toBe("default.v1");
    expect(rowNormalization({ normalization: undefined })).toBe("default.v1");
    expect(rowNormalization({ normalization: "" })).toBe("default.v1");
    expect(rowNormalization({ normalization: 42 })).toBe("default.v1");
    expect(rowNormalization({ normalization: { junk: true } })).toBe(
      "default.v1",
    );
  });
});

describe("scopeRowsToNormalization (series scoping — adversary A's rule)", () => {
  const legacy = { id: "legacy" }; // absent field -> default.v1
  const def = { id: "def", normalization: "default.v1" as string | null };
  const fit1 = { id: "fit1", normalization: "fit.v1-100" };
  const fit2 = { id: "fit2", normalization: "fit.v1-200" };

  it("legacy and explicit default rows are deliberately ONE series", () => {
    const s = scopeRowsToNormalization([legacy, def, fit1], "default.v1");
    expect(s.rows.map((r) => r.id)).toEqual(["legacy", "def"]);
    expect(s.excluded).toBe(true);
  });

  it("a fit stamp scopes to exactly its capture — a re-fit is a NEW series", () => {
    const s = scopeRowsToNormalization([legacy, fit1, fit2], "fit.v1-200");
    expect(s.rows.map((r) => r.id)).toEqual(["fit2"]);
    expect(s.excluded).toBe(true);
  });

  it("excluded is false when nothing was dropped (the pre-FIT status quo)", () => {
    const s = scopeRowsToNormalization([legacy, def], "default.v1");
    expect(s.rows).toHaveLength(2);
    expect(s.excluded).toBe(false);
  });

  it("an empty history scopes to an empty, un-excluded series", () => {
    const s = scopeRowsToNormalization([], "fit.v1-100");
    expect(s.rows).toEqual([]);
    expect(s.excluded).toBe(false);
  });

  it("does not mutate the input", () => {
    const rows = [legacy, fit1];
    scopeRowsToNormalization(rows, "default.v1");
    expect(rows).toHaveLength(2);
  });
});

describe("SINCE FIT title suffix (adjudication §E: composable PARTS only)", () => {
  it("is exactly the suffix — the title base belongs to another owner", () => {
    expect(SINCE_FIT_TITLE_SUFFIX).toBe(" (SINCE FIT)");
  });
});

describe("recentActivityTitle (adjudication §E: M12's BASE — parts, never the merge)", () => {
  it("demotes the strip to RECENT ACTIVITY and interpolates the walk count", () => {
    expect(recentActivityTitle(5)).toBe("RECENT ACTIVITY — LAST 5 WALKS");
    expect(recentActivityTitle(12)).toBe("RECENT ACTIVITY — LAST 12 WALKS");
  });

  it("never says TRENDS or improvement — the mixed strip reports activity only", () => {
    expect(recentActivityTitle(5)).not.toMatch(/TRENDS/);
    expect(recentActivityTitle(5)).not.toMatch(/improv/i);
  });

  it("composes cleanly with the FIT suffix (base brings no trailing space; the suffix brings its own)", () => {
    expect(recentActivityTitle(5).endsWith(" ")).toBe(false);
    expect(SINCE_FIT_TITLE_SUFFIX.startsWith(" ")).toBe(true);
  });
});
