import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MEDAL_RANK_NOTE } from "../src/hud-copy.js";

// F.24 (2026-07-13, a teacher-review P0): the summary MEDAL is a RANK among
// the trainee's own walks (best = gold), DECOUPLED from the PASS / NEEDS WORK
// verdict — so a first/best walk golds beside NEEDS WORK. Its meaning used to
// live ONLY in a code comment; beginners read the pairing as a contradiction.
// This pins the ONE clarifying caption on BOTH surfaces (XR panel + landing)
// and that it conveys rank-not-bar. Golden-neutral / display-only.

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** The caption conveys "a personal RANK among your own walks, best = gold,
 * NOT the pass bar" — asserted structurally so a reword that keeps the meaning
 * still passes, but dropping any of the three ideas fails. */
function conveysRankNotBar(s: string): boolean {
  const t = s.toLowerCase();
  const ranksOwnWalks = t.includes("rank") && t.includes("your own walk");
  const bestIsGold = t.includes("gold");
  const notAPass = t.includes("not a pass") || t.includes("not the pass");
  return ranksOwnWalks && bestIsGold && notAPass;
}

describe("ranking-medal caption (F.24)", () => {
  it("MEDAL_RANK_NOTE is one short ASCII line that conveys rank-not-bar", () => {
    // ASCII only (the XR panel MSDF font has no em-dash / smart-quote glyphs);
    // panel-ascii.test.ts sweeps this too, pinned here for locality.
    expect(MEDAL_RANK_NOTE).toMatch(/^[\x20-\x7E]+$/);
    // Single line — uikit wraps it itself (no embedded newline).
    expect(MEDAL_RANK_NOTE).not.toContain("\n");
    expect(conveysRankNotBar(MEDAL_RANK_NOTE)).toBe(true);
  });

  it("the XR panel carries #medal-note, styled + wired from MEDAL_RANK_NOTE", () => {
    const markup = read("../ui/lesson.uikitml");
    const hud = read("../src/hud.ts");
    // The caption element lives in the summary section, after the verdict.
    const summary = markup.slice(markup.indexOf('id="summary-section"'));
    expect(summary).toContain('id="medal-note"');
    const verdictAt = summary.indexOf('id="sum-verdict"');
    const noteAt = summary.indexOf('id="medal-note"');
    const deltaAt = summary.indexOf('id="delta-line"');
    expect(verdictAt).toBeGreaterThanOrEqual(0);
    expect(noteAt).toBeGreaterThan(verdictAt); // sits under the verdict
    expect(deltaAt).toBeGreaterThan(noteAt); // above the delta line
    // Default-hidden, revealed only when a medal shows (the sum-carriage law).
    expect(markup).toMatch(/#medal-note\s*\{[^}]*display:\s*none/);
    // hud.ts caches it and writes the shared copy constant into it.
    expect(hud).toContain('this.el<UIKit.Text>("medal-note")');
    expect(hud).toContain("text: MEDAL_RANK_NOTE");
  });

  it("the landing carries #medal-note beside the verdict, gated by the medal", () => {
    const html = read("../index.html");
    const landing = read("../src/landing.ts");
    const card = html.slice(html.indexOf('id="summary-card"'));
    expect(card).toContain('id="medal-note"');
    // Static copy in the markup, verbatim-identical to the panel constant so
    // both surfaces teach the same line.
    expect(card).toContain(MEDAL_RANK_NOTE);
    // Extract the element's own text and assert it conveys rank-not-bar.
    const openAt = card.indexOf('id="medal-note"');
    const textStart = card.indexOf(">", openAt) + 1;
    const textEnd = card.indexOf("</span>", textStart);
    expect(conveysRankNotBar(card.slice(textStart, textEnd))).toBe(true);
    // landing.ts caches it and toggles it with the medal's presence.
    expect(landing).toContain('byId("medal-note")');
    expect(landing).toContain("medalNote.hidden = medal === null");
  });
});
