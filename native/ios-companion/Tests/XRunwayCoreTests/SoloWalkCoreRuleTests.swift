//
//  SoloWalkCoreRuleTests.swift — the two SoloWalkCore rules the
//  walk-replay-solo tape cannot exercise (its ticks are frame-driven and
//  its walker never teleports), pinned here instead:
//
//   1. DARK TIMER TICKS: when no fresh frame has arrived for > SOLO_GAP_SEC
//      the engine timer advances the sampler with NULL channels — the
//      closed-gate law (an outage CLEARS fault clocks; it never ages them
//      against stale taps, and a resumed stream needs a fresh
//      FAULT_HOLD_SEC). While frames flow, tick() must be a byte-level
//      no-op so the frame-driven loop stays the vector-locked one.
//
//   2. THE ANCHOR-JUMP GUARD (§2 passer-by re-anchor): a hip displacement
//      no stride can produce is a tracking GAP (zero weight + re-seed),
//      never a measurement — the walk's pace mean must not carry a
//      teleport.
//

import XCTest
import XRunwayCore

final class SoloWalkCoreRuleTests: XCTestCase {

    /// Hips-only world frames (sparse skeletons are legal — the single-hip
    /// review finding) walking +x at `speed`, hip height ~0.95 with gait bob.
    private func hipFrame(t: Double, x: Double) -> [String: XRunwayCore.PoseKeypoint] {
        let y = 0.95 + 0.02 * sin(2 * .pi * 1.8 * t)
        return [
            "leftHip": XRunwayCore.PoseKeypoint(x: x, y: y, z: -0.1, score: 1),
            "rightHip": XRunwayCore.PoseKeypoint(x: x, y: y, z: 0.1, score: 1),
        ]
    }

    private func makeCore() -> (SoloWalkCore, () -> [(Double, LiveCue)]) {
        let core = SoloWalkCore(mode: getMode("beginner")) // ideal 0.85, 20 s
        var cues: [(Double, LiveCue)] = []
        core.onCue = { cues.append((core.walkTime, $0)) }
        return (core, { cues })
    }

    func testOutageClearsFaultClocksAndResumeNeedsFreshHold() {
        // Timeline budget: the whole rush/outage/resume arc must fit BEFORE
        // the final guard of the 20 s beginner walk (nothing cues once
        // walkRemainingSec <= FINAL_GUARD_SEC, i.e. from 16 s) — the
        // original 60 s timeline went dark exactly this way when the modes
        // moved to 20 s for the shareable demo.
        let (core, cues) = makeCore()
        core.beginWalk(atMono: 0)
        let hz = 60.0
        let dt = 1 / hz
        // 0..6 s: rush at 1.7 m/s (paceDelta ~ +0.85, way over the gate).
        // The fault ages from SETTLE_SEC (5) — only 1 s by the outage, so no
        // cue may exist yet.
        var x = 0.0
        var t = dt
        while t <= 6 {
            x += 1.7 * dt
            core.ingest(keypoints: hipFrame(t: t, x: x), monoTs: t)
            t += dt
        }
        XCTAssertTrue(cues().isEmpty, "no cue before the hold completes")
        // 6..11 s: OUTAGE — timer ticks only. A stale-tap implementation
        // would let the +0.85 fault mature at ~7.5 and cue; the dark ticks
        // must sample null channels and clear instead.
        while t <= 11 {
            core.tick(monoTs: t)
            t += 0.1
        }
        XCTAssertTrue(
            cues().isEmpty,
            "an outage aged a fault on stale taps: \(cues().map { $0.0 })")
        // 11..15.9 s: stream resumes, same rush. The fault needs a FRESH
        // FAULT_HOLD_SEC: the earliest legitimate cue is resume + hold (the
        // pace EMA is still warm from before the gap, so the fault re-arms
        // on the first samples) — matured ~13.75 s, before the 16 s final
        // guard.
        let resumeAt = t
        while t <= 15.9 {
            x += 1.7 * dt
            core.ingest(keypoints: hipFrame(t: t, x: x), monoTs: t)
            t += dt
        }
        let fired = cues()
        XCTAssertEqual(fired.count, 1, "the resumed fault cues exactly once here")
        if let first = fired.first {
            XCTAssertEqual(first.1.kind, .paceFast)
            XCTAssertGreaterThanOrEqual(
                first.0, resumeAt + FAULT_HOLD_SEC - 0.6,
                "cue fired without a fresh hold after the outage")
        }
    }

    func testTickIsANoOpWhileFramesFlow() {
        // Two identical fault walks; core B also gets a 4 Hz timer tick
        // interleaved. Cue timelines and the rollup must match exactly.
        func run(withTicks: Bool) -> (cues: [Double], overall: Double, pace: Double?) {
            let (core, cues) = makeCore()
            core.beginWalk(atMono: 0)
            let dt = 1.0 / 60
            var x = 0.0
            var t = dt
            var nextTick = 0.25
            while t <= 12 {
                x += 1.7 * dt
                core.ingest(keypoints: hipFrame(t: t, x: x), monoTs: t)
                if withTicks, t >= nextTick {
                    core.tick(monoTs: t + 0.001)
                    nextTick += 0.25
                }
                t += dt
            }
            let r = core.finish()
            return (cues().map { $0.0 }, r.overall, r.stats?.meanPaceMps)
        }
        let a = run(withTicks: false)
        let b = run(withTicks: true)
        XCTAssertEqual(a.cues, b.cues, "ticks while streaming changed the cue timeline")
        XCTAssertEqual(a.overall, b.overall)
        XCTAssertEqual(a.pace, b.pace)
    }

    func testGapThenMotionCountsOneGapZeroJumps() {
        // A real occlusion: frames stop for 1.2 s while the walker covers
        // ~1.2 m. The gap rule owns the resume frame (one gapReset); the
        // jump guard must NOT also fire on the pre-outage anchor (review
        // finding: it read the already-zeroed poseDt as its threshold).
        let (core, cues) = makeCore()
        core.beginWalk(atMono: 0)
        let dt = 1.0 / 60
        var t = dt
        var x = 0.0
        while t <= 10 {
            let occluded = t >= 4.0 && t < 5.2
            x += 1.0 * dt // the walker keeps walking, observed or not
            if !occluded {
                core.ingest(keypoints: hipFrame(t: t, x: x), monoTs: t)
            }
            t += dt
        }
        _ = core.finish()
        XCTAssertEqual(core.gapResets, 1, "one outage, one gap re-seed")
        XCTAssertEqual(
            core.anchorJumps, 0,
            "legitimately-walked outage distance is not an anchor steal")
        XCTAssertTrue(cues().isEmpty, "a clean 1.0 m/s walk must not cue")
    }

    func testAnchorJumpIsAGapNotAMeasurement() {
        let (core, cues) = makeCore()
        core.beginWalk(atMono: 0)
        let dt = 1.0 / 60
        var t = dt
        var x = 0.0
        var jumped = false
        while t <= 8 {
            x += 1.0 * dt
            // At 4 s the anchor "steals" onto a passer-by 3 m ahead.
            if t >= 4, !jumped {
                x += 3.0
                jumped = true
            }
            core.ingest(keypoints: hipFrame(t: t, x: x), monoTs: t)
            t += dt
        }
        let r = core.finish()
        XCTAssertEqual(core.anchorJumps, 1, "the teleport must be flagged")
        XCTAssertEqual(core.gapResets, 0, "no time gap here — only a spatial jump")
        if let pace = r.stats?.meanPaceMps {
            // 3 m credited to one frame would drag the 8 s mean toward
            // ~1.4+ (clamped burst); the guard keeps it at the walked 1.0.
            XCTAssertLessThan(pace, 1.15, "the teleport leaked into the pace mean")
            XCTAssertGreaterThan(pace, 0.85)
        } else {
            XCTFail("no pace measured")
        }
        XCTAssertTrue(cues().isEmpty, "a clean 1.0 m/s walk must not cue")
    }
}
