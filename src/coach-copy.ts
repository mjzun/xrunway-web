/**
 * (X)RUNWAY — the SOLO copy-variant table (SOLO-MODE §5, "part of the golden
 * spec"; §6.6 string exactness).
 *
 * Solo mode measures deviation from the walker's OWN line of travel, not a
 * mapped runway centerline — an unregistered ARKit frame has no centerline,
 * so copy that says "centerline" would claim something that was never
 * measured (the adjudicated honesty ruling: Solo copy must say what was
 * actually measured). This module is the single source for every string that
 * differs: the WEB column is built from the REAL exported tables/builders
 * (LIVE_CUE_TEXT, METRIC_COACH, METRIC_EXPLAIN, the footwork cue templates)
 * — never hand-copied — and the SOLO column is defined here and emitted into
 * test/golden/copy-variants.json for the Swift port's XCTest.
 *
 * Swift consumption rule (documented for A2): apply the variant substitution
 * (web -> solo, by key) to the coach/coach-live expected strings BEFORE
 * exact comparison; templates carry {cm}/{side} placeholders that substitute
 * the same rendered values as the web string they replace.
 *
 * Dependency-free (pure imports of pure modules); ASCII-only strings — the
 * coach.ts law.
 */

import {
  METRIC_COACH,
  METRIC_EXPLAIN,
  footworkDriftSideCue,
  footworkOffLineCue,
} from "./coach.js";
import { LIVE_CUE_TEXT } from "./coach-live.js";

/** One row of the variant table. `key` names the table entry or template the
 *  variant replaces on its surface. */
export interface CopyVariant {
  surface: "coach" | "coach-live";
  key: string;
  web: string;
  solo: string;
}

// -- The Solo strings (the §5 mandated copy) ---------------------------------

/** Live cue: "Find the centerline." -> the walker's own line. */
export const SOLO_LIVE_CUE_CENTER_UP = "Find your line.";

/** Footwork band note: the §5 "your line of travel" phrasing. Head/hip
 *  path, not feet — the phone tracks your body's line of travel, not foot
 *  placement, so the copy names the line, never the foot. */
export const SOLO_METRIC_COACH_FOOTWORK =
  "Track your line of travel - keep your body centered on it.";

/** M4 explainer: the second §5 copy-variant target. */
export const SOLO_METRIC_EXPLAIN_FOOTWORK =
  "How closely you hold your own line of travel.";

/** Directional footwork templates, solo phrasing (same shape as the web
 *  builders in coach.ts so the substitution is 1:1). */
export function soloFootworkDriftSideCue(
  cm: number | string,
  side: string,
): string {
  return `You drifted ${cm} cm ${side} of your line of travel - pull it back to your line.`;
}

export function soloFootworkOffLineCue(cm: number | string): string {
  return `You averaged ${cm} cm off your line of travel - tighten your line.`;
}

// -- The table (emitted as the copy-variants golden family) ------------------

export const SOLO_COPY_VARIANTS: readonly CopyVariant[] = [
  {
    surface: "coach-live",
    key: "LIVE_CUE_TEXT.center-up",
    web: LIVE_CUE_TEXT["center-up"],
    solo: SOLO_LIVE_CUE_CENTER_UP,
  },
  {
    surface: "coach",
    key: "METRIC_COACH.footPlacement",
    web: METRIC_COACH.footPlacement,
    solo: SOLO_METRIC_COACH_FOOTWORK,
  },
  {
    surface: "coach",
    key: "METRIC_EXPLAIN.footPlacement",
    web: METRIC_EXPLAIN.footPlacement,
    solo: SOLO_METRIC_EXPLAIN_FOOTWORK,
  },
  {
    surface: "coach",
    key: "footworkCue.drift-side",
    web: footworkDriftSideCue("{cm}", "{side}"),
    solo: soloFootworkDriftSideCue("{cm}", "{side}"),
  },
  {
    surface: "coach",
    key: "footworkCue.off-line",
    web: footworkOffLineCue("{cm}"),
    solo: soloFootworkOffLineCue("{cm}"),
  },
];
