//
//  PoseDerive.swift — XRunwayCore
//
//  Port of src/pose-derive.ts: the WORLD-SPACE (native ARKit) scoring core —
//  `deriveWorld` (web behavior, byte-equivalent) and `soloDeriveWorld` (the
//  SOLO-MODE §3 producer). Locked by the pose-derive-world / solo-derive /
//  gap-tape golden families (frame-invariance twins included) and, through
//  the wiring seams, by walk-replay.
//
//  Numeric ground rules honored here (SOLO-MODE §5):
//  - Double everywhere for state and math; the ONLY Float32 is where the TS
//    has a Float32Array — the 7-slot `target` sink and the step-interval
//    ring — mirrored as [Float] so the port reproduces the web's exact
//    quantization (the golden tolerance's 1e-6 relative term exists because
//    the emitted targets are f32-quantized; the ring feeds BACK into the
//    rhythm mean/MAD, so it must quantize identically, not just closely).
//  - The `1 - exp(-k * span)` EMA forms and every formula keep the TS
//    operation ORDER verbatim.
//  - JS falsy `|| fallback` sites are mirrored explicitly (0 -> fallback).
//

import Foundation

// ---------------------------------------------------------------------------
// Pose types (the pure slice of external-tracker.ts the core consumes).
// ---------------------------------------------------------------------------

public struct PoseKeypoint {
    public var x: Double
    public var y: Double
    public var z: Double
    public var score: Double

    public init(x: Double, y: Double, z: Double, score: Double) {
        self.x = x
        self.y = y
        self.z = z
        self.score = score
    }
}

/// The scoring core reads only `keypoints`; `t` is the frame's timestamp in
/// the sender's ms clock (payload-only here — the FRESH-FRAME gate around the
/// derive owns it, never poseDt; SOLO-MODE §4's dt/anchor law).
public struct PoseFrame {
    public var t: Double
    public var keypoints: [String: PoseKeypoint]

    public init(t: Double, keypoints: [String: PoseKeypoint]) {
        self.t = t
        self.keypoints = keypoints
    }
}

// ---------------------------------------------------------------------------
// Tuning shared by all derivation paths (verbatim from pose-derive.ts).
// ---------------------------------------------------------------------------

public let SCORE_MIN: Double = 40
/// 100 (was 98) — the perfect=100 rescale (founder ruling 2026-07-09):
/// anchors moved to 100, slopes and SCORE_MIN unchanged. Mirrors
/// pose-derive.ts byte-for-byte.
public let SCORE_MAX: Double = 100

/// The ruler stamp minted into every history row scored by THIS engine —
/// the TS SCORE_SCALE_STAMP twin. Absent rows read "s98.v1" (SessionGrading
/// rowScoreScale); old-ruler rows never blend into PB/benchmark/trends.
/// Bumped to v3 by PACE Part B (the asymmetric control band, 2026-07-16).
public let SCORE_SCALE_STAMP = "s100-pb.v3"

/// PACE Part B — the asymmetric control band (docs/PACE-RECONCILE.md).
/// Mirrors pose-derive.ts paceBandScore byte-for-byte: full credit inside
/// the band; beyond it, slow costs ~2x what fast does.
public let PACE_BAND_MPS: Double = 0.1
public let PACE_K_SLOW: Double = 90
public let PACE_K_FAST: Double = 45

/// The pace score BEFORE clamping (callers clamp like every other channel).
public func paceBandScore(_ speed: Double, _ idealPace: Double) -> Double {
    let d = speed - idealPace
    if d > PACE_BAND_MPS { return 100 - (d - PACE_BAND_MPS) * PACE_K_FAST }
    if d < -PACE_BAND_MPS { return 100 - (-d - PACE_BAND_MPS) * PACE_K_SLOW }
    return 100
}

/// Plausible step-interval window (s).
public let STEP_MIN: Double = 0.15
public let STEP_MAX: Double = 1.2
public let RING_SIZE: Int = 8

public func clampScore(_ v: Double) -> Double {
    return v < SCORE_MIN ? SCORE_MIN : (v > SCORE_MAX ? SCORE_MAX : v)
}

/// SOLO M1 slope — the §3 posture redefinition's score mapping, DERIVED (the
/// SOLO-MODE §5 rule: never a copied magic number):
///
/// The head path anchors its curve `100 - heightDevEma * 350` (anchor 96 ->
/// 100 in the perfect=100 rescale; the SLOPE never moved) at two points:
/// a clean walk (natural head bob folds to a ~1.0 cm |dev| EMA) scores
/// ~92.5, and the curve crosses the LOWEST pass bar (75, Modes) at
/// dev = 21/350 = 0.06 m — which is exactly where POSTURE_CUE_M was set.
/// Solo M1 mirrors the SHAPE onto the hip (100 - soloHipDevEma * K), but the
/// hip channel's clean-walk noise is larger: gait bobs the hip ~2 cm
/// (amplitude A = 0.02 m — the same bob the rhythm channel's TH = 0.008 m
/// was tuned against; mean |A sin| = 2A/pi ~ 1.27 cm) where the damped head
/// bobs ~1 cm. Keeping the clean-walk score equal re-derives the slope:
/// K = 350 * (0.010 / 0.0127) = 275.6, rounded to 280 so the bar-crossing
/// gate lands on a clean value. Cross-checks: clean walk scores
/// 100 - 280*0.0127 = 96.4 (head: 96.5); the curve crossed the OLD lowest pass
/// bar at |dev| EMA = 21/280 = 0.075 m, which is therefore the re-derived
/// SOLO_POSTURE_CUE_M (CoachLive) — the same score-bar rule that produced
/// the head gate 0.06 = 21/350.
public let SOLO_POSTURE_SLOPE: Double = 280

/// SOLO lateral needs a STABLE travel line before the hip-path offset may
/// integrate. The heading EMA folds UNIT displacement directions, so its
/// magnitude is its own confidence: 1 = perfectly steady travel, warm-up
/// starts at 0, and a mid-walk reversal pulls it through 0 while the old and
/// new directions cancel. Gating at 0.9 (recent directions agree within
/// ~25 deg) keeps the warm-up direction error out of the offset integral —
/// without it, the first ~1.5 s of heading convergence integrated a phantom
/// ~sway-amplitude DC offset that a clean walk carried forever — and it
/// self-excludes turns even when the caller's turnExcluded flag is late.
public let SOLO_HEADING_STABLE_MIN: Double = 0.9

/// SOLO lateral baseline window (s): the reported offset is the raw integral
/// minus its own running mean over the first second of measurement — the
/// posture walk-start-baseline law mirrored onto the lateral channel. The
/// integral's zero is the hip position at measurement start, an ARBITRARY
/// sway phase (+-swayAmp); averaging over one full sway period (~1.1 s at a
/// 1.8 Hz gait) re-centers the reference on the sway MEAN, so a clean walk
/// reads ~0 instead of the sway phase it happened to start on.
public let SOLO_LATERAL_BASELINE_SEC: Double = 1.0

/// SOLO §2 gap rule (s): any inter-frame gap above this — or any interval
/// where framing is not good — contributes ZERO stats weight. The caller
/// (the Solo engine loop) calls resetCadence() and re-arms its fresh-frame
/// gate, so the first frame after the gap RE-SEEDS the hip anchor instead
/// of differencing across the outage (which would credit the whole
/// unobserved displacement to one frame). BELOW this bound the
/// posePendingDt anchor law already measures hiccups correctly (full gap
/// displacement / full gap time), so brief capture stalls cost nothing.
/// 0.6 s is chosen against the capture physics, not the math: a healthy
/// ARKit body stream never gaps beyond a few frames (~0.05 s at 60 Hz),
/// while a real occlusion or an anchor re-lock keeps the anchor dark for
/// ~0.5 s+ — and 0.6 s of unobserved walking is also half a slowest-counted
/// stride (STEP_MAX 1.2 s), so the bob/cadence trackers have provably
/// missed structure and must re-seed rather than interpolate.
public let SOLO_GAP_SEC: Double = 0.6

/// SOLO §3 turn-window exclusion (s): the engine flags `turnExcluded` for
/// this long after each detected travel reversal, freezing the lateral
/// integral (soloDeriveWorld). Derivation: the reversal mark lands
/// mid-turn, where the heading EMA has collapsed toward 0; regrowing from
/// 0 to the SOLO_HEADING_STABLE_MIN bar under the heading fold rate (1.5)
/// takes -ln(1 - 0.9) / 1.5 = ln(10) / 1.5 ~ 1.5 s — so the flag and the
/// stability gate agree on the window. Both exist on purpose (§3): the
/// gate is the belt (it self-excludes even a missed mark), the caller
/// window the suspenders (a fast snap turn can swing the heading without
/// ever pulling the EMA magnitude under the bar, and the flag still
/// freezes it).
public let SOLO_TURN_EXCLUDE_SEC: Double = 1.5

/// Keypoint with a usable confidence AND finite coordinates, else nil.
///
/// Coordinate finiteness is part of the ACCEPTANCE gate, not a downstream
/// repair: a keypoint whose x/y/z is NaN/Infinity is not a measurement, so it
/// is treated exactly like a low-score one — absent — and the existing
/// single-hip / sparse-keypoint fallbacks own the frame. Pre-gate, a junk
/// hip with a healthy score folded NaN into the speed/upright/bob EMAs
/// PERMANENTLY (NaN never leaves an `ema += (v - ema) * a` fold).
/// (NaN scores fail `score >= 0.3` in Swift exactly as in JS.)
public func kpOk(_ kp: [String: PoseKeypoint], _ n: String) -> PoseKeypoint? {
    guard let k = kp[n] else { return nil }
    return k.score >= 0.3 && k.x.isFinite && k.y.isFinite && k.z.isFinite
        ? k : nil
}

/// The stats taps the world path feeds — the exact WalkStatsAccumulator
/// surface it needs (WalkStats.swift satisfies this). Passed in per call so
/// this module never hard-binds the accumulator.
public protocol PoseDeriveStats: AnyObject {
    var livePaceMps: Double? { get set }
    var liveLateralM: Double? { get set }
    var livePostureM: Double? { get set }
    func noteSource(_ source: WalkStatsSource, _ dtSec: Double)
    func addPace(_ speedMps: Double, _ dtSec: Double)
    func addStep(_ atSec: Double)
    /// Fed by the SOLO variant only (§3 redefined channels — signed hip-path
    /// offset / signed hip-height drift). The web path leaves them dark.
    func addLateral(_ lateralM: Double, _ dtSec: Double)
    func addPosture(_ deviationM: Double, _ dtSec: Double)
}

extension WalkStatsAccumulator: PoseDeriveStats {}

/// All mutable pose-stream derivation state (names and initializers verbatim
/// from pose-derive.ts PoseDeriveState). The session owns ONE instance;
/// deriveWorld/soloDeriveWorld mutate it per fresh world frame.
public final class PoseDeriveState {
    public var posePrevHipX: Double = 0
    public var posePrevHipZ: Double = 0 // world path only
    public var poseHavePrev = false
    public var poseSpeedEma: Double = 0
    public var poseLatEma: Double = 0
    public var poseUprightEma: Double = 0.92
    public var poseHeadingX: Double = 0 // world path: smoothed travel direction
    public var poseHeadingZ: Double = -1
    public var poseBobBaseline: Double = 0
    public var poseBobHavePrev = false
    public var poseBobSign: Double = 0
    public var poseLastCross: Double = -1
    /// True once the world-pose travel heading has integrated real motion;
    /// until then footwork lateral isn't measured (no valid travel line).
    public var poseHeadingValid = false

    /// THE ANCHOR OWNS ITS TIMESTAMP (the dt/anchor law). Pose-stream seconds
    /// that have elapsed since the frame that set the hip anchor but have NOT
    /// yet been folded into a measurement — accumulated by bail frames (no
    /// usable hip), zeroed by every measuring frame. A clean frame measures
    /// over `span = delta + posePendingDt`, i.e. exactly
    /// `now - anchorTimestamp`, so a bail frame can never desync the anchor
    /// from the dt that divides its displacement: recovery after N dark
    /// frames divides the FULL gap displacement by the FULL gap time. A REAL
    /// outage still re-seeds with zero weight: reset()/resetCadence() clear
    /// this along with the anchor (the §2 gap rule) — the span math applies
    /// only WITHIN a walk's tolerated bails.
    public var posePendingDt: Double = 0

    // -- SOLO-only channels (§3 redefinitions) — untouched by the web path. --

    /// Hip-height baseline vs which the SOLO M1 drift is signed: averaged
    /// over the first 0.5 s of the walk, the head path's baselineY law
    /// mirrored onto the hip. Per-WALK quantities: reset() clears them,
    /// resetCadence() (a tracking gap) deliberately does NOT — the baseline,
    /// the drift EMA and the accumulated lateral offset survive an outage,
    /// like the EMAs.
    public var soloBaseY: Double = 0
    public var soloBaseAcc: Double = 0
    public var soloBaseSamples: Int = 0
    /// EMA of |hip-height dev| feeding the SOLO M1 score (rate 1.5 — the
    /// head path's heightDevEma law).
    public var soloHipDevEma: Double = 0
    /// SIGNED perpendicular offset of the hip path from the walker's own
    /// travel line, integrated from per-frame hip displacement projected on
    /// the heading's right-hand perpendicular (+ = the walker's RIGHT
    /// relative to travel — the sign does NOT flip meaning at a turn, §3).
    /// Integrates only while the heading is STABLE (SOLO_HEADING_STABLE_MIN)
    /// and the caller flags no turn window; the REPORTED offset subtracts
    /// the baseline below.
    public var soloLatOffset: Double = 0
    /// walkTime when lateral measurement first engaged (-1 = not yet).
    public var soloLatStartT: Double = -1
    /// Running mean of the raw integral over its first
    /// SOLO_LATERAL_BASELINE_SEC of measurement — the offset's reference.
    public var soloLatBaseline: Double = 0
    public var soloLatBaseAcc: Double = 0
    public var soloLatBaseSamples: Int = 0

    /// Ring buffer of bob-crossing (step) intervals — Float32 to mirror the
    /// TS Float32Array EXACTLY (its quantization feeds back into the rhythm
    /// mean/MAD). Shared by every derivation path so one resetCadence clears
    /// cadence for all of them.
    public var intervals = [Float](repeating: 0, count: RING_SIZE)
    public var intervalIdx: Int = 0
    public var intervalCount: Int = 0

    public init() {}

    /// Per-walk reset (values verbatim from pose-derive.ts reset()).
    public func reset() {
        poseHavePrev = false
        posePrevHipX = 0
        posePrevHipZ = 0
        poseSpeedEma = 0
        poseLatEma = 0
        poseUprightEma = 0.92
        // Do NOT seed the heading from a layout yaw: the streamed world
        // keypoints are in the phone's ARKit frame (unregistered), so a
        // runway yaw is meaningless here. Start neutral and only measure
        // footwork once the heading EMA has integrated real travel.
        poseHeadingX = 0
        poseHeadingZ = 0
        poseHeadingValid = false
        poseBobHavePrev = false
        poseBobBaseline = 0
        poseBobSign = 0
        poseLastCross = -1
        posePendingDt = 0
        soloBaseY = 0
        soloBaseAcc = 0
        soloBaseSamples = 0
        soloHipDevEma = 0
        soloLatOffset = 0
        soloLatStartT = -1
        soloLatBaseline = 0
        soloLatBaseAcc = 0
        soloLatBaseSamples = 0
        intervalIdx = 0
        intervalCount = 0
    }

    /// The source-handoff / tracking-gap reset (§2 gap rule): clear the
    /// shared interval ring and the bob trackers, and drop the hip anchor so
    /// the first frame after a gap carries ZERO stats weight and re-seeds
    /// instead of differencing across the outage. The caller re-arms its
    /// fresh-frame gate (poseLastT = -1) alongside this call.
    public func resetCadence() {
        intervalIdx = 0
        intervalCount = 0
        poseBobSign = 0
        poseLastCross = -1
        poseBobHavePrev = false
        poseHavePrev = false
        // The anchor is gone, so the time owed to it is too — a resumed
        // stream re-seeds with ZERO weight instead of measuring the outage.
        posePendingDt = 0
    }
}

// ---------------------------------------------------------------------------
// The WORLD-SPACE derivation (body verbatim from pose-derive.ts).
// ---------------------------------------------------------------------------

/// JS Math.hypot(x, y, z) equivalent for the torso-length norm. Magnitudes
/// here are ~0.45 m — no overflow scaling needed; ulp-level differences from
/// V8's compensated algorithm sit ~10 orders inside the golden tolerance.
@inline(__always)
private func hypot3(_ x: Double, _ y: Double, _ z: Double) -> Double {
    return (x * x + y * y + z * z).squareRoot()
}

/// Returns TRUE when the derivation ran to completion (target[] holds a
/// fresh legacy composite), FALSE on the both-hips-missing bail (no targets
/// written) — the web module's §B wrote-targets contract, mirrored for
/// fidelity (no golden case captures the return; callers may discard it).
@discardableResult
private func deriveWorldImpl(
    _ frame: PoseFrame,
    _ delta: Double,
    _ walkTime: Double,
    _ idealPace: Double,
    _ rampSeconds: Double,
    _ state: PoseDeriveState,
    _ stats: PoseDeriveStats,
    _ target: inout [Float],
    _ solo: Bool,
    _ turnExcluded: Bool
) -> Bool {
    var delta = delta
    // Delta is a CALLER-supplied input on the port surface: a non-finite or
    // non-positive value is not a time interval, so it is treated as 0 — a
    // dark frame. Every EMA alpha becomes 1-exp(0) = 0 (all EMAs hold), the
    // bob seed and hip-anchor updates still occur, and walk-stats already
    // rejects dtSec <= 0. Without this, one NaN delta made
    // poseBobBaseline/poseUprightEma NaN FOREVER.
    if !(delta.isFinite && delta > 0) { delta = 0 }
    // Camera-world owns this stretch of the walk. Its pace is TRUE m/s and
    // feeds the stats below. The lateral/posture taps default DARK each
    // frame: on the WEB path they stay dark; the SOLO variant OWNS both
    // channels (§3 redefinitions) and overwrites the taps below on every
    // frame it actually measures.
    stats.noteSource(.cameraWorld, delta)
    stats.liveLateralM = nil
    stats.livePostureM = nil
    let kp = frame.keypoints
    let lh = kpOk(kp, "leftHip")
    let rh = kpOk(kp, "rightHip")
    if lh == nil && rh == nil {
        // Bail: a dark frame. The hip anchor AND its timestamp hold
        // untouched — only the elapsed time is banked, so the next measuring
        // frame divides the FULL gap displacement by the FULL gap time.
        // No targets written -> false (the §B wrote-targets contract).
        state.posePendingDt += delta
        return false
    }
    // The true measurement interval: now - the anchor frame's timestamp.
    // Every EMA below folds over `span` — the physical seconds since the
    // last fold.
    let span = delta + state.posePendingDt
    state.posePendingDt = 0
    // Single-hip fallback (defensive; ARKit normally backfills both).
    let hip = (lh ?? rh)!
    let hx = (lh != nil && rh != nil) ? (lh!.x + rh!.x) * 0.5 : hip.x
    let hy = (lh != nil && rh != nil) ? (lh!.y + rh!.y) * 0.5 : hip.y
    let hz = (lh != nil && rh != nil) ? (lh!.z + rh!.z) * 0.5 : hip.z
    let ls = kpOk(kp, "leftShoulder")
    let rs = kpOk(kp, "rightShoulder")
    let la = kpOk(kp, "leftAnkle")
    let ra = kpOk(kp, "rightAnkle")

    if state.poseHavePrev && span > 0 {
        let dx = hx - state.posePrevHipX
        let dz = hz - state.posePrevHipZ
        let mag = hypot(dx, dz)

        // Pace — true horizontal world speed (m/s), vs the ideal pace.
        var speed = mag / span
        if speed > 4 { speed = 4 }
        stats.addPace(speed, span) // true m/s, pre-score-mapping
        state.poseSpeedEma += (speed - state.poseSpeedEma) * (1 - exp(-2 * span))
        stats.livePaceMps = state.poseSpeedEma

        // Heading — smoothed travel direction (only when actually moving).
        if mag > 1e-4 {
            let a = 1 - exp(-1.5 * span)
            state.poseHeadingX += (dx / mag - state.poseHeadingX) * a
            state.poseHeadingZ += (dz / mag - state.poseHeadingZ) * a
            state.poseHeadingValid = true
        }

        // Foot placement — lateral distance of each ankle from the travel
        // line (perpendicular to heading). Only once a real travel line
        // exists: the heading must come from measured motion, never a seed.
        if state.poseHeadingValid {
            let hraw = hypot(state.poseHeadingX, state.poseHeadingZ)
            let hmag = hraw == 0 ? 1 : hraw // JS `hraw || 1`
            let hxn = state.poseHeadingX / hmag
            let hzn = state.poseHeadingZ / hmag
            var lat: Double = 0
            var n = 0
            if let la = la {
                lat += abs((la.x - hx) * -hzn + (la.z - hz) * hxn)
                n += 1
            }
            if let ra = ra {
                lat += abs((ra.x - hx) * -hzn + (ra.z - hz) * hxn)
                n += 1
            }
            if n > 0 {
                lat /= Double(n)
                state.poseLatEma += (lat - state.poseLatEma) * (1 - exp(-1.5 * span))
            }

            // SOLO lateral (§3): the SIGNED perpendicular offset of the HIP
            // path from the walker's own travel line — this frame's hip
            // displacement projected on the heading's right-hand
            // perpendicular (-hzn, hxn), integrated (+ = the walker's right
            // relative to travel; the sign keeps its meaning across a turn).
            // The M4 SCORE stays on the abs ankle offset above — §3 keeps
            // them distinct on purpose. Measurement needs a STABLE heading
            // (SOLO_HEADING_STABLE_MIN — warm-up and turns self-exclude) and
            // no caller-flagged turn window; while unmeasured, the offset
            // FREEZES and the live tap stays dark. The reported offset is
            // the raw integral re-centered on its own first-second mean
            // (SOLO_LATERAL_BASELINE_SEC — the posture-baseline law
            // mirrored).
            if solo && !turnExcluded && hraw >= SOLO_HEADING_STABLE_MIN {
                state.soloLatOffset += dx * -hzn + dz * hxn
                if state.soloLatStartT < 0 { state.soloLatStartT = walkTime }
                if walkTime - state.soloLatStartT < SOLO_LATERAL_BASELINE_SEC
                    || state.soloLatBaseSamples == 0
                {
                    state.soloLatBaseAcc += state.soloLatOffset
                    state.soloLatBaseSamples += 1
                    state.soloLatBaseline =
                        state.soloLatBaseAcc / Double(state.soloLatBaseSamples)
                }
                let offset = state.soloLatOffset - state.soloLatBaseline
                stats.addLateral(offset, span)
                stats.liveLateralM = offset
            }
        }
    }
    state.posePrevHipX = hx
    state.posePrevHipZ = hz
    state.poseHavePrev = true

    if solo {
        // SOLO posture (§3, decision made): SIGNED hip-height drift vs the
        // walk-start baseline — ONE quantity feeding the M1 score, the live
        // cue channel AND postureDriftM, so the score and the spoken copy
        // can never disagree. The baseline mirrors the head path's law:
        // averaged over the first 0.5 s of the walk (seeded by the first
        // usable frame if none landed inside the window). Torso tilt is
        // deliberately NOT used in v1.
        if walkTime < 0.5 || state.soloBaseSamples == 0 {
            state.soloBaseAcc += hy
            state.soloBaseSamples += 1
            state.soloBaseY = state.soloBaseAcc / Double(state.soloBaseSamples)
        }
        let devSigned = hy - state.soloBaseY
        stats.addPosture(devSigned, span)
        stats.livePostureM = devSigned
        let dev = devSigned < 0 ? -devSigned : devSigned
        state.soloHipDevEma +=
            (dev - state.soloHipDevEma) * (1 - exp(-1.5 * span))
    } else if let ls = ls, let rs = rs {
        // WEB posture — true torso tilt: |vertical| / length of
        // shoulder->hip.
        let vx = (ls.x + rs.x) * 0.5 - hx
        let vy = (ls.y + rs.y) * 0.5 - hy
        let vz = (ls.z + rs.z) * 0.5 - hz
        let lenRaw = hypot3(vx, vy, vz)
        let len = lenRaw == 0 ? 1e-3 : lenRaw // JS `|| 1e-3`
        let upright = abs(vy) / len // 1 = perfectly vertical
        state.poseUprightEma +=
            (upright - state.poseUprightEma) * (1 - exp(-1.5 * span))
    }

    // Rhythm — hip vertical-bob cadence (one up-crossing per stride).
    if !state.poseBobHavePrev {
        state.poseBobBaseline = hy
        state.poseBobHavePrev = true
    }
    state.poseBobBaseline +=
        (hy - state.poseBobBaseline) * (1 - exp(-1.2 * span))
    let dev = hy - state.poseBobBaseline
    let TH = 0.008 // world meters
    if dev > TH && state.poseBobSign <= 0 {
        state.poseBobSign = 1
        stats.addStep(walkTime) // every real strike counts
        if state.poseLastCross >= 0 {
            let interval = walkTime - state.poseLastCross
            if interval >= STEP_MIN && interval <= STEP_MAX {
                state.intervals[state.intervalIdx] = Float(interval)
                state.intervalIdx = (state.intervalIdx + 1) % RING_SIZE
                if state.intervalCount < RING_SIZE { state.intervalCount += 1 }
            }
        }
        state.poseLastCross = walkTime
    } else if dev < -TH && state.poseBobSign >= 0 {
        state.poseBobSign = -1
    }

    // Scores (true-metric mappings).
    let pace =
        state.poseSpeedEma < 0.05
        ? 44
        : paceBandScore(state.poseSpeedEma, idealPace)

    var rhythm: Double = 58
    if state.intervalCount >= 3 {
        var mean: Double = 0
        for i in 0..<state.intervalCount { mean += Double(state.intervals[i]) }
        mean /= Double(state.intervalCount)
        var mad: Double = 0
        for i in 0..<state.intervalCount {
            mad += abs(Double(state.intervals[i]) - mean)
        }
        mad /= Double(state.intervalCount)
        let cv = mean > 0 ? mad / mean : 1
        rhythm = 100 - cv * 220
    }

    // WEB: upright torso ~0.97-1.0; a visible lean drops toward 0.90.
    // SOLO: the head-path curve shape mirrored onto the hip-drift channel,
    // slope re-derived (SOLO_POSTURE_SLOPE — see its derivation above).
    let posture =
        solo
        ? 100 - state.soloHipDevEma * SOLO_POSTURE_SLOPE
        : 40 + ((state.poseUprightEma - 0.9) / 0.09) * 60
    let footPlacement = 100 - state.poseLatEma * 240

    let cPace = clampScore(pace)
    let cRhythm = clampScore(rhythm)
    let cPosture = clampScore(posture)
    let cFoot = clampScore(footPlacement)

    // Ramp over the LOCKED walk duration (perfect=100 rescale) — the TS
    // twin's junk-guard included: bad rampSeconds reads full ramp, never NaN.
    let sessionRamp =
        rampSeconds.isFinite && rampSeconds > 0
        ? min(walkTime / rampSeconds, 1) : 1
    let presence = cPosture * 0.4 + cRhythm * 0.3 + cPace * 0.3
    let confidence =
        cPace * 0.25
        + cPosture * 0.25
        + cRhythm * 0.25
        + cFoot * 0.15
        + sessionRamp * 10
    let presentation =
        cPosture * 0.25
        + cRhythm * 0.25
        + cFoot * 0.2
        + cPace * 0.15
        + presence * 0.15

    // Float32Array-equivalent sink: each write quantizes to f32 (IEEE
    // round-to-nearest), exactly like the TS target[] assignment.
    target[0] = Float(posture)
    target[1] = Float(pace)
    target[2] = Float(rhythm)
    target[3] = Float(footPlacement)
    target[4] = Float(presence)
    target[5] = Float(confidence)
    target[6] = Float(presentation)
    return true // full derivation ran (§B wrote-targets contract)
}

/// The WEB world derivation — behavior unchanged from the headset app:
/// torso-tilt M1, lateral/posture live taps honest-dark. Returns the §B
/// wrote-targets fact (discardable — mirror fidelity with the web module).
@discardableResult
public func deriveWorld(
    _ frame: PoseFrame,
    _ delta: Double,
    _ walkTime: Double,
    _ idealPace: Double,
    _ rampSeconds: Double,
    _ state: PoseDeriveState,
    _ stats: PoseDeriveStats,
    _ target: inout [Float]
) -> Bool {
    return deriveWorldImpl(
        frame, delta, walkTime, idealPace, rampSeconds, state, stats, &target,
        false, false)
}

/// The SOLO world derivation (SOLO-MODE §3) — shares PoseDeriveState and
/// every pace/rhythm/footwork-score/composite rule with deriveWorld, and
/// redefines the two channels an unregistered ARKit frame can carry
/// honestly:
///
/// - POSTURE (M1): SIGNED hip-height drift vs the walk-start baseline — one
///   quantity feeding stats.addPosture/livePostureM AND the M1 score
///   (100 - |dev|EMA * SOLO_POSTURE_SLOPE). Torso tilt deliberately unused.
/// - LATERAL: SIGNED perpendicular offset of the hip path from the walker's
///   own travel line (+ = walker's right relative to travel), feeding
///   stats.addLateral/liveLateralM. The M4 SCORE keeps the abs ankle-offset
///   input unchanged. Measurement engages only under a STABLE heading
///   (SOLO_HEADING_STABLE_MIN) and outside `turnExcluded`, the caller's
///   turn-window flag; the reported offset re-centers on its own
///   first-second mean (SOLO_LATERAL_BASELINE_SEC). While unmeasured, the
///   offset integration freezes, no sample lands, and the live tap reads
///   nil.
///
/// Returns the §B wrote-targets fact (true = target[] holds a fresh legacy
/// composite; false = the both-hips bail) — discardable: mirror fidelity
/// with the web soloDeriveWorld; no golden case captures the return.
@discardableResult
public func soloDeriveWorld(
    _ frame: PoseFrame,
    _ delta: Double,
    _ walkTime: Double,
    _ idealPace: Double,
    _ rampSeconds: Double,
    _ state: PoseDeriveState,
    _ stats: PoseDeriveStats,
    _ target: inout [Float],
    turnExcluded: Bool = false
) -> Bool {
    return deriveWorldImpl(
        frame, delta, walkTime, idealPace, rampSeconds, state, stats, &target,
        true, turnExcluded)
}
