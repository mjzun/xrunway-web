//
//  XRunwayCompanionApp.swift
//  (X)RUNWAY iOS Companion
//
//  App entry + the cinematic Enter→Camera transition (all from elapsed time):
//
//    1. GROW    — the glass orb grows out of the burst point, refracting the
//                 full-screen welcome page, until it fills the screen.
//    2. SETTLE  — full-screen, its center glides to the screen center (hidden,
//                 since the orb covers everything).
//    3. CRUMBLE — the welcome page SHRINKS along with the glass into a small ball
//                 (PowerPoint "shrink & discard"), and the camera is revealed
//                 around it as it collapses toward center.
//    4. BOUNCE  — the little "neutron star" reaches center and bounces up a touch.
//    5. DROP    — then falls out the bottom of the frame, leaving the camera.
//
//  Only the Enter screen + this overlay fill the screen; ContentView keeps its
//  real safe-area insets — never wrap it in .ignoresSafeArea() here.
//

import SwiftUI

@main
struct XRunwayCompanionApp: App {
    @State private var entered = ProcessInfo.processInfo.environment["XR_START_CAMERA"] == "1"
    @State private var transitioning = false
    @State private var burstPoint: CGPoint = .zero
    @State private var cinematicStart: TimeInterval = 0

    // Phase durations (seconds).
    private let tGrow = 1.4, tSettle = 0.4, tCrumble = 1.6, tBounce = 0.4, tDrop = 0.6
    private let neutronDia: CGFloat = 88
    private let bounceHeight: CGFloat = 18

    /// DEBUG: pin the cinematic at a fixed elapsed time (seconds) for inspection.
    private var frozenE: Double? {
        if let v = ProcessInfo.processInfo.environment["XR_FREEZE"], let d = Double(v) { return d }
        return nil
    }

    var body: some Scene {
        WindowGroup {
            ZStack {
                if transitioning || entered || frozenE != nil {
                    ContentView().preferredColorScheme(.dark)   // keeps its safe area
                }
                if !transitioning && !entered && frozenE == nil {
                    EnterScreen(onEnter: startCinematic)
                }
                if transitioning || frozenE != nil {
                    GeometryReader { geo in
                        let w = geo.size.width
                        let h = geo.size.height
                        let bp = frozenE != nil ? CGPoint(x: w / 2, y: h * EnterTokens.headlineTopFraction) : burstPoint
                        let far = max(hypot(bp.x, bp.y), hypot(w - bp.x, bp.y),
                                      hypot(bp.x, h - bp.y), hypot(w - bp.x, h - bp.y))
                        let fullDia = 2 * (far + 30)

                        TimelineView(.animation) { timeline in
                            let e = frozenE ?? (timeline.date.timeIntervalSinceReferenceDate - cinematicStart)
                            let s = phase(at: e, w: w, h: h, fullDia: fullDia, bp: bp)

                            ZStack {
                                if s.grow {
                                    // welcome fills the screen; orb is a refractive
                                    // window growing over it (camera stays hidden).
                                    WelcomePage()
                                    OrbView(page: WelcomePage(), diameter: s.d, center: s.c)
                                } else {
                                    // CRUMBLE: the welcome page is scaled down WITH the
                                    // orb into the ball; the camera shows around it. A
                                    // full off-white field behind the shrinking page
                                    // fills the ball (no black gaps around the tall
                                    // rectangle) so it still reads as a solid orb, and the
                                    // blue lava fades out so those gaps read off-white, not
                                    // blue, as the page collapses.
                                    OrbView(page: ZStack {
                                        EnterTokens.background
                                        WelcomePage().scaleEffect(s.sc, anchor: .center)
                                    }, diameter: s.d, center: s.c, lavaOpacity: s.lava, lensStrength: s.lava)
                                }
                            }
                        }
                    }
                    .ignoresSafeArea()
                }
            }
            .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
            .onChange(of: transitioning) { _, on in
                guard on else { return }
                let total = tGrow + tSettle + tCrumble + tBounce + tDrop
                DispatchQueue.main.asyncAfter(deadline: .now() + total + 0.05) {
                    entered = true
                    transitioning = false
                }
            }
        }
    }

    private func startCinematic(from point: CGPoint) {
        burstPoint = point
        cinematicStart = Date().timeIntervalSinceReferenceDate
        transitioning = true
    }

    private func smooth(_ p: Double) -> CGFloat {
        let q = min(max(p, 0), 1)
        return CGFloat(q * q * (3 - 2 * q))
    }

    /// (diameter, center, welcome-scale, isGrowPhase, lavaOpacity).
    private func phase(at e: Double, w: CGFloat, h: CGFloat, fullDia: CGFloat, bp: CGPoint) -> (d: CGFloat, c: CGPoint, sc: CGFloat, grow: Bool, lava: CGFloat) {
        let mid = CGPoint(x: w / 2, y: h / 2)
        // The interactive orb triggers at bubbleSize*(1+0.03*charge) ≈ ×1.03
        // (charge≈1), so GROW must begin there — not at the static bubbleSize —
        // or the first cinematic frame visibly shrinks the orb.
        let bubble = EnterTokens.bubbleSize * 1.03

        if e < tGrow {                                   // GROW (orb window grows)
            let ep = smooth(e / tGrow)
            return (bubble + (fullDia - bubble) * ep, bp, 1, true, 1)
        }
        var t = e - tGrow
        if t < tSettle {                                 // SETTLE center → mid (hidden)
            let ep = smooth(t / tSettle)
            return (fullDia, CGPoint(x: bp.x + (mid.x - bp.x) * ep, y: bp.y + (mid.y - bp.y) * ep), 1, true, 1)
        }
        t -= tSettle
        if t < tCrumble {                                // CRUMBLE: page + glass shrink,
            let ep = smooth(t / tCrumble)                // lava fades out over the first half
            let d = fullDia + (neutronDia - fullDia) * ep
            let lava = 1 - smooth(min((t / tCrumble) / 0.5, 1))
            return (d, mid, d / fullDia, false, lava)
        }
        t -= tCrumble
        let ballSc = neutronDia / fullDia
        if t < tBounce {                                 // BOUNCE
            let p = t / tBounce
            return (neutronDia, CGPoint(x: mid.x, y: mid.y - bounceHeight * CGFloat(sin(p * .pi))), ballSc, false, 0)
        }
        t -= tBounce                                     // DROP out the bottom
        let ep = smooth(min(t / tDrop, 1))
        return (neutronDia, CGPoint(x: mid.x, y: mid.y + (h + neutronDia - mid.y) * ep), ballSc, false, 0)
    }
}
