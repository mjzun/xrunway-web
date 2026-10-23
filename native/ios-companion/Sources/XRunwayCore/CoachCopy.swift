//
//  CoachCopy.swift — XRunwayCore
//
//  Port of src/coach-copy.ts: the SOLO copy-variant table (SOLO-MODE §5,
//  "part of the golden spec"; §6.6 string exactness), locked by the golden
//  `copy-variants` family.
//
//  Solo mode measures deviation from the walker's OWN line of travel, not a
//  mapped runway centerline — an unregistered ARKit frame has no centerline,
//  so copy that says "centerline" would claim something that was never
//  measured. This module is the single source for every string that differs:
//  the WEB column is built from the REAL tables/builders (LIVE_CUE_TEXT,
//  METRIC_COACH, METRIC_EXPLAIN, the footwork cue templates) — never
//  hand-copied — and the SOLO column is defined here. Consumers select a
//  surface via `CoachCopyVariant` (Coach.swift buildCoachReport,
//  CoachLive.swift liveCueText).
//

import Foundation

/// Which copy surface a consumer renders: the web strings (vector-locked
/// default, exactly the TS tables) or the Solo substitutions.
public enum CoachCopyVariant {
    case web
    case solo
}

/// One row of the variant table. `key` names the table entry or template the
/// variant replaces on its surface.
public struct CopyVariant {
    public let surface: String // "coach" | "coach-live"
    public let key: String
    public let web: String
    public let solo: String
}

// -- The Solo strings (the §5 mandated copy) ---------------------------------

/// Live cue: "Find the centerline." -> the walker's own line.
public let SOLO_LIVE_CUE_CENTER_UP = "Find your line."

/// Footwork band note: the §5 "your line of travel" phrasing. Head/hip path,
/// not feet — the phone tracks your body's line of travel, not foot placement.
public let SOLO_METRIC_COACH_FOOTWORK =
    "Track your line of travel - keep your body centered on it."

/// M4 explainer: the second §5 copy-variant target.
public let SOLO_METRIC_EXPLAIN_FOOTWORK =
    "How closely you hold your own line of travel."

/// Directional footwork templates, solo phrasing (same shape as the web
/// builders in Coach.swift so the substitution is 1:1).
public func soloFootworkDriftSideCue(_ cm: String, _ side: String) -> String {
    return "You drifted \(cm) cm \(side) of your line of travel - pull it back to your line."
}

public func soloFootworkOffLineCue(_ cm: String) -> String {
    return "You averaged \(cm) cm off your line of travel - tighten your line."
}

// -- The table (the copy-variants golden family's shape) ---------------------

public let SOLO_COPY_VARIANTS: [CopyVariant] = [
    CopyVariant(
        surface: "coach-live",
        key: "LIVE_CUE_TEXT.center-up",
        web: LIVE_CUE_TEXT["center-up"]!,
        solo: SOLO_LIVE_CUE_CENTER_UP
    ),
    CopyVariant(
        surface: "coach",
        key: "METRIC_COACH.footPlacement",
        web: METRIC_COACH["footPlacement"]!,
        solo: SOLO_METRIC_COACH_FOOTWORK
    ),
    CopyVariant(
        surface: "coach",
        key: "METRIC_EXPLAIN.footPlacement",
        web: METRIC_EXPLAIN["footPlacement"]!,
        solo: SOLO_METRIC_EXPLAIN_FOOTWORK
    ),
    CopyVariant(
        surface: "coach",
        key: "footworkCue.drift-side",
        web: footworkDriftSideCue("{cm}", "{side}"),
        solo: soloFootworkDriftSideCue("{cm}", "{side}")
    ),
    CopyVariant(
        surface: "coach",
        key: "footworkCue.off-line",
        web: footworkOffLineCue("{cm}"),
        solo: soloFootworkOffLineCue("{cm}")
    ),
]
