/**
 * (X)RUNWAY — Persisted coach-voice preference (on/off).
 *
 * Mid-walk spoken coaching (#20/#48) needs a trainee-facing OFF switch: the
 * voice is helpful in training and unwelcome in a demo or a quiet room. The
 * pref lives on `globals.coachPrefs` (a signal — the landing COACH VOICE
 * toggle and the in-headset settings row both write it, CoachLiveSystem gates
 * cue delivery on it) and persists across reloads, mirroring music-prefs.ts.
 *
 * NOTE the mute law: this pref is NOT the only silencer — `musicPrefs.enabled
 * === false` (the product-wide audio mute, #6) ALSO silences coaching. Mute
 * means silence, coach included.
 *
 * Dependency-free (localStorage access is guarded) so the sanitizing is
 * unit-testable in node.
 */

export interface CoachPrefs {
  /** Spoken mid-walk coaching on/off. Off silences cues without touching the
   * scoring or the post-walk coach notes. */
  enabled: boolean;
}

// Coach voice OFF by default (2026-07-05 founder call: "coach should be just
// text"). The live spoken coach system is also un-registered in index.ts, so
// mid-walk narration is gone regardless; this default also keeps the FIT
// guidance voice (speakFitLine, same pref gate) silent unless deliberately
// enabled.
export const DEFAULT_COACH: CoachPrefs = { enabled: false };

const STORAGE_KEY = "xrunway.coach.v1";

/** Coerce anything (old schema, manual edits) into a valid CoachPrefs.
 *
 * HARD-PINNED OFF (founder ruling 2026-07-16, repeating an earlier chat's
 * call): the coach voice is dropped ENTIRELY for this product at this time —
 * no control ships on either surface, and a legacy `enabled:true` left in
 * localStorage from early testing must not resurrect it. To bring the voice
 * back some day: restore the boolean read below AND re-add the controls AND
 * re-register CoachLiveSystem in index.ts. */
export function sanitizeCoachPrefs(_p: unknown): CoachPrefs {
  return { enabled: false };
}

export function loadCoachPrefs(): CoachPrefs {
  try {
    if (typeof localStorage === "undefined") return { ...DEFAULT_COACH };
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_COACH };
    return sanitizeCoachPrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_COACH };
  }
}

export function saveCoachPrefs(p: CoachPrefs): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeCoachPrefs(p)));
    }
  } catch {
    /* storage full / unavailable — non-fatal. */
  }
}
