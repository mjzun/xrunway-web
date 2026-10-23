import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MODES } from "../src/modes.ts";

// THE LEVEL ACCESS LOCK (founder ruling 2026-07-15, the exec-review coach P0):
// the product promises a beginner AND an emerging tier, but the mode selector
// was hidden on BOTH surfaces - every trainee silently got BEGINNER WALK.
// EMERGING must stay reachable: in-headset via the settings LEVEL toggle pill
// (set-level, on the floor-glow row so settings - the panel's aspect-bound
// tallest state - gains ZERO height), and on the desktop landing via the
// unhidden #mode-select. Only the two founder-named tiers are offered; the
// legacy commercial/challenge chips stay hidden (their labels also overflow
// the panel header title box - the in-file width caveat).

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const uikitml = read("../ui/lesson.uikitml");
const hud = read("../src/hud.ts");
const html = read("../index.html");

describe("in-headset LEVEL toggle (ui/lesson.uikitml + src/hud.ts)", () => {
  it("the settings panel carries the LEVEL pill on the floor-glow row", () => {
    expect(uikitml).toContain('id="set-level"');
    // Zero-height law: set-level shares a set-row with set-floorfx (settings
    // must not grow - it is the aspect-bound tallest state).
    const row = uikitml.slice(
      uikitml.lastIndexOf("<div", uikitml.indexOf('id="set-level"')),
      uikitml.indexOf("</div>", uikitml.indexOf('id="set-floorfx"')),
    );
    expect(row).toContain('id="set-level"');
    expect(row).toContain('id="set-floorfx"');
  });

  it("hud.ts wires the toggle through the SAME setMode path as the retired chips", () => {
    expect(hud).toContain('this.onClick("set-level"');
    expect(hud).toContain('this.setMode(cur.id === "beginner" ? 1 : 0)');
    // The pill names the ACTIVE tier (updateModeUI repaints it on mode change).
    expect(hud).toContain("this.levelBtn?.setProperties({ text: `Level: ${LEVEL_LABELS[cur.id]}` })");
  });

  it("LEVEL_LABELS names every mode id honestly (a stale pref never lies)", () => {
    for (const m of MODES) {
      expect(hud, m.id).toContain(`${m.id}: "`);
    }
    expect(hud).toContain('highfashion: "Emerging"');
  });
});

describe("desktop LEVEL selector (index.html #mode-select)", () => {
  const sel = html.slice(
    html.indexOf('id="mode-select"'),
    html.indexOf("</div>", html.indexOf("CHALLENGE")),
  );

  it("the selector itself is UNHIDDEN (the USER FLOW step-02 promise is real)", () => {
    // The container tag must not carry the hidden attribute.
    const openTag = html.slice(
      html.lastIndexOf("<div", html.indexOf('id="mode-select"')),
      html.indexOf(">", html.indexOf('id="mode-select"')),
    );
    expect(openTag).not.toMatch(/\bhidden\b/);
  });

  it("only the two founder-named tiers show; legacy chips stay hidden", () => {
    const chip = (mode: string): string =>
      sel.slice(
        sel.lastIndexOf("<button", sel.indexOf(`data-mode="${mode}"`)),
        sel.indexOf(">", sel.indexOf(`data-mode="${mode}"`)),
      );
    expect(chip("beginner")).not.toMatch(/\bhidden\b/);
    expect(chip("highfashion")).not.toMatch(/\bhidden\b/);
    expect(chip("commercial")).toMatch(/\bhidden\b/);
    expect(chip("challenge")).toMatch(/\bhidden\b/);
  });
});
