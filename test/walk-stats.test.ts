import { describe, expect, it } from "vitest";

import {
  STEP_DEBOUNCE_SEC,
  WalkStatsAccumulator,
} from "../src/walk-stats.ts";

function armed(idealPace = 0.85): WalkStatsAccumulator {
  const acc = new WalkStatsAccumulator();
  acc.reset(idealPace);
  return acc;
}

describe("WalkStatsAccumulator finalize/null contract", () => {
  it("returns null when the walk never produced a sample on any channel", () => {
    expect(new WalkStatsAccumulator().finalize(60)).toBeNull();
    expect(armed().finalize(60)).toBeNull(); // reset alone is not a sample
  });

  it("a walk that ran but measured nothing still reports source + ideal", () => {
    const acc = armed(0.72);
    acc.noteSource("camera-image", 10);
    const s = acc.finalize(30)!;
    expect(s).not.toBeNull();
    expect(s.source).toBe("camera-image");
    expect(s.idealPaceMps).toBe(0.72);
    expect(s.meanPaceMps).toBeNull();
    expect(s.paceDeltaMps).toBeNull();
    expect(s.meanLateralM).toBeNull();
    expect(s.meanAbsLateralM).toBeNull();
    expect(s.postureDriftM).toBeNull();
    expect(s.steps).toBe(0);
    expect(s.cadenceSpm).toBeNull();
  });

  it("channels go null independently (pace-only walk)", () => {
    const acc = armed();
    acc.noteSource("head", 2);
    acc.addPace(1.0, 2);
    const s = acc.finalize(2)!;
    expect(s.meanPaceMps).toBe(1);
    expect(s.meanLateralM).toBeNull();
    expect(s.postureDriftM).toBeNull();
  });

  it("finalize is non-destructive (same result twice)", () => {
    const acc = armed();
    acc.addPace(1.2, 1);
    acc.addStep(0.5);
    expect(acc.finalize(30)).toEqual(acc.finalize(30));
  });
});

describe("pace channel", () => {
  it("duration-weights the mean and signs the delta vs the ideal", () => {
    const acc = armed(0.72);
    acc.addPace(1.0, 3); // 3 s at 1.0 m/s
    acc.addPace(0.5, 1); // 1 s at 0.5 m/s
    const s = acc.finalize(4)!;
    expect(s.meanPaceMps).toBeCloseTo(0.875, 3); // (3.0 + 0.5) / 4
    expect(s.paceDeltaMps).toBeCloseTo(0.155, 3); // POSITIVE = too fast
  });

  it("paceDeltaMps is negative when slower than the ideal", () => {
    const acc = armed(1.05);
    acc.addPace(0.8, 2);
    expect(acc.finalize(2)!.paceDeltaMps).toBeCloseTo(-0.25, 3);
  });

  it("rounds to mm/s (3 dp)", () => {
    const acc = armed(0);
    acc.addPace(1 / 3, 1);
    expect(acc.finalize(1)!.meanPaceMps).toBe(0.333);
  });

  it("ignores non-finite speeds and non-positive intervals", () => {
    const acc = armed();
    acc.addPace(Number.NaN, 1);
    acc.addPace(Number.POSITIVE_INFINITY, 1);
    acc.addPace(2.0, 0);
    acc.addPace(2.0, -1);
    acc.addPace(1.0, 1); // the only valid sample
    expect(acc.finalize(1)!.meanPaceMps).toBe(1);
  });
});

describe("lateral channel (signed centerline offset)", () => {
  it("keeps the sign in the mean; abs mean exposes weave", () => {
    const acc = armed();
    acc.addLateral(-0.2, 1); // trainee's left (outbound)
    acc.addLateral(0.2, 1); // trainee's right (outbound)
    const s = acc.finalize(2)!;
    expect(s.meanLateralM).toBeCloseTo(0, 6); // weave averages out...
    expect(s.meanAbsLateralM).toBeCloseTo(0.2, 3); // ...but abs catches it
  });

  it("a one-sided drift keeps its sign, duration-weighted", () => {
    const acc = armed();
    acc.addLateral(-0.3, 3);
    acc.addLateral(0.1, 1);
    const s = acc.finalize(4)!;
    expect(s.meanLateralM).toBeCloseTo(-0.2, 3); // hugging the left edge
    expect(s.meanAbsLateralM).toBeCloseTo(0.25, 3);
  });
});

describe("posture channel (signed height deviation)", () => {
  it("negative drift = below the walk-start baseline", () => {
    const acc = armed();
    acc.addPosture(-0.05, 1);
    acc.addPosture(-0.01, 1);
    expect(acc.finalize(2)!.postureDriftM).toBeCloseTo(-0.03, 3);
  });

  it("positive drift = above the baseline", () => {
    const acc = armed();
    acc.addPosture(0.04, 2);
    expect(acc.finalize(2)!.postureDriftM).toBeCloseTo(0.04, 3);
  });
});

describe("footstrikes + cadence", () => {
  it("counts every strike, debouncing same-step re-fires", () => {
    const acc = armed();
    acc.addStep(1.0); // first strike counts
    acc.addStep(1.0 + STEP_DEBOUNCE_SEC / 2); // same physical step -> ignored
    acc.addStep(1.5); // real
    acc.addStep(4.0); // after a pause: still a real step (no upper bound)
    expect(acc.finalize(10)!.steps).toBe(3);
  });

  it("cadenceSpm = steps per minute over the timed walk", () => {
    const acc = armed();
    for (let i = 0; i < 30; i++) acc.addStep(i * 1.5);
    expect(acc.finalize(45)!.cadenceSpm).toBe(40); // 30 steps / 0.75 min
  });

  it("cadence is null with zero steps or a non-positive duration", () => {
    const acc = armed();
    acc.addPace(1, 1); // make finalize non-null
    expect(acc.finalize(60)!.cadenceSpm).toBeNull();
    const acc2 = armed();
    acc2.addStep(0.1);
    expect(acc2.finalize(0)!.cadenceSpm).toBeNull();
  });
});

describe("source dominance", () => {
  it("picks the path with the most accumulated walk time", () => {
    const acc = armed();
    acc.noteSource("head", 2);
    acc.noteSource("camera-world", 5);
    acc.noteSource("camera-image", 1);
    expect(acc.finalize(8)!.source).toBe("camera-world");
  });

  it("head-only and image-heavy walks label correctly", () => {
    const head = armed();
    head.noteSource("head", 10);
    expect(head.finalize(10)!.source).toBe("head");
    const img = armed();
    img.noteSource("camera-image", 6);
    img.noteSource("head", 4);
    expect(img.finalize(10)!.source).toBe("camera-image");
  });
});

describe("resetLateral() (mid-walk remap: the centerline moved)", () => {
  it("clears ONLY the lateral channel; pace/posture/steps/source survive", () => {
    const acc = armed(0.85);
    acc.noteSource("head", 4);
    acc.addPace(0.9, 4);
    acc.addPosture(-0.02, 4);
    acc.addStep(1);
    acc.addLateral(0.3, 4); // measured against the OLD centerline

    acc.resetLateral(); // fit-to-room / editor remap mid-walk

    // Nothing lateral yet against the new centerline -> channel reads null.
    const mid = acc.finalize(4)!;
    expect(mid.meanLateralM).toBeNull();
    expect(mid.meanAbsLateralM).toBeNull();
    expect(mid.meanPaceMps).toBe(0.9);
    expect(mid.postureDriftM).toBe(-0.02);
    expect(mid.steps).toBe(1);
    expect(mid.source).toBe("head");

    // Post-remap samples accumulate cleanly — no old-centerline blend.
    acc.addLateral(-0.1, 2);
    const s = acc.finalize(6)!;
    expect(s.meanLateralM).toBeCloseTo(-0.1, 6);
    expect(s.meanAbsLateralM).toBeCloseTo(0.1, 6);
  });
});

describe("reset()", () => {
  it("rearms every channel, the step counter, and the live taps", () => {
    const acc = armed(0.85);
    acc.addPace(1.5, 5);
    acc.addLateral(0.4, 5);
    acc.addPosture(-0.1, 5);
    acc.addStep(1);
    acc.noteSource("camera-world", 5);
    acc.livePaceMps = 1.5;
    acc.liveLateralM = 0.4;
    acc.livePostureM = -0.1;

    acc.reset(0.95);
    expect(acc.livePaceMps).toBeNull();
    expect(acc.liveLateralM).toBeNull();
    expect(acc.livePostureM).toBeNull();
    expect(acc.finalize(60)).toBeNull(); // nothing ingested since reset

    acc.noteSource("head", 1);
    acc.addPace(0.9, 1);
    // A strike right at walk start must count: the debounce clock rearms too.
    acc.addStep(0.01);
    const s = acc.finalize(30)!;
    expect(s.idealPaceMps).toBe(0.95);
    expect(s.meanPaceMps).toBe(0.9);
    expect(s.steps).toBe(1);
    expect(s.source).toBe("head");
  });
});
