//
//  SoloFakePoseFeed.swift
//  (X)RUNWAY iOS Companion — Solo mode (A3 verification harness)
//
//  DEBUG-ONLY synthetic walker: with the env var XR_SOLO_FAKE_POSE=1 the
//  Solo pipeline runs WITHOUT ARKit (which cannot run in the Simulator) —
//  a phase-aware scripted walker feeds world-space frames straight into
//  the SoloPoseConsumer seam at 60 Hz, so the whole protocol (measure →
//  position → audible countdown → multi-lap walk with reversals → live
//  cues → summary) is exercisable end-to-end on a Mac. Mirrors the app's
//  existing debug hooks (XR_START_CAMERA / XR_AUTOSTREAM / XR_FREEZE).
//
//  The walker's gait matches the golden tapes' model (1.8 Hz steps, 2 cm
//  bob, 3 cm sway) on an 8 m line, and RUSHES (+0.5 m/s over the mode's
//  ideal) during seconds 8-16 of a walk so a pace-fast cue demonstrably
//  fires. Zero effect without the env var.
//

import Foundation
import SwiftUI

@MainActor
final class SoloFakePoseFeed {
    /// Env-gated AND compiled out of Release builds: no end user can set an
    /// env var on a normally-launched iOS app, but a synthetic pose source
    /// that could ever score a real record deserves both belts (review
    /// finding — the honesty bar is "cannot happen", not "unlikely").
    static var isEnabled: Bool {
        #if DEBUG
            return ProcessInfo.processInfo.environment["XR_SOLO_FAKE_POSE"] == "1"
        #else
            return false
        #endif
    }

    private weak var engine: SoloSessionEngine?
    private var timer: Timer? = nil

    // Walker state (line along +x, phone at x≈0).
    private let lineM = 8.0
    private var pos = 0.3
    private var dir = 1.0
    private var lastTick: TimeInterval = -1
    private var measureStartedAt: TimeInterval = -1
    private var walkStartedAt: TimeInterval = -1

    func start(engine: SoloSessionEngine) {
        self.engine = engine
        lastTick = -1
        measureStartedAt = -1
        walkStartedAt = -1
        pos = 0.3
        dir = 1
        let t = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.tick() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        engine = nil
    }

    private func tick() {
        guard let engine else { return }
        let now = ProcessInfo.processInfo.systemUptime
        let dt = lastTick >= 0 ? now - lastTick : 1.0 / 60
        lastTick = now

        var speed = 0.0
        switch engine.phase {
        case .setup, .positioning, .countdown, .summary, .interrupted:
            // Stand near the start, in frame.
            measureStartedAt = -1
            walkStartedAt = -1
            speed = 0
        case .measuring:
            // One out-and-back pass, then stand (the operator taps DONE).
            if measureStartedAt < 0 { measureStartedAt = now }
            let elapsed = now - measureStartedAt
            let walkOut = lineM / 1.0
            speed = elapsed < 2 * walkOut ? 1.0 : 0
        case .walking:
            if walkStartedAt < 0 { walkStartedAt = now }
            let elapsed = now - walkStartedAt
            let ideal = engine.lockedMode.idealPace
            // Rush window so a pace-fast cue demonstrably fires.
            speed = (elapsed >= 8 && elapsed < 16) ? ideal + 0.5 : ideal
        }

        if speed > 0 {
            pos += dir * speed * dt
            if pos >= lineM {
                pos = 2 * lineM - pos
                dir = -1
            } else if pos <= 0.2 {
                pos = 0.4 - pos
                dir = 1
            }
        }

        let frame = Self.walkerFrame(time: now, posX: pos, dirX: dir)
        engine.consume(frame: frame, monoTs: now, framing: .good)
    }

    /// The golden tapes' walker shape (pose-tapes.ts walkKeypoints), enough
    /// joints for the derive path: hips, shoulders, ankles.
    private static func walkerFrame(time: Double, posX: Double, dirX: Double) -> PoseFrame {
        let stepHz = 1.8
        let phase = 2 * Double.pi * stepHz * time
        let sway = 0.03 * sin(phase * 0.5)
        let bob = 0.02 * sin(phase)
        let hipY = 0.95 + bob
        let hipZ = sway // perp of +x travel is +z
        let stride = 0.3 * sin(phase * 0.5)
        var kp: [String: PoseKeypoint] = [:]
        kp["leftHip"] = PoseKeypoint(x: posX, y: hipY, z: hipZ - 0.11, score: 1)
        kp["rightHip"] = PoseKeypoint(x: posX, y: hipY, z: hipZ + 0.11, score: 1)
        kp["leftShoulder"] = PoseKeypoint(x: posX, y: hipY + 0.45, z: hipZ - 0.17, score: 1)
        kp["rightShoulder"] = PoseKeypoint(x: posX, y: hipY + 0.45, z: hipZ + 0.17, score: 1)
        kp["leftAnkle"] = PoseKeypoint(
            x: posX + dirX * stride, y: 0.08, z: hipZ - 0.09, score: 1)
        kp["rightAnkle"] = PoseKeypoint(
            x: posX - dirX * stride, y: 0.08, z: hipZ + 0.09, score: 1)
        return PoseFrame(
            t: Date().timeIntervalSince1970 * 1000,
            source: "solo-fake", space: "world", keypoints: kp)
    }
}
