import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import * as beatStatsModule from "../src/beat-stats.js";
import * as holdStatsModule from "../src/hold-stats.js";
import * as hudCopy from "../src/hud-copy.js";
import * as turnStatsModule from "../src/turn-stats.js";

// POLISH-AUDIT #31: the XR panel's MSDF font has NO middle-dot, em-dash or
// curly-quote glyphs — any non-ASCII character that reaches the panel renders
// as a tofu box. ui/lesson.uikitml wrote the rule down in its header; this
// test ENFORCES it, over both the markup source and every string exported by
// src/hud-copy.ts (the single home for dynamic panel copy).

/** Printable ASCII only (space..tilde). Newlines are not expected either —
 * panel copy is single-line strings that uikit wraps itself. */
const ASCII = /^[\x20-\x7E]*$/;

/** Recursively collect every string reachable from a module export. */
function collectStrings(value: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof value === "string") {
    out.push([path, value]);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => collectStrings(v, `${path}[${i}]`, out));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      collectStrings(v, `${path}.${k}`, out);
    }
  }
}

describe("panel ASCII rule (#31)", () => {
  it("ui/lesson.uikitml contains printable-ASCII characters only", () => {
    const file = fileURLToPath(new URL("../ui/lesson.uikitml", import.meta.url));
    const lines = readFileSync(file, "utf8").split("\n");
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (!ASCII.test(line)) {
        offenders.push(`line ${i + 1}: ${line.trim()}`);
      }
    });
    expect(offenders).toEqual([]);
  });

  it("every string exported by src/hud-copy.ts is non-empty printable ASCII", () => {
    const strings: Array<[string, string]> = [];
    for (const [name, value] of Object.entries(hudCopy)) {
      collectStrings(value, name, strings);
    }
    // The module must actually export panel copy (guards a bad refactor that
    // empties it and silently disables this test).
    expect(strings.length).toBeGreaterThan(0);
    for (const [path, s] of strings) {
      expect(s.trim(), `${path} must not be blank`).not.toBe("");
      expect(s, `${path} must be printable ASCII, got: ${JSON.stringify(s)}`).toMatch(ASCII);
    }
  });

  it("keeps the mid-walk turn cue em-dash-free (founder C9.1 verbatim)", () => {
    expect(hudCopy.TURN_BACK_CUE).toBe("Pose... then walk back");
  });

  it("every string exported by src/hold-stats.ts is non-empty printable ASCII (M10 panel copy)", () => {
    // The M10 summary line reaches the XR panel (sum-hold) — its module-level
    // strings enter the sweep. The per-branch OUTPUTS of holdStatLine/holdCue
    // are exact-string pinned (incl. an ASCII sweep) in hold-stats.test.ts.
    const strings: Array<[string, string]> = [];
    for (const [name, value] of Object.entries(holdStatsModule)) {
      collectStrings(value, `hold-stats.${name}`, strings);
    }
    expect(strings.length).toBeGreaterThan(0); // HOLD_EXPLAIN at minimum
    for (const [path, s] of strings) {
      expect(s.trim(), `${path} must not be blank`).not.toBe("");
      expect(s, `${path} must be printable ASCII, got: ${JSON.stringify(s)}`).toMatch(ASCII);
    }
  });

  it("every string exported by src/beat-stats.ts is non-empty printable ASCII (M9 panel copy)", () => {
    // The M9 summary line reaches the XR panel (sum-beat) — its module-level
    // strings (BEAT_EXPLAIN / BEAT_SETTING_TIP at minimum) enter the sweep.
    // The per-branch OUTPUTS of beatStatLine/beatCue are exact-string pinned
    // in beat-stats.test.ts; the settings pill labels in beat-prefs.test.ts.
    const strings: Array<[string, string]> = [];
    for (const [name, value] of Object.entries(beatStatsModule)) {
      collectStrings(value, `beat-stats.${name}`, strings);
    }
    expect(strings.length).toBeGreaterThan(0);
    for (const [path, s] of strings) {
      expect(s.trim(), `${path} must not be blank`).not.toBe("");
      expect(s, `${path} must be printable ASCII, got: ${JSON.stringify(s)}`).toMatch(ASCII);
    }
  });

  it("every string exported by src/turn-stats.ts is non-empty printable ASCII (M11 panel copy)", () => {
    // The M11 summary line reaches the XR panel (sum-turn) — its module-level
    // strings (TURN_EXPLAIN / PRESENTATION_EXPLAIN_WITH_TURN at minimum)
    // enter the sweep. The per-branch OUTPUTS of turnStatLine/turnCue are
    // exact-string pinned (incl. their own ASCII sweep) in turn-stats.test.ts.
    const strings: Array<[string, string]> = [];
    for (const [name, value] of Object.entries(turnStatsModule)) {
      collectStrings(value, `turn-stats.${name}`, strings);
    }
    expect(strings.length).toBeGreaterThan(0);
    for (const [path, s] of strings) {
      expect(s.trim(), `${path} must not be blank`).not.toBe("");
      expect(s, `${path} must be printable ASCII, got: ${JSON.stringify(s)}`).toMatch(ASCII);
    }
  });
});
