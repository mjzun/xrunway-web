/**
 * (X)RUNWAY — M12 repeatability + benchmark re-test (EDGE-ROADMAP Wave 1).
 *
 * Pure cross-walk CONSISTENCY math over the persisted history rows: how much
 * do a trainee's repeat walks under the SAME conditions differ from each
 * other? Improvement claims need a like-for-like series; this module supplies
 * both halves — the repeatability verdict (spread of pace/cadence/centerline
 * across matched walks) and the locked benchmark configuration whose rows are
 * the ONLY series the product ever captions as improvement.
 *
 * Dependency-free by design (no @iwsdk/core, no DOM) so the golden-vector
 * generator and vitest import the REAL code — the progress.ts /
 * walk-stats.ts pattern. Golden family "repeatability" (registered in the
 * Wave 1 VECTORS commit per the bootstrap order); Swift mirror
 * Repeatability.swift moves in step.
 *
 * Zero-alloc law: N/A by design — this module runs once per summary render /
 * history-panel open (three event sites), never per frame, so the per-report
 * allocations are legal (the roadmap's own framing: "runs at walk end with
 * zero frame cost").
 *
 * HONESTY RULES CARRIED BY THIS FILE:
 * - Verdicts are MAX-DEVIATION bounds ("agreed within X%"), never CV dressed
 *   up as a per-walk claim; display rounding always errs toward claiming
 *   LESS consistency (ceil + a 1% floor, see withinPct).
 * - No cause claims: the roadmap draft's "— fatigue?" diagnosis is DROPPED;
 *   the hedge is carried by REPEAT_DISCLOSURE ("...NOT WHY.").
 * - Walks only aggregate when mode, shape, sensor, normalization stamp,
 *   music tempo (rowMusicBpm — multi-BPM wave) AND walk duration
 *   (rowWalkSeconds — the duration wave) all match — different rulers and
 *   different conditions never blend into one spread.
 *
 * WIRING (Wave 1, landed):
 * - Normalization reader: session-grading.ts owns rowNormalization
 *   (adjudication §A — the ONE implementation); rowNormalizationFallback
 *   below is a DELEGATING alias of it, kept so the default `normOf`
 *   parameter (and its tests) stay a visible injection seam. Exactly one
 *   implementation of the absent -> "default.v1" rule exists.
 * - The benchmark series layer (isBenchmarkRow / benchmarkRows /
 *   benchmarkSeries / benchmarkHeadline + benchmarkLine/BENCHMARK_TOOLTIP)
 *   lives in THIS module, not progress.ts — the progress golden family and
 *   its Swift mirror stay frozen (adjudicated override); only progress's
 *   qualifying set (realScoredRows) and SERIES_MAX are imported (pure ->
 *   pure value import).
 * - session-recorder.ts stamps rows via benchmarkConfigAtWalkStart at
 *   beginWalk and re-derives via benchmarkAtFinalize after the summary-stamp
 *   modeId override (adjudication §G); a mid-walk shape-KIND change voids
 *   shapeKind AND benchmark through recorder.invalidateShape().
 * - Surfaces: landing summary card (verdictLine), history panel (detailLine
 *   + verdictLine under a CONSISTENCY title), XR HUD summary (compactLine),
 *   and the sp-benchmark line under the web trends strip (benchmarkLine).
 */

import { realScoredRows, SERIES_MAX, type ProgressRow } from "./progress.js";
import { rowNormalization, rowScoreScale } from "./session-grading.js";

// ---------------------------------------------------------------------------
// Row shapes (all additive-optional — legacy rows simply never qualify).
// ---------------------------------------------------------------------------

/** The stats scalars repeatability reads (subset of WalkStats — kept
 * structural so this module never imports the accumulator). All are per-walk
 * values persisted by walk-stats finalize(): meanPaceMps (round3, m/s),
 * cadenceSpm (round1, steps/min), meanAbsLateralM (round3, m). */
export interface RepeatStatsSlice {
  meanPaceMps?: number | null;
  cadenceSpm?: number | null;
  meanAbsLateralM?: number | null;
}

/** Row shape: ProgressRow + the persisted per-walk facts M12 groups by.
 * `shapeKind` and `normalization` are Wave 1 stamps (absent on older rows —
 * such rows can never anchor or join a window because they cannot prove
 * their conditions); `primarySource` has been persisted since v1. */
export interface RepeatRow extends ProgressRow {
  stats?: RepeatStatsSlice | null;
  /** Runway shape kind at walk start ("straight"|"T"|"X"|"U"); null/absent
   * when unknown or when the shape changed mid-walk. */
  shapeKind?: string | null;
  /** "head", the external camera's source label, or "preview". */
  primarySource?: string;
  /** Which normalization scored this walk (adjudication §A wire field):
   * "default.v1", "fit.v1-<capturedAt ms>", or absent/null on rows persisted
   * before FIT — absent deliberately reads as "default.v1" (identical
   * constants scored both). */
  normalization?: string | null;
  /** The delivered music/haptic/scoring tempo stamp (BPM, multi-BPM wave —
   * see SessionRecord.musicBpm). ABSENT on legacy rows — every one of them
   * ran the deleted 122 build constant, so absent reads LEGACY_MUSIC_BPM via
   * rowMusicBpm and legacy histories keep grouping unchanged; explicit null
   * (the summary carried no stamp) matches only null. */
  musicBpm?: number | null;
  /** The CONFIGURED walk length stamp (s, the duration wave — see
   * SessionRecord.walkSecondsSet; distinct from the MEASURED durationSec).
   * ABSENT reads LEGACY_WALK_SECONDS via rowWalkSeconds (caveat documented
   * there); explicit null matches only null. */
  walkSecondsSet?: number | null;
  /** Ruler stamp (the perfect=100 rescale) — absent reads "s98.v1" via
   * rowScoreScale (session-grading). Scores on different rulers are never
   * one improvement series. */
  scoreScale?: string | null;
}

// ---------------------------------------------------------------------------
// Normalization stamp reader (adjudication §A).
// ---------------------------------------------------------------------------

/** Reads the normalization token a row was scored under. */
export type NormalizationReader = (row: {
  normalization?: string | null;
}) => string;

/** The token meaning "today's default constants scored this walk" — also
 * what every legacy (pre-stamp) row reads as, because the same constants
 * scored them (adjudication §A: legacy and new default-scored rows
 * deliberately merge). */
export const DEFAULT_NORMALIZATION = "default.v1";

/**
 * §A contract — a DELEGATING alias of session-grading's rowNormalization,
 * the ONE implementation of the rule: absent / null / junk (non-string or
 * empty) -> "default.v1"; any non-empty string token (e.g.
 * "fit.v1-1719900000000") passes through verbatim. The alias survives as
 * this module's default `normOf` so the injected-reader seam (and its
 * tests) keep a stable local name; it adds no second implementation
 * (override (c), option B — pinned by the identity test).
 */
export const rowNormalizationFallback: NormalizationReader = rowNormalization;

// ---------------------------------------------------------------------------
// Music tempo stamp reader (multi-BPM wave).
// ---------------------------------------------------------------------------

/**
 * The tempo every pre-multi-BPM walk was delivered at — the BUILD CONSTANT
 * (audio-core's single 122 BPM engine) that the multi-BPM wave deleted in
 * favor of the per-row musicBpm stamp. It survives here only as the read
 * value of an ABSENT stamp: one constant delivered every legacy walk, so
 * legacy rows deliberately group as one 122 series (the §A "identical
 * constants scored both" argument, applied to tempo). NOT a selectable
 * tempo anymore — new walks stamp 62/100/125, so a legacy window closes
 * rather than silently continuing under a different beat.
 */
export const LEGACY_MUSIC_BPM = 122;

/**
 * The music tempo THIS row was delivered at (the ONE reader — the
 * rowNormalization idiom applied to tempo). Absent and junk (non-number or
 * non-finite) read LEGACY_MUSIC_BPM: the only tempo that ever ran unstamped
 * is the deleted build constant, and junk follows the §A junk rule (a stamp
 * that proves nothing reads as the legacy default). EXPLICIT null is
 * different — the recorder minted it ("the summary carried no stamp",
 * metrics-less worlds) — so it stays null and matches only null in a group
 * key (JS null === null, exactly like the shapeKind usable() convention).
 */
export function rowMusicBpm(row: { musicBpm?: unknown }): number | null {
  const v = row.musicBpm;
  if (v === null) return null;
  return typeof v === "number" && Number.isFinite(v) ? v : LEGACY_MUSIC_BPM;
}

// ---------------------------------------------------------------------------
// Walk-duration stamp reader (the duration wave, founder call 2026-07-09:
// "yes it joins" the comparison groups).
// ---------------------------------------------------------------------------

/**
 * The walk length every unstamped row is read as (seconds). The tempo law's
 * justification transfers IMPERFECTLY here — a documented caveat, not a
 * clean constant: since commit 4ac430a (2026-07-07) every mode locked 20 s,
 * so post-4ac430a legacy rows group correctly; rows persisted BEFORE that
 * walked the old per-mode lengths (40-75 s) and absent->20 would misgroup
 * them. The window is two days of pre-worksheet history and the alternative
 * (dropping every unstamped row) would orphan ALL current histories, so the
 * founder-precedent read (the default.v1 / LEGACY_MUSIC_BPM idiom) stands —
 * revisit only if a pre-4ac430a history surfaces in practice.
 */
export const LEGACY_WALK_SECONDS = 20;

/**
 * The CONFIGURED walk length THIS row ran under (the ONE reader — the
 * rowMusicBpm idiom applied to duration). Absent and junk read
 * LEGACY_WALK_SECONDS (caveat above); EXPLICIT null (the recorder minted
 * "the summary carried no stamp") stays null and matches only null in a
 * group key. NEVER derived from the measured durationSec — a positional
 * finish ends a 20 s lock at ~17-19 s and would fragment every series.
 */
export function rowWalkSeconds(row: {
  walkSecondsSet?: unknown;
}): number | null {
  const v = row.walkSecondsSet;
  if (v === null) return null;
  return typeof v === "number" && Number.isFinite(v)
    ? v
    : LEGACY_WALK_SECONDS;
}

// ---------------------------------------------------------------------------
// Benchmark configuration (the locked like-for-like series).
// ---------------------------------------------------------------------------

/**
 * BENCHMARK_MODE_ID = "beginner" — the UNGATED day-0 default mode
 * (DEFAULT_MODE = MODES[0], modes.ts:130): every install can record a
 * benchmark walk on day one, so the series starts where the trainee starts.
 * NOT "the lowest bar" — commercial's 75 is lower than beginner's 78
 * (adjudication §K correction); the pin is day-0 accessibility plus the most
 * even weight table (modes.ts:51-59). Beginner's idealPace 0.85 m/s and
 * passThreshold 78 already ride ON every row via the existing
 * modeId/passThreshold stamps, so pinning the MODE pins the roadmap's
 * "beginner weights, 0.85 m/s, same bar" with zero new numeric constants.
 */
export const BENCHMARK_MODE_ID = "beginner";

/**
 * BENCHMARK_SHAPE_KIND = "straight" — DEFAULT_SHAPE (runway-shape.ts:94),
 * the smallest room footprint (every install can produce it) and the only
 * kind with no U-route lateral-sign caveat. Length is deliberately NOT
 * pinned: fit-to-room makes exact length unattainable across rooms, and a
 * length pin would strand the series on every remap. Length drift stays
 * visible to any reader (length ~ meanPaceMps x durationSec, both persisted
 * per row); the copy claims "same mode, same shape, same bar" and no more.
 */
export const BENCHMARK_SHAPE_KIND = "straight";

/**
 * Walk-START benchmark predicate — the recorder stamps `benchmark` with this
 * at beginWalk. Synthetic (Preview Walk auto-pilot) rows are stamped false
 * outright: belt + braces on top of realScoredRows, so a preview run can
 * never enter the improvement series even if a future consumer forgets the
 * synthetic filter. The stamp is captured (not re-derived from
 * modeId+shapeKind at read time) so the DEFINITION can evolve — e.g. a
 * FIT-required benchmark later — without reinterpreting old rows: the
 * modeId/passThreshold stamp law applied forward.
 */
export function benchmarkConfigAtWalkStart(
  synthetic: boolean,
  modeId: string | null | undefined,
  shapeKind: string | null | undefined,
): boolean {
  return (
    !synthetic &&
    modeId === BENCHMARK_MODE_ID &&
    shapeKind === BENCHMARK_SHAPE_KIND
  );
}

/**
 * Finalize-side re-derivation (adjudication §G): the recorder's finalize()
 * applies this AFTER the summary-stamp modeId override, so a mode switched
 * between the beginWalk meta capture and the summary stamp cannot leave a
 * stale benchmark=true on a row whose locked mode is no longer the
 * benchmark mode. shapeKind keeps its walk-start / invalidateShape() value
 * — the shape guard already owns that channel.
 */
export function benchmarkAtFinalize(
  stampedBenchmark: boolean | undefined,
  finalModeId: string | null | undefined,
): boolean {
  return stampedBenchmark === true && finalModeId === BENCHMARK_MODE_ID;
}

// ---------------------------------------------------------------------------
// Benchmark query layer (the improvement series over persisted rows).
//
// Lives HERE, not in progress.ts: the progress golden family + its Swift
// mirror stay frozen (adjudicated override) — this module owns everything
// benchmark and imports only progress's qualifying set (realScoredRows) and
// SERIES_MAX (pure -> pure value import). ProgressReport gains NO benchmark
// field; the landing calls benchmarkHeadline(rows) beside progressReport.
// ---------------------------------------------------------------------------

/** Row shape the benchmark queries read: ProgressRow + the Wave 1 stamps
 * (all additive-optional — legacy rows simply never qualify). */
export interface BenchmarkRow extends ProgressRow {
  /** Walk-start benchmark stamp (recorder), re-derived at finalize (§G). */
  benchmark?: boolean;
  /** "head", the external camera's source label, or "preview". */
  primarySource?: string;
  /** Adjudication §A wire field — absent/junk reads "default.v1". */
  normalization?: string | null;
  /** Delivered tempo stamp (BPM, multi-BPM wave) — absent/junk reads
   * LEGACY_MUSIC_BPM via rowMusicBpm; explicit null matches only null. */
  musicBpm?: number | null;
  /** Configured walk-length stamp (s, the duration wave) — absent/junk
   * reads LEGACY_WALK_SECONDS via rowWalkSeconds; explicit null matches
   * only null. */
  walkSecondsSet?: number | null;
  /** Ruler stamp (the perfect=100 rescale) — absent reads "s98.v1" via
   * rowScoreScale (session-grading). Scores on different rulers are never
   * one improvement series. */
  scoreScale?: string | null;
}

/**
 * BENCHMARK_HEADLINE_SHOWN = 3 — the product's smallest evidence chain is
 * already 3 (MASTERY_PASS_COUNT, progress.ts), the roadmap's own headline
 * exemplar is a 3-step chain ("benchmark 71 -> 79 -> 84"), and 3 three-digit
 * scores + arrows + delta fit the trends side column without wrapping.
 */
export const BENCHMARK_HEADLINE_SHOWN = 3;

/**
 * Stamp-trusting: a row is a benchmark row iff row.benchmark === true —
 * NEVER re-derived from modeId+shapeKind at read time. The stamp captures
 * walk-time truth under the definition in force at record time; a future
 * definition change (e.g. FIT-required benchmark) must add a new stamp, not
 * reinterpret old rows — the modeId/passThreshold stamp law applied forward.
 * Consequence: a legacy beginner+straight row without the stamp is NOT a
 * benchmark row (it cannot prove the configuration held for the whole walk).
 */
export function isBenchmarkRow(row: { benchmark?: boolean }): boolean {
  return row.benchmark === true;
}

/**
 * Real scored benchmark rows in the LATEST benchmark row's group,
 * chronological.
 *
 * THE GROUP-KEY RULE (adjudication §A): group key = (normalization token via
 * rowNormalization, primarySource, music tempo via rowMusicBpm, walk length
 * via rowWalkSeconds, scoring ruler via rowScoreScale — scores on different
 * rulers are different numbers, never one improvement story). A re-FIT mints a new normalization token, a sensor
 * change flips primarySource, a tempo switch changes the delivered beat
 * (multi-BPM wave: cadence follows the music by design), and a duration
 * switch changes how much walk the stats summarize (the duration wave: a
 * 10 s sprint and a 60 s walk are different exercises) — ANY of the four
 * starts a fresh series: pre- and post-change walks are different rulers or
 * different conditions and must never be read as one improvement story (the
 * tooltip discloses the restart). Synthetic and unscored rows are dropped by
 * realScoredRows before the stamp is even read.
 */
export function benchmarkRows<T extends BenchmarkRow>(
  rows: ReadonlyArray<T>,
): T[] {
  const bench = realScoredRows(rows).filter(isBenchmarkRow);
  if (bench.length === 0) return bench;
  const ref = bench[bench.length - 1];
  const norm = rowNormalization(ref);
  const source = usable(ref.primarySource);
  const bpm = rowMusicBpm(ref);
  const secs = rowWalkSeconds(ref);
  const scale = rowScoreScale(ref);
  return bench.filter(
    (r) =>
      rowNormalization(r) === norm &&
      usable(r.primarySource) === source &&
      rowMusicBpm(r) === bpm &&
      rowWalkSeconds(r) === secs &&
      rowScoreScale(r) === scale,
  );
}

/** Overalls of the last <= max current-group benchmark rows, chronological
 * (sparkline-style). Cap = progress's SERIES_MAX so the product keeps ONE
 * definition of a displayable series length. */
export function benchmarkSeries(
  rows: ReadonlyArray<BenchmarkRow>,
  max: number = SERIES_MAX,
): number[] {
  const group = benchmarkRows(rows);
  const out: number[] = [];
  for (let i = Math.max(0, group.length - max); i < group.length; i++) {
    out.push(group[i].overall as number);
  }
  return out;
}

export interface BenchmarkHeadline {
  /** Benchmark rows in the current (normalization, sensor) group. */
  walks: number;
  /** Last <= BENCHMARK_HEADLINE_SHOWN overalls, Math.round-ed for display. */
  shown: number[];
  /** shown[last] - shown[0] — computed from the ROUNDED shown values so the
   * claimed delta is self-consistent with the displayed scores. */
  delta: number;
  /** startedAt (epoch ms) of shown[0]'s row (for "over N weeks" copy). */
  firstShownAt: number;
  /** startedAt (epoch ms) of the newest group row. */
  lastAt: number;
}

/** Junk startedAt sorts/reports as 0, never throws (the progress.ts law). */
function startedMsOf(row: ProgressRow): number {
  const ms = Number(row.startedAt);
  return Number.isFinite(ms) ? ms : 0;
}

/** Null when fewer than 2 rows sit in the current benchmark group — one
 * benchmark walk is a baseline, not a trend (the landing's "one real walk
 * can't trend" precedent). */
export function benchmarkHeadline(
  rows: ReadonlyArray<BenchmarkRow>,
): BenchmarkHeadline | null {
  const group = benchmarkRows(rows);
  if (group.length < 2) return null;
  const shownRows = group.slice(
    Math.max(0, group.length - BENCHMARK_HEADLINE_SHOWN),
  );
  const shown = shownRows.map((r) => Math.round(r.overall as number));
  return {
    walks: group.length,
    shown,
    delta: shown[shown.length - 1] - shown[0],
    firstShownAt: startedMsOf(shownRows[0]),
    lastAt: startedMsOf(group[group.length - 1]),
  };
}

/**
 * The benchmark headline line (web trends strip; ASCII by construction):
 * "BENCHMARK 71 -> 79 -> 84 (+13)" — delta suffix "(+13)" / "(-4)" /
 * "(EVEN)" for zero (§6 copy). The improvement CAPTION itself lives in
 * BENCHMARK_TOOLTIP, never in this line.
 */
export function benchmarkLine(h: BenchmarkHeadline): string {
  const d = h.delta;
  const suffix = d === 0 ? "(EVEN)" : d > 0 ? `(+${d})` : `(${d})`;
  return `BENCHMARK ${h.shown.join(" -> ")} ${suffix}`;
}

/** The headline LAW, verbatim (tooltip on the benchmark line) — the ONLY
 * user-facing string in the product allowed the word "improvement": every
 * other series is spread or activity, never progress dressed as
 * like-for-like. */
export const BENCHMARK_TOOLTIP =
  "Beginner mode on the straight runway, graded against the same bar every time. Benchmark walks are the only series compared like-for-like, so only these deltas are read as improvement. The series restarts if the scoring sensor, calibration, music tempo, walk duration or scoring scale changes.";

// ---------------------------------------------------------------------------
// Repeatability constants (each with its derivation).
// ---------------------------------------------------------------------------

/** Minimum matched walks before ANY consistency claim — settled law (both
 * EDGE-ROADMAP adversaries KEEP the ">= 3 walks under the SAME mode and
 * runway shape" guard). Two walks have one gap; three is the smallest set
 * where "spread" is a property of the set rather than of one pair. */
export const REPEAT_MIN_WALKS = 3;

/** Window of matched walks the verdict reads. = TREND_WINDOW = MASTERY_WINDOW
 * (progress.ts:55/221) — the product has ONE definition of "recent"; a
 * second recency constant would let two surfaces disagree about which walks
 * are recent. */
export const REPEAT_WINDOW = 5;

/**
 * REPEAT_OUTLIER_PCT = 10 (% deviation from the window's pace mean before a
 * walk can be called out).
 *
 * Anchored to the product's own pace curve (metrics.ts:674):
 *   pace score = 100 - |meanPace - idealPace| * 70   [pts per m/s]
 * A deviation worth a named callout should move the INTEGER score card by an
 * unmistakable margin: 6 points (= 2x the ~3-point move a 5% pace deviation
 * produces: 0.05 * 0.85 m/s * 70 = 2.98 pts).
 *   outlierPct = 6 pts / 70 pts-per-mps / 0.85 mps = 0.1008 -> 10%
 * Cross-checks: 10% of the beginner ideal = 0.085 m/s — two orders above the
 * 0.0005 m/s round3 persistence quantization, and a third of the live
 * coach's interrupt bar (PACE_DELTA_CUE_MPS = 0.25 m/s, coach-live.ts:173,
 * = 29.4% of 0.85): a retrospective note fires easier than a live
 * interruption, as it should.
 */
export const REPEAT_OUTLIER_PCT = 10;

/**
 * REPEAT_OUTLIER_DOMINANCE = 2 (largest deviation must be >= 2x the second
 * largest). The callout names ONE walk, so one deviation must DOMINATE: in a
 * uniformly spread window deviations are comparable (n=3 uniform spacing
 * {-d, 0, +d} gives m1/m2 = 1; larger n similar), so no walk is scapegoated;
 * a genuine single outlier against a tight cluster gives ratios far above 2.
 * Two is the smallest integer factor that cleanly separates the regimes.
 */
export const REPEAT_OUTLIER_DOMINANCE = 2;

// ---------------------------------------------------------------------------
// Report shapes.
// ---------------------------------------------------------------------------

/** Spread of one relative channel (pace m/s or cadence spm) over the window.
 * Quantization note (documented once for both channels): CVs are computed
 * from round3/round1 persisted values — worst-case contribution ~0.06%
 * (round3 pace: 0.0005/0.85 = 0.059%; round1 cadence: 0.05/~100 = 0.05%),
 * two orders under the 1% display floor. Non-issue. */
export interface RepeatChannel {
  /** Rows that voted (finite values > 0). */
  n: number;
  /** Mean, channel unit (m/s or spm). */
  mean: number;
  /**
   * SAMPLE standard deviation (Bessel, n-1), channel unit:
   *   s = sqrt( (1/(n-1)) * SUM_i (v_i - mean)^2 )
   * Population-vs-sample: at the guard minimum n = 3 the population SD
   * understates spread by sqrt((n-1)/n) = sqrt(2/3) ~ 0.816 — an ~18%
   * understatement (at n = 5, sqrt(4/5) ~ 0.894, still 10.6%). A CONSISTENCY
   * claim must not overstate agreement, so the conservative (larger)
   * estimator wins. MAD rejected for v1: at n = 3 it collapses to the middle
   * of three deviations — discarding the very outlier the verdict exists to
   * name — and feeds no familiar "within X%" phrasing; robustness is instead
   * delivered structurally by the outlier rule, which EXCLUDES the outlier
   * and reports the remaining walks' agreement (what a trimmed estimator
   * would do, but legibly).
   */
  sdSample: number;
  /** 100 * sdSample / mean. */
  cvPct: number;
  /**
   * 100 * max_i |v_i - mean| / mean — the WORST-case relative deviation from
   * the group mean, i.e. "every walk was within X% of the group's own
   * average". This (not CV) is the honest mapping of the verdict phrasing:
   * CV would be a weaker claim dressed in the same words (a 4% CV admits
   * individual walks ~8%+ out at n=5).
   */
  agreementPct: number;
}

/** The named pace outlier (§ outlier rule at REPEAT_OUTLIER_PCT/_DOMINANCE). */
export interface RepeatOutlier {
  /** 1-based, chronological within the window. */
  index: number;
  /** Window size (== report.walks). */
  count: number;
  /** SIGNED %, vs the mean of the OTHER walks; + = faster. */
  deltaPct: number;
  /** Max deviation among the others vs THEIR OWN mean, %. */
  othersAgreementPct: number;
}

export interface RepeatabilityReport {
  /** Qualifying matched rows in the window (>= REPEAT_MIN_WALKS). */
  walks: number;
  /** The matched conditions (named in the copy, never implied). */
  modeId: string;
  shapeKind: string;
  /** The window's shared primarySource. */
  source: string;
  pace: RepeatChannel | null;
  cadence: RepeatChannel | null;
  /** Sample SD of meanAbsLateralM, meters — ABSOLUTE, never CV: the mean
   * legitimately approaches 0 for a good walker and CV divides by it (a 1 cm
   * spread on a 2 cm mean would read CV 50% while the same 1 cm on a 10 cm
   * mean reads 10% — punishing precision). Centimeters are the product's
   * native lateral unit (the coach's directional cues), so the honest
   * dispersion is s(meanAbsLateralM) in m, shown in whole cm. */
  lateralSpreadM: number | null;
  /** Pace channel only: one sentence can honestly carry one channel, and
   * pace is the only channel with a mode-anchored meaning (idealPace).
   * Cadence spread still reports via its CV in detailLine. */
  outlier: RepeatOutlier | null;
  /** Landing summary-card sentence (ASCII, XR-safe). */
  verdictLine: string;
  /** XR panel one-liner (ASCII). */
  compactLine: string;
  /** History-panel numbers row (ASCII). */
  detailLine: string;
}

/** The fixed hedge line (tooltip/title on every repeatability surface) —
 * carries the honesty disclosures the verdict sentence cannot: what was
 * matched, and that spread is described, never explained. */
export const REPEAT_DISCLOSURE =
  "MEASURED SPREAD ACROSS REPEAT WALKS UNDER THE SAME MODE, SHAPE, SENSOR, TEMPO AND DURATION. IT SHOWS HOW MUCH YOUR WALKS DIFFER, NOT WHY.";

// ---------------------------------------------------------------------------
// Display helpers (integer-only interpolation — keeps the Swift mirror
// trivial; jsRound in Swift matches Math.round here).
// ---------------------------------------------------------------------------

/**
 * Display rule for "within X%" claims: max(1, ceil(v)). A within-claim is an
 * UPPER BOUND, so rounding 4.4 down to "within 4%" would be FALSE — ceil is
 * the honest direction. The floor of 1: "within 0%" would claim identity
 * beyond what the persisted quantization supports (round3 pace worst case
 * 0.059% of the beginner ideal, round1 cadence 0.05% of ~100 spm — both
 * under half a percent), so 1% is the smallest supportable claim.
 */
export function withinPct(v: number): number {
  return Math.max(1, Math.ceil(v));
}

/** CV display: below 1% the persisted quantization owns too much of the
 * number to print it — "UNDER 1%" claims less, honestly. */
function cvText(v: number): string {
  return v < 1 ? "UNDER 1%" : `${Math.round(v)}%`;
}

/** Lateral SD display in whole cm; below 1 cm prints "UNDER 1 CM" (round3
 * meters persist at 1 mm steps — tenths of a cm would be false precision). */
function cmText(m: number): string {
  const cm = Math.round(m * 100);
  return cm < 1 ? "UNDER 1 CM" : `${cm} CM`;
}

// ---------------------------------------------------------------------------
// Internal math.
// ---------------------------------------------------------------------------

/** Non-empty string or null — the "usable stamp" test shared by every group
 * key part (mirrors progress.ts modeBucket's junk test). */
function usable(v: string | null | undefined): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function meanOf(values: ReadonlyArray<number>): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Bessel sample SD (see RepeatChannel.sdSample for the derivation). */
function sampleSd(values: ReadonlyArray<number>, mean: number): number {
  let sum = 0;
  for (const v of values) {
    const d = v - mean;
    sum += d * d;
  }
  return Math.sqrt(sum / (values.length - 1));
}

/** Build one relative channel (caller guarantees values.length >= 1 and
 * every value > 0, so mean > 0 and the divisions are safe). */
function channelOf(values: ReadonlyArray<number>): RepeatChannel {
  const mean = meanOf(values);
  const sd = sampleSd(values, mean);
  let maxDev = 0;
  for (const v of values) {
    const d = v < mean ? mean - v : v - mean;
    if (d > maxDev) maxDev = d;
  }
  return {
    n: values.length,
    mean,
    sdSample: sd,
    cvPct: (100 * sd) / mean,
    agreementPct: (100 * maxDev) / mean,
  };
}

/**
 * The pace outlier rule. Caller guarantees `values` maps 1:1 to the window's
 * walks (every row voted pace) so the 1-based index is unambiguous.
 * Deviations d_i = |v_i - mean|; with m1 >= m2 the two largest, an outlier
 * at k requires BOTH 100*m1/mean >= REPEAT_OUTLIER_PCT and
 * m1 >= REPEAT_OUTLIER_DOMINANCE * m2. A tie for the largest deviation can
 * never pass dominance (m1 == m2), so "which of the tied walks" never needs
 * an answer.
 */
function paceOutlier(values: ReadonlyArray<number>): RepeatOutlier | null {
  const n = values.length;
  const mean = meanOf(values);
  let m1 = -1;
  let m2 = -1;
  let k = -1;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    const d = v < mean ? mean - v : v - mean;
    if (d > m1) {
      m2 = m1;
      m1 = d;
      k = i;
    } else if (d > m2) {
      m2 = d;
    }
  }
  if ((100 * m1) / mean < REPEAT_OUTLIER_PCT) return null;
  if (m1 < REPEAT_OUTLIER_DOMINANCE * m2) return null;

  let sumOthers = 0;
  for (let i = 0; i < n; i++) if (i !== k) sumOthers += values[i];
  const meanOthers = sumOthers / (n - 1);
  let maxOtherDev = 0;
  for (let i = 0; i < n; i++) {
    if (i === k) continue;
    const d =
      values[i] < meanOthers ? meanOthers - values[i] : values[i] - meanOthers;
    if (d > maxOtherDev) maxOtherDev = d;
  }
  return {
    index: k + 1,
    count: n,
    deltaPct: (100 * (values[k] - meanOthers)) / meanOthers,
    othersAgreementPct: (100 * maxOtherDev) / meanOthers,
  };
}

// ---------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------

/**
 * Cross-walk consistency over the persisted history rows.
 *
 * THE RULE (pinned, test-enforced):
 * 1. Qualifying set = realScoredRows (synthetic Preview Walk rows and
 *    unscored rows can never enter a consistency claim). Trainee scoping is
 *    the CALLER's job via rowMatchesTrainee, exactly as progress.ts
 *    documents.
 * 2. Reference row = the NEWEST real scored walk — the summary card
 *    describes the walk just finished in its own context. Null when it lacks
 *    a usable modeId (junk/empty — mirrors the LEGACY_MODE_BUCKET mastery
 *    denial), a usable shapeKind (un-stamped legacy rows cannot prove which
 *    shape they walked), or a usable primarySource.
 * 3. Group key = (modeId, shapeKind, primarySource, normalization token via
 *    `normOf`, music tempo via rowMusicBpm, walk length via rowWalkSeconds).
 *    The normalization rule (cross-cutting Wave 1 law): walks scored under
 *    different normalization stamps never aggregate — a re-FIT starts a
 *    fresh window. primarySource is in the key for the same reason:
 *    head-derived and camera-derived stats are different rulers over the
 *    same walker. Tempo (multi-BPM wave): cadence follows the delivered
 *    beat by design, so a deliberate tempo switch is a CONDITION change,
 *    not inconsistency — mixing 100 and 125 BPM walks would manufacture a
 *    cadence spread the trainee never walked. Duration (the duration wave):
 *    a 10 s and a 60 s walk summarize different amounts of walking — their
 *    stats are not one spread. The roadmap's same-mode/same-shape guard is
 *    a floor, and stricter is legal.
 *    NOTE (perfect=100 rescale): the repeat WINDOW key is deliberately NOT
 *    scale-scoped — its channels (pace m/s, cadence spm, lateral m) are
 *    PHYSICAL measurements, identical on either ruler; only raw-overall
 *    series (the benchmark) split on rowScoreScale.
 * 4. Window = the last `window` rows of the qualifying set whose key equals
 *    the reference key — group-scoped recency across the whole history, NOT
 *    consecutive-rows-only: repeatability is a claim about skill under
 *    fixed conditions; the copy names the conditions ("MATCHED WALKS") and
 *    never claims "this session". Fewer than REPEAT_MIN_WALKS -> null.
 * 5. A row votes a relative channel (pace/cadence) only with a finite value
 *    > 0; each channel needs >= REPEAT_MIN_WALKS voters else null; BOTH
 *    null -> report null (no relative channel, no verdict). Lateral: sample
 *    SD over finite non-negative meanAbsLateralM values, >= REPEAT_MIN_WALKS
 *    voters else null. This is what keeps mixed-measurement histories
 *    honest: a camera-image-scored row (all three stats null) simply never
 *    votes.
 * 6. Outlier: pace only, and only when EVERY window row voted pace so the
 *    1-based indices map to walks (see paceOutlier).
 */
export function repeatabilityReport(
  rows: ReadonlyArray<RepeatRow>,
  window: number = REPEAT_WINDOW,
  normOf: NormalizationReader = rowNormalizationFallback,
): RepeatabilityReport | null {
  const real = realScoredRows(rows);
  if (real.length === 0) return null;

  const ref = real[real.length - 1];
  const modeId = usable(ref.modeId);
  const shapeKind = usable(ref.shapeKind);
  const source = usable(ref.primarySource);
  if (modeId === null || shapeKind === null || source === null) return null;
  const norm = normOf(ref);
  const bpm = rowMusicBpm(ref);
  const secs = rowWalkSeconds(ref);

  // Group-scoped recency: newest-first scan, then flip to chronological.
  const win: RepeatRow[] = [];
  for (let i = real.length - 1; i >= 0 && win.length < window; i--) {
    const r = real[i];
    if (
      usable(r.modeId) === modeId &&
      usable(r.shapeKind) === shapeKind &&
      usable(r.primarySource) === source &&
      normOf(r) === norm &&
      rowMusicBpm(r) === bpm &&
      rowWalkSeconds(r) === secs
    ) {
      win.push(r);
    }
  }
  win.reverse();
  if (win.length < REPEAT_MIN_WALKS) return null;

  const paceVals: number[] = [];
  const cadVals: number[] = [];
  const latVals: number[] = [];
  for (const r of win) {
    const s = r.stats;
    const p = s ? s.meanPaceMps : null;
    if (typeof p === "number" && Number.isFinite(p) && p > 0) {
      paceVals.push(p);
    }
    const c = s ? s.cadenceSpm : null;
    if (typeof c === "number" && Number.isFinite(c) && c > 0) {
      cadVals.push(c);
    }
    const l = s ? s.meanAbsLateralM : null;
    if (typeof l === "number" && Number.isFinite(l) && l >= 0) {
      latVals.push(l);
    }
  }

  const pace =
    paceVals.length >= REPEAT_MIN_WALKS ? channelOf(paceVals) : null;
  const cadence =
    cadVals.length >= REPEAT_MIN_WALKS ? channelOf(cadVals) : null;
  if (pace === null && cadence === null) return null;
  const lateralSpreadM =
    latVals.length >= REPEAT_MIN_WALKS
      ? sampleSd(latVals, meanOf(latVals))
      : null;
  const outlier =
    pace !== null && pace.n === win.length ? paceOutlier(paceVals) : null;

  const n = win.length;
  return {
    walks: n,
    modeId,
    shapeKind,
    source,
    pace,
    cadence,
    lateralSpreadM,
    outlier,
    verdictLine: buildVerdictLine(n, pace, cadence, outlier),
    compactLine: buildCompactLine(n, pace, cadence, outlier),
    detailLine: buildDetailLine(pace, cadence, lateralSpreadM),
  };
}

// ---------------------------------------------------------------------------
// Copy builders (golden-locked prose — adjudication §K "MATCHED WALKS").
// Every branch is exercised by the golden family; strings are ASCII only
// (they reach the XR panel via compactLine).
// ---------------------------------------------------------------------------

function buildVerdictLine(
  n: number,
  pace: RepeatChannel | null,
  cadence: RepeatChannel | null,
  outlier: RepeatOutlier | null,
): string {
  if (outlier !== null) {
    const dir = outlier.deltaPct > 0 ? "FASTER" : "SLOWER";
    const d = Math.round(Math.abs(outlier.deltaPct));
    const aPrime = withinPct(outlier.othersAgreementPct);
    // Newest-walk outlier reads as "this walk broke the streak"; an older
    // outlier reads as a named exception inside an otherwise tight window.
    if (outlier.index === n) {
      return `WALKS 1-${n - 1} AGREED WITHIN ${aPrime}% ON PACE; WALK ${n} WAS ${d}% ${dir}.`;
    }
    return `WALK ${outlier.index} WAS ${d}% ${dir} ON PACE THAN THE OTHER ${n - 1}, WHICH AGREED WITHIN ${aPrime}%.`;
  }
  if (pace !== null && cadence !== null) {
    return `LAST ${n} MATCHED WALKS AGREED WITHIN ${withinPct(pace.agreementPct)}% ON PACE AND ${withinPct(cadence.agreementPct)}% ON CADENCE.`;
  }
  if (pace !== null) {
    return `LAST ${n} MATCHED WALKS AGREED WITHIN ${withinPct(pace.agreementPct)}% ON PACE.`;
  }
  // channelOf callers guarantee pace or cadence non-null here.
  const c = cadence as RepeatChannel;
  return `LAST ${n} MATCHED WALKS AGREED WITHIN ${withinPct(c.agreementPct)}% ON CADENCE.`;
}

function buildCompactLine(
  n: number,
  pace: RepeatChannel | null,
  cadence: RepeatChannel | null,
  outlier: RepeatOutlier | null,
): string {
  let base: string;
  if (pace !== null && cadence !== null) {
    base = `${n} MATCHED WALKS: PACE SPREAD ${withinPct(pace.agreementPct)}%, CADENCE ${withinPct(cadence.agreementPct)}%`;
  } else if (pace !== null) {
    base = `${n} MATCHED WALKS: PACE SPREAD ${withinPct(pace.agreementPct)}%`;
  } else {
    const c = cadence as RepeatChannel;
    base = `${n} MATCHED WALKS: CADENCE SPREAD ${withinPct(c.agreementPct)}%`;
  }
  if (outlier !== null) {
    const d = Math.round(Math.abs(outlier.deltaPct));
    base += ` - WALK ${outlier.index} ${d}% ${outlier.deltaPct > 0 ? "FAST" : "SLOW"}`;
  }
  return base;
}

function buildDetailLine(
  pace: RepeatChannel | null,
  cadence: RepeatChannel | null,
  lateralSpreadM: number | null,
): string {
  const parts: string[] = [];
  if (pace !== null) parts.push(`PACE CV ${cvText(pace.cvPct)}`);
  if (cadence !== null) parts.push(`CADENCE CV ${cvText(cadence.cvPct)}`);
  if (lateralSpreadM !== null) {
    // The (HEAD PATH) suffix labels ONLY the centerline quantity — the
    // lateral channel is head-derived (walk-stats.ts:27-33); pace/cadence
    // carry no such caveat, so the suffix rides with this segment alone.
    parts.push(`CENTER SD ${cmText(lateralSpreadM)} (HEAD PATH)`);
  }
  return parts.join(" - ");
}
