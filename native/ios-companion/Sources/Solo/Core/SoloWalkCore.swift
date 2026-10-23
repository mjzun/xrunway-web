//
//  SoloWalkCore.swift
//  (X)RUNWAY iOS Companion — Solo mode (SOLO-MODE §4, Phase A3)
//
//  The Solo WALK LOOP — the production assembly of the XRunwayCore pieces:
//
//    soloDeriveWorld (§3 channels + turn windows)  ── walk-stats taps
//        │  fresh-frame gate + the §2 gap rule           │
//        ▼                                               ▼
//    display smoothing + ~6 Hz publish        2 Hz solo-gated LiveCoachPolicy
//        │                                               │
//        ▼                                               ▼
//    onSnapshot                                    onCue (CoachVoice)
//
//  DRIFT LOCK: the walk-replay-solo golden family drives THIS class in
//  XCTest (SoloReplayTests) — frames + ground-truth marks in, the emitted
//  snapshot/cue/rollup expectations out. The loop shape is the TS seam-spec
//  runSoloReplay (test/golden-replay.ts); a divergence here goes red
//  against vectors the web emitted. Two rules live OUTSIDE the tape's reach
//  and are unit-tested Swift-side instead (SoloWalkCoreRuleTests):
//    - dark ticks: when no fresh frame has arrived for > SOLO_GAP_SEC, the
//      engine's timer advances the sampler with NULL channels (the
//      closed-gate law — an outage clears fault clocks, never ages them on
//      stale taps); healthy streaming makes tick() a no-op so the
//      frame-driven loop stays exactly the vector-locked one;
//    - the anchor-jump guard (§2 passer-by re-anchor): a hip displacement
//      no real stride can produce is a tracking GAP (resetCadence +
//      zero-weight re-seed), never a measurement.
//
//  Pure Foundation + XRunwayCore — no UIKit/ARKit/AVFoundation imports, no
//  app types (the app-side engine converts its wire PoseFrame into
//  XRunwayCore.PoseFrame at the seam). Direct-compiles into the test
//  bundle; all timing math runs on the MONOTONIC capture timestamps the
//  PoseFrameSink seam delivers (never wall-clock frame.t).
//

import Foundation
import XRunwayCore

/// A hip displacement larger than SOLO_JUMP_BASE_M + 4 m/s * poseDt is not
/// a stride — 4 m/s is the derive path's own speed clamp, so the bound is
/// "the fastest displacement the scorer would even accept, plus half a
/// meter of skeleton noise". A passer-by anchor steal (ARKit re-locking
/// onto a body 1 m+ away) trips it; a real catwalk stride (~0.07 m/frame
/// at 60 Hz) never does. v0 value — tuned on real walks like the detector.
let SOLO_JUMP_BASE_M: Double = 0.5

/// One finished Solo walk — everything the summary screen renders.
struct SoloWalkResult {
    /// The last published ~6 Hz rounded snapshot (metric name -> 0-100).
    let scores: [String: Double]
    /// Weighted overall, clamped 0-100, from the LOCKED mode's weights.
    let overall: Double
    /// Rounded to 0.1 s, exactly like show.ts finishWalk.
    let durationSec: Double
    /// Real measurements (nil if no channel ever produced a sample).
    let stats: WalkStats?
    /// Verdict + directional notes, rendered with the SOLO copy surface.
    let report: CoachReport
    /// Diagnostics for the session log / tuning.
    let gapResets: Int
    let anchorJumps: Int
}

/// The per-walk scoring/coaching loop. One instance per walk; the engine
/// owns the state machine around it (positioning, countdown, summary) and
/// the turn DETECTOR feeding setMark(atSec:).
final class SoloWalkCore {
    private let mode: TrainingMode
    private let state = PoseDeriveState()
    private let acc = WalkStatsAccumulator()
    private var target: [Float]
    private var smooth: [Float]
    private let policy: LiveCoachPolicy

    // Walk clock (seconds since beginWalk, on the monotonic timebase).
    private var walkStartMono: TimeInterval = 0
    private(set) var walkTime: Double = 0
    private var prevWalkTime: Double = 0

    // Fresh-frame gate + the §2 gap rule.
    private var lastFreshMono: TimeInterval = -1
    private(set) var gapResets = 0

    // Anchor-jump guard (its own prev-hip copy; PoseDeriveState's anchor is
    // the scorer's business).
    private var jumpPrevX: Double = 0
    private var jumpPrevZ: Double = 0
    private var jumpHavePrev = false
    private(set) var anchorJumps = 0

    // ~6 Hz publish + 2 Hz sample accumulators (frame/tick dt driven).
    private var publishAcc: Double = 0
    private var sampleAcc: Double = 0
    private var published: [String: Double]? = nil

    // The mark feed (per-lap turn suppression; §2 both-ends model).
    private var markAtSec: Double? = nil

    // The lateral cue-input EMA + dark-hold (coach-live.ts
    // SOLO_LATERAL_CUE_SMOOTH_RATE docstring; mirrored from runSoloReplay).
    private var latCueEma: Double = 0
    private var latMeasuredAt: Double = -.infinity
    private let latCueAlpha = 1 - exp(-SOLO_LATERAL_CUE_SMOOTH_RATE * COACH_SAMPLE_SEC)

    /// Fired on every decided cue (the engine routes it to CoachVoice).
    var onCue: ((LiveCue) -> Void)?
    /// Fired on every ~6 Hz rounded publish (walkTime, scores).
    var onSnapshot: ((Double, [String: Double]) -> Void)?

    init(mode: TrainingMode) {
        self.mode = mode
        self.policy = LiveCoachPolicy(copy: .solo, gates: SOLO_CUE_GATES)
        self.target = [Float](repeating: Float(NEUTRAL), count: 7)
        self.smooth = [Float](repeating: Float(NEUTRAL), count: 7)
    }

    /// Arm for a new walk. `atMono` is the walk clock's zero (the GO beat).
    func beginWalk(atMono: TimeInterval) {
        walkStartMono = atMono
        walkTime = 0
        prevWalkTime = 0
        lastFreshMono = -1
        gapResets = 0
        jumpHavePrev = false
        anchorJumps = 0
        publishAcc = 0
        sampleAcc = 0
        published = nil
        markAtSec = nil
        latCueEma = 0
        latMeasuredAt = -.infinity
        for k in 0..<7 {
            target[k] = Float(NEUTRAL)
            smooth[k] = Float(NEUTRAL)
        }
        state.reset()
        acc.reset(mode.idealPace)
        policy.reset()
    }

    /// The most recent travel reversal (walk seconds). The engine's detector
    /// calls this on EVERY reversal (§2 per-lap re-arm); the golden replay
    /// test injects the tape's ground-truth marks through the same door.
    func setMark(atSec: Double) {
        markAtSec = atSec
    }

    /// One captured world-space frame. `monoTs` is the capture timestamp on
    /// the session/systemUptime timebase — NEVER PoseFrame.t (wall clock).
    func ingest(keypoints: [String: XRunwayCore.PoseKeypoint], monoTs: TimeInterval) {
        walkTime = monoTs - walkStartMono
        let dt = walkTime - prevWalkTime
        prevWalkTime = walkTime

        // The fresh-frame gate wraps ONLY the derive (runSoloReplay shape):
        // a repeated timestamp still ticks the display/sampler clocks, it
        // just never derives (dt-0 inflation protection).
        if monoTs != lastFreshMono {
            var poseDt = lastFreshMono >= 0 ? monoTs - lastFreshMono : 0
            lastFreshMono = monoTs

            // The §2 gap rule: an outage is re-seeded, never measured.
            let gapFired = poseDt > SOLO_GAP_SEC
            if gapFired {
                state.resetCadence()
                poseDt = 0
                gapResets += 1
            }

            // The §2 anchor-jump guard: a displacement no stride can
            // produce is a tracking gap (ARKit re-anchored onto a
            // passer-by, or the skeleton teleported after occlusion).
            // SKIPPED when the gap rule already fired: the frame is already
            // a zero-weight re-seed, and the pre-outage anchor would make
            // any legitimately-walked >SOLO_JUMP_BASE_M read as a jump
            // (review finding: the golden tape's own 1.2 s gap covers ~1 m
            // and must count as ONE gap, zero jumps).
            if let lh = kpOk(keypoints, "leftHip") ?? kpOk(keypoints, "rightHip") {
                let rh = kpOk(keypoints, "rightHip")
                let l = kpOk(keypoints, "leftHip")
                let hx = (l != nil && rh != nil) ? (l!.x + rh!.x) * 0.5 : lh.x
                let hz = (l != nil && rh != nil) ? (l!.z + rh!.z) * 0.5 : lh.z
                if jumpHavePrev, !gapFired {
                    let jump = ((hx - jumpPrevX) * (hx - jumpPrevX)
                        + (hz - jumpPrevZ) * (hz - jumpPrevZ)).squareRoot()
                    if jump > SOLO_JUMP_BASE_M + 4 * max(poseDt, 0) {
                        state.resetCadence()
                        poseDt = 0
                        anchorJumps += 1
                    }
                }
                jumpPrevX = hx
                jumpPrevZ = hz
                jumpHavePrev = true
            }

            let turnExcluded =
                markAtSec != nil && walkTime - markAtSec! < SOLO_TURN_EXCLUDE_SEC
            let frame = XRunwayCore.PoseFrame(t: monoTs * 1000, keypoints: keypoints)
            soloDeriveWorld(
                frame, poseDt, walkTime, mode.idealPace,
                Double(mode.walkSeconds), state, acc, &target,
                turnExcluded: turnExcluded)
        }

        advanceClocks(dt: dt, channelsDark: false)
    }

    /// Engine timer tick. A NO-OP while frames flow (the frame-driven loop
    /// is the vector-locked one); during an outage (> SOLO_GAP_SEC dark) it
    /// advances the walk clock and samples the policy with NULL channels —
    /// the closed-gate law: an outage clears fault clocks, it never ages
    /// them against stale taps.
    func tick(monoTs: TimeInterval) {
        let freshRef = lastFreshMono >= 0 ? lastFreshMono : walkStartMono
        guard monoTs - freshRef > SOLO_GAP_SEC else { return }
        let t = monoTs - walkStartMono
        guard t > prevWalkTime else { return }
        walkTime = t
        let dt = walkTime - prevWalkTime
        prevWalkTime = walkTime
        advanceClocks(dt: dt, channelsDark: true)
    }

    /// Display smoothing, ~6 Hz publish, and the 2 Hz policy sample — the
    /// exact runSoloReplay loop shape (real-dt ticks; a gap coalesces into
    /// one tick).
    private func advanceClocks(dt: Double, channelsDark: Bool) {
        let rampIn = rampInWeight(walkTime)
        let blend = displayBlend(dt)
        for k in 0..<7 {
            let goal = NEUTRAL + (clampScore(Double(target[k])) - NEUTRAL) * rampIn
            smooth[k] += Float((goal - Double(smooth[k])) * blend)
        }
        publishAcc += dt
        if publishAcc >= PUBLISH_INTERVAL {
            publishAcc = publishAcc.truncatingRemainder(dividingBy: PUBLISH_INTERVAL)
            var pub: [String: Double] = [:]
            for k in 0..<7 {
                pub[METRIC_ORDER[k]] = jsRound(Double(smooth[k]))
            }
            published = pub
            onSnapshot?(walkTime, pub)
        }
        sampleAcc += dt
        if sampleAcc >= COACH_SAMPLE_SEC {
            sampleAcc = sampleAcc.truncatingRemainder(dividingBy: COACH_SAMPLE_SEC)
            samplePolicy(channelsDark: channelsDark)
        }
    }

    private func samplePolicy(channelsDark: Bool) {
        let pace = channelsDark ? nil : acc.livePaceMps
        let lat = channelsDark ? nil : acc.liveLateralM
        let post = channelsDark ? nil : acc.livePostureM

        // Solo lateral cue input: smoothed |offset| with the SOLO_GAP_SEC
        // dark-hold (coach-live.ts docstring; runSoloReplay mirror).
        var absLat: Double? = nil
        if let lat, lat.isFinite {
            latCueEma += (abs(lat) - latCueEma) * latCueAlpha
            latMeasuredAt = walkTime
            absLat = latCueEma
        } else if walkTime - latMeasuredAt <= SOLO_GAP_SEC {
            absLat = latCueEma
        }

        let paceDelta: Double? =
            (pace != nil && pace!.isFinite) ? pace! - mode.idealPace : nil
        let postM: Double? = (post != nil && post!.isFinite) ? post! : nil

        let input = LiveCueInput(
            walking: true,
            walkRemainingSec: max(0, mode.walkSeconds - walkTime),
            markAtSec: markAtSec,
            // §2: progress is CLOCK-based on the phone (elapsed/walkSeconds)
            // — the positional fast-finisher guard is a web nicety that
            // doesn't map to timer-capped laps.
            walkProgress01: min(walkTime / mode.walkSeconds, 1),
            oneWayRoute: false,
            paceDeltaMps: paceDelta,
            absLateralM: absLat,
            postureM: postM)
        if let cue = policy.decideLiveCue(input, walkTime) {
            onCue?(cue)
        }
    }

    /// The timed-out rollup (show.ts finishWalk shape): finalize the stats,
    /// weight the last published snapshot with the LOCKED mode, and build
    /// the SOLO-copy coach report.
    func finish() -> SoloWalkResult {
        let finalStats = acc.finalize(walkTime)
        let durationSec = jsRound(walkTime * 10) / 10
        let scores = published ?? [:]
        var weighted: Double = 0
        for key in METRIC_ORDER {
            weighted += (scores[key] ?? 0) * (mode.weights[key] ?? 0)
        }
        let overall = max(0, min(100, jsRound(weighted)))
        let report = buildCoachReport(
            CoachContext(
                scores: scores,
                overall: overall,
                mode: CoachModeParams(
                    passThreshold: mode.passThreshold, weights: mode.weights),
                stats: finalStats,
                oneWayRoute: false),
            copy: .solo)
        return SoloWalkResult(
            scores: scores,
            overall: overall,
            durationSec: durationSec,
            stats: finalStats,
            report: report,
            gapResets: gapResets,
            anchorJumps: anchorJumps)
    }
}
