/**
 * (X)RUNWAY — Persisted music preferences (on/off + volume + tempo).
 *
 * The engine used to start on every run at a hard-coded level with no way to
 * turn it off or down (#6). These prefs live on `globals.musicPrefs` (a
 * signal — the landing MUSIC controls and the in-headset settings rows both
 * write it; MusicSystem applies volume to its master gain and adopts the
 * tempo at its per-run anchor points) and persist across reloads, following
 * the user-prefs.ts / scenes.ts localStorage pattern.
 *
 * TEMPO (the multi-BPM founder call, 2026-07-08): `bpm` selects the ONE
 * tempo that drives the audible music, the M9 haptic pulse grid, AND the
 * beat-lock scoring grid together — heard = felt = scored, full-tempo, never
 * audible-only. `null` = follow the active mode's default
 * ({@link MODE_DEFAULT_BPM}); the picker stores an explicit value on first
 * cycle. The delivered tempo is latched per run at the countdown edge
 * (music.ts armDropAtGo publishes `globals.goBpm` beside `goAudioTime`) and
 * stamped on the walk record — a mid-run pref change takes effect on the
 * NEXT run, never under a scored walk.
 *
 * Dependency-free (localStorage access is guarded) so the sanitizing is
 * unit-testable in node.
 */

/** The three deliverable tempos. Derived from the measured runway cadence
 * (~125 spm — docs/RESEARCH-runway-pace-bpm.md), never from a claimed
 * "industry BPM" (no credible source gives one): 125 = one step per beat at
 * true runway cadence, 62 = its half-time, 100 = the everyday-walk feel. */
export type MusicBpm = 62 | 100 | 125;

/** Picker cycle order (slow -> everyday -> runway). */
export const MUSIC_BPM_OPTIONS: readonly MusicBpm[] = [62, 100, 125];

export interface MusicPrefs {
  /** Master on/off. Off mutes the engine without stopping the show. */
  enabled: boolean;
  /** Master volume 0..1 (scales the engine's internal MASTER_LEVEL). */
  volume: number;
  /** Selected music tempo, or null = the active mode's default
   * ({@link MODE_DEFAULT_BPM}). Set the first time the picker cycles. */
  bpm: MusicBpm | null;
}

export const DEFAULT_MUSIC: MusicPrefs = {
  enabled: true,
  volume: 0.7,
  bpm: null,
};

/**
 * Per-mode default tempo (used while `bpm` is null). beginner -> 100 and
 * highfashion (EMERGING) -> 125 are the founder's calls (2026-07-08);
 * commercial -> 100 and challenge -> 125 are PROVISIONAL engineering
 * defaults by speed tier (both modes are hidden from the picker today) —
 * an open founder call. Lives HERE, not on TrainingMode, so the modes.json
 * golden + the Swift Modes mirror stay untouched.
 */
export const MODE_DEFAULT_BPM: Readonly<Record<string, MusicBpm>> = {
  beginner: 100,
  highfashion: 125,
  commercial: 100,
  challenge: 125,
};

const STORAGE_KEY = "xrunway.music.v1";

/** Coerce anything to a legal tempo choice: one of the three options, else
 * null (= mode default). */
export function sanitizeMusicBpm(v: unknown): MusicBpm | null {
  return v === 62 || v === 100 || v === 125 ? v : null;
}

/** Coerce anything (old schema, manual edits) into a valid MusicPrefs. */
export function sanitizeMusicPrefs(p: unknown): MusicPrefs {
  const obj = (p ?? {}) as Partial<Record<keyof MusicPrefs, unknown>>;
  const enabled =
    typeof obj.enabled === "boolean" ? obj.enabled : DEFAULT_MUSIC.enabled;
  const raw = typeof obj.volume === "number" ? obj.volume : Number.NaN;
  const volume = Number.isFinite(raw)
    ? Math.min(1, Math.max(0, raw))
    : DEFAULT_MUSIC.volume;
  return { enabled, volume, bpm: sanitizeMusicBpm(obj.bpm) };
}

export function loadMusicPrefs(): MusicPrefs {
  try {
    if (typeof localStorage === "undefined") return { ...DEFAULT_MUSIC };
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_MUSIC };
    return sanitizeMusicPrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_MUSIC };
  }
}

export function saveMusicPrefs(p: MusicPrefs): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeMusicPrefs(p)));
    }
  } catch {
    /* storage full / unavailable — non-fatal. */
  }
}

/**
 * The effective tempo: the explicit pref, else the active mode's default,
 * else 100 (an unknown mode id reads as the everyday tier — getMode's
 * DEFAULT_MODE fallback is beginner, whose default is also 100).
 */
export function resolveMusicBpm(
  p: MusicPrefs,
  modeId: string | null | undefined,
): MusicBpm {
  if (p.bpm !== null) return p.bpm;
  return (modeId != null ? MODE_DEFAULT_BPM[modeId] : undefined) ?? 100;
}

/**
 * Advance the settings surfaces' three-state cycle (62 -> 100 -> 125 -> 62),
 * starting from the RESOLVED tempo so the first cycle from a mode default
 * moves one visible step. Shared by the landing button and the XR pill so
 * the two surfaces can never cycle differently (the cycleBeatPrefs law).
 * Always stores an explicit value — there is no cycle back to "auto".
 */
export function cycleMusicBpm(
  p: MusicPrefs,
  modeId: string | null | undefined,
): MusicPrefs {
  const cur = resolveMusicBpm(p, modeId);
  const i = MUSIC_BPM_OPTIONS.indexOf(cur);
  const next = MUSIC_BPM_OPTIONS[(i + 1) % MUSIC_BPM_OPTIONS.length];
  return { ...p, bpm: next };
}

/**
 * The settings label for the resolved tempo: the landing control shouts
 * upper-case; the XR pill follows the set-music/set-beat sentence case
 * (BPM stays an initialism). ASCII only — the XR strings are pinned by the
 * label tests (the panel law). Structural label, not prose (the no-AI-text
 * law's structural exemption); the founder's own words per option are
 * {@link musicBpmNote}.
 */
export function musicBpmLabel(
  p: MusicPrefs,
  modeId: string | null | undefined,
  surface: "landing" | "xr",
): string {
  const bpm = resolveMusicBpm(p, modeId);
  return surface === "xr" ? `Music BPM: ${bpm}` : `MUSIC BPM: ${bpm}`;
}

/**
 * The founder's own description of each option — FINAL copy (the no-AI-text
 * law: integrated verbatim, 2026-07-08; never rewrite here). Shown under the
 * landing picker and in the settings DETAILS area.
 */
export function musicBpmNote(bpm: MusicBpm): string {
  if (bpm === 62) return "half time of the emerging level speed";
  if (bpm === 100) return "everyday walking speed or leisure";
  return "emerging level walking speed (industry standard)";
}
