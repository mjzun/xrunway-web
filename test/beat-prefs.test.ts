import { describe, expect, it } from "vitest";

import {
  beatPrefsLabel,
  cycleBeatPrefs,
  DEFAULT_BEAT,
  loadBeatPrefs,
  sanitizeBeatPrefs,
} from "../src/beat-prefs.ts";

describe("beat prefs", () => {
  it("defaults to countdown on, walk off (walk pulses are a scored condition)", () => {
    expect(DEFAULT_BEAT).toEqual({ countdown: true, walk: false });
    // node has no localStorage — load falls back to the default
    expect(loadBeatPrefs()).toEqual(DEFAULT_BEAT);
  });

  it("sanitize passes every boolean combination through (any combo is legal)", () => {
    for (const countdown of [false, true]) {
      for (const walk of [false, true]) {
        expect(sanitizeBeatPrefs({ countdown, walk })).toEqual({
          countdown,
          walk,
        });
      }
    }
  });

  it("sanitize repairs junk (old schema, manual edits) to the defaults", () => {
    expect(sanitizeBeatPrefs(null)).toEqual(DEFAULT_BEAT);
    expect(sanitizeBeatPrefs(undefined)).toEqual(DEFAULT_BEAT);
    expect(sanitizeBeatPrefs("pulse")).toEqual(DEFAULT_BEAT);
    expect(sanitizeBeatPrefs({ countdown: "yes", walk: 1 })).toEqual(
      DEFAULT_BEAT,
    );
  });

  it("sanitize repairs per-field (a valid field survives a junk sibling)", () => {
    expect(sanitizeBeatPrefs({ countdown: false, walk: "on" })).toEqual({
      countdown: false,
      walk: DEFAULT_BEAT.walk,
    });
    expect(sanitizeBeatPrefs({ walk: true })).toEqual({
      countdown: DEFAULT_BEAT.countdown,
      walk: true,
    });
  });
});

describe("beat prefs settings cycle (spec §4.6 — shared by landing + XR)", () => {
  it("cycles OFF -> COUNTDOWN -> WALK + COUNTDOWN -> OFF", () => {
    const off = { countdown: false, walk: false };
    const cd = cycleBeatPrefs(off);
    expect(cd).toEqual({ countdown: true, walk: false });
    const both = cycleBeatPrefs(cd);
    expect(both).toEqual({ countdown: true, walk: true });
    expect(cycleBeatPrefs(both)).toEqual(off);
  });

  it("a manual walk-only edit sits on the most-delivery step: cycles to OFF", () => {
    expect(cycleBeatPrefs({ countdown: false, walk: true })).toEqual({
      countdown: false,
      walk: false,
    });
  });
});

describe("beat prefs labels (spec §6 — exact strings, ASCII)", () => {
  const ASCII = /^[\x20-\x7E]+$/;

  it("landing labels shout the full state", () => {
    expect(beatPrefsLabel({ countdown: false, walk: false }, "landing")).toBe(
      "BEAT PULSE: OFF",
    );
    expect(beatPrefsLabel({ countdown: true, walk: false }, "landing")).toBe(
      "BEAT PULSE: COUNTDOWN",
    );
    expect(beatPrefsLabel({ countdown: true, walk: true }, "landing")).toBe(
      "BEAT PULSE: WALK + COUNTDOWN",
    );
    // a manual walk-only combination is labeled honestly (no "+ COUNTDOWN")
    expect(beatPrefsLabel({ countdown: false, walk: true }, "landing")).toBe(
      "BEAT PULSE: WALK",
    );
  });

  it("XR pill labels stay short in the set-music sentence case", () => {
    expect(beatPrefsLabel({ countdown: false, walk: false }, "xr")).toBe(
      "Beat pulse: off",
    );
    expect(beatPrefsLabel({ countdown: true, walk: false }, "xr")).toBe(
      "Beat pulse: countdown",
    );
    expect(beatPrefsLabel({ countdown: true, walk: true }, "xr")).toBe(
      "Beat pulse: walk",
    );
    expect(beatPrefsLabel({ countdown: false, walk: true }, "xr")).toBe(
      "Beat pulse: walk",
    );
  });

  it("every label on every state/surface is printable ASCII (the panel law)", () => {
    for (const countdown of [false, true]) {
      for (const walk of [false, true]) {
        for (const surface of ["landing", "xr"] as const) {
          expect(beatPrefsLabel({ countdown, walk }, surface)).toMatch(ASCII);
        }
      }
    }
  });
});
