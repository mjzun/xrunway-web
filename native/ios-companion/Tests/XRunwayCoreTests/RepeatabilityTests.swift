//
//  RepeatabilityTests.swift — the `repeatability` family (48 cases). Mirrors
//  runRepeatabilityQueries (golden-replay.ts): a row set + a list of queries
//  whose heterogeneous results (reports / rows / series / headlines / strings
//  / bools / null) are encoded back to JSONValue and deep-compared.
//
//  Rows reuse ProgressTests' GoldenRow (the same persisted-history JSON
//  wrapper, echoing its raw JSON back for the row-returning queries),
//  extended here with the M12 fields (stats slice / shapeKind /
//  primarySource / benchmark / normalization / the musicBpm tri-state) —
//  the Swift shape of the TS "RepeatRow extends ProgressRow".
//

import XCTest
import XRunwayCore

extension GoldenRow: RepeatRowLike {
    var statsValue: RepeatStatsSlice? {
        guard let o = raw["stats"]?.asObject else { return nil }
        // typeof === "number" per field (NaN preserved via $num), else nil.
        func num(_ key: String) -> Double? {
            if case .number(let n)? = o[key] { return n }
            return nil
        }
        return RepeatStatsSlice(
            meanPaceMps: num("meanPaceMps"),
            cadenceSpm: num("cadenceSpm"),
            meanAbsLateralM: num("meanAbsLateralM"))
    }

    var shapeKindValue: String? {
        if case .string(let s)? = raw["shapeKind"] { return s }
        return nil
    }

    var primarySourceValue: String? {
        if case .string(let s)? = raw["primarySource"] { return s }
        return nil
    }

    var benchmarkValue: Bool { raw["benchmark"]?.asBool == true }

    /// `row.normalization` when it is a string, else nil (absent/null/junk
    /// — rowNormalization maps it to "default.v1").
    /// `row.scoreScale` when a string (perfect=100 ruler stamp), else nil.
    var scoreScaleValue: String? {
        if case .string(let v)? = raw["scoreScale"] { return v }
        return nil
    }

    var normalizationValue: String? {
        if case .string(let s)? = raw["normalization"] { return s }
        return nil
    }

    /// `row.musicBpm` wire tri-state: missing key -> .absent, JSON null ->
    /// .null, number -> .number (NaN preserved via $num); junk (non-number)
    /// -> .absent, which rowMusicBpm reads as LEGACY_MUSIC_BPM exactly like
    /// the TS junk rule.
    var musicBpmStamp: MusicBpmStamp {
        switch raw["musicBpm"] {
        case .some(.null): return .null
        case .some(.number(let n)): return .number(n)
        default: return .absent
        }
    }

    /// `row.walkSecondsSet` wire tri-state (the duration wave) — the
    /// musicBpmStamp decode exactly; junk -> .absent, which rowWalkSeconds
    /// reads as LEGACY_WALK_SECONDS.
    var walkSecondsStamp: WalkSecondsStamp {
        switch raw["walkSecondsSet"] {
        case .some(.null): return .null
        case .some(.number(let n)): return .number(n)
        default: return .absent
        }
    }
}

final class RepeatabilityTests: XCTestCase {
    // -----------------------------------------------------------------
    // The multi-BPM tempo law — hand-mirrored from the "music tempo
    // stamp" describe block in test/repeatability.test.ts. The golden
    // family stays frozen at its 48 legacy-shaped cases (every fixture
    // row is musicBpm-ABSENT, so the vectors rebuilt byte-identical when
    // tempo joined the group key); the split behavior is therefore
    // covered by paired unit tests on both sides instead.
    // -----------------------------------------------------------------

    /// walkRow(i)-shaped wire row (repeat-helpers.ts defaults) with a
    /// pace-only stats slice and an optional literal musicBpm wire value
    /// (nil = key absent, the legacy shape).
    private func tempoRow(
        _ i: Int, _ musicBpm: JSONValue?, pace: Double, benchmark: Bool = false
    ) -> GoldenRow {
        var obj: [String: JSONValue] = [
            "startedAt": .number(Double(1000 + i * 60_000)),
            "overall": .number(80),
            "modeId": .string("beginner"),
            "passThreshold": .number(78),
            "shapeKind": .string("straight"),
            "primarySource": .string("head"),
            "stats": .object([
                "meanPaceMps": .number(pace),
                "cadenceSpm": .null,
                "meanAbsLateralM": .null,
            ]),
        ]
        if benchmark { obj["benchmark"] = .bool(true) }
        if let bpm = musicBpm { obj["musicBpm"] = bpm }
        return GoldenRow(raw: .object(obj))
    }

    func testRowMusicBpmLaw() {
        // Absent reads the deleted build constant; explicit null stays nil;
        // a finite number passes through; junk (string/NaN) reads legacy.
        XCTAssertEqual(rowMusicBpm(tempoRow(0, nil, pace: 0.85)), LEGACY_MUSIC_BPM)
        XCTAssertNil(rowMusicBpm(tempoRow(0, .null, pace: 0.85)))
        XCTAssertEqual(rowMusicBpm(tempoRow(0, .number(100), pace: 0.85)), 100)
        XCTAssertEqual(
            rowMusicBpm(tempoRow(0, .string("fast"), pace: 0.85)), LEGACY_MUSIC_BPM)
        XCTAssertEqual(
            rowMusicBpm(tempoRow(0, .number(.nan), pace: 0.85)), LEGACY_MUSIC_BPM)
    }

    func testTempoSwitchSplitsTheWindow() {
        // 3 walks at 100 then 2 at 125: the newest row anchors the 125
        // group, 2 < REPEAT_MIN_WALKS -> no verdict — a deliberate tempo
        // change is a fresh series, never "cadence inconsistency".
        let rows = [
            tempoRow(0, .number(100), pace: 0.84),
            tempoRow(1, .number(100), pace: 0.85),
            tempoRow(2, .number(100), pace: 0.86),
            tempoRow(3, .number(125), pace: 0.99),
            tempoRow(4, .number(125), pace: 1.01),
        ]
        XCTAssertNil(repeatabilityReport(rows))
        // A third 125 walk re-opens the verdict on the 125 series alone.
        let report = repeatabilityReport(rows + [tempoRow(5, .number(125), pace: 1.0)])
        XCTAssertEqual(report?.walks, 3)
        XCTAssertEqual(report?.pace?.mean ?? .nan, 1.0, accuracy: 1e-12)
    }

    func testLegacyAbsentMergesWithExplicit122AndNullMatchesOnlyNull() {
        // Absent and a literal 122 are ONE series (the same constant
        // delivered both) …
        let legacy = [
            tempoRow(0, nil, pace: 0.84),
            tempoRow(1, .number(122), pace: 0.85),
            tempoRow(2, nil, pace: 0.86),
        ]
        XCTAssertEqual(repeatabilityReport(legacy)?.walks, 3)
        // … while explicit null matches only null: the absent (=122) row
        // never joins the null-anchored window.
        let nulls = [
            tempoRow(0, nil, pace: 0.84),
            tempoRow(1, .null, pace: 0.85),
            tempoRow(2, .null, pace: 0.86),
            tempoRow(3, .null, pace: 0.85),
        ]
        XCTAssertEqual(repeatabilityReport(nulls)?.walks, 3)
    }

    func testBenchmarkTempoChangeStartsAFreshSeries() {
        let rows = [
            tempoRow(0, .number(100), pace: 0.85, benchmark: true),
            tempoRow(1, .number(100), pace: 0.85, benchmark: true),
            tempoRow(2, .number(125), pace: 0.85, benchmark: true),
        ]
        // The newest benchmark row's tempo owns the series: one 125 walk is
        // a baseline, not a trend.
        XCTAssertEqual(benchmarkRows(rows).count, 1)
        XCTAssertNil(benchmarkHeadline(rows))
    }

    // -----------------------------------------------------------------
    // The walk-duration law (the duration wave) — hand-mirrored from the
    // "walk-duration stamp" describe block in test/repeatability.test.ts;
    // the tempo suite's twin. The golden family stays frozen (every
    // fixture row is walkSecondsSet-ABSENT).
    // -----------------------------------------------------------------

    /// tempoRow with an optional literal walkSecondsSet wire value
    /// (nil = key absent, the pre-duration-wave shape).
    private func durationRow(
        _ i: Int, _ secs: JSONValue?, pace: Double, benchmark: Bool = false
    ) -> GoldenRow {
        guard case .object(var obj) = tempoRow(
            i, .number(100), pace: pace, benchmark: benchmark
        ).raw else { fatalError("tempoRow is always an object") }
        if let secs = secs { obj["walkSecondsSet"] = secs }
        return GoldenRow(raw: .object(obj))
    }

    func testRowWalkSecondsLaw() {
        // Absent reads the legacy 20; explicit null stays nil; a finite
        // number passes through; junk (string/NaN) reads legacy.
        XCTAssertEqual(
            rowWalkSeconds(durationRow(0, nil, pace: 0.85)), LEGACY_WALK_SECONDS)
        XCTAssertNil(rowWalkSeconds(durationRow(0, .null, pace: 0.85)))
        XCTAssertEqual(rowWalkSeconds(durationRow(0, .number(45), pace: 0.85)), 45)
        XCTAssertEqual(
            rowWalkSeconds(durationRow(0, .string("long"), pace: 0.85)),
            LEGACY_WALK_SECONDS)
        XCTAssertEqual(
            rowWalkSeconds(durationRow(0, .number(.nan), pace: 0.85)),
            LEGACY_WALK_SECONDS)
        XCTAssertEqual(LEGACY_WALK_SECONDS, 20)
    }

    func testDurationSwitchSplitsTheWindow() {
        // 3 walks at the 20 s default then 2 at 45 s: the newest row
        // anchors the 45 s group, 2 < REPEAT_MIN_WALKS -> no verdict.
        let rows = [
            durationRow(0, .number(20), pace: 0.84),
            durationRow(1, .number(20), pace: 0.85),
            durationRow(2, .number(20), pace: 0.86),
            durationRow(3, .number(45), pace: 0.99),
            durationRow(4, .number(45), pace: 1.01),
        ]
        XCTAssertNil(repeatabilityReport(rows))
        // A third 45 s walk re-opens the verdict on the 45 s series alone.
        let report = repeatabilityReport(rows + [durationRow(5, .number(45), pace: 1.0)])
        XCTAssertEqual(report?.walks, 3)
        XCTAssertEqual(report?.pace?.mean ?? .nan, 1.0, accuracy: 1e-12)
    }

    func testLegacyAbsentMergesWithExplicit20AndNullMatchesOnlyNull() {
        // Absent and a literal 20 are ONE series (post-4ac430a every walk
        // locked 20 s — the LEGACY_WALK_SECONDS read law) …
        let legacy = [
            durationRow(0, nil, pace: 0.84),
            durationRow(1, .number(20), pace: 0.85),
            durationRow(2, nil, pace: 0.86),
        ]
        XCTAssertEqual(repeatabilityReport(legacy)?.walks, 3)
        // … while explicit null matches only null.
        let nulls = [
            durationRow(0, nil, pace: 0.84),
            durationRow(1, .null, pace: 0.85),
            durationRow(2, .null, pace: 0.86),
            durationRow(3, .null, pace: 0.85),
        ]
        XCTAssertEqual(repeatabilityReport(nulls)?.walks, 3)
    }

    func testBenchmarkDurationChangeStartsAFreshSeries() {
        let rows = [
            durationRow(0, .number(20), pace: 0.85, benchmark: true),
            durationRow(1, .number(20), pace: 0.85, benchmark: true),
            durationRow(2, .number(45), pace: 0.85, benchmark: true),
        ]
        // The newest benchmark row's length owns the series: one 45 s walk
        // is a baseline, not a trend.
        XCTAssertEqual(benchmarkRows(rows).count, 1)
        XCTAssertNil(benchmarkHeadline(rows))
    }

    func testRepeatability() {
        guard let fam = loadFamilyOrFail("repeatability") else { return }
        XCTAssertEqual(fam.cases.count, 48, "repeatability case count")
        for c in fam.cases {
            let rows = (c.input["rows"]?.asArray ?? []).map { GoldenRow(raw: $0) }
            guard let queries = c.input["queries"]?.asArray else {
                XCTFail("repeatability case '\(c.name)' missing queries")
                continue
            }
            var results: [JSONValue] = []
            for q in queries {
                results.append(runQuery(q, rows: rows, name: c.name))
            }
            let actual = Enc.obj(["results": .array(results)])
            assertGolden(actual, c, module: "repeatability")
        }
    }

    private func runQuery(
        _ q: JSONValue, rows: [GoldenRow], name: String
    ) -> JSONValue {
        let fn = q["fn"]?.asString ?? ""
        let args = q["args"] ?? .object([:])
        switch fn {
        case "repeatabilityReport":
            if let w = args["window"]?.asDouble {
                return encodeReport(repeatabilityReport(rows, Int(w)))
            }
            return encodeReport(repeatabilityReport(rows))
        case "isBenchmarkRow":
            return .bool(isBenchmarkRow(GoldenRow(raw: args["row"] ?? .null)))
        case "benchmarkRows":
            return .array(benchmarkRows(rows).map { $0.raw })
        case "benchmarkSeries":
            if let m = args["max"]?.asDouble {
                return .array(benchmarkSeries(rows, Int(m)).map { .number($0) })
            }
            return .array(benchmarkSeries(rows).map { .number($0) })
        case "benchmarkHeadline":
            return encodeHeadline(benchmarkHeadline(rows))
        case "benchmarkLine":
            // The line is a pure function of the headline; deriving it from
            // the case's own rows keeps the query data-only (the TS runner).
            guard let h = benchmarkHeadline(rows) else { return .null }
            return .string(benchmarkLine(h))
        case "benchmarkConfigAtWalkStart":
            return .bool(
                benchmarkConfigAtWalkStart(
                    args["synthetic"]?.asBool == true,
                    args["modeId"]?.asString,
                    args["shapeKind"]?.asString))
        case "benchmarkAtFinalize":
            // An absent `stamped` key deliberately reads as nil/undefined
            // (the legacy wire shape the predicate must reject).
            return .bool(
                benchmarkAtFinalize(
                    args["stamped"]?.asBool, args["modeId"]?.asString))
        case "withinPct":
            return .number(withinPct(args["v"]?.asDouble ?? .nan))
        case "rowNormalization":
            return .string(
                rowNormalizationFallback(GoldenRow(raw: args["row"] ?? .null)))
        case "constants":
            return .object([
                "REPEAT_MIN_WALKS": Enc.int(REPEAT_MIN_WALKS),
                "REPEAT_WINDOW": Enc.int(REPEAT_WINDOW),
                "REPEAT_OUTLIER_PCT": .number(REPEAT_OUTLIER_PCT),
                "REPEAT_OUTLIER_DOMINANCE": .number(REPEAT_OUTLIER_DOMINANCE),
                "REPEAT_DISCLOSURE": .string(REPEAT_DISCLOSURE),
                "DEFAULT_NORMALIZATION": .string(DEFAULT_NORMALIZATION),
                "BENCHMARK_MODE_ID": .string(BENCHMARK_MODE_ID),
                "BENCHMARK_SHAPE_KIND": .string(BENCHMARK_SHAPE_KIND),
                "BENCHMARK_HEADLINE_SHOWN": Enc.int(BENCHMARK_HEADLINE_SHOWN),
                "BENCHMARK_TOOLTIP": .string(BENCHMARK_TOOLTIP),
            ])
        default:
            XCTFail("unknown repeatability query \(fn) in '\(name)'")
            return .null
        }
    }

    private func encodeChannel(_ c: RepeatChannel?) -> JSONValue {
        guard let c = c else { return .null }
        return .object([
            "n": Enc.int(c.n),
            "mean": .number(c.mean),
            "sdSample": .number(c.sdSample),
            "cvPct": .number(c.cvPct),
            "agreementPct": .number(c.agreementPct),
        ])
    }

    private func encodeOutlier(_ o: RepeatOutlier?) -> JSONValue {
        guard let o = o else { return .null }
        return .object([
            "index": Enc.int(o.index),
            "count": Enc.int(o.count),
            "deltaPct": .number(o.deltaPct),
            "othersAgreementPct": .number(o.othersAgreementPct),
        ])
    }

    private func encodeReport(_ r: RepeatabilityReport?) -> JSONValue {
        guard let r = r else { return .null }
        return .object([
            "walks": Enc.int(r.walks),
            "modeId": .string(r.modeId),
            "shapeKind": .string(r.shapeKind),
            "source": .string(r.source),
            "pace": encodeChannel(r.pace),
            "cadence": encodeChannel(r.cadence),
            "lateralSpreadM": Enc.optNum(r.lateralSpreadM),
            "outlier": encodeOutlier(r.outlier),
            "verdictLine": .string(r.verdictLine),
            "compactLine": .string(r.compactLine),
            "detailLine": .string(r.detailLine),
        ])
    }

    private func encodeHeadline(_ h: BenchmarkHeadline?) -> JSONValue {
        guard let h = h else { return .null }
        return .object([
            "walks": Enc.int(h.walks),
            "shown": .array(h.shown.map { .number($0) }),
            "delta": .number(h.delta),
            "firstShownAt": .number(h.firstShownAt),
            "lastAt": .number(h.lastAt),
        ])
    }
}
