//
//  GoldenHarness.swift — XRunwayCoreTests
//
//  Loads a golden family JSON from the test bundle, exposes the envelope
//  (schema / module / cases), and provides the shared assert-a-case helper
//  plus small encoders turning Swift results back into JSONValue for the
//  §6.5 deep compare.
//

import Foundation
import XCTest
import XRunwayCore

/// One golden case: name + input + expect (both decoded, sentinels resolved).
struct GoldenCase {
    let name: String
    let input: JSONValue
    let expect: JSONValue
}

/// A loaded golden family file.
struct GoldenFile {
    let schema: String
    let module: String
    let cases: [GoldenCase]
}

enum GoldenLoader {
    /// The bundle carrying the golden resources — the test bundle itself.
    /// Resources land at the bundle root (XcodeGen resources build phase).
    static func loadFamily(_ module: String) throws -> GoldenFile {
        let bundle = Bundle(for: BundleAnchor.self)
        guard
            let url = bundle.url(forResource: module, withExtension: "json")
                ?? bundle.url(
                    forResource: module, withExtension: "json",
                    subdirectory: "golden")
        else {
            throw NSError(
                domain: "golden", code: 1,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "golden family \(module).json not found in test bundle \(bundle.bundlePath)"
                ])
        }
        let data = try Data(contentsOf: url)
        let any = try JSONSerialization.jsonObject(with: data, options: [])
        let root = JSONValue.from(any)
        guard
            let schema = root["schema"]?.asString,
            let mod = root["module"]?.asString,
            let caseArr = root["cases"]?.asArray
        else {
            throw NSError(
                domain: "golden", code: 2,
                userInfo: [NSLocalizedDescriptionKey: "malformed envelope for \(module)"])
        }
        let cases = caseArr.map { c in
            GoldenCase(
                name: c["name"]?.asString ?? "<unnamed>",
                input: c["input"] ?? .null,
                expect: c["expect"] ?? .null)
        }
        return GoldenFile(schema: schema, module: mod, cases: cases)
    }
}

/// Anchor class so Bundle(for:) resolves the test bundle.
private final class BundleAnchor {}

// ---------------------------------------------------------------------------
// Shared assertion — compare an actual JSONValue against the case's expect
// under the §6.5 rule; on failure print case name + the diverging path.
// ---------------------------------------------------------------------------

extension XCTestCase {
    func assertGolden(
        _ actual: JSONValue, _ c: GoldenCase, module: String,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        if let d = JSONValue.diff(c.expect, actual) {
            XCTFail(
                "[\(module)] case '\(c.name)' diverged at \(d)",
                file: file, line: line)
        }
    }

    /// Load a family or fail the whole test (missing resource is a build/config
    /// bug, not a scoring divergence).
    func loadFamilyOrFail(
        _ module: String, file: StaticString = #filePath, line: UInt = #line
    ) -> GoldenFile? {
        do {
            let f = try GoldenLoader.loadFamily(module)
            XCTAssertEqual(
                f.schema, "xrunway-golden/1",
                "unexpected schema for \(module)", file: file, line: line)
            return f
        } catch {
            XCTFail("failed to load \(module): \(error)", file: file, line: line)
            return nil
        }
    }
}

// ---------------------------------------------------------------------------
// Encoders — Swift result -> JSONValue for comparison. These build the SAME
// object shapes the TS runners return (golden-replay.ts), so the deep compare
// matches key-for-key.
// ---------------------------------------------------------------------------

enum Enc {
    static func num(_ d: Double) -> JSONValue { .number(d) }
    static func int(_ i: Int) -> JSONValue { .number(Double(i)) }
    static func str(_ s: String) -> JSONValue { .string(s) }
    static func bool(_ b: Bool) -> JSONValue { .bool(b) }

    /// Optional Double -> number or null (JS `x ?? null`).
    static func optNum(_ d: Double?) -> JSONValue {
        guard let d = d else { return .null }
        return .number(d)
    }

    static func arr(_ xs: [JSONValue]) -> JSONValue { .array(xs) }
    static func obj(_ pairs: [String: JSONValue]) -> JSONValue { .object(pairs) }

    /// A WalkStats -> the golden final shape (fields keyed exactly like the TS,
    /// nulls preserved, source as its string).
    static func walkStats(_ s: WalkStats) -> JSONValue {
        return .object([
            "meanPaceMps": optNum(s.meanPaceMps),
            "idealPaceMps": num(s.idealPaceMps),
            "paceDeltaMps": optNum(s.paceDeltaMps),
            "meanLateralM": optNum(s.meanLateralM),
            "meanAbsLateralM": optNum(s.meanAbsLateralM),
            "postureDriftM": optNum(s.postureDriftM),
            "steps": int(s.steps),
            "cadenceSpm": optNum(s.cadenceSpm),
            "source": str(s.source.rawValue),
        ])
    }

    static func optWalkStats(_ s: WalkStats?) -> JSONValue {
        guard let s = s else { return .null }
        return walkStats(s)
    }

    /// The 7-slot target[] -> a JSON array of its f32-quantized values (the
    /// Double() widening of each Float reproduces the emitted number exactly).
    static func targets(_ t: [Float]) -> JSONValue {
        return .array(t.map { .number(Double($0)) })
    }
}
