//
//  BrandWordmark.swift
//  (X)RUNWAY iOS Companion
//
//  The "(X)RUNWAY" wordmark, rendered as type so it scales crisply and recolors
//  freely. On the off-white Enter screen it's drawn in near-black (the user's
//  "logo with black text"); the same view is reusable elsewhere in the app at a
//  different size/color.
//

import SwiftUI

struct BrandWordmark: View {
    var size: CGFloat = EnterTokens.headlineSize
    var color: Color = EnterTokens.headlineColor

    var body: some View {
        // Italic Impact wordmark. Impact ships with no italic face, and SwiftUI's
        // `.italic()` won't synthesize an oblique for a custom font — so we shear
        // it ourselves with a horizontal skew (~11°). Padding gives the leaned
        // glyphs slack so they don't clip; `tx` nudges it back toward centered.
        Text("(X)RUNWAY")
            .font(.custom(EnterTokens.headlineFontName, size: size))
            .tracking(EnterTokens.headlineTracking)
            .foregroundStyle(color)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .padding(.horizontal, size * 0.16)
            .transformEffect(CGAffineTransform(a: 1, b: 0,
                                               c: -EnterTokens.headlineSlant, d: 1,
                                               tx: size * EnterTokens.headlineSlant * 0.5, ty: 0))
            .accessibilityLabel("X RUNWAY")
    }
}

#Preview {
    ZStack {
        EnterTokens.background.ignoresSafeArea()
        BrandWordmark()
    }
}
