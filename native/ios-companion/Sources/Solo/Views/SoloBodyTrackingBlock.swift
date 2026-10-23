//
//  SoloBodyTrackingBlock.swift
//  (X)RUNWAY iOS Companion — Solo mode (SOLO-MODE §3, Phase A3)
//
//  The "Solo needs 3D body tracking" block screen — same visual family as
//  ContentView's cameraBlockedView (icon + tracked monospaced headline +
//  one-liner). Shown INSTEAD of the Solo controls on devices without ARKit
//  body tracking: the frame-invariance rule (§3) says image-space 2D pose
//  cannot measure honestly, so Solo refuses to score with it — no
//  false-promise buttons, no degraded mode. Stream mode still works.
//

import SwiftUI
import UIKit

struct SoloBodyTrackingBlock: View {
    /// The walking-figure-with-warning-badge symbol when this SF Symbols
    /// release has it; the always-available triangle otherwise — the icon
    /// must never silently render as nothing.
    private var iconName: String {
        let preferred = "figure.walk.motion.trianglebadge.exclamationmark"
        return UIImage(systemName: preferred) != nil
            ? preferred : "exclamationmark.triangle"
    }

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: iconName)
                .font(.system(size: 40))
                .foregroundStyle(Brand.warn)
            Text("SOLO NEEDS 3D BODY TRACKING")
                .font(.system(size: 13, weight: .semibold, design: .monospaced))
                .tracking(3)
                .foregroundStyle(Brand.white)
                .multilineTextAlignment(.center)
            Text("Solo mode scores your walk from ARKit 3D body tracking, which this device does not support. Simplified 2D tracking cannot measure honestly, so Solo will not score with it. Stream mode still works.")
                .font(.system(size: 12))
                .foregroundStyle(Brand.white.opacity(0.7))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
