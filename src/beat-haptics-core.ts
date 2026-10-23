/**
 * (X)RUNWAY — M9 BEAT-IN-THE-HAND: the pure per-frame DECISION step of
 * BeatHapticsSystem (src/beat-haptics.ts), extracted so the adjudication-§E
 * laws are unit-testable without a WebXR/AudioContext harness (the
 * hud-state.ts precedent — the system feeds its live state in, the test
 * feeds a truth table).
 *
 * The §E laws these two functions encode:
 * - update() PEEKS beatPrefs every frame and gates FIRING per phase:
 *   countdown fires when prefs.countdown, walk fires when prefs.walk
 *   ({@link pulseFrameAction} — the gate never stops the GRID: a gated-off
 *   frame still returns "advance" so the tick pointer keeps tracking the
 *   go-anchored grid and a mid-walk enable fires from the cached anchor
 *   without any re-arm code).
 * - EVERY disarm path nulls the delivery fact in the SAME frame
 *   ({@link walkDeliveryNext}): pref off ("advance"), suspended ctx
 *   ("idle" — a frozen clock AND an inaudible reference), phase exit
 *   (phase !== "walk"; countdown pulses never open the gate), actuator
 *   loss / muted earcon (a reached tick whose emission produced nothing
 *   writes null). Between ticks the LAST beat's emitted kind stands — the
 *   fact describes what the current pulse train is actually delivering.
 *
 * The tick arithmetic itself (firstPulseTick / advancePulseTick /
 * countdownFlamSuppressed and the BEAT_PULSE_* / BEAT_EARCON_* constants)
 * lives in beat-stats.ts beside the scoring core; this module owns only the
 * per-frame gate/delivery decisions. Zero allocation: plain scalar returns.
 */

/** The pulse train's phase view: the show's countdown / walk, or "off"
 *  (idle, brief, summary — the train never runs there). */
export type PulsePhase = "countdown" | "walk" | "off";

/** What the frame may do with the grid:
 *  - "fire": the phase gate is open — a reached tick emits;
 *  - "advance": gate closed (pref off) — a reached tick advances the
 *    pointer WITHOUT emitting, so a later enable never burst-fires catchup;
 *  - "idle": no clock to poll (phase off / suspended ctx) — the pointer
 *    holds; the resume path's advancePulseTick skips the missed ticks. */
export type PulseFrameAction = "fire" | "advance" | "idle";

/** What the walk train actually delivered this beat (the beatDelivery.walk
 *  fact the M9 reference gate consumes). */
export type WalkDeliveryKind = "haptic" | "earcon" | null;

/** The per-frame gate (adjudication §E): firing is gated per PHASE on the
 *  matching pref; a running clock is required for anything at all. */
export function pulseFrameAction(
  phase: PulsePhase,
  ctxRunning: boolean,
  prefsCountdown: boolean,
  prefsWalk: boolean,
): PulseFrameAction {
  if (phase === "off" || !ctxRunning) {
    return "idle";
  }
  const gate = phase === "countdown" ? prefsCountdown : prefsWalk;
  return gate ? "fire" : "advance";
}

/**
 * The GO downbeat (k=0 tick) is a COUNTDOWN-owned event: it ends the
 * countdown and reinforces the drop, and by construction it never opens the
 * M9 reference gate (the caller feeds `fired` to {@link walkDeliveryNext}
 * only on the normal `action === "fire"` path). Gating it on the CURRENT
 * phase is a race: the countdown->walk flip and the GO instant live on two
 * free-running clocks (ECS delta vs the audio clock), so on the default
 * config (countdown on, walk off) the GO pulse fired-or-not depending on
 * which side of the flip the crossing frame landed. This decision is
 * phase-INDEPENDENT — it fires whenever the countdown pref is on and the
 * clock is running — so the documented "pulse ON the drop" reinforcement is
 * delivered deterministically regardless of the flip timing. `isGoTick` is
 * the caller's identity test (the unique grid tick within +-BEAT/2 of the
 * cached goAudio).
 */
export function goReinforceFires(
  isGoTick: boolean,
  prefsCountdown: boolean,
  ctxRunning: boolean,
): boolean {
  return isGoTick && prefsCountdown && ctxRunning;
}

/**
 * The next value of the delivery fact (globals.beatDelivery.walk), given
 * what this frame did. §E: every disarm path lands on null in the SAME
 * frame this function runs —
 *   phase !== "walk"   -> null (phase exit; countdown never opens the gate)
 *   action !== "fire"  -> null (pref off mid-walk; suspended ctx)
 *   ticked             -> firedKind (what THIS beat actually emitted:
 *                         "haptic", the disclosed "earcon" fallback, or
 *                         null on actuator loss with the earcon muted —
 *                         the setting being ON never fakes delivery)
 *   otherwise          -> prev (between ticks the last beat's fact stands).
 */
export function walkDeliveryNext(
  phase: PulsePhase,
  action: PulseFrameAction,
  ticked: boolean,
  firedKind: WalkDeliveryKind,
  prev: WalkDeliveryKind,
): WalkDeliveryKind {
  if (phase !== "walk" || action !== "fire") {
    return null;
  }
  return ticked ? firedKind : prev;
}
