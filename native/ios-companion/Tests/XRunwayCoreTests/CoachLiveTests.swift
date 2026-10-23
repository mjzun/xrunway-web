//
//  CoachLiveTests.swift — the `coach-live` family (event tapes). Mirrors
//  runLiveEvents (golden-replay.ts): replay the 0.5 s-grid timeline through a
//  LiveCoachPolicy (.web copy; gates per the case's `gates` tag — absent =
//  web, "solo" = SOLO_CUE_GATES), applying reset/clearFaults ops and sampling
//  decideLiveCue on sample events. Records fired cues as {t, kind, text}.
//

import XCTest
import XRunwayCore

final class CoachLiveTests: XCTestCase {
    func testCoachLive() {
        guard let fam = loadFamilyOrFail("coach-live") else { return }
        XCTAssertEqual(fam.cases.count, 47, "coach-live case count")
        var soloGateCases = 0
        for c in fam.cases {
            guard let events = c.input["events"]?.asArray else {
                XCTFail("coach-live case '\(c.name)' missing events")
                continue
            }
            // The gates tag mirrors gatesFor (golden-replay.ts): absent/web
            // -> web gates, "solo" -> the §3 re-derived set.
            let gates: LiveCueGates
            switch c.input["gates"]?.asString {
            case nil, "web":
                gates = WEB_CUE_GATES
            case "solo":
                gates = SOLO_CUE_GATES
                soloGateCases += 1
            case let tag?:
                XCTFail("unknown cue-gates tag \(tag) in '\(c.name)'")
                continue
            }
            let policy = LiveCoachPolicy(gates: gates)
            var cues: [JSONValue] = []
            for ev in events {
                if let op = ev["op"]?.asString {
                    switch op {
                    case "reset": policy.reset()
                    case "clearFaults": policy.clearFaults()
                    default:
                        XCTFail("unknown coach-live op \(op) in '\(c.name)'")
                    }
                    continue
                }
                guard
                    let t = ev["t"]?.asDouble,
                    let sample = ev["sample"]
                else {
                    XCTFail("coach-live event malformed in '\(c.name)'")
                    continue
                }
                let input = decodeLiveInput(sample)
                if let cue = policy.decideLiveCue(input, t) {
                    cues.append(.object([
                        "t": .number(t),
                        "kind": .string(cue.kind.rawValue),
                        "text": .string(cue.text),
                    ]))
                }
            }
            let actual = Enc.obj(["cues": .array(cues)])
            assertGolden(actual, c, module: "coach-live")
        }
        // The solo-gate differentials must actually be exercised — a
        // generator change that drops the tag would silently run everything
        // under web gates.
        XCTAssertEqual(soloGateCases, 5, "solo-gate case count")
    }
}

/// Decode a coach-live `sample` object into a LiveCueInput. Nullable channels
/// map JSON null -> nil; a non-finite (sentinel) number is preserved so the
/// policy's isFinite honesty gate is exercised exactly.
func decodeLiveInput(_ s: JSONValue) -> LiveCueInput {
    func optNum(_ key: String) -> Double? {
        guard let v = s[key], !v.isNull else { return nil }
        return v.asDouble
    }
    return LiveCueInput(
        walking: s["walking"]?.asBool ?? false,
        // An ABSENT walkRemainingSec is TS `undefined`, and `undefined <=
        // FINAL_GUARD_SEC` is FALSE — the clock half of the final guard is
        // skipped, not tripped. Mirror that with .infinity (which correctly
        // fails `<= FINAL_GUARD_SEC`); coercing to 0 would FALSELY block the
        // cue. Pinned by the `absent-walk-remaining-skips-clock-guard` case.
        walkRemainingSec: s["walkRemainingSec"]?.asDouble ?? .infinity,
        markAtSec: optNum("markAtSec"),
        walkProgress01: s["walkProgress01"]?.asDouble ?? 0,
        oneWayRoute: s["oneWayRoute"]?.asBool ?? false,
        paceDeltaMps: optNum("paceDeltaMps"),
        absLateralM: optNum("absLateralM"),
        postureM: optNum("postureM"))
}
