//
//  ContentView.swift
//  (X)RUNWAY iOS Companion
//
//  The capture screen, in the (X)RUNWAY glass design language: a full-screen AR
//  camera feed with floating Liquid Glass control panels over it (this is the
//  *right* place for Apple's frosted glass — chrome over live content). Brand:
//  the italic-Impact (X)RUNWAY wordmark + Carolina-blue accent.
//
//    - full-screen live AR camera view (ARSCNView, body-tracked)
//    - top glass bar: wordmark + connection pill
//    - glass badge row: FPS / SEND / SRC
//    - bottom glass panel: status, host/source fields, START/STOP, stream line
//    - skeleton overlay drawn from the streamed keypoints
//

import SwiftUI
import ARKit
import SceneKit
import AVFoundation

// MARK: - Root view
// (Brand palette lives in Sources/Theme/Brand.swift — extracted for A3 so
// Solo screens share the tokens without depending on this file.)

/// What the camera feeds (SOLO-MODE §4): SOLO scores the walk ON-DEVICE
/// (no relay); STREAM is the proven pose pipeline to the headset app.
enum AppMode: String {
    case solo
    case stream
}

struct ContentView: View {
    @StateObject private var relayStatus = RelayStatus()
    @StateObject private var trackingState = TrackingState()
    /// The Solo training engine + its voice (idle in stream mode).
    @StateObject private var engine = SoloSessionEngine(voice: CoachVoice())

    @State private var relay: PoseRelayClient?
    @State private var tracker: ARBodyTracker?
    /// DEBUG (XR_SOLO_FAKE_POSE=1): the synthetic walker that stands in for
    /// ARKit in the Simulator — see SoloFakePoseFeed.
    @State private var fakeFeed: SoloFakePoseFeed?

    // Persisted across launches so you don't retype the relay target each time.
    @AppStorage("xr.relayHost") private var host: String = "192.168.1.42"
    @AppStorage("xr.relaySource") private var source: String = "iphone-arkit"
    @AppStorage("xr.relaySecure") private var secure: Bool = false
    /// SOLO | STREAM — persisted; solo is the product's front door (the
    /// accessible-trainer ladder, SOLO-MODE §1).
    @AppStorage("xr.appMode") private var appModeRaw: String = AppMode.solo.rawValue
    @State private var running = false
    /// Camera permission block, split by WHO can fix it (POLISH-AUDIT #5):
    /// `.denied` — the user flipped the switch off; OPEN SETTINGS can fix it.
    /// `.restricted` — Screen Time / MDM; the user cannot flip that switch,
    /// so the card must not promise a Settings fix. Either way START refuses
    /// to run the ARSession and the camera layer shows an explicit blocked
    /// state instead of a silent black view.
    private enum CameraBlock { case none, denied, restricted }
    @State private var cameraBlock: CameraBlock = .none
    /// A camera-permission request (the system dialog) is in flight — START
    /// must not re-enter and spawn a second requestAccess / double beginRunning.
    @State private var preflighting = false
    /// Tripod-setup tips sheet (POLISH-AUDIT #13), reached from the SETUP pill.
    @State private var showSetupTips = false

    private var appMode: AppMode { AppMode(rawValue: appModeRaw) ?? .solo }
    /// Solo requires ARKit 3D body tracking (§3: image-space pose must never
    /// silently score) — unsupported devices get the explicit block screen.
    /// The DEBUG fake-pose feed bypasses it (its frames are synthetic world
    /// space; ARKit is not involved — the Simulator harness).
    private var soloBlocked: Bool {
        appMode == .solo && !ARBodyTracker.bodyTrackingSupported
            && !SoloFakePoseFeed.isEnabled
    }

    var body: some View {
        // Glass chrome is the layout (respects the safe area); the camera fills the
        // whole screen BEHIND it, so the top cards clear the Dynamic Island and the
        // bottom card sits above the home indicator.
        VStack(spacing: 10) {
            topBar
            HStack(spacing: 8) {
                badge("CAMERA", "\(trackingState.captureFps) fps")
                if appMode == .stream {
                    badge("SENDING", "\(relayStatus.sendFps)/s")
                    badge("NAME", source)
                }
                Spacer()
                setupTipsButton
            }
            Spacer()
            if running {
                framingChip
                modeChip
            }
            bottomPanel
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            ZStack {
                cameraLayer
                if let tracker, running {
                    SkeletonOverlay(keypoints: trackingState.keypoints, mode: trackingState.mode)
                        .id(ObjectIdentifier(tracker))
                }
                if appMode == .solo, running {
                    SoloOverlays(engine: engine)
                }
            }
            .ignoresSafeArea()
        }
        .onAppear(perform: ensureClients)
        .sheet(isPresented: $showSetupTips) { SetupTipsCard() }
        .sheet(isPresented: summaryShown) {
            if let result = engine.result {
                SoloSummaryView(
                    result: result,
                    mode: engine.lockedMode,
                    onWalkAgain: {
                        engine.acknowledge()
                        engine.beginWalkFlow()
                    },
                    onDone: { engine.acknowledge() })
            }
        }
        // §2 v1: a capture interruption mid-walk DISCARDS the walk. Typed
        // channels (review finding: the note-string edge was wording-coupled
        // and missed a walk STARTED during an interruption).
        .onChange(of: trackingState.sessionError) { _, err in
            if !err.isEmpty { engine.noteCaptureInterrupted(err) }
        }
        .onChange(of: trackingState.captureInterrupted) { _, interrupted in
            if interrupted {
                engine.noteCaptureInterrupted(
                    "The camera was paused by the system - this walk was not scored.")
            }
        }
        // Level check: a walk flow STARTED while the camera is already
        // paused must interrupt immediately, not wait forever in
        // positioning (onChange alone only catches the rising edge).
        .onChange(of: engine.phase) { _, phase in
            if phase == .positioning, trackingState.captureInterrupted {
                engine.noteCaptureInterrupted(
                    "The camera is paused by the system - start the walk once it is back.")
            }
        }
        .preferredColorScheme(.dark)
    }

    /// The summary sheet binding: shown exactly while the engine sits in
    /// .summary; dismissing acknowledges (back to setup).
    private var summaryShown: Binding<Bool> {
        Binding(
            get: { engine.phase == .summary && engine.result != nil },
            set: { shown in if !shown { engine.acknowledge() } })
    }

    /// The SOLO | STREAM segmented glass pill. Locked while running — the
    /// capture pipeline is mode-shaped at START.
    private var modePill: some View {
        HStack(spacing: 0) {
            ForEach([AppMode.solo, AppMode.stream], id: \.rawValue) { m in
                Button {
                    guard !running else { return }
                    appModeRaw = m.rawValue
                } label: {
                    Text(m == .solo ? "SOLO" : "STREAM")
                        .font(.system(size: 9, weight: .semibold, design: .monospaced))
                        .foregroundStyle(appMode == m ? Brand.white : Brand.silver)
                        .padding(.horizontal, 9).padding(.vertical, 6)
                        .background {
                            if appMode == m {
                                Capsule().fill(Brand.accent.opacity(0.45))
                            }
                        }
                }
                .buttonStyle(.plain)
            }
        }
        .glassEffect(.regular, in: Capsule())
        .overlay(Capsule().stroke(Color.white.opacity(0.1)))
        .opacity(running ? 0.5 : 1)
    }

    // MARK: Camera layer

    private var cameraLayer: some View {
        ZStack {
            Brand.bg
            if soloBlocked {
                SoloBodyTrackingBlock()
            } else if cameraBlock != .none {
                cameraBlockedView
            } else if let tracker, running {
                ARViewContainer(session: tracker.session)
            } else {
                idlePlaceholder
            }
        }
    }

    private var idlePlaceholder: some View {
        VStack(spacing: 14) {
            Image(systemName: "figure.walk.motion")
                .font(.system(size: 40))
                .foregroundStyle(Brand.accent)
            Text("CAMERA IDLE")
                .font(.system(size: 13, weight: .semibold, design: .monospaced))
                .tracking(3)
                .foregroundStyle(Brand.white)
            Text(ARBodyTracker.bodyTrackingSupported
                 ? "Put the phone on a tripod, point it at the runway, and press START."
                 : "This device uses simplified 2D tracking. Point it at the runway and press START.")
                .font(.system(size: 12))
                .foregroundStyle(Brand.white.opacity(0.7))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
    }

    /// Explicit camera-permission-blocked state: same visual family as the idle
    /// placeholder (icon + tracked monospaced headline + one-liner). Denied gets
    /// an Open Settings deep link in the START button's accent-gradient style;
    /// restricted (Screen Time / MDM) hides it — the user cannot flip that
    /// switch, so the button would be a false promise.
    private var cameraBlockedView: some View {
        VStack(spacing: 14) {
            Image(systemName: "video.slash")
                .font(.system(size: 40))
                .foregroundStyle(Brand.bad)
            Text(cameraBlock == .restricted ? "CAMERA BLOCKED" : "CAMERA ACCESS OFF")
                .font(.system(size: 13, weight: .semibold, design: .monospaced))
                .tracking(3)
                .foregroundStyle(Brand.white)
            Text(cameraBlock == .restricted
                 ? "Camera is blocked by Screen Time or a device management profile — ask whoever manages this device to allow it."
                 : "(X)RUNWAY Cam can't see the walker without the camera. Allow it in Settings, then press START again.")
                .font(.system(size: 12))
                .foregroundStyle(Brand.white.opacity(0.7))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
            if cameraBlock == .denied {
                Button(action: openSettings) {
                    Text("OPEN SETTINGS")
                        .font(.system(size: 12, weight: .heavy, design: .monospaced))
                        .tracking(2)
                        .foregroundStyle(Brand.white)
                        .padding(.horizontal, 24).padding(.vertical, 12)
                        .background {
                            LinearGradient(colors: [Brand.accent, Brand.accentDeep],
                                           startPoint: .topLeading, endPoint: .bottomTrailing)
                        }
                        .clipShape(Capsule())
                        .overlay(Capsule().stroke(Color.white.opacity(0.2)))
                }
                .buttonStyle(.plain)
                .padding(.top, 6)
            }
        }
    }

    // MARK: Top bar

    private var topBar: some View {
        HStack(spacing: 10) {
            BrandWordmark(size: 19, color: Brand.white)
            // The mode switch IS the screen's caption — SOLO | STREAM.
            modePill
            Spacer()
            if appMode == .stream {
                connectionPill
            } else {
                onDevicePill
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .glassEffect(.regular, in: Capsule())
        .overlay(Capsule().stroke(Color.white.opacity(0.12)))
    }

    /// Solo's honest counterpart to the connection pill: nothing connects —
    /// everything happens on this phone.
    private var onDevicePill: some View {
        HStack(spacing: 7) {
            Circle().fill(Brand.ok).frame(width: 8, height: 8)
            Text("On-device")
                .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                .foregroundStyle(Brand.ok)
        }
        .padding(.horizontal, 11).padding(.vertical, 6)
        .background(Brand.ok.opacity(0.12), in: Capsule())
        .overlay(Capsule().stroke(Brand.ok.opacity(0.4)))
    }

    private var connectionPill: some View {
        let (label, color): (String, Color) = {
            switch relayStatus.phase {
            case .connected:  return ("Connected", Brand.ok)
            case .connecting: return ("Connecting…", Brand.warn)
            case .offline:    return ("Offline", Brand.silver)
            }
        }()
        return HStack(spacing: 7) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(label)
                .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                .foregroundStyle(color)
        }
        .padding(.horizontal, 11).padding(.vertical, 6)
        .background(color.opacity(0.12), in: Capsule())
        .overlay(Capsule().stroke(color.opacity(0.4)))
    }

    private func badge(_ label: String, _ value: String) -> some View {
        HStack(spacing: 5) {
            Text(label).foregroundStyle(Brand.white)
            Text(value).foregroundStyle(Brand.accentSoft)
        }
        .font(.system(size: 9, weight: .semibold, design: .monospaced))
        .padding(.horizontal, 10).padding(.vertical, 6)
        .glassEffect(.regular, in: Capsule())
        .overlay(Capsule().stroke(Color.white.opacity(0.1)))
    }

    private var modeChip: some View {
        Text(modeLine)
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(Brand.accentSoft)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .glassEffect(.regular, in: Capsule())
    }

    /// Live tripod-framing tip (POLISH-AUDIT #13): tells the operator how to
    /// fix the shot from what the tracker actually sees, in the same glass-chip
    /// family as the mode chip below it. The published FramingStatus is already
    /// debounced (hysteresis in ARBodyTracker), so this stays readable.
    @ViewBuilder
    private var framingChip: some View {
        if let line = framingLine {
            HStack(spacing: 6) {
                Image(systemName: line.icon)
                    .font(.system(size: 10, weight: .semibold))
                Text(line.text)
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
            }
            .foregroundStyle(line.color)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .glassEffect(.regular, in: Capsule())
            .overlay(Capsule().stroke(line.color.opacity(0.35)))
        }
    }

    private var framingLine: (icon: String, text: String, color: Color)? {
        switch trackingState.framing {
        case .unknown: return nil
        case .noBody:  return ("eye.slash", "Point the camera at the walker", Brand.warn)
        case .feetOut: return ("arrow.down.to.line", "Move back — feet out of frame", Brand.warn)
        case .headOut: return ("arrow.up.to.line", "Aim higher — head out of frame", Brand.warn)
        case .partial: return ("person.crop.rectangle", "Keep the whole body in frame", Brand.warn)
        case .good:    return ("checkmark.circle", "Framing good — whole body visible", Brand.ok)
        }
    }

    /// Small glass pill that opens the static tripod-setup tips (#13).
    private var setupTipsButton: some View {
        Button { showSetupTips = true } label: {
            HStack(spacing: 5) {
                Image(systemName: "info.circle")
                    .font(.system(size: 10, weight: .semibold))
                Text("SETUP")
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
            }
            .foregroundStyle(Brand.accentSoft)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .glassEffect(.regular, in: Capsule())
            .overlay(Capsule().stroke(Color.white.opacity(0.1)))
        }
        .buttonStyle(.plain)
    }

    private var modeLine: String {
        switch trackingState.mode {
        case .arBody:         return "3D tracking\(trackingState.bodyVisible ? " — walker locked" : " — looking for the walker…")"
        case .visionFallback: return "2D tracking (simplified)\(trackingState.bodyVisible ? " — walker found" : " — looking for the walker…")"
        case .unknown:        return "Starting…"
        }
    }

    // MARK: Bottom panel

    private var secureToggle: some View {
        Toggle(isOn: $secure) {
            VStack(alignment: .leading, spacing: 1) {
                Text("SECURE CONNECTION")
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .tracking(1)
                    .foregroundStyle(Brand.white)
                Text("Match the receiver — only turn on if it uses a secure link.")
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(Brand.silver)
            }
        }
        .tint(Brand.accent)
        .disabled(running)                 // set the transport before START
        .opacity(running ? 0.5 : 1)
    }

    private var bottomPanel: some View {
        VStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(statusLine)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Brand.silver)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if appMode == .stream, running, relayStatus.phase != .connected,
                    let hint = relayStatus.lastHint
                {
                    Text(hint)
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(Brand.warn)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            // Stream-only chrome (SOLO-MODE A3 file map): the relay target,
            // camera name and transport toggle mean nothing on-device.
            if appMode == .stream {
                HStack(spacing: 10) {
                    field("Receiver address (Wi-Fi IP)", text: $host, placeholder: "192.168.1.42", lockedWhileRunning: true)
                    field("Camera name", text: $source, placeholder: "iphone-arkit", liveSource: true)
                }

                secureToggle
            }

            // Solo walk controls live between the status line and the camera
            // button once capture runs.
            if appMode == .solo, running, !soloBlocked {
                SoloControls(engine: engine)
            }

            Button(action: toggle) {
                Text(running ? "STOP CAMERA" : "START CAMERA")
                    .font(.system(size: 13, weight: .heavy, design: .monospaced))
                    .tracking(3)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .foregroundStyle(running ? Color(red: 0.98, green: 0.84, blue: 0.84) : Brand.white)
                    .background {
                        if running {
                            Brand.bad.opacity(0.22)
                        } else {
                            LinearGradient(colors: [Brand.accent, Brand.accentDeep],
                                           startPoint: .topLeading, endPoint: .bottomTrailing)
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.white.opacity(0.2)))
            }
            .buttonStyle(.plain)
            .disabled(soloBlocked)
            .opacity(soloBlocked ? 0.4 : 1)

            if appMode == .stream {
                // Honest about state: only claims "Sending" while actually running.
                Text(verbatim: "\(running ? "Sending" : "Will send") to \(dialTarget)")
                    .font(.system(size: 10))
                    .foregroundStyle(Brand.silver)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(16)
        // Corners concentric with the display's rounded corners (iOS 26).
        .glassEffect(.regular, in: ConcentricRectangle())
        .overlay(ConcentricRectangle().stroke(Color.white.opacity(0.12)))
    }

    private func field(_ label: String, text: Binding<String>, placeholder: String,
                       lockedWhileRunning: Bool = false, liveSource: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label.uppercased())
                .font(.system(size: 8, design: .monospaced))
                .tracking(1.5)
                .foregroundStyle(Brand.silver)
            TextField(placeholder, text: text)
                .font(.system(size: 13, design: .monospaced))
                .foregroundStyle(Brand.white)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .keyboardType(.asciiCapable)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 11))
                .overlay(RoundedRectangle(cornerRadius: 11).stroke(Color.white.opacity(0.14)))
                .disabled(lockedWhileRunning && running)
                .opacity(lockedWhileRunning && running ? 0.55 : 1)
                .onChange(of: text.wrappedValue) {
                    // Only the SOURCE field re-announces; the host is locked while
                    // streaming (you set the transport before START), so editing it
                    // can't silently no-op or misfire updateSource.
                    if liveSource, running { Task { await relay?.updateSource(source) } }
                }
        }
    }

    private var dialTarget: String {
        "\(secure ? "wss" : "ws")://\(host):\(PoseRelayClient.relayPort)"
    }

    private var statusLine: String {
        // The camera outranks everything: a blocked permission or a failed
        // AR session is the walker's real problem in EVERY mode — never let
        // a relay/phase line mask a dead camera.
        switch cameraBlock {
        case .denied:
            return "Camera access is off — allow it in Settings, then press START."
        case .restricted:
            return "Camera is blocked by Screen Time or a device management profile."
        case .none:
            break
        }
        if !trackingState.sessionError.isEmpty {
            return trackingState.sessionError
        }
        if appMode == .solo {
            return soloStatusLine
        }
        switch relayStatus.phase {
        case .connecting:
            return "Connecting to \(relayStatus.target ?? dialTarget)…"
        case .connected:
            return trackingState.note.isEmpty ? "Streaming — \(relayStatus.sendFps)/s" : trackingState.note
        case .offline:
            if !running {
                return ARBodyTracker.bodyTrackingSupported ? "Ready — 3D body tracking." : "Ready — simplified 2D tracking."
            }
            if let err = relayStatus.lastError, !err.isEmpty { return "Connection: \(err)" }
            return "Receiver not reachable — retrying…"
        }
    }

    private var soloStatusLine: String {
        if soloBlocked {
            return "Solo needs 3D body tracking — this device can't score honestly."
        }
        if !running {
            return "Ready — on-device coaching. Start the camera to begin."
        }
        switch engine.phase {
        case .setup:
            return "Pick a lesson, set your line, then START WALK."
        case .measuring:
            return "Measuring — walk your line, come back, tap DONE."
        case .positioning:
            return "Waiting for the walker at the start of the line…"
        case .countdown:
            return "Counting down…"
        case .walking:
            let left = max(0, engine.lockedMode.walkSeconds - engine.elapsedSec)
            return "Walk in progress — \(Int(left))s left."
        case .summary:
            return "Walk scored."
        case .interrupted:
            return "Walk interrupted — not scored."
        }
    }

    // MARK: Actions

    private func ensureClients() {
        if relay == nil {
            let r = PoseRelayClient(status: relayStatus)
            relay = r
            tracker = ARBodyTracker(relay: r, state: trackingState)
        }
        // DEBUG: bring up only the RELAY (not ARKit, which can't run in the
        // Simulator) so the connect/diagnostic states can be inspected without a
        // tap. No effect unless the env var is set. Forces STREAM mode first —
        // autostarting a relay under the solo "On-device" pill would be a
        // self-contradiction, and `running` would lock the mode pill (review
        // finding).
        if !running, ProcessInfo.processInfo.environment["XR_AUTOSTREAM"] == "1" {
            appModeRaw = AppMode.stream.rawValue
            running = true
            Task { await relay?.start(host: host, source: source, secure: secure) }
        }
    }

    private func toggle() {
        ensureClients()
        guard let relay, let tracker else { return }
        guard !soloBlocked else { return }
        // While the permission dialog is pending, `running` is still false —
        // a second START tap would spawn a duplicate requestAccess task and a
        // double beginRunning on grant. Bail until the preflight resolves.
        guard !preflighting else { return }
        // Tactile confirmation for START/STOP (#27) — after the re-entrancy
        // guard, so a dead-bounced tap doesn't buzz.
        Haptics.tap()
        if running {
            running = false
            // Any in-flight Solo walk is discarded (§2 v1) before the
            // capture stops; harmless when the engine is idle.
            engine.stopEarly()
            fakeFeed?.stop()
            fakeFeed = nil
            tracker.soloSink = nil
            tracker.stop()
            Task { await relay.stop() }
        } else {
            startAfterCameraPreflight()
        }
    }

    /// Preflight the camera permission BEFORE running the ARSession, so a
    /// blocked camera becomes an explicit, actionable state instead of a black
    /// view over "Relay offline…" (POLISH-AUDIT #5).
    private func startAfterCameraPreflight() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            beginRunning()
        case .notDetermined:
            preflighting = true
            Task { @MainActor in
                let granted = await AVCaptureDevice.requestAccess(for: .video)
                preflighting = false
                if granted { beginRunning() } else { cameraBlock = .denied }
            }
        case .denied:
            cameraBlock = .denied
        case .restricted:
            // Screen Time / MDM restriction — distinct from .denied because the
            // Settings switch is not user-changeable (often not even shown).
            cameraBlock = .restricted
        @unknown default:
            // Unknown future status: try anyway — a real failure now surfaces
            // via trackingState.sessionError instead of being swallowed.
            beginRunning()
        }
    }

    private func beginRunning() {
        guard let relay, let tracker else { return }
        cameraBlock = .none
        running = true
        switch appMode {
        case .solo:
            // On-device only: the tracker feeds the Solo engine through the
            // PoseFrameSink seam; the relay is never started (its send()
            // no-ops while stopped, so the shared publish path stays safe).
            if SoloFakePoseFeed.isEnabled {
                // DEBUG: the synthetic walker replaces ARKit (Simulator).
                let feed = SoloFakePoseFeed()
                fakeFeed = feed
                feed.start(engine: engine)
            } else {
                tracker.soloSink = engine
                tracker.start(source: source)
            }
        case .stream:
            tracker.soloSink = nil
            tracker.start(source: source)
            Task { await relay.start(host: host, source: source, secure: secure) }
        }
    }

    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

// MARK: - Setup tips card

/// Static tripod-placement tips (POLISH-AUDIT #13): the advice a coach would
/// give before the first walk, kept short and physical. Reached from the SETUP
/// pill on the camera screen; the live framing chip takes over once tracking
/// runs. Portrait is the recommended orientation because the simplified 2D
/// path reads the camera image upright-portrait, and portrait keeps a full
/// standing body in frame at runway distances.
struct SetupTipsCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("CAMERA SETUP")
                .font(.system(size: 13, weight: .semibold, design: .monospaced))
                .tracking(3)
                .foregroundStyle(Brand.white)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.top, 22)
            tip("arrow.left.and.right", "Film from the side",
                "Place the phone side-on to the runway, so the walk crosses the frame.")
            tip("ruler", "Stand back 3–5 meters",
                "About 10–16 feet from the runway — far enough to fit the whole walk.")
            tip("iphone", "Waist height, upright",
                "Tripod at waist height, phone in portrait, not tilted up or down.")
            tip("person.fill.viewfinder", "Whole body in frame",
                "Head to feet must stay visible for the entire walk. Once the camera runs, the framing tip on screen turns green when the shot is right.")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
        .presentationBackground(Brand.bg)
        .preferredColorScheme(.dark)
    }

    private func tip(_ icon: String, _ title: String, _ body: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Brand.accent)
                .frame(width: 34, height: 34)
                .background(Brand.accent.opacity(0.12), in: Circle())
                .overlay(Circle().stroke(Brand.accent.opacity(0.3)))
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .tracking(1)
                    .foregroundStyle(Brand.white)
                Text(body)
                    .font(.system(size: 12))
                    .foregroundStyle(Brand.white.opacity(0.7))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

// MARK: - ARSCNView host

/// Hosts the ARKit session in a SceneKit view so the camera feed renders. We do
/// NOT drive ARSession from here — ARBodyTracker owns it; we only display it.
struct ARViewContainer: UIViewRepresentable {
    let session: ARSession

    func makeUIView(context: Context) -> ARSCNView {
        let view = ARSCNView(frame: .zero)
        view.session = session
        view.automaticallyUpdatesLighting = true
        view.scene = SCNScene()
        return view
    }

    func updateUIView(_ uiView: ARSCNView, context: Context) {}
}

// MARK: - Skeleton overlay

/// Draws the streamed keypoints over the camera feed. In `.arBody` mode the
/// keypoints are world meters, so we project to a stable 2D layout (orthographic
/// front view, scaled) for a recognizable stick figure; in `.visionFallback`
/// mode they are already normalized image coords (0..1, y down) — drawn directly.
struct SkeletonOverlay: View {
    let keypoints: [String: PoseKeypoint]
    let mode: TrackingMode

    var body: some View {
        GeometryReader { geo in
            Canvas { ctx, size in
                guard !keypoints.isEmpty else { return }
                let pts = projected(in: size)

                var path = Path()
                for (a, b) in Keypoint.bones {
                    guard let pa = pts[a], let pb = pts[b] else { continue }
                    path.move(to: pa)
                    path.addLine(to: pb)
                }
                ctx.stroke(path, with: .color(Brand.accent.opacity(0.9)),
                           style: StrokeStyle(lineWidth: max(2, size.width * 0.006),
                                              lineCap: .round))

                let r = max(3, size.width * 0.008)
                for name in Keypoint.all {
                    guard let p = pts[name] else { continue }
                    let outer = CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)
                    ctx.fill(Path(ellipseIn: outer), with: .color(Brand.white))
                    let ir = r * 0.55
                    let inner = CGRect(x: p.x - ir, y: p.y - ir, width: ir * 2, height: ir * 2)
                    ctx.fill(Path(ellipseIn: inner), with: .color(Brand.accent))
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .allowsHitTesting(false)
    }

    private func projected(in size: CGSize) -> [String: CGPoint] {
        switch mode {
        case .visionFallback:
            var out: [String: CGPoint] = [:]
            for (name, k) in keypoints {
                out[name] = CGPoint(x: CGFloat(k.x) * size.width,
                                    y: CGFloat(k.y) * size.height)
            }
            return out
        case .arBody, .unknown:
            var minX = Double.greatestFiniteMagnitude, maxX = -Double.greatestFiniteMagnitude
            var minY = Double.greatestFiniteMagnitude, maxY = -Double.greatestFiniteMagnitude
            for k in keypoints.values {
                minX = min(minX, k.x); maxX = max(maxX, k.x)
                minY = min(minY, k.y); maxY = max(maxY, k.y)
            }
            let spanX = max(maxX - minX, 0.001)
            let spanY = max(maxY - minY, 0.001)
            let span = max(spanX, spanY)
            let pad = 0.18
            let drawW = Double(size.width) * (1 - 2 * pad)
            let drawH = Double(size.height) * (1 - 2 * pad)
            let scale = min(drawW, drawH) / span
            let cx = (minX + maxX) * 0.5
            let cy = (minY + maxY) * 0.5
            var out: [String: CGPoint] = [:]
            for (name, k) in keypoints {
                let sx = Double(size.width) * 0.5 + (k.x - cx) * scale
                let sy = Double(size.height) * 0.5 - (k.y - cy) * scale
                out[name] = CGPoint(x: sx, y: sy)
            }
            return out
        }
    }
}
