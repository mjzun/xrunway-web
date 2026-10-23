//
//  LavaColorView.swift
//  (X)RUNWAY iOS Companion
//
//  The colour that lives inside the glass bubble: soft Carolina-blue blobs that
//  drift and pulse in intensity like a lava lamp, clipped to the bubble circle.
//  Driven by TimelineView(.animation); each blob uses sine/cosine of time with a
//  distinct phase + frequency, so they wander and brighten at shifting points
//  with no two ever quite in sync (organic, pseudo-random flow).
//

import SwiftUI

struct LavaColorView: View {
    /// Bubble diameter in points.
    var diameter: CGFloat
    /// 0…1 overall strength (fades the whole field in/out with the bubble).
    var intensity: CGFloat

    // Carolina blue leads; the lighter blues add depth as secondary blobs.
    private let palette: [Color] = [
        EnterTokens.carolinaBlue,
        EnterTokens.iridescentBlue,
        EnterTokens.carolinaBlue,
        EnterTokens.iridescentCyan,
        EnterTokens.iridescentPeriwinkle,
    ]

    var body: some View {
        TimelineView(.animation) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            Canvas { ctx, size in
                let n = max(1, EnterTokens.lavaBlobs)
                for i in 0..<n {
                    let p = Double(i) * 1.37            // phase offset per blob
                    // Drift around the bubble on lazy, out-of-sync sine paths.
                    let cx = size.width  * (0.5 + 0.30 * sin(t * 0.43 + p * 1.7))
                    let cy = size.height * (0.5 + 0.30 * cos(t * 0.31 + p * 2.1))
                    let r  = size.width  * (0.26 + 0.10 * sin(t * 0.53 + p * 0.9))
                    // Intensity pulse — brightens and dims at its own pace.
                    let a  = max(0.0, 0.28 + 0.42 * sin(t * 0.7 + p * 1.6))
                    let color = palette[i % palette.count]
                    let rect = CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2)
                    ctx.fill(
                        Circle().path(in: rect),
                        with: .radialGradient(
                            Gradient(colors: [color.opacity(a), .clear]),
                            center: CGPoint(x: cx, y: cy),
                            startRadius: 0,
                            endRadius: r
                        )
                    )
                }
            }
            .frame(width: diameter, height: diameter)
            .blur(radius: diameter * 0.05)       // melt the blobs together
            .clipShape(Circle())
            .opacity(Double(intensity) * Double(EnterTokens.lavaStrength))
            .allowsHitTesting(false)
        }
    }
}

#Preview {
    ZStack {
        EnterTokens.background.ignoresSafeArea()
        LavaColorView(diameter: 280, intensity: 1)
    }
}
