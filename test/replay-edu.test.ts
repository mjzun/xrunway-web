import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LATERAL_CUE_M, PACE_DELTA_CUE_MPS } from "../src/coach-live.js";
import { M8_GLANCE_PITCH_DEG } from "../src/head-carriage.js";
import {
  markerDetail,
  RECAP_HEADING,
  recapCues,
  REPLAY_CUE_TEXT,
  TRACE_TICK_SEC,
  traceFromTrack,
  traceTicks,
  type ReplayMarker,
  type ReplayTrack,
} from "../src/replay-core.js";

// REPLAY EDUCATION pins (the 2026-07-27 slate). Wave 1 = the floor trace /
// pace ticks / carriage head; wave 2 = the moment numbers / timeline dots /
// PRACTICE NEXT recap / comparison gap. All display-only; every threshold is
// IMPORTED from the engine (the replay-core provenance law).

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const mkTrack = (
  pts: Array<[number, number, number]>, // t, along, lateral
): ReplayTrack => ({
  points: pts.map(([t, along, lateral]) => ({
    t,
    along,
    lateral,
    pitchDeg: 0,
    paceMps: 1,
  })),
  duration: pts[pts.length - 1][0],
});

describe("wave 1 pure core: the trace", () => {
  it("trace warn flips at the SAME gate the LINE markers use", () => {
    const track = mkTrack([
      [0, 0, 0],
      [1, 1, LATERAL_CUE_M - 0.01],
      [2, 2, LATERAL_CUE_M + 0.01],
      [3, 3, -(LATERAL_CUE_M + 0.05)],
    ]);
    const tp = traceFromTrack(track);
    expect(tp.map((p) => p.warn)).toEqual([false, false, true, true]);
    expect(tp).toHaveLength(4);
  });

  it("pace ticks are equal-TIME samples of the tape", () => {
    const track = mkTrack([
      [0, 0, 0],
      [5, 5, 0],
    ]);
    const ticks = traceTicks(track);
    // 1..4 s (never t=0, never the endpoint)
    expect(ticks.map((k) => k.t)).toEqual([1, 2, 3, 4]);
    expect(TRACE_TICK_SEC).toBe(1.0);
    // constant speed -> equal along spacing
    expect(ticks.map((k) => +k.along.toFixed(3))).toEqual([1, 2, 3, 4]);
  });
});

describe("wave 2 pure core: moment numbers + recap", () => {
  const m = (kind: ReplayMarker["kind"], severity: number, t = 5): ReplayMarker => ({
    kind,
    t,
    along: 1,
    lateral: 0,
    severity,
  });

  it("markerDetail = the measured peak vs the ENGINE's own gate (F.39)", () => {
    // measured peak = the engine gate + the recorded severity, both sides
    // derived from the SAME imported constants (never hardcoded here).
    expect(markerDetail(m("line", 0.06))).toBe(
      `${(LATERAL_CUE_M + 0.06).toFixed(2)} M OFF CENTER - THE CUE LINE IS ${LATERAL_CUE_M.toFixed(2)}`,
    );
    expect(markerDetail(m("pace", 0.19))).toBe(
      `${(PACE_DELTA_CUE_MPS + 0.19).toFixed(2)} M/S OFF TEMPO - THE CUE LINE IS ${PACE_DELTA_CUE_MPS.toFixed(2)}`,
    );
    // head: glance line -15, severity 6 -> pitch -21
    expect(markerDetail(m("head", 6))).toBe(
      `CHIN 21 DEG DOWN - THE GLANCE LINE IS ${Math.abs(M8_GLANCE_PITCH_DEG)}`,
    );
  });

  it("recap = one cue per KIND, first-moment order, engine copy verbatim", () => {
    const cues = recapCues([
      m("pace", 0.1, 8),
      m("line", 0.1, 2),
      m("line", 0.2, 4),
      m("head", 3, 6),
    ]);
    expect(cues).toEqual([
      REPLAY_CUE_TEXT.line,
      REPLAY_CUE_TEXT.head,
      REPLAY_CUE_TEXT.pace,
    ]);
    expect(recapCues([])).toEqual([]);
    expect(RECAP_HEADING).toBe("PRACTICE NEXT");
  });
});

describe("wiring seams (the dead-pill lesson)", () => {
  const theater = read("../src/replay-theater.ts");
  const landing = read("../src/landing.ts");
  const html = read("../index.html");

  it("theater builds the trace family + drives the reveal and the warn", () => {
    for (const pin of [
      "buildTrace(parent)",
      "traceFromTrack(this.track)",
      "traceTicks(this.track)",
      "uHeadWarn",
      "M8_PITCH_BAND_DEG",
      "setDrawRange(0, this.traceShown * 6)",
      'side: DoubleSide',
    ]) {
      expect(theater).toContain(pin);
    }
  });

  it("theater publishes the wave-2 globals + the gap", () => {
    for (const pin of [
      "detail: markerDetail(r.marker)",
      "this.globals.replayMoments = markers.map",
      "this.globals.replayRecap =",
      "this.gapM = Math.abs(p.along - p2.along)",
      "this.stateOut.gapM = this.gapM",
    ]) {
      expect(theater).toContain(pin);
    }
  });

  it("landing paints the cue detail, dots, gap and recap", () => {
    for (const pin of [
      'byId("replay-cue-line")',
      'byId("replay-cue-detail")',
      'byId("rc-gap")',
      '"rp-dot"',
      'byId("sum-recap")',
      'byId("sum-recap-list")',
    ]) {
      expect(landing).toContain(pin);
    }
  });

  it("landing dot colors mirror the theater ring palette", () => {
    // REPLAY_MARKER_COLORS: line Carolina / pace white / head amber.
    for (const hex of ["#4b9cd3", "#f2f4f8", "#d9a441"]) {
      expect(landing).toContain(hex);
    }
    for (const hex of ["0xf2f4f8", "0xd9a441"]) {
      expect(theater).toContain(hex);
    }
  });

  it("index.html carries the wave-2 shells with the [hidden] law", () => {
    for (const pin of [
      'id="replay-cue-line"',
      'id="replay-cue-detail"',
      'id="rc-gap"',
      'id="sum-recap"',
      'id="sum-recap-list"',
      ">PRACTICE NEXT</div>",
    ]) {
      expect(html).toContain(pin);
    }
    const css = html.slice(
      html.indexOf("#sum-recap[hidden]"),
      html.indexOf("#replay-cue[hidden]"),
    );
    expect(css).toContain("display: none !important");
    // the recap heading in markup matches the exported constant
    expect(html).toContain(`>${RECAP_HEADING}</div>`);
  });
});
