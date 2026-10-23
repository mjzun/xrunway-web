/**
 * (X)RUNWAY — shared coach layer (POLISH-AUDIT #9/#16 + the copy halves of
 * #8/#22).
 *
 * ONE source for the post-walk teaching copy on BOTH surfaces: the desktop
 * summary card (landing.ts) and the in-headset summary panel (hud.ts). Hoists
 * what used to live desktop-only in landing.ts — the metric explainers, the
 * per-metric corrective cues, the PASS / NEEDS WORK verdict against the active
 * mode's own pass bar, and the top-3 below-line selection ranked by
 * weight x shortfall — and upgrades each cue from a generic band hint to a
 * DIRECTIONAL, quantified one when the walk's real measurements
 * (ShowSummary.stats, see walk-stats.ts) support the claim.
 *
 * Honesty rules (pinned — the copy must never claim what wasn't measured):
 * - M5-M7 (presence/confidence/presentation) are COMPOSITE reads — pure
 *   re-weightings of the four measured channels (metrics.ts derives them
 *   identically in all three source paths; confidence adds a small
 *   time-on-runway credit that grows over the locked walk length). Nothing
 *   observes eyeline,
 *   hesitation, or the turn, so their explainers say "composite" outright
 *   and their cues point at the measured channels to improve (#10).
 * - PACE is directional whenever paceDeltaMps is known: too fast says slow
 *   down, too slow says pick it up, both citing the real m/s numbers.
 * - POSTURE direction comes from the SIGN of postureDriftM (+ = rode above
 *   the walk-start baseline, - = sank below it), quantified in cm.
 * - FOOTWORK never claims left/right unless the route was ONE-WAY (a U walk)
 *   AND the side was consistent (|meanLateralM| / meanAbsLateralM >= 0.6).
 *   On out-and-back routes the lateral sign FLIPS on the return leg, so a
 *   signed mean can cancel or lie — those walks get magnitude-only copy.
 * - RHYTHM may cite the real step count + cadence when steps were detected.
 * - A null stats object or a null channel falls back to the generic band cue.
 *
 * Dependency-free by design (type-only imports; no @iwsdk/core, no DOM) so it
 * loads in vitest — the walk-stats.ts / stage-budget.ts pattern. Every string
 * in this module is ASCII punctuation ONLY: this copy reaches the XR panel,
 * whose font has no em-dash, middle-dot, curly-quote or arrow glyphs.
 */

import type { TrainingMode } from "./modes.js";
import type { MetricSnapshot } from "./show.js";
import type { WalkStats } from "./walk-stats.js";

export type MetricKey = keyof MetricSnapshot;

/**
 * Metric order M1..M7 — mirrors metrics.ts METRICS (which cannot be imported
 * here: metrics.ts pulls @iwsdk/core at runtime). Keep the two in sync; the
 * order is the tiebreak when two below-line metrics cost the same.
 */
const METRIC_ORDER: ReadonlyArray<MetricKey> = [
  "posture",
  "pace",
  "rhythm",
  "footPlacement",
  "presence",
  "confidence",
  "presentation",
];

/** Plain-language explainer per metric (summary-card tooltips). M5-M7 are
 * COMPOSITE reads — each explainer states its true derivation (verified
 * against metrics.ts, where all three source paths blend them identically)
 * and says plainly that nothing measures it separately (#10). */
export const METRIC_EXPLAIN: Record<MetricKey, string> = {
  posture: "How square and lifted your frame stays through the walk.",
  pace: "How close your speed is to this mode's ideal catwalk tempo.",
  rhythm: "How even and consistent your step timing is.",
  footPlacement:
    "How closely your head holds the runway centerline (a headset reads your head, not your feet).",
  presence:
    "Composite read: your posture, rhythm and pace weighted together, posture counting most. It is not separately measured - eyeline is not tracked.",
  confidence:
    "Composite read: pace, posture and rhythm weighted evenly with a lighter footwork share, plus a small settle-in credit that grows over the walk. It is not separately measured.",
  presentation:
    "Composite read: all four measured channels blended, posture and rhythm weighted heaviest. It is not separately measured - the turn is not analyzed.",
};

/**
 * Generic corrective cue per metric — the band-based fallback used when the
 * walk's measurements can't back a directional claim (stats null, channel
 * null, or a composite metric nothing measures directly). The M5-M7 cues
 * never coach qualities nothing observes (eyeline, hesitation, the turn) —
 * they point at the measured channels each composite is built from (#10).
 */
export const METRIC_COACH: Record<MetricKey, string> = {
  posture: "Lift through the crown - shoulders back, chin level, ribs over hips.",
  pace: "Settle into one tempo - don't rush the start or drift at the mark.",
  rhythm: "Lock a steady cadence - equal time on each step, like a metronome.",
  footPlacement: "Hold your line - keep your head centered over the runway.",
  presence:
    "Presence is scored from your posture, rhythm and pace - lift the frame and steady the tempo and it follows.",
  confidence:
    "Confidence is scored from your measured channels - even out pace, posture and rhythm and this read climbs with them.",
  presentation:
    "Presentation rolls up all four measured channels - posture and rhythm move it most, so start there.",
};

/** Every-metric-cleared line (shown when no note qualifies). */
export const CLEAN_WALK_CUE =
  "Clean walk - every metric cleared the line. Step up a mode.";

/**
 * Minimum |meanLateralM| / meanAbsLateralM for the footwork copy to name a
 * side. Below this the trainee weaved across the line more than they held one
 * side, and "you drifted right" would be a guess.
 */
export const LATERAL_SIDE_CONSISTENCY = 0.6;

/** One coach's note: the metric it targets + its (possibly directional) cue. */
export interface CoachNote {
  key: MetricKey;
  /** Corrective copy — directional + quantified when the stats support it. */
  cue: string;
  /** True when the cue cites this walk's real measurements. */
  directional: boolean;
}

/** The verdict + notes for one finished walk — plain data, no DOM. */
export interface CoachReport {
  /** Rounded overall score (the number both summary UIs display). */
  overall: number;
  /** The active mode's pass bar the verdict was judged against. */
  passThreshold: number;
  passed: boolean;
  verdict: "PASS" | "NEEDS WORK";
  /**
   * Up to 3 below-line metrics, most costly first (weight x shortfall, ties
   * keep M1..M7 order). Empty = every metric cleared the line.
   */
  notes: CoachNote[];
}

/** The slice of a TrainingMode the coach needs (structurally satisfied by it). */
export type CoachModeParams = Pick<TrainingMode, "passThreshold" | "weights">;

export interface CoachContext {
  /** Final 0-100 scores for the walk. */
  scores: MetricSnapshot;
  /** Overall 0-100 (unrounded is fine — the report rounds like the UIs do). */
  overall: number;
  mode: CoachModeParams;
  /** Real measurements for the walk, or null when none were captured. */
  stats: WalkStats | null;
  /**
   * True when the walked route is one-way (the U): the lateral sign is the
   * trainee's right for the WHOLE walk, so left/right copy is trustworthy.
   * Out-and-back routes (straight/T/X) must pass false — see the header.
   */
  oneWayRoute: boolean;
}

// ---------------------------------------------------------------------------
// Directional cue builders — each returns null when the stats can't honestly
// back the claim, and the caller falls back to the generic band cue.
// ---------------------------------------------------------------------------

function paceCue(stats: WalkStats): string | null {
  if (stats.paceDeltaMps === null || stats.meanPaceMps === null) return null;
  if (stats.paceDeltaMps === 0) return null; // dead-on: no direction to claim
  const mean = stats.meanPaceMps.toFixed(2);
  const ideal = stats.idealPaceMps.toFixed(2);
  // Sub-display-resolution delta (< 0.005 m/s): the two numbers RENDER
  // identically, so a directional command would contradict its own citation
  // ("0.85 vs 0.85 - slow down"). Fall back to the generic cue — mirroring
  // the cm < 1 guards in postureCue/footworkCue.
  if (mean === ideal) return null;
  return stats.paceDeltaMps > 0
    ? `You averaged ${mean} m/s against a ${ideal} m/s target - slow every stride down.`
    : `You averaged ${mean} m/s against a ${ideal} m/s target - pick every stride up.`;
}

function postureCue(stats: WalkStats): string | null {
  if (stats.postureDriftM === null) return null;
  const cm = Math.round(Math.abs(stats.postureDriftM) * 100);
  if (cm < 1) return null; // sub-centimeter: not worth a directional claim
  return stats.postureDriftM > 0
    ? `You rode ${cm} cm above your start height - settle down, no bounce.`
    : `You sank ${cm} cm below your start height - lift through the crown.`;
}

/**
 * Directional footwork templates — exported so the Solo copy-variant table
 * (coach-copy.ts) builds its WEB column from the REAL builders (placeholder
 * args) instead of hand-copied strings. footworkCue below feeds them the
 * live numbers, so the template and the shipped copy cannot fork.
 */
export function footworkDriftSideCue(
  cm: number | string,
  side: string,
): string {
  return `You drifted ${cm} cm ${side} of the centerline - pull it back to center.`;
}

export function footworkOffLineCue(cm: number | string): string {
  return `You averaged ${cm} cm off the centerline - tighten your line.`;
}

function footworkCue(stats: WalkStats, oneWayRoute: boolean): string | null {
  if (stats.meanAbsLateralM === null || stats.meanLateralM === null) {
    return null;
  }
  const cm = Math.round(stats.meanAbsLateralM * 100);
  if (cm < 1) return null;
  // Left/right ONLY on a one-way route with a consistent side — the signed
  // mean flips meaning on the return leg of an out-and-back walk.
  const sideIsHonest =
    oneWayRoute &&
    stats.meanAbsLateralM > 0 &&
    Math.abs(stats.meanLateralM) / stats.meanAbsLateralM >=
      LATERAL_SIDE_CONSISTENCY;
  if (sideIsHonest) {
    const side = stats.meanLateralM > 0 ? "right" : "left";
    return footworkDriftSideCue(cm, side);
  }
  return footworkOffLineCue(cm);
}

function rhythmCue(stats: WalkStats): string | null {
  if (stats.cadenceSpm === null || stats.steps <= 0) return null;
  return `${stats.steps} steps at ${Math.round(stats.cadenceSpm)} per minute - keep the interval even.`;
}

/** The best honest cue for one metric — directional when backed, else generic. */
function cueFor(
  key: MetricKey,
  stats: WalkStats | null,
  oneWayRoute: boolean,
): CoachNote {
  let cue: string | null = null;
  if (stats) {
    if (key === "pace") cue = paceCue(stats);
    else if (key === "posture") cue = postureCue(stats);
    else if (key === "footPlacement") cue = footworkCue(stats, oneWayRoute);
    else if (key === "rhythm") cue = rhythmCue(stats);
    // presence/confidence/presentation are composites — nothing measures them
    // directly, so they always take the generic band cue.
  }
  if (cue !== null) return { key, cue, directional: true };
  return { key, cue: METRIC_COACH[key], directional: false };
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

/**
 * Verdict + coach's notes for one finished walk. Pure data — the surfaces own
 * all rendering. Matches the landing's original logic exactly: scores round
 * before comparing, the verdict is rounded-overall vs the mode's bar, and the
 * notes are the below-line metrics ranked by weight x shortfall, capped at 3.
 */
export function buildCoachReport(ctx: CoachContext): CoachReport {
  const thr = ctx.mode.passThreshold;
  const overall = Math.round(ctx.overall);
  const passed = overall >= thr;
  const notes = METRIC_ORDER.map((key) => {
    const v = Math.round(ctx.scores[key]);
    return {
      key,
      below: v < thr,
      impact: (ctx.mode.weights[key] ?? 0) * Math.max(0, thr - v),
    };
  })
    .filter((x) => x.below)
    .sort((a, b) => b.impact - a.impact) // stable: ties keep M1..M7 order
    .slice(0, 3)
    .map((x) => cueFor(x.key, ctx.stats, ctx.oneWayRoute));
  return {
    overall,
    passThreshold: thr,
    passed,
    verdict: passed ? "PASS" : "NEEDS WORK",
    notes,
  };
}

// ---------------------------------------------------------------------------
// Shared one-line labels (both surfaces; ASCII-only for the XR panel).
// ---------------------------------------------------------------------------

/** XR summary verdict line — the verdict WITH the mode's bar, e.g. "PASS - BAR 78". */
export function verdictLine(report: CoachReport): string {
  return `${report.verdict} - BAR ${report.passThreshold}`;
}

/** Pre-walk pass-bar chip, e.g. "PASS AT 78". */
export function passBarLabel(passThreshold: number): string {
  return `PASS AT ${passThreshold}`;
}

/** Honest target-pace chip from the mode's ideal, e.g. "TARGET 0.85 M/S" —
 * replaces the retired fabricated stepsLabel (#22). */
export function targetPaceLabel(idealPaceMps: number): string {
  return `TARGET ${idealPaceMps.toFixed(2)} M/S`;
}

/**
 * Duration + REAL steps/cadence summary line (#22), e.g.
 * "58S ON THE RUNWAY - 58 STEPS - 96/MIN". Steps/cadence are omitted when the
 * walk produced none (stats null or zero detected steps).
 *
 * `sep` is the field separator: the ASCII " - " default is a PANEL
 * constraint (the XR font has no middle-dot glyph — hud.ts stays on it); the
 * DOM landing passes " · " to keep its own middle-dot typography.
 */
export function walkStatLine(
  durationSec: number,
  stats: WalkStats | null,
  sep: string = " - ",
): string {
  const base = `${Math.round(durationSec)}S ON THE RUNWAY`;
  if (!stats || stats.steps <= 0) return base;
  if (stats.cadenceSpm === null) return `${base}${sep}${stats.steps} STEPS`;
  return `${base}${sep}${stats.steps} STEPS${sep}${Math.round(stats.cadenceSpm)}/MIN`;
}
