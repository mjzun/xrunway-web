//
//  PoseRelayClient.swift
//  (X)RUNWAY iOS Companion
//
//  A small WebSocket client (URLSessionWebSocketTask) that streams PoseFrames to
//  the (X)RUNWAY pose relay. Ports the transport behaviour of the browser
//  companion (public/companion/index.html) and the headset ingest
//  (src/pose-ingest.ts):
//
//    - connect to ws://<host>:8082  (relay port from vite.config.ts)
//    - on open: send { type:"hello", role:"sender", source:"..." }
//    - stream  { type:"pose", frame:PoseFrame } throttled to <= 30/s
//    - auto-reconnect with exponential backoff (1s -> 15s cap), like the browser
//    - native apps are NOT browser-sandboxed, so plain ws is fine (no TLS/HTTPS)
//    - CONNECTED means the relay answered: the phase is gated on a protocol
//      ping coming back as a pong, and a heartbeat keeps re-proving it every
//      pingIntervalMs — a peer that vanishes without FIN/RST demotes to
//      reconnecting instead of displaying a stale "Connected".
//
//  Concurrency: an actor owns all socket state so sends/reconnects never race.
//  A @MainActor observable mirror (RelayStatus) drives the SwiftUI status UI.
//

import Foundation
import Combine
import Synchronization

/// Connection phase for the UI pill.
enum RelayPhase: Equatable {
    case offline
    case connecting
    case connected
}

/// Observable status the SwiftUI layer renders. Updated on the main actor.
@MainActor
final class RelayStatus: ObservableObject {
    @Published var phase: RelayPhase = .offline
    /// Frames actually sent in the last ~1s window (post-throttle send rate).
    @Published var sendFps: Int = 0
    /// Last error string for display (host unreachable, etc).
    @Published var lastError: String?
    /// A plain-language fix suggestion derived from the failure (see hint(for:)).
    @Published var lastHint: String?
    /// The URL currently being dialed, shown while connecting so a typo'd host /
    /// wrong scheme is obvious.
    @Published var target: String?
}

/// Drives a single relay connection. Reconnects until `stop()` is called.
actor PoseRelayClient {
    // Relay port — must match POSE_RELAY_PORT in vite.config.ts.
    static let relayPort = 8082

    // Throttle pose sends to <= ~30/s regardless of capture FPS (matches
    // SEND_INTERVAL_MS in the browser companion).
    private static let sendIntervalMs: Double = 1000.0 / 30.0

    // Reconnect backoff, mirroring the browser: start 1s, double, cap 15s.
    private static let backoffStartMs: Double = 1000
    private static let backoffMaxMs: Double = 15000

    // Give up a stalled connection attempt after this long (the WebSocket task's
    // own timeout is unreliable) so the UI leaves "Connecting…".
    private static let connectTimeoutMs: Double = 6000

    // Post-connect liveness: ping every pingIntervalMs; a ping still unanswered
    // when the NEXT tick fires demotes the connection (worst-case detection
    // ~2 intervals). A pong is the only proof the far side is still a live WS
    // server — the relay never speaks first (it only broadcasts OTHER clients'
    // traffic, so inbound silence is normal), and a peer that vanishes without
    // FIN/RST (machine changed networks / slept) leaves the pending receive
    // hanging and lets sends "succeed" into TCP retransmit limbo for minutes.
    // Witnessed 2026-07-02: the app claimed CONNECTED + SENDING against an IP
    // that no longer belonged to any machine, exactly because nothing after
    // the single connect-time pong ever re-proved the relay was there.
    private static let pingIntervalMs: Double = 10000

    // A connection must survive at least this long before a later drop is treated
    // as "stable" (allowed to fast-retry). Shorter-lived drops keep escalating
    // backoff, so a relay that accepts then immediately drops the sender isn't
    // hammered at a fixed 1s interval.
    private static let stableResetMs: Double = 5000

    /// Monotonic milliseconds — immune to wall-clock steps. Used for the send
    /// throttle, the FPS window, and connection-uptime, NOT for payload stamps.
    static func monoMs() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }

    private let status: RelayStatus

    private var host: String = ""
    private var source: String = "iphone-arkit"
    /// When true, dial wss:// (TLS) — needed when the dev relay runs under
    /// XRUNWAY_HTTPS=1 (mkcert). The self-signed cert is accepted by trustDelegate.
    private var secure: Bool = false

    private var session: URLSession
    private let trustDelegate = RelayTrustDelegate()
    private var task: URLSessionWebSocketTask?

    private var running = false
    private var connected = false
    private var backoffMs: Double = PoseRelayClient.backoffStartMs
    private var reconnectTask: Task<Void, Never>?
    /// Monotonic ms when the socket was confirmed connected; 0 if not connected.
    private var connectedAt: Double = 0

    private var lastSendT: Double = 0
    // Rolling 1s window of send timestamps (ms) for the displayed send-FPS.
    private var sendTimes: [Double] = []

    // Heartbeat bookkeeping for the CURRENT connection: pings sent vs pongs
    // received. The loop fails the connection when a ping goes unanswered for
    // a full interval (pongsReceived lags pingsSent at the next tick).
    private var pingsSent = 0
    private var pongsReceived = 0

    init(status: RelayStatus) {
        self.status = status
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = false
        config.timeoutIntervalForRequest = 10
        // A delegate is needed so wss:// to the user's self-signed dev relay is
        // accepted (see RelayTrustDelegate). Plain ws:// ignores it.
        self.session = URLSession(configuration: config, delegate: trustDelegate, delegateQueue: nil)
    }

    // MARK: - Lifecycle

    /// Begin connecting to ws(s)://<host>:8082 and announce as `source`.
    /// Safe to call repeatedly; updates target and (re)connects.
    func start(host: String, source: String, secure: Bool) {
        self.host = host.trimmingCharacters(in: .whitespacesAndNewlines)
        self.source = source.isEmpty ? "iphone-arkit" : source
        self.secure = secure
        guard !running else {
            // Already running: just re-announce on the live socket if open.
            sendHello()
            return
        }
        running = true
        backoffMs = Self.backoffStartMs
        openSocket()
    }

    /// Update the source label mid-session and re-announce (matches the browser
    /// re-sending hello when the source field changes).
    func updateSource(_ source: String) {
        self.source = source.isEmpty ? "iphone-arkit" : source
        sendHello()
    }

    /// Stop streaming, cancel the socket, and stop reconnecting.
    func stop() {
        running = false
        connected = false
        connectedAt = 0
        reconnectTask?.cancel()
        reconnectTask = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        sendTimes.removeAll()
        Task { @MainActor in
            status.phase = .offline
            status.sendFps = 0
            status.lastError = nil
            status.lastHint = nil
            status.target = nil
        }
    }

    // MARK: - Socket

    private func relayURL() -> URL? {
        // Plain ws over LAN by default (native apps aren't browser-sandboxed);
        // wss when the dev relay serves TLS (XRUNWAY_HTTPS=1 / mkcert).
        let scheme = secure ? "wss" : "ws"
        return URL(string: "\(scheme)://\(host):\(Self.relayPort)")
    }

    private func openSocket() {
        guard running else { return }
        guard let url = relayURL() else {
            Task { @MainActor in status.lastError = "Invalid address — enter the receiver's Wi-Fi IP." }
            scheduleReconnect()
            return
        }
        connected = false
        let targetStr = url.absoluteString
        Task { @MainActor in
            status.phase = .connecting
            status.lastError = nil
            status.lastHint = nil
            status.target = targetStr
        }
        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        // Announce immediately; the frame is buffered until the handshake opens.
        sendHello()
        receiveLoop(on: task)
        // No delegate is wired for open/close events, so "open" is proven the
        // honest way: a protocol-level ping must come back as a pong. Only a
        // live WS server pongs — a black-holed dial, a captive portal, or a
        // non-WS listener can't — so the UI stays "Connecting…" until then
        // (and the watchdog below turns a silent dial into a visible timeout).
        confirmConnectionSoon(task)
    }

    /// After resuming, send a lightweight ping to confirm the socket actually
    /// opened. Pong -> connected (and the heartbeat keeps re-proving it);
    /// failure -> reconnect.
    private func confirmConnectionSoon(_ task: URLSessionWebSocketTask) {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await task.sendPingAsync()
                await self.markConnected(via: task)
            } catch {
                await self.failCurrent(task, with: error)
            }
        }
        // Watchdog: URLSessionWebSocketTask does NOT reliably honor
        // timeoutIntervalForRequest, so a silently-dropped connection (wrong IP,
        // different subnet, AP client-isolation) can hang on "Connecting…"
        // forever. Force a timeout so the UI surfaces the diagnostic + retries.
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.connectTimeoutMs) * 1_000_000)
            guard let self else { return }
            await self.failIfStillConnecting(task)
        }
    }

    private func failIfStillConnecting(_ task: URLSessionWebSocketTask) {
        guard running, self.task === task, !connected else { return }
        // Clean message, but keep the .timedOut code so hint(for:) still maps it.
        let err = NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut,
                          userInfo: [NSLocalizedDescriptionKey: "Couldn’t reach the relay (timed out)."])
        handleFailure(err)
    }

    private func markConnected(via task: URLSessionWebSocketTask) {
        // Keyed to the task whose pong actually came back: a late pong from a
        // torn-down attempt must not flip a newer, still-dialing attempt (or a
        // stopped client) to "Connected".
        guard isCurrent(task), !connected else { return }
        connected = true
        // NB: do NOT reset backoff here — a successful ping only proves the
        // handshake opened, not that the relay will keep us. Backoff is reset in
        // handleFailure only if the socket actually survived (see stableResetMs).
        connectedAt = Self.monoMs()
        Task { @MainActor in
            status.phase = .connected
            status.lastError = nil
            status.lastHint = nil
            status.target = nil
        }
        // Re-send hello now that we know the channel is open.
        sendHello()
        // Keep proving the relay is there — "Connected" decays into a lie the
        // moment the peer vanishes without a close (no FIN/RST reaches us when
        // the machine changes networks or sleeps).
        startPingLoop(on: task)
    }

    // MARK: - Heartbeat

    /// Re-proves liveness for as long as `task` is the current connection.
    /// Every pingIntervalMs: if the previous ping is still unanswered, the peer
    /// is gone — demote and reconnect; otherwise send the next ping.
    private func startPingLoop(on task: URLSessionWebSocketTask) {
        pingsSent = 0
        pongsReceived = 0
        Task { [weak self] in
            while true {
                try? await Task.sleep(nanoseconds: UInt64(Self.pingIntervalMs) * 1_000_000)
                guard let self else { return }
                guard await self.heartbeat(task) else { return }
            }
        }
    }

    /// One heartbeat tick. Returns false when the loop must stop (socket
    /// replaced, stopped, or just demoted).
    private func heartbeat(_ task: URLSessionWebSocketTask) -> Bool {
        guard isCurrent(task), connected else { return false }
        guard pongsReceived >= pingsSent else {
            // The relay had a full interval to answer the last ping. A live WS
            // endpoint pongs from the framework up, so silence means nothing is
            // listening anymore — stop lying and reconnect.
            let err = NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut,
                              userInfo: [NSLocalizedDescriptionKey: "The receiver stopped answering (ping timed out)."])
            handleFailure(err)
            return false
        }
        pingsSent += 1
        Task { [weak self] in
            do {
                try await task.sendPingAsync()
                await self?.notePong(on: task)
            } catch {
                await self?.failCurrent(task, with: error)
            }
        }
        return true
    }

    private func notePong(on task: URLSessionWebSocketTask) {
        guard isCurrent(task) else { return }
        pongsReceived += 1
    }

    /// handleFailure, keyed to the task that failed: late errors surfacing from
    /// an already-replaced attempt (cancelled pings/sends of a torn-down socket)
    /// must not clobber the current attempt's state or diagnostics.
    private func failCurrent(_ task: URLSessionWebSocketTask, with error: Error) {
        guard self.task === task else { return }
        handleFailure(error)
    }

    private func receiveLoop(on task: URLSessionWebSocketTask) {
        Task { [weak self] in
            guard let self else { return }
            while await self.isCurrent(task) {
                do {
                    // We ignore inbound payloads (the relay only echoes peers),
                    // but receiving keeps the task alive and surfaces closes.
                    _ = try await task.receive()
                } catch {
                    await self.failCurrent(task, with: error)
                    return
                }
            }
        }
    }

    private func isCurrent(_ task: URLSessionWebSocketTask) -> Bool {
        running && self.task === task
    }

    private func handleFailure(_ error: Error) {
        guard running else { return }
        // Ignore self-inflicted cancellations (we cancel the task inside this very
        // method, and the receive loop then reports `.cancelled`) so they don't
        // clobber the real diagnostic that triggered the teardown.
        if (error as? URLError)?.code == .cancelled { return }
        connected = false
        // Only fast-retry if the connection had been stable for a while; a socket
        // that drops right after connecting keeps escalating backoff.
        if connectedAt > 0, Self.monoMs() - connectedAt >= Self.stableResetMs {
            backoffMs = Self.backoffStartMs
        }
        connectedAt = 0
        // Zero the SENDING badge with the phase — a frozen "30/s" over an
        // offline pill is the same lie as a stale "Connected".
        sendTimes.removeAll()
        let desc = (error as NSError).localizedDescription
        let tip = Self.hint(for: error)
        Task { @MainActor in
            status.phase = .offline
            status.sendFps = 0
            status.lastError = desc
            status.lastHint = tip
        }
        task?.cancel(with: .abnormalClosure, reason: nil)
        task = nil
        scheduleReconnect()
    }

    /// Map a connection failure to a one-line, plain-language fix suggestion so a
    /// failed test is self-diagnosing (unreachable vs port closed vs TLS/scheme).
    nonisolated private static func hint(for error: Error) -> String? {
        guard let e = error as? URLError else { return nil }
        // A denied Local Network permission surfaces as DIFFERENT URLErrors
        // depending on iOS version and timing (fast host-unreachable on modern
        // iOS, a silent timeout only while the very first prompt is pending),
        // so every connection-failure hint carries the pointer — keying it to
        // .timedOut alone would misdirect the most common denial path.
        let localNet = "Check Local Network is allowed (Settings > Privacy & Security > Local Network)."
        switch e.code {
        case .cannotConnectToHost:
            return "Nothing answered at port \(relayPort) — start (X)RUNWAY on the computer first. \(localNet)"
        case .timedOut:
            return "No response — check the address and that both devices share the same Wi-Fi (campus/guest Wi-Fi often blocks device-to-device). \(localNet)"
        case .cannotFindHost:
            return "Address not found — double-check the receiver address."
        case .notConnectedToInternet, .networkConnectionLost:
            return "Network dropped — reconnect Wi-Fi and retry. \(localNet)"
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
             .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected:
            return "Secure connection failed — flip SECURE CONNECTION to match the receiver."
        default:
            return "Try flipping SECURE CONNECTION — it must match the receiver."
        }
    }

    private func scheduleReconnect() {
        guard running, reconnectTask == nil else { return }
        let delayMs = backoffMs
        backoffMs = min(backoffMs * 2, Self.backoffMaxMs)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delayMs * 1_000_000))
            guard let self else { return }
            await self.clearReconnect()
            await self.openSocket()
        }
    }

    private func clearReconnect() {
        reconnectTask = nil
    }

    // MARK: - Sending

    private func sendHello() {
        guard let task else { return }
        let hello = HelloMessage(source: source)
        guard let data = try? JSONEncoder().encode(hello),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { [weak self] error in
            if let error { Task { await self?.failCurrent(task, with: error) } }
        }
    }

    /// Enqueue a frame for the relay, honoring the <=30/s throttle. Called from
    /// the capture pipeline at camera/AR rate (up to 60 Hz); excess is dropped.
    func send(frame: PoseFrame) {
        guard running, connected, let task else { return }
        // Throttle + FPS on a MONOTONIC clock; frame.t is the wall clock (Date)
        // and can step backward (NTP / user clock change), which would freeze the
        // whole stream. frame.t stays the payload timestamp only.
        let now = Self.monoMs()
        if now - lastSendT < Self.sendIntervalMs { return }
        lastSendT = now
        guard !frame.keypoints.isEmpty else { return }

        let message = PoseMessage(frame: frame)
        guard let data = try? JSONEncoder().encode(message),
              let text = String(data: data, encoding: .utf8) else { return }

        task.send(.string(text)) { [weak self] error in
            if let error {
                Task { await self?.failCurrent(task, with: error) }
            } else {
                // Count the frame only when its send COMPLETED cleanly, so the
                // SENDING badge reflects frames handed to the transport, not
                // frames merely enqueued on a possibly-dead task. (TCP can
                // still buffer briefly on a dying link — the heartbeat is what
                // bounds that window and then zeroes the badge.)
                Task { await self?.noteSent() }
            }
        }
    }

    private func noteSent() {
        guard connected else { return }
        trackSendRate(Self.monoMs())
    }

    private func trackSendRate(_ nowMs: Double) {
        sendTimes.append(nowMs)
        let cutoff = nowMs - 1000
        while let first = sendTimes.first, first < cutoff {
            sendTimes.removeFirst()
        }
        let fps = sendTimes.count
        Task { @MainActor in status.sendFps = fps }
    }
}

// MARK: - Dev TLS trust

/// Accepts the relay's TLS server trust so the app can dial **wss://** to the
/// user's own Mac running the dev relay with a self-signed / mkcert certificate
/// (which the system would otherwise reject). This is intentionally permissive
/// because the relay is a LAN dev endpoint the user reaches by typing its IP —
/// for a shipping product you would pin the relay's certificate instead.
/// Plain ws:// never triggers this (no TLS handshake).
final class RelayTrustDelegate: NSObject, URLSessionDelegate {
    func urlSession(_ session: URLSession,
                    didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}

// MARK: - Async ping

private extension URLSessionWebSocketTask {
    /// Async wrapper over the callback-based `sendPing(pongReceiveHandler:)`.
    /// `URLSessionWebSocketTask` has no built-in `async` overload of `sendPing`,
    /// so we bridge it. A returned pong is proof a live WS server holds the
    /// socket; used to confirm the connection opened AND by the heartbeat that
    /// keeps re-proving it (a dead peer's handler may simply never fire, which
    /// the heartbeat reads as pongsReceived lagging pingsSent).
    ///
    /// The handler is NOT guaranteed to fire exactly once: when the task is
    /// cancelled with a ping still outstanding (watchdog / heartbeat demote,
    /// i.e. exactly the dead-relay paths), URLSession has been observed calling
    /// the pongReceiveHandler twice — which double-resumes a bare continuation
    /// and traps (witnessed as a SIGTRAP in CheckedContinuation.resume while
    /// reproducing the dead-relay scenario in the Simulator, 2026-07-02).
    /// The Mutex gate resumes on the first fire only.
    func sendPingAsync() async throws {
        let resumed = Mutex(false)
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            self.sendPing { error in
                let first = resumed.withLock { done -> Bool in
                    if done { return false }
                    done = true
                    return true
                }
                guard first else { return }
                if let error {
                    cont.resume(throwing: error)
                } else {
                    cont.resume()
                }
            }
        }
    }
}
