//
//  SwipeHintView.swift
//  (X)RUNWAY iOS Companion
//
//  "Swipe up to enter" — filled with a leading→trailing gradient so the last
//  word ("enter") reads lighter, exactly as in ref_1. The whole label is a
//  single Text so the gradient flows across the glyphs as one mask.
//

import SwiftUI

struct SwipeHintView: View {
    var body: some View {
        Text(EnterTokens.hintText)
            .font(.system(size: EnterTokens.hintSize, weight: .semibold))
            // A horizontal gradient as the text fill: dark on the left,
            // fading lighter to the right so "enter" de-emphasizes.
            .foregroundStyle(
                LinearGradient(
                    colors: [EnterTokens.hintColorLeading, EnterTokens.hintColorTrailing],
                    startPoint: .leading,
                    endPoint: .trailing
                )
            )
            .accessibilityLabel(EnterTokens.hintText)
    }
}

#Preview {
    ZStack {
        EnterTokens.background.ignoresSafeArea()
        SwipeHintView()
    }
}
