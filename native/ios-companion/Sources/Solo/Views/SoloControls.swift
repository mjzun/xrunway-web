//
//  SoloControls.swift
//  (X)RUNWAY iOS Companion — Solo mode (SOLO-MODE §2, Phase A3)
//
//  The bottom-panel CONTENT for Solo mode — phase-dependent controls rendered
//  INSIDE the existing glass panel (the parent owns the ConcentricRectangle
//  glass; this view is plain VStack content):
//
//    setup        mode picker + line row + coach-voice toggle + START WALK
//    measuring    "walk your line" instruction + DONE / CANCEL
//    positioning  status row ("walk to your start") + STOP
//    countdown    status row (count) + STOP
//    walking      elapsed / LAP / THERMAL chips + STOP
//    summary /    a minimal placeholder row — the summary sheet and the
//    interrupted  interrupted overlay own those moments
//
//  Design language: ContentView's glass vocabulary (monospaced SF, wide
//  tracking, accent-gradient primary button, Brand tokens only).
//

import SwiftUI
import XRunwayCore

struct SoloControls: View {
    @ObservedObject var engine: SoloSessionEngine

    /// Local mirrors for the engine's PLAIN vars (pickedModeId is not
    /// @Published; CoachVoice.enabled lives on a @MainActor class) — the
    /// @State drives SwiftUI invalidation, the writeback keeps the engine
    /// authoritative.
    @State private var selectedModeId: String = DEFAULT_MODE.id
    @State private var voiceOn: Bool = true

    var body: some View {
        Group {
            switch engine.phase {
            case .setup:
                setupControls
            case .measuring:
                measuringControls
            case .positioning, .countdown, .walking:
                liveControls
            case .summary, .interrupted:
                // The summary sheet / interrupted overlay own these phases.
                Text("-")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Brand.silver)
                    .frame(maxWidth: .infinity)
            }
        }
        .onAppear {
            selectedModeId = engine.pickedModeId
            voiceOn = engine.voice.enabled
        }
    }

    // MARK: - Setup

    private var setupControls: some View {
        VStack(spacing: 12) {
            modePicker
            modeDetail
            lineRow
            lineCaption
            voiceToggle
            startButton
        }
    }

    private var selectedMode: TrainingMode { getMode(selectedModeId) }

    private var modePicker: some View {
        LazyVGrid(
            columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)],
            spacing: 8
        ) {
            ForEach(MODES, id: \.id) { mode in
                modeChip(mode)
            }
        }
    }

    private func modeChip(_ mode: TrainingMode) -> some View {
        let selected = mode.id == selectedModeId
        return Button {
            selectedModeId = mode.id
            engine.pickedModeId = mode.id
        } label: {
            HStack(spacing: 7) {
                Text(mode.number)
                    .font(.system(size: 9, weight: .heavy, design: .monospaced))
                    .foregroundStyle(selected ? Brand.white.opacity(0.85) : Brand.accentSoft)
                Text(mode.label)
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .tracking(0.5)
                    .foregroundStyle(selected ? Brand.white : Brand.silver)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                if selected {
                    LinearGradient(colors: [Brand.accent, Brand.accentDeep],
                                   startPoint: .topLeading, endPoint: .bottomTrailing)
                } else {
                    Color.white.opacity(0.06)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 11))
            .overlay(RoundedRectangle(cornerRadius: 11)
                .stroke(selected ? Color.white.opacity(0.25) : Color.white.opacity(0.1)))
        }
        .buttonStyle(.plain)
    }

    private var modeDetail: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(selectedMode.tagline)
                .font(.system(size: 10))
                .foregroundStyle(Brand.silver)
                .fixedSize(horizontal: false, vertical: true)
            Text("\(passBarLabel(selectedMode.passThreshold)) - \(targetPaceLabel(selectedMode.idealPace))")
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .tracking(1)
                .foregroundStyle(Brand.silver)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Line row

    private var lineRow: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("LINE")
                    .font(.system(size: 8, design: .monospaced))
                    .tracking(1.5)
                    .foregroundStyle(Brand.silver)
                Text(lineValueLabel)
                    .font(.system(size: 13, weight: .semibold, design: .monospaced))
                    .foregroundStyle(engine.lineLengthM == nil ? Brand.silver : Brand.white)
            }
            Spacer(minLength: 4)
            stepButton("minus") {
                guard let current = engine.lineLengthM else { return }
                engine.setManualLength(max(1.0, current - 0.5))
            }
            stepButton("plus") {
                let base = engine.lineLengthM ?? 5.5
                engine.setManualLength(min(50.0, base + 0.5))
            }
            Button {
                Haptics.tap()
                engine.beginMeasure()
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "ruler")
                        .font(.system(size: 10, weight: .semibold))
                    Text("MEASURE")
                        .font(.system(size: 9, weight: .semibold, design: .monospaced))
                        .tracking(1)
                }
                .foregroundStyle(Brand.accentSoft)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .glassEffect(.regular, in: Capsule())
                .overlay(Capsule().stroke(Color.white.opacity(0.1)))
            }
            .buttonStyle(.plain)
        }
    }

    private var lineValueLabel: String {
        guard let m = engine.lineLengthM else { return "NOT SET" }
        return String(format: "%.1f M", m)
    }

    /// Small -/+ stepper (0.5 m per tap; + from NOT SET starts at 6.0 m).
    private func stepButton(_ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Brand.white)
                .frame(width: 30, height: 30)
                .glassEffect(.regular, in: Circle())
                .overlay(Circle().stroke(Color.white.opacity(0.1)))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var lineCaption: some View {
        if let note = engine.lineNote {
            Text(note)
                .font(.system(size: 9))
                .foregroundStyle(Brand.warn)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if engine.lineLengthM == nil {
            Text("Line optional - START works without it; the walk runs on the mode's clock.")
                .font(.system(size: 9))
                .foregroundStyle(Brand.silver)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Coach voice toggle

    private var voiceToggle: some View {
        Toggle(isOn: $voiceOn) {
            VStack(alignment: .leading, spacing: 1) {
                Text("COACH VOICE")
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .tracking(1)
                    .foregroundStyle(Brand.white)
                Text("Spoken cues during the walk and the count.")
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(Brand.silver)
            }
        }
        .tint(Brand.accent)
        .onChange(of: voiceOn) {
            engine.voice.enabled = voiceOn
        }
    }

    // MARK: - START

    private var startButton: some View {
        Button {
            Haptics.tap()
            engine.beginWalkFlow()
        } label: {
            Text("START WALK")
                .font(.system(size: 13, weight: .heavy, design: .monospaced))
                .tracking(3)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
                .foregroundStyle(Brand.white)
                .background {
                    LinearGradient(colors: [Brand.accent, Brand.accentDeep],
                                   startPoint: .topLeading, endPoint: .bottomTrailing)
                }
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.white.opacity(0.2)))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Measuring

    private var measuringControls: some View {
        VStack(spacing: 12) {
            Text("Walk your line, then come back.")
                .font(.system(size: 12))
                .foregroundStyle(Brand.white.opacity(0.7))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity)
            Button {
                Haptics.tap()
                engine.finishMeasure()
            } label: {
                Text("DONE")
                    .font(.system(size: 13, weight: .heavy, design: .monospaced))
                    .tracking(3)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .foregroundStyle(Brand.white)
                    .background {
                        LinearGradient(colors: [Brand.accent, Brand.accentDeep],
                                       startPoint: .topLeading, endPoint: .bottomTrailing)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.white.opacity(0.2)))
            }
            .buttonStyle(.plain)
            Button {
                engine.cancelMeasure()
            } label: {
                Text("CANCEL")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .tracking(2)
                    .foregroundStyle(Brand.silver)
                    .padding(.vertical, 4)
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Live (positioning / countdown / walking)

    private var liveControls: some View {
        VStack(spacing: 12) {
            statusRow
            Button {
                Haptics.tap()
                engine.stopEarly()
            } label: {
                Text("STOP WALK")
                    .font(.system(size: 13, weight: .heavy, design: .monospaced))
                    .tracking(3)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .foregroundStyle(Color(red: 0.98, green: 0.84, blue: 0.84))
                    .background(Brand.bad.opacity(0.22))
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.white.opacity(0.2)))
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private var statusRow: some View {
        switch engine.phase {
        case .positioning:
            Text("Walk to your start - hold until the count begins.")
                .font(.system(size: 11))
                .foregroundStyle(Brand.white.opacity(0.7))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .countdown(let n):
            HStack(spacing: 8) {
                chip("STARTING IN \(n)", color: Brand.accentSoft)
                if engine.thermalWarning { thermalChip }
                Spacer(minLength: 0)
            }
        case .walking:
            HStack(spacing: 8) {
                chip(elapsedLabel, color: Brand.white)
                if engine.laps > 0 {
                    chip("LAP \(engine.laps)", color: Brand.accentSoft)
                }
                if engine.thermalWarning { thermalChip }
                Spacer(minLength: 0)
            }
        default:
            EmptyView()
        }
    }

    private var elapsedLabel: String {
        let t = max(0, Int(engine.elapsedSec))
        return String(format: "%02d:%02d", t / 60, t % 60)
    }

    private var thermalChip: some View {
        chip("PHONE HOT", color: Brand.warn)
    }

    private func chip(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
            .tracking(1)
            .foregroundStyle(color)
            .padding(.horizontal, 11).padding(.vertical, 6)
            .glassEffect(.regular, in: Capsule())
            .overlay(Capsule().stroke(color.opacity(0.35)))
    }
}
