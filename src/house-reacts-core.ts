/**
 * (X)RUNWAY — THE HOUSE REACTS, the pure pieces (idea-starter #5): a crowd
 * murmur bed that HUSHES at the countdown, an attentive room during the
 * walk, and applause at the reveal that scales with the walk's own score.
 * All levels/curves here are pure + unit-tested; the WebAudio side lives in
 * house-reacts.ts (the sfx-timeline / sfx.ts split).
 *
 * Honesty: the applause is theatrical DELIVERY of the real overall (the
 * medal/judges-paddle precedent) — nothing here feeds scoring.
 */

/** Murmur-bed target level per show phase, as a fraction of the layer's
 * master (musicPrefs-scaled). The COUNTDOWN is the theatrical beat: the
 * room falls near-silent the moment the lights commit. */
export const HOUSE_BED_LEVELS: Readonly<Record<string, number>> = {
  idle: 0.5,
  brief: 0.55,
  countdown: 0.08,
  walk: 0.16,
  summary: 0.42,
};

/** Seconds for the bed to ease between phase levels (setTargetAtTime tau).
 * The hush is FASTER than the swell — a room quiets on a cue, warms slowly. */
export const HOUSE_HUSH_TAU_SEC = 0.35;
export const HOUSE_SWELL_TAU_SEC = 1.4;

/** The house layer sits UNDER the music/SFX (a bed, not a voice). */
export const HOUSE_MASTER_LEVEL = 0.22;

/** Bed target for a phase (unknown phases read as idle). */
export function houseBedLevel(phase: string): number {
  return HOUSE_BED_LEVELS[phase] ?? HOUSE_BED_LEVELS.idle;
}

/** The ease constant for a phase CHANGE: hushing (level dropping) is fast,
 * swelling back is slow. */
export function houseBedTau(fromLevel: number, toLevel: number): number {
  return toLevel < fromLevel ? HOUSE_HUSH_TAU_SEC : HOUSE_SWELL_TAU_SEC;
}

/**
 * Applause intensity [0,1] for a revealed score vs the walk's own pass bar
 * (the revealVariant grading rule): a below-bar walk still gets a polite
 * hand (0.35 floor — a real house never boos a trainee), the bar earns a
 * warm 0.7, and every point above it climbs toward a full ovation at +15.
 */
export function applauseIntensity(
  overall: number,
  passThreshold: number,
): number {
  if (!Number.isFinite(overall)) return 0;
  const over = overall - passThreshold;
  if (over < 0) return 0.35;
  const k = 0.7 + (0.3 * Math.min(over, 15)) / 15;
  return Math.min(1, k);
}

/** One applause clap grain: onset (s), level [0,1], bandpass center (Hz). */
export interface ApplauseGrain {
  t: number;
  level: number;
  freq: number;
}

/** Applause length (s) by intensity — a polite hand is short, an ovation
 * hangs on. */
export function applauseDurationSec(intensity: number): number {
  return 1.6 + 2.6 * intensity;
}

/**
 * The deterministic clap-grain schedule for one applause event (seeded LCG —
 * reproducible in tests, varied per walk via the seed). Density and length
 * scale with intensity; levels swell in over the first ~15% and decay out
 * over the tail, each grain band-passed at a randomized clap-ish center.
 */
export function applauseGrains(
  intensity: number,
  seed: number,
): ApplauseGrain[] {
  const grains: ApplauseGrain[] = [];
  if (intensity <= 0) return grains;
  let s = (Math.floor(seed) % 2147483647) + 7919;
  const rnd = (): number => {
    s = (s * 48271) % 2147483647;
    return s / 2147483647;
  };
  const dur = applauseDurationSec(intensity);
  const count = Math.round(60 + 200 * intensity);
  for (let i = 0; i < count; i++) {
    // Onset density front-loads slightly (everyone starts near the reveal).
    const u = rnd();
    const t = dur * u * (0.7 + 0.3 * rnd());
    const swell = Math.min(1, t / (dur * 0.15));
    const decay = 1 - Math.max(0, (t - dur * 0.45) / (dur * 0.55));
    const level = intensity * swell * Math.max(0, decay) * (0.4 + 0.6 * rnd());
    if (level <= 0.01) continue;
    grains.push({
      t,
      level,
      freq: 900 + rnd() * 1600,
    });
  }
  grains.sort((a, b) => a.t - b.t);
  return grains;
}
