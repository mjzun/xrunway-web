/**
 * (X)RUNWAY — pace-style preference (founder ask 2026-07-18).
 *
 * PACE Part B scores full credit inside a band around the target speed, with
 * an asymmetric slope beyond it. The DEFAULT forgives fast walking (the
 * taught long confident stride) twice as much as slow. But direction is a
 * coaching call — the founder has been told "take your time" by real
 * directors — so the trainee can flip WHICH side is the gentle one:
 *
 *   confident    (default) — slow costs PACE_K_SLOW, fast costs PACE_K_FAST
 *   takeYourTime           — the slopes SWAP: slow is the gentle side
 *
 * ADVANCED: the band half-width itself (default PACE_BAND_MPS 0.10) can be
 * widened/narrowed through a deliberately quiet Settings control. Per the
 * founder's single-tester call (2026-07-18) these tweaks carry NO ruler
 * fencing — changing them simply changes scoring from the next run on.
 *
 * The engine latches the resolved values ONCE per run at walk start (the
 * tempo-latch law), so a mid-walk change never shifts a live score.
 * Persistence follows the music-prefs pattern; dependency-free for node
 * tests.
 */

import {
  PACE_BAND_MPS,
  PACE_K_FAST,
  PACE_K_SLOW,
  type PaceBandOpts,
} from "./pose-derive.js";

export type PaceBias = "confident" | "takeYourTime";

export interface PacePrefs {
  /** Which side of the target the scoring forgives more. */
  bias: PaceBias;
  /** The control-band half-width (m/s). Advanced; default PACE_BAND_MPS. */
  bandMps: number;
}

export const DEFAULT_PACE: PacePrefs = {
  bias: "confident",
  bandMps: PACE_BAND_MPS,
};

/** The advanced band ring (m/s). Cycled, never free-typed — a headset panel
 * has no keyboard, and a bounded ring keeps every value defensible. */
export const PACE_BAND_RING: readonly number[] = [0.05, 0.1, 0.15, 0.2];

const STORAGE_KEY = "xrunway.pace.v1";

/** Coerce anything (old schema, manual edits) into valid prefs. */
export function sanitizePacePrefs(p: unknown): PacePrefs {
  const obj = (p ?? {}) as Partial<Record<keyof PacePrefs, unknown>>;
  const bias: PaceBias =
    obj.bias === "takeYourTime" ? "takeYourTime" : DEFAULT_PACE.bias;
  const band =
    typeof obj.bandMps === "number" && PACE_BAND_RING.includes(obj.bandMps)
      ? obj.bandMps
      : DEFAULT_PACE.bandMps;
  return { bias, bandMps: band };
}

/** Resolve prefs into the engine's band options. The DEFAULT prefs resolve
 * to exactly the Part B constants — byte-identical scoring, golden-safe. */
export function resolvePaceOpts(p: PacePrefs): PaceBandOpts {
  const s = sanitizePacePrefs(p);
  return s.bias === "takeYourTime"
    ? { band: s.bandMps, kSlow: PACE_K_FAST, kFast: PACE_K_SLOW }
    : { band: s.bandMps, kSlow: PACE_K_SLOW, kFast: PACE_K_FAST };
}

export function cyclePaceBias(p: PacePrefs): PacePrefs {
  const s = sanitizePacePrefs(p);
  return {
    ...s,
    bias: s.bias === "confident" ? "takeYourTime" : "confident",
  };
}

export function cyclePaceBand(p: PacePrefs): PacePrefs {
  const s = sanitizePacePrefs(p);
  const i = PACE_BAND_RING.indexOf(s.bandMps);
  return { ...s, bandMps: PACE_BAND_RING[(i + 1) % PACE_BAND_RING.length] };
}

/** Pill labels (ASCII — the panel-font law). "xr" and "web" share wording. */
export function paceBiasLabel(p: PacePrefs): string {
  return sanitizePacePrefs(p).bias === "takeYourTime"
    ? "Pace style: Take your time"
    : "Pace style: Confident stride";
}

export function paceBandLabel(p: PacePrefs): string {
  return `Pace band: ${sanitizePacePrefs(p).bandMps.toFixed(2)} m/s`;
}

export function loadPacePrefs(): PacePrefs {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return sanitizePacePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_PACE };
  }
}

export function savePacePrefs(p: PacePrefs): void {
  try {
    globalThis.localStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify(sanitizePacePrefs(p)),
    );
  } catch {
    /* storage unavailable — session-only prefs are fine */
  }
}
