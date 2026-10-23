/**
 * (X)RUNWAY — SHARED case builders for the M12 repeatability suite AND the
 * future "repeatability" golden-family emitter (scripts/gen-golden-vectors
 * .mjs — registered in the Wave 1 VECTORS commit per the bootstrap order).
 *
 * The golden pipeline's rule is that vectors and tests are PROVABLY the same
 * truth (the test/case-helpers.ts pattern), so the row factories live here
 * and test/repeatability.test.ts imports them back — a change to a default
 * input shape moves the tests and the emitted vectors together, never one
 * without the other.
 *
 * NO vitest imports allowed in this file: it must load under plain `node`
 * (the generator runs via node's TS type-stripping, exactly like
 * test/pose-derive-tape.mjs).
 */

import type {
  BenchmarkRow,
  RepeatRow,
  RepeatStatsSlice,
} from "../src/repeatability.ts";

/** A stats slice with every channel null unless overridden — mirrors the
 * case-helpers stats() convention (a channel that never measured is null). */
export function slice(over: Partial<RepeatStatsSlice> = {}): RepeatStatsSlice {
  return {
    meanPaceMps: null,
    cadenceSpm: null,
    meanAbsLateralM: null,
    ...over,
  };
}

/**
 * Row factory — chronological startedAt derived from the index (the
 * case-helpers row() convention) and every M12 group-key stamp defaulting to
 * the benchmark configuration on the head sensor, so a plain walkRow(i)
 * always qualifies and each guard test breaks exactly ONE key part via
 * `over`. `normalization` stays ABSENT by default (the legacy/default wire
 * shape — adjudication §A: absent reads as "default.v1").
 */
export function walkRow(i: number, over: Partial<RepeatRow> = {}): RepeatRow {
  return {
    startedAt: 1000 + i * 60_000,
    overall: 80,
    modeId: "beginner",
    passThreshold: 78,
    shapeKind: "straight",
    primarySource: "head",
    ...over,
  };
}

/** Matched walks whose ONLY measured channel is pace — the workhorse fixture
 * for the CV/outlier math (index order = chronological order). */
export function paceWalks(
  paces: ReadonlyArray<number>,
  over: Partial<RepeatRow> = {},
): RepeatRow[] {
  return paces.map((p, i) =>
    walkRow(i, { stats: slice({ meanPaceMps: p }), ...over }),
  );
}

/** The wire shape the benchmark queries group over (RepeatRow's stamps +
 * the benchmark flag) — what a recorder-persisted row structurally is. */
export type BenchRow = RepeatRow & BenchmarkRow;

/**
 * Benchmark-STAMPED row: walkRow's benchmark-configuration defaults plus
 * `benchmark: true` (the recorder's walk-start stamp as §G finalize keeps
 * it) and an explicit overall — the series/headline queries read overalls,
 * not stats. `normalization` stays ABSENT by default (§A wire shape).
 */
export function benchRow(
  i: number,
  overall: number,
  over: Partial<BenchRow> = {},
): BenchRow {
  return { ...walkRow(i), overall, benchmark: true, ...over };
}

/** Matched walks with per-walk channel values (null = channel dark, the
 * camera-image "never voted" shape); `undefined` fields fall back to null. */
export function fullWalks(
  values: ReadonlyArray<{
    pace?: number | null;
    cadence?: number | null;
    lateral?: number | null;
  }>,
  over: Partial<RepeatRow> = {},
): RepeatRow[] {
  return values.map((v, i) =>
    walkRow(i, {
      stats: slice({
        meanPaceMps: v.pace ?? null,
        cadenceSpm: v.cadence ?? null,
        meanAbsLateralM: v.lateral ?? null,
      }),
      ...over,
    }),
  );
}
