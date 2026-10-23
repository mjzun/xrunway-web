//
//  SoloReplayTests.swift — the `walk-replay-solo` family (4 cases: 30/60 Hz,
//  each raw + @rigid37). UNLIKE WalkReplayTests (a test-local loop mirror),
//  this drives the PRODUCTION SoloWalkCore: frames + the tape's ground-truth
//  marks in through the engine's own doors (beginWalk / setMark / ingest /
//  finish), the emitted snapshot/cue/rollup expectations out — the engine
//  ASSEMBLY itself sits under the drift lock.
//
//  Copy rule (SOLO-MODE §5 / coach-copy.ts): the vectors carry WEB strings;
//  the core renders the SOLO surface. The expected strings are transformed
//  web -> solo through the vector-locked `copy-variants` family (exact rows
//  plus the {cm}/{side} template rows) BEFORE exact comparison — the
//  documented consumption rule, driven by data, never hand-copied strings.
//
//  Clock rule: the tape's per-frame walkTime IS the monotonic capture
//  timestamp fed to ingest (beginWalk at 0), so every accumulator sees the
//  exact doubles the TS runner folded — bitwise-followable, no tolerance
//  games at publish/sample boundaries.
//

import XCTest
import XRunwayCore

final class SoloReplayTests: XCTestCase {
    func testWalkReplaySolo() {
        guard let fam = loadFamilyOrFail("walk-replay-solo") else { return }
        XCTAssertEqual(fam.cases.count, 4, "walk-replay-solo case count")
        guard let variants = loadFamilyOrFail("copy-variants") else { return }
        guard let soloize = SoloCopySubstitution(variants) else {
            XCTFail("copy-variants family malformed")
            return
        }
        for c in fam.cases {
            guard let actual = runCore(c.input, name: c.name) else { continue }
            let expected = soloize.transformExpect(c.expect)
            if let d = JSONValue.diff(expected, actual) {
                XCTFail("[walk-replay-solo] case '\(c.name)' diverged at \(d)")
            }
        }
    }

    // -- the production-core drive --------------------------------------------

    private func runCore(_ input: JSONValue, name: String) -> JSONValue? {
        guard
            let idealPace = input["idealPace"]?.asDouble,
            let passThreshold = input["passThreshold"]?.asDouble,
            let walkSeconds = input["walkSeconds"]?.asDouble,
            let weightsObj = input["weights"]?.asObject,
            let frames = input["frames"]?.asArray,
            let marksArr = input["marks"]?.asArray
        else {
            XCTFail("walk-replay-solo '\(name)' malformed input")
            return nil
        }
        var weights: [String: Double] = [:]
        for (k, v) in weightsObj { if let d = v.asDouble { weights[k] = d } }
        let mode = TrainingMode(
            id: input["modeId"]?.asString ?? "beginner",
            number: "", label: "", tagline: "", greeting: "", instruction: "",
            walkSeconds: walkSeconds, idealPace: idealPace,
            passThreshold: passThreshold, weights: weights, intensity: 0)

        let core = SoloWalkCore(mode: mode)
        var snapshots: [JSONValue] = []
        var cues: [JSONValue] = []
        core.onSnapshot = { t, scores in
            var o: [String: JSONValue] = ["t": .number(t)]
            for key in METRIC_ORDER { o[key] = .number(scores[key] ?? 0) }
            snapshots.append(.object(o))
        }
        core.onCue = { cue in
            cues.append(.object([
                "t": .number(core.walkTime),
                "kind": .string(cue.kind.rawValue),
                "text": .string(cue.text),
            ]))
        }
        core.beginWalk(atMono: 0)

        var nextMark = 0
        for (i, f) in frames.enumerated() {
            while nextMark < marksArr.count,
                let idx = marksArr[nextMark]["frameIdx"]?.asDouble,
                Int(idx) <= i
            {
                core.setMark(atSec: marksArr[nextMark]["atSec"]?.asDouble ?? 0)
                nextMark += 1
            }
            guard
                let walkTime = f["walkTime"]?.asDouble,
                let kpObj = f["keypoints"]?.asObject
            else {
                XCTFail("walk-replay-solo '\(name)' malformed frame \(i)")
                return nil
            }
            var kp: [String: XRunwayCore.PoseKeypoint] = [:]
            for (kname, v) in kpObj {
                guard
                    let x = v["x"]?.asDouble, let y = v["y"]?.asDouble,
                    let z = v["z"]?.asDouble, let s = v["score"]?.asDouble
                else { continue }
                kp[kname] = XRunwayCore.PoseKeypoint(x: x, y: y, z: z, score: s)
            }
            core.ingest(keypoints: kp, monoTs: walkTime)
        }

        let result = core.finish()
        // Invariant, enforced not asserted-in-comments (review finding): the
        // tape's walker never teleports, so the anchor-jump guard must stay
        // silent — including across the scripted 1.2 s outage (the gap rule
        // owns that frame; a jump double-count here means the guard read the
        // zeroed poseDt).
        XCTAssertEqual(
            result.anchorJumps, 0,
            "\(name): anchor-jump guard fired on a frame tape")
        let notesJSON = result.report.notes.map { n -> JSONValue in
            .object([
                "key": .string(n.key),
                "cue": .string(n.cue),
                "directional": .bool(n.directional),
            ])
        }
        return .object([
            "snapshots": .array(snapshots),
            "cues": .array(cues),
            "durationSec": .number(result.durationSec),
            "overall": .number(result.overall),
            "finalStats": Enc.optWalkStats(result.stats),
            "report": .object([
                "overall": .number(result.report.overall),
                "passThreshold": .number(result.report.passThreshold),
                "passed": .bool(result.report.passed),
                "verdict": .string(result.report.verdict),
                "notes": .array(notesJSON),
            ]),
            "gapResets": Enc.int(result.gapResets),
        ])
    }
}

// -----------------------------------------------------------------------------
// The web -> solo expected-string transform, built from the vector-locked
// copy-variants family: exact rows swap byte-for-byte; template rows (the
// {cm}/{side} footwork builders) match the web rendering with a derived
// regex and re-render the solo template with the SAME captured values.
// -----------------------------------------------------------------------------

struct SoloCopySubstitution {
    private let exact: [String: String]
    private let templates: [(web: NSRegularExpression, solo: String, slots: [String])]

    init?(_ family: GoldenFile) {
        var exact: [String: String] = [:]
        var templates: [(NSRegularExpression, String, [String])] = []
        for c in family.cases {
            guard
                let web = c.expect["web"]?.asString,
                let solo = c.expect["solo"]?.asString
            else { return nil }
            if web.contains("{") {
                // Template row: escape, then open capture groups per slot in
                // the order they appear in the WEB string.
                var slots: [String] = []
                var pattern = "^"
                var rest = Substring(web)
                while let open = rest.firstIndex(of: "{") {
                    pattern += NSRegularExpression.escapedPattern(
                        for: String(rest[..<open]))
                    guard let close = rest[open...].firstIndex(of: "}") else {
                        return nil
                    }
                    let slot = String(rest[rest.index(after: open)..<close])
                    slots.append(slot)
                    pattern += slot == "side" ? "(left|right)" : "([0-9]+)"
                    rest = rest[rest.index(after: close)...]
                }
                pattern += NSRegularExpression.escapedPattern(for: String(rest))
                pattern += "$"
                guard let re = try? NSRegularExpression(pattern: pattern) else {
                    return nil
                }
                templates.append((re, solo, slots))
            } else {
                exact[web] = solo
            }
        }
        self.exact = exact
        self.templates = templates
    }

    func soloized(_ s: String) -> String {
        if let hit = exact[s] { return hit }
        for t in templates {
            let range = NSRange(s.startIndex..., in: s)
            guard let m = t.web.firstMatch(in: s, range: range),
                m.range == range
            else { continue }
            var out = t.solo
            for (i, slot) in t.slots.enumerated() {
                guard let r = Range(m.range(at: i + 1), in: s) else { continue }
                out = out.replacingOccurrences(
                    of: "{\(slot)}", with: String(s[r]))
            }
            return out
        }
        return s
    }

    /// Transform a walk-replay-solo `expect`: cue texts + report note cues
    /// pass through the substitution; everything else is untouched.
    func transformExpect(_ expect: JSONValue) -> JSONValue {
        guard var obj = expect.asObject else { return expect }
        if let cues = obj["cues"]?.asArray {
            obj["cues"] = .array(cues.map { cue in
                guard var c = cue.asObject, let text = c["text"]?.asString
                else { return cue }
                c["text"] = .string(soloized(text))
                return .object(c)
            })
        }
        if var report = obj["report"]?.asObject,
            let notes = report["notes"]?.asArray
        {
            report["notes"] = .array(notes.map { note in
                guard var n = note.asObject, let cue = n["cue"]?.asString
                else { return note }
                n["cue"] = .string(soloized(cue))
                return .object(n)
            })
            obj["report"] = .object(report)
        }
        return .object(obj)
    }
}
