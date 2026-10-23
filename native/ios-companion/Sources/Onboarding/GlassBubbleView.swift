//
//  GlassBubbleView.swift
//  (X)RUNWAY iOS Companion
//
//  Just the thin bright RIM of the crystal sphere — the glass edge catching light
//  (brighter top-left). No frosted material and no big specular blob; the sphere's
//  body is the refraction lens (in EnterScreen), and the soft drop shadow is drawn
//  separately, so this reads as a clear glass orb like the Wabi reference.
//

import SwiftUI

struct GlassBubbleView: View {
    var diameter: CGFloat

    var body: some View {
        Circle()
            .strokeBorder(
                LinearGradient(
                    colors: [.white.opacity(0.85), .white.opacity(0.12), .white.opacity(0.4)],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                ),
                lineWidth: max(1, diameter * 0.009)
            )
            .frame(width: diameter, height: diameter)
    }
}

#Preview {
    ZStack {
        EnterTokens.background.ignoresSafeArea()
        GlassBubbleView(diameter: 240)
    }
}
