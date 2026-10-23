import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The main-surface controls legend (tester catch 2026-07-09): the brief
// section carries a .set-controls line disclosing the XR inputs that are
// live in idle/brief — trigger click, left-stick slide, right-stick snap
// turn, right-stick-down teleport, left X/Y fit-to-room, right B panel
// toggle. This suite is the drift lock: an exact-string pin on the legend,
// plus cross-surface token locks so the brief legend and the settings
// set-controls line (ui/lesson.uikitml #settings-section) can't drift apart
// on the inputs they both disclose. The stick BINDINGS themselves are IWSDK
// defaults and can't be cheaply cross-pinned from here:
//   - left Thumbstick axis2d -> LocomotionMove
//     (node_modules/@iwsdk/core/dist/input/input-actions.js ~:256)
//   - right Thumbstick flick past 0.8 -> 45-degree snap turn (~:264)
//   - right Thumbstick down-hold/release -> teleport (~:278)
//   - right B toggle: src/hud.ts B_Button handler
//   - left X/Y fit arm: src/mapping.ts fit-to-room binding
// Pause honesty: hud-state.ts walkLocomotionPaused/snapTurnPaused stop
// slide/teleport/snap-turn during countdown+walk, which is why the legend
// lives INSIDE #brief-section (idle/brief only), not at root level.

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

function slice(src: string, startMark: string, endMark: string): string {
  const start = src.indexOf(startMark);
  const end = src.indexOf(endMark, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  // Strip markup comments: a commented-out line must read as deleted
  // (the scoring-copy review's mutation finding).
  return src.slice(start, end).replace(/<!--[\s\S]*?-->/g, " ");
}

const LEGEND =
  "Controls - Trigger: click a button | Left stick: move | Right stick: snap turn | Right stick down: teleport | Left X/Y: fit to room | Right B: hide/show panel";

/** The tokens both surfaces disclose — pinned on each so they can't drift. */
const SHARED_TOKENS = ["Left X/Y: fit to room", "Right B: hide/show panel"];

describe("main-surface controls legend (ui/lesson.uikitml #brief-section)", () => {
  const uikitml = read("../ui/lesson.uikitml");
  const brief = slice(uikitml, 'id="brief-section"', 'id="live-section"');
  const settings = slice(uikitml, 'id="settings-section"', 'id="details-section"');

  it("the brief carries the exact legend line at the settings-line style", () => {
    expect(brief).toContain(`<span class="set-controls">${LEGEND}</span>`);
  });

  it("the legend appears exactly once in the WHOLE file (brief only)", () => {
    expect(brief.split(LEGEND).length - 1).toBe(1);
    // File-global uniqueness (review catch 2026-07-10): a copy of the legend
    // leaking into settings (double disclosure) would pass a brief-only pin.
    expect(uikitml.split(LEGEND).length - 1).toBe(1);
    expect(settings).not.toContain(LEGEND);
  });

  it("cross-surface token lock: shared inputs carry the same token on both surfaces", () => {
    for (const token of SHARED_TOKENS) {
      expect(brief, `brief: ${token}`).toContain(token);
      expect(settings, `settings: ${token}`).toContain(token);
    }
  });

  it("the settings surface still discloses its own scrub (not duplicated in the brief)", () => {
    expect(settings).toContain("Right stick: scrub a focused size");
    expect(brief).not.toContain("scrub");
  });

  it("Right A stays undisclosed on the main surface (dead there by design)", () => {
    expect(brief).not.toContain("Right A");
  });
});
