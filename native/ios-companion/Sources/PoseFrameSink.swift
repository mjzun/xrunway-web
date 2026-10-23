//
//  PoseFrameSink.swift
//  (X)RUNWAY iOS Companion
//
//  The tracker's publish() fan-out seams (SOLO-MODE §4 "attach, don't
//  rewrite"). Two consumers, two shapes, on purpose:
//
//  - PoseFrameSink — the streaming leg. Exactly the relay's existing
//    signature, so PoseRelayClient conforms without a body change and
//    ARBodyTracker's stored property becomes protocol-typed with the call
//    path byte-identical (`Task { await relay.send(frame: frame) }`, one
//    detached Task per frame).
//
//  - SoloPoseConsumer — the on-device training leg. @MainActor and
//    synchronous (publish() is already main-actor), so Solo ingestion adds
//    ZERO scheduling between capture and scoring, and the payload carries
//    what the wire contract cannot: the MONOTONIC capture timestamp
//    (PoseFrame.t is wall-clock milliseconds and can step backward — it
//    must never feed timing math; the codebase's own clock law) and the
//    tracker's per-frame RAW framing verdict (ARKit extrapolates cropped
//    joints at score 1.0, so keypoint presence must never stand in for
//    visibility — the §2 zero-weight gate needs the anchor's isJointTracked
//    truth, undebounced).
//

import Foundation

/// A consumer of captured pose frames at ARBodyTracker's publish fan-out.
protocol PoseFrameSink: AnyObject {
    func send(frame: PoseFrame) async
}

/// The relay already has this exact method — conformance only, no body.
extension PoseRelayClient: PoseFrameSink {}

/// The Solo engine's ingestion seam. `monoTs` is seconds on the ARKit
/// session/`systemUptime` timebase (monotonic while awake); `framing` is the
/// RAW per-frame verdict (the debounced one on TrackingState is for UI).
@MainActor
protocol SoloPoseConsumer: AnyObject {
    func consume(frame: PoseFrame, monoTs: TimeInterval, framing: FramingStatus)
}
