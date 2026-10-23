import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  cycleWalkSeconds,
  DEFAULT_WALK,
  resolveWalkSeconds,
  sanitizeWalkPrefs,
  sanitizeWalkSeconds,
  WALK_SECONDS_OPTIONS,
  walkSecondsLabel,
} from "../src/walk-prefs.ts";

// The user-set walk duration (founder call 2026-07-09: range 10-60 s,
// default = the mode's own 20). The pref module follows music-prefs.ts;
// this suite follows music-prefs.test.ts: sanitize/resolve/cycle laws,
// ASCII label pins per surface, and — because show.ts and hud.ts import
// @iwsdk/core and can't load under vitest — SOURCE-TEXT seam pins on the
// injection point and the pill wiring (the beat-wiring.test.ts precedent).

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const MODE_20 = { walkSeconds: 20 };

describe("sanitizing", () => {
  it("accepts exactly the option set", () => {
    for (const s of WALK_SECONDS_OPTIONS) expect(sanitizeWalkSeconds(s)).toBe(s);
  });

  it("falls back to null (mode default) on anything else — no rounding", () => {
    for (const junk of [25, 0, -10, 61, 9, "20", 20.5, null, undefined, {}]) {
      expect(sanitizeWalkSeconds(junk)).toBeNull();
    }
    expect(sanitizeWalkPrefs({ seconds: 999 })).toEqual({ seconds: null });
    expect(sanitizeWalkPrefs("garbage")).toEqual({ seconds: null });
  });

  it("the founder's range law: every option sits inside 10-60 with 20 present", () => {
    for (const s of WALK_SECONDS_OPTIONS) {
      expect(s).toBeGreaterThanOrEqual(10);
      expect(s).toBeLessThanOrEqual(60);
    }
    expect(WALK_SECONDS_OPTIONS).toContain(20);
  });
});

describe("resolve + cycle", () => {
  it("null resolves to the mode's own walkSeconds (default 20)", () => {
    expect(resolveWalkSeconds(DEFAULT_WALK, MODE_20)).toBe(20);
    expect(resolveWalkSeconds({ seconds: 45 }, MODE_20)).toBe(45);
  });

  it("cycles one visible step from the RESOLVED value (the cycleMusicBpm law)", () => {
    // From the unset default (resolves 20) the first tap lands on 30.
    expect(cycleWalkSeconds(DEFAULT_WALK, MODE_20)).toEqual({ seconds: 30 });
    // Full ring: 10 -> 15 -> 20 -> 30 -> 45 -> 60 -> 10.
    let p = { seconds: 10 as const } as ReturnType<typeof cycleWalkSeconds>;
    const seen: number[] = [10];
    for (let i = 0; i < WALK_SECONDS_OPTIONS.length; i++) {
      p = cycleWalkSeconds(p, MODE_20);
      seen.push(p.seconds as number);
    }
    expect(seen).toEqual([10, 15, 20, 30, 45, 60, 10]);
  });

  it("a non-option mode default restarts the ring instead of throwing", () => {
    expect(cycleWalkSeconds({ seconds: null }, { walkSeconds: 25 })).toEqual({
      seconds: 10,
    });
  });

  it("never cycles back to auto — an explicit value is always stored", () => {
    let p: { seconds: (typeof WALK_SECONDS_OPTIONS)[number] | null } =
      DEFAULT_WALK;
    for (let i = 0; i < 12; i++) {
      p = cycleWalkSeconds(p, MODE_20);
      expect(p.seconds).not.toBeNull();
    }
  });
});

describe("labels (the panel law: ASCII, per-surface case)", () => {
  it("XR pill: sentence case, pinned", () => {
    expect(walkSecondsLabel(DEFAULT_WALK, MODE_20, "xr")).toBe("Duration: 20s");
    expect(walkSecondsLabel({ seconds: 45 }, MODE_20, "xr")).toBe(
      "Duration: 45s",
    );
  });

  it("landing: shouts upper-case", () => {
    expect(walkSecondsLabel({ seconds: 60 }, MODE_20, "landing")).toBe(
      "DURATION: 60S",
    );
  });

  it("every label over every option is printable ASCII", () => {
    for (const s of WALK_SECONDS_OPTIONS) {
      for (const surface of ["xr", "landing"] as const) {
        expect(walkSecondsLabel({ seconds: s }, MODE_20, surface)).toMatch(
          /^[\x20-\x7E]+$/,
        );
      }
    }
  });
});

describe("the wiring seams (source-text pins — show.ts/hud.ts aren't vitest-loadable)", () => {
  it("the show director resolves the pref at its startRun mode lock", () => {
    const show = read("../src/show.ts");
    expect(show).toContain("resolveWalkSeconds(");
    expect(show).toContain(
      "secs === base.walkSeconds ? base : { ...base, walkSeconds: secs }",
    );
    // The configured-duration stamp rides the summary (the musicBpm law).
    expect(show).toContain("walkSecondsSet: this.runMode.walkSeconds");
  });

  it("the recorder persists the configured stamp beside the measured time", () => {
    const rec = read("../src/session-recorder.ts");
    expect(rec).toContain(
      "this.current.walkSecondsSet = summary.walkSecondsSet ?? null;",
    );
    expect(rec).toContain("walkSecondsSet: this.current.walkSecondsSet,");
  });

  it("the hud wires the pill and resolves the idle TIME stamp via the pref", () => {
    const hud = read("../src/hud.ts");
    expect(hud).toContain('this.el<UIKit.Text>("set-duration")');
    expect(hud).toContain('this.onClick("set-duration", () =>');
    expect(hud).toContain("cycleWalkSeconds(");
    expect(hud).toContain(
      "resolveWalkSeconds(this.walkPrefsSig?.peek() ?? DEFAULT_WALK, this.mode)",
    );
    const uikitml = read("../ui/lesson.uikitml");
    expect(uikitml).toContain('id="set-duration"');
  });

  it("the landing wires its picker off the SAME signal + cycle as the XR pill", () => {
    // The web twin (queued on landing.ts going clean, shipped 2026-07-10):
    // one signal, one cycle helper, per-surface label — the two surfaces
    // can never disagree on the chosen length.
    const landing = read("../src/landing.ts");
    expect(landing).toContain('byId<HTMLButtonElement>("duration-btn")');
    expect(landing).toContain("cycleWalkSeconds(");
    expect(landing).toContain('"landing",');
    const html = read("../index.html");
    expect(html).toContain('id="duration-btn"');
  });

  it("the prefs signal is published + persisted at world init", () => {
    const index = read("../src/index.ts");
    expect(index).toContain("g.walkPrefs = walkPrefsSig;");
    expect(index).toContain(
      "walkPrefsSig.subscribe((p) => saveWalkPrefs(p))",
    );
  });
});
