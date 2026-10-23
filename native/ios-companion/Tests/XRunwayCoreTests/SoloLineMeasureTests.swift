//
//  SoloLineMeasureTests.swift — walk-the-line length capture (SOLO-MODE §2):
//  peak straight-line hip distance from a settled start anchor, the §2
//  short-line warning, the teleport (anchor-steal) suspicion flag, and the
//  nothing-usable nil.
//

import XCTest
import XRunwayCore

final class SoloLineMeasureTests: XCTestCase {

    /// Walk out-and-back over `length` at `speed` with gait sway, 60 Hz,
    /// starting after `standSec` of stance wobble (the tap-then-walk gap).
    private func measure(
        length: Double, speed: Double = 1.2, standSec: Double = 1.0,
        mutate: ((Double, inout Double, inout Double) -> Void)? = nil
    ) -> SoloLineMeasure {
        let m = SoloLineMeasure()
        m.reset()
        let dt = 1.0 / 60
        let walkOut = length / speed
        var t = 0.0
        while t <= standSec + 2 * walkOut {
            var x: Double
            if t < standSec {
                x = 0.01 * sin(2 * .pi * 0.5 * t) // stance wobble
            } else if t < standSec + walkOut {
                x = speed * (t - standSec)
            } else {
                x = length - speed * (t - standSec - walkOut)
            }
            var z = 0.03 * sin(2 * .pi * 0.9 * t)
            if let mutate { mutate(t, &x, &z) }
            m.ingest(x: x, z: z, tSec: t)
            t += dt
        }
        return m
    }

    func testOutAndBackMeasuresTheLine() {
        let m = measure(length: 8)
        guard let r = m.finish() else {
            XCTFail("no measurement")
            return
        }
        XCTAssertEqual(r.lengthM, 8.0, accuracy: 0.2)
        XCTAssertFalse(r.short)
        XCTAssertFalse(r.suspect)
    }

    func testShortLineWarns() {
        let m = measure(length: 4)
        guard let r = m.finish() else {
            XCTFail("no measurement")
            return
        }
        XCTAssertEqual(r.lengthM, 4.0, accuracy: 0.2)
        XCTAssertTrue(r.short, "under \(LINE_WARN_MIN_M) m must warn (SOLO-MODE §2)")
    }

    func testTeleportFlagsSuspect() {
        let m = measure(length: 8) { t, x, _ in
            if t >= 3.0, t < 3.02 { x += 2.5 } // one-frame anchor steal
        }
        guard let r = m.finish() else {
            XCTFail("no measurement")
            return
        }
        XCTAssertTrue(r.suspect, "a 2.5 m single-frame jump must poison the measure")
    }

    func testNothingUsableIsNil() {
        let m = SoloLineMeasure()
        m.reset()
        // 2 s of stance wobble only — anchor forms, but no walk happens.
        let dt = 1.0 / 60
        var t = 0.0
        while t <= 2 {
            m.ingest(x: 0.01 * sin(2 * .pi * 0.5 * t), z: 0, tSec: t)
            t += dt
        }
        XCTAssertNil(m.finish(), "half a meter of travel is not a line")
    }
}
