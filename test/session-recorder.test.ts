import { signal } from "@preact/signals-core";
import { SCORE_SCALE_STAMP } from "../src/pose-derive.ts";
import { describe, expect, it, vi } from "vitest";

import { MODES } from "../src/modes.ts";
import { DEFAULT_LAYOUT } from "../src/runway-layout.ts";
import {
  APP_VERSION,
  EXPORT_UNITS,
  historyExport,
  historyToCsv,
  installSessionRecorder,
  SessionRecorder,
  sessionToCsv,
  walkExport,
} from "../src/session-recorder.ts";
import type { MetricSnapshot, ShowPhaseValue, ShowSummary } from "../src/show.ts";
import type { WalkStats } from "../src/walk-stats.ts";
import { makeBeat } from "./beat-helpers.ts";
import { holdStats } from "./hold-helpers.ts";
import { makeTurnStats } from "./turn-helpers.ts";

function metrics(base: number): MetricSnapshot {
  return {
    posture: base + 5,
    pace: base,
    rhythm: base + 2,
    footPlacement: base + 8,
    presence: base + 1,
    confidence: base - 1,
    presentation: base + 3,
  };
}
function summary(
  overall: number,
  delta: number | null,
  stats: WalkStats | null = null,
  normalization?: string | null,
): ShowSummary {
  const s: ShowSummary = {
    scores: metrics(overall),
    overall,
    deltaVsLast: delta,
    durationSec: 12.3,
    stats,
    oneWayRoute: false,
    // Stamp-less by default: finalize falls back to the walk-start capture.
    modeId: null,
    passThreshold: null,
  };
  // The FIT normalization stamp is ADDITIVE-OPTIONAL: only set when the
  // caller asks, so the default fixture keeps exercising the legacy shape.
  if (normalization !== undefined) {
    s.normalization = normalization;
  }
  return s;
}

function walkStats(): WalkStats {
  return {
    meanPaceMps: 0.91,
    idealPaceMps: 0.85,
    paceDeltaMps: 0.06,
    meanLateralM: -0.12,
    meanAbsLateralM: 0.18,
    postureDriftM: -0.021,
    steps: 41,
    cadenceSpm: 96.5,
    source: "head",
  };
}

function record(now: () => number) {
  const r = new SessionRecorder(now);
  r.clearHistory(); // node localStorage is absent; start from empty in-memory
  return r;
}

describe("SessionRecorder lifecycle", () => {
  it("captures samples and finalizes a walk", () => {
    let t = 1000;
    const r = record(() => t);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    for (let i = 0; i < 4; i++) {
      r.sample(metrics(70 + i), "head");
      t += 167;
    }
    r.finalize(summary(82, null));

    expect(r.count()).toBe(1);
    const s = r.latest();
    expect(s).not.toBeNull();
    expect(s!.samples.length).toBe(4);
    expect(s!.overall).toBe(82);
    expect(s!.primarySource).toBe("head");
    expect(s!.samples[0].source).toBe("head");
    expect(r.list()[0].overall).toBe(82);
  });

  it("records the passed lesson label (mode-aware), defaulting otherwise", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head", "02 EMERGING RUNWAY");
    r.finalize(summary(75, null));
    expect(r.list()[0].lesson).toBe("02 EMERGING RUNWAY");
    // no lesson arg -> the static fallback
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(75, null));
    expect(r.list()[0].lesson).toBe("01 BEGINNER WALK");
  });

  it("tags a Preview Walk auto-pilot run synthetic, on the record AND the history row", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "preview", "01 BEGINNER WALK", {
      synthetic: true,
    });
    r.finalize(summary(90, null));
    expect(r.latest()!.synthetic).toBe(true);
    expect(r.list()[0].synthetic).toBe(true);
    expect(r.list()[0].primarySource).toBe("preview");
  });

  it("defaults to a real (non-synthetic) walk when no meta is passed", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(70, null));
    expect(r.latest()!.synthetic).toBe(false);
    expect(r.list()[0].synthetic).toBe(false);
  });

  it("captures mode, pass threshold and trainee at walk start (record + row)", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head", "02 EMERGING RUNWAY", {
      modeId: "highfashion",
      passThreshold: 80,
      trainee: { name: "Ada", id: "003" },
    });
    r.finalize(summary(79, null));
    const rec = r.latest()!;
    expect(rec.modeId).toBe("highfashion");
    expect(rec.passThreshold).toBe(80);
    expect(rec.trainee).toEqual({ name: "Ada", id: "003" });
    const row = r.list()[0];
    expect(row.modeId).toBe("highfashion");
    expect(row.passThreshold).toBe(80);
    expect(row.trainee).toEqual({ name: "Ada", id: "003" });
    // no meta -> nulls, not undefined (stable JSON export shape)
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(70, null));
    expect(r.latest()!.modeId).toBeNull();
    expect(r.latest()!.passThreshold).toBeNull();
    expect(r.latest()!.trainee).toBeNull();
  });

  it("finalize prefers the LOCKED mode stamped on the summary over the walk-start capture (mode-lock)", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head", "01 BEGINNER WALK", {
      modeId: "beginner",
      passThreshold: 78,
    });
    // The picker moved during the brief window — the director's locked
    // runMode (stamped at finishWalk) is what actually scored the walk, and
    // the persisted row must grade the way the summary card did.
    r.finalize({
      ...summary(80, null),
      modeId: "highfashion",
      passThreshold: 80,
    });
    expect(r.latest()!.modeId).toBe("highfashion");
    expect(r.latest()!.passThreshold).toBe(80);
    expect(r.list()[0].modeId).toBe("highfashion");
    expect(r.list()[0].passThreshold).toBe(80);

    // A stamp-less summary (legacy caller / fixture) keeps the walk-start
    // capture — the safety fallback.
    r.beginWalk(DEFAULT_LAYOUT, "head", "01 BEGINNER WALK", {
      modeId: "beginner",
      passThreshold: 78,
    });
    r.finalize(summary(70, null));
    expect(r.latest()!.modeId).toBe("beginner");
    expect(r.latest()!.passThreshold).toBe(78);
  });

  it("persists the walk's real measurements (stats) on the record AND the row", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(80, null, walkStats()));
    expect(r.latest()!.stats).toEqual(walkStats());
    expect(r.list()[0].stats).toEqual(walkStats());
    // stats-less summary (walk never produced a sample) -> null, not undefined
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(70, null));
    expect(r.latest()!.stats).toBeNull();
    expect(r.list()[0].stats).toBeNull();
  });

  it("records the raw sample channels, rounded, and null when absent", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.sample(metrics(70), "head", 0.91234, -0.123456);
    r.sample(metrics(70), "camera"); // channels absent -> null
    r.finalize(summary(80, null));
    const s = r.latest()!;
    expect(s.samples[0].paceMps).toBe(0.91); // 2 dp
    expect(s.samples[0].lateralM).toBe(-0.123); // 3 dp, SIGN kept
    expect(s.samples[1].paceMps).toBeNull();
    expect(s.samples[1].lateralM).toBeNull();
  });

  it("discard() drops an in-progress walk", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "camera");
    r.sample(metrics(60), "camera");
    r.discard();
    r.finalize(summary(99, null)); // no current -> no-op
    expect(r.count()).toBe(0);
    expect(r.latest()).toBeNull();
  });

  it("carries deltaVsLast onto the persisted history row (#21/#25)", () => {
    let t = 0;
    const r = record(() => t);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(70, null)); // baseline walk — null delta, not 0
    t += 5000;
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(88, 18));
    const list = r.list();
    expect(list[0].deltaVsLast).toBe(18);
    expect(list[1].deltaVsLast).toBeNull();
  });

  it("records each walk most-recent-first in list()", () => {
    let t = 0;
    const r = record(() => t);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(70, null));
    t += 5000;
    r.beginWalk(DEFAULT_LAYOUT, "camera");
    r.finalize(summary(88, 18));
    const list = r.list();
    expect(list.length).toBe(2);
    expect(list[0].overall).toBe(88); // newest first
    expect(list[1].overall).toBe(70);
  });
});

describe("lastRealOverall (the deltaVsLast baseline across reloads, #21)", () => {
  it("returns the most recent real walk's overall", () => {
    let t = 0;
    const r = record(() => t);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(70, null));
    t += 5000;
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(85, 15));
    expect(r.lastRealOverall()).toBe(85);
  });

  it("skips synthetic Preview Walk rows — auto-pilot never seeds a baseline", () => {
    let t = 0;
    const r = record(() => t);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(72, null));
    t += 5000;
    r.beginWalk(DEFAULT_LAYOUT, "preview", "01 BEGINNER WALK", {
      synthetic: true,
    });
    r.finalize(summary(94, null));
    expect(r.lastRealOverall()).toBe(72);
  });

  it("skips score-less rows; null when nothing real is scored", () => {
    const r = record(() => 0);
    expect(r.lastRealOverall()).toBeNull();
    r.beginWalk(DEFAULT_LAYOUT, "preview", "01 BEGINNER WALK", {
      synthetic: true,
    });
    r.finalize(summary(90, null));
    expect(r.lastRealOverall()).toBeNull();
  });

  it("clearHistory erases the baseline source — the next walk is a fresh baseline (night-review #9)", () => {
    let t = 0;
    const r = record(() => t);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(85, null));
    expect(r.lastRealOverall()).toBe(85);
    r.clearHistory();
    // ShowDirector re-seeds its deltaVsLast baseline from HERE at every walk
    // start, so the erased 85 can never grade the next student's first walk
    // ("+N VS LAST WALK" vs a ghost) or leak through the persisted/exported
    // deltaVsLast (erased overall = newOverall - delta).
    expect(r.lastRealOverall()).toBeNull();
    expect(r.count()).toBe(0);
    // The next real walk seeds a fresh record, not a resurrected one.
    t += 5000;
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(70, null));
    expect(r.lastRealOverall()).toBe(70);
  });

  it("scopes the baseline to the CURRENT trainee on a shared device (pinned rule)", () => {
    let t = 0;
    const r = record(() => t);
    r.beginWalk(DEFAULT_LAYOUT, "head"); // unattributed (legacy-style) row
    r.finalize(summary(60, null));
    t += 5000;
    r.beginWalk(DEFAULT_LAYOUT, "head", "01 BEGINNER WALK", {
      trainee: { name: "Ada", id: "A" },
    });
    r.finalize(summary(70, null));
    t += 5000;
    r.beginWalk(DEFAULT_LAYOUT, "head", "01 BEGINNER WALK", {
      trainee: { name: "Ben", id: "B" },
    });
    r.finalize(summary(90, null));

    // Falsy current id -> no filtering (single-user device).
    expect(r.lastRealOverall()).toBe(90);
    expect(r.lastRealOverall(null)).toBe(90);
    // Per-trainee: Ada's baseline is HER newest walk, never Ben's 90.
    expect(r.lastRealOverall("A")).toBe(70);
    expect(r.lastRealOverall("B")).toBe(90);
    // A trainee with no attributed rows still inherits unattributed/legacy
    // rows (they always match) rather than starting from nothing.
    expect(r.lastRealOverall("C")).toBe(60);
  });
});

describe("loadHistory corruption tolerance (the single ingestion point)", () => {
  // Stamped current-scale: this suite tests CORRUPTION tolerance; the
  // ruler law (an unstamped legacy row never seeds the baseline) has its
  // own explicit cases in the lastRealOverall suite.
  const GOOD_ROW = {
    id: "S-1",
    startedAt: 1000,
    lesson: "01 BEGINNER WALK",
    primarySource: "head",
    durationSec: 10,
    overall: 80,
    finalScores: null,
    scoreScale: SCORE_SCALE_STAMP,
  };

  function withStorage<T>(payload: string, fn: () => T): T {
    const store: Record<string, string> = { "xrunway.sessions.v1": payload };
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
    try {
      return fn();
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("filters non-object elements (null/number/string/array) so no consumer can throw", () => {
    withStorage(
      JSON.stringify([null, 5, "junk", [1, 2], GOOD_ROW]),
      () => {
        // Pre-fix this construction path fed `null` rows into isSyntheticRow
        // (TypeError) — at BOOT, since ShowDirector.init seeds from
        // lastRealOverall (#21). The sane row must survive the filter.
        const r = new SessionRecorder(() => 0);
        expect(r.count()).toBe(1);
        expect(r.list().map((x) => x.id)).toEqual(["S-1"]);
        expect(r.lastRealOverall()).toBe(80); // walks the (cleaned) history
      },
    );
  });

  it("a poisoned newest element never reaches lastRealOverall", () => {
    withStorage(JSON.stringify([GOOD_ROW, null]), () => {
      const r = new SessionRecorder(() => 0);
      expect(r.lastRealOverall()).toBe(80);
    });
  });

  it("non-array payloads load as empty history", () => {
    withStorage(JSON.stringify({ not: "an array" }), () => {
      expect(new SessionRecorder(() => 0).count()).toBe(0);
    });
  });
});

describe("CSV builders", () => {
  it("sessionToCsv: stable '#' metadata block, then header, then samples (#25)", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head", "02 EMERGING RUNWAY", {
      modeId: "highfashion",
      passThreshold: 80,
      trainee: { name: "Ada", id: "003" },
    });
    r.sample(metrics(70), "head", 0.88, -0.12);
    r.sample(metrics(80), "camera"); // raw channels absent -> empty cells
    r.finalize(summary(80, null));
    const csv = sessionToCsv(r.latest()!);
    const lines = csv.split("\n");
    // The metadata block is a parser contract: these 16 keys, in this order
    // (normalization joined after appVersion in the FIT wave; shape after
    // mode + benchmark after synthetic in the M12 wave — §F build order).
    expect(lines.slice(0, 16)).toEqual([
      "# schema: xrunway.walk.v2",
      "# id: S-0",
      "# startedAt: 1970-01-01T00:00:00.000Z",
      "# lesson: 02 EMERGING RUNWAY",
      "# mode: highfashion",
      "# shape: ", // no shapeKind meta passed (legacy caller) -> empty
      "# passThreshold: 80",
      "# trainee: Ada (003)",
      "# source: head",
      "# synthetic: false",
      "# benchmark: false",
      "# durationSec: 12.3",
      "# sampleRateHz: 6",
      `# appVersion: ${APP_VERSION}`,
      "# normalization: default.v1",
      "# units: scores 0-100; t_sec seconds; pace_mps meters/second; lateral_m meters signed (+ = trainee's right outbound); head_pitch_deg/head_yaw_deg degrees signed (pitch + = above neutral; yaw + = trainee's right; empty when unmeasured)",
    ]);
    expect(lines[16]).toBe(
      "t_sec,pace,posture,rhythm,footPlacement,presence,confidence,presentation,pace_mps,lateral_m,source,head_pitch_deg,head_yaw_deg",
    );
    expect(lines.length).toBe(19); // 16 metadata + header + 2 samples
    // NEGATIVE lateral_m exports as a plain number, NOT a `'-`-guarded text
    // cell — numbers bypass the formula-injection prefix. The M8 carriage
    // cells (appended after source, §F) are empty here — no tracker fed them.
    expect(lines[17].endsWith(",0.88,-0.12,head,,")).toBe(true);
    expect(lines[18].endsWith(",,,camera,,")).toBe(true);
  });

  it("sessionToCsv: a synthetic Preview Walk file carries its own marker (#3)", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "preview", "01 BEGINNER WALK", {
      synthetic: true,
      trainee: { name: "Ada", id: "003" }, // beginWalk stamps the real user
    });
    r.sample(metrics(90), "head"); // auto-pilot samples log "head"
    r.finalize(summary(94, null));
    const csv = sessionToCsv(r.latest()!);
    const lines = csv.split("\n");
    // The downloaded/renamed file itself must say the auto-pilot drove the
    // rig — the per-sample source column can't ("head"), the metadata must.
    expect(lines[8]).toBe("# source: preview");
    expect(lines[9]).toBe("# synthetic: true");
    // ...and a synthetic run is never a benchmark walk (belt + braces).
    expect(lines[10]).toBe("# benchmark: false");
    expect(/preview/i.test(csv)).toBe(true);
  });

  it("sessionToCsv: absent walk context leaves stable, empty metadata values", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head"); // no meta at all (legacy caller)
    r.finalize(summary(80, null));
    const lines = sessionToCsv(r.latest()!).split("\n");
    expect(lines[4]).toBe("# mode: ");
    expect(lines[5]).toBe("# shape: ");
    expect(lines[6]).toBe("# passThreshold: ");
    expect(lines[7]).toBe("# trainee: ");
    expect(lines[8]).toBe("# source: head");
    expect(lines[9]).toBe("# synthetic: false");
    expect(lines[10]).toBe("# benchmark: false");
  });

  it("sessionToCsv: a hostile trainee name cannot fabricate rows or split a metadata line", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head", "01 BEGINNER WALK", {
      trainee: { name: "Eve\r\n99,99,99,99,99,99,99,99,99,99,99", id: "666" },
    });
    r.sample(metrics(70), "head");
    r.finalize(summary(80, null));
    const lines = sessionToCsv(r.latest()!).split("\n");
    expect(lines.length).toBe(18); // 16 metadata + header + 1 sample — no injected row
    // Commas are neutralized ALONGSIDE CR/LF: spreadsheets split '#' lines on
    // commas too, so a comma-carrying name must not fabricate CELLS either.
    expect(lines[7]).toBe("# trainee: Eve 99 99 99 99 99 99 99 99 99 99 99 (666)");
  });

  it("sessionToCsv: a comma-smuggled formula in the trainee name never becomes a live cell", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head", "01 BEGINNER WALK", {
      trainee: { name: 'Eve,=HYPERLINK("http://evil","open")', id: "666" },
    });
    r.finalize(summary(80, null));
    const lines = sessionToCsv(r.latest()!).split("\n");
    // No comma survives, so a spreadsheet import sees ONE cell (starting with
    // '#', never '='): the formula is neutralized, not just displaced.
    expect(lines[7]).toBe(
      '# trainee: Eve =HYPERLINK("http://evil" "open") (666)',
    );
    expect(lines[7].includes(",")).toBe(false);
    for (const cell of lines[7].split(",")) {
      expect(cell.startsWith("=")).toBe(false);
    }
  });

  it("sessionToCsv: a leading formula trigger in a metadata value gets the csvCell text prefix", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head", "01 BEGINNER WALK", {
      trainee: { name: "=SUM(A1)", id: "007" },
    });
    r.finalize(summary(80, null));
    const lines = sessionToCsv(r.latest()!).split("\n");
    expect(lines[7]).toBe("# trainee: '=SUM(A1) (007)");
  });

  it("historyToCsv: the simplified 11 columns (date/time/lesson/runway/duration/overall + PACE/CARRIAGE/LINE), csv-safe", () => {
    const csv = historyToCsv([
      {
        id: "S-1",
        startedAt: 0,
        lesson: "01 BEGINNER, WALK", // comma in a text field -> must be quoted
        modeId: "beginner",
        primarySource: "head",
        durationSec: 20,
        walkSecondsSet: 45, // the CONFIGURED length (duration_s) - not durationSec
        overall: 84,
        finalScores: metrics(80), // pace + footPlacement (LINE) come from here
        carriage: {
          pitchInBandFrac: 0.9,
          yawInBandFrac: 0.8,
          meanPitchDevDeg: 3,
          glanceCount: 1,
          firstGlanceAtSec: 5,
          neutralPitchDeg: 0,
          neutralSource: "stand",
          measuredSec: 18,
          carriageScore: 92, // the 3rd shipped metric, replacing rhythm
        },
        shapeKind: "straight",
        runwayLength: 7.0,
        runwayWidth: 1.4,
      },
      {
        // A legacy row: no carriage / dims / scores -> those cells stay empty.
        id: "S-2",
        startedAt: 1000,
        lesson: "01 BEGINNER WALK",
        primarySource: "camera",
        durationSec: 0,
        overall: null,
        finalScores: null,
      },
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "date,time,lesson,runway_length_m,runway_width_m,runway_shape,duration_s,overall,pace,carriage,line",
    );
    // the comma in the lesson is QUOTED (not stripped) so the column count holds
    expect(lines[1]).toContain('"01 BEGINNER, WALK"');
    const cells = splitCsvLine(lines[1]);
    expect(cells.length).toBe(11);
    expect(cells[0]).toBe("1970-01-01"); // date (UTC part of startedAt)
    expect(cells[1]).toBe("00:00"); // time (UTC HH:MM)
    expect(cells[2]).toBe("01 BEGINNER, WALK"); // comma survived intact
    expect(cells[3]).toBe("7"); // runway_length_m (7.0 -> 7)
    expect(cells[4]).toBe("1.4"); // runway_width_m
    expect(cells[5]).toBe("straight"); // runway_shape
    expect(cells[6]).toBe("45"); // duration_s (the CONFIGURED walkSecondsSet)
    expect(cells[7]).toBe("84"); // overall
    expect(cells[8]).toBe("80"); // pace
    expect(cells[9]).toBe("92"); // carriage score
    expect(cells[10]).toBe("88"); // line (footPlacement = base+8)
    // legacy row: dims / duration / overall / carriage / scores all empty
    const legacy = splitCsvLine(lines[2]);
    expect(legacy.length).toBe(11);
    expect(legacy[0]).toBe("1970-01-01");
    expect(legacy[2]).toBe("01 BEGINNER WALK");
    expect(legacy[3]).toBe(""); // no runway dims stamped
    expect(legacy[6]).toBe(""); // pre-wave row: no configured duration - NEVER a guessed 20
    expect(legacy[7]).toBe(""); // null overall
    expect(legacy[8]).toBe(""); // no finalScores
    expect(legacy[9]).toBe(""); // no carriage
  });
});

describe("normalization stamp flow (FIT wave: summary -> record -> row -> CSV)", () => {
  it("finalize copies the summary stamp onto the record AND the history row", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(80, null, null, "fit.v1-123"));
    expect(r.latest()!.normalization).toBe("fit.v1-123");
    expect(r.list()[0].normalization).toBe("fit.v1-123");
  });

  it("a stamp-less summary keeps the walk-start null -> reads default.v1 downstream", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(80, null)); // legacy fixture: no normalization field
    expect(r.latest()!.normalization).toBeNull();
    expect(r.list()[0].normalization).toBeNull();
    // The row reader's law: null/absent = the factory constants scored it.
    const lines = sessionToCsv(r.latest()!).split("\n");
    expect(lines[14]).toBe("# normalization: default.v1");
  });

  it("an explicit null stamp (metrics-less world) also persists as null", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(80, null, null, null));
    expect(r.latest()!.normalization).toBeNull();
  });

  it("sessionToCsv meta carries the stamp after appVersion (relative order)", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(80, null, null, "fit.v1-9"));
    const lines = sessionToCsv(r.latest()!).split("\n");
    const appIdx = lines.findIndex((l) => l.startsWith("# appVersion:"));
    expect(lines[appIdx + 1]).toBe("# normalization: fit.v1-9");
    expect(lines[appIdx + 2].startsWith("# units:")).toBe(true);
  });

  it("lastRealOverall without a stamp arg behaves exactly as today (additive-API negative control)", () => {
    let t = 0;
    const r = record(() => t);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(70, null)); // legacy (null stamp)
    t += 5000;
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(90, null, null, "fit.v1-123"));
    expect(r.lastRealOverall()).toBe(90);
    expect(r.lastRealOverall(null)).toBe(90);
    expect(r.lastRealOverall(null, null)).toBe(90); // null stamp filters nothing
  });

  it("the musicBpm stamp rides the same flow: summary -> record -> row", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    const s = summary(80, null);
    s.musicBpm = 125;
    r.finalize(s);
    expect(r.latest()!.musicBpm).toBe(125);
    expect(r.list()[0].musicBpm).toBe(125);
    // A stamp-less summary (legacy fixture / metrics-less world) reads null.
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(80, null));
    expect(r.latest()!.musicBpm).toBeNull();
    expect(r.list()[0].musicBpm).toBeNull();
  });

  it("lastRealOverall with a stamp scopes the baseline to that series (both directions)", () => {
    let t = 0;
    const r = record(() => t);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(70, null)); // legacy row -> default.v1
    t += 5000;
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(90, null, null, "fit.v1-123"));
    // Post-FIT reseed skips the default row; pre-FIT reseed skips the fit row.
    expect(r.lastRealOverall(null, "fit.v1-123")).toBe(90);
    expect(r.lastRealOverall(null, "default.v1")).toBe(70);
    // A re-fit mints a NEW stamp -> a new series -> fresh baseline (null).
    expect(r.lastRealOverall(null, "fit.v1-456")).toBeNull();
  });
});

describe("M10 hold stamp flow (summary -> record -> row; additive-optional)", () => {
  it("finalize copies the summary's hold onto the record AND the history row", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    const h = holdStats({ stillnessRmsCm: 2.4, markErrCm: 12 });
    r.finalize({ ...summary(80, null), hold: h, holdNullReason: null });
    expect(r.latest()!.hold).toEqual(h);
    expect(r.list()[0].hold).toEqual(h);
  });

  it("a NULL hold (window never measured) persists as null, not absent", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize({ ...summary(80, null), hold: null, holdNullReason: "no-data" });
    expect(r.latest()!.hold).toBeNull();
    expect(r.list()[0].hold).toBeNull();
  });

  it("a stamp-less summary (legacy fixture / no director) yields null", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(80, null)); // no hold field at all
    expect(r.latest()!.hold).toBeNull();
    expect(r.list()[0].hold).toBeNull();
  });

  it("legacy persisted rows (no hold key) still load and grade (additive-optional schema)", () => {
    // The loadHistory row predicate tolerates extra/missing optional fields —
    // asserted with the same GOOD_ROW shape the corruption suite uses.
    const store: Record<string, string> = {
      "xrunway.sessions.v1": JSON.stringify([
        {
          id: "S-1",
          startedAt: 1000,
          lesson: "01 BEGINNER WALK",
          primarySource: "head",
          durationSec: 10,
          overall: 80,
          finalScores: null,
        },
      ]),
    };
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
    try {
      const r = new SessionRecorder(() => 2000);
      expect(r.count()).toBe(1);
      expect(r.list()[0].hold).toBeUndefined(); // absent, tolerated
      // Loads + grades, but an unstamped row is an OLD-RULER row: it must
      // never seed a NEW-scale deltaVsLast baseline (the perfect=100 law).
      expect(r.lastRealOverall()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("negative control: a synthetic Preview row WITH hold data never seeds the baseline", () => {
    let t = 0;
    const r = record(() => t);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize({ ...summary(72, null), hold: holdStats(), holdNullReason: null });
    t += 5000;
    r.beginWalk(DEFAULT_LAYOUT, "preview", "01 BEGINNER WALK", {
      synthetic: true,
    });
    r.finalize({ ...summary(94, null), hold: holdStats(), holdNullReason: null });
    // The synthetic row carries hold data like any stats — and is still
    // excluded from every training claim (realScoredRows law, unchanged).
    expect(r.list()[0].hold).not.toBeNull();
    expect(r.lastRealOverall()).toBe(72);
  });
});

describe("M12 shape + benchmark stamps (walk start -> record -> row -> reload)", () => {
  it("beginWalk meta stamps round-trip onto the record AND the history row", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head", "01 BEGINNER WALK", {
      modeId: "beginner",
      passThreshold: 78,
      shapeKind: "straight",
      benchmark: true,
    });
    r.finalize(summary(80, null));
    expect(r.latest()!.shapeKind).toBe("straight");
    expect(r.latest()!.benchmark).toBe(true);
    expect(r.list()[0].shapeKind).toBe("straight");
    expect(r.list()[0].benchmark).toBe(true);
    // no meta -> null shape / false benchmark (the ?? null / === true law),
    // never undefined (stable JSON export shape).
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(70, null));
    expect(r.latest()!.shapeKind).toBeNull();
    expect(r.latest()!.benchmark).toBe(false);
  });

  it("stamps survive the localStorage round-trip (reload)", () => {
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
    try {
      const r = new SessionRecorder(() => 0);
      r.clearHistory();
      r.beginWalk(DEFAULT_LAYOUT, "head", "01 BEGINNER WALK", {
        modeId: "beginner",
        passThreshold: 78,
        shapeKind: "straight",
        benchmark: true,
      });
      r.finalize(summary(80, null));
      // A fresh recorder (the reload) reads the stamps back off the row.
      const reloaded = new SessionRecorder(() => 1000);
      expect(reloaded.list()[0].shapeKind).toBe("straight");
      expect(reloaded.list()[0].benchmark).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("§G: finalize re-derives benchmark from the summary-LOCKED mode (both directions)", () => {
    const r = record(() => 0);
    // Mode switched between the beginWalk meta capture and the summary
    // stamp: the stale walk-start true must be REVOKED — the row grades as
    // challenge, so it can never sit in the beginner improvement series.
    r.beginWalk(DEFAULT_LAYOUT, "head", "01 BEGINNER WALK", {
      modeId: "beginner",
      passThreshold: 78,
      shapeKind: "straight",
      benchmark: true,
    });
    r.finalize({ ...summary(80, null), modeId: "challenge", passThreshold: 82 });
    expect(r.list()[0].modeId).toBe("challenge");
    expect(r.list()[0].benchmark).toBe(false);

    // The reverse can never MINT a stamp: a walk that STARTED off-benchmark
    // stays false even when the summary locks the benchmark mode (the shape
    // half of the config was only verified at walk start).
    r.beginWalk(DEFAULT_LAYOUT, "head", "04 CHALLENGE", {
      modeId: "challenge",
      passThreshold: 82,
      shapeKind: "straight",
      benchmark: false,
    });
    r.finalize({ ...summary(80, null), modeId: "beginner", passThreshold: 78 });
    expect(r.list()[0].modeId).toBe("beginner");
    expect(r.list()[0].benchmark).toBe(false);

    // A stamp-less summary (legacy fixture) keeps the walk-start capture:
    // still beginner at finalize -> the stamp survives re-derivation.
    r.beginWalk(DEFAULT_LAYOUT, "head", "01 BEGINNER WALK", {
      modeId: "beginner",
      passThreshold: 78,
      shapeKind: "straight",
      benchmark: true,
    });
    r.finalize(summary(80, null));
    expect(r.list()[0].benchmark).toBe(true);
  });

  it("invalidateShape voids BOTH stamps; idempotent; no-op outside a walk", () => {
    const r = record(() => 0);
    r.invalidateShape(); // no walk in progress -> no throw, no state
    r.beginWalk(DEFAULT_LAYOUT, "head", "01 BEGINNER WALK", {
      modeId: "beginner",
      passThreshold: 78,
      shapeKind: "straight",
      benchmark: true,
    });
    r.invalidateShape();
    r.invalidateShape(); // idempotent
    r.finalize(summary(80, null));
    expect(r.list()[0].shapeKind).toBeNull();
    expect(r.list()[0].benchmark).toBe(false);
  });

  it("EXPORT_UNITS documents the two new fields", () => {
    expect(EXPORT_UNITS.shapeKind).toContain("straight/T/X/U");
    expect(EXPORT_UNITS.shapeKind).toContain("changed mid-walk");
    expect(EXPORT_UNITS.benchmark).toContain(
      "beginner mode on the straight shape",
    );
  });
});

describe("M12 CSV columns (§F: relative positions only, never 'last')", () => {
  it("per-walk meta: '# shape:' follows mode, '# benchmark:' follows synthetic", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head", "01 BEGINNER WALK", {
      modeId: "beginner",
      passThreshold: 78,
      shapeKind: "U",
      benchmark: false,
    });
    r.finalize(summary(80, null));
    const lines = sessionToCsv(r.latest()!).split("\n");
    const modeIdx = lines.findIndex((l) => l.startsWith("# mode:"));
    expect(lines[modeIdx]).toBe("# mode: beginner");
    expect(lines[modeIdx + 1]).toBe("# shape: U");
    const synIdx = lines.findIndex((l) => l.startsWith("# synthetic:"));
    expect(lines[synIdx + 1]).toBe("# benchmark: false");
  });

  it("a benchmark walk's file says so in its metadata", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head", "01 BEGINNER WALK", {
      modeId: "beginner",
      passThreshold: 78,
      shapeKind: "straight",
      benchmark: true,
    });
    r.finalize(summary(80, null));
    const lines = sessionToCsv(r.latest()!).split("\n");
    expect(lines).toContain("# benchmark: true");
    expect(lines).toContain("# shape: straight");
  });
});

describe("M9 beat stamp (summary -> record -> row) + CSV columns (§F)", () => {
  it("finalize copies the summary beat onto the record AND the history row", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    const s = summary(80, null);
    s.beat = makeBeat({ vectorR: 0.755, reference: "music+haptic" });
    s.beatNullReason = null;
    r.finalize(s);
    expect(r.latest()!.beat).toEqual(s.beat);
    expect(r.list()[0].beat).toEqual(s.beat);
  });

  it("a stamp-less summary (legacy fixture) keeps the walk-start null; a null stamp persists null", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(80, null)); // no beat field at all
    expect(r.latest()!.beat).toBeNull();
    expect(r.list()[0].beat).toBeNull();
    r.beginWalk(DEFAULT_LAYOUT, "head");
    const s = summary(80, null);
    s.beat = null; // measured nothing (the reason enum stays summary-side)
    s.beatNullReason = "no-reference";
    r.finalize(s);
    expect(r.latest()!.beat).toBeNull();
    expect(r.list()[0].beat).toBeNull();
  });

  it("EXPORT_UNITS documents every beat.* field on the row", () => {
    expect(EXPORT_UNITS["beat.strikes"]).toContain("reference-gated");
    expect(EXPORT_UNITS["beat.vectorR / beat.vectorRRaw"]).toContain(
      "Rayleigh-bias-corrected",
    );
    expect(EXPORT_UNITS["beat.meanPhaseBeats"]).toContain(
      "never read as absolute timing",
    );
    expect(EXPORT_UNITS["beat.rayleighNR2"]).toContain("Rayleigh");
    // Tempo-relative since the multi-BPM wave: the grid derives from the
    // row's own musicBpm stamp, never a hardcoded engine tempo.
    expect(EXPORT_UNITS["beat.subdivision / beat.gridSpm"]).toContain(
      "derived from the walk's musicBpm",
    );
    expect(EXPORT_UNITS.musicBpm).toContain("beats per minute");
    expect(EXPORT_UNITS["beat.cadenceSpm"]).toContain("steps per minute");
    expect(EXPORT_UNITS["beat.driftSpm"]).toContain("constant-lag-immune");
    expect(EXPORT_UNITS["beat.refSec"]).toContain("truncated");
    expect(EXPORT_UNITS["beat.reference"]).toContain("hand-tracking fallback");
    expect(EXPORT_UNITS["beat.strikeSource"]).toContain(
      "never mixed across paths",
    );
    expect(EXPORT_UNITS["beat.beatScore"]).toContain(
      "not folded into any composite",
    );
  });
});

describe("M11 turn stamp (summary -> record -> row) + CSV columns (§F)", () => {
  it("finalize copies the summary turn onto the record AND the history row", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    const s = summary(80, null);
    s.turn = makeTurnStats();
    s.turnNullReason = null;
    r.finalize(s);
    expect(r.latest()!.turn).toEqual(s.turn);
    expect(r.list()[0].turn).toEqual(s.turn);
  });

  it("a stamp-less summary (legacy fixture) keeps the walk-start null; a null stamp persists null", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(80, null)); // no turn field at all
    expect(r.latest()!.turn).toBeNull();
    expect(r.list()[0].turn).toBeNull();
    r.beginWalk(DEFAULT_LAYOUT, "head");
    const s = summary(80, null);
    s.turn = null; // no turn measured (the reason enum stays summary-side)
    s.turnNullReason = "one-way-route";
    r.finalize(s);
    expect(r.latest()!.turn).toBeNull();
    expect(r.list()[0].turn).toBeNull();
  });

  it("EXPORT_UNITS documents every turn.* field on the row", () => {
    expect(EXPORT_UNITS["turn.startAtSec"]).toContain("head path");
    expect(EXPORT_UNITS["turn.durationSec"]).toContain("head path");
    expect(EXPORT_UNITS["turn.durBandLoSec / turn.durBandHiSec"]).toContain(
      "mode-scaled",
    );
    expect(EXPORT_UNITS["turn.entryClipped"]).toContain("hold window");
    expect(EXPORT_UNITS["turn.sweepDeg"]).toContain("unwrapped");
    expect(EXPORT_UNITS["turn.reversalCount"]).toContain("5 deg");
    expect(EXPORT_UNITS["turn.sweepMonotoneFrac"]).toContain(
      "time-independent",
    );
    expect(EXPORT_UNITS["turn.dipCm"]).toContain("walk baseline");
    expect(EXPORT_UNITS["turn.dipFrac"]).toContain("turn.heightSource");
    expect(EXPORT_UNITS["turn.heightM"]).toContain("standing head height");
    expect(EXPORT_UNITS["turn.heightSource"]).toContain("FIT baseline");
    expect(EXPORT_UNITS["turn.pitchInBandFrac"]).toContain(
      "head orientation, not gaze",
    );
    expect(EXPORT_UNITS["turn.measuredSec"]).toContain("accepted");
    expect(EXPORT_UNITS["turn.reacquireSec"]).toContain("never re-centered");
    expect(EXPORT_UNITS["turn.reacquireCapped"]).toContain(
      "never re-acquired",
    );
  });
});

describe("installSessionRecorder M12 wiring (walk-start stamp + shape guard)", () => {
  /** Minimal signal-backed globals for the install path (node-safe: the
   * recorder's storage + window touches are already guarded). */
  function makeWorld(over: Record<string, unknown> = {}) {
    const phase = signal<ShowPhaseValue>("idle");
    const summarySig = signal<ShowSummary | null>(null);
    const shape = signal<{ kind: string }>({ kind: "straight" });
    const globals: Record<string, unknown> = {
      showPhase: phase,
      metrics: signal<MetricSnapshot | null>(null),
      summary: summarySig,
      runwayLayout: signal(DEFAULT_LAYOUT),
      runwayShape: shape,
      activeMode: signal(MODES.find((m) => m.id === "beginner")!),
      userPrefs: signal({ name: "Ada", id: "003" }),
      demoActive: false,
      cleanupFuncs: [] as Array<() => void>,
      ...over,
    };
    const recorder = installSessionRecorder(globals);
    recorder.clearHistory();
    return { globals, phase, summarySig, shape, recorder };
  }

  it("stamps benchmark=true for a real beginner walk on the straight shape", () => {
    const w = makeWorld();
    w.phase.value = "walk";
    w.summarySig.value = summary(80, null);
    const row = w.recorder.list()[0];
    expect(row.shapeKind).toBe("straight");
    expect(row.benchmark).toBe(true);
    expect(row.modeId).toBe("beginner");
  });

  it("off-configuration walks stamp benchmark=false (mode OR shape)", () => {
    const challenge = makeWorld({
      activeMode: signal(MODES.find((m) => m.id === "challenge")!),
    });
    challenge.phase.value = "walk";
    challenge.summarySig.value = summary(80, null);
    expect(challenge.recorder.list()[0].benchmark).toBe(false);
    expect(challenge.recorder.list()[0].shapeKind).toBe("straight");

    const tShape = makeWorld();
    tShape.shape.value = { kind: "T" };
    tShape.phase.value = "walk";
    tShape.summarySig.value = summary(80, null);
    expect(tShape.recorder.list()[0].benchmark).toBe(false);
    expect(tShape.recorder.list()[0].shapeKind).toBe("T");
  });

  it("a Preview Walk in the benchmark configuration stamps FALSE, shape still stamped", () => {
    const w = makeWorld({ demoActive: true });
    w.phase.value = "walk";
    w.summarySig.value = summary(90, null);
    const row = w.recorder.list()[0];
    expect(row.synthetic).toBe(true);
    expect(row.benchmark).toBe(false); // belt + braces over realScoredRows
    expect(row.shapeKind).toBe("straight");
  });

  it("an unwired shape signal stamps null shape / false benchmark", () => {
    const w = makeWorld({ runwayShape: undefined });
    w.phase.value = "walk";
    w.summarySig.value = summary(80, null);
    expect(w.recorder.list()[0].shapeKind).toBeNull();
    expect(w.recorder.list()[0].benchmark).toBe(false);
  });

  it("a mid-walk shape-KIND change voids both stamps; a same-kind remap keeps them", () => {
    // KIND change: straight -> U mid-walk.
    const changed = makeWorld();
    changed.phase.value = "walk";
    changed.shape.value = { kind: "U" };
    changed.summarySig.value = summary(80, null);
    expect(changed.recorder.list()[0].shapeKind).toBeNull();
    expect(changed.recorder.list()[0].benchmark).toBe(false);

    // Same-kind remap (fit-to-room publishes a NEW object, same kind).
    const remapped = makeWorld();
    remapped.phase.value = "walk";
    remapped.shape.value = { kind: "straight" };
    remapped.summarySig.value = summary(80, null);
    expect(remapped.recorder.list()[0].shapeKind).toBe("straight");
    expect(remapped.recorder.list()[0].benchmark).toBe(true);
  });

  it("a kind change OUTSIDE a walk never voids the next walk's stamps", () => {
    const w = makeWorld();
    w.shape.value = { kind: "U" }; // idle-time edit
    w.shape.value = { kind: "straight" };
    w.phase.value = "walk";
    w.summarySig.value = summary(80, null);
    expect(w.recorder.list()[0].shapeKind).toBe("straight");
    expect(w.recorder.list()[0].benchmark).toBe(true);
  });

  it("a change-then-revert mid-walk stays voided (the walk straddled shapes)", () => {
    const w = makeWorld();
    w.phase.value = "walk";
    w.shape.value = { kind: "U" };
    w.shape.value = { kind: "straight" }; // back to the walk-start kind
    w.summarySig.value = summary(80, null);
    expect(w.recorder.list()[0].shapeKind).toBeNull();
    expect(w.recorder.list()[0].benchmark).toBe(false);
  });

  it("subscription-order pin: a LATER summary subscriber reads the finalized row", () => {
    // index.ts installs the recorder BEFORE any system registers, so HUD/
    // landing (later subscribers) see the walk's row the moment the summary
    // publishes. This pins that order at the signal level: if the recorder
    // ever subscribes late, this stand-in renderer sees a stale history.
    const w = makeWorld();
    let benchmarkSeen: boolean | undefined | "unread" = "unread";
    const dispose = w.summarySig.subscribe((s) => {
      if (!s) return;
      benchmarkSeen = w.recorder.list()[0]?.benchmark;
    });
    w.phase.value = "walk";
    w.summarySig.value = summary(80, null);
    expect(benchmarkSeen).toBe(true);
    dispose();
  });
});

describe("export envelope (#25)", () => {
  it("walkExport: self-describing envelope around the record", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "camera");
    r.sample(metrics(70), "camera");
    r.finalize(summary(80, null, walkStats()));
    const env = walkExport(r.latest()!, "2026-07-01T12:00:00.000Z");
    expect(env.schema).toBe("xrunway.walk.v2");
    expect(env.appVersion).toBe(APP_VERSION);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/); // real package.json version
    expect(env.exportedAt).toBe("2026-07-01T12:00:00.000Z");
    expect(env.sampleRateHz).toBe(6);
    // units cover the raw sample channels AND the stats block
    expect(env.units["samples[].paceMps"]).toContain("meters per second");
    expect(env.units["samples[].lateralM"]).toContain("signed");
    expect(env.units["stats.cadenceSpm"]).toContain("steps per minute");
    expect(env.units.deltaVsLast).toContain("previous real walk");
    expect(env.device.source).toBe("camera");
    expect("userAgent" in env.device).toBe(true);
    expect(env.record).toBe(r.latest());
    // survives the JSON round-trip that actually lands in the file
    const parsed = JSON.parse(JSON.stringify(env)) as typeof env;
    expect(parsed.record.id).toBe("S-0");
    expect(parsed.record.stats!.cadenceSpm).toBe(96.5);
  });

  it("historyExport: schema + detail flag; source lives per record", () => {
    let t = 0;
    const r = record(() => t);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(70, null));
    t += 5000;
    r.beginWalk(DEFAULT_LAYOUT, "camera");
    r.finalize(summary(80, 10));
    const rows = r.list();
    const env = historyExport(rows, "summary", "2026-07-01T12:00:00.000Z");
    expect(env.schema).toBe("xrunway.history.v2");
    expect(env.appVersion).toBe(APP_VERSION);
    expect(env.detail).toBe("summary");
    expect(env.sampleRateHz).toBe(6);
    expect(env.records).toBe(rows);
    expect(env.device.source).toBeUndefined(); // per record: primarySource
    expect("userAgent" in env.device).toBe(true);
  });

  it("hasFullRecord: true only while the walk's samples are in memory (#41)", () => {
    const r = record(() => 0);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.sample(metrics(70), "head");
    r.finalize(summary(80, null));
    expect(r.hasFullRecord("S-0")).toBe(true);
    // a persisted-history id from before this page-load is NOT in memory
    expect(r.hasFullRecord("S-99999")).toBe(false);
  });

  it("clearHistory erases the summary rows AND the in-memory full records (#26)", () => {
    let t = 0;
    const r = record(() => t);
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.sample(metrics(70), "head");
    r.finalize(summary(80, null));
    t += 5000;
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(85, 5));
    expect(r.count()).toBe(2);
    expect(r.hasFullRecord("S-0")).toBe(true);

    r.clearHistory();

    // Nothing left to list, grade, or export — a post-clear export must never
    // resurrect an "erased" walk (the JSON export prefers in-memory records).
    expect(r.count()).toBe(0);
    expect(r.list()).toEqual([]);
    expect(r.hasFullRecord("S-0")).toBe(false);
    expect(r.latest()).toBeNull();
    expect(r.lastRealOverall()).toBeNull();

    // A walk recorded AFTER the clear starts a fresh, working history.
    t += 5000;
    r.beginWalk(DEFAULT_LAYOUT, "head");
    r.finalize(summary(72, null));
    expect(r.count()).toBe(1);
  });
});

/** Minimal RFC-4180 line parser (quote-aware) for asserting column integrity. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
