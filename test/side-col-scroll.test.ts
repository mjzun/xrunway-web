import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// THE CLIPPING REGRESSION LOCK (founder raised the cut-off right column
// repeatedly): #landing is a position:fixed overlay that never scrolls, so
// on desktop the side column MUST scroll itself, and — the half every prior
// attempt missed — it must opt back into pointer events, or the overlay's
// pointer-events:none swallows the wheel and the "scrollable" column clips
// anyway. Verified live 2026-07-10 (wheel-to-bottom on a 700px viewport).
// If any of these pins go red, content taller than the viewport is being
// CUT OFF again. Do not delete a pin to make a refactor pass — re-verify
// scrolling end-to-end instead.

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("desktop side-column scroll (the cut-off fix)", () => {
  const html = read("../index.html");
  // The base #side-col rule (desktop): slice from its selector to the next
  // rule block that follows its helpers.
  const start = html.indexOf("      #side-col {");
  const slice = html.slice(start, html.indexOf("#hero {", start));

  it("the column scrolls itself on desktop", () => {
    expect(start).toBeGreaterThan(-1);
    // 2026-07-13: the cap is now the VIEWPORT height (calc(100dvh - Npx)), not
    // 100% of the compressed middle grid row - so the full card shows when it
    // fits the screen and only scrolls when it genuinely exceeds it (founder:
    // "extend this box"). Still a bounded cap + overflow, so nothing is ever
    // clipped without an access path.
    expect(slice).toContain("max-height: calc(100dvh");
    expect(slice).toContain("overflow-y: auto");
  });

  it("the column opts into pointer events (the wheel-swallowing trap)", () => {
    expect(slice).toContain("pointer-events: auto");
  });

  it("the <=900px branch keeps whole-overlay scrolling instead", () => {
    const mobile = html.slice(html.indexOf("@media (max-width: 900px)"));
    expect(mobile).toContain("overflow-y: auto");
    expect(mobile).toContain("pointer-events: auto");
    // ...and releases the column's own trap-scroll there.
    expect(mobile).toContain("max-height: none");
  });
});
