import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MEDAL_POP_SEC } from "../src/hud-copy.js";
import { REVEAL_DELAY_SEC } from "../src/sfx-timeline.js";

// The MEDAL moment's WEB TWIN (the in-headset badge shipped 2026-07-09;
// this landing mirror was queued on landing.ts going clean). File-scan the
// wiring seams — the scoring-copy review's lesson: a dead pill can ship
// green unless the markup AND the consumer wiring are both pinned.

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("landing medal badge (the web twin of the panel medal)", () => {
  const html = read("../index.html");
  const landing = read("../src/landing.ts");

  it("the summary card carries the badge beside the verdict", () => {
    const card = html.slice(html.indexOf('id="summary-card"'));
    expect(card).toContain('id="sum-medal"');
    // Beside the verdict: both pills inside the same verdict-row wrapper.
    const row = card.slice(
      card.indexOf('class="verdict-row"'),
      card.indexOf("</span>", card.indexOf('id="sum-medal"')),
    );
    expect(row).toContain('id="sum-verdict"');
    expect(row).toContain('id="sum-medal"');
  });

  it("hidden is paired with the !important display rule (the CSS-specificity lesson)", () => {
    expect(html).toMatch(/\.sum-medal\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });

  it("the pop animation carries the panel's exact timing anchors", () => {
    // delay = REVEAL_DELAY_SEC (the graded sting's reveal anchor), duration
    // = MEDAL_POP_SEC — the two surfaces pop as one moment. Drift either
    // constant without this CSS and the twins desync silently.
    expect(html).toContain(
      `animation: medal-pop ${MEDAL_POP_SEC}s ease-out ${REVEAL_DELAY_SEC}s backwards`,
    );
    expect(html).toContain("@keyframes medal-pop");
  });

  it("landing.ts wires the badge from the same scoreMedal read as the panel", () => {
    expect(landing).toContain('byId("sum-medal")');
    expect(landing).toContain("scoreMedal(medalRank(s.overall, traineeRows))");
    expect(landing).toContain("MEDAL_LABEL[medal]");
    expect(landing).toContain("MEDAL_COLOR[medal]");
  });
});
