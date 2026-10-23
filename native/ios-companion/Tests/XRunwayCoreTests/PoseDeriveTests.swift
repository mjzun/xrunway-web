//
//  PoseDeriveTests.swift — the pose-derive walk families:
//    pose-derive-world (16 cases: 8 raw + 8 @rigid37) via deriveWorld
//    solo-derive       (14 cases: 7 raw + 7 @rigid37) via soloDeriveWorld
//    gap-tape          (2 cases:  1 raw + 1 @rigid37) via deriveWorld
//
//  Mirrors runTape + deriveExpect (pose-tapes.ts / golden-replay.ts): drive
//  each frame through the derive behind the metrics.ts fresh-frame gate
//  (poseDt = poseLastT>=0 ? (t-poseLastT)/1000 : 0), a `gap` event does
//  resetCadence()+re-arm, and checkpoints are the same subset the generator
//  emits (i<8 || i%5==0 || isGap || last). The rigid twins run the SAME driver
//  on the rigidly-transformed input already baked into the vector, so both raw
//  and transformed pairs must match to tolerance.
//

import XCTest
import XRunwayCore

/// Which world derivation a family drives.
private enum DeriveVariant {
    case web  // deriveWorld
    case solo  // soloDeriveWorld (reads per-frame turnExcluded)
}

/// A recorded step (post-derive snapshot) matching the tape's steps[] shape.
private struct TapeStep {
    let ev: String  // "frame" | "gap"
    let walkTime: Double
    let targets: [Float]
    let live: (Double?, Double?, Double?)
}

final class PoseDeriveTests: XCTestCase {

    func testPoseDeriveWorld() {
        runFamily("pose-derive-world", variant: .web, expectedCases: 16)
    }

    func testSoloDerive() {
        runFamily("solo-derive", variant: .solo, expectedCases: 14)
    }

    func testGapTape() {
        runFamily("gap-tape", variant: .web, expectedCases: 2)
    }

    private func runFamily(
        _ module: String, variant: DeriveVariant, expectedCases: Int
    ) {
        guard let fam = loadFamilyOrFail(module) else { return }
        XCTAssertEqual(fam.cases.count, expectedCases, "\(module) case count")
        for c in fam.cases {
            let actual = runTape(c.input, variant: variant)
            assertGolden(actual, c, module: module)
        }
    }

    /// Drive one tape and build the {checkpoints, final} expectation exactly as
    /// pose-tapes.ts runTape + golden-replay.ts deriveExpect do.
    private func runTape(_ input: JSONValue, variant: DeriveVariant) -> JSONValue {
        let idealPace = input["idealPace"]?.asDouble ?? 0
        let durationSec = input["durationSec"]?.asDouble ?? 0
        let events = input["events"]?.asArray ?? []

        let state = PoseDeriveState()
        let acc = WalkStatsAccumulator()
        var target = [Float](repeating: 62, count: 7)  // NEUTRAL start
        // Match makeWorldSession/makeSoloSession: reset both, target filled.
        acc.reset(idealPace)
        state.reset()

        var poseLastT: Double = -1
        var steps: [TapeStep] = []

        for ev in events {
            let kind = ev["kind"]?.asString ?? "frame"
            if kind == "gap" {
                state.resetCadence()
                poseLastT = -1
                steps.append(
                    TapeStep(
                        ev: "gap",
                        walkTime: ev["walkTime"]?.asDouble ?? 0,
                        targets: target,
                        live: (acc.livePaceMps, acc.liveLateralM, acc.livePostureM)))
                continue
            }
            let t = ev["t"]?.asDouble ?? 0
            let walkTime = ev["walkTime"]?.asDouble ?? 0
            // metrics.ts fresh-frame gate.
            if t != poseLastT {
                let poseDt = poseLastT >= 0 ? (t - poseLastT) / 1000 : 0
                poseLastT = t
                let frame = decodeFrame(ev, t: t)
                switch variant {
                case .web:
                    deriveWorld(
                        frame, poseDt, walkTime, idealPace, durationSec, state,
                        acc, &target)
                case .solo:
                    let turnExcluded = ev["turnExcluded"]?.asBool ?? false
                    soloDeriveWorld(
                        frame, poseDt, walkTime, idealPace, durationSec, state,
                        acc, &target, turnExcluded: turnExcluded)
                }
            }
            steps.append(
                TapeStep(
                    ev: "frame",
                    walkTime: walkTime,
                    targets: target,
                    live: (acc.livePaceMps, acc.liveLateralM, acc.livePostureM)))
        }

        let final = acc.finalize(durationSec)

        // deriveExpect checkpoint selection.
        var checkpoints: [JSONValue] = []
        let n = steps.count
        for (i, s) in steps.enumerated() {
            let isGap = s.ev == "gap"
            if i < 8 || i % 5 == 0 || isGap || i == n - 1 {
                checkpoints.append(encodeStep(i, s))
            }
        }
        return .object([
            "checkpoints": .array(checkpoints),
            "final": Enc.optWalkStats(final),
        ])
    }

    private func encodeStep(_ i: Int, _ s: TapeStep) -> JSONValue {
        return .object([
            "i": .number(Double(i)),
            "ev": .string(s.ev),
            "walkTime": .number(s.walkTime),
            "targets": Enc.targets(s.targets),
            "live": .object([
                "pace": Enc.optNum(s.live.0),
                "lat": Enc.optNum(s.live.1),
                "post": Enc.optNum(s.live.2),
            ]),
        ])
    }
}

/// Decode a tape frame event's keypoints into a PoseFrame. Non-finite
/// coordinates (sentinel) survive so the kpOk acceptance gate is exercised.
func decodeFrame(_ ev: JSONValue, t: Double) -> PoseFrame {
    var kps: [String: PoseKeypoint] = [:]
    if let kpObj = ev["keypoints"]?.asObject {
        for (name, v) in kpObj {
            guard let o = v.asObject else { continue }
            kps[name] = PoseKeypoint(
                x: o["x"]?.asDouble ?? .nan,
                y: o["y"]?.asDouble ?? .nan,
                z: o["z"]?.asDouble ?? .nan,
                score: o["score"]?.asDouble ?? .nan)
        }
    }
    return PoseFrame(t: t, keypoints: kps)
}
