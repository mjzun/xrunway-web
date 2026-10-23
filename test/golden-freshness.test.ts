/**
 * (X)RUNWAY — golden-vector VALIDITY suite (SOLO-MODE.md §6, Phase A1b).
 *
 * Validates the checked-in test/golden/*.json drift-lock vectors on every
 * vitest run: the full inventory exists, every file parses and matches the
 * pinned xrunway-golden/1 envelope, case names are unique, the non-finite
 * sentinels are in use where the honesty cases demand them, the modes table
 * still matches the live MODES constants (the cheap staleness tripwire), and
 * every frame-invariance pair is internally identical under the shared
 * comparison rule (test/golden-format.ts).
 *
 * THIS SUITE NEVER REGENERATES. Regeneration is an explicit, deliberate act:
 *
 *   node scripts/gen-golden-vectors.mjs
 *
 * (which refuses to emit while vitest is red OR the tree is dirty). If a
 * scoring change lands without regeneration, the web-side nets go red:
 * test/golden-replay.test.ts re-executes every behavioral family's inputs
 * through the real modules on each vitest run; the table tripwires below
 * (modes, coach-tables, copy-variants) deep-compare against the live
 * exports; `npm test` additionally runs the generator's --check mode
 * (rebuild-in-memory vs disk, generatedBy ignored); and the byte-golden
 * tape suite (pose-derive-world.test.ts) pins the derive module itself.
 */

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CLEAN_WALK_CUE, METRIC_COACH, METRIC_EXPLAIN } from "../src/coach.ts";
import { SOLO_COPY_VARIANTS } from "../src/coach-copy.ts";
import {
  COACH_EARCONS,
  COACH_EARCON_LEVEL,
  LIVE_CUE_TEXT,
  PACE_DELTA_CUE_MPS,
  SOLO_LATERAL_CUE_M,
  SOLO_LATERAL_CUE_SMOOTH_RATE,
  SOLO_POSTURE_CUE_M,
} from "../src/coach-live.ts";
import { MODES } from "../src/modes.ts";
import {
  SOLO_GAP_SEC,
  SOLO_HEADING_STABLE_MIN,
  SOLO_LATERAL_BASELINE_SEC,
  SOLO_POSTURE_SLOPE,
  SOLO_TURN_EXCLUDE_SEC,
} from "../src/pose-derive.ts";
import {
  GOLDEN_MODULES,
  GOLDEN_SCHEMA,
  PAIRED_MODULES,
  RIGID_SUFFIX,
  decodeNums,
  goldenDiff,
  type GoldenFile,
} from "./golden-format.ts";

const GOLDEN_DIR = new URL("./golden/", import.meta.url);

function load(module: string): GoldenFile {
  const raw = readFileSync(new URL(`${module}.json`, GOLDEN_DIR), "utf8");
  return JSON.parse(raw) as GoldenFile;
}

describe("golden vectors — inventory and envelope", () => {
  it("the emitted inventory is exactly the pinned module list", () => {
    const onDisk = readdirSync(GOLDEN_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
    expect(onDisk).toEqual([...GOLDEN_MODULES].sort());
  });

  for (const module of GOLDEN_MODULES) {
    it(`${module}.json parses and matches the xrunway-golden/1 envelope`, () => {
      const g = load(module);
      expect(g.schema).toBe(GOLDEN_SCHEMA);
      expect(g.module).toBe(module);
      expect(g.generatedBy.script).toBe("scripts/gen-golden-vectors.mjs");
      expect(g.generatedBy.gitSha).toMatch(/^[0-9a-f]{40}$/);
      // ISO-8601 with offset (git %cI) — parseable and not the epoch.
      expect(Number.isFinite(Date.parse(g.generatedBy.date))).toBe(true);
      expect(Array.isArray(g.cases)).toBe(true);
      expect(g.cases.length).toBeGreaterThan(0);
      const names = new Set<string>();
      for (const c of g.cases) {
        expect(typeof c.name, `${module} case name`).toBe("string");
        expect(names.has(c.name), `${module} duplicate ${c.name}`).toBe(false);
        names.add(c.name);
        expect("input" in c, `${module}/${c.name} input`).toBe(true);
        expect("expect" in c, `${module}/${c.name} expect`).toBe(true);
      }
    });
  }

  it("every file was stamped by the same generator run (one sha, one date)", () => {
    const stamps = new Set(
      GOLDEN_MODULES.map((m) => {
        const g = load(m);
        return `${g.generatedBy.gitSha}@${g.generatedBy.date}`;
      }),
    );
    expect(stamps.size).toBe(1);
  });
});

describe("golden vectors — non-finite sentinels", () => {
  it("the coach-live honesty cases carry real NaN/Infinity via sentinels", () => {
    const raw = readFileSync(new URL("coach-live.json", GOLDEN_DIR), "utf8");
    expect(raw).toContain('{"$num":"nan"}');
    expect(raw).toContain('{"$num":"+inf"}');
    expect(raw).toContain('{"$num":"-inf"}');
    // ...and they decode to the actual non-finite numbers.
    const g = decodeNums(JSON.parse(raw)) as GoldenFile;
    const sticky = g.cases.find((c) => c.name === "sticky-nan-pace-fires-nothing")!;
    const events = (sticky.input as { events: Array<{ sample?: { paceDeltaMps: number } }> })
      .events;
    expect(events.some((e) => e.sample && Number.isNaN(e.sample.paceDeltaMps))).toBe(
      true,
    );
    expect((sticky.expect as { cues: unknown[] }).cues).toEqual([]);
  });
});

describe("golden vectors — modes table tripwire (stale vectors go red here)", () => {
  it("modes.json matches the live MODES constants exactly", () => {
    const g = decodeNums(load("modes")) as GoldenFile;
    const want = MODES.map((m) => ({
      name: `mode-${m.id}`,
      input: { id: m.id },
      expect: {
        id: m.id,
        idealPace: m.idealPace,
        passThreshold: m.passThreshold,
        weights: m.weights,
        walkSeconds: m.walkSeconds,
      },
    }));
    expect(goldenDiff(g.cases, want)).toBeNull();
  });
});

describe("golden vectors — coach-tables tripwire (stale tables go red here)", () => {
  it("coach-tables.json matches the live exported tables exactly", () => {
    const g = decodeNums(load("coach-tables")) as GoldenFile;
    const tables = g.cases.find((c) => c.name === "copy-and-earcon-tables")!;
    expect(
      goldenDiff(tables.expect, {
        METRIC_EXPLAIN,
        METRIC_COACH,
        CLEAN_WALK_CUE,
        LIVE_CUE_TEXT,
        COACH_EARCONS,
        COACH_EARCON_LEVEL,
      }),
    ).toBeNull();
    const thresholds = g.cases.find((c) => c.name === "solo-cue-thresholds")!;
    expect(
      goldenDiff(thresholds.expect, {
        PACE_DELTA_CUE_MPS,
        SOLO_LATERAL_CUE_M,
        SOLO_POSTURE_CUE_M,
        SOLO_POSTURE_SLOPE,
        SOLO_HEADING_STABLE_MIN,
        SOLO_LATERAL_BASELINE_SEC,
        SOLO_GAP_SEC,
        SOLO_TURN_EXCLUDE_SEC,
        SOLO_LATERAL_CUE_SMOOTH_RATE,
      }),
    ).toBeNull();
  });

  it("copy-variants.json matches the live table; web column is live copy verbatim", () => {
    const g = decodeNums(load("copy-variants")) as GoldenFile;
    const want = SOLO_COPY_VARIANTS.map((v) => ({
      name: `${v.surface}:${v.key}`,
      input: { surface: v.surface, key: v.key },
      expect: { web: v.web, solo: v.solo },
    }));
    expect(goldenDiff(g.cases, want)).toBeNull();
    // The table's non-template web strings must be the LIVE tables' strings
    // (coach-copy.ts builds them from real imports — this trips if the
    // vectors go stale against a copy edit).
    const byKey = new Map(
      g.cases.map((c) => [(c.input as { key: string }).key, c]),
    );
    const webOf = (key: string) =>
      (byKey.get(key)!.expect as { web: string }).web;
    expect(webOf("LIVE_CUE_TEXT.center-up")).toBe(LIVE_CUE_TEXT["center-up"]);
    expect(webOf("METRIC_COACH.footPlacement")).toBe(
      METRIC_COACH.footPlacement,
    );
    expect(webOf("METRIC_EXPLAIN.footPlacement")).toBe(
      METRIC_EXPLAIN.footPlacement,
    );
    // Solo strings never claim the centerline that Solo cannot measure.
    for (const c of g.cases) {
      const e = c.expect as { web: string; solo: string };
      expect(e.solo.toLowerCase()).not.toContain("centerline");
      expect(e.solo).not.toBe(e.web);
    }
  });
});

describe("golden vectors — frame-invariance pairs (the §6.4 honesty lock)", () => {
  for (const module of PAIRED_MODULES) {
    it(`${module}: every walk carries a rigid twin with identical expectations`, () => {
      const g = decodeNums(load(module)) as GoldenFile;
      const byName = new Map(g.cases.map((c) => [c.name, c]));
      const rawCases = g.cases.filter((c) => !c.name.endsWith(RIGID_SUFFIX));
      expect(rawCases.length).toBeGreaterThan(0);
      // Exact pairing, both directions.
      expect(g.cases.length).toBe(rawCases.length * 2);
      for (const c of rawCases) {
        const twin = byName.get(`${c.name}${RIGID_SUFFIX}`);
        expect(twin, `${module}/${c.name} rigid twin`).toBeDefined();
        // The twins' INPUTS must genuinely differ (a copied tape would make
        // the invariance check vacuous)…
        expect(goldenDiff(c.input, twin!.input)).not.toBeNull();
        // …while the EXPECTED outputs are identical under the shared §6.5
        // rule (exact strings/ints; floats within IEEE rotation noise).
        expect(goldenDiff(c.expect, twin!.expect)).toBeNull();
      }
    });
  }

  it("walk-replay covers both mandated rates", () => {
    const g = load("walk-replay");
    const names = g.cases.map((c) => c.name);
    expect(names).toContain("walk-replay-30hz");
    expect(names).toContain("walk-replay-60hz");
  });
});
