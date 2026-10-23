//
//  ARBodyTracker.swift
//  (X)RUNWAY iOS Companion
//
//  Native body tracking — the native upgrade of the browser companion's
//  MediaPipe pipeline. Two modes, picked at runtime:
//
//  1. ARKit ARBodyTrackingConfiguration (preferred, A12+ devices). ARKit returns
//     a 3D world-space skeleton in METERS. We map ARSkeleton joints to the
//     contract keypoint names and stream world coordinates with score 1.0 — this
//     is what docs/SENSORS.md calls "strictly better" than the browser's 2D:
//     calibrated, metric, ready for true pace/stride in the app's runway frame.
//
//  2. Vision VNDetectHumanBodyPoseRequest fallback (when body tracking is
//     unsupported). Runs on the AR session's captured frame and yields 2D
//     NORMALIZED image coords (0..1, y down) — the same space the browser
//     companion streamed, so the app's side-camera derivation still works. The
//     UI says so explicitly.
//
//  Emitted PoseFrame matches src/external-tracker.ts exactly. Names map per the
//  contract: nose<-head, shoulders, hips, knees, ankles<-feet.
//

import Foundation
import ARKit
import Vision
import Combine
import simd

/// Which tracking path is live.
enum TrackingMode: Equatable {
    case unknown
    case arBody          // ARBodyTrackingConfiguration — world-space meters
    case visionFallback  // VNDetectHumanBodyPoseRequest — normalized 2D
}

/// Live framing quality, derived from which contract keypoints the tracker is
/// actually seeing — the tripod-placement feedback loop (POLISH-AUDIT #13).
/// Raw per-frame verdicts pass through hysteresis (see updateFraming) before
/// they publish, so the on-screen tip never flickers at frame rate.
enum FramingStatus: Equatable {
    case unknown   // not evaluated yet (just started / stopped)
    case noBody    // nobody detected in frame
    case feetOut   // body found but no ankle visible — too close / aimed too high
    case headOut   // body found but no head visible — aimed too low
    case partial   // body found but the hips aren't readable — framing marginal
    case good      // head + hips + ankles all visible
}

/// Observable mirror for the SwiftUI layer: latest skeleton + capture FPS + mode.
@MainActor
final class TrackingState: ObservableObject {
    /// Latest keypoints for the overlay. In `.arBody` these are world meters; in
    /// `.visionFallback` they are normalized image coords (0..1, y down).
    @Published var keypoints: [String: PoseKeypoint] = [:]
    @Published var mode: TrackingMode = .unknown
    @Published var captureFps: Int = 0
    /// True when a body is currently detected this frame.
    @Published var bodyVisible: Bool = false
    /// Debounced framing verdict for the live tripod-setup tip (see
    /// FramingStatus). Updates at most a few times per second.
    @Published var framing: FramingStatus = .unknown
    /// Human-readable note for the UI (e.g. fallback reason).
    @Published var note: String = ""
    /// Non-empty when the AR session itself FAILED (camera unavailable, sensor
    /// error). Kept separate from `note` so ContentView can surface it in
    /// every relay phase — a relay-status line must never mask a dead camera.
    @Published var sessionError: String = ""
    /// LEVEL-wise system-interruption state (call / FaceTime PiP / Split
    /// View holding the camera). A TYPED channel, not the `note` string —
    /// the Solo engine must be able to consult it when a walk STARTS during
    /// an interruption, not just catch a wording-coupled rising edge
    /// (review finding).
    @Published var captureInterrupted: Bool = false
}

/// Owns the ARSession and produces PoseFrames. Hands each frame to the relay
/// client (throttled there to <=30/s). UIKit/ARKit callbacks are main-actor.
@MainActor
final class ARBodyTracker: NSObject, ObservableObject, ARSessionDelegate {

    let session = ARSession()
    let state: TrackingState
    /// The streaming sink (protocol-typed; the concrete PoseRelayClient in
    /// the app). Its call path in publish() is byte-identical to the
    /// pre-seam code — one detached Task per frame.
    private let relay: PoseFrameSink
    /// The Solo engine's ingestion seam (PoseFrameSink.swift). Weak: the
    /// engine owns its own lifecycle; the tracker never keeps a walk alive.
    weak var soloSink: SoloPoseConsumer?

    private var mode: TrackingMode = .unknown
    private var running = false
    private(set) var source: String = "iphone-arkit"

    // Capture-FPS measurement (rolling 1s window of frame timestamps in ms).
    private var frameTimes: [Double] = []

    // Framing hysteresis (POLISH-AUDIT #13): a raw verdict must hold for
    // framingHoldMs of consecutive frames before it publishes, and publishes
    // are spaced at least framingMinGapMs apart — so the tip is stable to read
    // (no per-frame flicker when a joint hovers at the confidence threshold)
    // yet still answers a tripod adjustment within ~a second. Monotonic clock.
    private static let framingHoldMs: Double = 500
    private static let framingMinGapMs: Double = 300
    private var framingCandidate: FramingStatus = .unknown
    private var framingCandidateSince: Double = 0
    private var lastFramingPublish: Double = 0
    // Latest per-joint framing verdict from the ARKit body anchor (see
    // framingFromBodyAnchor). Kept separate from the streamed keypoints because
    // ARKit ESTIMATES cropped joints instead of dropping them — key presence in
    // the skeleton says nothing about what the camera actually sees.
    private var arFraming: FramingStatus = .noBody

    // Serialize Vision work off the main actor. The request itself is created
    // fresh inside the queue (a lightweight descriptor) so no main-actor state is
    // touched off the main actor — see runVision(on:).
    private let visionQueue = DispatchQueue(label: "xrunway.vision", qos: .userInitiated)
    private var visionBusy = false

    init(relay: PoseFrameSink, state: TrackingState) {
        self.relay = relay
        self.state = state
        super.init()
        self.session.delegate = self
    }

    /// True if this device can do ARKit world-space body tracking.
    static var bodyTrackingSupported: Bool {
        ARBodyTrackingConfiguration.isSupported
    }

    // MARK: - Control

    func start(source: String) {
        self.source = source.isEmpty ? "iphone-arkit" : source
        running = true
        frameTimes.removeAll()
        state.sessionError = ""
        state.captureInterrupted = false
        resetFraming()

        if Self.bodyTrackingSupported {
            mode = .arBody
            let config = ARBodyTrackingConfiguration()
            config.automaticSkeletonScaleEstimationEnabled = true
            session.run(config, options: [.resetTracking, .removeExistingAnchors])
            state.mode = .arBody
        } else {
            mode = .visionFallback
            // A world-tracking session still gives us camera frames for Vision.
            let config = ARWorldTrackingConfiguration()
            session.run(config, options: [.resetTracking, .removeExistingAnchors])
            state.mode = .visionFallback
        }
        state.note = streamingNote
    }

    /// The mode's baseline status-line note — set at start and restored when a
    /// system interruption ends (so the pause note never outlives the pause).
    private var streamingNote: String {
        mode == .arBody
            ? "Streaming 3D body tracking to the headset."
            : "Streaming simplified 2D tracking to the headset."
    }

    func stop() {
        running = false
        session.pause()
        state.bodyVisible = false
        state.captureFps = 0
        state.keypoints = [:]
        state.sessionError = ""
        resetFraming()
    }

    // MARK: - ARSessionDelegate

    nonisolated func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        // ARKit body anchors arrive here in ARBodyTracking mode (main thread).
        for anchor in anchors {
            if let body = anchor as? ARBodyAnchor {
                MainActor.assumeIsolated {
                    // ARKit keeps delivering this anchor with isTracked == false
                    // and FROZEN joint transforms after the body leaves frame.
                    // Streaming those as score-1.0 world points would read on the
                    // headset as a motionless body forever (bodyVisible never
                    // clears; the app's freshness clock stays alive). Drop them
                    // and report the body as not visible.
                    guard body.isTracked else {
                        self.state.bodyVisible = false
                        self.arFraming = .noBody
                        return
                    }
                    // Framing truth comes from the anchor's per-joint tracking
                    // flags, NOT from the streamed keypoints — those stay
                    // model-complete even when the feet/head are cropped.
                    self.arFraming = Self.framingFromBodyAnchor(body)
                    let frame = Self.frameFromBodyAnchor(body, source: self.source)
                    // Monotonic capture stamp for the Solo sink: the current
                    // ARFrame's timestamp (the frame that carried this anchor
                    // update, session timebase), falling back to the same
                    // clock's raw read. NEVER frame.t — that is wall-clock.
                    let monoTs = self.session.currentFrame?.timestamp
                        ?? ProcessInfo.processInfo.systemUptime
                    self.publish(frame, bodyVisible: true, monoTs: monoTs)
                }
            }
        }
    }

    nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
        // Used for capture-FPS and for the Vision fallback path.
        MainActor.assumeIsolated {
            self.onFrame(frame)
        }
    }

    nonisolated func session(_ session: ARSession, didFailWithError error: Error) {
        MainActor.assumeIsolated {
            // A failure delivered after a deliberate stop() pertains to the
            // paused session — noise that would mask the healthy idle Ready
            // state (stop() already cleared sessionError). Mirrors onFrame.
            guard self.running else { return }
            // Route failures into the dedicated error channel (NOT `note`,
            // which the UI only shows while the relay is connected) so the
            // real cause is visible whatever the relay is doing.
            if let arError = error as? ARError, arError.code == .cameraUnauthorized {
                self.state.sessionError = "Camera access is off — allow it in Settings > Privacy & Security > Camera."
            } else {
                self.state.sessionError = "AR session failed: \(error.localizedDescription)"
            }
            // Mirror stop()'s UI reset: a dead session stops delivering frames,
            // so without this the last skeleton keeps drawing and the FPS/SEND
            // badges freeze at live-looking values that contradict the error.
            self.state.bodyVisible = false
            self.state.keypoints = [:]
            self.state.captureFps = 0
            self.frameTimes.removeAll()
            // A dead session can't judge framing — hide the tip, don't tell
            // the user to move the tripod when the camera is the problem.
            self.resetFraming()
        }
    }

    nonisolated func sessionWasInterrupted(_ session: ARSession) {
        MainActor.assumeIsolated {
            // Interruptions (incoming call, FaceTime PiP taking the camera,
            // iPad Split View) stop frame delivery WITHOUT didFailWithError,
            // so without this the skeleton, FPS badges, and framing chip
            // freeze at live-looking values while nothing is being captured —
            // the exact bug class the failure handler above documents. Same
            // `guard running` discipline: an interruption delivered after a
            // deliberate stop() is noise about a paused session.
            guard self.running else { return }
            self.state.bodyVisible = false
            self.state.keypoints = [:]
            self.state.captureFps = 0
            self.frameTimes.removeAll()
            // A paused session can't judge framing — hide the tip rather than
            // pin the last verdict (plausibly a green "Framing good").
            self.resetFraming()
            self.state.note = "Camera paused by the system."
            self.state.captureInterrupted = true
        }
    }

    nonisolated func sessionInterruptionEnded(_ session: ARSession) {
        MainActor.assumeIsolated {
            guard self.running else { return }
            // Frames resume on their own: FPS, the skeleton, and the framing
            // verdict all re-derive through the normal hysteresis. Only the
            // pause note needs clearing back to the mode's streaming line.
            self.state.note = self.streamingNote
            self.state.captureInterrupted = false
        }
    }

    // MARK: - Frame handling

    private func onFrame(_ frame: ARFrame) {
        guard running else { return }
        measureFps()
        updateFraming()
        if mode == .visionFallback {
            runVision(on: frame)
        }
    }

    private func measureFps() {
        let now = Date().timeIntervalSince1970 * 1000
        frameTimes.append(now)
        let cutoff = now - 1000
        while let first = frameTimes.first, first < cutoff {
            frameTimes.removeFirst()
        }
        state.captureFps = frameTimes.count
    }

    // MARK: - Framing feedback (POLISH-AUDIT #13)

    /// The framing verdict the CURRENT frame's data suggests, from data the
    /// tracker already publishes. In Vision mode a missing joint literally
    /// means "out of frame or unreadable" (per-joint confidence gate). In
    /// ARKit mode the streamed skeleton is model-complete whenever the body
    /// is tracked — ARKit keeps isTracked == true and EXTRAPOLATES cropped
    /// joints when the feet or head leave the frame — so key presence proves
    /// nothing there; the verdict instead comes from the anchor's per-joint
    /// tracking flags (framingFromBodyAnchor), captured in the anchor handler.
    private func rawFraming() -> FramingStatus {
        guard state.bodyVisible, !state.keypoints.isEmpty else { return .noBody }
        if mode == .arBody { return arFraming }
        let kp = state.keypoints
        let anyAnkle = kp[Keypoint.leftAnkle] != nil || kp[Keypoint.rightAnkle] != nil
        let anyHip = kp[Keypoint.leftHip] != nil || kp[Keypoint.rightHip] != nil
        // Vision reports near-zero nose confidence whenever the walker faces
        // AWAY from the camera — the walk-away half of every runway pass — so
        // the nose alone can't stand for the head. Accept both shoulders as
        // head-family proof: if both shoulders are readable the top of the
        // body is in frame, and a back-facing walker with shoulders + hips +
        // ankles reads as good framing instead of "Aim higher".
        let head = kp[Keypoint.nose] != nil
            || (kp[Keypoint.leftShoulder] != nil && kp[Keypoint.rightShoulder] != nil)
        if !anyAnkle { return .feetOut }
        if !head { return .headOut }
        if !anyHip { return .partial }
        return .good
    }

    /// Per-joint framing truth for ARKit mode (POLISH-AUDIT #13). ARKit keeps
    /// delivering a tracked, model-complete skeleton while the feet or head
    /// are cropped out of shot — exactly the tripod mistakes this chip exists
    /// to catch — but it marks those joints as no longer TRACKED (estimated
    /// instead). ARSkeleton.isJointTracked(_:) is therefore the visibility
    /// source of truth; count a body part as in frame only when at least one
    /// of its joints is actively tracked. Same joint names as
    /// frameFromBodyAnchor below, same verdict ladder as rawFraming().
    nonisolated static func framingFromBodyAnchor(_ anchor: ARBodyAnchor) -> FramingStatus {
        let skeleton = anchor.skeleton
        let jointNames = skeleton.definition.jointNames

        func tracked(_ raw: String) -> Bool {
            guard let index = jointNames.firstIndex(of: raw) else { return false }
            return skeleton.isJointTracked(index)
        }

        let anyAnkle = tracked("left_foot_joint") || tracked("right_foot_joint")
        let head = tracked(ARSkeleton.JointName.head.rawValue)
        let anyHip = tracked("left_upLeg_joint") || tracked("right_upLeg_joint")
            || tracked(ARSkeleton.JointName.root.rawValue)
        if !anyAnkle { return .feetOut }
        if !head { return .headOut }
        if !anyHip { return .partial }
        return .good
    }

    /// Hysteresis + throttle: publish a new verdict only after it has held for
    /// framingHoldMs, and never more often than every framingMinGapMs.
    private func updateFraming() {
        let now = ProcessInfo.processInfo.systemUptime * 1000
        let raw = rawFraming()
        if raw != framingCandidate {
            framingCandidate = raw
            framingCandidateSince = now
            return
        }
        guard raw != state.framing,
              now - framingCandidateSince >= Self.framingHoldMs,
              now - lastFramingPublish >= Self.framingMinGapMs else { return }
        lastFramingPublish = now
        state.framing = raw
    }

    private func resetFraming() {
        framingCandidate = .unknown
        framingCandidateSince = 0
        lastFramingPublish = 0
        arFraming = .noBody
        state.framing = .unknown
    }

    /// Publish a frame to the UI overlay, the Solo sink, and the relay —
    /// THE single fan-out for every captured frame.
    private func publish(_ frame: PoseFrame, bodyVisible: Bool, monoTs: TimeInterval) {
        guard running else { return }
        state.keypoints = frame.keypoints
        state.bodyVisible = bodyVisible
        // Solo first: synchronous on the main actor (no Task hop between
        // capture and scoring); a nil sink costs one branch.
        soloSink?.consume(frame: frame, monoTs: monoTs, framing: arFraming)
        Task { await relay.send(frame: frame) }
    }

    // MARK: - ARKit -> PoseFrame (world-space meters)

    /// Map an ARBodyAnchor's ARSkeleton3D to a PoseFrame in WORLD meters.
    ///
    /// ARKit joint model-transforms are relative to the hips (the skeleton root);
    /// we compose with the anchor's world transform so the streamed coordinates
    /// are world-space, matching what the app's runway frame expects from a
    /// native source (docs/SENSORS.md).
    nonisolated static func frameFromBodyAnchor(_ anchor: ARBodyAnchor, source: String) -> PoseFrame {
        let skeleton = anchor.skeleton
        let root = anchor.transform // hips/root -> world

        func worldPoint(_ jointName: ARSkeleton.JointName) -> PoseKeypoint? {
            guard let local = skeleton.modelTransform(for: jointName) else { return nil }
            let world = simd_mul(root, local)
            let p = world.columns.3 // translation column
            return PoseKeypoint(x: Double(p.x), y: Double(p.y), z: Double(p.z), score: 1.0)
        }

        var kp: [String: PoseKeypoint] = [:]

        // ARSkeleton.JointName provides the canonical named joints; less-common
        // joints (knees/ankles) are addressed by their model joint name strings.
        func named(_ raw: String) -> PoseKeypoint? {
            worldPoint(ARSkeleton.JointName(rawValue: raw))
        }

        if let v = worldPoint(.head)          { kp[Keypoint.nose] = v }
        if let v = worldPoint(.leftShoulder)  { kp[Keypoint.leftShoulder] = v }
        if let v = worldPoint(.rightShoulder) { kp[Keypoint.rightShoulder] = v }

        // Hips: ARKit exposes left/right upper-leg joints; the named .root is the
        // hip center. Map left/right hip from the leg roots when available.
        if let v = named("left_upLeg_joint")  { kp[Keypoint.leftHip] = v }
        if let v = named("right_upLeg_joint") { kp[Keypoint.rightHip] = v }
        // Fallbacks if the rig names differ: derive hips from the root center.
        if kp[Keypoint.leftHip] == nil || kp[Keypoint.rightHip] == nil {
            if let hipCenter = worldPoint(.root) {
                if kp[Keypoint.leftHip] == nil  { kp[Keypoint.leftHip] = hipCenter }
                if kp[Keypoint.rightHip] == nil { kp[Keypoint.rightHip] = hipCenter }
            }
        }

        if let v = named("left_leg_joint")    { kp[Keypoint.leftKnee] = v }
        if let v = named("right_leg_joint")   { kp[Keypoint.rightKnee] = v }
        if let v = named("left_foot_joint")   { kp[Keypoint.leftAnkle] = v }
        if let v = named("right_foot_joint")  { kp[Keypoint.rightAnkle] = v }

        return PoseFrame(t: nowMs(), source: source, space: "world", keypoints: kp)
    }

    // MARK: - Vision fallback (normalized 2D image coords)

    private func runVision(on frame: ARFrame) {
        guard !visionBusy else { return }
        visionBusy = true
        let pixelBuffer = frame.capturedImage
        let source = self.source
        // ARKit's capturedImage is camera-native landscape-right; .right gets a
        // human-upright orientation for Vision so y-down normalized coords align
        // with the browser's image space.
        visionQueue.async {
            // Fresh request per detection: keeps Vision state OFF the main actor
            // (a reused @MainActor-isolated request would be a data race here).
            let request = VNDetectHumanBodyPoseRequest()
            let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer,
                                                orientation: .right,
                                                options: [:])
            var keypoints: [String: PoseKeypoint] = [:]
            do {
                try handler.perform([request])
                if let obs = request.results?.first {
                    keypoints = Self.keypointsFromVision(obs)
                }
            } catch {
                // Transient detect failure — emit nothing this frame.
            }
            let frameOut = PoseFrame(t: Self.nowMs(), source: source, space: "image", keypoints: keypoints)
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.visionBusy = false
                // Vision frames are image-space — the Solo engine refuses
                // them (space gate) — so a loose monotonic stamp is fine.
                self.publish(frameOut, bodyVisible: !keypoints.isEmpty,
                             monoTs: ProcessInfo.processInfo.systemUptime)
            }
        }
    }

    /// Map a Vision body-pose observation to normalized image keypoints (0..1,
    /// y DOWN to match the browser companion's image space; Vision is y-up so we
    /// flip). z = 0 (Vision is 2D).
    nonisolated static func keypointsFromVision(_ obs: VNHumanBodyPoseObservation) -> [String: PoseKeypoint] {
        let map: [(VNHumanBodyPoseObservation.JointName, String)] = [
            (.nose, Keypoint.nose),
            (.leftShoulder, Keypoint.leftShoulder),
            (.rightShoulder, Keypoint.rightShoulder),
            (.leftHip, Keypoint.leftHip),
            (.rightHip, Keypoint.rightHip),
            (.leftKnee, Keypoint.leftKnee),
            (.rightKnee, Keypoint.rightKnee),
            (.leftAnkle, Keypoint.leftAnkle),
            (.rightAnkle, Keypoint.rightAnkle),
        ]
        var kp: [String: PoseKeypoint] = [:]
        for (joint, name) in map {
            guard let point = try? obs.recognizedPoint(joint) else { continue }
            guard point.confidence >= 0.3 else { continue }
            // Vision: origin bottom-left, y up. Browser image space: y down.
            kp[name] = PoseKeypoint(
                x: Double(point.location.x),
                y: Double(1.0 - point.location.y),
                z: 0,
                score: Double(point.confidence)
            )
        }
        return kp
    }

    // MARK: - Clock

    /// Milliseconds in this device's clock — re-stamped by the headset on arrival
    /// (src/pose-ingest.ts), so only monotonicity matters.
    nonisolated static func nowMs() -> Double {
        Date().timeIntervalSince1970 * 1000
    }
}
