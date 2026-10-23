//
//  WalkStats.swift — XRunwayCore
//
//  1:1 port of src/walk-stats.ts (the per-walk physical measurement layer),
//  locked by the golden `walk-stats` family (19 ops tapes incl. the live-tap
//  setLive/readLive surface and the negative-half rounding landmine).
//
//  Pure scalar accumulator + summary contract for the REAL measured
//  quantities: true horizontal pace (m/s), the SIGNED lateral offset (m), the
//  SIGNED height drift from the walk-start baseline (m), and every detected
//  footstrike. All channels are duration-weighted so mixed cadences average
//  correctly; zero per-ingest allocation (plain Double fields, reset once per
//  walk; the only allocation is the WalkStats built by finalize()).
//
//  Solo channel meanings (SOLO-MODE §3 — the schema-honesty redefinitions):
//  lateral = signed offset of the hip path from the walker's OWN travel line
//  (+ = walker's right relative to travel), posture = signed hip-height drift
//  vs the walk-start baseline. The field names and math are unchanged from
//  the web; only what feeds them differs (pose-derive soloDeriveWorld).
//

import Foundation

/// Which derivation path produced (most of) a walk's measurements.
public enum WalkStatsSource: String {
    case head = "head"
    case cameraWorld = "camera-world"
    case cameraImage = "camera-image"
}

/// Real physical measurements for one walk (true units, signed).
///
/// Sign conventions (walk-stats.ts:27-41):
/// - meanLateralM / meanAbsLateralM: time-weighted means of the SIGNED
///   lateral offset; near-zero mean beside a large abs-mean = weaving that
///   averaged out.
/// - postureDriftM: time-weighted mean SIGNED height deviation from the
///   walk-start baseline. POSITIVE = above (rose / on-toes), NEGATIVE =
///   below (slouch).
/// - paceDeltaMps = meanPaceMps - idealPaceMps (POSITIVE = faster than the
///   mode's ideal).
/// - cadenceSpm = steps / (durationSec / 60); nil when no steps or a
///   non-positive duration.
/// - source: the derivation path that owned the most walk time (ties resolve
///   head > camera-image > camera-world).
///
/// A nil field means its underlying channel never produced a sample.
public struct WalkStats {
    public var meanPaceMps: Double?
    public var idealPaceMps: Double
    public var paceDeltaMps: Double?
    public var meanLateralM: Double?
    public var meanAbsLateralM: Double?
    public var postureDriftM: Double?
    public var steps: Int
    public var cadenceSpm: Double?
    public var source: WalkStatsSource

    // The synthesized memberwise init is `internal`; the framework boundary
    // (A3) needs it public — test fixtures and the Solo engine build these.
    public init(
        meanPaceMps: Double?, idealPaceMps: Double, paceDeltaMps: Double?,
        meanLateralM: Double?, meanAbsLateralM: Double?,
        postureDriftM: Double?, steps: Int, cadenceSpm: Double?,
        source: WalkStatsSource
    ) {
        self.meanPaceMps = meanPaceMps
        self.idealPaceMps = idealPaceMps
        self.paceDeltaMps = paceDeltaMps
        self.meanLateralM = meanLateralM
        self.meanAbsLateralM = meanAbsLateralM
        self.postureDriftM = postureDriftM
        self.steps = steps
        self.cadenceSpm = cadenceSpm
        self.source = source
    }
}

/// Minimum seconds between COUNTED footstrikes (mirrors pose-derive STEP_MIN).
/// A strike that re-fires faster than a physically plausible step is the same
/// physical step, not a new one. No upper bound: a strike after a long pause
/// is still a real step.
public let STEP_DEBOUNCE_SEC: Double = 0.15

/// Per-walk accumulator. The scoring loop calls reset() at walk start, then
/// feeds each channel at whatever cadence its derivation path runs. All
/// samples are duration-weighted, so mixed cadences average correctly.
public final class WalkStatsAccumulator {
    /// Live raw channels for the 6 Hz recorder tap and the live audio coach's
    /// 2 Hz policy sample — dumb assignable fields written by the scoring
    /// core where the smoothed values live (paceMps = the speed EMA the pace
    /// score maps from; lateralM = the latest SIGNED lateral offset;
    /// postureM = the latest SIGNED height deviation, + = above baseline).
    /// nil while the active source doesn't measure the channel. Honesty
    /// gating (isFinite) happens at the CONSUMERS, exactly like the web.
    public var livePaceMps: Double? = nil
    public var liveLateralM: Double? = nil
    public var livePostureM: Double? = nil

    private var idealPace: Double = 0
    private var paceSum: Double = 0
    private var paceTime: Double = 0
    private var latSum: Double = 0
    private var latAbsSum: Double = 0
    private var latTime: Double = 0
    private var postSum: Double = 0
    private var postTime: Double = 0
    private var stepCount: Int = 0
    private var lastStepAt: Double = -1
    private var tHead: Double = 0
    private var tImage: Double = 0
    private var tWorld: Double = 0

    public init() {}

    /// Arm for a new walk, locking the mode's ideal pace (m/s) for this run.
    public func reset(_ idealPaceMps: Double) {
        idealPace = idealPaceMps
        paceSum = 0
        paceTime = 0
        latSum = 0
        latAbsSum = 0
        latTime = 0
        postSum = 0
        postTime = 0
        stepCount = 0
        lastStepAt = -1
        tHead = 0
        tImage = 0
        tWorld = 0
        livePaceMps = nil
        liveLateralM = nil
        livePostureM = nil
    }

    /// Clear ONLY the lateral channel (mid-walk geometry remap): every
    /// accumulated lateral sample was measured against the old reference, so
    /// keeping it would blend two geometries into one persisted mean. Pace /
    /// posture / steps / source time are reference-independent and survive.
    public func resetLateral() {
        latSum = 0
        latAbsSum = 0
        latTime = 0
    }

    /// Credit `dtSec` of walk time to a derivation path (source dominance).
    public func noteSource(_ source: WalkStatsSource, _ dtSec: Double) {
        if !(dtSec > 0) { return }
        switch source {
        case .head: tHead += dtSec
        case .cameraWorld: tWorld += dtSec
        case .cameraImage: tImage += dtSec
        }
    }

    /// One horizontal-speed sample (TRUE m/s), weighted by its interval.
    public func addPace(_ speedMps: Double, _ dtSec: Double) {
        if !(dtSec > 0) || !speedMps.isFinite { return }
        paceSum += speedMps * dtSec
        paceTime += dtSec
    }

    /// One SIGNED lateral offset sample (m) — see WalkStats.meanLateralM.
    public func addLateral(_ lateralM: Double, _ dtSec: Double) {
        if !(dtSec > 0) || !lateralM.isFinite { return }
        latSum += lateralM * dtSec
        latAbsSum += (lateralM < 0 ? -lateralM : lateralM) * dtSec
        latTime += dtSec
    }

    /// One SIGNED height deviation sample (m, + = above the baseline).
    public func addPosture(_ deviationM: Double, _ dtSec: Double) {
        if !(dtSec > 0) || !deviationM.isFinite { return }
        postSum += deviationM * dtSec
        postTime += dtSec
    }

    /// One detected footstrike at `atSec` (seconds into the walk). Strikes
    /// closer than STEP_DEBOUNCE_SEC to the previous one are the same
    /// physical step and are not re-counted.
    public func addStep(_ atSec: Double) {
        if lastStepAt >= 0 && atSec - lastStepAt < STEP_DEBOUNCE_SEC {
            return
        }
        lastStepAt = atSec
        stepCount += 1
    }

    /// Freeze the walk into a WalkStats (non-destructive — the accumulator
    /// keeps its state until the next reset()). Returns nil only when the
    /// walk never produced a sample on ANY channel.
    public func finalize(_ durationSec: Double) -> WalkStats? {
        let ranAtAll =
            paceTime > 0 || latTime > 0 || postTime > 0 || stepCount > 0
            || tHead > 0 || tImage > 0 || tWorld > 0
        if !ranAtAll { return nil }

        // Dominant source by accumulated derivation time; ties keep the
        // earlier-checked (always-on head first, then camera-image).
        var source = WalkStatsSource.head
        var best = tHead
        if tImage > best {
            source = .cameraImage
            best = tImage
        }
        if tWorld > best {
            source = .cameraWorld
        }

        let meanPace: Double? = paceTime > 0 ? paceSum / paceTime : nil
        return WalkStats(
            meanPaceMps: meanPace.map { jsRound3($0) },
            idealPaceMps: idealPace,
            paceDeltaMps: meanPace.map { jsRound3($0 - idealPace) },
            meanLateralM: latTime > 0 ? jsRound3(latSum / latTime) : nil,
            meanAbsLateralM: latTime > 0 ? jsRound3(latAbsSum / latTime) : nil,
            postureDriftM: postTime > 0 ? jsRound3(postSum / postTime) : nil,
            steps: stepCount,
            cadenceSpm: stepCount > 0 && durationSec > 0
                ? jsRound1(Double(stepCount) / (durationSec / 60))
                : nil,
            source: source
        )
    }
}
