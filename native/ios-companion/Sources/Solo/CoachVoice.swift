//
//  CoachVoice.swift
//  (X)RUNWAY iOS Companion — Solo mode (SOLO-MODE §5 / A2 / A3)
//
//  The DELIVERY layer for on-device voice coaching: speaks a decided LiveCue
//  with its earcon lead-in, plays the countdown ticks and the GO sting, and
//  says plain prompts. A Swift port of src/coach-voice.ts, adapted to
//  AVFoundation per docs/SOLO-MODE.md ("coach-voice.ts — delivery" and
//  "Haptics and TTS precedent"). The earcon RECIPES are NOT re-declared here
//  — they come from XRunwayCore (COACH_EARCONS / COACH_EARCON_LEVEL,
//  vector-locked table data); this file only synthesizes and schedules.
//
//  Laws carried over from coach-voice.ts (each review-adjudicated there):
//  - NEVER QUEUE: every delivery cancels anything in flight first
//    (coach-voice.ts:16-18,201). The policy's 9 s cooldown makes overlap
//    near-impossible; this makes it impossible.
//  - EARCON LEAD-IN: the earcon plays immediately, the words follow 150 ms
//    later so the trainee's ear is already listening (coach-voice.ts:55-56).
//  - EARCON IS THE GUARANTEED CHANNEL: the recipes are contour-coded per
//    kind so an earcon-only delivery still coaches learnably — a speech
//    failure must never take the earcon with it (coach-voice.ts:5-9,225-227).
//  - STALE EVENTS ARE DEAD EVENTS: AVSpeechSynthesizerDelegate callbacks
//    (didFinish/didCancel) land asynchronously AFTER cancel() returns — by
//    which time the next delivery may own the session. Every async handler
//    carries a generation token; cancel() bumps it, so a dead utterance's
//    late events can never touch the successor's state
//    (coach-voice.ts:29-35,64-68).
//  - WATCHDOG: a 10 s hard stop covers engines that never fire a delegate
//    callback — on iOS that is a call/Siri killing the utterance without a
//    clean end (coach-voice.ts:61-62,255-267). Generation-gated like
//    everything else.
//  - RATE SCALE: AVSpeechUtterance.rate is 0..1 with
//    AVSpeechUtteranceDefaultSpeechRate (~0.5) = normal, so "slightly brisk"
//    is a SMALL bump above the default constant — NOT the web's 1.05
//    multiplier and NOT 1.0 (maximum) (SOLO-MODE porting note).
//
//  iOS-specific decisions (the SOLO-MODE risk items, resolved):
//  - AUDIO SESSION: category .playback with .duckOthers — the founder call:
//    the hardware silent switch does NOT silence a coach the trainee
//    explicitly enabled; the in-app `enabled` toggle is THE mute; the
//    trainee's own Spotify ducks under a cue and recovers on the
//    .notifyOthersOnDeactivation wind-down. The session activates lazily on
//    the first sound and deactivates a short grace after the last one.
//  - INTERRUPTIONS: on AVAudioSession .began, cancel() — a spoken-but-unheard
//    cue stays SPENT (the policy already consumed its per-kind budget;
//    re-firing risks nagging — the v1 decision).
//  - EARCON SYNTHESIS: contour-equivalence is the contract, not
//    bit-exactness (SOLO-MODE §5). Each recipe is pre-rendered ONCE at init
//    into an AVAudioPCMBuffer (pure math, deterministic) and played through
//    a single AVAudioEngine + AVAudioPlayerNode. COACH_EARCON_LEVEL is a
//    relative shape against the web SFX master (0.5) — re-anchored here, not
//    copied blindly: tick sits just under the coach earcon, the GO sting
//    just above, exactly the web's 0.14 / 0.16 / 0.18 ladder.
//

import Foundation
import AVFoundation
import XRunwayCore

/// Speaks coach cues, countdown beats and plain prompts for a Solo walk.
/// All state is main-actor; the AVFoundation callbacks hop back here through
/// a small nonisolated relay carrying the delivery generation.
@MainActor
final class CoachVoice {

    // MARK: - Tuning constants (web receipts cited per value)

    /// Earcon leads the words so the trainee's ear is already listening
    /// (coach-voice.ts EARCON_LEAD_MS = 150).
    private static let earconLeadSec: Double = 0.15
    /// Hard stop for a synthesizer that never fires a delegate callback
    /// (coach-voice.ts SPEECH_WATCHDOG_MS = 10000).
    private static let speechWatchdogSec: Double = 10
    /// Grace after the last sound before the audio session deactivates and
    /// other apps' audio un-ducks (descendant of the web's 1200 ms
    /// earcon-only wind-down).
    private static let sessionGraceSec: Double = 1.2
    /// "Slightly brisk": a SMALL bump over the platform default — the port of
    /// the web's 1.05 multiplier onto AVFoundation's absolute 0..1 scale.
    private static let speechRate: Float = min(
        AVSpeechUtteranceDefaultSpeechRate + 0.04,
        AVSpeechUtteranceMaximumSpeechRate
    )

    /// Comfortable absolute master the relative earcon levels scale against.
    /// The web anchors them to SFX_MASTER_LEVEL = 0.5; there is no music
    /// engine on the phone, so the same anchor is a sane absolute choice.
    private static let masterLevel: Double = 0.5
    /// Countdown tick: one short blip at G6, slightly UNDER the coach earcon
    /// (the web's tick sits at 0.14 vs COACH_EARCON_LEVEL 0.16).
    private static let tickHz: Double = 1567.98
    private static let tickDecaySec: Double = 0.07
    private static let tickLevel: Double = 0.14
    /// GO sting: a rising two-note figure (G5 -> C6), slightly ABOVE the
    /// coach earcon (the web's pose sting sits at 0.18).
    private static let goNotes: (Double, Double) = (783.99, 1046.50)
    private static let goSpanSec: Double = 0.11
    private static let goDecaySec: Double = 0.12
    private static let goLevel: Double = 0.18

    /// Offline render format: 44.1 kHz mono Float32 (the player node is
    /// connected with this same format; the mixer resamples to hardware).
    private static let renderSampleRateHz: Double = 44100
    /// Web envelope shapes (coach-voice.ts playEarcon): 4 ms blip attack,
    /// 12 ms glide attack, exponential decay to the 0.0001 gain floor.
    private static let blipAttackSec: Double = 0.004
    private static let glideAttackSec: Double = 0.012
    private static let gainFloor: Double = 0.0001
    /// Silent tail on every rendered buffer so the exponential floor never
    /// clicks at the buffer edge.
    private static let renderTailSec: Double = 0.05

    // MARK: - Public state

    /// The in-app coach toggle — THE mute (SOLO-MODE audio-session law: the
    /// hardware silent switch is deliberately ignored by .playback; this
    /// flag is what silences the coach). Read live at every delivery; when
    /// false, nothing sounds: no earcon, no speech.
    var enabled: Bool = true

    // MARK: - Private state

    private let synthesizer = AVSpeechSynthesizer()
    /// Nonisolated NSObject relay: AVSpeechSynthesizer delegate + audio
    /// session interruption observer. Holds `owner` weakly — no cycle.
    private let relay = CoachVoiceEventRelay()

    /// ONE engine instance for every earcon (SOLO-MODE porting note); the
    /// buffers are scheduled on one player node attached at init. `var`, not
    /// `let`: a media-services reset invalidates the whole graph, and the
    /// only recovery is a rebuild (mediaServicesWereReset below).
    private var engine = AVAudioEngine()
    private var player = AVAudioPlayerNode()
    /// The render format the graph is wired in (nil only if AVAudioFormat
    /// construction failed at init — then earcons are silently absent).
    private let renderFormat: AVAudioFormat?

    /// Pre-rendered earcon per LiveCueKind rawValue (from COACH_EARCONS).
    private let cueBuffers: [String: AVAudioPCMBuffer]
    private let tickBuffer: AVAudioPCMBuffer?
    private let goBuffer: AVAudioPCMBuffer?

    /// Delivery generation: bumped by every cancel(), captured by every
    /// async continuation (pending speech, watchdog, wind-down, delegate
    /// events). A mismatch = the delivery was cancelled and the event is
    /// dead (the coach-voice.ts night-review #3 law).
    private var generation = 0
    /// The 150 ms earcon-lead timer (never outlives cancel()).
    private var pendingSpeak: Task<Void, Never>? = nil
    /// The 10 s speech hard-stop (never outlives cancel()).
    private var watchdog: Task<Void, Never>? = nil
    /// The post-sound session wind-down grace timer. Generation-gated AND
    /// cancelled by the next activation — it may be replaced by cancel(),
    /// never left running into a new delivery.
    private var windDown: Task<Void, Never>? = nil

    /// True while OUR activation of the shared audio session stands.
    private var sessionActive = false
    /// Category configured once (retried until it succeeds).
    private var sessionConfigured = false
    /// Cached en-US voice; a nil lookup just retries at the next delivery
    /// (the web's pickVoice cache semantics).
    private var voiceCache: AVSpeechSynthesisVoice? = nil

    // MARK: - Init

    /// Pre-renders every earcon (pure math, deterministic) and wires the
    /// engine graph + delegate/interruption plumbing. Nothing touches the
    /// audio session here — activation is lazy on the first sound.
    init() {
        let format = AVAudioFormat(
            standardFormatWithSampleRate: Self.renderSampleRateHz, channels: 1
        )

        var cues: [String: AVAudioPCMBuffer] = [:]
        var tick: AVAudioPCMBuffer? = nil
        var go: AVAudioPCMBuffer? = nil
        if let format {
            let cuePeak = COACH_EARCON_LEVEL * Self.masterLevel
            for (key, spec) in COACH_EARCONS {
                let buf = spec.glide
                    ? Self.renderGlide(
                        notes: spec.notes, span: spec.span, decay: spec.decay,
                        peak: cuePeak, format: format)
                    : Self.renderBlipPair(
                        notes: spec.notes, span: spec.span, decay: spec.decay,
                        peak: cuePeak, format: format)
                if let buf { cues[key] = buf }
            }
            tick = Self.renderSingleBlip(
                freq: Self.tickHz, decay: Self.tickDecaySec,
                peak: Self.tickLevel * Self.masterLevel, format: format)
            go = Self.renderBlipPair(
                notes: Self.goNotes, span: Self.goSpanSec,
                decay: Self.goDecaySec,
                peak: Self.goLevel * Self.masterLevel, format: format)
        }
        cueBuffers = cues
        tickBuffer = tick
        goBuffer = go
        renderFormat = format

        wireEngineGraph()

        relay.owner = self
        synthesizer.delegate = relay
        // Selector-based observers: auto-unregistered when the relay deallocs
        // (retained only by this object), so no deinit bookkeeping.
        NotificationCenter.default.addObserver(
            relay,
            selector: #selector(CoachVoiceEventRelay.audioSessionInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance()
        )
        // A media-server crash invalidates the session config AND the engine
        // graph. Without this observer the coach would silently lose the
        // .playback category (the ring switch would start muting it — the
        // founder-call law) and every future earcon (engine.start() throws
        // forever) until app relaunch (review finding).
        NotificationCenter.default.addObserver(
            relay,
            selector: #selector(CoachVoiceEventRelay.audioSessionMediaReset(_:)),
            name: AVAudioSession.mediaServicesWereResetNotification,
            object: AVAudioSession.sharedInstance()
        )
    }

    /// Attach + connect the earcon graph (init, and again after a
    /// media-services reset rebuild).
    private func wireEngineGraph() {
        engine.attach(player)
        if let renderFormat {
            // Player -> main mixer in the render format; the mixer owns the
            // resample to whatever the hardware runs (usually 48 kHz).
            engine.connect(player, to: engine.mainMixerNode, format: renderFormat)
        }
    }

    // MARK: - Public interface

    /// A decided mid-walk cue: earcon lead-in, then the spoken line 150 ms
    /// later. Never queues — cancels anything in flight first. If speech
    /// fails, the earcon has already played (the guaranteed channel).
    func speakCue(_ cue: LiveCue) {
        cancel() // never queue
        guard enabled else { return } // THE mute — no earcon, no speech
        let gen = generation
        ensureSessionActive()
        play(cueBuffers[cue.kind.rawValue]) // earcon first, unconditionally
        scheduleSpeech(cue.text, gen: gen)
    }

    /// Countdown beat (n = 3, 2, 1): a short tick earcon + the spoken
    /// number. Reuses the earcon-lead law so the tick lands clean before the
    /// word; other n values speak the digit.
    func countdownTick(_ n: Int) {
        cancel()
        guard enabled else { return }
        let gen = generation
        ensureSessionActive()
        play(tickBuffer)
        scheduleSpeech(Self.countdownWord(n), gen: gen)
    }

    /// The walk-start beat: a rising sting + "Go."
    func go() {
        cancel()
        guard enabled else { return }
        let gen = generation
        ensureSessionActive()
        play(goBuffer)
        scheduleSpeech("Go.", gen: gen)
    }

    /// A plain spoken prompt (no earcon, no lead-in), e.g. positioning
    /// instructions. Cancels anything in flight first.
    func say(_ line: String) {
        cancel()
        guard enabled else { return }
        let gen = generation
        ensureSessionActive()
        speakNow(line, gen: gen)
    }

    /// Cancel anything in flight: the pending speech timer, the live
    /// utterance, the watchdog, a playing earcon. Phase exits call this — a
    /// summary must never carry a stale mid-utterance correction (the web's
    /// cancelCoachVoice-on-phase-exit law). Bumps the generation FIRST so
    /// every in-flight handler is orphaned before stopSpeaking can fire its
    /// didCancel.
    func cancel() {
        generation &+= 1
        pendingSpeak?.cancel()
        pendingSpeak = nil
        watchdog?.cancel()
        watchdog = nil
        synthesizer.stopSpeaking(at: .immediate)
        if engine.isRunning {
            player.stop() // silence a mid-flight earcon too
        }
        // Nothing sounds after a cancel — release the session (and other
        // apps' ducking) after the grace unless a new delivery re-arms.
        scheduleSessionWindDown()
    }

    // MARK: - Speech internals

    /// Speak `text` after the earcon lead (the web's pendingSpeak timer).
    /// The task carries this delivery's generation; cancel() both cancels
    /// the task and orphans it via the token — belt and braces.
    private func scheduleSpeech(_ text: String, gen: Int) {
        pendingSpeak = Task { [weak self] in
            try? await Task.sleep(
                nanoseconds: UInt64(Self.earconLeadSec * 1_000_000_000))
            guard !Task.isCancelled, let self, gen == self.generation else {
                return
            }
            self.pendingSpeak = nil
            self.speakNow(text, gen: gen)
        }
    }

    /// Hand one utterance to the synthesizer and arm the watchdog. Failure
    /// here can never take the earcon back — it already played.
    private func speakNow(_ text: String, gen: Int) {
        synthesizer.stopSpeaking(at: .immediate) // belt + braces: queue empty
        let u = GenUtterance(string: text)
        u.gen = gen
        u.rate = Self.speechRate
        u.volume = 1.0 // in-app gain law is the boolean `enabled`; the system
                       // volume owns the rest (no separate voice slider — #6)
        if let voice = pickVoice() {
            u.voice = voice
        } // nil -> the system default voice speaks (always exists on iOS)
        synthesizer.speak(u)
        armWatchdog(gen: gen)
    }

    /// Hard stop for engines that never fire didFinish/didCancel (a call or
    /// Siri can kill an utterance without a clean callback). Generation-
    /// gated: a newer delivery owns the synthesizer by the time a stale
    /// watchdog fires.
    private func armWatchdog(gen: Int) {
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            try? await Task.sleep(
                nanoseconds: UInt64(Self.speechWatchdogSec * 1_000_000_000))
            guard !Task.isCancelled, let self, gen == self.generation else {
                return
            }
            self.watchdog = nil
            self.synthesizer.stopSpeaking(at: .immediate)
            self.scheduleSessionWindDown()
        }
    }

    /// A neutral en-US voice, cached once found; nil just retries next time
    /// (the web pickVoice semantics — on iOS the lookup is one call).
    private func pickVoice() -> AVSpeechSynthesisVoice? {
        if let v = voiceCache { return v }
        voiceCache = AVSpeechSynthesisVoice(language: "en-US")
        return voiceCache
    }

    /// Spoken countdown numbers: the 3/2/1 words; any other n speaks the
    /// digit (defensive — the engine only sends 3, 2, 1).
    private static func countdownWord(_ n: Int) -> String {
        switch n {
        case 3: return "Three"
        case 2: return "Two"
        case 1: return "One"
        default: return String(n)
        }
    }

    // MARK: - Earcon playback

    /// Play one pre-rendered buffer through the shared engine. Requires the
    /// session to be active (ensureSessionActive ran first); if the engine
    /// cannot start, the earcon is skipped and speech still goes out — the
    /// exact web fallback shape, mirrored (there: no AudioContext, speech
    /// independent; here: no engine, synthesizer independent).
    private func play(_ buffer: AVAudioPCMBuffer?) {
        guard let buffer, sessionActive else { return }
        if !engine.isRunning {
            do {
                try engine.start()
            } catch {
                return // earcon skipped; the spoken line still delivers
            }
        }
        player.stop() // never queue applies to earcons too
        player.scheduleBuffer(buffer, completionHandler: nil)
        player.play()
    }

    // MARK: - Audio session lifecycle

    /// Activate the shared session lazily on the first sound (the web's
    /// "never create the AudioContext outside the gesture chain" maps to
    /// "never activate outside a delivery"). Cancels any pending wind-down:
    /// a new sound re-arms the session before the grace expires.
    @discardableResult
    private func ensureSessionActive() -> Bool {
        windDown?.cancel()
        windDown = nil
        if sessionActive { return true }
        let session = AVAudioSession.sharedInstance()
        do {
            if !sessionConfigured {
                // .playback: the silent switch does NOT mute an explicitly
                // enabled coach. .duckOthers: the trainee's own music dips
                // under a cue and recovers on deactivation.
                try session.setCategory(.playback, options: [.duckOthers])
                sessionConfigured = true
            }
            try session.setActive(true)
            sessionActive = true
            return true
        } catch {
            return false // no route — this delivery's earcon is skipped;
                         // speech is still attempted (synthesizer may cope)
        }
    }

    /// Deactivate a short grace after the last sound so back-to-back beats
    /// (countdown ticks are 1 s apart) never thrash the session, then let
    /// other apps' audio recover (.notifyOthersOnDeactivation). Generation-
    /// gated AND cancelled by every new activation.
    private func scheduleSessionWindDown() {
        guard sessionActive else { return }
        windDown?.cancel()
        let gen = generation
        windDown = Task { [weak self] in
            try? await Task.sleep(
                nanoseconds: UInt64(Self.sessionGraceSec * 1_000_000_000))
            guard !Task.isCancelled, let self, gen == self.generation else {
                return
            }
            self.windDown = nil
            self.deactivateSessionNow()
        }
    }

    /// Stop the engine and give the session back. Failures are non-fatal:
    /// `sessionActive` drops regardless so the next delivery re-activates
    /// cleanly (setActive(true) on an already-active session is harmless).
    private func deactivateSessionNow() {
        guard sessionActive else { return }
        if engine.isRunning {
            player.stop()
        }
        engine.stop() // the engine must not be running when we deactivate
        do {
            try AVAudioSession.sharedInstance().setActive(
                false, options: [.notifyOthersOnDeactivation])
        } catch {
            // e.g. an utterance tail still draining — non-fatal; the flag
            // drop below means the next delivery simply re-activates.
        }
        sessionActive = false
    }

    // MARK: - Event plumbing (relay entry points, main-actor)

    /// didFinish/didCancel for ONE utterance, identified by its generation.
    /// Stale events (a cancelled utterance's late callback) are dead events.
    fileprivate func utteranceEnded(gen: Int) {
        guard gen == generation else { return }
        watchdog?.cancel()
        watchdog = nil
        scheduleSessionWindDown()
    }

    /// AVAudioSession interruption .began (call, Siri): the system already
    /// silenced and deactivated us. A spoken-but-unheard cue stays SPENT —
    /// the policy consumed its budget; re-firing risks nagging (v1 decision).
    fileprivate func interruptionBegan() {
        sessionActive = false // the system deactivated the session for us
        cancel() // orphans handlers; cancel()'s wind-down stays inert (the
                 // sessionActive guard) and its player.stop() is engine-
                 // running-gated, so a system-halted engine is never poked
        engine.stop()
        // No .ended handling: the next delivery lazily re-activates.
    }

    /// mediaServicesWereReset: the media server crashed and came back. The
    /// old engine graph is dead (start() would throw forever) and the
    /// session lost its category. Rebuild both so the next delivery is
    /// whole: category re-applies (sessionConfigured drops), the graph is
    /// recreated, and anything in flight is spent (Apple's required
    /// handling; review finding).
    fileprivate func mediaServicesWereReset() {
        sessionActive = false
        sessionConfigured = false
        cancel()
        engine = AVAudioEngine()
        player = AVAudioPlayerNode()
        wireEngineGraph()
    }

    // MARK: - Offline earcon rendering (pure math, runs once at init)

    /// Allocate a zero-filled mono Float32 buffer of `seconds`.
    private static func makeBuffer(
        seconds: Double, format: AVAudioFormat
    ) -> AVAudioPCMBuffer? {
        let frames = AVAudioFrameCount((seconds * renderSampleRateHz).rounded(.up))
        guard frames > 0,
            let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames),
            let channels = buf.floatChannelData
        else { return nil }
        buf.frameLength = frames
        channels[0].update(repeating: 0, count: Int(frames))
        return buf
    }

    /// Add one sine blip at `startSec`: ~4 ms linear attack to `peak`, then
    /// exponential decay reaching the gain floor `decaySec` after onset —
    /// the web envelope (coach-voice.ts:177-185), additive so overlapping
    /// blips sum like overlapping oscillators.
    private static func addBlip(
        into samples: UnsafeMutablePointer<Float>, frames: Int,
        startSec: Double, freq: Double, decaySec: Double, peak: Double
    ) {
        let startFrame = max(Int(startSec * renderSampleRateHz), 0)
        let endFrame = min(
            frames, Int((startSec + decaySec) * renderSampleRateHz))
        let decaySpan = max(decaySec - blipAttackSec, 0.001)
        let floorRatio = gainFloor / max(peak, gainFloor)
        var frame = startFrame
        while frame < endFrame {
            let t = Double(frame) / renderSampleRateHz - startSec
            let env: Double
            if t < blipAttackSec {
                env = peak * (t / blipAttackSec)
            } else {
                env = peak * pow(floorRatio, (t - blipAttackSec) / decaySpan)
            }
            samples[frame] += Float(env * sin(2 * .pi * freq * t))
            frame += 1
        }
    }

    /// Blip pair: two sine blips `span` seconds apart (the second at
    /// notes.1 — center-up repeats the same pitch), each with the blip
    /// envelope above. Also renders the GO sting (a rising pair).
    private static func renderBlipPair(
        notes: (Double, Double), span: Double, decay: Double, peak: Double,
        format: AVAudioFormat
    ) -> AVAudioPCMBuffer? {
        let total = span + decay + renderTailSec
        guard let buf = makeBuffer(seconds: total, format: format),
            let channels = buf.floatChannelData
        else { return nil }
        let n = Int(buf.frameLength)
        addBlip(
            into: channels[0], frames: n, startSec: 0, freq: notes.0,
            decaySec: decay, peak: peak)
        addBlip(
            into: channels[0], frames: n, startSec: span, freq: notes.1,
            decaySec: decay, peak: peak)
        return buf
    }

    /// One short blip — the countdown tick.
    private static func renderSingleBlip(
        freq: Double, decay: Double, peak: Double, format: AVAudioFormat
    ) -> AVAudioPCMBuffer? {
        let total = decay + renderTailSec
        guard let buf = makeBuffer(seconds: total, format: format),
            let channels = buf.floatChannelData
        else { return nil }
        addBlip(
            into: channels[0], frames: Int(buf.frameLength), startSec: 0,
            freq: freq, decaySec: decay, peak: peak)
        return buf
    }

    /// Glide: ONE sine voice whose frequency ramps notes.0 -> notes.1 over
    /// `span` (then holds), gain floor -> peak in ~12 ms, exponential decay
    /// reaching the floor at span + decay — the web's posture swoop
    /// (coach-voice.ts:158-170). Phase is the integral of the linear
    /// frequency ramp so the sweep is click-free.
    private static func renderGlide(
        notes: (Double, Double), span: Double, decay: Double, peak: Double,
        format: AVAudioFormat
    ) -> AVAudioPCMBuffer? {
        let total = span + decay + renderTailSec
        guard span > 0,
            let buf = makeBuffer(seconds: total, format: format),
            let channels = buf.floatChannelData
        else { return nil }
        let samples = channels[0]
        let n = Int(buf.frameLength)
        let envEnd = span + decay
        let decaySpan = max(envEnd - glideAttackSec, 0.001)
        let floorRatio = gainFloor / max(peak, gainFloor)
        let phaseAtSpan =
            2 * Double.pi * (notes.0 * span + (notes.1 - notes.0) * span / 2)
        for i in 0..<n {
            let t = Double(i) / renderSampleRateHz
            if t >= envEnd { break } // zero-filled tail stays silent
            let phase: Double
            if t < span {
                // integral of f(t) = n0 + (n1 - n0) * t / span
                phase = 2 * .pi
                    * (notes.0 * t + (notes.1 - notes.0) * t * t / (2 * span))
            } else {
                phase = phaseAtSpan + 2 * .pi * notes.1 * (t - span)
            }
            let env: Double
            if t < glideAttackSec {
                env = gainFloor + (peak - gainFloor) * (t / glideAttackSec)
            } else {
                env = peak * pow(floorRatio, (t - glideAttackSec) / decaySpan)
            }
            samples[i] = Float(env * sin(phase))
        }
        return buf
    }
}

// MARK: - Nonisolated plumbing

/// An AVSpeechUtterance stamped with the delivery generation it belongs to,
/// so the delegate can hand the token back without any shared lookup table
/// (STALE EVENTS ARE DEAD EVENTS — the token rides the utterance itself).
private final class GenUtterance: AVSpeechUtterance {
    var gen: Int = 0
}

/// Nonisolated relay: AVSpeechSynthesizerDelegate callbacks and the audio
/// session interruption notification arrive on arbitrary threads; this hops
/// them onto the main actor with only Sendable payloads (the generation
/// Int). Holds the owner weakly — CoachVoice retains the relay, never the
/// reverse, so there is no cycle.
private final class CoachVoiceEventRelay: NSObject, AVSpeechSynthesizerDelegate {
    /// Weak: reads of a weak reference are thread-safe.
    weak var owner: CoachVoice?

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance
    ) {
        forwardEnd(utterance)
    }

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didCancel utterance: AVSpeechUtterance
    ) {
        forwardEnd(utterance)
    }

    /// didFinish and didCancel share one path (the web's onend/onerror do
    /// too): report "this utterance is over" with its generation.
    private func forwardEnd(_ utterance: AVSpeechUtterance) {
        guard let gen = (utterance as? GenUtterance)?.gen,
            let owner
        else { return } // a foreign utterance is none of our business
        Task { @MainActor in
            owner.utteranceEnded(gen: gen)
        }
    }

    /// AVAudioSession interruption (call, Siri, another .playback app).
    /// Only .began matters: cancel and stay spent; .ended is ignored — the
    /// next delivery lazily re-activates the session.
    @objc func audioSessionInterruption(_ note: Notification) {
        guard
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            AVAudioSession.InterruptionType(rawValue: raw) == .began,
            let owner
        else { return }
        Task { @MainActor in
            owner.interruptionBegan()
        }
    }

    /// The media server crashed and restarted: category + engine graph are
    /// both gone — the owner rebuilds.
    @objc func audioSessionMediaReset(_ note: Notification) {
        guard let owner else { return }
        Task { @MainActor in
            owner.mediaServicesWereReset()
        }
    }
}
