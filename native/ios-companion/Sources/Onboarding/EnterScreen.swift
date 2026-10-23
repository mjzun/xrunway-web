//
//  EnterScreen.swift
//  (X)RUNWAY iOS Companion
//
//  The interactive opening screen: the WelcomePage with a clear refraction-lens
//  orb you lift with your finger (1:1 tracking) and HOLD over the (X)RUNWAY title.
//  Holding charges it — a gentle rumble + Carolina-blue glow — and when charged it
//  hands off (`onEnter(point)`) to the host, which plays the cinematic grow →
//  collapse → neutron-bounce → drop transition into the camera.
//

import SwiftUI

struct EnterScreen: View {
    /// Called when the orb finishes charging over the title; passes the orb's
    /// center so the cinematic can grow out of exactly that point.
    var onEnter: (CGPoint) -> Void = { _ in }

    @State private var dragPoint: CGPoint? = nil
    @State private var dragStart: CGPoint = .zero
    @State private var sizeT: CGFloat = 0
    @State private var chargeStart: Date? = nil
    @State private var chargePoint: CGPoint = .zero
    @State private var chargeWork: DispatchWorkItem? = nil
    @State private var triggered = false
    @GestureState private var isDragging = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            let restCenterY = h * EnterTokens.bubbleRestFraction
            let titleY = h * EnterTokens.headlineTopFraction

            let fingerX = dragPoint?.x ?? (w / 2)
            let fingerY = dragPoint?.y ?? restCenterY
            let dragUp = max(0, dragStart.y - (dragPoint?.y ?? dragStart.y))
            let progress = min(dragUp / EnterTokens.triggerDistance, 1.0)

            let centerX = lerp(w / 2, fingerX, sizeT)
            let centerY = lerp(restCenterY, fingerY, sizeT)

            let page = WelcomePage()

            ZStack {
                page

                // The orb — rumbles + glows gently while charging.
                TimelineView(.animation) { timeline in
                    let now = timeline.date
                    let t = now.timeIntervalSinceReferenceDate
                    let charge: CGFloat = chargeStart.map {
                        CGFloat(min(now.timeIntervalSince($0) / EnterTokens.chargeDuration, 1.0))
                    } ?? 0
                    // Settle the rumble to zero as charge completes so the orb's
                    // final frame sits at the un-jittered center (== burstPoint),
                    // matching the cinematic's first frame (no center pop).
                    let settle = charge < 0.8 ? 1.0 : (1.0 - charge) / 0.2
                    let amp = EnterTokens.rumbleAmplitude * charge * settle
                    let d = EnterTokens.bubbleSize * (1 + 0.03 * charge)
                    let bc = CGPoint(x: centerX + amp * CGFloat(sin(t * 40)),
                                     y: centerY + amp * CGFloat(sin(t * 47 + 1.1)))

                    OrbView(page: page, diameter: d, center: bc, refractionFade: 0, charge: charge)
                }
                .allowsHitTesting(false)

                SwipeHintView()
                    .position(x: w / 2, y: h - EnterTokens.hintBottomPadding)
                    .opacity(chargeStart != nil ? 0 : 1 - min(progress * 3, 1))

                Group {
                    if reduceMotion {
                        Color.clear.contentShape(Rectangle())
                            .onTapGesture { trigger(at: CGPoint(x: w / 2, y: titleY)) }
                    } else {
                        Color.clear.contentShape(Rectangle()).gesture(liftGesture(titleY: titleY))
                    }
                }
                .accessibilityLabel("Hold the orb over the title to enter")
                .accessibilityAddTraits(.isButton)
            }
        }
        .ignoresSafeArea()
        .preferredColorScheme(.light)
    }

    // MARK: Gesture

    private func liftGesture(titleY: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .updating($isDragging) { _, state, _ in state = true }
            .onChanged { value in
                guard !triggered else { return }
                if dragPoint == nil {
                    dragStart = value.startLocation
                    withAnimation(.spring(response: 0.34, dampingFraction: 0.82)) { sizeT = 1 }
                }
                dragPoint = value.location

                let over = abs(value.location.y - titleY) < EnterTokens.bubbleSize * 0.5 + 36
                if over {
                    chargePoint = value.location
                    if chargeStart == nil { startCharge() }
                } else if chargeStart != nil {
                    cancelCharge()
                }
            }
            .onEnded { _ in
                guard !triggered else { return }
                cancelCharge()
                withAnimation(EnterTokens.snapBackAnimation) {
                    dragPoint = nil
                    sizeT = 0
                }
            }
    }

    private func startCharge() {
        chargeStart = Date()
        let work = DispatchWorkItem { trigger(at: chargePoint) }
        chargeWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + EnterTokens.chargeDuration, execute: work)
    }

    private func cancelCharge() {
        chargeWork?.cancel()
        chargeWork = nil
        chargeStart = nil
    }

    private func trigger(at point: CGPoint) {
        guard !triggered else { return }
        triggered = true
        chargeWork?.cancel()
        chargeWork = nil
        chargeStart = nil
        // The charge completing is the app's most physical moment — the visual
        // rumble gets a real (light) impact as the orb commits (#27).
        Haptics.tap()
        onEnter(point)
    }

    private func lerp(_ a: CGFloat, _ b: CGFloat, _ t: CGFloat) -> CGFloat {
        a + (b - a) * t
    }
}

// MARK: - Reusable glass orb

/// The crystal orb that refracts `page`: clear magnified center + chromatic rim,
/// Carolina-blue lava at the edge, a thin bright rim, and (during the cinematic)
/// a `refractionFade` that fades the refracted interior out so the camera shows
/// through as it shrinks. `charge` adds the faint hold glow.
struct OrbView<Page: View>: View {
    var page: Page
    var diameter: CGFloat
    var center: CGPoint
    var refractionFade: CGFloat = 0   // 0 = full refraction, 1 = interior cleared
    var charge: CGFloat = 0
    var lavaOpacity: CGFloat = 1       // 1 = full Carolina-blue flow, 0 = clear glass
    /// Lens strength multiplier (1 = full bulge + chromatic aberration, 0 = clean
    /// passthrough). Ramped to 0 during the crumble so the off-white page reads
    /// flat inside the ball with no cyan aberration fringing in the side gaps.
    var lensStrength: CGFloat = 1

    var body: some View {
        let d = diameter
        let c = center
        // Cover the true rim displacement for THIS orb size so the lens never
        // clips on large screens / landscape (the GROW orb fills the screen). The
        // shader's worst case at the rim (lensStrength 1) is (d/2)*refraction +
        // aberration; a fixed cap truncated the sampling on iPad/landscape.
        let lensOffset = d / 2 * EnterTokens.refractionMax + EnterTokens.aberrationMax + 8
        ZStack {
            // soft drop shadow
            Circle().fill(Color.black.opacity(0.12))
                .frame(width: d, height: d).blur(radius: 18)
                .position(x: c.x, y: c.y + 10)
                .opacity(1 - refractionFade)

            // refraction lens — fades out as the orb clears for the camera
            page
                .layerEffect(
                    ShaderLibrary.sphereLens(
                        .float2(c),
                        .float(d / 2),
                        .float(EnterTokens.refractionMax * lensStrength),
                        .float(EnterTokens.aberrationMax * lensStrength)
                    ),
                    maxSampleOffset: CGSize(width: lensOffset, height: lensOffset),
                    isEnabled: true
                )
                .mask { Circle().frame(width: d, height: d).position(c) }
                .opacity(1 - refractionFade)

            // faint Carolina-blue charge glow
            Circle()
                .stroke(Brand.accent.opacity(0.5 * charge), lineWidth: 2 + 6 * charge)
                .frame(width: d, height: d).blur(radius: 9)
                .position(c)

            // Carolina-blue lava rim (the glass colour; fades out during the
            // crumble so the off-white page reads cleanly inside the ball)
            LavaColorView(diameter: d, intensity: 1 + 0.3 * charge)
                .frame(width: d, height: d)
                .mask(
                    RadialGradient(
                        colors: [.clear, .clear, .black.opacity(0.55), .black],
                        center: .center, startRadius: 0, endRadius: d * 0.5
                    )
                )
                .opacity(lavaOpacity)
                .position(c)

            // thin bright rim (stays — the glass edge)
            GlassBubbleView(diameter: d)
                .frame(width: d, height: d)
                .position(c)
        }
    }
}

#Preview {
    EnterScreen(onEnter: { _ in print("entered") })
}
