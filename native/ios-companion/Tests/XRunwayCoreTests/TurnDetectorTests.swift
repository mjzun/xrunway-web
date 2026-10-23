//
//  TurnDetectorTests.swift — synthetic-tape coverage for the v0
//  TravelReversalDetector (SOLO-MODE §2). NOT golden-locked: the detector is
//  genuinely new logic with no web receipt — it ships FLAGGED, biased to
//  over-trigger, and gets its own vectors once the heuristic is fixed on
//  real walks. These tapes pin the v0 physics claims: every real reversal
//  marks (reflection AND arc turns), detection lands within a stride of the
//  truth, and stance sway / jitter / pauses / hesitation half-steps /
//  tracking gaps never fabricate one.
//

import XCTest
import XRunwayCore

final class TurnDetectorTests: XCTestCase {

    /// Drive a parametric hip track through the detector at 60 Hz.
    private func drive(
        seconds: Double, hz: Double = 60,
        pos: (Double) -> (Double, Double)
    ) -> [Double] {
        let det = TravelReversalDetector()
        det.reset()
        var marks: [Double] = []
        det.onReversal = { marks.append($0) }
        let dt = 1 / hz
        var t = 0.0
        while t <= seconds + 1e-9 {
            let (x, z) = pos(t)
            det.ingest(x: x, z: z, dtSec: dt, walkTime: t)
            t += dt
        }
        return marks
    }

    /// Triangle-wave lap position on a line of `length` at `speed`.
    private func lapX(_ t: Double, length: Double, speed: Double) -> Double {
        let period = 2 * length / speed
        let phase = t.truncatingRemainder(dividingBy: period)
        let d = phase * speed
        return d <= length ? d : 2 * length - d
    }

    /// Gait sway + a small deterministic wobble (stands in for skeleton
    /// jitter without a random source).
    private func sway(_ t: Double) -> Double {
        return 0.03 * sin(2 * .pi * 0.9 * t) + 0.004 * sin(997 * t)
            + 0.003 * cos(541 * t)
    }

    func testReflectionLapsMarkEveryReversal() {
        // 9 m line at 1.0 m/s for 40 s: ground-truth reversals at 9/18/27/36.
        let marks = drive(seconds: 40) { t in
            (self.lapX(t, length: 9, speed: 1.0), self.sway(t))
        }
        XCTAssertEqual(marks.count, 4, "one mark per reversal, no extras: \(marks)")
        for (i, truth) in [9.0, 18.0, 27.0, 36.0].enumerated() where i < marks.count {
            XCTAssertGreaterThan(marks[i], truth, "mark before the physical turn")
            XCTAssertLessThan(
                marks[i], truth + 1.0,
                "detection latency over a stride at 1 m/s: \(marks[i]) vs \(truth)")
        }
    }

    func testArcTurnMarks() {
        // 8 m out at 1.0 m/s, then a half-circle turn of radius 0.35 m
        // (~1.1 s), then back. One reversal, marked during/after the arc.
        let arcSec = Double.pi * 0.35 / 1.0
        let marks = drive(seconds: 16) { t -> (Double, Double) in
            if t < 8 {
                return (t, self.sway(t))
            } else if t < 8 + arcSec {
                let s = (t - 8) / arcSec // 0..1 around the half-circle
                return (8 + 0.35 * sin(.pi * s), 0.35 * (1 - cos(.pi * s)))
            } else {
                return (8 - (t - 8 - arcSec), 0.7 + self.sway(t))
            }
        }
        XCTAssertEqual(marks.count, 1, "one arc turn, one mark: \(marks)")
        if let m = marks.first {
            XCTAssertGreaterThan(m, 8.0)
            XCTAssertLessThan(m, 10.5, "arc turn detected within ~a stride of exit")
        }
    }

    func testStandingPauseNeverMarks() {
        // Walk 5 s, stand 4 s (sway only — under the speed floor), resume the
        // SAME direction: nothing here is a reversal.
        let marks = drive(seconds: 14) { t -> (Double, Double) in
            if t < 5 { return (t, self.sway(t)) }
            if t < 9 { return (5 + 0.01 * sin(2 * .pi * 0.4 * t), self.sway(t)) }
            return (5 + (t - 9), self.sway(t))
        }
        XCTAssertEqual(marks, [], "a pause is not a turn")
    }

    func testHesitationHalfStepStaysUnderTheBar() {
        // A 0.3 m back-step then onward — under REV_MIN_DIST by design (the
        // documented v0 boundary; lowering the constant flips this first).
        let marks = drive(seconds: 14) { t -> (Double, Double) in
            if t < 6 { return (t, self.sway(t)) }
            if t < 6.6 { return (6 - 0.5 * (t - 6), self.sway(t)) } // -0.3 m
            return (5.7 + (t - 6.6), self.sway(t))
        }
        XCTAssertEqual(marks, [], "a hesitation half-step is not a turn (v0 bar)")
    }

    func testGapAndTeleportDoNotFabricateAMark() {
        // Mid-lap occlusion: the engine calls noteGap() and the track jumps
        // 1 m on re-acquire. The lap's real reversal must still be the ONLY
        // mark.
        let det = TravelReversalDetector()
        det.reset()
        var marks: [Double] = []
        det.onReversal = { marks.append($0) }
        let dt = 1.0 / 60
        var t = 0.0
        while t <= 14 + 1e-9 { // through the far-end turn, before the near end
            if t >= 4, t < 4.5 {
                // occluded — no frames; announce once at entry
                if t < 4 + dt { det.noteGap() }
            } else {
                let jump = t >= 4.5 ? 1.0 : 0.0 // re-anchored 1 m ahead
                let x = min(self.lapX(t, length: 9, speed: 1.0) + jump, 9.0)
                det.ingest(x: x, z: self.sway(t), dtSec: dt, walkTime: t)
            }
            t += dt
        }
        // The +1 m offset walks the track into the far end early and holds it
        // there (clamped) until the true track catches up — the only REAL
        // reversal in the window must be the only mark.
        XCTAssertEqual(marks.count, 1, "gap/teleport fabricated or ate a mark: \(marks)")
    }
}
