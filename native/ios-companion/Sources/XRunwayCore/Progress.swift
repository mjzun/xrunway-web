//
//  Progress.swift — XRunwayCore
//
//  Port of src/progress.ts: pure cross-walk math over persisted history rows
//  — the overall-score series, personal best, rolling average, per-metric
//  trend deltas, and per-mode records with the pinned mastery rule. Locked
//  by the golden `progress` family (22 cases).
//
//  Every rule shares one qualifying set: REAL walks only (synthetic Preview
//  Walk rows are excluded — auto-pilot data must never read as a trainee
//  improving) with a finite overall score, sorted chronologically regardless
//  of input order (rows with equal startedAt keep input order — JS sort is
//  stable, so the Swift sort carries an explicit index tiebreak).
//

import Foundation

/// The 7 metric keys (mirrors METRIC_ORDER; kept as its own name to match
/// the TS module surface).
public let PROGRESS_METRIC_KEYS: [String] = METRIC_ORDER

/// Rolling-average + trend comparison window (walks).
public let TREND_WINDOW = 5
/// Sparkline series length cap (walks).
public let SERIES_MAX = 20

/// Epoch ms at walk start; junk values sort as 0, never throw.
private func startedMs(_ row: ProgressRowLike) -> Double {
    let ms = row.startedAtValue
    return ms.isFinite ? ms : 0
}

/// The qualifying set for every progress rule: REAL, SCORED walks in
/// chronological order. Synthetic rows and rows without a finite overall are
/// out; input order doesn't matter (stable sort on startedAt).
public func realScoredRows<T: ProgressRowLike>(_ rows: [T]) -> [T] {
    return rows
        .filter { r in
            if isSyntheticRow(r) { return false }
            guard let overall = r.overallValue else { return false }
            return overall.isFinite
        }
        .enumerated()
        .sorted { a, b in
            let (ma, mb) = (startedMs(a.element), startedMs(b.element))
            // Explicit stable-sort tiebreak (JS Array.prototype.sort is
            // stable; Swift's sort is not).
            return ma != mb ? ma < mb : a.offset < b.offset
        }
        .map { $0.element }
}

public struct PersonalBest {
    public let overall: Double
    /// Epoch ms of the walk that SET the record. Ties keep the EARLIEST
    /// walk — matching a record later is not a new best.
    public let startedAt: Double
}

/// Personal best overall across ALL real scored walks, or nil.
/// True when the row was scored on the CURRENT ruler (perfect=100 rescale) —
/// the progress.ts onCurrentScale twin.
private func onCurrentScale(_ row: ProgressRowLike) -> Bool {
    return rowScoreScale(row) == SCORE_SCALE_STAMP
}

public func personalBest(_ rows: [some ProgressRowLike]) -> PersonalBest? {
    var best: PersonalBest? = nil
    for r in realScoredRows(rows) {
        if !onCurrentScale(r) { continue }  // old-ruler rows never compete
        let overall = r.overallValue!
        if best == nil || overall > best!.overall {
            best = PersonalBest(overall: overall, startedAt: startedMs(r))
        }
    }
    return best
}

/// Mean of the last `window` values (fewer when the series is shorter — the
/// average is over min(window, n) values). Nil when the series is empty.
/// Values are chronological.
public func rollingAverage(
    _ values: [Double], _ window: Int = TREND_WINDOW
) -> Double? {
    if values.isEmpty || window < 1 { return nil }
    let n = min(window, values.count)
    var sum: Double = 0
    for i in (values.count - n)..<values.count { sum += values[i] }
    return sum / Double(n)
}

/// Trend delta over a chronological series: mean of the last w values minus
/// mean of the w values before those, where w = min(window, floor(n/2)).
///
/// THE RULE: with 10+ walks this compares the last 5 against the previous 5;
/// shorter histories shrink BOTH windows together so the comparison stays
/// like-for-like. Anything older than the last 2w walks is ignored. Nil when
/// fewer than 2 values — nothing to compare.
public func trendDelta(
    _ values: [Double], _ window: Int = TREND_WINDOW
) -> Double? {
    let n = values.count
    if n < 2 || window < 1 { return nil }
    let w = min(window, n / 2)
    var recent: Double = 0
    var previous: Double = 0
    for i in 0..<w {
        recent += values[n - 1 - i]
        previous += values[n - 1 - w - i]
    }
    return (recent - previous) / Double(w)
}

/// Overall scores of the last <= `max` real walks, chronological (sparkline).
public func overallSeries(
    _ rows: [some ProgressRowLike], _ max: Int = SERIES_MAX
) -> [Double] {
    let real = realScoredRows(rows)
    var out: [Double] = []
    var i = real.count - max
    if i < 0 { i = 0 }
    while i < real.count {
        out.append(real[i].overallValue!)
        i += 1
    }
    return out
}

/// Per-metric trend deltas from the rows' final scores. A metric only counts
/// walks where it was recorded with a finite value, so a legacy row without
/// finalScores can't zero a trend — it just doesn't vote. Nil when that
/// metric has fewer than 2 recorded walks.
public func metricTrends(
    _ rows: [some ProgressRowLike]
) -> [String: Double?] {
    let real = realScoredRows(rows)
    var out: [String: Double?] = [:]
    for key in PROGRESS_METRIC_KEYS {
        var values: [Double] = []
        for r in real {
            if let v = r.finalScoresValue?[key], v.isFinite {
                values.append(v)
            }
        }
        out[key] = trendDelta(values)
    }
    return out
}

/// True when the trainee's LATEST real walk set a new personal best:
/// - it beat every earlier real walk STRICTLY (tying a record only matches),
/// - at least one earlier real walk exists, and
/// - no newer row of ANY kind was recorded after it (a Preview Walk run
///   after the record must never re-announce it as new).
public func latestIsPersonalBest(_ rows: [some ProgressRowLike]) -> Bool {
    // Scale-scoped (the TS twin): PB is a current-ruler fact.
    let real = realScoredRows(rows).filter(onCurrentScale)
    if real.count < 2 { return false }
    let latest = real[real.count - 1]
    for r in rows {
        if startedMs(r) > startedMs(latest) { return false }
    }
    let latestOverall = latest.overallValue!
    for i in 0..<(real.count - 1) {
        if real[i].overallValue! >= latestOverall { return false }
    }
    return true
}

// ---------------------------------------------------------------------------
// Per-mode records + mastery.
// ---------------------------------------------------------------------------

/// Bucket id for rows persisted before modeId was recorded. They still get
/// per-mode stats but NEVER a mastery flag: mastery is a claim about a
/// specific lesson's bar, and these rows can't prove which lesson they
/// trained.
public let LEGACY_MODE_BUCKET = "legacy"

/// THE MASTERY RULE (pinned): a mode is mastered when at least
/// MASTERY_PASS_COUNT of the last MASTERY_WINDOW real walks in that mode
/// passed — each walk judged against ITS OWN recorded passThreshold (legacy
/// fallback 75). Recency is the point: three early passes buried under
/// recent failures are not mastery.
public let MASTERY_PASS_COUNT = 3
public let MASTERY_WINDOW = 5

/// Cross-walk record for one training mode (real scored walks only).
public struct ModeStats {
    /// The mode id, or LEGACY_MODE_BUCKET for pre-mode rows.
    public let modeId: String
    /// Real scored walks in this mode (all-time).
    public let walks: Int
    /// Best overall in this mode.
    public let best: Double
    /// Overall of the most recent walk in this mode.
    public let last: Double
    /// Passing walks in this mode (all-time, each vs its own bar).
    public let passed: Int
    /// See MASTERY_PASS_COUNT / MASTERY_WINDOW; always false for legacy.
    public let mastered: Bool
}

/// The row's per-mode bucket id. Junk/empty modeId = legacy.
private func modeBucket(_ row: ProgressRowLike) -> String {
    if let id = row.modeIdValue, !id.isEmpty { return id }
    return LEGACY_MODE_BUCKET
}

/// The pinned mastery rule over ONE mode's chronological real walks.
private func masteredFrom(_ walks: [ProgressRowLike]) -> Bool {
    var passed = 0
    let from = max(0, walks.count - MASTERY_WINDOW)
    for i in from..<walks.count {
        if rowPassed(walks[i]) { passed += 1 }
    }
    return passed >= MASTERY_PASS_COUNT
}

/// Per-mode records across the history: one entry per mode bucket present in
/// the REAL scored rows. Entries keep first-walked order (JS Map insertion
/// order) — consumers reorder for display.
public func modeStats(_ rows: [some ProgressRowLike]) -> [ModeStats] {
    var order: [String] = []
    var byMode: [String: [ProgressRowLike]] = [:]
    for r in realScoredRows(rows) {
        let bucket = modeBucket(r)
        if byMode[bucket] != nil {
            byMode[bucket]!.append(r)
        } else {
            order.append(bucket)
            byMode[bucket] = [r]
        }
    }
    var out: [ModeStats] = []
    for modeId in order {
        let list = byMode[modeId]!
        // Per-mode BEST competes on the current ruler; no current-scale
        // walks -> the newest overall as a display placeholder (TS twin).
        var best: Double? = nil
        var passed = 0
        for r in list {
            let overall = r.overallValue!
            if onCurrentScale(r) && (best == nil || overall > best!) {
                best = overall
            }
            if rowPassed(r) { passed += 1 }
        }
        let bestOut = best ?? list[list.count - 1].overallValue!
        out.append(
            ModeStats(
                modeId: modeId,
                walks: list.count,
                best: bestOut,
                last: list[list.count - 1].overallValue!,
                passed: passed,
                mastered: modeId != LEGACY_MODE_BUCKET && masteredFrom(list)
            ))
    }
    return out
}

/// True when the trainee's newest walk in `modeId` EARNED that mode's
/// mastery — the "MODE MASTERED" moment on the summary card. Idempotent
/// against the post-walk history:
/// - the mode is mastered now, and was NOT mastered without its newest walk;
/// - no newer row of ANY kind was recorded after that walk;
/// - never for the legacy bucket or an unknown/absent mode id.
public func masteryJustEarned(
    _ rows: [some ProgressRowLike], _ modeId: String?
) -> Bool {
    guard let modeId = modeId, !modeId.isEmpty, modeId != LEGACY_MODE_BUCKET
    else { return false }
    let inMode: [ProgressRowLike] =
        realScoredRows(rows).filter { modeBucket($0) == modeId }
    if inMode.count < MASTERY_PASS_COUNT { return false }
    let latest = inMode[inMode.count - 1]
    for r in rows {
        if startedMs(r) > startedMs(latest) { return false }
    }
    return masteredFrom(inMode) && !masteredFrom(Array(inMode.dropLast()))
}

/// Everything the trends strip + summary-card best chip consume, in one pass.
public struct ProgressReport {
    /// Count of real, scored walks in the history.
    public let walks: Int
    /// Overall of the last <= SERIES_MAX real walks, chronological.
    public let series: [Double]
    public let best: PersonalBest?
    /// Mean overall of the last <= TREND_WINDOW real walks.
    public let rollingAvg: Double?
    /// Overall trend delta (see trendDelta for the window rule).
    public let overallTrend: Double?
    public let metricTrends: [String: Double?]
    /// The latest real walk set a new personal best.
    public let newBest: Bool
}

public func progressReport(_ rows: [some ProgressRowLike]) -> ProgressReport {
    let real = realScoredRows(rows)
    let overalls = real.map { $0.overallValue! }
    return ProgressReport(
        walks: real.count,
        series: Array(overalls.suffix(SERIES_MAX)),
        best: personalBest(rows),
        rollingAvg: rollingAverage(overalls),
        overallTrend: trendDelta(overalls),
        metricTrends: metricTrends(rows),
        newBest: latestIsPersonalBest(rows)
    )
}
