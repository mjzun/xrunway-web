import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  WALK_CARD_H,
  WALK_CARD_TAGLINE,
  WALK_CARD_W,
  walkCardFilename,
  type WalkCardData,
} from "../src/walk-card.js";
import { SHARE_CARD_NOTE, SHARE_CARD_PILL } from "../src/hud-copy.js";

// THE WALK CARD (share build): the pure pieces + every wiring seam pinned
// (the dead-pill lesson). The PNG pixels themselves are verified headlessly
// against a real walk (tmp-convert/walk-card-verify.mjs — dims + brand
// pixels + non-blank), not here.

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const DATA: WalkCardData = {
  overall: 86.4,
  medal: "gold",
  pace: 88,
  carriage: 97,
  line: 100,
  shapeKind: "straight",
  runwayLength: 7,
  runwayWidth: 1.4,
  dateIso: "2026-07-22",
};

describe("walk card: the pure pieces", () => {
  it("is the og.png share format (1200x630) with the ruled tagline", () => {
    expect(WALK_CARD_W).toBe(1200);
    expect(WALK_CARD_H).toBe(630);
    expect(WALK_CARD_TAGLINE).toBe("Take the next step.");
  });

  it("filename carries the date + rounded score", () => {
    expect(walkCardFilename(DATA)).toBe("xrunway-walk-2026-07-22-86.png");
  });

  it("the headset pill copy is ASCII and honest (no fake share verb)", () => {
    for (const s of [SHARE_CARD_PILL, SHARE_CARD_NOTE]) {
      expect(s).toMatch(/^[\x20-\x7e]+$/);
    }
    expect(SHARE_CARD_NOTE).toContain("WEB");
  });
});

describe("walk card: the wiring seams (file-scan pins)", () => {
  const html = read("../index.html");
  const landing = read("../src/landing.ts");
  const hud = read("../src/hud.ts");
  const uikitml = read("../ui/lesson.uikitml");

  it("web summary: SHARE CARD exists, hidden-paired, and landing wires it", () => {
    expect(html).toContain('id="sum-share"');
    expect(html).toMatch(/#sum-share\[hidden\]/);
    expect(landing).toContain('byId("sum-share")');
    expect(landing).toContain("buildWalkCardBlob");
    expect(landing).toContain("walkCardFilename");
    expect(landing).toContain("lastWalkCard = {");
    // Share where possible, download otherwise, AbortError is not a failure.
    expect(landing).toContain("canShare");
    expect(landing).toContain("AbortError");
  });

  it("XR panel: the honest pill exists, hud swaps + reverts the label", () => {
    expect(uikitml).toContain('id="share-button"');
    expect(hud).toContain('this.onClick("share-button"');
    expect(hud).toContain("SHARE_CARD_NOTE");
    expect(hud).toContain("SHARE_CARD_PILL");
    expect(hud).toContain("shareNoteRemaining");
  });
});
