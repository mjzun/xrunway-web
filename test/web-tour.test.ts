import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  SCENE_SPOT_FRAC,
  shouldShowWebTour,
  TOUR_BEATS,
  TOUR_SETTLE_DELAY_MS,
  WEB_TOUR_KEY,
} from "../src/web-tour-core.js";

// FIRST-RUN GUIDED ATTENTION pins (2026-07-27 build). The tour is the
// founder's answer to "first time users do not know where to start or where
// to look" — these pins hold the empty-history gate, the beat order (the
// sequence ENDS ON START, the founder's explicit shape), the caption drafts
// (worksheet F.38), and the wiring seams (the dead-pill lesson: a tour whose
// installer is never called ships green without the file scans).

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("web-tour core (gate + beats)", () => {
  it("empty history + no key = show; anything else = never", () => {
    expect(shouldShowWebTour(0, false)).toBe(true);
    expect(shouldShowWebTour(0, true)).toBe(false);
    expect(shouldShowWebTour(1, false)).toBe(false);
    expect(shouldShowWebTour(1, true)).toBe(false);
    expect(shouldShowWebTour(12, false)).toBe(false);
  });

  it("the dismissal key is the versioned web-tour namespace", () => {
    expect(WEB_TOUR_KEY).toBe("xrunway.web-tour.v1");
  });

  it("beat ORDER is scene -> settings card -> START -> headset (count 4)", () => {
    expect(TOUR_BEATS.map((b) => b.target)).toEqual([
      "scene",
      "lesson-card",
      "begin-walk",
      "enter-xr",
    ]);
  });

  it("captions are the F.38 drafts, one short line each", () => {
    expect(TOUR_BEATS.map((b) => b.caption)).toEqual([
      "This is your show.",
      "Set your walk.",
      "When you're ready - START.",
      "Got a headset? Step inside.",
    ]);
    for (const b of TOUR_BEATS) {
      expect(b.caption.split(/\s+/).length).toBeLessThanOrEqual(8);
    }
  });

  it("beats hold ~2-3 s (the brief's tempo), scene spot stays on-screen", () => {
    for (const b of TOUR_BEATS) {
      expect(b.holdMs).toBeGreaterThanOrEqual(2000);
      expect(b.holdMs).toBeLessThanOrEqual(3500);
    }
    const [x, y, w, h] = SCENE_SPOT_FRAC;
    expect(x + w).toBeLessThanOrEqual(1);
    expect(y + h).toBeLessThanOrEqual(1);
    expect(TOUR_SETTLE_DELAY_MS).toBeGreaterThan(1700); // after body.settled
  });
});

describe("web-tour markup + CSS laws (index.html)", () => {
  const html = read("../index.html");

  it("the static shell exists with all four tour elements", () => {
    expect(html).toContain('<div id="web-tour" hidden>');
    expect(html).toContain('<div id="tour-spot"></div>');
    expect(html).toContain('<div id="tour-caption"></div>');
    expect(html).toContain('id="tour-skip"');
  });

  it("every beat's element target exists in the landing", () => {
    for (const b of TOUR_BEATS) {
      if (b.target === "scene") continue;
      expect(html).toContain(`id="${b.target}"`);
    }
  });

  // NOTE: .onb-overlay also appears in the top-of-file transparency fallback,
  // so the end anchor must search FROM the tour block, not from 0.
  const cssStart = html.indexOf("#web-tour {");
  const cssBlock = html.slice(
    cssStart,
    html.indexOf(".onb-overlay {", cssStart),
  );

  it("[hidden] is paired with !important (the display-class trap)", () => {
    expect(cssBlock).toContain("#web-tour[hidden]");
    expect(cssBlock).toContain("display: none !important");
  });

  it("the overlay owns the pointer + sits under the onboarding modal", () => {
    const css = html.slice(
      html.indexOf("#web-tour {"),
      html.indexOf("#web-tour[hidden]"),
    );
    expect(css).toContain("pointer-events: auto");
    expect(css).toContain("z-index: 58");
  });

  it("reduced motion silences the glide + the START pulse", () => {
    const rm = cssBlock.slice(cssBlock.indexOf("prefers-reduced-motion"));
    expect(rm).toContain("animation: none");
    expect(rm).toContain("transition: none");
  });
});

describe("web-tour wiring seams (the dead-pill lesson)", () => {
  it("landing.ts installs the tour with all four hooks", () => {
    const landing = read("../src/landing.ts");
    expect(landing).toContain('from "./web-tour.js"');
    expect(landing).toContain("installWebTour({");
    for (const hook of [
      "walkCount:",
      "phaseIdle:",
      "inBrowser:",
      "onboardingOpen:",
    ]) {
      expect(landing).toContain(hook);
    }
  });

  it("web-tour.ts stamps + reads the SAME dismissal key and never clears it", () => {
    const src = read("../src/web-tour.ts");
    expect(src).toContain("localStorage.getItem(WEB_TOUR_KEY)");
    expect(src).toContain("localStorage.setItem(WEB_TOUR_KEY");
    expect(src).not.toContain("removeItem(WEB_TOUR_KEY");
  });

  it("SKIP TOUR is the shell's only literal copy (F.38)", () => {
    const html = read("../index.html");
    expect(html).toContain(">SKIP TOUR</button>");
  });
});
