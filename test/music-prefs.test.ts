import { describe, expect, it } from "vitest";

import {
  cycleMusicBpm,
  DEFAULT_MUSIC,
  loadMusicPrefs,
  MODE_DEFAULT_BPM,
  MUSIC_BPM_OPTIONS,
  musicBpmLabel,
  musicBpmNote,
  resolveMusicBpm,
  sanitizeMusicBpm,
  sanitizeMusicPrefs,
} from "../src/music-prefs.ts";

describe("music prefs", () => {
  it("defaults to on at 0.7, tempo unset (mode default)", () => {
    expect(DEFAULT_MUSIC).toEqual({ enabled: true, volume: 0.7, bpm: null });
    // node has no localStorage — load falls back to the default
    expect(loadMusicPrefs()).toEqual(DEFAULT_MUSIC);
  });

  it("sanitize passes valid prefs through", () => {
    expect(
      sanitizeMusicPrefs({ enabled: false, volume: 0.25, bpm: 62 }),
    ).toEqual({ enabled: false, volume: 0.25, bpm: 62 });
    expect(sanitizeMusicPrefs({ enabled: true, volume: 0, bpm: null })).toEqual(
      { enabled: true, volume: 0, bpm: null },
    );
  });

  it("sanitize clamps volume into 0..1", () => {
    expect(sanitizeMusicPrefs({ enabled: true, volume: 1.8 }).volume).toBe(1);
    expect(sanitizeMusicPrefs({ enabled: true, volume: -0.3 }).volume).toBe(0);
  });

  it("sanitize repairs junk (old schema, manual edits) to the defaults", () => {
    expect(sanitizeMusicPrefs(null)).toEqual(DEFAULT_MUSIC);
    expect(sanitizeMusicPrefs("loud")).toEqual(DEFAULT_MUSIC);
    expect(sanitizeMusicPrefs({ enabled: "yes", volume: "11" })).toEqual(
      DEFAULT_MUSIC,
    );
    expect(sanitizeMusicPrefs({ volume: Number.NaN }).volume).toBe(
      DEFAULT_MUSIC.volume,
    );
  });

  it("a pre-tempo stored pref (no bpm field) reads as tempo-unset", () => {
    // The exact object an existing install has under xrunway.music.v1.
    expect(sanitizeMusicPrefs({ enabled: true, volume: 0.5 })).toEqual({
      enabled: true,
      volume: 0.5,
      bpm: null,
    });
  });
});

describe("music tempo (the multi-BPM founder call)", () => {
  it("the three deliverable tempos, in cycle order", () => {
    expect(MUSIC_BPM_OPTIONS).toEqual([62, 100, 125]);
  });

  it("sanitizeMusicBpm whitelists the options, everything else -> null", () => {
    expect(sanitizeMusicBpm(62)).toBe(62);
    expect(sanitizeMusicBpm(100)).toBe(100);
    expect(sanitizeMusicBpm(125)).toBe(125);
    expect(sanitizeMusicBpm(122)).toBeNull(); // the legacy engine tempo is NOT deliverable
    expect(sanitizeMusicBpm("125")).toBeNull();
    expect(sanitizeMusicBpm(null)).toBeNull();
    expect(sanitizeMusicBpm(undefined)).toBeNull();
  });

  it("mode defaults: beginner -> 100, EMERGING (highfashion) -> 125", () => {
    // The founder's calls (2026-07-08). commercial/challenge are provisional.
    expect(MODE_DEFAULT_BPM.beginner).toBe(100);
    expect(MODE_DEFAULT_BPM.highfashion).toBe(125);
    expect(MODE_DEFAULT_BPM.commercial).toBe(100);
    expect(MODE_DEFAULT_BPM.challenge).toBe(125);
  });

  it("resolve: explicit pref wins; unset follows the mode; unknown mode -> 100", () => {
    const unset = { ...DEFAULT_MUSIC };
    expect(resolveMusicBpm(unset, "beginner")).toBe(100);
    expect(resolveMusicBpm(unset, "highfashion")).toBe(125);
    expect(resolveMusicBpm(unset, null)).toBe(100);
    expect(resolveMusicBpm(unset, "junk-mode")).toBe(100);
    expect(resolveMusicBpm({ ...unset, bpm: 62 }, "highfashion")).toBe(62);
  });

  it("cycle: 62 -> 100 -> 125 -> 62, starting from the RESOLVED tempo", () => {
    const unset = { ...DEFAULT_MUSIC };
    // First cycle from a beginner default (100) lands on 125, stored explicitly.
    const first = cycleMusicBpm(unset, "beginner");
    expect(first.bpm).toBe(125);
    expect(cycleMusicBpm(first, "beginner").bpm).toBe(62);
    expect(cycleMusicBpm({ ...unset, bpm: 62 }, "beginner").bpm).toBe(100);
    // First cycle from an EMERGING default (125) wraps to 62.
    expect(cycleMusicBpm(unset, "highfashion").bpm).toBe(62);
    // Other fields ride through untouched.
    const p = cycleMusicBpm({ enabled: false, volume: 0.2, bpm: 100 }, null);
    expect(p).toEqual({ enabled: false, volume: 0.2, bpm: 125 });
  });

  it("labels: landing shouts, the XR pill stays sentence-case (the panel law)", () => {
    const unset = { ...DEFAULT_MUSIC };
    expect(musicBpmLabel(unset, "beginner", "landing")).toBe("MUSIC BPM: 100");
    expect(musicBpmLabel(unset, "highfashion", "xr")).toBe("Music BPM: 125");
    expect(musicBpmLabel({ ...unset, bpm: 62 }, "beginner", "xr")).toBe(
      "Music BPM: 62",
    );
    // ASCII only — the XR strings enter the panel sweep.
    for (const bpm of MUSIC_BPM_OPTIONS) {
      const xr = musicBpmLabel({ ...unset, bpm }, null, "xr");
      expect(/^[\x20-\x7E]*$/.test(xr)).toBe(true);
    }
  });

  it("the founder's option notes are pinned VERBATIM (the no-AI-text law)", () => {
    expect(musicBpmNote(62)).toBe("half time of the emerging level speed");
    expect(musicBpmNote(100)).toBe("everyday walking speed or leisure");
    expect(musicBpmNote(125)).toBe(
      "emerging level walking speed (industry standard)",
    );
  });
});
