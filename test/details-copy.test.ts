import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { passBarLabel, targetPaceLabel } from "../src/coach.ts";
import { getMode } from "../src/modes.ts";
import {
  MODE_DEFAULT_BPM,
  MUSIC_BPM_OPTIONS,
  musicBpmNote,
} from "../src/music-prefs.ts";

// The DETAILS reference surfaces (founder call 2026-07-08): the in-headset
// subsection (ui/lesson.uikitml #details-section) and the web block
// (index.html #details-block) carry STATIC text — this suite is the drift
// lock that pins every static line to the LIVE constants it states
// (modes.ts idealPace/passThreshold/labels, MODE_DEFAULT_BPM, the founder's
// verbatim musicBpmNote copy). Change a constant without updating the
// markup and this goes red — the panel-ascii file-scan precedent.

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** The two founder-named modes shown in DETAILS (commercial/challenge tempo
 * defaults are PROVISIONAL — deliberately not listed). */
const SHOWN_MODES = ["beginner", "highfashion"] as const;

function detailsSlice(src: string, startMark: string, endMark: string): string {
  const start = src.indexOf(startMark);
  const end = src.indexOf(endMark, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("in-headset DETAILS subsection (ui/lesson.uikitml)", () => {
  const uikitml = read("../ui/lesson.uikitml");
  const section = detailsSlice(
    uikitml,
    'id="details-section"',
    'id="fit-status"',
  );

  it("each shown mode states its label, its own shipped chips, and its default tempo", () => {
    for (const id of SHOWN_MODES) {
      const m = getMode(id);
      expect(section).toContain(m.label);
      expect(section).toContain(
        `${targetPaceLabel(m.idealPace)} - ${passBarLabel(m.passThreshold)} - MUSIC ${MODE_DEFAULT_BPM[id]} BPM`,
      );
    }
  });

  it("each tempo option carries the founder's note VERBATIM", () => {
    for (const bpm of MUSIC_BPM_OPTIONS) {
      expect(section).toContain(`${bpm} - ${musicBpmNote(bpm)}`);
    }
  });

  it("the provisional modes are NOT listed", () => {
    expect(section).not.toContain(getMode("commercial").label);
    expect(section).not.toContain(getMode("challenge").label);
  });

  it("the section has the open/close seam the hud wires", () => {
    expect(uikitml).toContain('id="set-details"');
    expect(section).toContain('id="det-done"');
  });
});

describe("web DETAILS block (index.html)", () => {
  const html = read("../index.html");
  const block = detailsSlice(html, 'id="details-block"', "controls-label");

  it("each shown mode states its label, its own shipped chips, and its default tempo", () => {
    for (const id of SHOWN_MODES) {
      const m = getMode(id);
      expect(block).toContain(m.label);
      // The web block separates with &middot; entities — pin the SEGMENTS.
      expect(block).toContain(targetPaceLabel(m.idealPace));
      expect(block).toContain(passBarLabel(m.passThreshold));
      expect(block).toContain(`MUSIC ${MODE_DEFAULT_BPM[id]} BPM`);
    }
  });

  it("each tempo option carries the founder's note VERBATIM", () => {
    for (const bpm of MUSIC_BPM_OPTIONS) {
      expect(block).toContain(`${bpm} &middot; ${musicBpmNote(bpm)}`);
    }
  });

  it("the provisional modes are NOT listed", () => {
    expect(block).not.toContain(getMode("commercial").label);
    expect(block).not.toContain(getMode("challenge").label);
  });
});
