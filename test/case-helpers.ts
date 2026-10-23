/**
 * (X)RUNWAY — SHARED case builders: the single source of test-case truth for
 * BOTH the vitest suites and the golden-vector generator
 * (scripts/gen-golden-vectors.mjs — SOLO-MODE.md §6.1).
 *
 * These helpers used to live test-file-local (coach-live.test.ts sample()/
 * run(), coach.test.ts snap()/stats() + the report/note context defaults,
 * progress.test.ts row()/scored()/modeRow()). The golden pipeline's rule is
 * that vectors and tests are PROVABLY the same truth, so the builders moved
 * here and the suites import them back — a change to a default input shape
 * now moves the tests and the emitted vectors together, never one without
 * the other.
 *
 * NO vitest imports allowed in this file: it must load under plain `node`
 * (the generator runs via node's TS type-stripping, exactly like
 * test/pose-derive-tape.mjs). Assertion-carrying helpers (coach.test.ts
 * noteFor) stay in their suites and build their inputs from the context
 * builders here.
 */

import { LiveCoachPolicy, type LiveCue, type LiveCueInput } from "../src/coach-live.ts";
import { SCORE_SCALE_STAMP } from "../src/pose-derive.ts";
import type { CoachContext, MetricKey } from "../src/coach.ts";
import { MODES } from "../src/modes.ts";
import { PROGRESS_METRIC_KEYS, type ProgressRow } from "../src/progress.ts";
import type { MetricSnapshot } from "../src/show.ts";
import type { WalkStats } from "../src/walk-stats.ts";

// ---------------------------------------------------------------------------
// coach-live: the 2 Hz sample grid (test/coach-live.test.ts).
// ---------------------------------------------------------------------------

/** The system samples at 2 Hz — tests and vectors drive the same grid. */
export const STEP = 0.5;

/** A clean walking sample; override the fields under test. */
export function sample(over: Partial<LiveCueInput> = {}): LiveCueInput {
  return {
    walking: true,
    walkRemainingSec: 600,
    markAtSec: null,
    walkProgress01: 0,
    oneWayRoute: false,
    paceDeltaMps: 0,
    absLateralM: 0,
    postureM: 0,
    ...over,
  };
}

/** Drive `policy` from t=STEP to t=until on the 2 Hz grid, collecting cues. */
export function run(
  policy: LiveCoachPolicy,
  until: number,
  at: (t: number) => LiveCueInput,
): Array<{ t: number; cue: LiveCue }> {
  const out: Array<{ t: number; cue: LiveCue }> = [];
  for (let i = 1; i * STEP <= until + 1e-9; i++) {
    const t = i * STEP;
    const cue = policy.decideLiveCue(at(t), t);
    if (cue) out.push({ t, cue });
  }
  return out;
}

// ---------------------------------------------------------------------------
// coach: context builders (test/coach.test.ts).
// ---------------------------------------------------------------------------

export const METRIC_KEYS: ReadonlyArray<MetricKey> = [
  "posture",
  "pace",
  "rhythm",
  "footPlacement",
  "presence",
  "confidence",
  "presentation",
];

/** The default mode every coach case is judged in unless overridden. */
export const BEGINNER = MODES[0]; // passThreshold 78

/** A full snapshot at one value, with per-key overrides. */
export function snap(
  base: number,
  over: Partial<MetricSnapshot> = {},
): MetricSnapshot {
  const s = {} as MetricSnapshot;
  for (const k of METRIC_KEYS) s[k] = base;
  return { ...s, ...over };
}

/** WalkStats with every channel null/empty unless overridden. */
export function stats(over: Partial<WalkStats> = {}): WalkStats {
  return {
    meanPaceMps: null,
    idealPaceMps: 0.85,
    paceDeltaMps: null,
    meanLateralM: null,
    meanAbsLateralM: null,
    postureDriftM: null,
    steps: 0,
    cadenceSpm: null,
    source: "head",
    ...over,
  };
}

/** The default CoachContext (the report() fixture) with overrides. */
export function coachContext(over: Partial<CoachContext> = {}): CoachContext {
  return {
    scores: snap(90),
    overall: 90,
    mode: BEGINNER,
    stats: null,
    oneWayRoute: false,
    ...over,
  };
}

/**
 * The context noteFor() judges: only `key` sits below the line, so the report
 * carries exactly one note and its cue is the one under test. (The asserting
 * noteFor wrapper stays in coach.test.ts; this builds its input.)
 */
export function noteContext(
  key: MetricKey,
  walkStats: WalkStats | null,
  oneWayRoute = false,
): CoachContext {
  return coachContext({
    scores: snap(95, { [key]: 50 } as Partial<MetricSnapshot>),
    overall: 85,
    stats: walkStats,
    oneWayRoute,
  });
}

// ---------------------------------------------------------------------------
// progress: row factories (test/progress.test.ts).
// ---------------------------------------------------------------------------

/** Row factory — chronological startedAt derived from an index. */
export function row(
  i: number,
  overall: number | null,
  extra: Partial<ProgressRow> = {},
): ProgressRow {
  // Stamped current-ruler by default (the perfect=100 rescale): these
  // fixtures model TODAY's histories, and raw-overall records only compete
  // on the current scale. Pass scoreScale in `extra` (or null/undefined via
  // an explicit override) to model old-ruler rows in the split-law cases.
  return { startedAt: 1000 + i * 60_000, overall, scoreScale: SCORE_SCALE_STAMP, ...extra };
}

/** Rows whose overall AND every metric equal `v` — trend fixtures. */
export function scored(i: number, v: number): ProgressRow {
  const finalScores = {} as Record<string, number>;
  for (const k of PROGRESS_METRIC_KEYS) finalScores[k] = v;
  return row(i, v, { finalScores });
}

/** A walk in `modeId` scored against a stored per-run bar (default 78). */
export function modeRow(
  i: number,
  modeId: string | null,
  overall: number | null,
  passThreshold: number | null = 78,
  extra: Partial<ProgressRow> = {},
): ProgressRow {
  return row(i, overall, { modeId, passThreshold, ...extra });
}
