import { describe, expect, it } from "vitest";

import {
  DEFAULT_MUSIC_SOURCE,
  MUSIC_SOURCE_SCORING_NOTE,
  beatLockAvailable,
  sanitizeMusicSource,
} from "../src/music-source.ts";

// The MusicSource seam (docs/MUSIC-INTEGRATION.md, 2026-07-16): one provider
// switch whose beat-lock authority keeps the scoring grid honest about
// whether it IS the audible music. Verified constraints behind the law:
// streamed audio has no tempo metadata, no audio tap, coarse clocks, and TOS
// bans on synchronization — so only procedural + uploaded may beat-lock.

describe("music source seam", () => {
  it("defaults to procedural with streaming dark", () => {
    expect(DEFAULT_MUSIC_SOURCE).toEqual({
      source: "procedural",
      streamingEnabled: false,
    });
  });

  it("sanitize repairs junk to the default", () => {
    expect(sanitizeMusicSource(null)).toEqual(DEFAULT_MUSIC_SOURCE);
    expect(sanitizeMusicSource("spotify")).toEqual(DEFAULT_MUSIC_SOURCE);
    expect(sanitizeMusicSource({ source: "vinyl" })).toEqual(DEFAULT_MUSIC_SOURCE);
  });

  it("a stored streaming source cannot resurrect the dark feature", () => {
    expect(sanitizeMusicSource({ source: "streaming" }).source).toBe("procedural");
    expect(
      sanitizeMusicSource({ source: "streaming", streamingEnabled: true }).source,
    ).toBe("streaming");
  });

  it("beat-lock is available ONLY for sources the app controls or measured", () => {
    expect(beatLockAvailable("procedural")).toBe(true);
    expect(beatLockAvailable("uploaded")).toBe(true);
    expect(beatLockAvailable("system")).toBe(false);
    expect(beatLockAvailable("streaming")).toBe(false);
  });

  it("every source carries an ASCII scoring note, and un-lockable sources never claim the beat", () => {
    for (const [kind, note] of Object.entries(MUSIC_SOURCE_SCORING_NOTE)) {
      expect(note.length).toBeGreaterThan(0);
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(note), note).toBe(true);
      if (!beatLockAvailable(kind as never)) {
        expect(note).toContain("coach's beat");
      }
    }
  });
});
