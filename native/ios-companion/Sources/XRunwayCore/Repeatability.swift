//
//  Repeatability.swift — XRunwayCore
//
//  Port of src/repeatability.ts (M12 repeatability + benchmark re-test,
//  EDGE-ROADMAP Wave 1): pure cross-walk CONSISTENCY math over the persisted
//  history rows — the repeatability verdict (spread of pace/cadence/
//  centerline across matched walks) and the locked benchmark configuration
//  whose rows are the ONLY series the product ever captions as improvement.
//  Locked by the golden `repeatability` family (48 cases).
//
//  HONESTY RULES CARRIED BY THIS FILE (verbatim from the TS):
//  - Verdicts are MAX-DEVIATION bounds ("agreed within X%"), never CV
//    dressed up as a per-walk claim; display rounding always errs toward
//    claiming LESS consistency (ceil + a 1% floor, see withinPct).
//  - No cause claims: the hedge is carried by REPEAT_DISCLOSURE
//    ("...NOT WHY.").
//  - Walks only aggregate when mode, shape, sensor, normalization stamp,
//    music tempo (rowMusicBpm — multi-BPM wave) AND walk duration
//    (rowWalkSeconds — the duration wave) all match — different rulers and
//    different conditions never blend into one spread.
//
//  The benchmark series layer lives HERE, not Progress.swift — the progress
//  golden family and its Swift mirror stay frozen (adjudicated override);
//  only progress's qualifying set (realScoredRows) and SERIES_MAX are reused
//  (pure -> pure value import). SessionGrading.swift owns rowNormalization
//  (adjudication §A — the ONE implementation); rowNormalizationFallback
//  below is a DELEGATING alias kept so the default `normOf` parameter stays
//  a visible injection seam.
//

import Foundation

// ---------------------------------------------------------------------------
// Row shapes (all additive-optional — legacy rows simply never qualify).
// ---------------------------------------------------------------------------

/// The stats scalars repeatability reads (subset of WalkStats — kept
/// structural so this module never touches the accumulator). All are
/// per-walk values persisted by walk-stats finalize(): meanPaceMps (round3,
/// m/s), cadenceSpm (round1, steps/min), meanAbsLateralM (round3, m).
/// Fields keep the TS `number | null | undefined` semantics: nil for
/// null/absent/non-number, with a wire-carried NaN preserved as a number.
public struct RepeatStatsSlice {
    public let meanPaceMps: Double?
    public let cadenceSpm: Double?
    public let meanAbsLateralM: Double?

    public init(
        meanPaceMps: Double? = nil,
        cadenceSpm: Double? = nil,
        meanAbsLateralM: Double? = nil
    ) {
        self.meanPaceMps = meanPaceMps
        self.cadenceSpm = cadenceSpm
        self.meanAbsLateralM = meanAbsLateralM
    }
}

/// Row surface for M12: ProgressRowLike + the persisted per-walk facts the
/// repeatability window and the benchmark series group by (the TS
/// "RepeatRow extends ProgressRow" / "BenchmarkRow extends ProgressRow",
/// merged — structurally the same rows feed both). Every added field is
/// defaulted by the extension below so existing conformers compile
/// unchanged; a conformer without the Wave 1 stamps simply never qualifies
/// (it cannot prove its conditions), exactly like the TS's
/// additive-optional interface fields.
public protocol RepeatRowLike: ProgressRowLike {
    /// `row.stats` when it is an object, else nil.
    var statsValue: RepeatStatsSlice? { get }
    /// Runway shape kind at walk start ("straight"|"T"|"X"|"U") when it is
    /// a string, else nil (unknown, mid-walk shape change, or legacy row).
    var shapeKindValue: String? { get }
    /// "head", the external camera's source label, or "preview" — when a
    /// string, else nil.
    var primarySourceValue: String? { get }
    /// `row.benchmark === true` — the walk-start benchmark stamp
    /// (recorder), re-derived at finalize (§G). Absent/junk reads false.
    var benchmarkValue: Bool { get }
    /// Wire tri-state of the `musicBpm` stamp (multi-BPM wave) — the
    /// RowTrainee pattern: absent and explicit null read DIFFERENTLY under
    /// rowMusicBpm, so a plain `Double?` cannot carry the field. Junk
    /// (non-number wire value) decodes as .absent — the TS law reads both
    /// as LEGACY_MUSIC_BPM.
    var musicBpmStamp: MusicBpmStamp { get }
    /// Wire tri-state of the `walkSecondsSet` stamp (the duration wave) —
    /// the musicBpmStamp pattern exactly: absent/junk decodes .absent
    /// (reads LEGACY_WALK_SECONDS), explicit null stays .null.
    var walkSecondsStamp: WalkSecondsStamp { get }
}

/// The three wire shapes of `row.musicBpm` (see RepeatRowLike.musicBpmStamp).
public enum MusicBpmStamp {
    /// No `musicBpm` key on the row (legacy, pre-multi-BPM) — or junk.
    case absent
    /// `musicBpm: null` — the summary carried no stamp.
    case null
    /// `musicBpm: <number>` (a wire-carried NaN stays a number here; the
    /// finite check lives in rowMusicBpm, the ONE reader).
    case number(Double)
}

/// The three wire shapes of `row.walkSecondsSet` (the duration wave — see
/// RepeatRowLike.walkSecondsStamp; the MusicBpmStamp pattern).
public enum WalkSecondsStamp {
    /// No `walkSecondsSet` key on the row (pre-duration-wave) — or junk.
    case absent
    /// `walkSecondsSet: null` — the summary carried no stamp.
    case null
    /// `walkSecondsSet: <number>` (finite check lives in rowWalkSeconds).
    case number(Double)
}

extension RepeatRowLike {
    public var statsValue: RepeatStatsSlice? { nil }
    public var shapeKindValue: String? { nil }
    public var primarySourceValue: String? { nil }
    public var benchmarkValue: Bool { false }
    /// Default for conformers that predate the multi-BPM stamp — reads as
    /// absent, which rowMusicBpm maps to LEGACY_MUSIC_BPM, so existing
    /// conformers compile (and group) unchanged.
    public var musicBpmStamp: MusicBpmStamp { .absent }
    /// Default for conformers that predate the duration stamp — reads as
    /// absent, which rowWalkSeconds maps to LEGACY_WALK_SECONDS.
    public var walkSecondsStamp: WalkSecondsStamp { .absent }
}

// ---------------------------------------------------------------------------
// Normalization stamp reader (adjudication §A).
// ---------------------------------------------------------------------------

/// Reads the normalization token a row was scored under.
public typealias NormalizationReader = (ProgressRowLike) -> String

/// The token meaning "today's default constants scored this walk" — also
/// what every legacy (pre-stamp) row reads as, because the same constants
/// scored them (adjudication §A: legacy and new default-scored rows
/// deliberately merge).
public let DEFAULT_NORMALIZATION = "default.v1"

/// §A contract — a DELEGATING alias of SessionGrading's rowNormalization,
/// the ONE implementation of the rule: absent / null / junk (non-string or
/// empty) -> "default.v1"; any non-empty string token (e.g.
/// "fit.v1-1719900000000") passes through verbatim. The alias survives as
/// this module's default `normOf` so the injected-reader seam keeps a
/// stable local name; it adds no second implementation.
public func rowNormalizationFallback(_ row: ProgressRowLike) -> String {
    return rowNormalization(row)
}

// ---------------------------------------------------------------------------
// Music tempo stamp reader (multi-BPM wave).
// ---------------------------------------------------------------------------

/// The tempo every pre-multi-BPM walk was delivered at — the BUILD CONSTANT
/// (the single 122 BPM engine) that the multi-BPM wave deleted in favor of
/// the per-row musicBpm stamp. It survives here only as the read value of an
/// ABSENT stamp: one constant delivered every legacy walk, so legacy rows
/// deliberately group as one 122 series (the §A "identical constants scored
/// both" argument, applied to tempo). NOT a selectable tempo anymore — new
/// walks stamp 62/100/125, so a legacy window closes rather than silently
/// continuing under a different beat.
public let LEGACY_MUSIC_BPM: Double = 122

/// The music tempo THIS row was delivered at (the ONE reader — the
/// rowNormalization idiom applied to tempo). Absent and junk (non-number or
/// non-finite) read LEGACY_MUSIC_BPM: the only tempo that ever ran unstamped
/// is the deleted build constant, and junk follows the §A junk rule (a stamp
/// that proves nothing reads as the legacy default). EXPLICIT null is
/// different — the recorder minted it ("the summary carried no stamp") — so
/// it stays nil and matches only nil in a group key (Optional ==, exactly
/// the JS null === null the TS relies on).
public func rowMusicBpm(_ row: RepeatRowLike) -> Double? {
    switch row.musicBpmStamp {
    case .null:
        return nil
    case .number(let n) where n.isFinite:
        return n
    case .absent, .number:
        return LEGACY_MUSIC_BPM
    }
}

// ---------------------------------------------------------------------------
// Walk-duration stamp reader (the duration wave, founder call 2026-07-09).
// ---------------------------------------------------------------------------

/// The walk length every unstamped row is read as (seconds). The tempo law
/// transfers IMPERFECTLY here — a documented caveat, not a clean constant:
/// since commit 4ac430a (2026-07-07) every mode locked 20 s, so post-4ac430a
/// legacy rows group correctly; rows persisted BEFORE that walked the old
/// per-mode lengths (40-75 s) and absent->20 would misgroup them. The window
/// is two days of pre-worksheet history; the founder-precedent read (the
/// default.v1 / LEGACY_MUSIC_BPM idiom) stands — revisit only if a
/// pre-4ac430a history surfaces in practice. (TS: LEGACY_WALK_SECONDS.)
public let LEGACY_WALK_SECONDS: Double = 20

/// The CONFIGURED walk length THIS row ran under (the ONE reader — the
/// rowMusicBpm idiom applied to duration). Absent and junk read
/// LEGACY_WALK_SECONDS (caveat above); EXPLICIT null stays nil and matches
/// only nil in a group key. NEVER derived from the measured durationSec —
/// a positional finish ends a 20 s lock early and would fragment series.
public func rowWalkSeconds(_ row: RepeatRowLike) -> Double? {
    switch row.walkSecondsStamp {
    case .null:
        return nil
    case .number(let n) where n.isFinite:
        return n
    case .absent, .number:
        return LEGACY_WALK_SECONDS
    }
}

// ---------------------------------------------------------------------------
// Benchmark configuration (the locked like-for-like series).
// ---------------------------------------------------------------------------

/// BENCHMARK_MODE_ID = "beginner" — the UNGATED day-0 default mode
/// (DEFAULT_MODE = MODES[0]): every install can record a benchmark walk on
/// day one, so the series starts where the trainee starts. NOT "the lowest
/// bar" — commercial's 75 is lower than beginner's 78 (adjudication §K
/// correction); the pin is day-0 accessibility plus the most even weight
/// table. Beginner's idealPace 0.85 m/s and passThreshold 78 already ride
/// ON every row via the existing modeId/passThreshold stamps, so pinning
/// the MODE pins the roadmap's "beginner weights, 0.85 m/s, same bar" with
/// zero new numeric constants.
public let BENCHMARK_MODE_ID = "beginner"

/// BENCHMARK_SHAPE_KIND = "straight" — DEFAULT_SHAPE, the smallest room
/// footprint (every install can produce it) and the only kind with no
/// U-route lateral-sign caveat. Length is deliberately NOT pinned:
/// fit-to-room makes exact length unattainable across rooms, and a length
/// pin would strand the series on every remap. Length drift stays visible
/// to any reader (length ~ meanPaceMps x durationSec, both persisted per
/// row); the copy claims "same mode, same shape, same bar" and no more.
public let BENCHMARK_SHAPE_KIND = "straight"

/// Walk-START benchmark predicate — the recorder stamps `benchmark` with
/// this at beginWalk. Synthetic (Preview Walk auto-pilot) rows are stamped
/// false outright: belt + braces on top of realScoredRows, so a preview run
/// can never enter the improvement series even if a future consumer forgets
/// the synthetic filter. The stamp is captured (not re-derived from
/// modeId+shapeKind at read time) so the DEFINITION can evolve — e.g. a
/// FIT-required benchmark later — without reinterpreting old rows: the
/// modeId/passThreshold stamp law applied forward.
public func benchmarkConfigAtWalkStart(
    _ synthetic: Bool, _ modeId: String?, _ shapeKind: String?
) -> Bool {
    return !synthetic
        && modeId == BENCHMARK_MODE_ID
        && shapeKind == BENCHMARK_SHAPE_KIND
}

/// Finalize-side re-derivation (adjudication §G): the recorder's finalize()
/// applies this AFTER the summary-stamp modeId override, so a mode switched
/// between the beginWalk meta capture and the summary stamp cannot leave a
/// stale benchmark=true on a row whose locked mode is no longer the
/// benchmark mode. shapeKind keeps its walk-start / invalidateShape() value
/// — the shape guard already owns that channel.
public func benchmarkAtFinalize(
    _ stampedBenchmark: Bool?, _ finalModeId: String?
) -> Bool {
    return stampedBenchmark == true && finalModeId == BENCHMARK_MODE_ID
}

// ---------------------------------------------------------------------------
// Benchmark query layer (the improvement series over persisted rows).
// ---------------------------------------------------------------------------

/// BENCHMARK_HEADLINE_SHOWN = 3 — the product's smallest evidence chain is
/// already 3 (MASTERY_PASS_COUNT), the roadmap's own headline exemplar is a
/// 3-step chain ("benchmark 71 -> 79 -> 84"), and 3 three-digit scores +
/// arrows + delta fit the trends side column without wrapping.
public let BENCHMARK_HEADLINE_SHOWN = 3

/// Stamp-trusting: a row is a benchmark row iff row.benchmark === true —
/// NEVER re-derived from modeId+shapeKind at read time. The stamp captures
/// walk-time truth under the definition in force at record time; a future
/// definition change must add a new stamp, not reinterpret old rows.
/// Consequence: a legacy beginner+straight row without the stamp is NOT a
/// benchmark row (it cannot prove the configuration held for the whole
/// walk).
public func isBenchmarkRow(_ row: RepeatRowLike) -> Bool {
    return row.benchmarkValue
}

/// Real scored benchmark rows in the LATEST benchmark row's group,
/// chronological.
///
/// THE GROUP-KEY RULE (adjudication §A): group key = (normalization token
/// via rowNormalization, primarySource, music tempo via rowMusicBpm, walk
/// length via rowWalkSeconds). A re-FIT mints a new normalization token, a
/// sensor change flips primarySource, a tempo switch changes the delivered
/// beat (multi-BPM wave: cadence follows the music by design), and a
/// duration switch changes how much walk the stats summarize (the duration
/// wave) — ANY of the four starts a fresh series: pre- and post-change
/// walks are different rulers or different conditions and must never be
/// read as one improvement story (the tooltip discloses the restart).
/// Synthetic and unscored rows are
/// dropped by realScoredRows before the stamp is even read.
public func benchmarkRows<T: RepeatRowLike>(_ rows: [T]) -> [T] {
    let bench = realScoredRows(rows).filter { isBenchmarkRow($0) }
    if bench.isEmpty { return bench }
    let ref = bench[bench.count - 1]
    let norm = rowNormalization(ref)
    let source = usable(ref.primarySourceValue)
    let bpm = rowMusicBpm(ref)
    let secs = rowWalkSeconds(ref)
    let scale = rowScoreScale(ref)
    return bench.filter {
        rowNormalization($0) == norm
            && usable($0.primarySourceValue) == source
            && rowMusicBpm($0) == bpm
            && rowWalkSeconds($0) == secs
            && rowScoreScale($0) == scale
    }
}

/// Overalls of the last <= max current-group benchmark rows, chronological
/// (sparkline-style). Cap = progress's SERIES_MAX so the product keeps ONE
/// definition of a displayable series length.
public func benchmarkSeries(
    _ rows: [some RepeatRowLike], _ max: Int = SERIES_MAX
) -> [Double] {
    let group = benchmarkRows(rows)
    var out: [Double] = []
    var i = group.count - max
    if i < 0 { i = 0 }
    while i < group.count {
        out.append(group[i].overallValue!)
        i += 1
    }
    return out
}

public struct BenchmarkHeadline {
    /// Benchmark rows in the current (normalization, sensor) group.
    public let walks: Int
    /// Last <= BENCHMARK_HEADLINE_SHOWN overalls, jsRound-ed for display.
    public let shown: [Double]
    /// shown[last] - shown[0] — computed from the ROUNDED shown values so
    /// the claimed delta is self-consistent with the displayed scores.
    public let delta: Double
    /// startedAt (epoch ms) of shown[0]'s row (for "over N weeks" copy).
    public let firstShownAt: Double
    /// startedAt (epoch ms) of the newest group row.
    public let lastAt: Double
}

/// Junk startedAt sorts/reports as 0, never throws (the progress law).
private func startedMsOf(_ row: ProgressRowLike) -> Double {
    let ms = row.startedAtValue
    return ms.isFinite ? ms : 0
}

/// Nil when fewer than 2 rows sit in the current benchmark group — one
/// benchmark walk is a baseline, not a trend (the landing's "one real walk
/// can't trend" precedent).
public func benchmarkHeadline(
    _ rows: [some RepeatRowLike]
) -> BenchmarkHeadline? {
    let group = benchmarkRows(rows)
    if group.count < 2 { return nil }
    var from = group.count - BENCHMARK_HEADLINE_SHOWN
    if from < 0 { from = 0 }
    let shownRows = Array(group[from...])
    let shown = shownRows.map { jsRound($0.overallValue!) }
    return BenchmarkHeadline(
        walks: group.count,
        shown: shown,
        delta: shown[shown.count - 1] - shown[0],
        firstShownAt: startedMsOf(shownRows[0]),
        lastAt: startedMsOf(group[group.count - 1])
    )
}

/// The benchmark headline line (web trends strip; ASCII by construction):
/// "BENCHMARK 71 -> 79 -> 84 (+13)" — delta suffix "(+13)" / "(-4)" /
/// "(EVEN)" for zero (§6 copy). The improvement CAPTION itself lives in
/// BENCHMARK_TOOLTIP, never in this line.
public func benchmarkLine(_ h: BenchmarkHeadline) -> String {
    let d = h.delta
    let suffix =
        d == 0 ? "(EVEN)" : d > 0 ? "(+\(jsIntString(d)))" : "(\(jsIntString(d)))"
    let scores = h.shown.map { jsIntString($0) }.joined(separator: " -> ")
    return "BENCHMARK \(scores) \(suffix)"
}

/// The headline LAW, verbatim (tooltip on the benchmark line) — the ONLY
/// user-facing string in the product allowed the word "improvement": every
/// other series is spread or activity, never progress dressed as
/// like-for-like.
public let BENCHMARK_TOOLTIP =
    "Beginner mode on the straight runway, graded against the same bar every time. Benchmark walks are the only series compared like-for-like, so only these deltas are read as improvement. The series restarts if the scoring sensor, calibration, music tempo, walk duration or scoring scale changes."

// ---------------------------------------------------------------------------
// Repeatability constants (each with its derivation).
// ---------------------------------------------------------------------------

/// Minimum matched walks before ANY consistency claim — settled law (both
/// EDGE-ROADMAP adversaries KEEP the ">= 3 walks under the SAME mode and
/// runway shape" guard). Two walks have one gap; three is the smallest set
/// where "spread" is a property of the set rather than of one pair.
public let REPEAT_MIN_WALKS = 3

/// Window of matched walks the verdict reads. = TREND_WINDOW =
/// MASTERY_WINDOW — the product has ONE definition of "recent"; a second
/// recency constant would let two surfaces disagree about which walks are
/// recent.
public let REPEAT_WINDOW = 5

/// REPEAT_OUTLIER_PCT = 10 (% deviation from the window's pace mean before
/// a walk can be called out).
///
/// Anchored to the product's own pace curve (metrics.ts:674):
///   pace score = 95 - |meanPace - idealPace| * 70   [pts per m/s]
/// A deviation worth a named callout should move the INTEGER score card by
/// an unmistakable margin: 6 points (= 2x the ~3-point move a 5% pace
/// deviation produces: 0.05 * 0.85 m/s * 70 = 2.98 pts).
///   outlierPct = 6 pts / 70 pts-per-mps / 0.85 mps = 0.1008 -> 10%
/// Cross-checks: 10% of the beginner ideal = 0.085 m/s — two orders above
/// the 0.0005 m/s round3 persistence quantization, and a third of the live
/// coach's interrupt bar (PACE_DELTA_CUE_MPS = 0.25 m/s = 29.4% of 0.85): a
/// retrospective note fires easier than a live interruption, as it should.
public let REPEAT_OUTLIER_PCT: Double = 10

/// REPEAT_OUTLIER_DOMINANCE = 2 (largest deviation must be >= 2x the second
/// largest). The callout names ONE walk, so one deviation must DOMINATE: in
/// a uniformly spread window deviations are comparable (n=3 uniform spacing
/// {-d, 0, +d} gives m1/m2 = 1; larger n similar), so no walk is
/// scapegoated; a genuine single outlier against a tight cluster gives
/// ratios far above 2. Two is the smallest integer factor that cleanly
/// separates the regimes.
public let REPEAT_OUTLIER_DOMINANCE: Double = 2

// ---------------------------------------------------------------------------
// Report shapes.
// ---------------------------------------------------------------------------

/// Spread of one relative channel (pace m/s or cadence spm) over the
/// window. Quantization note (documented once for both channels): CVs are
/// computed from round3/round1 persisted values — worst-case contribution
/// ~0.06% (round3 pace: 0.0005/0.85 = 0.059%; round1 cadence: 0.05/~100 =
/// 0.05%), two orders under the 1% display floor. Non-issue.
public struct RepeatChannel {
    /// Rows that voted (finite values > 0).
    public let n: Int
    /// Mean, channel unit (m/s or spm).
    public let mean: Double
    /// SAMPLE standard deviation (Bessel, n-1), channel unit:
    ///   s = sqrt( (1/(n-1)) * SUM_i (v_i - mean)^2 )
    /// Population-vs-sample: at the guard minimum n = 3 the population SD
    /// understates spread by sqrt((n-1)/n) = sqrt(2/3) ~ 0.816 — an ~18%
    /// understatement (at n = 5, sqrt(4/5) ~ 0.894, still 10.6%). A
    /// CONSISTENCY claim must not overstate agreement, so the conservative
    /// (larger) estimator wins. MAD rejected for v1: at n = 3 it collapses
    /// to the middle of three deviations — discarding the very outlier the
    /// verdict exists to name; robustness is instead delivered structurally
    /// by the outlier rule, which EXCLUDES the outlier and reports the
    /// remaining walks' agreement.
    public let sdSample: Double
    /// 100 * sdSample / mean.
    public let cvPct: Double
    /// 100 * max_i |v_i - mean| / mean — the WORST-case relative deviation
    /// from the group mean, i.e. "every walk was within X% of the group's
    /// own average". This (not CV) is the honest mapping of the verdict
    /// phrasing: CV would be a weaker claim dressed in the same words (a 4%
    /// CV admits individual walks ~8%+ out at n=5).
    public let agreementPct: Double
}

/// The named pace outlier (§ outlier rule at REPEAT_OUTLIER_PCT/_DOMINANCE).
public struct RepeatOutlier {
    /// 1-based, chronological within the window.
    public let index: Int
    /// Window size (== report.walks).
    public let count: Int
    /// SIGNED %, vs the mean of the OTHER walks; + = faster.
    public let deltaPct: Double
    /// Max deviation among the others vs THEIR OWN mean, %.
    public let othersAgreementPct: Double
}

public struct RepeatabilityReport {
    /// Qualifying matched rows in the window (>= REPEAT_MIN_WALKS).
    public let walks: Int
    /// The matched conditions (named in the copy, never implied).
    public let modeId: String
    public let shapeKind: String
    /// The window's shared primarySource.
    public let source: String
    public let pace: RepeatChannel?
    public let cadence: RepeatChannel?
    /// Sample SD of meanAbsLateralM, meters — ABSOLUTE, never CV: the mean
    /// legitimately approaches 0 for a good walker and CV divides by it (a
    /// 1 cm spread on a 2 cm mean would read CV 50% while the same 1 cm on
    /// a 10 cm mean reads 10% — punishing precision). Centimeters are the
    /// product's native lateral unit, so the honest dispersion is
    /// s(meanAbsLateralM) in m, shown in whole cm.
    public let lateralSpreadM: Double?
    /// Pace channel only: one sentence can honestly carry one channel, and
    /// pace is the only channel with a mode-anchored meaning (idealPace).
    /// Cadence spread still reports via its CV in detailLine.
    public let outlier: RepeatOutlier?
    /// Landing summary-card sentence (ASCII, XR-safe).
    public let verdictLine: String
    /// XR panel one-liner (ASCII).
    public let compactLine: String
    /// History-panel numbers row (ASCII).
    public let detailLine: String
}

/// The fixed hedge line (tooltip/title on every repeatability surface) —
/// carries the honesty disclosures the verdict sentence cannot: what was
/// matched, and that spread is described, never explained.
public let REPEAT_DISCLOSURE =
    "MEASURED SPREAD ACROSS REPEAT WALKS UNDER THE SAME MODE, SHAPE, SENSOR, TEMPO AND DURATION. IT SHOWS HOW MUCH YOUR WALKS DIFFER, NOT WHY."

// ---------------------------------------------------------------------------
// Display helpers (integer-only interpolation — jsRound/jsIntString match
// the TS Math.round + `${n}` sites).
// ---------------------------------------------------------------------------

/// Display rule for "within X%" claims: max(1, ceil(v)). A within-claim is
/// an UPPER BOUND, so rounding 4.4 down to "within 4%" would be FALSE —
/// ceil is the honest direction. The floor of 1: "within 0%" would claim
/// identity beyond what the persisted quantization supports (round3 pace
/// worst case 0.059% of the beginner ideal, round1 cadence 0.05% of ~100
/// spm — both under half a percent), so 1% is the smallest supportable
/// claim. (Swift .up rounding == JS Math.ceil for the finite values this
/// receives.)
public func withinPct(_ v: Double) -> Double {
    return Swift.max(1, v.rounded(.up))
}

/// CV display: below 1% the persisted quantization owns too much of the
/// number to print it — "UNDER 1%" claims less, honestly.
private func cvText(_ v: Double) -> String {
    return v < 1 ? "UNDER 1%" : "\(jsIntString(jsRound(v)))%"
}

/// Lateral SD display in whole cm; below 1 cm prints "UNDER 1 CM" (round3
/// meters persist at 1 mm steps — tenths of a cm would be false precision).
private func cmText(_ m: Double) -> String {
    let cm = jsRound(m * 100)
    return cm < 1 ? "UNDER 1 CM" : "\(jsIntString(cm)) CM"
}

// ---------------------------------------------------------------------------
// Internal math.
// ---------------------------------------------------------------------------

/// Non-empty string or nil — the "usable stamp" test shared by every group
/// key part (mirrors progress modeBucket's junk test).
private func usable(_ v: String?) -> String? {
    if let v = v, !v.isEmpty { return v }
    return nil
}

private func meanOf(_ values: [Double]) -> Double {
    var sum: Double = 0
    for v in values { sum += v }
    return sum / Double(values.count)
}

/// Bessel sample SD (see RepeatChannel.sdSample for the derivation).
private func sampleSd(_ values: [Double], _ mean: Double) -> Double {
    var sum: Double = 0
    for v in values {
        let d = v - mean
        sum += d * d
    }
    return (sum / Double(values.count - 1)).squareRoot()
}

/// Build one relative channel (caller guarantees values.count >= 1 and
/// every value > 0, so mean > 0 and the divisions are safe).
private func channelOf(_ values: [Double]) -> RepeatChannel {
    let mean = meanOf(values)
    let sd = sampleSd(values, mean)
    var maxDev: Double = 0
    for v in values {
        let d = v < mean ? mean - v : v - mean
        if d > maxDev { maxDev = d }
    }
    return RepeatChannel(
        n: values.count,
        mean: mean,
        sdSample: sd,
        cvPct: (100 * sd) / mean,
        agreementPct: (100 * maxDev) / mean
    )
}

/// The pace outlier rule. Caller guarantees `values` maps 1:1 to the
/// window's walks (every row voted pace) so the 1-based index is
/// unambiguous. Deviations d_i = |v_i - mean|; with m1 >= m2 the two
/// largest, an outlier at k requires BOTH 100*m1/mean >= REPEAT_OUTLIER_PCT
/// and m1 >= REPEAT_OUTLIER_DOMINANCE * m2. A tie for the largest deviation
/// can never pass dominance (m1 == m2), so "which of the tied walks" never
/// needs an answer.
private func paceOutlier(_ values: [Double]) -> RepeatOutlier? {
    let n = values.count
    let mean = meanOf(values)
    var m1: Double = -1
    var m2: Double = -1
    var k = -1
    for i in 0..<n {
        let v = values[i]
        let d = v < mean ? mean - v : v - mean
        if d > m1 {
            m2 = m1
            m1 = d
            k = i
        } else if d > m2 {
            m2 = d
        }
    }
    if (100 * m1) / mean < REPEAT_OUTLIER_PCT { return nil }
    if m1 < REPEAT_OUTLIER_DOMINANCE * m2 { return nil }

    var sumOthers: Double = 0
    for i in 0..<n where i != k { sumOthers += values[i] }
    let meanOthers = sumOthers / Double(n - 1)
    var maxOtherDev: Double = 0
    for i in 0..<n {
        if i == k { continue }
        let d =
            values[i] < meanOthers
            ? meanOthers - values[i] : values[i] - meanOthers
        if d > maxOtherDev { maxOtherDev = d }
    }
    return RepeatOutlier(
        index: k + 1,
        count: n,
        deltaPct: (100 * (values[k] - meanOthers)) / meanOthers,
        othersAgreementPct: (100 * maxOtherDev) / meanOthers
    )
}

// ---------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------

/// Cross-walk consistency over the persisted history rows.
///
/// THE RULE (pinned, golden-enforced):
/// 1. Qualifying set = realScoredRows (synthetic Preview Walk rows and
///    unscored rows can never enter a consistency claim). Trainee scoping
///    is the CALLER's job via rowMatchesTrainee.
/// 2. Reference row = the NEWEST real scored walk — the summary card
///    describes the walk just finished in its own context. Nil when it
///    lacks a usable modeId (junk/empty — mirrors the LEGACY_MODE_BUCKET
///    mastery denial), a usable shapeKind (un-stamped legacy rows cannot
///    prove which shape they walked), or a usable primarySource.
/// 3. Group key = (modeId, shapeKind, primarySource, normalization token
///    via `normOf`, music tempo via rowMusicBpm, walk length via
///    rowWalkSeconds). The normalization rule (cross-cutting Wave 1 law):
///    walks scored under different normalization stamps never aggregate —
///    a re-FIT starts a fresh window. primarySource is in the key for the
///    same reason: head-derived and camera-derived stats are different
///    rulers over the same walker. Tempo (multi-BPM wave): cadence follows
///    the delivered beat by design, so a deliberate tempo switch is a
///    CONDITION change, not inconsistency — mixing 100 and 125 BPM walks
///    would manufacture a cadence spread the trainee never walked.
///    Duration (the duration wave): a 10 s and a 60 s walk summarize
///    different amounts of walking — their stats are not one spread.
///    NOTE (perfect=100 rescale): the repeat WINDOW key is deliberately NOT
///    scale-scoped — its channels are PHYSICAL measurements, identical on
///    either ruler; only raw-overall series (the benchmark) split on
///    rowScoreScale.
/// 4. Window = the last `window` rows of the qualifying set whose key
///    equals the reference key — group-scoped recency across the whole
///    history, NOT consecutive-rows-only; the copy names the conditions
///    ("MATCHED WALKS") and never claims "this session". Fewer than
///    REPEAT_MIN_WALKS -> nil.
/// 5. A row votes a relative channel (pace/cadence) only with a finite
///    value > 0; each channel needs >= REPEAT_MIN_WALKS voters else nil;
///    BOTH nil -> report nil (no relative channel, no verdict). Lateral:
///    sample SD over finite non-negative meanAbsLateralM values, >=
///    REPEAT_MIN_WALKS voters else nil. This is what keeps
///    mixed-measurement histories honest: a camera-image-scored row (all
///    three stats null) simply never votes.
/// 6. Outlier: pace only, and only when EVERY window row voted pace so the
///    1-based indices map to walks (see paceOutlier).
public func repeatabilityReport<T: RepeatRowLike>(
    _ rows: [T],
    _ window: Int = REPEAT_WINDOW,
    _ normOf: NormalizationReader = rowNormalizationFallback
) -> RepeatabilityReport? {
    let real = realScoredRows(rows)
    if real.isEmpty { return nil }

    let ref = real[real.count - 1]
    guard
        let modeId = usable(ref.modeIdValue),
        let shapeKind = usable(ref.shapeKindValue),
        let source = usable(ref.primarySourceValue)
    else { return nil }
    let norm = normOf(ref)
    let bpm = rowMusicBpm(ref)
    let secs = rowWalkSeconds(ref)

    // Group-scoped recency: newest-first scan, then flip to chronological.
    var win: [T] = []
    var i = real.count - 1
    while i >= 0 && win.count < window {
        let r = real[i]
        if usable(r.modeIdValue) == modeId
            && usable(r.shapeKindValue) == shapeKind
            && usable(r.primarySourceValue) == source
            && normOf(r) == norm
            && rowMusicBpm(r) == bpm
            && rowWalkSeconds(r) == secs
        {
            win.append(r)
        }
        i -= 1
    }
    win.reverse()
    if win.count < REPEAT_MIN_WALKS { return nil }

    var paceVals: [Double] = []
    var cadVals: [Double] = []
    var latVals: [Double] = []
    for r in win {
        let s = r.statsValue
        if let p = s?.meanPaceMps, p.isFinite, p > 0 { paceVals.append(p) }
        if let c = s?.cadenceSpm, c.isFinite, c > 0 { cadVals.append(c) }
        if let l = s?.meanAbsLateralM, l.isFinite, l >= 0 { latVals.append(l) }
    }

    let pace = paceVals.count >= REPEAT_MIN_WALKS ? channelOf(paceVals) : nil
    let cadence = cadVals.count >= REPEAT_MIN_WALKS ? channelOf(cadVals) : nil
    if pace == nil && cadence == nil { return nil }
    let lateralSpreadM: Double? =
        latVals.count >= REPEAT_MIN_WALKS
        ? sampleSd(latVals, meanOf(latVals)) : nil
    let outlier: RepeatOutlier? =
        (pace != nil && pace!.n == win.count) ? paceOutlier(paceVals) : nil

    let n = win.count
    return RepeatabilityReport(
        walks: n,
        modeId: modeId,
        shapeKind: shapeKind,
        source: source,
        pace: pace,
        cadence: cadence,
        lateralSpreadM: lateralSpreadM,
        outlier: outlier,
        verdictLine: buildVerdictLine(n, pace, cadence, outlier),
        compactLine: buildCompactLine(n, pace, cadence, outlier),
        detailLine: buildDetailLine(pace, cadence, lateralSpreadM)
    )
}

// ---------------------------------------------------------------------------
// Copy builders (golden-locked prose — adjudication §K "MATCHED WALKS").
// Every branch is exercised by the golden family; strings are ASCII only
// (they reach the XR panel via compactLine).
// ---------------------------------------------------------------------------

private func buildVerdictLine(
    _ n: Int,
    _ pace: RepeatChannel?,
    _ cadence: RepeatChannel?,
    _ outlier: RepeatOutlier?
) -> String {
    if let outlier = outlier {
        let dir = outlier.deltaPct > 0 ? "FASTER" : "SLOWER"
        let d = jsIntString(jsRound(abs(outlier.deltaPct)))
        let aPrime = jsIntString(withinPct(outlier.othersAgreementPct))
        // Newest-walk outlier reads as "this walk broke the streak"; an
        // older outlier reads as a named exception inside an otherwise
        // tight window.
        if outlier.index == n {
            return
                "WALKS 1-\(n - 1) AGREED WITHIN \(aPrime)% ON PACE; WALK \(n) WAS \(d)% \(dir)."
        }
        return
            "WALK \(outlier.index) WAS \(d)% \(dir) ON PACE THAN THE OTHER \(n - 1), WHICH AGREED WITHIN \(aPrime)%."
    }
    if let pace = pace, let cadence = cadence {
        return
            "LAST \(n) MATCHED WALKS AGREED WITHIN \(jsIntString(withinPct(pace.agreementPct)))% ON PACE AND \(jsIntString(withinPct(cadence.agreementPct)))% ON CADENCE."
    }
    if let pace = pace {
        return
            "LAST \(n) MATCHED WALKS AGREED WITHIN \(jsIntString(withinPct(pace.agreementPct)))% ON PACE."
    }
    // repeatabilityReport guarantees pace or cadence non-nil here.
    let c = cadence!
    return
        "LAST \(n) MATCHED WALKS AGREED WITHIN \(jsIntString(withinPct(c.agreementPct)))% ON CADENCE."
}

private func buildCompactLine(
    _ n: Int,
    _ pace: RepeatChannel?,
    _ cadence: RepeatChannel?,
    _ outlier: RepeatOutlier?
) -> String {
    var base: String
    if let pace = pace, let cadence = cadence {
        base =
            "\(n) MATCHED WALKS: PACE SPREAD \(jsIntString(withinPct(pace.agreementPct)))%, CADENCE \(jsIntString(withinPct(cadence.agreementPct)))%"
    } else if let pace = pace {
        base =
            "\(n) MATCHED WALKS: PACE SPREAD \(jsIntString(withinPct(pace.agreementPct)))%"
    } else {
        let c = cadence!
        base =
            "\(n) MATCHED WALKS: CADENCE SPREAD \(jsIntString(withinPct(c.agreementPct)))%"
    }
    if let outlier = outlier {
        let d = jsIntString(jsRound(abs(outlier.deltaPct)))
        base +=
            " - WALK \(outlier.index) \(d)% \(outlier.deltaPct > 0 ? "FAST" : "SLOW")"
    }
    return base
}

private func buildDetailLine(
    _ pace: RepeatChannel?,
    _ cadence: RepeatChannel?,
    _ lateralSpreadM: Double?
) -> String {
    var parts: [String] = []
    if let pace = pace { parts.append("PACE CV \(cvText(pace.cvPct))") }
    if let cadence = cadence {
        parts.append("CADENCE CV \(cvText(cadence.cvPct))")
    }
    if let m = lateralSpreadM {
        // The (HEAD PATH) suffix labels ONLY the centerline quantity — the
        // lateral channel is head-derived (walk-stats); pace/cadence carry
        // no such caveat, so the suffix rides with this segment alone.
        parts.append("CENTER SD \(cmText(m)) (HEAD PATH)")
    }
    return parts.joined(separator: " - ")
}
