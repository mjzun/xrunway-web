//
//  Coach.swift — XRunwayCore
//
//  Port of src/coach.ts (the shared post-walk coach layer), locked by the
//  golden `coach` family (41 cases: verdict rounding, per-mode bars, note
//  ranking/cap/tiebreak, every directional-honesty gate) and the
//  `coach-tables` emission of METRIC_EXPLAIN / METRIC_COACH / CLEAN_WALK_CUE.
//
//  Honesty rules (pinned — the copy must never claim what wasn't measured):
//  - M5-M7 are COMPOSITE reads; their cues point at the measured channels.
//  - PACE is directional whenever paceDeltaMps is known, citing real m/s.
//  - POSTURE direction comes from the SIGN of postureDriftM, quantified cm.
//  - FOOTWORK never claims left/right unless the route was ONE-WAY and the
//    side was consistent (|meanLateralM| / meanAbsLateralM >= 0.6).
//  - RHYTHM may cite the real step count + cadence when steps were detected.
//  - A nil stats object or a nil channel falls back to the generic band cue.
//
//  Ground rules honored: jsRound at every rounding site; toFixed(2) via
//  String(format: "%.2f") with the render-identical guard comparing the
//  FORMATTED strings; the below-line sort carries an explicit index tiebreak
//  because Swift's sort is not stable (JS's is — ties keep M1..M7 order).
//
//  The SOLO copy variants (SOLO-MODE §5) enter through `CoachCopyVariant`:
//  the web strings are the vector-locked default; .solo swaps exactly the
//  five strings the copy-variants golden family pins (CoachCopy.swift).
//

import Foundation

/// Plain-language explainer per metric (summary-card tooltips). M5-M7 are
/// COMPOSITE reads — each explainer states its true derivation and says
/// plainly that nothing measures it separately.
public let METRIC_EXPLAIN: [String: String] = [
    "posture": "How square and lifted your frame stays through the walk.",
    "pace": "How close your speed is to this mode's ideal catwalk tempo.",
    "rhythm": "How even and consistent your step timing is.",
    "footPlacement":
        "How closely your head holds the runway centerline (a headset reads your head, not your feet).",
    "presence":
        "Composite read: your posture, rhythm and pace weighted together, posture counting most. It is not separately measured - eyeline is not tracked.",
    "confidence":
        "Composite read: pace, posture and rhythm weighted evenly with a lighter footwork share, plus a small settle-in credit that grows over the walk. It is not separately measured.",
    "presentation":
        "Composite read: all four measured channels blended, posture and rhythm weighted heaviest. It is not separately measured - the turn is not analyzed.",
]

/// Generic corrective cue per metric — the band-based fallback used when the
/// walk's measurements can't back a directional claim.
public let METRIC_COACH: [String: String] = [
    "posture": "Lift through the crown - shoulders back, chin level, ribs over hips.",
    "pace": "Settle into one tempo - don't rush the start or drift at the mark.",
    "rhythm": "Lock a steady cadence - equal time on each step, like a metronome.",
    "footPlacement": "Hold your line - keep your head centered over the runway.",
    "presence":
        "Presence is scored from your posture, rhythm and pace - lift the frame and steady the tempo and it follows.",
    "confidence":
        "Confidence is scored from your measured channels - even out pace, posture and rhythm and this read climbs with them.",
    "presentation":
        "Presentation rolls up all four measured channels - posture and rhythm move it most, so start there.",
]

/// Every-metric-cleared line (shown when no note qualifies).
public let CLEAN_WALK_CUE =
    "Clean walk - every metric cleared the line. Step up a mode."

/// Minimum |meanLateralM| / meanAbsLateralM for the footwork copy to name a
/// side. Below this the trainee weaved across the line more than they held
/// one side, and "you drifted right" would be a guess.
public let LATERAL_SIDE_CONSISTENCY: Double = 0.6

/// One coach's note: the metric it targets + its (possibly directional) cue.
public struct CoachNote {
    public let key: String
    /// Corrective copy — directional + quantified when the stats support it.
    public let cue: String
    /// True when the cue cites this walk's real measurements.
    public let directional: Bool
}

/// The verdict + notes for one finished walk — plain data, no UI.
public struct CoachReport {
    /// Rounded overall score (the number the summary UI displays).
    public let overall: Double
    /// The active mode's pass bar the verdict was judged against.
    public let passThreshold: Double
    public let passed: Bool
    public let verdict: String // "PASS" | "NEEDS WORK"
    /// Up to 3 below-line metrics, most costly first (weight x shortfall,
    /// ties keep M1..M7 order). Empty = every metric cleared the line.
    public let notes: [CoachNote]
}

/// The slice of a TrainingMode the coach needs.
public struct CoachModeParams {
    public let passThreshold: Double
    public let weights: [String: Double]

    public init(passThreshold: Double, weights: [String: Double]) {
        self.passThreshold = passThreshold
        self.weights = weights
    }
}

public struct CoachContext {
    /// Final 0-100 scores for the walk, keyed by METRIC_ORDER names.
    public let scores: [String: Double]
    /// Overall 0-100 (unrounded is fine — the report rounds like the UIs).
    public let overall: Double
    public let mode: CoachModeParams
    /// Real measurements for the walk, or nil when none were captured.
    public let stats: WalkStats?
    /// True when the walked route is one-way: the lateral sign is the
    /// trainee's right for the WHOLE walk, so left/right copy is
    /// trustworthy. Out-and-back routes must pass false.
    public let oneWayRoute: Bool

    public init(
        scores: [String: Double], overall: Double, mode: CoachModeParams,
        stats: WalkStats?, oneWayRoute: Bool
    ) {
        self.scores = scores
        self.overall = overall
        self.mode = mode
        self.stats = stats
        self.oneWayRoute = oneWayRoute
    }
}

// ---------------------------------------------------------------------------
// Directional cue builders — each returns nil when the stats can't honestly
// back the claim, and the caller falls back to the generic band cue.
// ---------------------------------------------------------------------------

private func paceCue(_ stats: WalkStats) -> String? {
    guard let paceDelta = stats.paceDeltaMps, let meanPace = stats.meanPaceMps
    else { return nil }
    if paceDelta == 0 { return nil } // dead-on: no direction to claim
    let mean = jsToFixed2(meanPace)
    let ideal = jsToFixed2(stats.idealPaceMps)
    // Sub-display-resolution delta (< 0.005 m/s): the two numbers RENDER
    // identically, so a directional command would contradict its own
    // citation ("0.85 vs 0.85 - slow down"). Fall back to the generic cue —
    // the guard compares the FORMATTED strings, mirroring coach.ts.
    if mean == ideal { return nil }
    return paceDelta > 0
        ? "You averaged \(mean) m/s against a \(ideal) m/s target - slow every stride down."
        : "You averaged \(mean) m/s against a \(ideal) m/s target - pick every stride up."
}

private func postureCue(_ stats: WalkStats) -> String? {
    guard let drift = stats.postureDriftM else { return nil }
    let cm = jsRound(abs(drift) * 100)
    if cm < 1 { return nil } // sub-centimeter: not worth a directional claim
    return drift > 0
        ? "You rode \(jsIntString(cm)) cm above your start height - settle down, no bounce."
        : "You sank \(jsIntString(cm)) cm below your start height - lift through the crown."
}

/// Directional footwork templates — exported so the Solo copy-variant table
/// (CoachCopy.swift) builds its WEB column from the REAL builders
/// (placeholder args) instead of hand-copied strings.
public func footworkDriftSideCue(_ cm: String, _ side: String) -> String {
    return "You drifted \(cm) cm \(side) of the centerline - pull it back to center."
}

public func footworkOffLineCue(_ cm: String) -> String {
    return "You averaged \(cm) cm off the centerline - tighten your line."
}

private func footworkCue(
    _ stats: WalkStats, _ oneWayRoute: Bool, _ copy: CoachCopyVariant
) -> String? {
    guard let meanAbs = stats.meanAbsLateralM, let mean = stats.meanLateralM
    else { return nil }
    let cm = jsRound(meanAbs * 100)
    if cm < 1 { return nil }
    // Left/right ONLY on a one-way route with a consistent side — the signed
    // mean flips meaning on the return leg of an out-and-back walk.
    let sideIsHonest =
        oneWayRoute && meanAbs > 0
        && abs(mean) / meanAbs >= LATERAL_SIDE_CONSISTENCY
    if sideIsHonest {
        let side = mean > 0 ? "right" : "left"
        return copy == .solo
            ? soloFootworkDriftSideCue(jsIntString(cm), side)
            : footworkDriftSideCue(jsIntString(cm), side)
    }
    return copy == .solo
        ? soloFootworkOffLineCue(jsIntString(cm))
        : footworkOffLineCue(jsIntString(cm))
}

private func rhythmCue(_ stats: WalkStats) -> String? {
    guard let cadence = stats.cadenceSpm, stats.steps > 0 else { return nil }
    return "\(stats.steps) steps at \(jsIntString(jsRound(cadence))) per minute - keep the interval even."
}

/// The best honest cue for one metric — directional when backed, else the
/// generic band cue (variant-substituted for the Solo surface, §5).
private func cueFor(
    _ key: String, _ stats: WalkStats?, _ oneWayRoute: Bool,
    _ copy: CoachCopyVariant
) -> CoachNote {
    var cue: String? = nil
    if let stats = stats {
        if key == "pace" { cue = paceCue(stats) }
        else if key == "posture" { cue = postureCue(stats) }
        else if key == "footPlacement" {
            cue = footworkCue(stats, oneWayRoute, copy)
        } else if key == "rhythm" { cue = rhythmCue(stats) }
        // presence/confidence/presentation are composites — nothing measures
        // them directly, so they always take the generic band cue.
    }
    if let cue = cue { return CoachNote(key: key, cue: cue, directional: true) }
    let generic =
        copy == .solo && key == "footPlacement"
        ? SOLO_METRIC_COACH_FOOTWORK
        : METRIC_COACH[key]!
    return CoachNote(key: key, cue: generic, directional: false)
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

/// Verdict + coach's notes for one finished walk. Pure data — the surfaces
/// own all rendering. Scores round before comparing, the verdict is
/// rounded-overall vs the mode's bar, and the notes are the below-line
/// metrics ranked by weight x shortfall, capped at 3.
///
/// `copy` selects the copy-variant surface: `.web` (the vector-locked
/// default, exactly src/coach.ts) or `.solo` (the §5 substitution — the
/// copy-variants golden family pins the swapped strings).
public func buildCoachReport(
    _ ctx: CoachContext, copy: CoachCopyVariant = .web
) -> CoachReport {
    let thr = ctx.mode.passThreshold
    let overall = jsRound(ctx.overall)
    let passed = overall >= thr
    struct Ranked {
        let key: String
        let below: Bool
        let impact: Double
        let index: Int
    }
    let ranked = METRIC_ORDER.enumerated().map { (i, key) -> Ranked in
        let v = jsRound(ctx.scores[key] ?? Double.nan)
        return Ranked(
            key: key,
            below: v < thr,
            impact: (ctx.mode.weights[key] ?? 0) * max(0, thr - v),
            index: i
        )
    }
    let notes =
        ranked
        .filter { $0.below }
        // JS's sort is stable (ties keep M1..M7 order); Swift's is not, so
        // the tiebreak is explicit on the METRIC_ORDER index.
        .sorted { a, b in
            a.impact != b.impact ? a.impact > b.impact : a.index < b.index
        }
        .prefix(3)
        .map { cueFor($0.key, ctx.stats, ctx.oneWayRoute, copy) }
    return CoachReport(
        overall: overall,
        passThreshold: thr,
        passed: passed,
        verdict: passed ? "PASS" : "NEEDS WORK",
        notes: Array(notes)
    )
}

// ---------------------------------------------------------------------------
// Shared one-line labels (ASCII-only). Not vector-locked (no golden family
// exercises them — they are DOM/panel chrome on the web); ported for the A3
// summary UI. Thresholds/paces are whole or 2-dp numbers in practice.
// ---------------------------------------------------------------------------

/// Summary verdict line, e.g. "PASS - BAR 78".
public func verdictLine(_ report: CoachReport) -> String {
    return "\(report.verdict) - BAR \(jsIntString(report.passThreshold))"
}

/// Pre-walk pass-bar chip, e.g. "PASS AT 78".
public func passBarLabel(_ passThreshold: Double) -> String {
    return "PASS AT \(jsIntString(passThreshold))"
}

/// Honest target-pace chip from the mode's ideal, e.g. "TARGET 0.85 M/S".
public func targetPaceLabel(_ idealPaceMps: Double) -> String {
    return "TARGET \(jsToFixed2(idealPaceMps)) M/S"
}

/// Duration + REAL steps/cadence summary line, e.g.
/// "58S ON THE RUNWAY - 58 STEPS - 96/MIN". Steps/cadence are omitted when
/// the walk produced none.
public func walkStatLine(
    _ durationSec: Double, _ stats: WalkStats?, sep: String = " - "
) -> String {
    let base = "\(jsIntString(jsRound(durationSec)))S ON THE RUNWAY"
    guard let stats = stats, stats.steps > 0 else { return base }
    guard let cadence = stats.cadenceSpm else {
        return "\(base)\(sep)\(stats.steps) STEPS"
    }
    return "\(base)\(sep)\(stats.steps) STEPS\(sep)\(jsIntString(jsRound(cadence)))/MIN"
}
