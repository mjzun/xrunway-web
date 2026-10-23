//
//  MetricsWiring.swift — XRunwayCore
//
//  Port of src/metrics-wiring.ts: the WIRING constants + display-smoothing
//  forms around the scoring core (SOLO-MODE §6 single-sourcing). These are
//  the seams the Solo loop re-implements around deriveWorld: the neutral
//  score bars start from, the ~6 Hz publish cadence, and the display
//  ramp/blend smoothing. The walk-replay golden family drives all of them.
//

import Foundation

/// Score every metric bar starts/ramps from (walk-start fill for
/// targets/smooth/snapshot).
public let NEUTRAL: Double = 62

/// Rounded-snapshot publish interval (s) — the ~6 Hz metrics tick.
public let PUBLISH_INTERVAL: Double = 1.0 / 6.0

/// Display values ramp in from NEUTRAL over this many seconds of walk time
/// so bars never jump on incomplete data.
public let RAMP_IN_SEC: Double = 2

/// Rate constant of the display blend toward the ramped target.
public let DISPLAY_BLEND_RATE: Double = 3

/// Ramp-in weight at `walkTime` seconds into the walk: linear 0..1 over the
/// first RAMP_IN_SEC, then 1.
public func rampInWeight(_ walkTime: Double) -> Double {
    return walkTime < RAMP_IN_SEC ? walkTime / RAMP_IN_SEC : 1
}

/// Per-frame display blend factor: 1 - exp(-DISPLAY_BLEND_RATE * dt) — the
/// frame-rate-independent EMA form shared with the scoring core.
public func displayBlend(_ delta: Double) -> Double {
    return 1 - exp(-DISPLAY_BLEND_RATE * delta)
}
