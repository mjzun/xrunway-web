//
//  TablesTests.swift — the `coach-tables` (2 cases) and `copy-variants` (5
//  cases) families. Byte-compare the emitted tables against the Swift
//  constants and the copy-variant substitution table.
//

import XCTest
import XRunwayCore

final class TablesTests: XCTestCase {

    // -- coach-tables ---------------------------------------------------------

    func testCoachTables() {
        guard let fam = loadFamilyOrFail("coach-tables") else { return }
        XCTAssertEqual(fam.cases.count, 2, "coach-tables case count")
        for c in fam.cases {
            let actual: JSONValue
            switch c.name {
            case "copy-and-earcon-tables":
                actual = copyAndEarconTables()
            case "solo-cue-thresholds":
                actual = soloCueThresholds()
            default:
                XCTFail("unknown coach-tables case '\(c.name)'")
                continue
            }
            assertGolden(actual, c, module: "coach-tables")
        }
    }

    private func strDict(_ d: [String: String]) -> JSONValue {
        var out: [String: JSONValue] = [:]
        for (k, v) in d { out[k] = .string(v) }
        return .object(out)
    }

    private func copyAndEarconTables() -> JSONValue {
        var earcons: [String: JSONValue] = [:]
        for (k, e) in COACH_EARCONS {
            earcons[k] = .object([
                "notes": .array([.number(e.notes.0), .number(e.notes.1)]),
                "span": .number(e.span),
                "decay": .number(e.decay),
                "glide": .bool(e.glide),
            ])
        }
        return .object([
            "METRIC_EXPLAIN": strDict(METRIC_EXPLAIN),
            "METRIC_COACH": strDict(METRIC_COACH),
            "CLEAN_WALK_CUE": .string(CLEAN_WALK_CUE),
            "LIVE_CUE_TEXT": strDict(LIVE_CUE_TEXT),
            "COACH_EARCONS": .object(earcons),
            "COACH_EARCON_LEVEL": .number(COACH_EARCON_LEVEL),
        ])
    }

    private func soloCueThresholds() -> JSONValue {
        return .object([
            "PACE_DELTA_CUE_MPS": .number(PACE_DELTA_CUE_MPS),
            "SOLO_LATERAL_CUE_M": .number(SOLO_LATERAL_CUE_M),
            "SOLO_POSTURE_CUE_M": .number(SOLO_POSTURE_CUE_M),
            "SOLO_POSTURE_SLOPE": .number(SOLO_POSTURE_SLOPE),
            "SOLO_HEADING_STABLE_MIN": .number(SOLO_HEADING_STABLE_MIN),
            "SOLO_LATERAL_BASELINE_SEC": .number(SOLO_LATERAL_BASELINE_SEC),
            "SOLO_GAP_SEC": .number(SOLO_GAP_SEC),
            "SOLO_TURN_EXCLUDE_SEC": .number(SOLO_TURN_EXCLUDE_SEC),
            "SOLO_LATERAL_CUE_SMOOTH_RATE": .number(SOLO_LATERAL_CUE_SMOOTH_RATE),
        ])
    }

    // -- copy-variants --------------------------------------------------------

    func testCopyVariants() {
        guard let fam = loadFamilyOrFail("copy-variants") else { return }
        XCTAssertEqual(fam.cases.count, 5, "copy-variants case count")
        // Build a lookup keyed by "surface:key" from SOLO_COPY_VARIANTS.
        var table: [String: CopyVariant] = [:]
        for v in SOLO_COPY_VARIANTS {
            table["\(v.surface):\(v.key)"] = v
        }
        for c in fam.cases {
            guard
                let surface = c.input["surface"]?.asString,
                let key = c.input["key"]?.asString
            else {
                XCTFail("copy-variants case '\(c.name)' missing surface/key")
                continue
            }
            guard let v = table["\(surface):\(key)"] else {
                XCTFail("copy-variants case '\(c.name)' has no matching variant")
                continue
            }
            let actual = Enc.obj([
                "web": Enc.str(v.web),
                "solo": Enc.str(v.solo),
            ])
            assertGolden(actual, c, module: "copy-variants")
        }
    }
}
