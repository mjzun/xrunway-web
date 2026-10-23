/**
 * (X)RUNWAY — Persisted beat-pulse preferences (M9 BEAT-IN-THE-HAND
 * delivery: countdown pulses + walk pulses).
 *
 * These prefs live on `globals.beatPrefs` (a signal — the landing BEAT PULSE
 * control and the in-headset settings pill both write it; BeatHapticsSystem
 * PEEKS it per frame) and persist across reloads — the music-prefs.ts
 * template byte-for-byte: sanitize / load / save, storage guarded.
 *
 * DEFAULTS (the spec's justification, recorded at the value):
 * - `countdown: true` — countdown pulses are PRE-scoring (they end at GO),
 *   so they change no measurement condition and prime the exact skill M9
 *   measures.
 * - `walk: false` — walk pulses change the walk's STIMULUS (a scored
 *   condition, stamped on the row via BeatStats.reference), so they are
 *   opt-in: the status quo is preserved for every existing trainee's trend
 *   series. Flipping the default after on-device experience is a RESERVED
 *   FOUNDER CALL.
 *
 * Dependency-free (localStorage access is guarded) so the sanitizing is
 * unit-testable in node.
 */

export interface BeatPrefs {
  /** Pulse the beat grid through the countdown (pre-scoring; ends at GO). */
  countdown: boolean;
  /** Pulse the beat grid through the walk (a scored condition — the walk
   *  record stamps the delivered reference). */
  walk: boolean;
}

export const DEFAULT_BEAT: BeatPrefs = { countdown: true, walk: false };

const STORAGE_KEY = "xrunway.beat.v1";

/** Coerce anything (old schema, manual edits) into a valid BeatPrefs.
 *  Per-field repair; ANY boolean combination is accepted (the settings
 *  surfaces cycle three states, but walk-without-countdown from a manual
 *  edit is a legal delivery choice, not junk). */
export function sanitizeBeatPrefs(p: unknown): BeatPrefs {
  const obj = (p ?? {}) as Partial<Record<keyof BeatPrefs, unknown>>;
  const countdown =
    typeof obj.countdown === "boolean" ? obj.countdown : DEFAULT_BEAT.countdown;
  const walk = typeof obj.walk === "boolean" ? obj.walk : DEFAULT_BEAT.walk;
  return { countdown, walk };
}

export function loadBeatPrefs(): BeatPrefs {
  try {
    if (typeof localStorage === "undefined") return { ...DEFAULT_BEAT };
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_BEAT };
    return sanitizeBeatPrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_BEAT };
  }
}

export function saveBeatPrefs(p: BeatPrefs): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeBeatPrefs(p)));
    }
  } catch {
    /* storage full / unavailable — non-fatal. */
  }
}

/**
 * Advance the settings surfaces' three-state cycle (spec §4.6 mapping):
 * OFF {false,false} -> COUNTDOWN {true,false} -> WALK + COUNTDOWN
 * {true,true} -> OFF. A manual walk-only edit ({countdown:false, walk:true}
 * — legal per sanitize) sits on the "most delivery" step and cycles to OFF
 * like the full state. Shared by the landing button and the XR pill so the
 * two surfaces can never cycle differently.
 */
export function cycleBeatPrefs(p: BeatPrefs): BeatPrefs {
  if (!p.countdown && !p.walk) {
    return { countdown: true, walk: false };
  }
  if (p.countdown && !p.walk) {
    return { countdown: true, walk: true };
  }
  return { countdown: false, walk: false };
}

/**
 * The settings label for the current state (spec §6): the landing control
 * shouts upper-case; the XR pill follows the set-music/set-coach sentence
 * case and stays short ("walk" covers both walk-on states — pulses reach
 * the walk either way). A manual walk-only combination is labeled honestly
 * on the landing (never "+ COUNTDOWN" when the countdown is off). ASCII
 * only — the XR strings are pinned by the label tests (the panel law).
 */
export function beatPrefsLabel(
  p: BeatPrefs,
  surface: "landing" | "xr",
): string {
  if (surface === "xr") {
    if (p.walk) return "Beat pulse: walk";
    return p.countdown ? "Beat pulse: countdown" : "Beat pulse: off";
  }
  if (p.walk) {
    return p.countdown ? "BEAT PULSE: WALK + COUNTDOWN" : "BEAT PULSE: WALK";
  }
  return p.countdown ? "BEAT PULSE: COUNTDOWN" : "BEAT PULSE: OFF";
}
