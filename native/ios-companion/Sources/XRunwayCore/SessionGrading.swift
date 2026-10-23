//
//  SessionGrading.swift — XRunwayCore
//
//  Port of src/session-grading.ts: pure history-row grading + filtering
//  rules, locked (together with Progress.swift) by the golden `progress`
//  family's grading queries.
//
//  Rows come from persisted history, so every field can be absent, null or
//  junk (legacy-build tolerance). The port models that honestly:
//  `ProgressRowLike` exposes JS-semantics views of the raw fields —
//  `overallValue` is nil for null/absent/non-number but PRESERVES a NaN
//  number, `passThresholdValue` likewise, `startedAtValue` is the
//  JS-`Number()`-coerced timestamp (junk -> NaN) — so each rule below can
//  keep the exact `typeof`/`Number.isFinite` shape of the TS.
//

import Foundation

/// The trainee-attribution states rowMatchesTrainee distinguishes.
public enum RowTrainee {
    /// No `trainee` field at all (legacy single-user rows).
    case absent
    /// `trainee: null`.
    case null
    /// `trainee` present but its id is missing or not a string (junk
    /// attribution — treated as unattributed).
    case junk
    /// A usable string id.
    case id(String)
}

/// The row surface every grading/progress rule reads. Conformers wrap
/// persisted rows (or, in the golden harness, raw vector JSON).
public protocol ProgressRowLike {
    /// `Number(row.startedAt)` — junk coerces to NaN, never throws.
    var startedAtValue: Double { get }
    /// `row.overall` when it is a number (NaN included), else nil.
    var overallValue: Double? { get }
    /// `row.synthetic === true`.
    var syntheticFlag: Bool { get }
    /// `row.finalScores` when it is an object, else nil; values only where
    /// they are numbers.
    var finalScoresValue: [String: Double]? { get }
    /// `row.modeId` when it is a string, else nil.
    var modeIdValue: String? { get }
    /// `row.passThreshold` when it is a number (NaN included), else nil.
    var passThresholdValue: Double? { get }
    var traineeValue: RowTrainee { get }
    /// `row.normalization` when it is a string, else nil (Wave 1 FIT stamp —
    /// absent on rows persisted before the FIT wave, or junk/non-string).
    var normalizationValue: String? { get }
    /// `row.scoreScale` when it is a string, else nil (the perfect=100
    /// rescale ruler stamp — absent on pre-rescale rows, or junk).
    var scoreScaleValue: String? { get }
}

extension ProgressRowLike {
    /// Default for conformers that predate the Wave 1 normalization stamp —
    /// reads as absent, which rowNormalization maps to "default.v1", so
    /// existing conformers compile (and grade) unchanged.
    public var normalizationValue: String? { nil }
    /// Default for conformers that predate the ruler stamp — reads absent,
    /// which rowScoreScale maps to LEGACY_SCORE_SCALE.
    public var scoreScaleValue: String? { nil }
}

/// Rows persisted before per-run thresholds were recorded are graded against
/// the fixed line the gallery always used.
/// MUST NOT move with the perfect=100 rescale: legacy rows are OLD-RULER
/// rows grading against their own stored bars (the TS twin's law).
public let LEGACY_PASS_THRESHOLD: Double = 75

/// Synthetic = recorded while the Preview Walk auto-pilot drove the rig.
/// Legacy persisted rows have no flag and are NOT synthetic.
public func isSyntheticRow(_ row: ProgressRowLike) -> Bool {
    return row.syntheticFlag
}

/// The pass line THIS row was scored against: its stored per-run threshold,
/// or the legacy 75 for rows that predate the field (or carry junk).
public func rowPassThreshold(_ row: ProgressRowLike) -> Double {
    if let t = row.passThresholdValue, t.isFinite {
        return t
    }
    return LEGACY_PASS_THRESHOLD
}

/// Did this row pass, judged against ITS OWN threshold — so a Beginner 76
/// reads NEEDS WORK in history exactly as it did on the summary card. A row
/// with no recorded overall never passes (and NaN >= bar is false, exactly
/// like JS).
public func rowPassed(_ row: ProgressRowLike) -> Bool {
    guard let overall = row.overallValue else { return false }
    return overall >= rowPassThreshold(row)
}

/// Trainee-scoping rule for shared-device histories. PINNED:
/// - a falsy CURRENT trainee id (nil/empty — no identity wired) filters
///   NOTHING;
/// - otherwise a row matches when its trainee id equals the current id, OR
///   when the row carries no usable attribution — no trainee field, a null
///   trainee, or a junk/non-string id — so a legacy history keeps grading
///   the device's single user instead of vanishing.
public func rowMatchesTrainee(
    _ row: ProgressRowLike, _ traineeId: String?
) -> Bool {
    guard let traineeId = traineeId, !traineeId.isEmpty else { return true }
    switch row.traineeValue {
    case .absent, .null, .junk:
        return true
    case .id(let id):
        return id == traineeId
    }
}

/// The head-path normalization stamp THIS row was scored under (Wave 1 FIT,
/// adjudication §A — the ONE reader helper; Repeatability.swift's
/// rowNormalizationFallback is a DELEGATING alias, never a second
/// implementation). Rows persisted before the FIT wave (or with junk —
/// non-string or empty) were scored with the factory constants — they read
/// "default.v1", deliberately merging with new default-scored rows:
/// identical constants scored both, so they ARE one series. Tokens:
/// "default.v1" | "fit.v1-<capturedAt ms>".
public func rowNormalization(_ row: ProgressRowLike) -> String {
    if let n = row.normalizationValue, !n.isEmpty { return n }
    return "default.v1"
}

/// The ruler every pre-rescale row was scored on (the TS LEGACY_SCORE_SCALE
/// twin). RAW-overall comparisons are scale-scoped; pass-based facts are not.
public let LEGACY_SCORE_SCALE = "s98.v1"

/// The scale stamp THIS row was scored under — the rowNormalization idiom
/// applied to the ruler (session-grading.ts rowScoreScale twin).
public func rowScoreScale(_ row: ProgressRowLike) -> String {
    if let v = row.scoreScaleValue, !v.isEmpty { return v }
    return LEGACY_SCORE_SCALE
}

public enum HistoryFilter: String {
    case all = "all"
    case pass = "pass"
    case low = "low"
}

/// Apply a run-history filter. ALL keeps everything; PASSED / NEEDS WORK are
/// TRAINING verdicts, so synthetic auto-pilot rows are excluded from both
/// and each real row is graded against its own threshold.
public func filterHistoryRows<T: ProgressRowLike>(
    _ rows: [T], _ filter: HistoryFilter
) -> [T] {
    if filter == .all {
        return Array(rows)
    }
    return rows.filter {
        !isSyntheticRow($0) && (filter == .pass) == rowPassed($0)
    }
}
