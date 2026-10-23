//
//  PoseFrame.swift
//  (X)RUNWAY iOS Companion
//
//  The wire contract shared by every (X)RUNWAY pose source. Ported 1:1 from the
//  TypeScript source of truth:
//
//    src/external-tracker.ts   — PoseFrame / PoseKeypoint shape
//    public/companion/index.html — buildPoseFrame() field semantics
//    docs/SENSORS.md           — native ARKit upgrade = WORLD-SPACE meters
//
//  A frame is JSON-encoded and sent as the `frame` field of a relay message:
//
//    { "type": "pose", "frame": PoseFrame }
//
//  PoseFrame = {
//    t: number          // capture time in ms (THIS device's clock)
//    source: string     // label, e.g. "iphone-arkit"
//    keypoints: Record<name, { x, y, z, score }>
//  }
//
//  Keypoint names (exactly these, per the contract / pose-ingest.ts consumer):
//    nose, leftShoulder, rightShoulder, leftHip, rightHip,
//    leftKnee, rightKnee, leftAnkle, rightAnkle
//
//  Coordinate spaces (what the app's MetricsSystem.deriveFromPose expects):
//    - Browser companion streamed NORMALIZED IMAGE coords (0..1, y down), z = relative depth.
//    - This native ARKit companion streams WORLD-SPACE METERS (ARKit right-handed,
//      +y up). docs/SENSORS.md: native world tracking is "strictly better" — the
//      app side is unchanged; it just gets calibrated metric coordinates.
//    - The Vision 2D fallback streams normalized image coords (0..1, y down), like
//      the browser, so the side-camera derivation still works when body tracking
//      is unavailable.
//

import Foundation

/// One body keypoint. Matches `PoseKeypoint` in src/external-tracker.ts.
/// In ARKit mode x/y/z are meters in the world frame; in Vision mode x/y are
/// normalized image coords (0..1, y down) and z is 0.
struct PoseKeypoint: Codable, Equatable {
    var x: Double
    var y: Double
    var z: Double
    /// 0..1 detector confidence. ARKit tracked joints report 1.0.
    var score: Double
}

/// One frame of external body tracking. Matches `PoseFrame` in
/// src/external-tracker.ts. `keypoints` is a sparse name -> position map.
struct PoseFrame: Codable, Equatable {
    /// Capture clock in milliseconds, in THIS device's time domain. The headset
    /// re-stamps on arrival (src/pose-ingest.ts), so absolute epoch is irrelevant
    /// — only monotonicity / freshness matters.
    var t: Double
    /// Source label, e.g. "iphone-arkit".
    var source: String
    /// Coordinate space: "world" (ARKit meters) or "image" (Vision normalized).
    var space: String
    /// Sparse keypoint map keyed by the canonical names above.
    var keypoints: [String: PoseKeypoint]
}

/// Canonical keypoint names the app consumes. Single source so the tracker and
/// the overlay agree. Order is the skeleton's head-to-toe reading order.
enum Keypoint {
    static let nose = "nose"
    static let leftShoulder = "leftShoulder"
    static let rightShoulder = "rightShoulder"
    static let leftHip = "leftHip"
    static let rightHip = "rightHip"
    static let leftKnee = "leftKnee"
    static let rightKnee = "rightKnee"
    static let leftAnkle = "leftAnkle"
    static let rightAnkle = "rightAnkle"

    /// All names the app expects, in the contract's listed order.
    static let all: [String] = [
        nose, leftShoulder, rightShoulder, leftHip, rightHip,
        leftKnee, rightKnee, leftAnkle, rightAnkle,
    ]

    /// Bone pairs for the on-screen skeleton overlay (mirrors SKELETON_BONES in
    /// the browser companion, restricted to the joints we actually emit).
    static let bones: [(String, String)] = [
        (leftShoulder, rightShoulder), // shoulders
        (leftShoulder, leftHip),       // left torso
        (rightShoulder, rightHip),     // right torso
        (leftHip, rightHip),           // hips
        (leftHip, leftKnee),           // left thigh
        (leftKnee, leftAnkle),         // left shin
        (rightHip, rightKnee),         // right thigh
        (rightKnee, rightAnkle),       // right shin
        (nose, leftShoulder),          // neck-ish
        (nose, rightShoulder),
    ]
}

// MARK: - Relay envelope messages

/// Sent on socket open to identify ourselves to the relay.
/// `{ "type": "hello", "role": "sender", "source": "iphone-arkit" }`
struct HelloMessage: Codable {
    let type: String
    let role: String
    let source: String

    init(source: String) {
        self.type = "hello"
        self.role = "sender"
        self.source = source
    }
}

/// Wraps a frame for the wire: `{ "type": "pose", "frame": PoseFrame }`.
struct PoseMessage: Codable {
    let type: String
    let frame: PoseFrame

    init(frame: PoseFrame) {
        self.type = "pose"
        self.frame = frame
    }
}
