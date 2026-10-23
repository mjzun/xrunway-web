//
//  CoachTests.swift — the `coach` family (41 cases: verdict rounding, per-mode
//  bars, note ranking/cap/tiebreak, every directional-honesty gate). Drives
//  buildCoachReport over a CoachContext built from the case input. All coach
//  cases run the .web copy surface (no `copy` field).
//

import XCTest
import XRunwayCore

final class CoachTests: XCTestCase {
    func testCoach() {
        guard let fam = loadFamilyOrFail("coach") else { return }
        XCTAssertEqual(fam.cases.count, 41, "coach case count")
        for c in fam.cases {
            guard let ctx = buildContext(c.input) else {
                XCTFail("coach case '\(c.name)' has malformed input")
                continue
            }
            let report = buildCoachReport(ctx, copy: .web)
            let actual = encodeReport(report)
            assertGolden(actual, c, module: "coach")
        }
    }

    private func buildContext(_ input: JSONValue) -> CoachContext? {
        guard
            let scoresObj = input["scores"]?.asObject,
            let overall = input["overall"]?.asDouble,
            let modeObj = input["mode"]?.asObject,
            let thr = modeObj["passThreshold"]?.asDouble,
            let weightsObj = modeObj["weights"]?.asObject,
            let oneWay = input["oneWayRoute"]?.asBool
        else { return nil }

        var scores: [String: Double] = [:]
        for (k, v) in scoresObj { if let d = v.asDouble { scores[k] = d } }
        var weights: [String: Double] = [:]
        for (k, v) in weightsObj { if let d = v.asDouble { weights[k] = d } }

        let stats = decodeStats(input["stats"])
        return CoachContext(
            scores: scores, overall: overall,
            mode: CoachModeParams(passThreshold: thr, weights: weights),
            stats: stats, oneWayRoute: oneWay)
    }

    private func encodeReport(_ r: CoachReport) -> JSONValue {
        let notes = r.notes.map { n -> JSONValue in
            .object([
                "key": .string(n.key),
                "cue": .string(n.cue),
                "directional": .bool(n.directional),
            ])
        }
        return .object([
            "report": .object([
                "overall": .number(r.overall),
                "passThreshold": .number(r.passThreshold),
                "passed": .bool(r.passed),
                "verdict": .string(r.verdict),
                "notes": .array(notes),
            ])
        ])
    }
}

/// Decode a golden WalkStats object (or null) into a WalkStats. Shared by the
/// coach family. Nullable fields map JSON null -> nil.
func decodeStats(_ v: JSONValue?) -> WalkStats? {
    guard let v = v, !v.isNull, let o = v.asObject else { return nil }
    func opt(_ key: String) -> Double? {
        guard let x = o[key], !x.isNull else { return nil }
        return x.asDouble
    }
    let source = WalkStatsSource(rawValue: o["source"]?.asString ?? "head") ?? .head
    return WalkStats(
        meanPaceMps: opt("meanPaceMps"),
        idealPaceMps: o["idealPaceMps"]?.asDouble ?? 0,
        paceDeltaMps: opt("paceDeltaMps"),
        meanLateralM: opt("meanLateralM"),
        meanAbsLateralM: opt("meanAbsLateralM"),
        postureDriftM: opt("postureDriftM"),
        steps: Int(o["steps"]?.asDouble ?? 0),
        cadenceSpm: opt("cadenceSpm"),
        source: source)
}
