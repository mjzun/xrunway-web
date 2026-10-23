//
//  EnterScreenTokens.swift
//  (X)RUNWAY iOS Companion
//
//  Single source of truth for the Liquid Glass "Swipe up to enter" opening
//  screen. Every visual/behavioural constant lives here so the look can be
//  tuned in one place (per the design prompt's DESIGN TOKENS block).
//
//  Coordinate note: a few values are expressed as *fractions* of the live
//  screen size (width/height) rather than absolute points, because the bubble
//  is intentionally sized off screen width so the dome reads as a shallow cap
//  on every device. EnterScreen resolves them against a GeometryReader.
//

import SwiftUI

enum EnterTokens {

    // MARK: Background
    /// #EFEFEF — warm light gray, flat.
    static let background = Color(red: 239/255, green: 239/255, blue: 239/255)
    /// Barely-there vignette: center lighter (near-white) → edges = background.
    static let vignetteCenter = Color(white: 0.99)
    static let vignetteOpacity: Double = 0.6

    // MARK: Headline — the (X)RUNWAY wordmark (replaces the ref's body copy)
    /// Italic Impact (condensed display face) reads large; near-black on #EFEFEF.
    static let headlineFontName = "Impact"
    static let headlineColor = Color(white: 0.10)
    static let headlineSize: CGFloat = 54   // Impact is condensed → bigger reads well
    static let headlineTracking: CGFloat = 1.0
    /// Synthetic-italic skew for the wordmark (tan of the slant; ~0.2 ≈ 11°).
    static let headlineSlant: CGFloat = 0.2
    /// Vertical anchor of the headline block (wordmark + tagline), ~34% down.
    static let headlineTopFraction: CGFloat = 0.34

    // Tagline beneath the wordmark (echoes ref_1's second headline line).
    static let taglineText = "Take the next step."
    static let taglineSize: CGFloat = 18
    static let taglineColor = Color(white: 0.32)
    static let headlineToTaglineSpacing: CGFloat = 14

    // MARK: Gesture hint — "Swipe up to enter"
    static let hintText = "Hold the orb over the title"
    static let hintSize: CGFloat = 17
    static let hintColorLeading = Color(white: 0.40)   // darker gray
    static let hintColorTrailing = Color(white: 0.72)  // fades lighter → "enter" reads soft
    /// Hint center, as distance in points up from the physical bottom edge
    /// (clears the home indicator and sits on the visible dome cap).
    static let hintBottomPadding: CGFloat = 56

    // MARK: Glass bubble
    /// A small, BOUNDED bubble (points) — used at rest and while dragging. A huge
    /// glass dome refracts most of the screen ("whole background frosts"); a small
    /// bounded one keeps the glass strictly to the bubble.
    static let bubbleSize: CGFloat = 220
    /// Resting center as a fraction of screen height — a visible orb low on screen.
    static let bubbleRestFraction: CGFloat = 0.88
    // (legacy dome tokens — no longer used)
    static let bubbleDiameterFactor: CGFloat = 1.65
    static let bubbleRestCenterYFactor: CGFloat = 1.06
    static let bubbleShadowColor = Color.black.opacity(0.06)
    static let bubbleShadowRadius: CGFloat = 30
    static let bubbleShadowY: CGFloat = -8   // shadow rises upward

    // MARK: Floating sphere (after lift — Phase 2 target)
    static let sphereDiameter: CGFloat = 168
    static let sphereCenterYFraction: CGFloat = 0.48
    /// Where the sphere RISES TO at full drag — parked over the wordmark so the
    /// lens magnifies it (ref_2 / ref_3). 0 = top of screen, 1 = bottom.
    static let sphereLiftFraction: CGFloat = 0.36
    /// How far the headline fades during the lift. 0.55 keeps ~45% visible at
    /// full pull, so the lens has the wordmark to magnify; it only fully
    /// disappears on completion.
    static let headlineLiftFade: CGFloat = 0.55
    static let triggerDistance: CGFloat = 220   // upward drag past this completes login
    static let flickVelocity: CGFloat = 600     // predicted upward velocity that also completes
    /// Brief dwell holding the orb over the title before the wave commits.
    static let chargeDuration: Double = 0.35
    /// Subtle rumble shimmer amplitude (points) — gentle, not violent.
    static let rumbleAmplitude: CGFloat = 2.5
    /// Cinematically slow duration of the orb growing to fill the screen, seconds.
    static let waveDuration: Double = 2.9
    /// Cross-fade from the full-screen glass into the camera, seconds.
    static let crossfadeDuration: Double = 0.75

    // MARK: Refraction lens (the Wabi-style crystal sphere)
    /// Spherical magnification strength (clear center, bends toward the rim).
    static let refractionMax: CGFloat = 0.42
    /// RGB channel split (points) at the rim — cranked for vivid edge fringing.
    static let aberrationMax: CGFloat = 26
    /// Must exceed the largest pixel displacement or the lens clips at the bounds.
    /// Large so the lens still holds up when the orb GROWS to fill the screen.
    static let lensMaxSampleOffset: CGFloat = 420
    /// Peak opacity of the iridescent lift glow (at dragProgress ≈ 0.5).
    static let iridescentPeak: CGFloat = 0.7

    static let iridescentCyan = Color(red: 40/255,  green: 205/255, blue: 246/255)   // #28CDF6
    static let iridescentBlue = Color(red: 162/255, green: 213/255, blue: 242/255)   // #A2D5F2
    static let iridescentPeriwinkle = Color(red: 149/255, green: 179/255, blue: 240/255) // #95B3F0

    // Lava-lamp colour flow inside the bubble — built around the project's
    // Carolina blue accent, with the lighter blues as secondary blobs.
    static let carolinaBlue = Color(red: 0x4b/255, green: 0x9c/255, blue: 0xd3/255)   // #4B9CD3
    /// Overall opacity ceiling for the lava colour while dragging.
    static let lavaStrength: CGFloat = 0.9
    /// Number of drifting colour blobs.
    static let lavaBlobs = 5

    // MARK: Motion (Phase 2)
    static let liftAnimation = Animation.interpolatingSpring(stiffness: 170, damping: 18)
    static let snapBackAnimation = Animation.spring(response: 0.45, dampingFraction: 0.78)
    static let completeAnimation = Animation.bouncy(duration: 0.6)
}

// MARK: - Pre-iOS-26 fallback (documented, not wired)
//
// The app's minimum deployment target is iOS 26, so native Liquid Glass is
// always available and `GlassBubbleView` calls `.glassEffect` directly. If you
// ever LOWER the target below 26, wrap the native call in `#available` and use
// this frosted-material fallback (it keeps the dome readable without Liquid
// Glass). Kept here so it's one paste away and never goes stale:
//
//   if #available(iOS 26.0, *) {
//       Color.clear.frame(width: d, height: d).glassEffect(.clear, in: Circle())
//   } else {
//       Circle().fill(.ultraThinMaterial)
//           .overlay(Circle().fill(Color.white.opacity(0.10)))
//   }
//
// The manual rim/specular overlays in GlassBubbleView apply in BOTH paths —
// native Liquid Glass specular does not render in the Simulator, only on device.
