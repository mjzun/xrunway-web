//
//  CoachLive.swift — XRunwayCore
//
//  Port of src/coach-live.ts: the live mid-walk coaching policy, locked by
//  the golden `coach-live` family (41 event tapes) and the `coach-tables`
//  thresholds case.
//
//  THE RULES (each pinned by a vector):
//  - Walk phase only. Cues never fire outside the walk.
//  - Settle window: faults do not even ACCUMULATE before SETTLE_SEC.
//  - Final guard: nothing cues inside the last FINAL_GUARD_SEC of the walk
//    clock OR past FINAL_GUARD_PROGRESS of the route.
//  - Turn-back window: fault timers are CLEARED (not just muted) for
//    TURN_SUPPRESS_SEC after the pose mark; one-way routes stay suppressed
//    to the walk's end. Per-lap semantics: the mark UPDATES on every
//    travel-heading reversal (SOLO-MODE §2 — both ends mark), so each new
//    mark re-opens a fresh suppression window; the vectors pin both the
//    re-clear and the fault-that-matures-between-marks cases.
//  - Hysteresis: a fault must hold continuously for FAULT_HOLD_SEC beyond
//    its threshold before it cues; a clean sample (or a sign flip, for the
//    signed channels) restarts the clock.
//  - Cadence: >= CUE_COOLDOWN_SEC between ANY two cues, at most MAX_PER_KIND
//    of each kind per walk, and never the same kind twice in a row.
//  - Priority when several faults are sustained: pace > center > posture.
//  - Channel honesty: nil never cues — and a NON-FINITE value is treated
//    exactly like nil (NaN/Infinity means "not measured", never a fault).
//    Center copy uses the ABS offset only and NEVER names left/right.
//

import Foundation

// ---------------------------------------------------------------------------
// Cue vocabulary.
// ---------------------------------------------------------------------------

public enum LiveCueKind: String, CaseIterable {
    case paceFast = "pace-fast"
    case paceSlow = "pace-slow"
    case centerUp = "center-up"
    case postureDrop = "posture-drop"
    case postureLift = "posture-lift"
}

public let LIVE_CUE_KINDS: [LiveCueKind] = [
    .paceFast, .paceSlow, .centerUp, .postureDrop, .postureLift,
]

/// One decided cue: the kind doubles as the earcon id (COACH_EARCONS).
public struct LiveCue {
    public let kind: LiveCueKind
    /// Short spoken line — ASCII only, short enough to SPEAK mid-stride.
    public let text: String
}

/// Spoken copy per kind (the WEB strings — the coach-tables golden family
/// pins them). center-up deliberately never says left/right.
public let LIVE_CUE_TEXT: [String: String] = [
    "pace-fast": "Slow it down - long, even strides.",
    "pace-slow": "Pick up the pace - stretch every stride.",
    "center-up": "Find the centerline.",
    "posture-drop": "Settle your height - smooth, no bounce.",
    "posture-lift": "Lift through the crown - chin level.",
]

/// The spoken line for a kind on a copy surface: Solo swaps center-up for
/// "Find your line." (the copy-variants golden family, SOLO-MODE §5).
public func liveCueText(
    _ kind: LiveCueKind, copy: CoachCopyVariant = .web
) -> String {
    if copy == .solo && kind == .centerUp { return SOLO_LIVE_CUE_CENTER_UP }
    return LIVE_CUE_TEXT[kind.rawValue]!
}

// ---------------------------------------------------------------------------
// Earcon recipes (pure data — the voice layer synthesizes from these).
// Each kind is LEARNABLE: pace = two blips (falling = slow down, rising =
// speed up), center = a same-pitch double tap, posture = one gliding swoop
// (falling = settle, rising = lift). Contours mirror the correction.
// Contour-equivalence is the contract (SOLO-MODE §5) — but the RECIPES are
// table data and table data is vector-locked byte-exact (coach-tables).
// ---------------------------------------------------------------------------

public struct CoachEarcon {
    /// Two frequencies (Hz): blip pair, or glide start -> end when `glide`.
    public let notes: (Double, Double)
    /// Blip spacing (s), or the glide duration when `glide`.
    public let span: Double
    /// Per-voice gain decay (s).
    public let decay: Double
    public let glide: Bool
}

/// Earcon peak level, relative to the SFX pref law master. Sits between the
/// countdown tick (0.14) and the pose sting (0.18).
public let COACH_EARCON_LEVEL: Double = 0.16

public let COACH_EARCONS: [String: CoachEarcon] = [
    "pace-fast": CoachEarcon(notes: (1318.51, 987.77), span: 0.11, decay: 0.09, glide: false),
    "pace-slow": CoachEarcon(notes: (987.77, 1318.51), span: 0.11, decay: 0.09, glide: false),
    "center-up": CoachEarcon(notes: (1174.66, 1174.66), span: 0.09, decay: 0.07, glide: false),
    "posture-drop": CoachEarcon(notes: (1046.5, 783.99), span: 0.18, decay: 0.3, glide: true),
    "posture-lift": CoachEarcon(notes: (783.99, 1046.5), span: 0.18, decay: 0.3, glide: true),
]

// ---------------------------------------------------------------------------
// Rule constants (all seconds / meters / m/s).
// ---------------------------------------------------------------------------

/// Policy sampling interval (s) — the 2 Hz grid the live system samples the
/// walk-stats taps on. Lives HERE (the pure module) so the app loop, the
/// golden vectors and this port consume one value.
public let COACH_SAMPLE_SEC: Double = 0.5

/// No fault accumulation before this much walk time (EMA warm-up window).
public let SETTLE_SEC: Double = 5
/// No cue inside the last N seconds of the walk clock.
public let FINAL_GUARD_SEC: Double = 4
/// No cue past this route progress (0..1) either: a cue fired on the last
/// sample gets chopped mid-word by the summary flip.
public let FINAL_GUARD_PROGRESS: Double = 0.9
/// A fault must hold continuously this long beyond threshold to cue.
public let FAULT_HOLD_SEC: Double = 2.5
/// Minimum spacing between ANY two cues.
public let CUE_COOLDOWN_SEC: Double = 9
/// Per-kind cap per walk.
public let MAX_PER_KIND = 2
/// Fault timers stay cleared this long after the pose mark on an
/// out-and-back route (covers the pose beat + the physical turn). One-way
/// routes stay suppressed to the walk's end (it ends at the mark).
public let TURN_SUPPRESS_SEC: Double = 4

/// |live pace - mode ideal| must exceed this (m/s): the pace score is
/// 95 - |delta| * 70, so a sustained 0.25 m/s error maps to ~77.5 — at or
/// below every mode's pass bar (75-82). Smaller deltas sit inside the
/// speed-EMA's normal stride-to-stride wobble. CARRIES UNCHANGED into Solo:
/// the pace channel and its score mapping are identical there.
public let PACE_DELTA_CUE_MPS: Double = 0.25

/// |live centerline offset| must exceed this (m) — the WEB head-channel
/// gate: footwork is 96 - |lat| * 240, hitting the SCORE_MIN floor at
/// ~0.23 m; 0.20 maps to score ~48 (decisively failing every bar) while
/// staying ~4x natural head sway (~5 cm).
public let LATERAL_CUE_M: Double = 0.2

/// |live head-height deviation| gate (m) — the WEB channel: posture is
/// 96 - dev * 350, so 0.06 m maps to ~75, right at the lowest pass bar.
public let POSTURE_CUE_M: Double = 0.06

// ---------------------------------------------------------------------------
// SOLO thresholds (SOLO-MODE §3/§5) — RE-DERIVED against the §3 channel
// definitions, never carried over (the doc rules this a Phase A task, not an
// option). PACE_DELTA_CUE_MPS carries unchanged (see above). Locked by the
// coach-tables golden family's solo-cue-thresholds case.
// ---------------------------------------------------------------------------

/// SOLO |hip-path lateral offset| cue gate (m) — re-derived for the §3
/// channel (PoseDerive soloDeriveWorld): the web's 0.20 was tuned against
/// the HEAD centerline channel with ~5 cm natural head sway (gate ~4x
/// noise; with the 2.5 s hold a drift had to sustain ~0.25 m to cue).
/// Solo's channel is the HIP path offset from the walker's own travel line:
/// it carries NO stance width (that lives only in the ankle-offset M4 score
/// input) and its natural noise is hip sway — ~3 cm (the §6 walker's
/// swayAmp; up to ~5 cm on a real catwalk). 0.15 keeps both web rules on
/// the new channel: it is 5x the 3 cm sway noise (>= the web's 4x rule),
/// and with FAULT_HOLD_SEC a drift must sustain ~0.18 m+ beyond sway to cue
/// — "you have left your line" on a narrower, stance-free channel, matching
/// the web's effective ~0.25 m trip on its wider one.
public let SOLO_LATERAL_CUE_M: Double = 0.15

/// SOLO |hip-height drift| cue gate (m) — re-derived against the §3 M1
/// mapping (96 - |dev|EMA * SOLO_POSTURE_SLOPE, PoseDerive): the same
/// score-bar rule that produced the head gate (0.06 = 21/350, the dev where
/// the curve crosses the lowest pass bar 75) gives 21/280 = 0.075 for the
/// hip slope. Gait hip bob (~2 cm) plus the 2.5 s continuous hold keep a
/// clean walk from ever tripping it: a sustained drift must clear ~0.095 m
/// through the bob oscillation to cue.
public let SOLO_POSTURE_CUE_M: Double = 0.075

/// SOLO lateral CUE-INPUT smoothing rate (1/s): the Solo engine feeds the
/// policy's absLateralM with a rate-0.5 EMA of |liveLateralM| sampled on
/// the 2 Hz grid — NOT the raw tap the web uses. The §3 travel-line offset
/// has no absolute reference (the web's mapped centerline does): a slow
/// drift is absorbed by the heading EMA, a sharp side-step is eaten by the
/// stability gate, and a weave crosses zero twice a cycle — so the RAW
/// |offset| can never hold above any gate for the FAULT_HOLD_SEC
/// continuous-hold law. The cue's product meaning ("Find your line" = you
/// are CONSISTENTLY off your line) is the sustained magnitude: tau = 2 s ~
/// FAULT_HOLD_SEC smooths weave rectification ripple to ~+-10%. Clean-walk
/// noise floor on the smoothed tap ~0.011 m -> the 0.15 gate keeps >=13x
/// noise. DARK-TAP RULE at the sampler: report the HELD EMA while the tap
/// has been dark <= SOLO_GAP_SEC (a stability blip must not reset the
/// fault clock), null beyond it (turn windows DO clear, as suppression
/// intends). Locked by the walk-replay-solo family, which drives the
/// production SoloWalkCore loop.
public let SOLO_LATERAL_CUE_SMOOTH_RATE: Double = 0.5

// ---------------------------------------------------------------------------
// Cue gate sets — the thresholds a policy instance trips on. The RULES
// (settle, hold, cooldown, caps, priority, honesty) are surface-independent;
// only the three gate values differ because the web and Solo channels are
// physically different quantities (head-vs-centerline vs the §3 hip
// channels). Pace carries unchanged — same channel, same score mapping.
// ---------------------------------------------------------------------------

/// The three cue gates a LiveCoachPolicy trips on (all derived values — see
/// the constants above; never free parameters).
public struct LiveCueGates {
    /// |live pace - mode ideal| gate (m/s).
    public let paceDeltaMps: Double
    /// |live lateral offset| gate (m).
    public let lateralM: Double
    /// |live height deviation| gate (m).
    public let postureM: Double

    public init(paceDeltaMps: Double, lateralM: Double, postureM: Double) {
        self.paceDeltaMps = paceDeltaMps
        self.lateralM = lateralM
        self.postureM = postureM
    }
}

/// The web surface's gates (head/centerline channels) — the default, so
/// every existing construction site keeps its exact behavior.
public let WEB_CUE_GATES = LiveCueGates(
    paceDeltaMps: PACE_DELTA_CUE_MPS,
    lateralM: LATERAL_CUE_M,
    postureM: POSTURE_CUE_M
)

/// The Solo surface's gates (§3 hip channels, re-derived above). The Solo
/// engine constructs its policy with these; the golden coach-live family
/// pins the differential behavior (cases tagged `gates: "solo"`).
public let SOLO_CUE_GATES = LiveCueGates(
    paceDeltaMps: PACE_DELTA_CUE_MPS,
    lateralM: SOLO_LATERAL_CUE_M,
    postureM: SOLO_POSTURE_CUE_M
)

// ---------------------------------------------------------------------------
// Policy input — one flat snapshot per 2 Hz sample.
// ---------------------------------------------------------------------------

public struct LiveCueInput {
    /// True only while the show phase is "walk".
    public var walking: Bool
    /// Seconds left on the walk clock.
    public var walkRemainingSec: Double
    /// Walk-time (s) when the pose mark was reached, or nil before it.
    /// Per-lap semantics: the caller updates this on EVERY travel-heading
    /// reversal (§2 both-ends decision) — each update re-opens suppression.
    public var markAtSec: Double?
    /// Route progress 0..1 (0 when unknown). Feeds the POSITIONAL half of
    /// the final guard.
    public var walkProgress01: Double
    /// One-way route: the walk ENDS at the mark — no return leg.
    public var oneWayRoute: Bool
    /// livePaceMps - the mode's idealPace, or nil while no pace channel.
    public var paceDeltaMps: Double?
    /// |liveLateralM| — ABS only (the sign is route-relative), or nil.
    public var absLateralM: Double?
    /// SIGNED live height deviation (+ above baseline), or nil.
    public var postureM: Double?

    public init(
        walking: Bool, walkRemainingSec: Double, markAtSec: Double?,
        walkProgress01: Double, oneWayRoute: Bool, paceDeltaMps: Double?,
        absLateralM: Double?, postureM: Double?
    ) {
        self.walking = walking
        self.walkRemainingSec = walkRemainingSec
        self.markAtSec = markAtSec
        self.walkProgress01 = walkProgress01
        self.oneWayRoute = oneWayRoute
        self.paceDeltaMps = paceDeltaMps
        self.absLateralM = absLateralM
        self.postureM = postureM
    }
}

// ---------------------------------------------------------------------------
// The policy. Stateful across one walk (reset() re-arms it); every decide
// call is pure scalar math.
// ---------------------------------------------------------------------------

public final class LiveCoachPolicy {
    /// +1 fast / -1 slow / 0 no pace fault.
    private var paceSign = 0
    private var paceSince: Double = -1
    private var latSince: Double = -1
    /// +1 riding high (bounce) / -1 sinking / 0 no posture fault.
    private var postSign = 0
    private var postSince: Double = -1

    private var lastCueAt = -Double.infinity
    private var lastKind: LiveCueKind? = nil
    private var counts: [LiveCueKind: Int] = [:]

    /// The copy surface this policy speaks (SOLO-MODE §5: Solo swaps
    /// center-up). Vectors run .web; the Solo engine constructs with .solo.
    private let copy: CoachCopyVariant

    /// The gate set this instance trips on (web default; the Solo engine
    /// passes SOLO_CUE_GATES). Gates only — every rule constant is shared.
    private let gates: LiveCueGates

    public init(copy: CoachCopyVariant = .web, gates: LiveCueGates = WEB_CUE_GATES) {
        self.copy = copy
        self.gates = gates
        reset()
    }

    /// Arm for a new walk: counters, cooldown and fault timers all clear.
    public func reset() {
        clearFaults()
        lastCueAt = -Double.infinity
        lastKind = nil
        for kind in LIVE_CUE_KINDS { counts[kind] = 0 }
    }

    /// Clear ONLY the fault-persistence timers (counters/cooldown survive).
    /// Called on a mid-walk geometry remap — every in-flight fault clock was
    /// measured against stale geometry.
    public func clearFaults() {
        paceSign = 0
        paceSince = -1
        latSince = -1
        postSign = 0
        postSince = -1
    }

    /// One 2 Hz policy step. `nowSec` is seconds since the walk started (the
    /// same clock `input.markAtSec` is on). Returns a cue to deliver, or nil.
    public func decideLiveCue(_ input: LiveCueInput, _ nowSec: Double) -> LiveCue? {
        if !input.walking {
            return nil
        }

        // Settle window — keep timers clear so a ramp-in artifact can never
        // pre-age a fault.
        if nowSec < SETTLE_SEC {
            clearFaults()
            return nil
        }

        // Turn-back / pose-beat window — CLEAR, don't just mute: the turn
        // itself (pace ~0, lateral swinging) must never mature into a fault.
        if let markAtSec = input.markAtSec {
            if input.oneWayRoute || nowSec - markAtSec < TURN_SUPPRESS_SEC {
                clearFaults()
                return nil
            }
        }

        // -- fault persistence (channel honesty: nil/non-finite clears) -----
        // isFinite gates route NaN/Infinity through the SAME clear/reset
        // path as nil — a value that isn't a measurement can never age a
        // fault.
        if let pace = input.paceDeltaMps, pace.isFinite,
            !(abs(pace) <= gates.paceDeltaMps)
        {
            let sign = pace > 0 ? 1 : -1
            if sign != paceSign {
                paceSign = sign
                paceSince = nowSec
            }
        } else {
            paceSign = 0
            paceSince = -1
        }

        if let lat = input.absLateralM, lat.isFinite, !(lat <= gates.lateralM) {
            if latSince < 0 {
                latSince = nowSec
            }
        } else {
            latSince = -1
        }

        if let post = input.postureM, post.isFinite,
            !(abs(post) <= gates.postureM)
        {
            let sign = post > 0 ? 1 : -1
            if sign != postSign {
                postSign = sign
                postSince = nowSec
            }
        } else {
            postSign = 0
            postSince = -1
        }

        // -- cue gates (faults above keep aging through these) --------------
        if input.walkRemainingSec <= FINAL_GUARD_SEC
            || input.walkProgress01 >= FINAL_GUARD_PROGRESS
        {
            return nil
        }
        if nowSec - lastCueAt < CUE_COOLDOWN_SEC {
            return nil
        }

        // -- selection: priority pace > center > posture ---------------------
        if held(paceSince, nowSec) {
            let kind: LiveCueKind = paceSign > 0 ? .paceFast : .paceSlow
            if eligible(kind) {
                return fire(kind, nowSec)
            }
        }
        if held(latSince, nowSec) && eligible(.centerUp) {
            return fire(.centerUp, nowSec)
        }
        if held(postSince, nowSec) {
            let kind: LiveCueKind = postSign > 0 ? .postureDrop : .postureLift
            if eligible(kind) {
                return fire(kind, nowSec)
            }
        }
        return nil
    }

    private func held(_ since: Double, _ nowSec: Double) -> Bool {
        return since >= 0 && nowSec - since >= FAULT_HOLD_SEC
    }

    private func eligible(_ kind: LiveCueKind) -> Bool {
        return counts[kind]! < MAX_PER_KIND && kind != lastKind
    }

    private func fire(_ kind: LiveCueKind, _ nowSec: Double) -> LiveCue {
        counts[kind]! += 1
        lastKind = kind
        lastCueAt = nowSec
        return LiveCue(kind: kind, text: liveCueText(kind, copy: copy))
    }
}
