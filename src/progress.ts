/**
 * (X)RUNWAY — progress-over-time stats (POLISH-AUDIT #11 + the #38 per-mode
 * records/mastery layer).
 *
 * Pure cross-walk math over the persisted history rows (SessionSummaryRow):
 * the overall-score series behind the run-history sparkline, the personal
 * best, a rolling average, per-metric trend deltas, and per-mode records
 * with a documented mastery rule. This is the layer that turns a flat walk
 * log into "you are improving" — the one thing a training product's history
 * owes the trainee.
 *
 * Dependency-free by design (no @iwsdk/core, no DOM) so it loads in vitest —
 * the stage-budget.ts / session-grading.ts pattern. Every rule shares one
 * qualifying set: REAL walks only (synthetic Preview Walk auto-pilot rows are
 * excluded via session-grading's flag — auto-pilot data must never read as a
 * trainee improving) with a finite overall score, sorted chronologically
 * regardless of input order (the recorder's list() is newest-first, its
 * internal store oldest-first; rows with equal startedAt keep input order).
 */

import { isSyntheticRow, rowPassed, rowScoreScale } from "./session-grading.js";
import { SCORE_SCALE_STAMP } from "./pose-derive.js";

/** The 7 metric keys, mirroring MetricSnapshot (show.ts). Value copy kept
 * here — the session-recorder METRIC_COLS pattern — so this module never
 * pulls the @iwsdk/core import chain into the test runner. */
export const PROGRESS_METRIC_KEYS = [
  "posture",
  "pace",
  "rhythm",
  "footPlacement",
  "presence",
  "confidence",
  "presentation",
] as const;
export type ProgressMetricKey = (typeof PROGRESS_METRIC_KEYS)[number];

/** The subset of a SessionSummaryRow the progress rules need. Fields are
 * optional/nullable where rows persisted by older builds may lack them. */
export interface ProgressRow {
  /** Epoch ms at walk start (junk values sort as 0, never throw). */
  startedAt: number;
  overall: number | null;
  synthetic?: boolean;
  finalScores?: Partial<Record<ProgressMetricKey, number>> | null;
  /** Training-mode id the walk was scored with ("beginner".."challenge").
   * Absent/null on rows persisted before modes were recorded — those group
   * under the LEGACY_MODE_BUCKET for per-mode stats. */
  modeId?: string | null;
  /** The mode's pass bar AT RECORD TIME; per-mode pass counts judge against
   * this via session-grading's rowPassed (legacy fallback 75). */
  passThreshold?: number | null;
  /** Ruler stamp (perfect=100 rescale) — absent reads "s98.v1" via
   * rowScoreScale. RAW-overall records (personal best, per-mode best) only
   * compete on the CURRENT ruler; pass-based facts (mastery, pass counts)
   * stay unscoped — each row grades against its own stored bar. */
  scoreScale?: string | null;
}

/** Rolling-average + trend comparison window (walks). */
export const TREND_WINDOW = 5;
/** Sparkline series length cap (walks). */
export const SERIES_MAX = 20;

function startedMs(row: ProgressRow): number {
  const ms = Number(row.startedAt);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The qualifying set for every progress rule: REAL, SCORED walks in
 * chronological order. Synthetic Preview Walk rows and rows without a finite
 * overall are out; input order doesn't matter (stable sort on startedAt).
 */
export function realScoredRows<T extends ProgressRow>(
  rows: ReadonlyArray<T>,
): T[] {
  return rows
    .filter(
      (r) =>
        !isSyntheticRow(r) &&
        typeof r.overall === "number" &&
        Number.isFinite(r.overall),
    )
    .sort((a, b) => startedMs(a) - startedMs(b));
}

export interface PersonalBest {
  overall: number;
  /** Epoch ms of the walk that SET the record. Ties keep the EARLIEST walk —
   * matching a record later is not a new best. */
  startedAt: number;
}

/** Personal best overall across ALL real scored walks, or null. */
/** True when the row was scored on the CURRENT ruler (perfect=100 rescale):
 * raw overalls are only comparable on one ruler, so records restart when
 * the scale changes — the first post-rescale walk is honestly a baseline,
 * never a "+N vs" or an instant PB against old-ruler numbers. */
function onCurrentScale(row: ProgressRow): boolean {
  return rowScoreScale(row) === SCORE_SCALE_STAMP;
}

export function personalBest(
  rows: ReadonlyArray<ProgressRow>,
): PersonalBest | null {
  let best: PersonalBest | null = null;
  for (const r of realScoredRows(rows)) {
    if (!onCurrentScale(r)) continue; // old-ruler rows never compete
    const overall = r.overall as number;
    if (best === null || overall > best.overall) {
      best = { overall, startedAt: startedMs(r) };
    }
  }
  return best;
}

/**
 * The 1-based RANK of a walk's `overall` among the trainee's real scored
 * walks on the current ruler — this walk INCLUDED (the recorder finalizes
 * before the summary renders, so its row is already in `rows`). Best = 1;
 * ties share a rank (strictly-better count + 1). null when `overall` is not
 * a finite number.
 *
 * The medal reads this rank (founder ruling 2026-07-10): the badge is the
 * score's POSITION among your walks, not an absolute bar — your best walk
 * is 1st = GOLD, then SILVER, then BRONZE, and one score is always 1st.
 * Old-ruler rows are excluded (raw overalls only compare on one ruler,
 * the personalBest law), so the first walk after a rescale ranks 1st.
 */
export function medalRank(
  overall: number,
  rows: ReadonlyArray<ProgressRow>,
): number | null {
  if (!Number.isFinite(overall)) return null;
  let better = 0;
  for (const r of realScoredRows(rows)) {
    if (!onCurrentScale(r)) continue;
    const o = r.overall as number;
    if (Number.isFinite(o) && o > overall) better += 1;
  }
  return better + 1;
}

/**
 * Mean of the last `window` values (fewer when the series is shorter — the
 * average is over min(window, n) values, so a 3-walk history still reads).
 * Null when the series is empty. Values are chronological.
 */
export function rollingAverage(
  values: ReadonlyArray<number>,
  window: number = TREND_WINDOW,
): number | null {
  if (values.length === 0 || window < 1) return null;
  const n = Math.min(window, values.length);
  let sum = 0;
  for (let i = values.length - n; i < values.length; i++) sum += values[i];
  return sum / n;
}

/**
 * Trend delta over a chronological series: mean of the last w values minus
 * mean of the w values before those, where w = min(window, floor(n/2)).
 *
 * THE RULE (documented, test-enforced): with 10+ walks this compares the last
 * 5 against the previous 5; shorter histories shrink BOTH windows together so
 * the comparison stays like-for-like (4 walks → last 2 vs previous 2; 2-3
 * walks → last 1 vs the 1 before it). Anything older than the last 2w walks
 * is ignored. Null when fewer than 2 values — nothing to compare.
 */
export function trendDelta(
  values: ReadonlyArray<number>,
  window: number = TREND_WINDOW,
): number | null {
  const n = values.length;
  if (n < 2 || window < 1) return null;
  const w = Math.min(window, Math.floor(n / 2));
  let recent = 0;
  let previous = 0;
  for (let i = 0; i < w; i++) {
    recent += values[n - 1 - i];
    previous += values[n - 1 - w - i];
  }
  return (recent - previous) / w;
}

/** Overall scores of the last ≤`max` real walks, chronological (sparkline). */
export function overallSeries(
  rows: ReadonlyArray<ProgressRow>,
  max: number = SERIES_MAX,
): number[] {
  const real = realScoredRows(rows);
  const out: number[] = [];
  for (let i = Math.max(0, real.length - max); i < real.length; i++) {
    out.push(real[i].overall as number);
  }
  return out;
}

/**
 * Per-metric trend deltas (see trendDelta) from the rows' final scores. A
 * metric only counts walks where it was recorded with a finite value, so a
 * legacy row without finalScores can't zero a trend — it just doesn't vote.
 * Null when that metric has fewer than 2 recorded walks.
 */
export function metricTrends(
  rows: ReadonlyArray<ProgressRow>,
): Record<ProgressMetricKey, number | null> {
  const real = realScoredRows(rows);
  const out = {} as Record<ProgressMetricKey, number | null>;
  for (const key of PROGRESS_METRIC_KEYS) {
    const values: number[] = [];
    for (const r of real) {
      const v = r.finalScores ? r.finalScores[key] : undefined;
      if (typeof v === "number" && Number.isFinite(v)) values.push(v);
    }
    out[key] = trendDelta(values);
  }
  return out;
}

/**
 * True when the trainee's LATEST real walk set a new personal best:
 * - it beat every earlier real walk STRICTLY (tying a record only matches it),
 * - at least one earlier real walk exists (a first walk is a baseline, not a
 *   best), and
 * - no newer row of ANY kind was recorded after it (a Preview Walk run after
 *   the record must never re-announce it as new).
 */
export function latestIsPersonalBest(
  rows: ReadonlyArray<ProgressRow>,
): boolean {
  // Scale-scoped (perfect=100 rescale): PB is a current-ruler fact — the
  // latest walk must be current-scale, and only current-scale rows compete.
  const real = realScoredRows(rows).filter(onCurrentScale);
  if (real.length < 2) return false;
  const latest = real[real.length - 1];
  for (const r of rows) {
    if (startedMs(r) > startedMs(latest)) return false;
  }
  const latestOverall = latest.overall as number;
  for (let i = 0; i < real.length - 1; i++) {
    if ((real[i].overall as number) >= latestOverall) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-mode records + mastery (POLISH-AUDIT #38).
// ---------------------------------------------------------------------------

/** Bucket id for rows persisted before modeId was recorded. They still get
 * per-mode stats (walks/best/last/passed — each row grades against its own
 * stored bar via rowPassed, legacy fallback 75) but NEVER a mastery flag:
 * mastery is a claim about a specific lesson's bar, and these rows can't
 * prove which lesson they trained. */
export const LEGACY_MODE_BUCKET = "legacy";

/** THE MASTERY RULE (pinned, test-enforced): a mode is mastered when at
 * least MASTERY_PASS_COUNT of the last MASTERY_WINDOW real walks in that
 * mode passed — each walk judged against ITS OWN recorded passThreshold
 * (session-grading rowPassed; legacy fallback 75). Recency is the point:
 * three early passes buried under recent failures are not mastery. */
export const MASTERY_PASS_COUNT = 3;
export const MASTERY_WINDOW = 5;

/** Cross-walk record for one training mode (real scored walks only). */
export interface ModeStats {
  /** The mode id, or LEGACY_MODE_BUCKET for pre-mode rows. */
  modeId: string;
  /** Real scored walks in this mode (all-time). */
  walks: number;
  /** Best overall in this mode. */
  best: number;
  /** Overall of the most recent walk in this mode. */
  last: number;
  /** Passing walks in this mode (all-time, each vs its own bar). */
  passed: number;
  /** See MASTERY_PASS_COUNT / MASTERY_WINDOW; always false for the legacy
   * bucket. */
  mastered: boolean;
}

/** The row's per-mode bucket id. Junk/empty modeId = legacy. */
function modeBucket(row: ProgressRow): string {
  const id = row.modeId;
  return typeof id === "string" && id.length > 0 ? id : LEGACY_MODE_BUCKET;
}

/** The pinned mastery rule over ONE mode's chronological real walks. */
function masteredFrom(walks: ReadonlyArray<ProgressRow>): boolean {
  let passed = 0;
  const from = Math.max(0, walks.length - MASTERY_WINDOW);
  for (let i = from; i < walks.length; i++) {
    if (rowPassed(walks[i])) passed++;
  }
  return passed >= MASTERY_PASS_COUNT;
}

/**
 * Per-mode records across the history: one entry per mode bucket present in
 * the REAL scored rows (synthetic Preview Walks never count; the caller
 * trainee-filters, as everywhere else). Entries keep first-walked order —
 * consumers reorder for display (the landing uses the MODES table order).
 */
export function modeStats(rows: ReadonlyArray<ProgressRow>): ModeStats[] {
  const byMode = new Map<string, ProgressRow[]>();
  for (const r of realScoredRows(rows)) {
    const bucket = modeBucket(r);
    const list = byMode.get(bucket);
    if (list) list.push(r);
    else byMode.set(bucket, [r]);
  }
  const out: ModeStats[] = [];
  for (const [modeId, list] of byMode) {
    // Per-mode BEST competes on the current ruler only; a mode with no
    // current-scale walks falls back to its newest overall (a display
    // placeholder, not a record — the first new-scale walk owns the
    // record). walks/passed/mastery stay UNscoped (pass-based).
    let best: number | null = null;
    let passed = 0;
    for (const r of list) {
      const overall = r.overall as number;
      if (onCurrentScale(r) && (best === null || overall > best)) {
        best = overall;
      }
      if (rowPassed(r)) passed++;
    }
    if (best === null) best = list[list.length - 1].overall as number;
    out.push({
      modeId,
      walks: list.length,
      best,
      last: list[list.length - 1].overall as number,
      passed,
      mastered: modeId !== LEGACY_MODE_BUCKET && masteredFrom(list),
    });
  }
  return out;
}

/**
 * True when the trainee's newest walk in `modeId` EARNED that mode's mastery
 * — the "MODE MASTERED" moment on the summary card. Idempotent against the
 * post-walk history (the recorder finalizes before the card renders):
 * - the mode is mastered now, and was NOT mastered without its newest walk
 *   (so a mode that stays mastered never re-announces, and mastery lost then
 *   re-earned announces again on the walk that re-earns it);
 * - no newer row of ANY kind was recorded after that walk (a Preview Walk
 *   run after the moment must never resurface it — the latestIsPersonalBest
 *   rule);
 * - never for the legacy bucket or an unknown/absent mode id.
 */
export function masteryJustEarned(
  rows: ReadonlyArray<ProgressRow>,
  modeId: string | null | undefined,
): boolean {
  if (!modeId || modeId === LEGACY_MODE_BUCKET) return false;
  const inMode = realScoredRows(rows).filter((r) => modeBucket(r) === modeId);
  if (inMode.length < MASTERY_PASS_COUNT) return false;
  const latest = inMode[inMode.length - 1];
  for (const r of rows) {
    if (startedMs(r) > startedMs(latest)) return false;
  }
  return masteredFrom(inMode) && !masteredFrom(inMode.slice(0, -1));
}

/** Everything the trends strip + summary-card best chip consume, in one pass. */
export interface ProgressReport {
  /** Count of real, scored walks in the history. */
  walks: number;
  /** Overall of the last ≤SERIES_MAX real walks, chronological. */
  series: number[];
  best: PersonalBest | null;
  /** Mean overall of the last ≤TREND_WINDOW real walks (see rollingAverage). */
  rollingAvg: number | null;
  /** Overall trend delta (see trendDelta for the window rule). */
  overallTrend: number | null;
  metricTrends: Record<ProgressMetricKey, number | null>;
  /** The latest real walk set a new personal best (see latestIsPersonalBest). */
  newBest: boolean;
}

export function progressReport(
  rows: ReadonlyArray<ProgressRow>,
): ProgressReport {
  const real = realScoredRows(rows);
  const overalls = real.map((r) => r.overall as number);
  return {
    walks: real.length,
    series: overalls.slice(Math.max(0, overalls.length - SERIES_MAX)),
    best: personalBest(rows),
    rollingAvg: rollingAverage(overalls),
    overallTrend: trendDelta(overalls),
    metricTrends: metricTrends(rows),
    newBest: latestIsPersonalBest(rows),
  };
}
