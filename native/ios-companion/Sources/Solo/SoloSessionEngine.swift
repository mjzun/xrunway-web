//
//  SoloSessionEngine.swift
//  (X)RUNWAY iOS Companion — Solo mode (SOLO-MODE §2/§4, Phase A3)
//
//  The walk-protocol state machine around SoloWalkCore — its OWN lifecycle,
//  deliberately not crammed into ContentView's `running` bool:
//
//    setup ──(MEASURE)── measuring ──(DONE)── setup
//      │
//      └─(START WALK)── positioning ── countdown(3..1) ── walking ── summary
//                            ▲                                │
//                            └── interrupted (v1: discarded) ─┘
//
//  Rules it owns (each cites its SOLO-MODE receipt):
//  - positioning is FRAMING-GATED (§2): the countdown arms only after the
//    debounced verdict holds .good — visibility truth comes from the
//    framing machinery, never keypoint presence;
//  - the countdown is AUDIBLE (§2: the trainee can't see the screen);
//  - the walk is timer-capped multi-lap (§2): the mode's walkSeconds is the
//    clock; the detector marks EVERY reversal (both ends) and each mark
//    re-opens the policy's suppression window + the derive turn freeze;
//  - framing-not-good intervals contribute ZERO weight (§2): frames are
//    withheld from the core, whose gap rule + dark timer ticks own the
//    outage; the detector is told (noteGap) so it never differences across
//    one;
//  - an ARSession interruption mid-walk DISCARDS the walk with a plain
//    message (§2 v1 — no partial records, no synthetic ghosts);
//  - the mode is LOCKED at the walk edge (the coach-live-system law): the
//    countdown snapshots it; mid-walk picker changes apply next walk;
//  - image-space pose never scores (§3): Solo requires ARKit body tracking
//    — the UI blocks unsupported devices, and the engine additionally
//    refuses non-world frames.
//

import Foundation
import Combine
import SwiftUI
import XRunwayCore

/// The framing verdict must hold .good this long in positioning before the
/// countdown arms (on top of the tracker's own 500 ms publish hysteresis).
let SOLO_POSITION_HOLD_SEC: Double = 1.0

/// The framing gate tolerates this much time since the last GOOD frame
/// before it reads not-visible (review findings, both directions): the seam
/// delivers the RAW per-frame verdict, so a single flicker frame must not
/// abort a countdown — and a totally lost body delivers NO frames at all
/// (the tracker drops them), so a frozen last-verdict must not carry one
/// either. 0.5 s mirrors the tracker's own publish hysteresis
/// (framingHoldMs).
let SOLO_FRAMING_LAPSE_SEC: Double = 0.5

/// Countdown beats (3-2-1, one per second, then GO).
let SOLO_COUNTDOWN_FROM = 3

@MainActor
final class SoloSessionEngine: ObservableObject, SoloPoseConsumer {

    enum Phase: Equatable {
        case setup
        case measuring
        case positioning
        case countdown(Int)
        case walking
        case summary
        case interrupted(String)

        static func == (lhs: Phase, rhs: Phase) -> Bool {
            switch (lhs, rhs) {
            case (.setup, .setup), (.measuring, .measuring),
                (.positioning, .positioning), (.walking, .walking),
                (.summary, .summary):
                return true
            case let (.countdown(a), .countdown(b)):
                return a == b
            case let (.interrupted(a), .interrupted(b)):
                return a == b
            default:
                return false
            }
        }
    }

    @Published private(set) var phase: Phase = .setup
    /// The measured (or manually entered) line, meters — nil until set.
    @Published var lineLengthM: Double? = nil
    /// A one-line caution about the line ("under 6 m…" / "measurement
    /// looked off…"), cleared on the next measure/manual entry.
    @Published private(set) var lineNote: String? = nil
    /// Live walk readouts for the chrome (the trainee can't see them — the
    /// operator/coach can).
    @Published private(set) var elapsedSec: Double = 0
    @Published private(set) var laps: Int = 0
    /// The finished walk (set when phase == .summary).
    @Published private(set) var result: SoloWalkResult? = nil
    /// ProcessInfo.thermalState surfaced as a plain warning (SOLO-MODE §8).
    @Published private(set) var thermalWarning: Bool = false

    /// The mode picked in the UI; SNAPSHOTTED into `lockedMode` at the walk
    /// edge (countdown start) — the picker can't move the target mid-run.
    var pickedModeId: String = "beginner"
    private(set) var lockedMode: TrainingMode = getMode("beginner")

    /// The coach on/off toggle (the in-app mute — SOLO-MODE §8's law:
    /// voice.enabled is read live at every cue).
    let voice: CoachVoice

    private var core: SoloWalkCore? = nil
    private let detector = TravelReversalDetector()
    private var lineMeasure: SoloLineMeasure? = nil
    private var timer: Timer? = nil

    // Framing gate state. The gate's ONLY input is the time of the last
    // GOOD frame: in arBody mode the tracker publishes NOTHING when the
    // body is lost entirely (isTracked == false drops the frame), so a
    // stored verdict would freeze stale — and the delivered verdict is the
    // RAW per-frame one, so a single flicker must not read as loss either.
    // Both collapse into one rule: visible = a good frame within
    // SOLO_FRAMING_LAPSE_SEC (review findings).
    private var framingGoodSince: TimeInterval = -1
    private var lastGoodFramingMono: TimeInterval = -1
    private var framingGoodNow = false

    // Walk clock anchors (monotonic — ProcessInfo.systemUptime timebase,
    // the same clock the seam's monoTs rides).
    private var countdownStartedAt: TimeInterval = 0
    private var walkStartedAt: TimeInterval = 0
    private var lastCount = SOLO_COUNTDOWN_FROM + 1

    init(voice: CoachVoice) {
        self.voice = voice
    }

    private func now() -> TimeInterval {
        ProcessInfo.processInfo.systemUptime
    }

    // MARK: - Setup / line measurement

    func beginMeasure() {
        guard phase == .setup else { return }
        let m = SoloLineMeasure()
        m.reset()
        lineMeasure = m
        lineNote = nil
        phase = .measuring
        voice.say("Walk your line, then come back and tap done.")
    }

    func finishMeasure() {
        guard phase == .measuring, let m = lineMeasure else { return }
        // Phase exits never carry speech across the boundary (the web's
        // cancel-on-phase-exit law; review finding).
        voice.cancel()
        lineMeasure = nil
        phase = .setup
        guard let r = m.finish() else {
            lineNote = "Too little movement to measure - walk the whole line, or enter the length by hand."
            return
        }
        lineLengthM = r.lengthM
        if r.suspect {
            lineNote = "Tracking jumped mid-measure - re-measure or enter the length by hand."
        } else if r.short {
            lineNote = "Under \(Int(LINE_WARN_MIN_M)) m: mid-walk coaching has little room on a short line. The summary still scores fully."
        }
    }

    func cancelMeasure() {
        guard phase == .measuring else { return }
        voice.cancel()
        lineMeasure = nil
        phase = .setup
    }

    func setManualLength(_ meters: Double) {
        guard meters.isFinite, meters > 0 else { return }
        lineLengthM = (meters * 10).rounded() / 10
        lineNote = meters < LINE_WARN_MIN_M
            ? "Under \(Int(LINE_WARN_MIN_M)) m: mid-walk coaching has little room on a short line. The summary still scores fully."
            : nil
    }

    // MARK: - The walk flow

    /// START WALK: lock the mode, arm the framing gate.
    func beginWalkFlow() {
        guard phase == .setup || phase == .summary else { return }
        lockedMode = getMode(pickedModeId)
        result = nil
        framingGoodSince = -1
        framingGoodNow = false
        lastGoodFramingMono = -1
        phase = .positioning
        startTimer()
        voice.say("Walk to your start. Hold still until you hear the count.")
    }

    /// STOP (v1): any in-flight walk is discarded — no partial records.
    func stopEarly() {
        guard phase == .positioning || phase == .walking
            || isCountdown(phase)
        else { return }
        voice.cancel()
        tearDownWalk()
        phase = .setup
    }

    /// Back to setup from summary/interrupted. `result` deliberately
    /// SURVIVES (review finding: clearing it here blanked the summary sheet
    /// mid-dismiss-animation); the next walk flow clears it.
    func acknowledge() {
        guard phase == .summary || isInterrupted(phase) else { return }
        voice.cancel()
        phase = .setup
    }

    /// An ARSession interruption / failure while a walk is live (§2 v1:
    /// discard, plain message). ContentView routes the tracker's signals
    /// here; setup/measuring/summary phases just ride it out.
    func noteCaptureInterrupted(_ reason: String) {
        guard phase == .walking || phase == .positioning || isCountdown(phase)
        else { return }
        voice.cancel()
        tearDownWalk()
        phase = .interrupted(
            reason.isEmpty
                ? "The camera was interrupted - this walk was not scored."
                : reason)
    }

    private func isCountdown(_ p: Phase) -> Bool {
        if case .countdown = p { return true }
        return false
    }

    private func isInterrupted(_ p: Phase) -> Bool {
        if case .interrupted = p { return true }
        return false
    }

    private func tearDownWalk() {
        timer?.invalidate()
        timer = nil
        core = nil
        elapsedSec = 0
        laps = 0
    }

    // MARK: - SoloPoseConsumer (the PoseFrameSink seam)

    func consume(frame: PoseFrame, monoTs: TimeInterval, framing: FramingStatus) {
        ingest(frame: frame, monoTs: monoTs, framing: framing)
    }

    private var lastDetectorMono: TimeInterval = -1

    private func ingest(frame: PoseFrame, monoTs: TimeInterval, framing: FramingStatus) {
        // §3: image-space pose must NEVER silently score.
        guard frame.space == "world" else { return }
        framingGoodNow = framing == .good
        if framingGoodNow { lastGoodFramingMono = monoTs }

        switch phase {
        case .measuring:
            if let hips = hipCenter(frame.keypoints), framing != .noBody {
                lineMeasure?.ingest(x: hips.x, z: hips.z, tSec: monoTs)
            }
        case .walking:
            guard let core else { return }
            if framingGoodNow {
                // Convert the wire keypoints to Core keypoints once, feed
                // the scorer and the detector the same frame.
                var kp: [String: XRunwayCore.PoseKeypoint] = [:]
                kp.reserveCapacity(frame.keypoints.count)
                for (name, k) in frame.keypoints {
                    kp[name] = XRunwayCore.PoseKeypoint(
                        x: k.x, y: k.y, z: k.z, score: k.score)
                }
                // The core owns the §2 gap + anchor-jump guards; mirror its
                // verdict into the detector (review finding: an anchor
                // steal's 3 m hip displacement would otherwise read as
                // instant opposing travel and fabricate a mark).
                let gapsBefore = core.gapResets
                let jumpsBefore = core.anchorJumps
                core.ingest(keypoints: kp, monoTs: monoTs)
                let discontinuity =
                    core.gapResets > gapsBefore || core.anchorJumps > jumpsBefore
                if let hips = hipCenter(frame.keypoints) {
                    if discontinuity {
                        detector.noteGap()
                        lastDetectorMono = -1
                        // Re-seed the detector's anchor on this frame so the
                        // NEXT one differences a real stride.
                        detector.ingest(
                            x: hips.x, z: hips.z, dtSec: 0,
                            walkTime: monoTs - walkStartedAt)
                    } else {
                        let dt = lastDetectorMono >= 0 ? monoTs - lastDetectorMono : 0
                        lastDetectorMono = monoTs
                        detector.ingest(
                            x: hips.x, z: hips.z, dtSec: dt,
                            walkTime: monoTs - walkStartedAt)
                    }
                }
            } else {
                // §2: not-good framing contributes zero weight. Withhold
                // the frame; the core's gap rule + dark ticks own the
                // outage, and the detector must not difference across it.
                detector.noteGap()
                lastDetectorMono = -1
            }
        default:
            break
        }
    }

    /// Mean of the usable hips (the derive path's own single-hip rule).
    private func hipCenter(_ kp: [String: PoseKeypoint]) -> (x: Double, z: Double)? {
        func ok(_ n: String) -> PoseKeypoint? {
            guard let k = kp[n], k.score >= 0.3,
                k.x.isFinite, k.y.isFinite, k.z.isFinite
            else { return nil }
            return k
        }
        let l = ok("leftHip")
        let r = ok("rightHip")
        if let l, let r { return ((l.x + r.x) * 0.5, (l.z + r.z) * 0.5) }
        if let l { return (l.x, l.z) }
        if let r { return (r.x, r.z) }
        return nil
    }

    // MARK: - The 10 Hz engine timer

    private func startTimer() {
        timer?.invalidate()
        let t = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.tickTimer() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func tickTimer() {
        thermalWarning = ProcessInfo.processInfo.thermalState.rawValue
            >= ProcessInfo.ThermalState.serious.rawValue
        let mono = now()
        // Visible = a good frame within the lapse window. One rule covers
        // both flicker (raw verdicts blip) and total loss (frame silence).
        let visible =
            lastGoodFramingMono >= 0
            && mono - lastGoodFramingMono <= SOLO_FRAMING_LAPSE_SEC
        switch phase {
        case .positioning:
            if visible {
                if framingGoodSince < 0 { framingGoodSince = mono }
                if mono - framingGoodSince >= SOLO_POSITION_HOLD_SEC {
                    countdownStartedAt = mono
                    lastCount = SOLO_COUNTDOWN_FROM + 1
                    phase = .countdown(SOLO_COUNTDOWN_FROM)
                    tickCountdown(mono)
                }
            } else {
                framingGoodSince = -1
            }
        case .countdown:
            // Losing the walker during the count aborts back to the gate —
            // starting a walk nobody is framed for scores nothing.
            if !visible {
                phase = .positioning
                framingGoodSince = -1
                voice.say("Hold in frame. Starting over.")
                return
            }
            tickCountdown(mono)
        case .walking:
            guard let core else { return }
            elapsedSec = mono - walkStartedAt
            core.tick(monoTs: mono)
            if elapsedSec >= lockedMode.walkSeconds {
                finishWalk()
            }
        default:
            break
        }
    }

    private func tickCountdown(_ mono: TimeInterval) {
        let elapsed = mono - countdownStartedAt
        let remaining = SOLO_COUNTDOWN_FROM - Int(elapsed)
        if remaining <= 0 {
            beginWalk(mono)
            return
        }
        if remaining < lastCount {
            lastCount = remaining
            phase = .countdown(remaining)
            voice.countdownTick(remaining)
        }
    }

    private func beginWalk(_ mono: TimeInterval) {
        let c = SoloWalkCore(mode: lockedMode)
        c.onCue = { [weak self] cue in
            self?.voice.speakCue(cue)
        }
        core = c
        detector.reset()
        lastDetectorMono = -1
        detector.onReversal = { [weak self, weak c] atSec in
            guard let self, let c else { return }
            c.setMark(atSec: atSec)
            self.laps += 1
        }
        walkStartedAt = mono
        elapsedSec = 0
        laps = 0
        c.beginWalk(atMono: mono)
        phase = .walking
        voice.go()
    }

    private func finishWalk() {
        guard let core else { return }
        // The summary flip cancels any in-flight cue (the web's
        // cancelCoachVoice-on-phase-exit law).
        voice.cancel()
        let r = core.finish()
        result = r
        tearDownWalk()
        phase = .summary
        voice.say(r.report.passed ? "Pass. Nice walk." : "Scored. Check the summary.")
    }
}
