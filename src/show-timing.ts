/**
 * (X)RUNWAY — ONE show clock (pure, dependency-free — vitest-safe).
 *
 * #44: GO and THE DROP used to disagree by 0.15–2.1 s because two clocks ran
 * against each other: ShowDirector's delta-accumulated countdown (3.0 s) vs
 * MusicSystem's bar grid, anchored once at the BRIEF phase. scheduleDrop()
 * then pushed the drop to "the next bar boundary", which almost never
 * coincided with the walk-phase flip.
 *
 * The fix keeps ShowDirector as the SHOW timeline owner (COUNTDOWN_SEC lives
 * here, single source — show.ts consumes it, hud.ts/landing.ts mirror the
 * same 3 whole seconds) and makes the MUSIC re-fit itself to that timeline:
 * at the countdown edge MusicSystem re-anchors its bar grid via
 * {@link alignGridToGo} so that GO (countdown start + COUNTDOWN_SEC) IS a bar
 * boundary, and pre-arms the drop for exactly that moment. Nothing audible
 * moves during the re-anchor — pre-drop the transport plays only sustained
 * pads (the drums enter AT the drop), so shifting the grid under them is
 * silent.
 *
 * The countdown "metronome" is also re-specified here: instead of ticking
 * every musical beat against the HUD's whole-second digits, ticks fire on
 * the SAME second boundaries the digits flip on
 * ({@link countdownTickTimes}), counting down into the GO downbeat.
 *
 * TEMPO (the multi-BPM founder call): the engine's tempo is a RUNTIME value
 * — the resolved music pref (music-prefs.ts: 62 / 100 / 125, mode default
 * while unset). This module exports only the pure derivations
 * ({@link beatSecOf} / {@link barSecOf} / {@link stepSecOf}); MusicSystem
 * latches the run's tempo at its anchor points and publishes the armed value
 * as `globals.goBpm` beside `goAudioTime`, so the haptic pulse train and the
 * beat-lock scoring grid run on the SAME delivered tempo (heard = felt =
 * scored). There is deliberately no module-scope BEAT/BAR/STEP constant left
 * to freeze a tempo at import time.
 */

/** Countdown length (s) — WHOLE seconds (the HUD renders 3-2-1 digits and
 * ticks land on the digit flips). Mirrored by hud.ts COUNTDOWN_SECONDS and
 * the landing's 1 s interval; change all three together. */
export const COUNTDOWN_SEC = 3;

/** 8th-note steps per 4/4 bar — a count, tempo-independent. */
export const STEPS_PER_BAR = 8;

/** One beat (s) at a tempo: 60 / bpm. */
export function beatSecOf(bpm: number): number {
  return 60 / bpm;
}

/** One 4/4 bar (s) at a tempo. */
export function barSecOf(bpm: number): number {
  return beatSecOf(bpm) * 4;
}

/** One 8th-note scheduler step (s) at a tempo. */
export function stepSecOf(bpm: number): number {
  return beatSecOf(bpm) / 2;
}

/** A re-anchored scheduler grid (all times on the caller's audio clock). */
export interface GridAlignment {
  /** New grid anchor. `go` is an EXACT whole-bar multiple past it. */
  gridStart: number;
  /** Step index of the first step to schedule (≥ 0, on the new grid). */
  step: number;
  /** Audio time of that first step (≥ `now`, so nothing schedules in the past). */
  nextStepTime: number;
}

/**
 * Re-anchor an 8th-note scheduler grid so that `go` lands EXACTLY on a bar
 * boundary (the drop downbeat), with the grid origin at-or-before `now` so
 * step indices stay non-negative (the pattern math floors/mods them).
 *
 * Pure: caller passes its clock's `now` and target `go` (must be > now) plus
 * the run's bar/step durations ({@link barSecOf} / {@link stepSecOf} at the
 * latched tempo — REQUIRED, so no call site can silently fall back to a
 * frozen default tempo). At 62 BPM a bar (~3.87 s) is LONGER than the 3 s
 * countdown — the math still holds (bars >= 1, gridStart <= now).
 */
export function alignGridToGo(
  now: number,
  go: number,
  bar: number,
  step: number,
): GridAlignment {
  // Whole bars needed to reach back from `go` to at-or-before `now`.
  const bars = Math.max(1, Math.ceil((go - now) / bar));
  const gridStart = go - bars * bar;
  // First step at-or-after `now` (+20 ms of scheduling headroom).
  const stepIndex = Math.max(0, Math.ceil((now + 0.02 - gridStart) / step - 1e-9));
  return {
    gridStart,
    step: stepIndex,
    nextStepTime: gridStart + stepIndex * step,
  };
}

/**
 * Countdown tick times: ONE tick per displayed digit, ON the second boundary
 * that digit appears (digit N shows while remaining ∈ (N-1, N], so digit N's
 * tick is at `go - N`). For the 3 s countdown: [go-3, go-2, go-1] — the same
 * instants the HUD digits flip — counting down into the GO downbeat at `go`.
 * Tempo-independent by design (#44).
 */
export function countdownTickTimes(
  go: number,
  countdownSec: number = COUNTDOWN_SEC,
): number[] {
  const digits = Math.max(0, Math.ceil(countdownSec));
  const times: number[] = [];
  for (let d = digits; d >= 1; d--) {
    times.push(go - d);
  }
  return times;
}
