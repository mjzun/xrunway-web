import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  carriageScoreOf,
  M8_GLANCE_PITCH_DEG,
  M8_PITCH_BAND_DEG,
} from "../src/head-carriage.ts";
import { SCORE_MAX, SCORE_MIN } from "../src/pose-derive.ts";

// The UNDERSTANDING THE SCORE education surfaces (queue #5): the landing
// block (index.html #scoring-block, founder copy shipped 2026-07-08) and its
// in-headset twin (ui/lesson.uikitml #scoring-section). Both carry STATIC
// text — this suite is the drift lock that pins them to each other and to
// the LIVE engine: the founder's intro + definitions verbatim on BOTH
// surfaces (the XR side ASCII-transliterated only as the panel font demands),
// the formula constants rebuilt from pose-derive.ts / head-carriage.ts, and
// the 95/70/96/240 anchors file-scanned in the two engine sites that state
// them. Change the engine without the markup (or either surface without the
// other) and this goes red — the details-copy.test.ts precedent, and the
// FIRST pin on the web block (it shipped unpinned).

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Collapse whitespace runs: index.html wraps sentences across indented
 * source lines, so pins compare squashed text on both surfaces. */
const squash = (s: string): string => s.replace(/\s+/g, " ");

/** Slice the RENDERED region: markup comments are stripped BEFORE pinning so
 * (a) commenting a line out reads as deleting it — the pin goes red instead
 * of matching text no user sees (the review's mutation finding), and (b) the
 * neighbouring DETAILS lead comments can't feed the banned-word scan. */
function slice(src: string, startMark: string, endMark: string): string {
  const start = src.indexOf(startMark);
  const end = src.indexOf(endMark, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end).replace(/<!--[\s\S]*?-->/g, " ");
}

/** Pin ORDER as well as presence: every needle must appear, each strictly
 * after the previous — a formula re-paired under the wrong metric heading on
 * one surface is a silent honesty bug presence-only pins wave through. */
function assertOrdered(hay: string, needles: readonly string[]): void {
  let at = -1;
  for (const n of needles) {
    const next = hay.indexOf(n, at + 1);
    expect(next, `out of order or missing: ${n.slice(0, 60)}`).toBeGreaterThan(
      at,
    );
    at = next;
  }
}

/** Count non-overlapping occurrences (the "exactly 3 definitions" pin — a
 * fourth one-sided def with a novel, non-banned name must go red while the
 * pinned founder intro promises "the 3 main metrics"). */
const count = (hay: string, needle: string): number =>
  hay.split(needle).length - 1;

// ---------------------------------------------------------------------------
// The founder's words (A2, COPY-WORKSHEET.md decision log 2026-07-08) as
// shipped on the landing — already pure ASCII, so both surfaces carry the
// SAME bytes. The intro's "is tracked" is the founder's F.15 ruling
// (2026-07-09): the A2 verbatim form, synced to both surfaces.
// ---------------------------------------------------------------------------

const INTRO =
  "Here are how the 3 main metrics are defined, tracked, and what it means for you. Please note that the data for these metrics is tracked by the headset only.";

const DEFS: ReadonlyArray<{ name: string; what: string }> = [
  { name: "PACE", what: "head speed vs the target head speed" },
  {
    name: "CARRIAGE",
    what: "% of time the head stays level (downward glances negatively affect this score)",
  },
  { name: "LINE", what: "head alignment with the center line" },
];

// ---------------------------------------------------------------------------
// The formula lines (factual, not founder-quoted) — per-surface punctuation:
// the web uses HTML entities, the XR panel is printable-ASCII only
// (test/panel-ascii.test.ts). The clamp band and the carriage map are rebuilt
// from the live constants; the pace/line anchors (95 x 70, 96 x 240) are
// pinned by the engine file-scan below.
// ---------------------------------------------------------------------------

const BAND_XR = `(${SCORE_MIN}-${SCORE_MAX})`;
const BAND_WEB = `(${SCORE_MIN}&ndash;${SCORE_MAX})`;
const CARRIAGE_MAP = `${SCORE_MIN} + ${SCORE_MAX - SCORE_MIN}`; // "40 + 58"

const MATH_XR = [
  `score = 100 within 0.10 m/s of the target; slower costs 90 per m/s, faster costs 45 ${BAND_XR}. In the band = 100.`,
  `score = ${CARRIAGE_MAP} x the share of the walk your head stayed level (chin within ${M8_PITCH_BAND_DEG} deg of neutral) and facing down the line. A head-drop (>${-M8_GLANCE_PITCH_DEG} deg down) counts against it.`,
  `score = 100 - (your average distance off the centerline, in meters) x 240 ${BAND_XR}. Dead on the line = 100.`,
];

const MATH_WEB = [
  `score = 100 within &plusmn;0.10 m/s of the target; slower costs 90 per m/s, faster costs 45 ${BAND_WEB}. In the band = 100.`,
  `score = ${CARRIAGE_MAP} &times; the share of the walk your head stayed level (chin within ${M8_PITCH_BAND_DEG}&deg; of neutral) &amp; facing down the line. A head-drop (&gt;${-M8_GLANCE_PITCH_DEG}&deg; down) counts against it.`,
  `score = 100 &minus; (your average distance off the centerline, in meters) &times; 240 &nbsp;${BAND_WEB}. Dead on the line = 100.`,
];

const SENSOR_XR =
  "Computed on-device from Meta Quest 3 head tracking only - no camera, no body scan; nothing is scored that the headset did not measure.";
const SENSOR_WEB =
  "Computed on-device from Meta Quest 3 head tracking only &mdash; no camera, no body scan; nothing is scored that the headset did not measure.";

// F.17 provenance lines (2026-07-09, the founder's complete-it delegation):
// each metric cites the VERBATIM industry instruction it operationalizes —
// the quotes are 3-0-verified in docs/RESEARCH-runway-instruction.md and may
// not drift from the research record. Per-surface punctuation (web em-dash,
// XR ASCII hyphen).
const SRC_QUOTES: ReadonlyArray<{ quote: string; source: string }> = [
  { quote: "take long strides, and control your pace", source: "Naomi Campbell" },
  { quote: "keep your head straight and steady", source: "CM Models" },
  { quote: "walking along a thin, invisible line", source: "Backstage" },
];
const SRC_XR = SRC_QUOTES.map(
  (s) => `In the industry's words: "${s.quote}" - ${s.source}`,
);
const SRC_WEB = SRC_QUOTES.map(
  (s) => `In the industry's words: "${s.quote}" &mdash; ${s.source}`,
);

/** Engine-computed reads that are display-banned under the honesty law (the
 * shipped card is PACE / CARRIAGE / LINE only). Word-boundary regexes: the
 * neighbouring markup comments say "returns", which must not trip "turn". */
const BANNED = [
  /\brhythm\b/i,
  /\bposture\b/i,
  /\bfootwork\b/i,
  /\bfoot placement\b/i,
  /\bhold\b/i,
  /\bbeat\b/i,
  /\bturn\b/i,
  /\bconsistency\b/i,
  /\bpresence\b/i,
  /\bconfidence\b/i,
  /\bpresentation\b/i,
];

describe("in-headset SCORING subsection (ui/lesson.uikitml)", () => {
  const uikitml = read("../ui/lesson.uikitml");
  const section = squash(
    slice(uikitml, 'id="scoring-section"', 'id="details-section"'),
  );

  it("carries the founder's intro, the three definitions, the formulas and the cited provenance, IN ORDER", () => {
    assertOrdered(section, [
      INTRO,
      ...DEFS.flatMap((d, i) => [d.name, d.what, MATH_XR[i], SRC_XR[i]]),
      SENSOR_XR,
    ]);
  });

  it("shows exactly the 3 promised definitions — no one-sided additions", () => {
    expect(count(section, 'class="det-name"')).toBe(DEFS.length);
  });

  it("names no display-banned metric (the honesty law)", () => {
    for (const re of BANNED) expect(section).not.toMatch(re);
  });

  it("has the open/close seam the hud wires", () => {
    expect(uikitml).toContain('id="set-scoring"');
    expect(section).toContain('id="scoring-done"');
  });

  it("the hud actually wires the seam — a dead Scoring pill must go red", () => {
    // The source-text seam pin (the beat-wiring.test.ts precedent): hud.ts is
    // not vitest-loadable (imports @iwsdk/core), so pin the exact wiring lines.
    const hud = read("../src/hud.ts");
    expect(hud).toContain('this.el<UIKit.Container>("scoring-section")');
    expect(hud).toContain('this.onClick("set-scoring", () =>');
    expect(hud).toContain('this.onClick("scoring-done", () =>');
    expect(hud).toContain("this.setDisplay(this.scoringSection, scoring);");
    expect(hud).toContain('forced === "scoring"'); // the __PANEL_SECTION dev hook
  });
});

describe("web UNDERSTANDING THE SCORE block (index.html)", () => {
  const html = read("../index.html");
  const block = squash(slice(html, 'id="scoring-block"', 'id="details-block"'));

  it("carries the founder's intro, the three definitions, the formulas and the cited provenance, IN ORDER", () => {
    assertOrdered(block, [
      INTRO,
      ...DEFS.flatMap((d, i) => [d.name, d.what, MATH_WEB[i], SRC_WEB[i]]),
      SENSOR_WEB,
    ]);
  });

  it("shows exactly the 3 promised definitions — no one-sided additions", () => {
    expect(count(block, 'class="score-name')).toBe(DEFS.length);
  });

  it("names no display-banned metric (the honesty law)", () => {
    for (const re of BANNED) expect(block).not.toMatch(re);
  });
});

describe("the stated math IS the live engine", () => {
  it("carriageScoreOf anchors the stated 40 + 58 map — and IS that line", () => {
    expect(carriageScoreOf(0, null)).toBe(SCORE_MIN);
    expect(carriageScoreOf(1, null)).toBe(SCORE_MAX);
    // Linearity witness: endpoints alone would pass any monotone curve, but
    // the card claims the LINEAR "40 + 58 x share" — pin the midpoint too.
    expect(carriageScoreOf(0.5, null)).toBeCloseTo(
      SCORE_MIN + (SCORE_MAX - SCORE_MIN) / 2,
      10,
    );
  });

  it("the head-drop line states the glance threshold", () => {
    expect(-M8_GLANCE_PITCH_DEG).toBe(15);
    expect(M8_PITCH_BAND_DEG).toBe(7);
  });

  // The pace/line anchors (100 - |dv| x 70, 100 - lat x 240) are inline
  // literals in the two engine sites, not exports — pin the SOURCE TEXT
  // (the beat-wiring.test.ts precedent). Retune either engine slope and
  // this goes red, pointing at BOTH markup surfaces to move with it.
  it("metrics.ts (the headset walk path) states the anchors the card shows", () => {
    const metrics = read("../src/metrics.ts");
    expect(metrics).toContain(
      "paceBandScore(this.speedEma, this.idealPace, this.paceOpts)",
    );
    expect(metrics).toContain("100 - this.latEma * 240");
  });

  it("pose-derive.ts (the golden/solo twin) states the same anchors", () => {
    const poseDerive = read("../src/pose-derive.ts");
    expect(poseDerive).toContain(
      "paceBandScore(state.poseSpeedEma, idealPace, paceOpts)",
    );
    expect(poseDerive).toContain("100 - state.poseLatEma * 240");
  });
});
