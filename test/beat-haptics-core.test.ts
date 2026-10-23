import { describe, expect, it } from "vitest";

import {
  goReinforceFires,
  pulseFrameAction,
  walkDeliveryNext,
} from "../src/beat-haptics-core.ts";

// M9 BEAT-IN-THE-HAND — the adjudication-§E decision laws, pinned on the
// PURE step BeatHapticsSystem runs every frame (beat-haptics-core.ts, the
// hud-state.ts precedent): firing is gated per phase on the matching pref,
// a gated-off frame still ADVANCES the grid pointer (mid-walk enable needs
// no re-arm), and EVERY disarm path nulls the delivery fact in the SAME
// frame. The tick arithmetic itself (firstPulseTick / advancePulseTick /
// countdownFlamSuppressed) is pinned in beat-stats.test.ts.

describe("pulseFrameAction (the per-phase firing gate)", () => {
  it("countdown fires on prefs.countdown, walk fires on prefs.walk", () => {
    expect(pulseFrameAction("countdown", true, true, false)).toBe("fire");
    expect(pulseFrameAction("countdown", true, false, true)).toBe("advance");
    expect(pulseFrameAction("walk", true, false, true)).toBe("fire");
    expect(pulseFrameAction("walk", true, true, false)).toBe("advance");
  });

  it("a gated-off frame ADVANCES (never idles): the grid pointer keeps tracking so a mid-walk enable fires from the cached anchor", () => {
    expect(pulseFrameAction("walk", true, true, false)).toBe("advance");
    expect(pulseFrameAction("countdown", true, false, false)).toBe("advance");
  });

  it("a suspended ctx idles regardless of prefs (frozen clock AND inaudible reference)", () => {
    expect(pulseFrameAction("walk", false, true, true)).toBe("idle");
    expect(pulseFrameAction("countdown", false, true, true)).toBe("idle");
  });

  it("outside the train phases nothing runs", () => {
    expect(pulseFrameAction("off", true, true, true)).toBe("idle");
  });
});

describe("walkDeliveryNext (§E: every disarm path nulls the fact SAME frame)", () => {
  it("mid-walk pref OFF: the advance frame nulls delivery immediately", () => {
    // prev = "haptic" (the train was delivering) -> pref flips off -> the
    // very frame the gate reads "advance", the fact is null.
    expect(walkDeliveryNext("walk", "advance", false, null, "haptic")).toBe(
      null,
    );
    // ...even on a frame that also reached a tick.
    expect(walkDeliveryNext("walk", "advance", true, null, "haptic")).toBe(
      null,
    );
  });

  it("mid-walk pref ON: delivery stays null until the first tick actually fires, then carries the emitted kind", () => {
    // enable frame, no tick reached yet -> prev (null) stands
    expect(walkDeliveryNext("walk", "fire", false, null, null)).toBe(null);
    // the first reached tick emits -> the fact opens with the emitted kind
    expect(walkDeliveryNext("walk", "fire", true, "haptic", null)).toBe(
      "haptic",
    );
    // between ticks the last beat's fact stands
    expect(walkDeliveryNext("walk", "fire", false, null, "haptic")).toBe(
      "haptic",
    );
  });

  it("suspended ctx (action idle) nulls delivery the same frame", () => {
    expect(walkDeliveryNext("walk", "idle", false, null, "earcon")).toBe(null);
  });

  it("phase exit nulls delivery; countdown pulses never open the gate", () => {
    expect(walkDeliveryNext("off", "idle", false, null, "haptic")).toBe(null);
    // countdown fires but the walk fact stays closed.
    expect(walkDeliveryNext("countdown", "fire", true, "haptic", null)).toBe(
      null,
    );
  });

  it("actuator loss + muted earcon: a reached tick that emitted NOTHING writes null (the setting never fakes delivery)", () => {
    expect(walkDeliveryNext("walk", "fire", true, null, "haptic")).toBe(null);
  });

  it("the hand-tracking fallback reports the disclosed earcon kind", () => {
    expect(walkDeliveryNext("walk", "fire", true, "earcon", "earcon")).toBe(
      "earcon",
    );
  });
});

describe("goReinforceFires (GO drop pulse — phase-independent, deterministic)", () => {
  it("fires the GO tick whenever the countdown pref is on and the clock runs", () => {
    expect(goReinforceFires(true, true, true)).toBe(true);
  });

  it("is phase-INDEPENDENT: no phase param, so the countdown->walk flip race can never change the GO decision", () => {
    // The whole point of the fix — the decision does not depend on the
    // current show phase (which side of the flip the crossing frame landed
    // on), only on the pref + a running clock.
    expect(goReinforceFires(true, true, true)).toBe(true);
    expect(goReinforceFires(true, true, false)).toBe(false); // dead ctx
  });

  it("never fires a non-GO tick (that is the phase gate's job)", () => {
    expect(goReinforceFires(false, true, true)).toBe(false);
  });

  it("respects the countdown pref: off => no GO reinforcement", () => {
    expect(goReinforceFires(true, false, true)).toBe(false);
  });
});
