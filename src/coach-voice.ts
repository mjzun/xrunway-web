/**
 * (X)RUNWAY — live-cue DELIVERY: earcon lead-in + spoken coaching (#20/#48).
 *
 * The thin DOM boundary under coach-live.ts (the pure policy): given a
 * decided LiveCue, play its earcon as the attention lead-in, then speak the
 * line ~150 ms later via speechSynthesis. Where speech is unavailable or
 * errors, the earcon IS the cue — the recipes (coach-live.ts COACH_EARCONS)
 * are distinct and contour-coded per kind precisely so an earcon-only device
 * (some headset browsers ship no TTS voices) still coaches learnably.
 *
 * Laws:
 *  - MUTE MEANS SILENCE (#6): the earcon level comes from the exact
 *    sfxLevel() pref law the SFX layer uses, and the utterance volume from
 *    the same musicPrefs law — prefs off/volume 0 delivers NOTHING (no
 *    speech either; the caller additionally gates on coachPrefs).
 *  - NEVER QUEUE: a new cue cancels any pending/speaking one first. The
 *    policy's 9 s cooldown makes overlap near-impossible; this makes it
 *    impossible.
 *  - AudioContext discipline (audio-core.ts): peekAudioContext() only —
 *    this module never creates/resumes the shared context. During a walk it
 *    exists (the brief's user-gesture chain built it); if not, the earcon
 *    is skipped and speech still goes out (speechSynthesis is independent).
 *  - DUCKING: while a cue plays, the music master dips to ~65 % through
 *    MusicSystem's duck handle (globals.musicDuck — hold()/release()),
 *    released utterance-end + 300 ms, with an earcon-only span and a
 *    watchdog covering devices whose TTS never fires end/error. hold and
 *    release are balanced by construction: every path through this module
 *    releases exactly the duck it held.
 *  - STALE EVENTS ARE DEAD EVENTS (night-review #3): engines fire a
 *    cancelled utterance's onend/onerror asynchronously AFTER cancel()
 *    returns — by which time the next cue may already hold ITS duck. Every
 *    handler (onend/onerror/watchdog) captures a delivery generation token;
 *    cancelCoachVoice() bumps it, so a dead utterance's late events can
 *    never release the successor's duck or kill its watchdog.
 */

import { peekAudioContext } from "./audio-core.js";
import {
  COACH_EARCON_LEVEL,
  COACH_EARCONS,
  type LiveCue,
  type LiveCueKind,
} from "./coach-live.js";
import type { MusicPrefs } from "./music-prefs.js";
import { sfxLevel } from "./sfx-timeline.js";

/** MusicSystem's master duck handle (published as globals.musicDuck). */
export interface MusicDuckControls {
  hold(): void;
  release(): void;
}

/** Slightly brisk, still natural — the coach talks over a moving walk. */
export const SPEECH_RATE = 1.05;
/** Earcon leads the words so the trainee's ear is already listening. */
export const EARCON_LEAD_MS = 150;
/** Duck tail after the utterance ends. */
const DUCK_TAIL_MS = 300;
/** Duck span when the cue is earcon-only (no speech available). */
const EARCON_ONLY_DUCK_MS = 1200;
/** Hard stop for TTS engines that never fire end/error. */
const SPEECH_WATCHDOG_MS = 10000;

// Module-level delivery state — ONE cue in flight at most (never queue).
/** Delivery generation: bumped by every cancel, captured by every async
 * handler of the delivery it belongs to. A mismatch = the utterance was
 * cancelled and its late events must not touch the live delivery's state. */
let generation = 0;
let pendingSpeak: ReturnType<typeof setTimeout> | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let watchdog: ReturnType<typeof setTimeout> | null = null;
let heldDuck: MusicDuckControls | null = null;
let voiceCache: SpeechSynthesisVoice | null = null;

function clearTimer(t: ReturnType<typeof setTimeout> | null): null {
  if (t !== null) {
    clearTimeout(t);
  }
  return null;
}

/** Release the held duck (idempotent) and stop its timers. */
function releaseDuckNow(): void {
  releaseTimer = clearTimer(releaseTimer);
  watchdog = clearTimer(watchdog);
  if (heldDuck !== null) {
    const d = heldDuck;
    heldDuck = null;
    try {
      d.release();
    } catch {
      /* the music engine may already be torn down — non-fatal */
    }
  }
}

/** Schedule the duck release `ms` from now (replaces any pending release). */
function scheduleRelease(ms: number): void {
  releaseTimer = clearTimer(releaseTimer);
  watchdog = clearTimer(watchdog);
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    releaseDuckNow();
  }, ms);
}

/**
 * Stop everything in flight: pending speech timer, live utterance, duck.
 * Called on any phase exit (a reset/finish silences a mid-utterance cue)
 * and at the top of every new delivery.
 */
export function cancelCoachVoice(): void {
  generation++; // orphan every in-flight handler before cancel() can fire them
  pendingSpeak = clearTimer(pendingSpeak);
  try {
    if (typeof speechSynthesis !== "undefined") {
      speechSynthesis.cancel();
    }
  } catch {
    /* non-fatal */
  }
  releaseDuckNow();
}

/** A neutral English voice, cached once found. getVoices() loads async on
 * some platforms — an empty list just retries at the next cue. */
function pickVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
  if (voiceCache !== null) {
    return voiceCache;
  }
  let voices: SpeechSynthesisVoice[];
  try {
    voices = synth.getVoices();
  } catch {
    return null;
  }
  if (!voices || voices.length === 0) {
    return null;
  }
  const en = voices.filter(
    (v) => typeof v.lang === "string" && v.lang.toLowerCase().startsWith("en"),
  );
  voiceCache =
    en.find((v) => v.default) ?? en.find((v) => v.localService) ?? en[0] ?? null;
  return voiceCache;
}

/** Synthesize one earcon (nodes are event-scoped — the sfx.ts precedent). */
function playEarcon(kind: LiveCueKind, level: number): void {
  const ctx = peekAudioContext(); // NEVER create outside the gesture chain
  if (ctx === null || ctx.state !== "running") {
    return;
  }
  const spec = COACH_EARCONS[kind];
  const t0 = ctx.currentTime + 0.01;
  const peak = COACH_EARCON_LEVEL * level;
  if (spec.glide) {
    // One swoop: frequency glides notes[0] -> notes[1] over `span`.
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(spec.notes[0], t0);
    osc.frequency.linearRampToValueAtTime(spec.notes[1], t0 + spec.span);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.span + spec.decay);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + spec.span + spec.decay + 0.05);
  } else {
    // Two blips, `span` apart (center-up repeats the same pitch).
    for (let i = 0; i < 2; i++) {
      const at = t0 + i * spec.span;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(spec.notes[i], at);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(peak, at + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, at + spec.decay);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(at);
      osc.stop(at + spec.decay + 0.03);
    }
  }
}

/**
 * Wave 1 FIT SESSION guidance delivery: the speakCue path MINUS the earcon
 * (the fit flow is a calm calibration, not a mid-walk attention grab —
 * FIT_LINES are full sentences that carry themselves). Same laws exactly:
 * cancel-never-queue, SPEECH_RATE, the voice pick, the musicPrefs mute law
 * (level <= 0 delivers NOTHING), duck held while speaking + generation-gated
 * release + watchdog. The coachPrefs on/off gate is the caller's
 * (FitSessionSystem). No speech engine -> silence (there is no earcon here;
 * the panel guidance line is the fallback surface).
 */
export function speakFitLine(
  text: string,
  prefs: MusicPrefs,
  duck: MusicDuckControls | null,
): void {
  cancelCoachVoice(); // never queue; also releases any stale duck
  const gen = generation; // this delivery's token (cancel just bumped it)

  const level = sfxLevel(prefs); // the SFX layer's exact pref law (#6)
  if (level <= 0) {
    return; // mute means silence
  }

  const synth =
    typeof speechSynthesis !== "undefined" &&
    typeof SpeechSynthesisUtterance !== "undefined"
      ? speechSynthesis
      : null;
  if (synth === null) {
    return; // no TTS, no earcon fallback — the panel line carries the copy
  }

  if (duck !== null) {
    try {
      duck.hold();
      heldDuck = duck;
    } catch {
      heldDuck = null;
    }
  }

  try {
    synth.cancel(); // belt + braces: nothing of ours may still be queued
    const u = new SpeechSynthesisUtterance(text);
    u.rate = SPEECH_RATE;
    // The same musicPrefs law as speakCue: off = 0, else scaled.
    u.volume = Math.min(1, Math.max(0, prefs.enabled ? prefs.volume : 0));
    const voice = pickVoice(synth);
    if (voice !== null) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = "en-US";
    }
    // Generation-gated end/error (the stale-events-are-dead-events law).
    u.onend = () => {
      if (gen === generation) scheduleRelease(DUCK_TAIL_MS);
    };
    u.onerror = () => {
      if (gen === generation) scheduleRelease(DUCK_TAIL_MS);
    };
    synth.speak(u);
    // Watchdog: some engines never fire end/error — never duck forever.
    watchdog = setTimeout(() => {
      watchdog = null;
      if (gen !== generation) {
        return; // a newer delivery owns the synth/duck now
      }
      try {
        synth.cancel();
      } catch {
        /* non-fatal */
      }
      releaseDuckNow();
    }, SPEECH_WATCHDOG_MS);
  } catch {
    releaseDuckNow(); // speech construction failed — nothing is playing
  }
}

/**
 * Deliver one decided cue: earcon now, speech EARCON_LEAD_MS later, music
 * ducked until the words land. `prefs` is the live musicPrefs snapshot —
 * this module applies the volume/mute LAW; the coachPrefs on/off gate is
 * the caller's (CoachLiveSystem).
 */
export function speakCue(
  cue: LiveCue,
  prefs: MusicPrefs,
  duck: MusicDuckControls | null,
): void {
  cancelCoachVoice(); // never queue; also releases any stale duck
  const gen = generation; // this delivery's token (cancel just bumped it)

  const level = sfxLevel(prefs); // the SFX layer's exact pref law (#6)
  if (level <= 0) {
    return; // mute means silence — no earcon, no speech
  }

  playEarcon(cue.kind, level);

  if (duck !== null) {
    try {
      duck.hold();
      heldDuck = duck;
    } catch {
      heldDuck = null;
    }
  }

  const synth =
    typeof speechSynthesis !== "undefined" &&
    typeof SpeechSynthesisUtterance !== "undefined"
      ? speechSynthesis
      : null;
  if (synth === null) {
    scheduleRelease(EARCON_ONLY_DUCK_MS); // earcon-only device
    return;
  }

  pendingSpeak = setTimeout(() => {
    pendingSpeak = null;
    try {
      synth.cancel(); // belt + braces: nothing of ours may still be queued
      const u = new SpeechSynthesisUtterance(cue.text);
      u.rate = SPEECH_RATE;
      // The same musicPrefs law as the levels above: off = 0, else scaled.
      u.volume = Math.min(1, Math.max(0, prefs.enabled ? prefs.volume : 0));
      const voice = pickVoice(synth);
      if (voice !== null) {
        u.voice = voice;
        u.lang = voice.lang;
      } else {
        u.lang = "en-US";
      }
      // Generation-gated: a cancelled utterance's end/error lands AFTER the
      // next speakCue held its duck — a stale scheduleRelease would release
      // that NEW duck ~300 ms into its speech and clear its watchdog.
      u.onend = () => {
        if (gen === generation) scheduleRelease(DUCK_TAIL_MS);
      };
      u.onerror = () => {
        if (gen === generation) scheduleRelease(DUCK_TAIL_MS);
      };
      synth.speak(u);
      // Watchdog: some engines never fire end/error — never duck forever.
      watchdog = setTimeout(() => {
        watchdog = null;
        if (gen !== generation) {
          return; // a newer delivery owns the synth/duck now
        }
        try {
          synth.cancel();
        } catch {
          /* non-fatal */
        }
        releaseDuckNow();
      }, SPEECH_WATCHDOG_MS);
    } catch {
      // Speech construction failed — the earcon already played; wind down.
      scheduleRelease(EARCON_ONLY_DUCK_MS - EARCON_LEAD_MS);
    }
  }, EARCON_LEAD_MS);
}
