/**
 * (X)RUNWAY — Pure history-row grading + filtering helpers.
 *
 * The run-history gallery, its PASSED / NEEDS WORK filters, and the exports
 * all need the same two judgements about a persisted walk row:
 *   - is it a real trainee walk or a synthetic Preview Walk auto-pilot run?
 *   - did it pass — against the threshold IT was scored with?
 *
 * Kept dependency-free (the stage-budget.ts / hud-state.ts pattern) so the
 * rules are unit-testable in node: landing.ts + session-recorder.ts feed live
 * rows in, the tests feed fixtures.
 */

/** The subset of a SessionSummaryRow the grading rules need. Fields are
 * optional because rows persisted by older builds predate them. */
export interface GradableRow {
  overall: number | null;
  /** The pass threshold of the mode this walk was scored with, captured at
   * record time. Legacy rows (no field) fall back to the historical 75. */
  passThreshold?: number | null;
  /** True when the walk was driven by the Preview Walk auto-pilot. Legacy
   * rows (no field) are real walks. */
  synthetic?: boolean;
}

/** Rows persisted before per-run thresholds were recorded are graded against
 * the fixed line the gallery always used. */
/** 75 — the lowest mode bar. MUST NOT move with the perfect=100 rescale:
 * legacy rows are OLD-RULER rows and re-grade against their own stored
 * bars; bumping this silently rewrites every legacy row's verdict. */
export const LEGACY_PASS_THRESHOLD = 75;

/** Synthetic = recorded while the Preview Walk auto-pilot drove the rig.
 * Legacy persisted rows have no flag and are NOT synthetic. */
export function isSyntheticRow(row: { synthetic?: boolean }): boolean {
  return row.synthetic === true;
}

/** The pass line THIS row was scored against: its stored per-run threshold,
 * or the legacy 75 for rows that predate the field (or carry junk). */
export function rowPassThreshold(row: GradableRow): number {
  const t = row.passThreshold;
  return typeof t === "number" && Number.isFinite(t)
    ? t
    : LEGACY_PASS_THRESHOLD;
}

/** Did this row pass, judged against ITS OWN threshold (#40) — so a Beginner
 * 76 reads NEEDS WORK in history exactly as it did on the summary card.
 * A row with no recorded overall never passes. */
export function rowPassed(row: GradableRow): boolean {
  return row.overall !== null && row.overall >= rowPassThreshold(row);
}

/**
 * Trainee-scoping rule for the reload baseline (lastRealOverall) and the
 * progress/trends consumers on a SHARED device (kiosk/classroom). PINNED:
 * - a falsy CURRENT trainee id (no identity wired) filters NOTHING;
 * - otherwise a row matches when its `trainee.id` equals the current id, OR
 *   when the row carries no usable attribution — no `trainee` field (legacy
 *   single-user rows), a null trainee, or a junk/non-string id — so a pre-#4
 *   history keeps grading the device's single user instead of vanishing.
 */
export function rowMatchesTrainee(
  row: { trainee?: { id?: unknown } | null },
  traineeId: string | null | undefined,
): boolean {
  if (!traineeId) return true;
  const t = row.trainee;
  if (t === undefined || t === null) return true;
  const id = (t as { id?: unknown }).id;
  if (typeof id !== "string") return true; // junk attribution -> unattributed
  return id === traineeId;
}

/**
 * The head-path normalization stamp THIS row was scored under (Wave 1 FIT,
 * adjudication §A — the ONE reader helper). Rows persisted before the FIT
 * wave (or with junk) were scored with the factory constants — they read
 * "default.v1", deliberately merging with new default-scored rows: identical
 * constants scored both, so they ARE one series. Tokens: "default.v1" |
 * "fit.v1-<capturedAt ms>" (body-baseline.ts mints them).
 */
export function rowNormalization(row: { normalization?: unknown }): string {
  const n = row.normalization;
  return typeof n === "string" && n.length > 0 ? n : "default.v1";
}

/** Composable trends-title suffix (adjudication §E): FIT's commit appends it
 * to the EXISTING title when the stamp prefilter excluded rows; M12 later
 * rewrites the base and keeps this hook. Tests assert the PARTS, never the
 * whole merged string. */
export const SINCE_FIT_TITLE_SUFFIX = " (SINCE FIT)";

/**
 * The trends-strip BASE title (adjudication §E — M12's half of the
 * composition; the landing renders base + SINCE_FIT_TITLE_SUFFIX). The
 * mixed-mode strip is demoted from "TRENDS" to "RECENT ACTIVITY": it blends
 * modes, shapes and sensors, so it reports activity — only the benchmark
 * line (repeatability.ts, benchmarkLine) is ever captioned as improvement.
 * Em-dash is legal here: this string lives on the WEB history panel only and
 * never reaches the ASCII-constrained XR panel.
 */
export function recentActivityTitle(walksShown: number): string {
  return `RECENT ACTIVITY — LAST ${walksShown} WALKS`;
}

/** Result of scoping a row series to one normalization stamp. `excluded` is
 * true when the filter actually dropped rows — the landing appends
 * SINCE_FIT_TITLE_SUFFIX to the trends title exactly then. */
export interface NormalizationScope<T> {
  rows: T[];
  excluded: boolean;
}

/**
 * Scope a comparative SERIES (trends / sparkline / rolling avg) to rows
 * scored under `activeStamp` (adversary A's rule: pre-FIT and post-FIT
 * scores are never trended as one series). Absent/junk stamps read
 * "default.v1" via rowNormalization, so legacy history trends normally for
 * anyone who never runs FIT. Records/mastery/personal-best are deliberately
 * NOT scoped (each row grades against its own stamped bar — all-time facts).
 */
export function scopeRowsToNormalization<T extends { normalization?: unknown }>(
  rows: ReadonlyArray<T>,
  activeStamp: string,
): NormalizationScope<T> {
  const scoped = rows.filter((r) => rowNormalization(r) === activeStamp);
  return { rows: scoped, excluded: scoped.length !== rows.length };
}

// ---------------------------------------------------------------------------
// Score-scale stamp (the perfect=100 rescale, founder ruling 2026-07-09).
// ---------------------------------------------------------------------------

/** The ruler every pre-rescale row was scored on: per-channel anchors
 * 95/96 with the 98 cap. Rows persisted before the rescale carry no
 * scoreScale field — absent/junk reads this token. NOTE the amended
 * adjudication: the "records are deliberately NOT scoped" rule above
 * applies to NORMALIZATION (same ruler, different calibration); the scale
 * stamp is the RULER ITSELF changing, so RAW-overall comparisons
 * (personal best, deltaVsLast, trends, the benchmark series) ARE
 * scale-scoped. Pass-based facts (mastery, pass counts) stay unscoped —
 * each row grades against its own stored bar. */
export const LEGACY_SCORE_SCALE = "s98.v1";

/** The scale stamp THIS row was scored under (the rowNormalization idiom
 * applied to the ruler): the stored string when present, else
 * LEGACY_SCORE_SCALE. pose-derive.ts SCORE_SCALE_STAMP is the current
 * ruler; the recorder mints it at walk start. */
export function rowScoreScale(row: { scoreScale?: unknown }): string {
  const v = row.scoreScale;
  return typeof v === "string" && v.length > 0 ? v : LEGACY_SCORE_SCALE;
}

/** Scope a comparative series to rows scored on `activeScale` — the
 * scopeRowsToNormalization twin for the ruler. */
export function scopeRowsToScale<T extends { scoreScale?: unknown }>(
  rows: ReadonlyArray<T>,
  activeScale: string,
): NormalizationScope<T> {
  const scoped = rows.filter((r) => rowScoreScale(r) === activeScale);
  return { rows: scoped, excluded: scoped.length !== rows.length };
}

/** Composable trends-title suffix when the scale prefilter dropped old-ruler
 * rows (the SINCE_FIT_TITLE_SUFFIX pattern). PROVISIONAL wording — founder
 * call F.20 (the medal PROVISIONAL precedent); web-only surface, em-dash
 * legal. */
export const NEW_SCALE_TITLE_SUFFIX = " (NEW SCORING)";

export type HistoryFilter = "all" | "pass" | "low";

/**
 * Apply a run-history filter. ALL keeps everything (synthetic rows render with
 * a PREVIEW badge); PASSED / NEEDS WORK are TRAINING verdicts, so synthetic
 * auto-pilot rows are excluded from both (#3) and each real row is graded
 * against its own threshold.
 */
export function filterHistoryRows<T extends GradableRow>(
  rows: ReadonlyArray<T>,
  filter: HistoryFilter,
): T[] {
  if (filter === "all") {
    return [...rows];
  }
  return rows.filter(
    (r) => !isSyntheticRow(r) && (filter === "pass") === rowPassed(r),
  );
}
