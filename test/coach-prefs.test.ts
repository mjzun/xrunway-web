import { describe, expect, it } from "vitest";

import {
  DEFAULT_COACH,
  loadCoachPrefs,
  sanitizeCoachPrefs,
  saveCoachPrefs,
} from "../src/coach-prefs.ts";

describe("coach prefs", () => {
  it("defaults to OFF (coach is text-only — the spoken system is un-registered)", () => {
    expect(DEFAULT_COACH).toEqual({ enabled: false });
    // node has no localStorage — load falls back to the default
    expect(loadCoachPrefs()).toEqual(DEFAULT_COACH);
  });

  it("sanitize hard-pins the voice OFF - even a stored enabled:true (founder ruling 2026-07-16: coach voice dropped entirely)", () => {
    expect(sanitizeCoachPrefs({ enabled: false })).toEqual({ enabled: false });
    expect(sanitizeCoachPrefs({ enabled: true })).toEqual({ enabled: false });
  });

  it("sanitize repairs junk (old schema, manual edits) to the default", () => {
    expect(sanitizeCoachPrefs(null)).toEqual(DEFAULT_COACH);
    expect(sanitizeCoachPrefs("off")).toEqual(DEFAULT_COACH);
    expect(sanitizeCoachPrefs({ enabled: "no" })).toEqual(DEFAULT_COACH);
    expect(sanitizeCoachPrefs({ volume: 0.5 })).toEqual(DEFAULT_COACH);
  });

  it("save is non-fatal without localStorage", () => {
    expect(() => saveCoachPrefs({ enabled: false })).not.toThrow();
  });
});
