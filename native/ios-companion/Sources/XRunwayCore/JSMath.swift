//
//  JSMath.swift — XRunwayCore
//
//  (X)RUNWAY Solo port, SOLO-MODE.md §5 numeric ground rules.
//
//  ONE rounding helper reproducing JS `Math.round` half-up semantics, used at
//  EVERY rounding site in the port (snapshot publish, overall rollup,
//  round3/round1 WalkStats quantization, cm rounding in coach cues).
//
//  Why not Swift's `rounded()`: Swift/C `round` rounds halves AWAY FROM ZERO
//  (-2.5 -> -3) while JS `Math.round` rounds halves TOWARD +INFINITY
//  (-2.5 -> -2). The divergence surfaces exactly in the SIGNED channels that
//  feed spoken copy (postureDriftM, meanLateralM) — the golden walk-stats
//  family pins the -2.5 case (`negative-half-rounding-landmine`).
//
//  Why not `floor(x + 0.5)`: for x = 0.49999999999999994 the addition rounds
//  to 1.0 in IEEE double and floor gives 1, but JS Math.round returns 0 (the
//  spec computes on the exact value). Computing the fraction against the
//  floor avoids the double-rounding.
//

import Foundation

/// JS `Math.round(x)`: nearest integer, halves toward +Infinity.
/// Non-finite passes through (JS returns NaN/±Infinity unchanged).
public func jsRound(_ x: Double) -> Double {
    guard x.isFinite else { return x }
    let f = x.rounded(.down)
    // x - f is exact for the magnitudes this port rounds (scores, cm, spm);
    // at |x| >= 2^52 every double is an integer and the branch returns f = x.
    return (x - f) < 0.5 ? f : f + 1
}

/// walk-stats.ts `round3` — pace/lateral/posture persisted precision (mm).
public func jsRound3(_ v: Double) -> Double {
    return jsRound(v * 1000) / 1000
}

/// walk-stats.ts `round1` — cadenceSpm persisted precision.
public func jsRound1(_ v: Double) -> Double {
    return jsRound(v * 10) / 10
}

/// JS `Number.prototype.toFixed(2)` for the coach's pace copy.
///
/// Both the ECMA algorithm and C's `%.2f` round the EXACT binary value of the
/// double; a tie (exact .xx5) is not representable in binary, so the two can
/// never disagree on this port's inputs. coach.ts's render-identical guard
/// compares these FORMATTED strings, mirrored verbatim in Coach.swift.
public func jsToFixed2(_ v: Double) -> String {
    return String(format: "%.2f", v)
}

/// JS integer interpolation `${n}` for a jsRound()ed value (whole-number
/// doubles print without a fractional part in JS).
public func jsIntString(_ n: Double) -> String {
    return String(Int(n))
}
