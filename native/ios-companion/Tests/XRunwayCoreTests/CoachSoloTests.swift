//
//  CoachSoloTests.swift — the port-added `.solo` copy-surface ROUTING that no
//  golden vector exercises (every golden case runs `copy: .web`, and no golden
//  input carries a copy/surface field). These are differential + router-level
//  assertions, NOT new golden JSON: the target strings are already byte-locked
//  by the `copy-variants` / `coach-tables` families — what was unpinned is the
//  runtime SELECTION that threads `copy` through buildCoachReport (Coach.swift
//  cueFor/footworkCue) and LiveCoachPolicy.fire()/liveCueText (CoachLive.swift).
//
//  A wiring regression (ignoring `copy`, swapping on the wrong note key, the
//  directional gate suppressing the swapped cue, or fire() dropping the copy
//  argument) would leave the whole golden harness green — these tests turn it
//  RED. See SOLO-MODE §5 (the Solo copy variants) + the A2 review findings
//  #1/#2/#7.
//

import XCTest
import XRunwayCore

final class CoachSoloTests: XCTestCase {

    // -- #1: buildCoachReport(copy: .solo) footwork-note selection ------------
    //
    // Re-run every real `coach` golden case through BOTH surfaces. Assert:
    //   (a) every NON-footPlacement note is byte-identical across .web/.solo
    //       (the swap must be scoped to footPlacement only), and
    //   (b) the footPlacement note (when one is present) equals the .solo
    //       variant string rendered with the SAME cm/side the .web note used
    //       (independently reconstructed from the WalkStats via the documented
    //       coach-copy.ts substitution rule — not copied from buildCoachReport,
    //       so a mis-swap is caught).
    //
    // The `coach` family carries cases on all three footwork paths this locks:
    //   drift-side directional  (foot-oneway-consistent-right/left,
    //                            foot-exactly-at-consistency-bound),
    //   off-line directional    (foot-out-and-back-never-names-side,
    //                            foot-inconsistent-magnitude-only),
    //   generic band            (notes-capped-at-three, foot-sub-cm-generic).
    func testCoachReportSoloFootworkSurface() {
        guard let fam = loadFamilyOrFail("coach") else { return }
        var sawDriftSide = false
        var sawOffLine = false
        var sawGenericBand = false
        for c in fam.cases {
            guard let ctx = decodeCoachContext(c.input) else {
                XCTFail("coach case '\(c.name)' has malformed input")
                continue
            }
            let web = buildCoachReport(ctx, copy: .web)
            let solo = buildCoachReport(ctx, copy: .solo)

            // Verdict / overall / ranking must be untouched by the copy surface.
            XCTAssertEqual(
                web.notes.count, solo.notes.count,
                "[\(c.name)] note count changed under .solo")
            XCTAssertEqual(
                web.verdict, solo.verdict, "[\(c.name)] verdict changed")
            XCTAssertEqual(
                web.overall, solo.overall, "[\(c.name)] overall changed")

            for (wn, sn) in zip(web.notes, solo.notes) {
                XCTAssertEqual(
                    wn.key, sn.key, "[\(c.name)] note key order changed")
                if wn.key == "footPlacement" {
                    let expectedSolo = expectedSoloFootwork(ctx)
                    XCTAssertEqual(
                        sn.cue, expectedSolo,
                        "[\(c.name)] .solo footPlacement cue mismatch")
                    XCTAssertNotEqual(
                        sn.cue, wn.cue,
                        "[\(c.name)] .solo footPlacement cue must differ from .web "
                            + "(both mention the runway line differently)")
                    XCTAssertEqual(
                        sn.directional, wn.directional,
                        "[\(c.name)] .solo must not change the directional flag")
                    // Track which of the three footwork paths this case drove:
                    // drift-side "You drifted N cm <side> of your line ...",
                    // off-line  "You averaged N cm off your line ...",
                    // generic band (non-directional).
                    if !sn.directional {
                        sawGenericBand = true
                    } else if sn.cue.hasPrefix("You drifted") {
                        sawDriftSide = true
                    } else if sn.cue.hasPrefix("You averaged") {
                        sawOffLine = true
                    } else {
                        XCTFail("[\(c.name)] unrecognized .solo footwork cue \(sn.cue)")
                    }
                } else {
                    // Every non-footwork note is byte-identical on both surfaces.
                    XCTAssertEqual(
                        sn.cue, wn.cue,
                        "[\(c.name)] non-footwork note '\(wn.key)' changed under .solo")
                    XCTAssertEqual(sn.directional, wn.directional)
                }
            }
        }
        // The golden family MUST still cover all three footwork branches, else
        // this differential has silently stopped exercising a path.
        XCTAssertTrue(sawDriftSide, "no drift-side directional footwork case seen")
        XCTAssertTrue(sawOffLine, "no off-line directional footwork case seen")
        XCTAssertTrue(sawGenericBand, "no generic-band footwork case seen")
    }

    /// The expected `.solo` footPlacement cue for a context — reconstructed
    /// from the WalkStats via the SAME derivation footworkCue uses (cm =
    /// jsRound(meanAbs*100); side honesty gate = oneWay && consistency>=0.6),
    /// then rendered through the SOLO builders / band constant. Independent of
    /// buildCoachReport so a swap onto the wrong string is caught.
    private func expectedSoloFootwork(_ ctx: CoachContext) -> String {
        guard
            let stats = ctx.stats,
            let meanAbs = stats.meanAbsLateralM,
            let mean = stats.meanLateralM
        else {
            return SOLO_METRIC_COACH_FOOTWORK  // no channel -> generic band
        }
        let cm = jsRound(meanAbs * 100)
        if cm < 1 { return SOLO_METRIC_COACH_FOOTWORK }  // sub-cm -> band
        let sideIsHonest =
            ctx.oneWayRoute && meanAbs > 0
            && abs(mean) / meanAbs >= LATERAL_SIDE_CONSISTENCY
        if sideIsHonest {
            let side = mean > 0 ? "right" : "left"
            return soloFootworkDriftSideCue(jsIntString(cm), side)
        }
        return soloFootworkOffLineCue(jsIntString(cm))
    }

    /// Rebuild a CoachContext from a `coach` golden case input (same decode the
    /// CoachTests family uses, kept local so this file is self-contained).
    private func decodeCoachContext(_ input: JSONValue) -> CoachContext? {
        guard
            let scoresObj = input["scores"]?.asObject,
            let overall = input["overall"]?.asDouble,
            let modeObj = input["mode"]?.asObject,
            let thr = modeObj["passThreshold"]?.asDouble,
            let weightsObj = modeObj["weights"]?.asObject,
            let oneWay = input["oneWayRoute"]?.asBool
        else { return nil }
        var scores: [String: Double] = [:]
        for (k, v) in scoresObj { if let d = v.asDouble { scores[k] = d } }
        var weights: [String: Double] = [:]
        for (k, v) in weightsObj { if let d = v.asDouble { weights[k] = d } }
        return CoachContext(
            scores: scores, overall: overall,
            mode: CoachModeParams(passThreshold: thr, weights: weights),
            stats: decodeStats(input["stats"]), oneWayRoute: oneWay)
    }

    // -- #2 / #7: the live-cue copy router + fire() threading -----------------
    //
    // liveCueText(.centerUp, .solo) must route to "Find your line." and every
    // other (kind, surface) pair to the web string; then a sustained center-up
    // fault driven through a LiveCoachPolicy(copy: .solo) must FIRE that solo
    // string (exercising fire() at CoachLive.swift:368, not just the pure fn),
    // while the .web control fires "Find the centerline."

    func testLiveCueTextSoloRouter() {
        // center-up is the ONLY kind the solo surface swaps.
        XCTAssertEqual(
            liveCueText(.centerUp, copy: .solo), SOLO_LIVE_CUE_CENTER_UP)
        XCTAssertEqual(liveCueText(.centerUp, copy: .solo), "Find your line.")
        XCTAssertEqual(
            liveCueText(.centerUp, copy: .web), LIVE_CUE_TEXT["center-up"]!)
        XCTAssertEqual(liveCueText(.centerUp, copy: .web), "Find the centerline.")
        // The solo string must actually differ (guards against both constants
        // accidentally collapsing to the same value).
        XCTAssertNotEqual(
            liveCueText(.centerUp, copy: .solo),
            liveCueText(.centerUp, copy: .web))
        // Every non-centerUp kind is surface-invariant.
        for kind in LIVE_CUE_KINDS where kind != .centerUp {
            XCTAssertEqual(
                liveCueText(kind, copy: .solo), liveCueText(kind, copy: .web),
                "\(kind.rawValue) must not change on the solo surface")
            XCTAssertEqual(
                liveCueText(kind, copy: .solo), LIVE_CUE_TEXT[kind.rawValue]!)
        }
    }

    func testSoloPolicyFiresSoloCenterCue() {
        // Same sustained-lateral tape on both surfaces: absLateralM held above
        // LATERAL_CUE_M from the settle window on, no pace/posture fault, so
        // the FIRST fired cue is a center-up. Drive the 2 Hz grid long enough
        // to clear SETTLE_SEC + FAULT_HOLD_SEC and fire.
        func firstCenterCueText(copy: CoachCopyVariant) -> String? {
            let policy = LiveCoachPolicy(copy: copy)
            // Same 2 Hz grid the golden runner walks: t = i * STEP, i>=1.
            var i = 1
            while Double(i) * COACH_SAMPLE_SEC <= 30.0 + 1e-9 {
                let t = Double(i) * COACH_SAMPLE_SEC
                let input = LiveCueInput(
                    walking: true, walkRemainingSec: 600, markAtSec: nil,
                    walkProgress01: 0, oneWayRoute: false, paceDeltaMps: 0,
                    absLateralM: 0.3, postureM: 0)
                if let cue = policy.decideLiveCue(input, t) {
                    XCTAssertEqual(cue.kind, .centerUp, "expected a center-up cue")
                    return cue.text
                }
                i += 1
            }
            return nil
        }
        XCTAssertEqual(
            firstCenterCueText(copy: .solo), SOLO_LIVE_CUE_CENTER_UP,
            "the .solo policy must FIRE the solo center string (fire() threads copy)")
        XCTAssertEqual(
            firstCenterCueText(copy: .web), "Find the centerline.",
            "the .web control must fire the web center string")
    }
}
