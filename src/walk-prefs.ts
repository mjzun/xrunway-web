/**
 * (X)RUNWAY — Persisted walk-duration preference (founder call 2026-07-09:
 * "we need to be able to have the user be able to change the duration of the
 * walk but you can keep the default at 20s"; range ruled 10-60 s).
 *
 * The music-prefs.ts pattern byte-for-byte: lives on `globals.walkPrefs`
 * (a signal — the in-headset settings pill writes it; a landing picker
 * follows once src/landing.ts is free of the other session's edits),
 * persists across reloads, `null` = the active mode's own walkSeconds
 * (all modes ship 20 today).
 *
 * THE INJECTION LAW: the chosen duration is applied ONCE per run, at
 * ShowDirectorSystem.startRun()'s mode lock, by composing an effective run
 * mode `{ ...base, walkSeconds }` — the exact override pattern the golden
 * generator itself uses (gen-golden-vectors.mjs REPLAY_MODE, 45 s). modes.ts
 * walkSeconds stays 20 (the modes.json golden family + the Swift Modes
 * mirror stay untouched — the MODE_DEFAULT_BPM placement precedent), and a
 * mid-run pref change takes effect on the NEXT run, never under a scored
 * walk (the tempo-latch law).
 *
 * Dependency-free (localStorage access is guarded) so the sanitizing is
 * unit-testable in node.
 */

/** The selectable walk lengths. The founder ruled the RANGE (10-60 s,
 * default 20); the discrete steps within it are an engineering call — a
 * settings pill cycles them (the MUSIC_BPM_OPTIONS pattern), so the list
 * stays short enough to tap through. */
export type WalkSeconds = 10 | 15 | 20 | 30 | 45 | 60;

/** Pill cycle order (short -> default -> long). */
export const WALK_SECONDS_OPTIONS: readonly WalkSeconds[] = [
  10, 15, 20, 30, 45, 60,
];

export interface WalkPrefs {
  /** Selected walk length in seconds, or null = the active mode's own
   * walkSeconds (20 on every shipped mode). Set the first time the pill
   * cycles — there is no cycle back to "auto" (the musicPrefs.bpm law). */
  seconds: WalkSeconds | null;
}

export const DEFAULT_WALK: WalkPrefs = { seconds: null };

const STORAGE_KEY = "xrunway.walk.v1";

/** Coerce anything to a legal duration choice: one of the options, else
 * null (= mode default). Exact-match like sanitizeMusicBpm — a hand-edited
 * 25 falls back to the mode default rather than rounding. */
export function sanitizeWalkSeconds(v: unknown): WalkSeconds | null {
  return (WALK_SECONDS_OPTIONS as readonly unknown[]).includes(v)
    ? (v as WalkSeconds)
    : null;
}

/** Coerce anything (old schema, manual edits) into valid WalkPrefs. */
export function sanitizeWalkPrefs(p: unknown): WalkPrefs {
  const obj = (p ?? {}) as Partial<Record<keyof WalkPrefs, unknown>>;
  return { seconds: sanitizeWalkSeconds(obj.seconds) };
}

export function loadWalkPrefs(): WalkPrefs {
  try {
    if (typeof localStorage === "undefined") return { ...DEFAULT_WALK };
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_WALK };
    return sanitizeWalkPrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_WALK };
  }
}

export function saveWalkPrefs(p: WalkPrefs): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeWalkPrefs(p)));
    }
  } catch {
    /* storage full / unavailable — non-fatal. */
  }
}

/** The effective walk length: the explicit pref, else the mode's own
 * walkSeconds. Takes the minimal mode shape so show.ts, hud.ts and tests
 * can all hand in whatever mode object they hold. */
export function resolveWalkSeconds(
  p: WalkPrefs,
  mode: { walkSeconds: number },
): number {
  return p.seconds ?? mode.walkSeconds;
}

/**
 * Advance the settings pill's cycle (10 -> 15 -> 20 -> 30 -> 45 -> 60 -> 10),
 * starting from the RESOLVED length so the first cycle from a mode default
 * moves one visible step (the cycleMusicBpm law). A resolved value outside
 * the options (a future non-20 mode default) restarts at the first option.
 * Always stores an explicit value — there is no cycle back to "auto".
 */
export function cycleWalkSeconds(
  p: WalkPrefs,
  mode: { walkSeconds: number },
): WalkPrefs {
  const cur = resolveWalkSeconds(p, mode);
  const i = (WALK_SECONDS_OPTIONS as readonly number[]).indexOf(cur);
  const next = WALK_SECONDS_OPTIONS[(i + 1) % WALK_SECONDS_OPTIONS.length];
  return { seconds: next };
}

/**
 * The settings label for the resolved length: the landing control shouts
 * upper-case; the XR pill follows the set-music/set-bpm sentence case.
 * ASCII only — the XR string is pinned by the label tests (the panel law).
 * Structural label, not prose (the no-AI-text law's structural exemption).
 */
export function walkSecondsLabel(
  p: WalkPrefs,
  mode: { walkSeconds: number },
  surface: "landing" | "xr",
): string {
  const s = resolveWalkSeconds(p, mode);
  return surface === "xr" ? `Duration: ${s}s` : `DURATION: ${s}S`;
}
