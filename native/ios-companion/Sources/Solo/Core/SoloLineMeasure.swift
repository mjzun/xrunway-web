//
//  SoloLineMeasure.swift
//  (X)RUNWAY iOS Companion — Solo mode (SOLO-MODE §2, Phase A3)
//
//  Measure the walking line by WALKING it once: tap MEASURE at the phone,
//  walk to the far end (turn, walk back — the phone is at the near end, so
//  the trainee finishes where the DONE button is). The line length is the
//  PEAK horizontal straight-line distance of the hip from its start
//  anchor — frame-invariant (a distance between two hip positions in the
//  same unregistered ARKit session frame), robust to the return leg, and
//  immune to sway inflating a path integral.
//
//  Honesty: this length is the ONLY spatial quantity a Solo record ever
//  stamps (SOLO-MODE §3 — never emit fake world coordinates); it feeds the
//  §2 short-line warning and nothing in scoring (progress is clock-based).
//
//  Pure Foundation + XRunwayCore; unit-tested in SoloLineMeasureTests.
//

import Foundation
import XRunwayCore

/// Lines under this read cramped for mid-walk coaching (SOLO-MODE §2: the
/// settle window + per-lap suppression leave little cue room) — warn, do
/// not block; the summary still scores fully.
let LINE_WARN_MIN_M: Double = 6.0

/// The start anchor averages hip positions over this many seconds before
/// distance accumulates — the tap-then-stand wobble must not become the
/// anchor.
let LINE_ANCHOR_SEC: Double = 0.5

/// A single-frame hip displacement past this (m) mid-measure is an anchor
/// steal / tracking teleport, not walking — the measurement is untrusted
/// and the UI offers a retry or manual entry.
let LINE_JUMP_M: Double = 1.0

final class SoloLineMeasure {
    /// Peak straight-line distance from the start anchor (m) so far.
    private(set) var peakM: Double = 0
    /// True once a teleport-scale jump poisoned the measurement.
    private(set) var suspectJump = false

    private var anchorX: Double = 0
    private var anchorZ: Double = 0
    private var anchorAcc = 0
    private var anchorStartT: Double = -1
    private var anchored = false
    private var prevX: Double = 0
    private var prevZ: Double = 0
    private var havePrev = false

    func reset() {
        peakM = 0
        suspectJump = false
        anchorAcc = 0
        anchorStartT = -1
        anchored = false
        havePrev = false
    }

    /// One fresh frame's hip center (world meters) at `tSec` (any monotonic
    /// seconds; only differences matter).
    func ingest(x: Double, z: Double, tSec: Double) {
        if havePrev {
            let dx = x - prevX
            let dz = z - prevZ
            if (dx * dx + dz * dz).squareRoot() > LINE_JUMP_M {
                suspectJump = true
            }
        }
        prevX = x
        prevZ = z
        havePrev = true

        if !anchored {
            if anchorStartT < 0 { anchorStartT = tSec }
            // Running mean over the anchor window.
            anchorAcc += 1
            let n = Double(anchorAcc)
            anchorX += (x - anchorX) / n
            anchorZ += (z - anchorZ) / n
            if tSec - anchorStartT >= LINE_ANCHOR_SEC { anchored = true }
            return
        }
        let dx = x - anchorX
        let dz = z - anchorZ
        let d = (dx * dx + dz * dz).squareRoot()
        if d > peakM { peakM = d }
    }

    /// Finish the measurement. nil when nothing usable was captured.
    func finish() -> (lengthM: Double, suspect: Bool, short: Bool)? {
        guard anchored, peakM > 0.5 else { return nil }
        let length = (peakM * 10).rounded() / 10 // 0.1 m resolution — honest
        return (length, suspectJump, length < LINE_WARN_MIN_M)
    }
}
