import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// M11 WIRING PINS. The engine files (metrics.ts / show.ts) import
// @iwsdk/core and are not vitest-loadable, so the load-bearing wiring seams
// are pinned at the SOURCE TEXT — the beat-wiring.test.ts precedent. The
// BEHAVIOR behind every seam is pinned pure elsewhere: the tracker's
// wiring-feed tapes (edge latches, window open, partition, reset laws) in
// turn-stats.test.ts against the REAL production TurnTracker, the rider +
// row-presence law in summary-riders.test.ts, the CSV contract in
// session-recorder.test.ts.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("metrics.ts M11 seams (spec §2.3)", () => {
  const metrics = src("../src/metrics.ts");

  it("latches noteMark on the SAME poseBurst rising edge as markAtWalkTime", () => {
    // Inside the one mark-latch branch: the latch assignment then the
    // tracker's idempotent mark edge, in one block.
    const at = metrics.indexOf("this.markAtWalkTime = this.walkTime;");
    expect(at).toBeGreaterThan(-1);
    const block = metrics.slice(at, metrics.indexOf("}", at));
    expect(block).toContain("this.turn.noteMark(this.walkTime);");
  });

  it("edge-detects globals.holdArmed with a PRIVATE latch (the durable-flag law)", () => {
    expect(metrics).toContain("const armed = this.globals.holdArmed === true;");
    expect(metrics).toContain("if (armed && !this.prevHoldArmed)");
    expect(metrics).toContain("this.turn.noteHoldArmed(this.walkTime);");
    expect(metrics).toContain("this.prevHoldArmed = armed;");
    // The wiring never WRITES the shared flag — readers edge-detect
    // privately (only show.ts owns the lifecycle).
    expect(metrics).not.toMatch(/this\.globals\.holdArmed\s*=[^=]/);
  });

  it("captures the projection as SCALARS (projectRoute returns a reused object)", () => {
    expect(metrics).toContain(
      "const proj = this.projector.projectRoute(hp.x, hp.z);",
    );
    expect(metrics).toContain("const walkYaw = proj.yaw;");
    expect(metrics).toContain("const lat = proj.lateral;");
  });

  it("feeds the tracker ONCE, after carriage.update, from the one quaternion read + the M8 raw tap", () => {
    const feeds = metrics.match(/this\.turn\.update\(/g) ?? [];
    expect(feeds).toHaveLength(1);
    const carriage = metrics.indexOf("this.carriage.update(");
    const turn = metrics.indexOf("this.turn.update(");
    expect(carriage).toBeGreaterThan(-1);
    expect(turn).toBeGreaterThan(carriage); // raw tap must be THIS frame's
    const call = metrics.slice(turn, metrics.indexOf(");", turn));
    expect(call).toContain("this.carriage.liveRawPitchDevDeg");
    expect(call).toContain("hp.y"); // head y ungated — the tracker owns y
    // ZERO new reads: exactly the two pre-existing getWorldQuaternion sites
    // (the M8 feed + the countdown sampleNeutral) — M11 added none.
    const quatReads =
      metrics.match(/getWorldQuaternion\(this\.headQuat\)/g) ?? [];
    expect(quatReads).toHaveLength(2);
  });

  it("re-arms the machine on a mid-walk remap (compiledPath subscription), latch beside it", () => {
    const at = metrics.indexOf("this.turn.resetRoute(this.routeOneWay);");
    expect(at).toBeGreaterThan(-1);
    // ...inside the compiledPath subscription's active-walk branch (before
    // the phase subscription registers).
    expect(at).toBeLessThan(metrics.indexOf("this.phaseSig.subscribe"));
    const after = metrics.slice(at, at + 200);
    expect(after).toContain("this.prevHoldArmed = false;");
  });

  it("arms per walk with the FIT height + route topology + the walk-locked mode pace", () => {
    const begin = metrics.indexOf("private beginWalkTracking()");
    const body = metrics.slice(begin);
    const arm = body.indexOf("this.turn.beginWalk(");
    expect(arm).toBeGreaterThan(-1);
    const call = body.slice(arm, body.indexOf(");", arm));
    expect(call).toContain("standHeightM");
    expect(call).toContain("this.routeOneWay");
    expect(call).toContain("this.idealPace");
    // ...after the run's idealPace lock (mode-lock law: the band is scaled
    // from the pace this walk actually scores against).
    expect(body.indexOf("this.idealPace =")).toBeLessThan(arm);
  });

  it("publishes globals.turnTrack with the guarded cleanup (the beatLock handle pattern)", () => {
    expect(metrics).toContain("g.turnTrack = this.turn;");
    expect(metrics).toContain("if (g.turnTrack === this.turn)");
    expect(metrics).toContain("g.turnTrack = null;");
  });

  it("resetCadence never touches the turn tracker (arbitration independence — the M8 law)", () => {
    const body = metrics.slice(metrics.indexOf("private resetCadence()"));
    expect(body.slice(0, body.indexOf("\n  }"))).not.toContain("this.turn.");
  });
});

describe("show.ts M11 seams (spec §2.4)", () => {
  const show = src("../src/show.ts");

  it("owns the globals.holdArmed lifecycle: init seed + walk start + mid-walk remap re-arm", () => {
    // One init seed (g.holdArmed) + two re-arms (setPhase walk / applyPath
    // walk branch) — the director is the ONLY writer of false.
    expect(show).toContain("g.holdArmed = false;");
    const clears = show.match(/this\.globals\.holdArmed = false;/g) ?? [];
    expect(clears).toHaveLength(2);
    // The applyPath re-arm sits in the mid-walk branch, beside the hold's
    // own re-arm (the LAST-window-wins law).
    const apply = show.indexOf("private applyPath(");
    const applyBody = show.slice(apply, show.indexOf("update(delta", apply));
    expect(applyBody).toContain("this.globals.holdArmed = false;");
  });

  it("publishes the arming EDGE exactly once, on the holdStartElapsed snapshot frame", () => {
    const sets = show.match(/this\.globals\.holdArmed = true;/g) ?? [];
    expect(sets).toHaveLength(1);
    const snap = show.indexOf("this.holdStartElapsed = this.phaseElapsed;");
    expect(snap).toBeGreaterThan(-1);
    const block = show.slice(snap, snap + 500);
    expect(block).toContain("this.globals.holdArmed = true;");
  });

  it("freezes finalize() + nullReason() from the globals.turnTrack handle at finishWalk", () => {
    expect(show).toContain("this.globals.turnTrack");
    expect(show).toContain(
      "tt.finalize(this.holdBaseN > 0 ? this.holdBaseY : null)",
    );
    expect(show).toContain("turn === null && tt ? tt.nullReason() : null");
    // ONE walk-baseline sampler, two consumers: the hold finalize and the
    // turn finalize read the SAME first-0.5-s holdBaseY expression — a
    // second sampler would let the two dips drift apart.
    const samplers =
      show.match(/this\.holdBaseN > 0 \? this\.holdBaseY : null/g) ?? [];
    expect(samplers).toHaveLength(2);
  });

  it("stamps turn + turnNullReason on the summary object (after the beat stamps)", () => {
    const publish = show.indexOf("this.summarySig.value = {");
    const block = show.slice(publish, show.indexOf("};", publish));
    const beat = block.indexOf("beatNullReason,");
    const turn = block.indexOf("turn,");
    const reason = block.indexOf("turnNullReason,");
    expect(beat).toBeGreaterThan(-1);
    expect(turn).toBeGreaterThan(beat); // §G build order on the stamp too
    expect(reason).toBeGreaterThan(turn);
  });
});
