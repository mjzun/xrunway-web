import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEAD_NORMALIZATION,
  deriveHeadNormalization,
} from "../src/body-baseline.ts";
import { fitStartRefusal, type FitStartState } from "../src/fit-wiring.ts";

// The engine wrapper (fit-session-system.ts) cannot load under vitest
// (@iwsdk/core) — its DECISIONS are extracted pure (the hud-state.ts
// precedent) and pinned here: the caller-side start refusals, and the exact
// no-baseline call shape the wiring makes into the scoring lock.

function state(over: Partial<FitStartState> = {}): FitStartState {
  return {
    phase: "idle",
    demoActive: false,
    mapMode: "off",
    flowActive: false,
    ...over,
  };
}

describe("fitStartRefusal (caller-side refusals, spec §4.3)", () => {
  it("allows a start only when idle, not mapping, no demo, no live flow", () => {
    expect(fitStartRefusal(state())).toBeNull();
  });

  it("refuses outside idle — every show phase that is not idle", () => {
    for (const phase of ["brief", "countdown", "walk", "summary"]) {
      expect(fitStartRefusal(state({ phase }))).toBe("not-idle");
    }
  });

  it("refuses while the Preview Walk auto-pilot drives the rig", () => {
    expect(fitStartRefusal(state({ demoActive: true }))).toBe("demo");
  });

  it("refuses while mapping owns the floor (any non-off mode)", () => {
    for (const mapMode of ["placing-start", "placing-end", "adjust"]) {
      expect(fitStartRefusal(state({ mapMode }))).toBe("mapping");
    }
  });

  it("refuses a double-start (incl. the terminal hold) — most specific first", () => {
    expect(fitStartRefusal(state({ flowActive: true }))).toBe(
      "already-running",
    );
    // An active flow wins over every other reason: the flow already owns
    // whatever state the show is in.
    expect(
      fitStartRefusal(state({ flowActive: true, phase: "walk" })),
    ).toBe("already-running");
  });
});

describe("the wiring's no-baseline call shape (the identity pin, wiring side)", () => {
  it("the exact beginWalkTracking fallback shape returns the frozen default BY REFERENCE", () => {
    // metrics.ts calls deriveHeadNormalization(fitSig?.peek() ?? null,
    // userSig?.peek()?.id ?? null) — absent signals collapse to (null, null).
    // The result must be the IDENTICAL frozen factory object (not a copy):
    // scoring cannot drift for anyone who never runs FIT.
    expect(deriveHeadNormalization(null, null)).toBe(
      DEFAULT_HEAD_NORMALIZATION,
    );
    expect(deriveHeadNormalization(null, "001")).toBe(
      DEFAULT_HEAD_NORMALIZATION,
    );
    // The frozen object IS the pair of deleted metrics.ts constants + the
    // default stamp (the byte-identity pin, restated at the wiring seam).
    expect(DEFAULT_HEAD_NORMALIZATION).toEqual({
      bobThresholdM: 0.004,
      postureSlopePerM: 350,
      stamp: "default.v1",
    });
  });
});
