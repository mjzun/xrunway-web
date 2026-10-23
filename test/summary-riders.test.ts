import { describe, expect, it } from "vitest";

import { beatCue } from "../src/beat-stats.ts";
import { holdCue } from "../src/hold-stats.ts";
import { buildSummaryRiders, turnRowStamped } from "../src/summary-riders.ts";
import { turnCue } from "../src/turn-stats.ts";
import { makeBeat } from "./beat-helpers.ts";
import { makeTurnStats } from "./turn-helpers.ts";

// Adjudication §G — the ONE ordered post-walk rider list (HOLD > BEAT >
// TURN), generalized in the M9 wiring so M11 only appends its rider. The
// surfaces (hud.ts slots / landing.ts list) consume this order verbatim;
// coach-note priority + slot exhaustion are surface-side by construction
// (riders only ever fill the room LEFT after report.notes).

const ASCII = /^[\x20-\x7E]*$/;

describe("buildSummaryRiders (§G order + gating)", () => {
  it("orders HOLD before BEAT when both channels have a note", () => {
    const riders = buildSummaryRiders({
      hold: null,
      holdNullReason: "never-marked",
      beat: null,
      beatNullReason: "no-reference",
    });
    expect(riders.map((r) => r.label)).toEqual(["HOLD", "BEAT"]);
    // The texts are the channels' own copy, verbatim.
    expect(riders[0].text).toBe(holdCue(null, "never-marked"));
    expect(riders[1].text).toBe(beatCue(null, "no-reference"));
  });

  it("gates each rider on its summary STAMP (absent field = summary built without a director)", () => {
    expect(buildSummaryRiders({})).toEqual([]);
    // one stamp present, the other absent -> only that channel rides
    const holdOnly = buildSummaryRiders({
      hold: null,
      holdNullReason: "never-marked",
    });
    expect(holdOnly.map((r) => r.label)).toEqual(["HOLD"]);
    const beatOnly = buildSummaryRiders({
      beat: null,
      beatNullReason: "too-few-strikes",
    });
    expect(beatOnly.map((r) => r.label)).toEqual(["BEAT"]);
  });

  it("a null cue contributes no rider: beat 'no-clock' is an internal condition, no note", () => {
    const riders = buildSummaryRiders({
      beat: null,
      beatNullReason: "no-clock",
    });
    expect(riders).toEqual([]);
  });

  it("the absent-reason fallbacks make the weaker claim (hold 'no-data', beat 'no-clock')", () => {
    // hold stamped null with NO reason -> the weaker "no-data" sentence
    const hold = buildSummaryRiders({ hold: null });
    expect(hold).toHaveLength(1);
    expect(hold[0].text).toBe(holdCue(null, "no-data"));
    // beat stamped null with NO reason -> "no-clock" -> no note at all
    expect(buildSummaryRiders({ beat: null })).toEqual([]);
  });

  it("a measured beat row rides with its own cue (direction copy when the gates pass)", () => {
    const b = makeBeat({
      cadenceSpm: 65.5,
      driftSpm: 4.5,
      rayleighNR2: 26.24,
    });
    const riders = buildSummaryRiders({ beat: b, beatNullReason: null });
    expect(riders).toHaveLength(1);
    expect(riders[0].label).toBe("BEAT");
    expect(riders[0].text).toBe(beatCue(b, "no-clock"));
    expect(riders[0].text).toContain("ahead of the beat");
  });

  it("a between-bands beat row (no qualifying claim) contributes no rider", () => {
    const quiet = makeBeat({ vectorR: 0.6, rayleighNR2: 2, driftSpm: 0.5 });
    expect(beatCue(quiet, "no-clock")).toBeNull();
    expect(buildSummaryRiders({ beat: quiet, beatNullReason: null })).toEqual(
      [],
    );
  });

  it("orders HOLD before BEAT before TURN when all three channels have a note (§G)", () => {
    const riders = buildSummaryRiders({
      hold: null,
      holdNullReason: "never-marked",
      beat: null,
      beatNullReason: "no-reference",
      turn: null,
      turnNullReason: "turned-in-hold", // a coachable motion fact -> a note
    });
    expect(riders.map((r) => r.label)).toEqual(["HOLD", "BEAT", "TURN"]);
    expect(riders[2].text).toBe(turnCue(null, "turned-in-hold"));
  });

  it("gates the TURN rider on the presence law, not !== undefined: both-null = no analyzer ran", () => {
    // The director stamps turn null AND reason null when globals.turnTrack
    // is absent (metrics-less world) — nothing ran, nothing to ride.
    expect(
      buildSummaryRiders({ turn: null, turnNullReason: null }),
    ).toEqual([]);
    expect(turnRowStamped({ turn: null, turnNullReason: null })).toBe(false);
    expect(turnRowStamped({})).toBe(false);
    // A disclosed null (reason stamped) IS present — the row shows...
    expect(
      turnRowStamped({ turn: null, turnNullReason: "one-way-route" }),
    ).toBe(true);
    // ...but a non-coachable reason contributes no rider (the row line
    // carries the disclosure alone — one-way / never-marked / dark /
    // never-settled all yield a null cue).
    expect(
      buildSummaryRiders({ turn: null, turnNullReason: "one-way-route" }),
    ).toEqual([]);
    // A measured turn is present regardless of the reason field.
    expect(turnRowStamped({ turn: makeTurnStats() })).toBe(true);
  });

  it("a measured turn rides with the core's own cue, verbatim", () => {
    const t = makeTurnStats({ reversalCount: 2, sweepMonotoneFrac: 0.78 });
    const riders = buildSummaryRiders({ turn: t, turnNullReason: null });
    expect(riders).toHaveLength(1);
    expect(riders[0].label).toBe("TURN");
    expect(riders[0].text).toBe(turnCue(t, "tracking-dark"));
    expect(riders[0].text).toContain("swept back 2 times");
  });

  it("a clean measured turn (the between-bands/clean branch) still yields exactly the core's cue or none", () => {
    // The clean fixture trips the CLEAN sentence — the rider carries it.
    const clean = makeTurnStats();
    expect(turnCue(clean, "tracking-dark")).not.toBeNull();
    const riders = buildSummaryRiders({ turn: clean, turnNullReason: null });
    expect(riders.map((r) => r.text)).toEqual([
      turnCue(clean, "tracking-dark"),
    ]);
    // An unmeasured-dip turn cannot claim clean (the honesty law) — with
    // nothing else tripped it contributes NO rider.
    const quiet = makeTurnStats({ dipCm: null, dipFrac: null, heightM: null, heightSource: null });
    expect(turnCue(quiet, "tracking-dark")).toBeNull();
    expect(
      buildSummaryRiders({ turn: quiet, turnNullReason: null }),
    ).toEqual([]);
  });

  it("every rider label + text is non-empty printable ASCII (the panel law)", () => {
    const riders = buildSummaryRiders({
      hold: null,
      holdNullReason: "no-data",
      beat: makeBeat({ vectorR: 0.8 }),
      beatNullReason: null,
      turn: null,
      turnNullReason: "walk-ended-mid-turn",
    });
    expect(riders.length).toBeGreaterThan(0);
    expect(riders.map((r) => r.label)).toContain("TURN");
    for (const r of riders) {
      expect(r.label).toMatch(ASCII);
      expect(r.text.trim()).not.toBe("");
      expect(r.text).toMatch(ASCII);
    }
  });
});
