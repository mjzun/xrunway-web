import { describe, it, expect } from "vitest";
import {
  mapFlowActive,
  settingsPanelShown,
  snapTurnPaused,
  walkLocomotionPaused,
  type SettingsVisibilityState,
} from "../src/hud-state.js";

// Locks in REVIEW-FINDINGS H4 / M5 / L13: the scrub + snap-turn pause must key off
// whether the settings panel is ACTUALLY shown, not raw settingsOpen — so the stick
// can't mutate the runway while the panel is hidden, and snap-turn always resumes.

// The fully-shown baseline; each case overrides one field.
const SHOWN: SettingsVisibilityState = {
  settingsOpen: true,
  mapMode: "off",
  phase: "idle",
  hudVisible: true,
  inXR: true,
};

describe("settingsPanelShown", () => {
  it("is true only when open, in XR, not mapping, not mid-walk, HUD visible", () => {
    expect(settingsPanelShown(SHOWN)).toBe(true);
  });

  it("is false when the panel is not open", () => {
    expect(settingsPanelShown({ ...SHOWN, settingsOpen: false })).toBe(false);
  });

  it("is false while mapping owns the panel (H4: MAP opened with settings still open)", () => {
    for (const mapMode of ["placing-start", "placing-end", "adjust"]) {
      expect(settingsPanelShown({ ...SHOWN, mapMode })).toBe(false);
    }
  });

  it("is false mid-walk (H4: a walk started without the Done button)", () => {
    for (const phase of ["countdown", "walk"]) {
      expect(settingsPanelShown({ ...SHOWN, phase })).toBe(false);
    }
  });

  it("stays shown in the idle / brief / summary phases", () => {
    for (const phase of ["idle", "brief", "summary"]) {
      expect(settingsPanelShown({ ...SHOWN, phase })).toBe(true);
    }
  });

  it("is false when the HUD is B-hidden (M5: turn must resume, scrub must stop)", () => {
    expect(settingsPanelShown({ ...SHOWN, hudVisible: false })).toBe(false);
  });

  it("is false outside XR (L13: never fight the browser demo's TurnSystem pause)", () => {
    expect(settingsPanelShown({ ...SHOWN, inXR: false })).toBe(false);
  });
});

// The Quest tester's "throws you off the runway" fix (2026-07-09): virtual
// locomotion must never move the rig under a PHYSICAL graded walk — IWSDK's
// snap turn pivots about the XR ORIGIN (not the head), so a stick flick at
// the end of a short runway sweeps the deck metres sideways; slide/teleport
// relocate the rig outright. One HUD reconciler keys off these predicates.
describe("walkLocomotionPaused", () => {
  it("pauses slide+teleport for the whole XR graded walk (countdown included)", () => {
    expect(walkLocomotionPaused("countdown", true, false)).toBe(true);
    expect(walkLocomotionPaused("walk", true, false)).toBe(true);
  });

  it("frees the stick outside the walk (idle/brief/summary) — look around, find the panel", () => {
    for (const phase of ["idle", "brief", "summary", "mapping"]) {
      expect(walkLocomotionPaused(phase, true, false)).toBe(false);
    }
  });

  it("never pauses in the browser (W/A/S/D IS slide; the demo manages its own pause)", () => {
    expect(walkLocomotionPaused("walk", false, false)).toBe(false);
    expect(walkLocomotionPaused("countdown", false, false)).toBe(false);
  });

  it("never pauses in the EMULATED headset — stick/WASD is the only way a laptop viewer moves (founder repro 2026-07-10)", () => {
    expect(walkLocomotionPaused("countdown", true, true)).toBe(false);
    expect(walkLocomotionPaused("walk", true, true)).toBe(false);
  });
});

describe("snapTurnPaused", () => {
  it("pauses with the walk, with a scrub, and with mapping ADJUST (the width stick)", () => {
    expect(snapTurnPaused("walk", true, false, "off", false)).toBe(true);
    expect(snapTurnPaused("countdown", true, false, "off", false)).toBe(true);
    expect(snapTurnPaused("idle", true, true, "off", false)).toBe(true);
    expect(snapTurnPaused("idle", true, false, "adjust", false)).toBe(true);
  });

  it("stays free at summary with no scrub and no mapping — the parked panel stays findable", () => {
    expect(snapTurnPaused("summary", true, false, "off", false)).toBe(false);
    expect(snapTurnPaused("idle", true, false, "off", false)).toBe(false);
    // placing modes keep the turn too: the trainee physically walks the floor.
    expect(snapTurnPaused("idle", true, false, "placing-start", false)).toBe(false);
    expect(snapTurnPaused("idle", true, false, "placing-end", false)).toBe(false);
  });

  it("browser is never affected", () => {
    expect(snapTurnPaused("walk", false, true, "adjust", false)).toBe(false);
  });

  it("emulated: the walk pause lifts, but the same-stick input conflicts stay", () => {
    // The physical-walk claim is emulation-exempt...
    expect(snapTurnPaused("walk", true, false, "off", true)).toBe(false);
    // ...but a scrub / mapping width nudge fights the SAME stick on a laptop
    // exactly as on a Quest — those pauses hold.
    expect(snapTurnPaused("idle", true, true, "off", true)).toBe(true);
    expect(snapTurnPaused("idle", true, false, "adjust", true)).toBe(true);
  });
});

describe("mapFlowActive (the mid-mapping booby-trap gate, tester 2026-07-09)", () => {
  it("RIGHT B panel toggle is inert while mapping owns the panel", () => {
    // hud.ts's B-toggle condition carries !mapFlowActive(mapMode): a mid-flow
    // hide left the state machine running headless (invisible prompts,
    // un-clickable CANCEL/CONFIRM).
    expect(mapFlowActive("placing-start")).toBe(true);
    expect(mapFlowActive("placing-end")).toBe(true);
    expect(mapFlowActive("adjust")).toBe(true);
  });

  it("fit-to-room arm is refused while mapping (X/Y mid-flow)", () => {
    // mapping.ts autoMapFromFloor refuses when mapMode != "off" (the twin
    // chokepoint check) — a landed fit would force-cancel the flow and
    // discard the placed points. Same truth table, both consumers.
    for (const mode of ["placing-start", "placing-end", "adjust"]) {
      expect(mapFlowActive(mode)).toBe(true);
    }
  });

  it("both inputs are live again once mapping is off", () => {
    expect(mapFlowActive("off")).toBe(false);
  });
});
