//
//  WalkStatsTests.swift — the `walk-stats` family (19 ops tapes). Mirrors
//  runWalkStatsOps (golden-replay.ts): replay the ops through a
//  WalkStatsAccumulator, recording finalize() results and readLive snapshots.
//  Shape rule: `lives` rides along only when the tape has >= 1 readLive.
//

import XCTest
import XRunwayCore

final class WalkStatsTests: XCTestCase {
    func testWalkStats() {
        guard let fam = loadFamilyOrFail("walk-stats") else { return }
        XCTAssertEqual(fam.cases.count, 19, "walk-stats case count")
        for c in fam.cases {
            guard let ops = c.input["ops"]?.asArray else {
                XCTFail("walk-stats case '\(c.name)' missing ops")
                continue
            }
            let acc = WalkStatsAccumulator()
            var finals: [JSONValue] = []
            var lives: [JSONValue] = []
            for raw in ops {
                guard let op = raw["op"]?.asString else { continue }
                switch op {
                case "reset":
                    acc.reset(raw["idealPace"]?.asDouble ?? 0)
                case "addPace":
                    acc.addPace(
                        raw["v"]?.asDouble ?? .nan, raw["dt"]?.asDouble ?? .nan)
                case "addLateral":
                    acc.addLateral(
                        raw["v"]?.asDouble ?? .nan, raw["dt"]?.asDouble ?? .nan)
                case "addPosture":
                    acc.addPosture(
                        raw["v"]?.asDouble ?? .nan, raw["dt"]?.asDouble ?? .nan)
                case "addStep":
                    acc.addStep(raw["at"]?.asDouble ?? .nan)
                case "noteSource":
                    let src = WalkStatsSource(
                        rawValue: raw["source"]?.asString ?? "")!
                    acc.noteSource(src, raw["dt"]?.asDouble ?? .nan)
                case "resetLateral":
                    acc.resetLateral()
                case "finalize":
                    let f = acc.finalize(raw["durationSec"]?.asDouble ?? 0)
                    finals.append(Enc.optWalkStats(f))
                case "setLive":
                    acc.livePaceMps = liveVal(raw["pace"])
                    acc.liveLateralM = liveVal(raw["lat"])
                    acc.livePostureM = liveVal(raw["post"])
                case "readLive":
                    lives.append(.object([
                        "pace": Enc.optNum(acc.livePaceMps),
                        "lat": Enc.optNum(acc.liveLateralM),
                        "post": Enc.optNum(acc.livePostureM),
                    ]))
                default:
                    XCTFail("unknown walk-stats op \(op) in '\(c.name)'")
                }
            }
            let actual: JSONValue =
                lives.isEmpty
                ? .object(["finals": .array(finals)])
                : .object(["finals": .array(finals), "lives": .array(lives)])
            assertGolden(actual, c, module: "walk-stats")
        }
    }

    /// A live-tap value in the ops tape is a number (finite OR non-finite via
    /// the sentinel) or JSON null. Null -> nil (clears the channel); a number
    /// (incl. NaN) assigns directly, exactly as MetricsSystem does.
    private func liveVal(_ v: JSONValue?) -> Double? {
        guard let v = v else { return nil }
        if v.isNull { return nil }
        return v.asDouble
    }
}
