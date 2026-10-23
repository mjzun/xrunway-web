//
//  Haptics.swift
//  (X)RUNWAY iOS Companion
//
//  One tiny seam for tactile feedback (POLISH-AUDIT #27): the Enter orb
//  finishing its charge and START/STOP on the camera screen get a light
//  impact, so the app's two commitment moments feel physical. A generator is
//  created per tap — at a handful of taps per session there's nothing to gain
//  from keeping one alive and prepared.
//

import UIKit

@MainActor
enum Haptics {
    /// Light impact for a completed primary interaction
    /// (orb charged, START/STOP tapped).
    static func tap() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
}
