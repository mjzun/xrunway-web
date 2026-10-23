/**
 * (X)RUNWAY — golden-vector REPLAY net: every behavioral family's checked-in
 * inputs re-executed through the REAL modules on every vitest run, with the
 * checked-in expectations asserted under the shared §6.5 comparison rule.
 *
 * This is the staleness net the drift lock was missing: before it, a
 * scoring change with its unit test updated left all tests green while
 * test/golden/*.json silently pinned the OLD behavior — which the Swift
 * port would then faithfully diverge onto. The runners come from
 * test/golden-replay.ts, the SAME code the generator emits with.
 *
 * Families covered here: walk-stats, coach, coach-live, progress,
 * pose-derive-world, solo-derive, gap-tape, walk-replay, walk-replay-solo.
 * The table families (modes, coach-tables, copy-variants) are replayed
 * against their live exports by the tripwires in golden-freshness.test.ts.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildCoachReport, type CoachContext } from "../src/coach.ts";
import {
  GOLDEN_MODULES,
  decodeNums,
  goldenDiff,
  type GoldenFile,
} from "./golden-format.ts";
import {
  deriveExpect,
  gatesFor,
  runBeatQueries,
  runCarriageQueries,
  runFitQueries,
  runHoldQueries,
  runLiveEvents,
  runProgressQueries,
  runRepeatabilityQueries,
  runReplay,
  runSoloReplay,
  runTurnQueries,
  runWalkStatsOps,
  type GoldenQuery,
  type LiveEvent,
  type ReplayFrame,
  type SoloMark,
} from "./golden-replay.ts";
import {
  makeRealSession,
  makeSoloSession,
  runTape,
  type Tape,
  type TapeEvent,
} from "./pose-tapes.ts";

const GOLDEN_DIR = new URL("./golden/", import.meta.url);

function load(module: string): GoldenFile {
  const raw = readFileSync(new URL(`${module}.json`, GOLDEN_DIR), "utf8");
  return decodeNums(JSON.parse(raw)) as GoldenFile;
}

// Guard: if a family is added to the inventory without a replay here or a
// tripwire in golden-freshness, this list goes stale loudly.
const REPLAYED = [
  "walk-stats",
  "coach",
  "coach-live",
  "progress",
  "pose-derive-world",
  "solo-derive",
  "gap-tape",
  "walk-replay",
  "walk-replay-solo",
  // Wave 1 instrument-upgrade families (query-style; runners shared with
  // the emitter in golden-replay.ts, the same-truth law).
  "fit-core",
  "head-carriage",
  "hold-stats",
  "repeatability",
  // Wave 2 (tempo + the turn) — same pattern.
  "beat-stats",
  "turn-stats",
] as const;
const TRIPWIRED = ["modes", "coach-tables", "copy-variants"] as const;

it("every inventory family has a web-side net (replay or tripwire)", () => {
  expect([...REPLAYED, ...TRIPWIRED].sort()).toEqual(
    [...GOLDEN_MODULES].sort(),
  );
});

describe("walk-stats vectors replay against the live accumulator", () => {
  for (const c of load("walk-stats").cases) {
    it(c.name, () => {
      const input = c.input as { ops: Array<Record<string, unknown>> };
      expect(goldenDiff(runWalkStatsOps(input.ops), c.expect)).toBeNull();
    });
  }
});

describe("coach vectors replay against buildCoachReport", () => {
  for (const c of load("coach").cases) {
    it(c.name, () => {
      const report = buildCoachReport(c.input as CoachContext);
      expect(goldenDiff({ report }, c.expect)).toBeNull();
    });
  }
});

describe("coach-live vectors replay against LiveCoachPolicy", () => {
  for (const c of load("coach-live").cases) {
    it(c.name, () => {
      const input = c.input as { gates?: string; events: LiveEvent[] };
      expect(
        goldenDiff(
          { cues: runLiveEvents(input.events, gatesFor(input.gates)) },
          c.expect,
        ),
      ).toBeNull();
    });
  }
});

describe("progress vectors replay against progress/session-grading", () => {
  for (const c of load("progress").cases) {
    it(c.name, () => {
      const input = c.input as {
        rows: unknown[];
        queries: Array<{ fn: string; args?: Record<string, unknown> }>;
      };
      expect(
        goldenDiff(
          { results: runProgressQueries(input.rows, input.queries) },
          c.expect,
        ),
      ).toBeNull();
    });
  }
});

// Wave 1 + Wave 2 query-style families: each case replays its {queries}
// (plus rows, for repeatability) through the SAME runner the emitter used.
for (const [module, run] of [
  ["fit-core", runFitQueries],
  ["head-carriage", runCarriageQueries],
  ["hold-stats", runHoldQueries],
  ["beat-stats", runBeatQueries],
  ["turn-stats", runTurnQueries],
] as const) {
  describe(`${module} vectors replay against the live module`, () => {
    for (const c of load(module).cases) {
      it(c.name, () => {
        const input = c.input as { queries: GoldenQuery[] };
        expect(
          goldenDiff({ results: run(input.queries) }, c.expect),
        ).toBeNull();
      });
    }
  });
}

describe("repeatability vectors replay against repeatability/session-grading", () => {
  for (const c of load("repeatability").cases) {
    it(c.name, () => {
      const input = c.input as { rows: unknown[]; queries: GoldenQuery[] };
      expect(
        goldenDiff(
          { results: runRepeatabilityQueries(input.rows, input.queries) },
          c.expect,
        ),
      ).toBeNull();
    });
  }
});

for (const [module, makeSession] of [
  ["pose-derive-world", makeRealSession],
  ["solo-derive", makeSoloSession],
  ["gap-tape", makeRealSession],
] as const) {
  describe(`${module} vectors replay against the real derive session`, () => {
    for (const c of load(module).cases) {
      it(c.name, () => {
        const input = c.input as {
          idealPace: number;
          durationSec: number;
          events: TapeEvent[];
        };
        const tape: Tape = {
          name: c.name,
          idealPace: input.idealPace,
          durationSec: input.durationSec,
          events: input.events,
        };
        expect(
          goldenDiff(deriveExpect(runTape(makeSession, tape)), c.expect),
        ).toBeNull();
      });
    }
  });
}

describe("walk-replay vectors replay the whole loop from their own context", () => {
  for (const c of load("walk-replay").cases) {
    it(c.name, () => {
      const input = c.input as {
        idealPace: number;
        passThreshold: number;
        weights: Record<string, number>;
        walkSeconds: number;
        hz: number;
        durationSec: number;
        frames: ReplayFrame[];
        cueContext: Array<{ markAtSec: number | null }>;
      };
      const out = runReplay(
        input.hz,
        input.frames,
        {
          idealPace: input.idealPace,
          passThreshold: input.passThreshold,
          weights: input.weights,
          walkSeconds: input.walkSeconds,
        },
        input.durationSec,
        // Data, not rules: the marks come from the vector's OWN emitted
        // cueContext, consumed per 2 Hz sample.
        (_frameIdx, sampleIdx) => input.cueContext[sampleIdx].markAtSec,
      );
      const { cueContext, ...expectPart } = out;
      // The re-derived context must equal the emitted one (the sample grid
      // and clock rules are consistent with the data we just replayed)…
      expect(goldenDiff(cueContext, input.cueContext)).toBeNull();
      // …and the full expectation (snapshots, cues, rollup, stats, report)
      // must match the checked-in vector.
      expect(goldenDiff(expectPart, c.expect)).toBeNull();
    });
  }
});

describe("walk-replay-solo vectors replay the SOLO engine loop", () => {
  for (const c of load("walk-replay-solo").cases) {
    it(c.name, () => {
      const input = c.input as {
        idealPace: number;
        passThreshold: number;
        weights: Record<string, number>;
        walkSeconds: number;
        durationSec: number;
        frames: ReplayFrame[];
        marks: SoloMark[];
        cueContext: Array<{ markAtSec: number | null }>;
      };
      const out = runSoloReplay(
        input.frames,
        {
          idealPace: input.idealPace,
          passThreshold: input.passThreshold,
          weights: input.weights,
          walkSeconds: input.walkSeconds,
        },
        // Data, not rules: the ground-truth reversal marks ride in the
        // vector (input.marks) — the same feed the Swift SoloWalkCore
        // consumption test injects.
        input.marks,
      );
      const { cueContext, ...expectPart } = out;
      expect(goldenDiff(cueContext, input.cueContext)).toBeNull();
      expect(goldenDiff(expectPart, c.expect)).toBeNull();
    });
  }
});
