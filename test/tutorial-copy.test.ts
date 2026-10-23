import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  TUTORIAL_STEPS,
  TUTORIAL_PACE_STEP,
  TUTORIAL_CARRIAGE_STEP,
  TUTORIAL_PREFS_STEP,
  TUTORIAL_NEXT_LABEL,
  TUTORIAL_DONE_LABEL,
  TUT_LEVEL_LABELS,
} from "../src/hud-copy.ts";

// The first-run IN-HEADSET TUTORIAL (2026-07-11). The whole product's teaching
// used to live only on the desktop landing and show at most once; a headset-
// first trainee got nothing (the new-user audit). This adds a six-card guided
// section (#tutorial-section) driven by HUDSystem from TUTORIAL_STEPS. This
// suite is the drift lock: it pins the six cards' content + honest framing, the
// markup elements the renderer writes into, and the six hud.ts wiring seams
// (field / byId / teardown / onClick / applySections / __PANEL_SECTION), the
// scoring-copy.test.ts precedent. panel-ascii.test.ts already sweeps the
// TUTORIAL_STEPS strings for the ASCII panel-font law.

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const uikitml = read("../ui/lesson.uikitml");
const hud = read("../src/hud.ts");

describe("tutorial copy (src/hud-copy.ts TUTORIAL_STEPS)", () => {
  it("has exactly eight cards in the coach's first-lesson order (prefs card 2026-07-16)", () => {
    expect(TUTORIAL_STEPS).toHaveLength(8);
    expect(TUTORIAL_STEPS.map((s) => s.kicker)).toEqual([
      "WELCOME",
      "MAKE IT YOURS",
      "YOUR RUNWAY",
      "CARRIAGE",
      "LINE",
      "PACE",
      "THE TURN",
      "READY",
    ]);
  });

  it("the MAKE IT YOURS card is index 1 and points at the preference pills", () => {
    expect(TUTORIAL_PREFS_STEP).toBe(1);
    expect(TUTORIAL_STEPS[TUTORIAL_PREFS_STEP].kicker).toBe("MAKE IT YOURS");
    // it must tell the novice these are changeable later (no lock-in fear).
    expect(TUTORIAL_STEPS[TUTORIAL_PREFS_STEP].body).toContain("SETTINGS");
  });

  it("the WELCOME card frames the first walk as practice for EVERYONE (not just pros)", () => {
    // Teacher + coach P0: the low-stakes framing must reach the beginner, who
    // needs it most - not only the emerging pro via the 'skip ahead' aside.
    expect(TUTORIAL_STEPS[0].body.toLowerCase()).toContain("practice");
  });

  it("THE TURN card teaches the pose + turn + return (the coach's P0)", () => {
    const turn = TUTORIAL_STEPS[6];
    expect(turn.kicker).toBe("THE TURN");
    expect(turn.body.toLowerCase()).toContain("pose");
    expect(turn.body.toLowerCase()).toContain("turn");
    // head-leaves-last is the industry turn cue (MasterClass).
    expect(turn.body.toLowerCase()).toContain("head");
  });

  it("every card carries a non-empty title + body (load-bearing text)", () => {
    for (const s of TUTORIAL_STEPS) {
      expect(s.title.length, s.kicker).toBeGreaterThan(0);
      expect(s.body.length, s.kicker).toBeGreaterThan(0);
    }
  });

  it("the three metric cards name the metric as a HEAD-motion proxy (honesty law)", () => {
    // CARRIAGE / LINE / PACE must each say the headset scores the HEAD — never
    // imply feet/spine/face/arms. This is the methodology.html cardinal law
    // carried into the first-run teaching.
    const carriage = TUTORIAL_STEPS[3];
    const line = TUTORIAL_STEPS[4];
    const pace = TUTORIAL_STEPS[5];
    expect(carriage.body.toLowerCase()).toContain("head");
    expect(line.body.toLowerCase()).toContain("head");
    expect(pace.body.toLowerCase()).toContain("head");
    // None of them may claim a body/feet/spine measurement.
    for (const s of [carriage, line, pace]) {
      for (const banned of ["your feet", "your spine", "your hips", "your body"]) {
        expect(s.body.toLowerCase(), `${s.kicker}: ${banned}`).not.toContain(
          banned.replace("your ", "measures your "),
        );
      }
    }
  });

  it("the READY card carries the head-only honesty capstone + the countdown baseline", () => {
    const ready = TUTORIAL_STEPS[7];
    expect(ready.body).toContain("head motion only");
    // The audit's find: CARRIAGE's neutral is captured during the countdown
    // stand — the trainee is never told to hold still. The card teaches it.
    expect(ready.body.toLowerCase()).toContain("countdown");
    expect(ready.body).toContain("PACE");
    expect(ready.body).toContain("CARRIAGE");
    expect(ready.body).toContain("LINE");
  });

  it("the PACE card is index 5 (the one with the cadence track)", () => {
    expect(TUTORIAL_PACE_STEP).toBe(5);
    expect(TUTORIAL_STEPS[TUTORIAL_PACE_STEP].kicker).toBe("PACE");
  });

  it("the CARRIAGE card is index 3 (the one with the live head-level indicator)", () => {
    expect(TUTORIAL_CARRIAGE_STEP).toBe(3);
    expect(TUTORIAL_STEPS[TUTORIAL_CARRIAGE_STEP].kicker).toBe("CARRIAGE");
  });

  it("the live-level labels are the three honest (head, not gaze) states", () => {
    // level in-band; below/above are directional chin corrections. HEAD
    // CARRIAGE never claims gaze - "chin" names head orientation.
    expect(TUT_LEVEL_LABELS.level).toBe("HEAD LEVEL");
    expect(TUT_LEVEL_LABELS.low).toBe("LIFT YOUR CHIN");
    expect(TUT_LEVEL_LABELS.high).toBe("EASE YOUR CHIN DOWN");
    for (const s of Object.values(TUT_LEVEL_LABELS)) {
      expect(s.length).toBeGreaterThan(0);
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(s), s).toBe(true); // ASCII panel-font law
      expect(s.toLowerCase(), s).not.toContain("eye"); // never a gaze claim
    }
  });

  it("the nav labels are the shipped strings", () => {
    expect(TUTORIAL_NEXT_LABEL).toBe("Next");
    expect(TUTORIAL_DONE_LABEL).toBe("Done");
  });
});

describe("tutorial markup (ui/lesson.uikitml #tutorial-section)", () => {
  it("declares the section + every element the renderer writes into", () => {
    expect(uikitml).toContain('id="tutorial-section"');
    for (const id of [
      "tut-kicker",
      "tut-title",
      "tut-body",
      "tut-cad",
      "tut-back",
      "tut-next",
      "tut-skip",
    ]) {
      expect(uikitml, id).toContain(`id="${id}"`);
    }
    // eight progress dots + five cadence pips.
    for (let i = 0; i < 8; i += 1) {
      expect(uikitml, `tut-dot-${i}`).toContain(`id="tut-dot-${i}"`);
    }
    for (let i = 0; i < 5; i += 1) {
      expect(uikitml, `tut-pip-${i}`).toContain(`id="tut-pip-${i}"`);
    }
    // the CARRIAGE-only live head-level indicator: wrapper + marker + zone +
    // label (the renderer slides the marker + glows the zone from head pitch).
    for (const id of ["tut-level", "tut-level-marker", "tut-level-zone", "tut-level-label"]) {
      expect(uikitml, id).toContain(`id="${id}"`);
    }
    // the label placeholder is LOAD-BEARING (an empty text element never renders).
    expect(uikitml).toMatch(/id="tut-level-label"[^>]*>[^<]+</);
    // the Settings replay entry point.
    expect(uikitml).toContain('id="set-guide"');
  });

  it("sits BEFORE #settings-section so it stays outside every copy-slice test window", () => {
    // scoring-copy / details-copy / controls-legend all slice at or after
    // settings-section; placing the tutorial before it keeps their windows clean.
    const tut = uikitml.indexOf('id="tutorial-section"');
    const settings = uikitml.indexOf('id="settings-section"');
    expect(tut).toBeGreaterThan(-1);
    expect(settings).toBeGreaterThan(tut);
  });
});

describe("tutorial wiring (src/hud.ts)", () => {
  it("mirrors the six section touch-points", () => {
    // field + byId + teardown null + applySections setDisplay + the dev hook.
    expect(hud).toContain('this.el<UIKit.Container>("tutorial-section")');
    expect(hud).toContain("this.tutorialSection = null;");
    expect(hud).toContain("this.setDisplay(this.tutorialSection, tutorial);");
    expect(hud).toContain('forced === "tutorial"');
  });

  it("wires the nav + replay controls", () => {
    expect(hud).toContain('this.onClick("tut-next", () => this.tutorialAdvance())');
    expect(hud).toContain('this.onClick("tut-back", () => this.tutorialBack())');
    expect(hud).toContain('this.onClick("tut-skip", () => this.closeTutorial())');
    expect(hud).toContain('this.onClick("set-guide", () => this.setTutorialOpen(true))');
  });

  it("auto-opens on the first XR entry whenever walk history is EMPTY (founder ruling 2026-07-22)", () => {
    expect(hud).toContain('const TUTORIAL_SEEN_KEY = "xrunway.xr-tutorial.v1";');
    expect(hud).toContain("this.enteredXrOnce = true;");
    expect(hud).toContain("if (this.shouldAutoOpenTutorial()) this.setTutorialOpen(true);");
    // The gate is the recorder walk count ALONE — the seen-key must NOT
    // suppress it (a fresh device / cleared history greets like a new
    // trainee even if the key was stamped in an earlier life).
    expect(hud).toContain("walkCount === 0");
    const gate = hud.slice(
      hud.indexOf("private shouldAutoOpenTutorial()"),
      hud.indexOf("}", hud.indexOf("return walkCount === 0")),
    );
    expect(gate).not.toContain("TUTORIAL_SEEN_KEY");
  });

  it("advances on the RIGHT A button while the card is shown", () => {
    expect(hud).toContain("rightPad.getButtonDown(InputComponent.A_Button)");
    expect(hud).toContain("this.tutorialShown()");
  });

  it("wires the live head-level indicator on the CARRIAGE card only", () => {
    // shown/hidden by step index (the tut-cad precedent) - CARRIAGE index 2.
    expect(hud).toContain("this.setDisplay(this.tutLevel, showLevel);");
    expect(hud).toContain("step === TUTORIAL_CARRIAGE_STEP");
    // the update() loop is gated on the CARRIAGE step + tutorialShown().
    expect(hud).toContain("this.tutorialStep === TUTORIAL_CARRIAGE_STEP");
    // the head-pitch read: live head direction off player.head, mapped to the
    // CARRIAGE scoring band (M8_PITCH_BAND_DEG) - proof the read is wired.
    expect(hud).toContain("this.player.head.getWorldDirection(this.tutLevelDir)");
    expect(hud).toContain("M8_PITCH_BAND_DEG");
    // the marker + label are painted from the live level state.
    expect(hud).toContain("TUT_LEVEL_LABELS[state]");
    expect(hud).toContain("transformTranslateX: q");
  });

  it("wires the MAKE IT YOURS preference pills to the SAME shared signals", () => {
    // markup: the wrapper + all five pills exist.
    expect(uikitml).toContain('id="tut-prefs"');
    for (const id of ["tut-music", "tut-mode", "tut-bpm", "tut-beat", "tut-duration"]) {
      expect(uikitml, id).toContain(`id="${id}"`);
    }
    // shown only on the prefs card (the tut-cad precedent).
    expect(hud).toContain("this.setDisplay(this.tutPrefs, showPrefs);");
    expect(hud).toContain("step === TUTORIAL_PREFS_STEP");
    // every pill writes the shared signal (never a private copy of state).
    expect(hud).toContain('this.onClick("tut-music"');
    expect(hud).toContain('this.onClick("tut-mode"');
    expect(hud).toContain('this.onClick("tut-bpm"');
    expect(hud).toContain('this.onClick("tut-beat"');
    expect(hud).toContain('this.onClick("tut-duration"');
    // labels are stamped by the settings update fns (twin writes).
    expect(hud).toContain("this.tutMusicBtn?.setProperties");
    expect(hud).toContain("this.tutModeBtn?.setProperties");
    expect(hud).toContain("this.tutBpmBtn?.setProperties");
    expect(hud).toContain("this.tutBeatBtn?.setProperties");
    expect(hud).toContain("this.tutDurationBtn?.setProperties");
  });
});
