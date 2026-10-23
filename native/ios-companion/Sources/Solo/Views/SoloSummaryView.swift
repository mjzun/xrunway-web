//
//  SoloSummaryView.swift
//  (X)RUNWAY iOS Companion — Solo mode (SOLO-MODE §2 + Appendix A3, Phase A)
//
//  The post-walk summary sheet — the SwiftUI translation of the web's
//  summary-card composition (SOLO-MODE "Summary card composition"):
//
//    WALK SUMMARY
//    {overall}            big rounded number, ok/warn by report.passed
//    PASS - BAR 78        verdictLine(report)
//    58S ON THE RUNWAY - 58 STEPS - 96/MIN
//    7 metric rows        value + thin bar, ALL judged against the ONE
//                         locked-mode passThreshold (no per-metric bars)
//    composite caption    PR/CO/PE honesty line (the pinned M5-M7 rule)
//    COACH'S NOTES        report.notes rows (empty -> the clean-walk line)
//    WALK AGAIN / DONE
//
//  Phase A deliberately shows NO delta / BEST / MASTERED — those chips are
//  the Phase B history store's business.
//

import SwiftUI
import XRunwayCore

struct SoloSummaryView: View {
    let result: SoloWalkResult
    /// The mode LOCKED at the walk edge — every row grades against ITS bar.
    let mode: TrainingMode
    var onWalkAgain: () -> Void
    var onDone: () -> Void

    private var passColor: Color {
        result.report.passed ? Brand.ok : Brand.warn
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                Text("WALK SUMMARY")
                    .font(.system(size: 13, weight: .semibold, design: .monospaced))
                    .tracking(3)
                    .foregroundStyle(Brand.white)
                    .padding(.top, 22)

                overallBlock
                metricRows
                compositeCaption
                notesSection
                buttons
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 18)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Brand.bg)
        .preferredColorScheme(.dark)
    }

    // MARK: - Overall + verdict + stat line

    private var overallBlock: some View {
        VStack(spacing: 6) {
            Text("\(Int(result.overall.rounded()))")
                .font(.system(size: 64, weight: .heavy, design: .monospaced))
                .foregroundStyle(passColor)
            Text(verdictLine(result.report))
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .tracking(2)
                .foregroundStyle(passColor)
            Text(soloStatLine)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(Brand.silver)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Metric rows

    private var metricRows: some View {
        VStack(spacing: 10) {
            ForEach(METRIC_ORDER, id: \.self) { key in
                metricRow(key)
            }
        }
    }

    private func metricRow(_ key: String) -> some View {
        let value = Int((result.scores[key] ?? 0).rounded())
        // The web's rule verbatim: pass coloring = value >= mode bar — the
        // SAME bar for all seven rows.
        let rowColor = Double(value) >= mode.passThreshold ? Brand.ok : Brand.warn
        return VStack(spacing: 4) {
            HStack {
                Text(metricLabel(key))
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .tracking(1.5)
                    .foregroundStyle(Brand.white.opacity(0.85))
                Spacer()
                Text("\(value)")
                    .font(.system(size: 12, weight: .heavy, design: .monospaced))
                    .foregroundStyle(rowColor)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.08))
                    Capsule()
                        .fill(rowColor)
                        .frame(width: geo.size.width
                            * CGFloat(min(max(Double(value) / 100.0, 0), 1)))
                }
            }
            .frame(height: 4)
        }
    }

    private func metricLabel(_ key: String) -> String {
        switch key {
        case "posture":       return "POSTURE"
        case "pace":          return "PACE"
        case "rhythm":        return "RHYTHM"
        case "footPlacement": return "FOOT PLACEMENT"
        case "presence":      return "PRESENCE"
        case "confidence":    return "CONFIDENCE"
        case "presentation":  return "PRESENTATION"
        default:              return key.uppercased()
        }
    }

    /// walkStatLine with the SOLO surface's honest location: there is no
    /// runway on the phone — the trainee walked THEIR LINE (the §3
    /// travel-line honesty ruling, applied to copy). Same shape as the
    /// Coach.swift helper otherwise (duration, then real steps/cadence).
    private var soloStatLine: String {
        let base = "\(jsIntString(jsRound(result.durationSec)))S ON YOUR LINE"
        guard let stats = result.stats, stats.steps > 0 else { return base }
        var line = "\(base) - \(stats.steps) STEPS"
        if let cadence = stats.cadenceSpm {
            line += " - \(jsIntString(jsRound(cadence)))/MIN"
        }
        return line
    }

    /// The pinned M5-M7 honesty marker, directly under the rows region that
    /// ends with the three composite reads. Names the rows as the screen
    /// labels them (review finding: PR/CO/PE codes appear nowhere here —
    /// they are the web history strip's column codes).
    private var compositeCaption: some View {
        Text("Presence, Confidence and Presentation are composite reads derived from the four measured channels - not separately measured.")
            .font(.system(size: 9))
            .foregroundStyle(Brand.silver)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Coach's notes

    private var notesSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("COACH'S NOTES")
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .tracking(2)
                .foregroundStyle(Brand.white)
            if result.report.notes.isEmpty {
                // The vector-locked constant, never a hand-copied twin
                // (review finding: a hardcoded truncation had drifted).
                noteRow(icon: "checkmark.circle", tint: Brand.ok,
                        text: CLEAN_WALK_CUE,
                        textColor: Brand.ok)
            } else {
                ForEach(Array(result.report.notes.enumerated()), id: \.offset) { _, note in
                    noteRow(icon: noteIcon(note.key), tint: Brand.accent,
                            text: note.cue,
                            textColor: Brand.white.opacity(0.7))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func noteRow(icon: String, tint: Color, text: String, textColor: Color) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 32, height: 32)
                .background(tint.opacity(0.12), in: Circle())
                .overlay(Circle().stroke(tint.opacity(0.3)))
            Text(text)
                .font(.system(size: 12))
                .foregroundStyle(textColor)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 6)
        }
    }

    private func noteIcon(_ key: String) -> String {
        switch key {
        case "posture":       return "figure.stand"
        case "pace":          return "speedometer"
        case "rhythm":        return "metronome"
        case "footPlacement": return "shoeprints.fill"
        case "presence":      return "sparkles"
        case "confidence":    return "bolt.fill"
        case "presentation":  return "star"
        default:              return "text.bubble"
        }
    }

    // MARK: - Buttons

    private var buttons: some View {
        VStack(spacing: 10) {
            Button {
                Haptics.tap()
                onWalkAgain()
            } label: {
                Text("WALK AGAIN")
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
                onDone()
            } label: {
                Text("DONE")
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .tracking(2)
                    .foregroundStyle(Brand.silver)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
        }
        .padding(.top, 4)
    }
}
