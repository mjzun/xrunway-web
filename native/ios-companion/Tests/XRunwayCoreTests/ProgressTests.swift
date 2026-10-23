//
//  ProgressTests.swift — the `progress` family (22 cases). Mirrors
//  runProgressQueries (golden-replay.ts): a row set + a list of queries whose
//  heterogeneous results (rows / structs / scalars / bools / null) are encoded
//  back to JSONValue and deep-compared.
//
//  Rows come from persisted history so every field can be absent/null/junk;
//  GoldenRow wraps the raw JSONValue and exposes JS-semantics views
//  (Number()-coerced startedAt, number-or-nil overall, etc.) AND echoes its
//  original JSON back for the row-returning queries (realScoredRows /
//  filterHistoryRows), exactly as the TS runner does.
//

import XCTest
import XRunwayCore

/// JS `Number(x)` for the values the vectors carry (number / string / bool /
/// null / absent). Junk strings -> NaN; null -> 0; absent -> NaN.
private func jsNumber(_ v: JSONValue?) -> Double {
    guard let v = v else { return .nan }  // undefined -> NaN
    switch v {
    case .null: return 0  // Number(null) === 0
    case .number(let n): return n
    case .bool(let b): return b ? 1 : 0
    case .string(let s):
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return 0 }  // Number("") === 0
        return Double(trimmed) ?? .nan
    default: return .nan
    }
}

/// A history row backed by its raw golden JSON.
struct GoldenRow: ProgressRowLike {
    let raw: JSONValue

    var startedAtValue: Double { jsNumber(raw["startedAt"]) }

    var overallValue: Double? {
        // typeof === "number" (NaN preserved), else nil.
        if case .number(let n)? = raw["overall"] { return n }
        return nil
    }

    var syntheticFlag: Bool { raw["synthetic"]?.asBool == true }

    var finalScoresValue: [String: Double]? {
        guard let o = raw["finalScores"]?.asObject else { return nil }
        var out: [String: Double] = [:]
        for (k, v) in o { if case .number(let n) = v { out[k] = n } }
        return out
    }

    var modeIdValue: String? {
        if case .string(let s)? = raw["modeId"] { return s }
        return nil
    }

    var passThresholdValue: Double? {
        if case .number(let n)? = raw["passThreshold"] { return n }
        return nil
    }

    var traineeValue: RowTrainee {
        guard let t = raw["trainee"] else { return .absent }
        if t.isNull { return .null }
        guard let o = t.asObject else { return .junk }
        if case .string(let id)? = o["id"] { return .id(id) }
        return .junk
    }
}

final class ProgressTests: XCTestCase {
    func testProgress() {
        guard let fam = loadFamilyOrFail("progress") else { return }
        XCTAssertEqual(fam.cases.count, 24, "progress case count")
        for c in fam.cases {
            let rows = (c.input["rows"]?.asArray ?? []).map { GoldenRow(raw: $0) }
            guard let queries = c.input["queries"]?.asArray else {
                XCTFail("progress case '\(c.name)' missing queries")
                continue
            }
            var results: [JSONValue] = []
            for q in queries {
                results.append(runQuery(q, rows: rows, name: c.name))
            }
            let actual = Enc.obj(["results": .array(results)])
            assertGolden(actual, c, module: "progress")
        }
    }

    private func runQuery(
        _ q: JSONValue, rows: [GoldenRow], name: String
    ) -> JSONValue {
        let fn = q["fn"]?.asString ?? ""
        let args = q["args"] ?? .object([:])
        switch fn {
        case "realScoredRows":
            return .array(realScoredRows(rows).map { $0.raw })
        case "personalBest":
            return encodeBest(personalBest(rows))
        case "rollingAverage":
            let values = numArg(args, "values")
            if let w = args["window"]?.asDouble {
                return Enc.optNum(rollingAverage(values, Int(w)))
            }
            return Enc.optNum(rollingAverage(values))
        case "trendDelta":
            let values = numArg(args, "values")
            if let w = args["window"]?.asDouble {
                return Enc.optNum(trendDelta(values, Int(w)))
            }
            return Enc.optNum(trendDelta(values))
        case "overallSeries":
            if let m = args["max"]?.asDouble {
                return .array(overallSeries(rows, Int(m)).map { .number($0) })
            }
            return .array(overallSeries(rows).map { .number($0) })
        case "metricTrends":
            return encodeMetricTrends(metricTrends(rows))
        case "latestIsPersonalBest":
            return .bool(latestIsPersonalBest(rows))
        case "modeStats":
            return .array(modeStats(rows).map { encodeModeStats($0) })
        case "masteryJustEarned":
            let modeId = args["modeId"]?.asString
            return .bool(masteryJustEarned(rows, modeId))
        case "progressReport":
            return encodeReport(progressReport(rows))
        case "rowPassed":
            return .bool(rowPassed(GoldenRow(raw: args["row"] ?? .null)))
        case "rowPassThreshold":
            return .number(rowPassThreshold(GoldenRow(raw: args["row"] ?? .null)))
        case "isSyntheticRow":
            return .bool(isSyntheticRow(GoldenRow(raw: args["row"] ?? .null)))
        case "rowMatchesTrainee":
            let tid = args["traineeId"]?.asString
            return .bool(
                rowMatchesTrainee(GoldenRow(raw: args["row"] ?? .null), tid))
        case "filterHistoryRows":
            let filter = HistoryFilter(rawValue: args["filter"]?.asString ?? "all")!
            return .array(filterHistoryRows(rows, filter).map { $0.raw })
        default:
            XCTFail("unknown progress query \(fn) in '\(name)'")
            return .null
        }
    }

    private func numArg(_ args: JSONValue, _ key: String) -> [Double] {
        return (args[key]?.asArray ?? []).compactMap { $0.asDouble }
    }

    private func encodeBest(_ b: PersonalBest?) -> JSONValue {
        guard let b = b else { return .null }
        return .object([
            "overall": .number(b.overall),
            "startedAt": .number(b.startedAt),
        ])
    }

    private func encodeMetricTrends(_ t: [String: Double?]) -> JSONValue {
        var out: [String: JSONValue] = [:]
        for (k, v) in t { out[k] = Enc.optNum(v ?? nil) }
        return .object(out)
    }

    private func encodeModeStats(_ m: ModeStats) -> JSONValue {
        return .object([
            "modeId": .string(m.modeId),
            "walks": .number(Double(m.walks)),
            "best": .number(m.best),
            "last": .number(m.last),
            "passed": .number(Double(m.passed)),
            "mastered": .bool(m.mastered),
        ])
    }

    private func encodeReport(_ r: ProgressReport) -> JSONValue {
        return .object([
            "walks": .number(Double(r.walks)),
            "series": .array(r.series.map { .number($0) }),
            "best": encodeBest(r.best),
            "rollingAvg": Enc.optNum(r.rollingAvg),
            "overallTrend": Enc.optNum(r.overallTrend),
            "metricTrends": encodeMetricTrends(r.metricTrends),
            "newBest": .bool(r.newBest),
        ])
    }
}
