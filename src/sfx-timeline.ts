/**
 * (X)RUNWAY — SFX event table + gain law (pure, dependency-free — vitest-safe).
 *
 * The DATA behind src/sfx.ts (the WebAudio show-SFX layer, #19): which show
 * signals fire which sounds, at what levels, and how the layer's master gain
 * follows the persisted music prefs. sfx.ts reads every number from here so
 * the tests can lock the event table and the mute/volume law without touching
 * WebAudio.
 *
 * Trigger vocabulary:
 *   phase:<p>   — fired from the showPhase signal subscription (edge by
 *                 definition — subscribers run once per transition).
 *   edge:<flag> — fired from update() by PRIVATE-prev rising-edge detection
 *                 on a shared durable global (poseBurst / finishBurst /
 *                 lastStep.time). LAW: the flags have multiple readers — the
 *                 SFX layer NEVER writes them (the poseBurst destructive-read
 *                 bug, commit 98a571b).
 *   clock:go    — scheduled at the armed GO instant (globals.goAudioTime,
 *                 published by MusicSystem on the shared AudioContext clock,
 *                 #44) so it lands sample-aligned with THE DROP.
 */

export type SfxEventId =
  | "countdown-tick"
  | "go-hit"
  | "footstrike"
  | "pose-sting"
  | "finale-hit"
  | "reveal-sting";

export type SfxTrigger =
  | "phase:countdown"
  | "clock:go"
  | "edge:lastStep"
  | "edge:poseBurst"
  | "edge:finishBurst"
  | "phase:summary";

export interface SfxEventSpec {
  id: SfxEventId;
  trigger: SfxTrigger;
  /** Peak voice gain, relative to the SFX master (0..1]. */
  level: number;
  /** True = scheduled ahead on the audio clock (cancellable via the show bus
   * when the run resets); false = fired immediately on its edge. */
  scheduled: boolean;
}

/** The show's signature moments — every one of them was silent before #19. */
export const SFX_EVENTS: readonly SfxEventSpec[] = [
  { id: "countdown-tick", trigger: "phase:countdown", level: 0.14, scheduled: true },
  { id: "go-hit", trigger: "clock:go", level: 0.22, scheduled: true },
  { id: "footstrike", trigger: "edge:lastStep", level: 0.08, scheduled: false },
  { id: "pose-sting", trigger: "edge:poseBurst", level: 0.18, scheduled: false },
  { id: "finale-hit", trigger: "edge:finishBurst", level: 0.5, scheduled: false },
  { id: "reveal-sting", trigger: "phase:summary", level: 0.13, scheduled: true },
] as const;

export function sfxEvent(id: SfxEventId): SfxEventSpec {
  const spec = SFX_EVENTS.find((e) => e.id === id);
  if (spec === undefined) {
    throw new Error(`unknown sfx event: ${id}`);
  }
  return spec;
}

/** SFX bed sits under the music (music master is 0.7). */
export const SFX_MASTER_LEVEL = 0.5;

/**
 * The layer's master gain — the SAME law MusicSystem.masterLevel() applies to
 * globals.musicPrefs (#6): off mutes the layer entirely (the show itself is
 * untouched), on scales SFX_MASTER_LEVEL by the persisted 0..1 volume.
 */
export function sfxLevel(prefs: { enabled: boolean; volume: number }): number {
  return prefs.enabled ? SFX_MASTER_LEVEL * prefs.volume : 0;
}

/** Score-reveal sting delay after the summary lands: the finale hit + musical
 * cadence own the finish instant; the graded sting reads as its own beat. */
export const REVEAL_DELAY_SEC = 0.9;

/** Pass bar fallback when a summary carries no mode stamp (legacy fixtures). */
export const DEFAULT_PASS_THRESHOLD = 75;

/**
 * Which reveal sting a summary earns. Mirrors the product-wide grading rule
 * (overall >= the LOCKED run mode's pass bar; stamp may be null on legacy
 * summaries → the shared 75 fallback).
 */
export function revealVariant(
  overall: number,
  passThreshold: number | null | undefined,
): "pass" | "needswork" {
  const bar = passThreshold ?? DEFAULT_PASS_THRESHOLD;
  return overall >= bar ? "pass" : "needswork";
}

/* ------------------------------------------------------------------------ */
/* Voice recipes — frequencies/envelopes sfx.ts synthesizes from. All gains   */
/* below are the peak levels from SFX_EVENTS (kept in one place above).       */
/* ------------------------------------------------------------------------ */

export const SFX_VOICES = {
  /** Countdown tick: the soft D6 blip the old music metronome used — now on
   * the HUD's second boundaries (#44). */
  tick: { freq: 1174.66, decay: 0.08 },
  /** GO: an A-major-less affirmation (E6 + A6) with a snap transient — lands
   * ON the drop downbeat, which carries the real weight. */
  go: { freqs: [1318.51, 1760.0], decay: 0.3 },
  /** Footstrike: a tiny band-passed noise tap; L/R alternate brightness.
   * Gain rides show energy (base + span·energy) so idle browsing barely
   * ticks while the walk taps clearly. */
  foot: { freqL: 1700, freqR: 2100, decay: 0.05, baseGain: 0.02, energySpan: 0.06 },
  /** Pose-mark sting: a shutter-click cluster + one bright E6 chime — the
   * audio twin of the paparazzi storm. */
  pose: { clicks: 5, spread: 0.3, chimeFreq: 1318.51, chimeDecay: 0.5 },
  /** Finale hit: sub boom (220→55 Hz drop) + noise splash, immediate on the
   * finish edge; the musical cadence resolves right behind it. */
  finale: { boomFrom: 220, boomTo: 55, boomDecay: 0.5, splashFreq: 2400, splashDecay: 0.35 },
  /** Reveal stings: PASS = ascending A5-E6-A6 sparkle; NEEDS WORK = a gentle
   * descending C4→A3 — distinct, never punishing. */
  reveal: {
    pass: [880.0, 1318.51, 1760.0],
    needswork: [261.63, 220.0],
    noteGap: 0.09,
    decay: 0.5,
  },
} as const;
