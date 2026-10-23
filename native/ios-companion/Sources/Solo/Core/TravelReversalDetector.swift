//
//  TravelReversalDetector.swift
//  (X)RUNWAY iOS Companion — Solo mode (SOLO-MODE §2, Phase A3)
//
//  Per-lap travel-heading reversal detection — the ONE genuinely new piece
//  of measurement logic in Solo mode, with no web precedent (the headset's
//  pose mark comes from the show director's route geometry; the phone has
//  no registered route). Every reversal marks — far end AND near end — and
//  each mark re-opens the coach's TURN_SUPPRESS window and the derive
//  loop's SOLO_TURN_EXCLUDE_SEC lateral freeze.
//
//  V0, SHIPS FLAGGED (SOLO-MODE §8): biased to OVER-trigger by design — a
//  false mark wrongly clears fault clocks for 4 s (benign); a missed mark
//  lets the physical turn mature into fabricated pace-slow / center-up
//  cues (not benign). The constants below are v0 values reasoned from gait
//  physics, to be TUNED ON REAL WALKS; the detector gets its own golden
//  vectors once the heuristic is fixed. Synthetic coverage lives in
//  TurnDetectorTests (clean laps, pauses, arcs, jitter, anchor jumps).
//
//  Model: keep an EMA of unit displacement directions (the same fold form
//  as the scorer's heading, its own state). A reversal = accumulated
//  OPPOSING travel — displacement whose direction dots < -OPPOSE_DOT
//  against the established heading, at real walking speed — reaching
//  REV_MIN_DIST meters. Distance, not time: standing sway has no coherent
//  displacement to accumulate, and a slow deliberate turn accumulates just
//  as surely as a snap turn. The mid-arc band (|dot| <= OPPOSE_DOT) HOLDS
//  the tally (a turn's sideways arc neither confirms nor denies); clearly
//  aligned travel resets it. On fire, the heading re-seeds to the current
//  displacement direction so the next reversal accumulates fresh.
//

import Foundation
import XRunwayCore

/// Opposing travel (m) that confirms a reversal: ~half a stride of
/// genuinely backwards motion. A hesitation half-step (~0.3 m) stays just
/// under it; anything past it at walking speed means the walker turned.
/// Low on purpose — the over-trigger bias. v0.
let REV_MIN_DIST: Double = 0.35

/// |dot| band edge: motion counts as opposing under -0.3 (more than ~107
/// deg off the established heading), as aligned above +0.3; the arc between
/// holds. Wide on purpose (over-trigger bias). v0.
let REV_OPPOSE_DOT: Double = 0.3

/// Displacement slower than this (m/s) is stance sway / tracker noise, not
/// travel — it neither accumulates nor resets. Matches the framing of the
/// scorer's own "only when actually moving" heading gate. v0.
let REV_MIN_SPEED_MPS: Double = 0.15

/// Aligned travel (m) needed before the FIRST mark can fire (heading
/// warm-up: a mark against an unformed heading is noise).
let REV_WARMUP_DIST: Double = 1.0

/// Minimum seconds between marks. A 6 m line at a brisk 1.5 m/s gives 4 s
/// laps; 2 s rejects double-fires from one physical turn without ever
/// swallowing a real next-lap reversal. v0.
let REV_REFIRE_SEC: Double = 2.0

/// Detects travel reversals from the hip track. Feed it every fresh frame's
/// hip center; it reports marks via the callback (walk seconds).
final class TravelReversalDetector {
    /// Fired once per detected reversal, with the walk-time of DETECTION
    /// (the physical turn began ~REV_MIN_DIST earlier; the mark CLEARS
    /// fault clocks on arrival, so the latency is benign by construction).
    var onReversal: ((Double) -> Void)?

    private var headingX: Double = 0
    private var headingZ: Double = 0
    private var alignedDist: Double = 0
    private var opposeDist: Double = 0
    private var lastMarkAt: Double = -.infinity
    private var prevX: Double = 0
    private var prevZ: Double = 0
    private var havePrev = false
    private(set) var marks = 0

    func reset() {
        headingX = 0
        headingZ = 0
        alignedDist = 0
        opposeDist = 0
        lastMarkAt = -.infinity
        havePrev = false
        marks = 0
    }

    /// A tracking gap / anchor jump: drop the position anchor so the next
    /// frame re-seeds instead of differencing across the outage. The
    /// heading and tallies survive (like the scorer's EMAs) — the walker's
    /// travel direction did not stop existing because the camera blinked.
    func noteGap() {
        havePrev = false
    }

    /// One fresh frame's hip center (world meters) + inter-frame dt (s).
    func ingest(x: Double, z: Double, dtSec: Double, walkTime: Double) {
        guard havePrev, dtSec > 0 else {
            prevX = x
            prevZ = z
            havePrev = true
            return
        }
        let dx = x - prevX
        let dz = z - prevZ
        prevX = x
        prevZ = z
        let mag = (dx * dx + dz * dz).squareRoot()
        guard mag > 1e-4, mag / dtSec >= REV_MIN_SPEED_MPS else { return }

        let ux = dx / mag
        let uz = dz / mag
        let hmag = (headingX * headingX + headingZ * headingZ).squareRoot()

        if hmag < 0.3 {
            // No established heading yet (walk-start warm-up) — fold and
            // walk on.
            fold(ux, uz, dtSec, rate: 1.5)
            alignedDist += mag
            return
        }

        // EVIDENCE RULE (found by the synthetic tapes, not theory): the
        // heading must NEVER fold on opposing motion — folding it collapses
        // the EMA magnitude under the warm-up bar and rotates it toward the
        // new direction, ERASING the reversal before the distance tally can
        // confirm it. Opposition only accumulates; the heading re-seeds on
        // the fire. The mid-arc band folds SLOWLY (a permanent route bend
        // must eventually become the heading) — slow enough that a real
        // turn's ~0.5 m of arc rotates it only a few degrees.
        let dot = (ux * headingX + uz * headingZ) / hmag
        if dot <= -REV_OPPOSE_DOT {
            // Accumulate the BACKWARD COMPONENT of the displacement, not
            // its raw magnitude: gait sway rides perpendicular to travel
            // and would otherwise inflate a 0.3 m hesitation past the bar
            // (found by the hesitation tape — the false fire then re-seeds
            // the heading backwards and the resume cascades a second one).
            opposeDist += mag * (-dot)
            if opposeDist >= REV_MIN_DIST,
                alignedDist >= REV_WARMUP_DIST,
                walkTime - lastMarkAt >= REV_REFIRE_SEC
            {
                marks += 1
                lastMarkAt = walkTime
                opposeDist = 0
                // Re-seed the heading to the CURRENT (post-turn) direction
                // so the next lap's reversal accumulates against it fresh.
                headingX = ux
                headingZ = uz
                onReversal?(walkTime)
            }
        } else if dot >= REV_OPPOSE_DOT {
            // Clearly aligned travel: a hesitation was a hesitation.
            opposeDist = 0
            alignedDist += mag
            fold(ux, uz, dtSec, rate: 1.5)
        } else {
            // The mid-arc band: hold the tallies, follow the arc slowly.
            fold(ux, uz, dtSec, rate: 0.3)
        }
    }

    private func fold(_ ux: Double, _ uz: Double, _ dtSec: Double, rate: Double) {
        // The scorer's heading fold form, on the detector's own state.
        let a = 1 - exp(-rate * dtSec)
        headingX += (ux - headingX) * a
        headingZ += (uz - headingZ) * a
    }
}
