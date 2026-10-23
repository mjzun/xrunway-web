/**
 * (X)RUNWAY — the MusicSource provider seam (scaffolding, 2026-07-16).
 *
 * The founder wants trainees walking to THEIR music (Apple Music / Spotify /
 * their own files). The verified research (docs/MUSIC-INTEGRATION.md — 18
 * agents, primary sources, 0 refuted claims) settled the architecture: ONE
 * provider seam with four modes, where only sources the app can actually
 * ANALYZE may drive the beat-scoring grid:
 *
 *   procedural — today's WebAudio engine. Full beat-locked scoring (the app
 *                IS the clock).
 *   uploaded   — a trainee's own audio file, decoded client-side; BPM + first
 *                beat measured in-browser. Full beat-locked scoring. Zero
 *                backend; audio never leaves the browser.
 *   system     — something else plays (e.g. the native Spotify app in the
 *                Quest background). The app cannot hear it: AMBIENCE ONLY,
 *                rhythm channels score against the app's own grid and the UI
 *                must say so.
 *   streaming  — Apple Music / Spotify playing INSIDE the app. Feature-
 *                flagged OFF: DRM blocks any audio tap, tempo metadata is
 *                gone from both APIs, playback clocks are too coarse to
 *                phase-lock, and both TOS forbid synchronization. If it ever
 *                ships, it is ambience-only by construction.
 *
 * THE HONESTY LAW THIS FILE OWNS: `beatLockAvailable(source)` is the single
 * authority on whether the scored beat grid may claim to be the music the
 * trainee hears. Consumers (music.ts, beat-stats wiring, education copy)
 * must route through it — never assume "music on" means "grid == music".
 *
 * Persistence follows the music-prefs.ts pattern; dependency-free so node
 * tests load it. Nothing user-visible changes while the pref stays at the
 * default — the pickers/uploaders are follow-up builds gated on the founder's
 * Section-5 rulings in docs/MUSIC-INTEGRATION.md.
 */

export type MusicSourceKind = "procedural" | "uploaded" | "system" | "streaming";

export interface MusicSourcePrefs {
  /** Which provider feeds the walk's music. */
  source: MusicSourceKind;
  /** Streaming stays dark until the founder rules + the on-device DRM spike
   * passes (docs/MUSIC-INTEGRATION.md Phase 0). Kept as a pref field so a
   * dev build can flip it without a schema change. */
  streamingEnabled: boolean;
}

export const DEFAULT_MUSIC_SOURCE: MusicSourcePrefs = {
  source: "procedural",
  streamingEnabled: false,
};

const STORAGE_KEY = "xrunway.music-source.v1";

const KINDS: readonly MusicSourceKind[] = [
  "procedural",
  "uploaded",
  "system",
  "streaming",
];

/** Coerce anything (old schema, manual edits) into valid prefs. A stored
 * "streaming" source with the flag off falls back to procedural — the pref
 * must never resurrect a dark feature. */
export function sanitizeMusicSource(p: unknown): MusicSourcePrefs {
  const obj = (p ?? {}) as Partial<Record<keyof MusicSourcePrefs, unknown>>;
  const streamingEnabled = obj.streamingEnabled === true;
  let source: MusicSourceKind = DEFAULT_MUSIC_SOURCE.source;
  if (typeof obj.source === "string" && (KINDS as readonly string[]).includes(obj.source)) {
    source = obj.source as MusicSourceKind;
  }
  if (source === "streaming" && !streamingEnabled) {
    source = DEFAULT_MUSIC_SOURCE.source;
  }
  return { source, streamingEnabled };
}

/** THE beat-lock authority: may the scored grid claim to BE the audible
 * music? True only when the app controls or has measured the audio itself.
 * (docs/MUSIC-INTEGRATION.md §3 — the four verified kill-shots for
 * streaming; "system" audio is unhearable by construction.) */
export function beatLockAvailable(source: MusicSourceKind): boolean {
  return source === "procedural" || source === "uploaded";
}

/** The one honest line each source may print beside the rhythm channels.
 * ASCII (panel-font law); consumers render verbatim. DRAFTED-BY-CLAUDE —
 * founder VETO/REWRITE via docs/COPY-WORKSHEET.md F.29. */
export const MUSIC_SOURCE_SCORING_NOTE: Record<MusicSourceKind, string> = {
  procedural: "The beat you hear is the beat we score.",
  uploaded: "Your track's measured beat is the beat we score.",
  system: "Your music plays; your score follows the coach's beat.",
  streaming: "Your music plays; your score follows the coach's beat.",
};

export function loadMusicSource(): MusicSourcePrefs {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return sanitizeMusicSource(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_MUSIC_SOURCE };
  }
}

export function saveMusicSource(p: MusicSourcePrefs): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(sanitizeMusicSource(p)));
  } catch {
    /* storage unavailable (private mode) — session-only prefs are fine */
  }
}
