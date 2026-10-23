import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CROWD_EASE_RATE,
  CROWD_LEAN_MAX_RAD,
  CROWD_TICK_SEC,
  CROWD_TURN_MAX_RAD,
  crowdTracksPhase,
  easeAngle,
  seatTurnTarget,
  wrapAngle,
} from "../src/crowd-gaze-core.js";

// A Crowd That Watches You (display-only spectacle): the pure angle laws +
// the wiring seams (the dead-pill lesson — pin the markup AND the consumer).

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("crowd-gaze core: the turn law", () => {
  it("a seat facing the walker holds its base pose (delta 0)", () => {
    // Seat at (2, 0) facing -X (yaw = atan2(-2, 0)); walker on the seat's
    // sightline at the origin.
    const yaw = Math.atan2(-2, -0);
    expect(seatTurnTarget(yaw, 2, 0, 0, 0)).toBeCloseTo(0, 6);
  });

  it("turns by the shortest signed angle toward the walker", () => {
    // Seat at (2, 0) facing -X; walker slightly down-route (+z side).
    const base = Math.atan2(-1, 0);
    const t = seatTurnTarget(base, 2, 0, 0, 0.5);
    const expected = wrapAngle(Math.atan2(-2, 0.5) - base);
    expect(t).toBeCloseTo(expected, 6);
    expect(Math.abs(t)).toBeLessThan(CROWD_TURN_MAX_RAD);
  });

  it("clamps to +/- CROWD_TURN_MAX_RAD - never an owl", () => {
    // Walker BEHIND the seat: the raw delta is ~PI, the clamp holds ~30 deg.
    const base = Math.atan2(-1, 0); // facing -X
    const t = seatTurnTarget(base, 2, 0, 5, 0); // walker at +X, behind
    expect(Math.abs(t)).toBeCloseTo(CROWD_TURN_MAX_RAD, 6);
  });

  it("ease is frame-rate independent and settles at the target", () => {
    // Two 0.1 s steps == one 0.2 s step (exponential form).
    let a = 0;
    a = easeAngle(a, 1, 0.1);
    a = easeAngle(a, 1, 0.1);
    const b = easeAngle(0, 1, 0.2);
    expect(a).toBeCloseTo(b, 10);
    // Monotonic approach, never overshoot.
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
    expect(CROWD_EASE_RATE).toBeGreaterThan(0);
  });

  it("tracks only during countdown + walk (summary/idle ease back)", () => {
    expect(crowdTracksPhase("countdown")).toBe(true);
    expect(crowdTracksPhase("walk")).toBe(true);
    for (const p of ["idle", "brief", "summary"]) {
      expect(crowdTracksPhase(p)).toBe(false);
    }
  });

  it("the lean is a subtle beat, inside the turn clamp", () => {
    expect(CROWD_LEAN_MAX_RAD).toBeLessThan(CROWD_TURN_MAX_RAD);
    expect(CROWD_TICK_SEC).toBeGreaterThanOrEqual(0.1 - 1e-9); // the 10 Hz law
  });
});

describe("crowd-gaze wiring seams (file-scan pins)", () => {
  const stage = read("../src/stage.ts");
  const system = read("../src/crowd-gaze.ts");
  const indexTs = read("../src/index.ts");

  it("the stage exports live seats from BOTH crowd paths and never the pit", () => {
    // GLB path: instanceAudienceModels takes + fills the collector.
    expect(stage).toContain("liveSeats?: AudienceLiveSeat[]");
    expect(stage).toContain("instanceAudienceModels(audModels, slots, add, dum, liveSeats)");
    // Procedural path pushes skin+cloth (+ the phone rider).
    expect(stage).toMatch(/gazeEntries: AudienceSeatEntry\[\] = \[\s*\{ im: skinMeshes\[v\]/);
    // The pit builder never touches the collector.
    const pit = stage.slice(
      stage.indexOf("function buildPhotographerPit"),
      stage.indexOf("function", stage.indexOf("function buildPhotographerPit") + 10),
    );
    expect(pit).not.toContain("liveSeats");
    expect(pit).not.toContain("audienceLive");
    // The rebuild staleness law: cleared before every build.
    expect(stage).toContain("g.audienceLive = null");
  });

  it("the system is registered and throttled, with the settle skip", () => {
    expect(indexTs).toContain("registerSystem(CrowdGazeSystem");
    expect(system).toContain("CROWD_TICK_SEC");
    expect(system).toContain("CROWD_SETTLE_EPS_RAD");
    expect(system).toContain("holdLive");
    // No per-frame allocation in update: scratches are class fields.
    expect(system).toMatch(/private mRot!: Matrix4;/);
  });
});
