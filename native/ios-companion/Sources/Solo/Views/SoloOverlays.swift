//
//  SoloOverlays.swift
//  (X)RUNWAY iOS Companion — Solo mode (SOLO-MODE §2, Phase A3)
//
//  Mid-screen overlays above the camera, one per Solo moment:
//
//    positioning   glass banner — "WALK TO YOUR START" (the trainee is
//                  walking away from the phone; the banner backs up the
//                  voice line for anyone still close enough to read)
//    countdown     a HUGE glowing digit — visible from the far end of the
//                  line (the audible count is the primary channel)
//    interrupted   glass card — "WALK NOT SCORED" + the plain reason and
//                  an OK button (engine.acknowledge)
//
//  walking / setup / measuring / summary render NOTHING — the camera stays
//  clean during the walk, and the summary sheet owns its own moment.
//

import SwiftUI
import XRunwayCore

struct SoloOverlays: View {
    @ObservedObject var engine: SoloSessionEngine

    var body: some View {
        switch engine.phase {
        case .positioning:
            positioningBanner
        case .countdown(let n):
            countdownDigit(n)
        case .interrupted(let message):
            interruptedCard(message)
        case .setup, .measuring, .walking, .summary:
            EmptyView()
        }
    }

    // MARK: - Positioning banner

    private var positioningBanner: some View {
        VStack(spacing: 10) {
            Image(systemName: "figure.walk.motion")
                .font(.system(size: 28))
                .foregroundStyle(Brand.accent)
            Text("WALK TO YOUR START")
                .font(.system(size: 13, weight: .semibold, design: .monospaced))
                .tracking(3)
                .foregroundStyle(Brand.white)
            Text("Hold still until you hear the count.")
                .font(.system(size: 12))
                .foregroundStyle(Brand.white.opacity(0.7))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 26)
        .padding(.vertical, 20)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 22))
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color.white.opacity(0.12)))
        .padding(.horizontal, 32)
        .allowsHitTesting(false)
    }

    // MARK: - Countdown digit

    private func countdownDigit(_ n: Int) -> some View {
        Text("\(n)")
            .font(.system(size: 120, weight: .heavy, design: .monospaced))
            .foregroundStyle(Brand.white)
            .shadow(color: Brand.accent.opacity(0.9), radius: 22)
            .shadow(color: Brand.accent.opacity(0.5), radius: 60)
            .id(n) // re-enter per beat so the transition pulses
            .transition(.scale(scale: 1.25).combined(with: .opacity))
            .animation(.easeOut(duration: 0.25), value: n)
            .allowsHitTesting(false)
    }

    // MARK: - Interrupted card

    private func interruptedCard(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(Brand.warn)
                .frame(width: 52, height: 52)
                .background(Brand.warn.opacity(0.12), in: Circle())
                .overlay(Circle().stroke(Brand.warn.opacity(0.3)))
            Text("WALK NOT SCORED")
                .font(.system(size: 13, weight: .semibold, design: .monospaced))
                .tracking(3)
                .foregroundStyle(Brand.white)
            Text(message)
                .font(.system(size: 12))
                .foregroundStyle(Brand.white.opacity(0.7))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                engine.acknowledge()
            } label: {
                Text("OK")
                    .font(.system(size: 12, weight: .heavy, design: .monospaced))
                    .tracking(2)
                    .foregroundStyle(Brand.white)
                    .padding(.horizontal, 34).padding(.vertical, 12)
                    .background {
                        LinearGradient(colors: [Brand.accent, Brand.accentDeep],
                                       startPoint: .topLeading, endPoint: .bottomTrailing)
                    }
                    .clipShape(Capsule())
                    .overlay(Capsule().stroke(Color.white.opacity(0.2)))
            }
            .buttonStyle(.plain)
            .padding(.top, 4)
        }
        .padding(.horizontal, 26)
        .padding(.vertical, 22)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 22))
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color.white.opacity(0.12)))
        .padding(.horizontal, 32)
    }
}
