//
//  WalkReplayTests.swift — the `walk-replay` family (4 cases: 30 Hz + 60 Hz,
//  each raw + @rigid37). Mirrors runReplay (golden-replay.ts): the whole Solo
//  loop — deriveWorld through the metrics.ts publish seam (~6 Hz rounded
//  snapshots + display ramp/blend), the coach-live 2 Hz sample loop, and the
//  show.ts finishWalk rollup (finalize + overall + buildCoachReport).
//
//  The mark feed for each 2 Hz sample is the vector's OWN emitted cueContext
//  (data, not rules): markAt(i, sampleIdx) = cueContext[sampleIdx].markAtSec,
//  exactly the replay-net wiring in golden-replay.test.ts.
//

import XCTest
import XRunwayCore

final class WalkReplayTests: XCTestCase {
    func testWalkReplay() {
        guard let fam = loadFamilyOrFail("walk-replay") else { return }
        XCTAssertEqual(fam.cases.count, 4, "walk-replay case count")
        for c in fam.cases {
            let actual = runReplay(c.input)
            assertGolden(actual, c, module: "walk-replay")
        }
    }

    private struct Snapshot { var t: Double; var scores: [String: Double] }
    private struct Cue { var t: Double; var kind: String; var text: String }

    private func runReplay(_ input: JSONValue) -> JSONValue {
        let hz = input["hz"]?.asDouble ?? 30
        let idealPace = input["idealPace"]?.asDouble ?? 0
        let passThreshold = input["passThreshold"]?.asDouble ?? 0
        let walkSeconds = input["walkSeconds"]?.asDouble ?? 0
        let durationSecCap = input["durationSec"]?.asDouble ?? 0
        var weights: [String: Double] = [:]
        for (k, v) in (input["weights"]?.asObject ?? [:]) {
            if let d = v.asDouble { weights[k] = d }
        }
        let cueContextIn = input["cueContext"]?.asArray ?? []
        let frames = input["frames"]?.asArray ?? []

        let state = PoseDeriveState()
        let acc = WalkStatsAccumulator()
        var target = [Float](repeating: Float(NEUTRAL), count: 7)
        var smooth = [Float](repeating: Float(NEUTRAL), count: 7)
        let policy = LiveCoachPolicy()
        acc.reset(idealPace)
        state.reset()
        policy.reset()

        let delta = 1.0 / hz
        var poseLastT: Double = -1
        var publishAcc: Double = 0
        var sampleAcc: Double = 0
        var walkTime: Double = 0
        var published: [String: Double]? = nil
        var snapshots: [Snapshot] = []
        var cues: [Cue] = []
        var sampleCount = 0

        for i in 0..<frames.count {
            let f = frames[i]
            let t = f["t"]?.asDouble ?? 0
            walkTime = f["walkTime"]?.asDouble ?? 0

            if t != poseLastT {
                let poseDt = poseLastT >= 0 ? (t - poseLastT) / 1000 : 0
                poseLastT = t
                let frame = decodeFrame(f, t: t)
                deriveWorld(
                    frame, poseDt, walkTime, idealPace, walkSeconds, state,
                    acc, &target)
            }

            // display smoothing + ~6 Hz rounded publish
            let rampIn = rampInWeight(walkTime)
            let blend = displayBlend(delta)
            for k in 0..<7 {
                let goal =
                    NEUTRAL + (clampScore(Double(target[k])) - NEUTRAL) * rampIn
                smooth[k] += Float((goal - Double(smooth[k])) * blend)
            }
            publishAcc += delta
            if publishAcc >= PUBLISH_INTERVAL {
                publishAcc = publishAcc.truncatingRemainder(
                    dividingBy: PUBLISH_INTERVAL)
                var pub: [String: Double] = [:]
                for k in 0..<7 {
                    pub[METRIC_ORDER[k]] = jsRound(Double(smooth[k]))
                }
                published = pub
                var scores = pub
                scores["t"] = walkTime
                snapshots.append(Snapshot(t: walkTime, scores: scores))
            }

            // coach-live 2 Hz sample
            sampleAcc += delta
            if sampleAcc >= COACH_SAMPLE_SEC {
                sampleAcc = sampleAcc.truncatingRemainder(
                    dividingBy: COACH_SAMPLE_SEC)
                let pace = acc.livePaceMps
                let lat = acc.liveLateralM
                let post = acc.livePostureM
                // markAt(i, sampleCount) = the vector's own cueContext.
                var markAtSec: Double? = nil
                if sampleCount < cueContextIn.count {
                    if let m = cueContextIn[sampleCount]["markAtSec"], !m.isNull {
                        markAtSec = m.asDouble
                    }
                }
                let paceDelta: Double? =
                    (pace != nil && pace!.isFinite) ? pace! - idealPace : nil
                let absLat: Double? =
                    (lat != nil && lat!.isFinite) ? abs(lat!) : nil
                let postM: Double? =
                    (post != nil && post!.isFinite) ? post! : nil
                let inputSample = LiveCueInput(
                    walking: true,
                    walkRemainingSec: max(0, walkSeconds - walkTime),
                    markAtSec: markAtSec,
                    walkProgress01: min(walkTime / durationSecCap, 1),
                    oneWayRoute: false,
                    paceDeltaMps: paceDelta,
                    absLateralM: absLat,
                    postureM: postM)
                sampleCount += 1
                if let cue = policy.decideLiveCue(inputSample, walkTime) {
                    cues.append(
                        Cue(t: walkTime, kind: cue.kind.rawValue, text: cue.text))
                }
            }
        }

        // finishWalk rollup
        let finalStats = acc.finalize(walkTime)
        let durationSec = jsRound(walkTime * 10) / 10
        let scores = published ?? [:]
        var weighted: Double = 0
        for key in METRIC_ORDER {
            weighted += (scores[key] ?? 0) * (weights[key] ?? 0)
        }
        let overall = max(0, min(100, jsRound(weighted)))
        let ctx = CoachContext(
            scores: scores, overall: overall,
            mode: CoachModeParams(passThreshold: passThreshold, weights: weights),
            stats: finalStats, oneWayRoute: false)
        let report = buildCoachReport(ctx, copy: .web)

        // encode
        let snapJSON = snapshots.map { s -> JSONValue in
            var o: [String: JSONValue] = ["t": .number(s.t)]
            for key in METRIC_ORDER { o[key] = .number(s.scores[key] ?? 0) }
            return .object(o)
        }
        let cueJSON = cues.map { c -> JSONValue in
            .object([
                "t": .number(c.t),
                "kind": .string(c.kind),
                "text": .string(c.text),
            ])
        }
        let notesJSON = report.notes.map { n -> JSONValue in
            .object([
                "key": .string(n.key),
                "cue": .string(n.cue),
                "directional": .bool(n.directional),
            ])
        }
        return .object([
            "snapshots": .array(snapJSON),
            "cues": .array(cueJSON),
            "durationSec": .number(durationSec),
            "overall": .number(overall),
            "finalStats": Enc.optWalkStats(finalStats),
            "report": .object([
                "overall": .number(report.overall),
                "passThreshold": .number(report.passThreshold),
                "passed": .bool(report.passed),
                "verdict": .string(report.verdict),
                "notes": .array(notesJSON),
            ]),
        ])
    }
}
