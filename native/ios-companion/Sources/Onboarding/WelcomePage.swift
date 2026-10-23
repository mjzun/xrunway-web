//
//  WelcomePage.swift
//  (X)RUNWAY iOS Companion
//
//  The flat welcome page the glass orb refracts — off-white field, faint center
//  vignette, the italic-Impact (X)RUNWAY wordmark + tagline. Shared by the
//  interactive Enter screen and the Enter→Camera transition so the orb refracts
//  exactly the same thing in both (seamless hand-off).
//

import SwiftUI

struct WelcomePage: View {
    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            ZStack {
                EnterTokens.background
                RadialGradient(
                    colors: [EnterTokens.vignetteCenter, EnterTokens.background],
                    center: .center, startRadius: 0, endRadius: max(w, h) * 0.75
                )
                .opacity(EnterTokens.vignetteOpacity)

                VStack(spacing: EnterTokens.headlineToTaglineSpacing) {
                    BrandWordmark()
                    Text(EnterTokens.taglineText)
                        .font(.system(size: EnterTokens.taglineSize, weight: .medium))
                        .foregroundStyle(EnterTokens.taglineColor)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: 360)
                .position(x: w / 2, y: h * EnterTokens.headlineTopFraction)
            }
        }
    }
}

#Preview {
    WelcomePage()
}
