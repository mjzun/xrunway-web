import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  CAMERA_BACK_CUE,
  CAMERA_DROP_CUE,
  COACH_LINE_MUTED,
  COACH_LINE_OFF,
  COACH_LINE_ON,
  coachPromiseLine,
  FIT_BUSY_TOAST,
  FIT_NEEDS_HEADSET_TOAST,
  FIT_STATUS_LINES,
  fitAgeDays,
  fitCardStatusLine,
  fitPanelStatusLine,
  MAP_FIT_BLOCKED_NOTICE,
  MAP_NOTES,
  MAP_PROMPTS,
  MAP_TOO_SHORT_NOTICE,
  MEDAL_COLOR,
  MEDAL_LABEL,
  MEDAL_POP_SEC,
  medalPopScale,
  scoreMedal,
  trackingSourceLabel,
  type FitStatus,
  type PanelMapMode,
} from "../src/hud-copy.js";

// (ASCII-ness of every exported string is enforced module-wide by
// test/panel-ascii.test.ts — these tests pin the SEMANTICS of the copy.)

describe("FIT_STATUS_LINES (#15: fit-to-room must not fail silently)", () => {
  it("covers every non-idle fit status with a line + color", () => {
    const statuses: Array<Exclude<FitStatus, "idle">> = [
      "searching",
      "no-floor",
      "fitted",
    ];
    for (const s of statuses) {
      expect(FIT_STATUS_LINES[s].text.trim()).not.toBe("");
      expect(FIT_STATUS_LINES[s].color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("tells the trainee what is happening while armed", () => {
    expect(FIT_STATUS_LINES.searching.text).toMatch(/floor/i);
  });

  it("the no-floor hint names the actual fix (saved Space + spatial data)", () => {
    const hint = FIT_STATUS_LINES["no-floor"].text;
    expect(hint).toMatch(/no floor/i);
    expect(hint).toMatch(/Space/);
    expect(hint).toMatch(/spatial data/i);
  });

  it("confirms success in plain language", () => {
    expect(FIT_STATUS_LINES.fitted.text).toMatch(/fitted/i);
  });
});

describe("mapping guidance (#17: no unguided steps in walk-and-place)", () => {
  const modes: PanelMapMode[] = ["placing-start", "placing-end", "adjust"];

  it("every mapping mode has a prompt AND a how-to note", () => {
    for (const m of modes) {
      expect(MAP_PROMPTS[m].trim()).not.toBe("");
      expect(MAP_NOTES[m].trim()).not.toBe("");
    }
  });

  it("the adjust step documents its controls (right stick width + A/CONFIRM commit)", () => {
    expect(MAP_NOTES.adjust).toMatch(/right stick/i);
    expect(MAP_NOTES.adjust).toMatch(/\bA\b/);
    expect(MAP_NOTES.adjust).toMatch(/confirm/i);
  });

  it("both placing steps name the trigger", () => {
    expect(MAP_NOTES["placing-start"]).toMatch(/trigger/i);
    expect(MAP_NOTES["placing-end"]).toMatch(/trigger/i);
  });

  it("placing-end acknowledges the start landed and states the ENFORCED minimum", () => {
    expect(MAP_NOTES["placing-end"]).toMatch(/start placed/i);
    // Deliberately pinned to the gate mapping.ts actually enforces
    // (Math.hypot(dx, dz) < 0.4) — the earlier "half a meter" copy
    // overstated the rule by 20% (night-review #19). If this number moves,
    // move the gate and this copy TOGETHER.
    expect(MAP_NOTES["placing-end"]).toMatch(/0\.4 m/);
    expect(MAP_NOTES["placing-end"]).not.toMatch(/half a meter/i);
  });

  it("the rejected-placement notice says what went wrong and what to do", () => {
    expect(MAP_TOO_SHORT_NOTICE).toMatch(/too short/i);
    expect(MAP_TOO_SHORT_NOTICE).toMatch(/keep walking/i);
  });

  it("the mid-mapping fit-refusal notice names the exits (wording pin, F.22)", () => {
    // The MAP_TOO_SHORT precedent: say why nothing happened + what to do.
    expect(MAP_FIT_BLOCKED_NOTICE).toMatch(/mapping/i);
    expect(MAP_FIT_BLOCKED_NOTICE).toMatch(/confirm|cancel/i);
  });
});

describe("trackingSourceLabel (#32/#46: pose provenance in the headset)", () => {
  it("is HEAD ONLY whenever no camera is scoring, regardless of last space", () => {
    expect(trackingSourceLabel(false, null)).toBe("HEAD ONLY");
    expect(trackingSourceLabel(false, undefined)).toBe("HEAD ONLY");
    expect(trackingSourceLabel(false, "world")).toBe("HEAD ONLY");
    expect(trackingSourceLabel(false, "image")).toBe("HEAD ONLY");
  });

  it("labels the browser image stream (and unknown space) as CAMERA", () => {
    expect(trackingSourceLabel(true, "image")).toBe("CAMERA");
    expect(trackingSourceLabel(true, null)).toBe("CAMERA");
    expect(trackingSourceLabel(true, undefined)).toBe("CAMERA");
  });

  it("labels the native world stream as CAMERA (ARKIT)", () => {
    expect(trackingSourceLabel(true, "world")).toBe("CAMERA (ARKIT)");
  });

  it("the drop cue names both the event and the consequence", () => {
    expect(CAMERA_DROP_CUE).toMatch(/camera dropped/i);
    expect(CAMERA_DROP_CUE).toMatch(/head/i);
    expect(CAMERA_BACK_CUE).toMatch(/camera/i);
  });
});

describe("coachPromiseLine (night-review: the brief must not promise silenced speech)", () => {
  it("promises speech only when the coach is on AND music is audible", () => {
    expect(coachPromiseLine(true, { enabled: true, volume: 0.7 })).toBe(
      COACH_LINE_ON,
    );
  });

  it("states the off state when COACH VOICE is toggled off", () => {
    expect(coachPromiseLine(false, { enabled: true, volume: 0.7 })).toBe(
      COACH_LINE_OFF,
    );
    // Coach off wins over mute — it's the direct control being described.
    expect(coachPromiseLine(false, { enabled: false, volume: 0 })).toBe(
      COACH_LINE_OFF,
    );
  });

  it("music mute silences the coach: enabled=false AND volume 0 both read muted", () => {
    expect(coachPromiseLine(true, { enabled: false, volume: 0.7 })).toBe(
      COACH_LINE_MUTED,
    );
    // Volume 0 IS mute — the same sfxLevel() law CoachLiveSystem gates on.
    expect(coachPromiseLine(true, { enabled: true, volume: 0 })).toBe(
      COACH_LINE_MUTED,
    );
  });

  it("every variant tells the trainee it is about the coach voice", () => {
    for (const line of [COACH_LINE_ON, COACH_LINE_OFF, COACH_LINE_MUTED]) {
      expect(line).toMatch(/coach/i);
      expect(line.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("FIT body-baseline status lines (Wave 1 — §K honesty labels)", () => {
  const DAY = 86_400_000;
  const b = (capturedAt: number) => ({
    capturedAt,
    standHeightM: 1.72,
    bobAmpM: 0.012,
    paceMps: 0.94,
  });

  it("fitAgeDays: whole days, clamped at 0 for under-24h and junk", () => {
    expect(fitAgeDays(0, DAY * 3 + 5)).toBe(3);
    expect(fitAgeDays(0, DAY - 1)).toBe(0);
    expect(fitAgeDays(1000, 0)).toBe(0); // future-junk clamps (display-only)
    expect(fitAgeDays(NaN, 0)).toBe(0);
  });

  it("panel status: not set / set today / set <n>d ago", () => {
    expect(fitPanelStatusLine(null, DAY)).toBe("Fit: not set");
    expect(fitPanelStatusLine(DAY - 1000, DAY)).toBe("Fit: set today");
    expect(fitPanelStatusLine(0, DAY * 3)).toBe("Fit: set 3d ago");
  });

  it("card status, no baseline: states the standard-baseline fact", () => {
    expect(fitCardStatusLine(null, DAY)).toBe(
      "FIT: NOT SET - scores use the standard body baseline.",
    );
  });

  it("card status says HEAD HEIGHT — never body height (§K), with age + mm bob + pace", () => {
    expect(fitCardStatusLine(b(0), DAY * 3)).toBe(
      "FIT: SET 3 DAYS AGO - HEAD HEIGHT 1.72 M, BOB 12 MM, PACE 0.94 M/S.",
    );
    expect(fitCardStatusLine(b(0), DAY - 1)).toBe(
      "FIT: SET TODAY - HEAD HEIGHT 1.72 M, BOB 12 MM, PACE 0.94 M/S.",
    );
    expect(fitCardStatusLine(b(0), DAY)).toContain("SET 1 DAY AGO"); // singular
    expect(fitCardStatusLine(b(0), DAY * 3)).not.toMatch(/body height/i);
  });

  it("the landing toasts name the actual next step", () => {
    expect(FIT_NEEDS_HEADSET_TOAST).toMatch(/headset/i);
    expect(FIT_BUSY_TOAST).toMatch(/run fit/i);
  });
});

describe("the MEDAL moment (RANKING medal - founder ruling 2026-07-10)", () => {
  it("the badge is the walk's RANK: 1st gold, 2nd silver, 3rd bronze, one score = gold", () => {
    expect(scoreMedal(1)).toBe("gold");
    expect(scoreMedal(2)).toBe("silver");
    expect(scoreMedal(3)).toBe("bronze");
    // defensive: a rank <= 1 (shouldn't occur; medalRank floors at 1) is 1st.
    expect(scoreMedal(0)).toBe("gold");
  });

  it("4th-or-worse earns no badge - only the top three positions medal", () => {
    expect(scoreMedal(4)).toBeNull();
    expect(scoreMedal(10)).toBeNull();
  });

  it("junk / non-finite / null rank never medals", () => {
    expect(scoreMedal(null)).toBeNull();
    expect(scoreMedal(Number.NaN)).toBeNull();
    expect(scoreMedal(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("labels are the structural ASCII caps set; badge metals are brand hexes", () => {
    expect(MEDAL_LABEL).toEqual({ bronze: "BRONZE", silver: "SILVER", gold: "GOLD" });
    for (const c of Object.values(MEDAL_COLOR)) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    // gold + silver ARE the BRAND_CSS metals (theme.ts) - pinned so a brand
    // retune moves the badge with it.
    expect(MEDAL_COLOR.gold).toBe("#d9b78a");
    expect(MEDAL_COLOR.silver).toBe("#8a8f96");
  });

  it("the pop envelope: 0.6 in, 1.08 overshoot at t=0.7, settles to 1.0, junk-clamped", () => {
    expect(medalPopScale(0)).toBeCloseTo(0.6, 10);
    expect(medalPopScale(0.7)).toBeCloseTo(1.08, 10);
    expect(medalPopScale(1)).toBeCloseTo(1.0, 10);
    expect(medalPopScale(5)).toBeCloseTo(1.0, 10); // over-run clamps settled
    expect(medalPopScale(-1)).toBeCloseTo(0.6, 10);
    expect(medalPopScale(Number.NaN)).toBeCloseTo(1.0, 10); // junk = settled
    // monotonic rise to the overshoot peak
    let prev = -1;
    for (let t = 0; t <= 0.7001; t += 0.05) {
      const s = medalPopScale(t);
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
    expect(MEDAL_POP_SEC).toBeGreaterThan(0.2);
    expect(MEDAL_POP_SEC).toBeLessThan(1);
  });

  it("the hud + markup wire the badge (source-text seams - hud.ts is not vitest-loadable)", () => {
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const hud = read("../src/hud.ts");
    expect(hud).toContain('this.el<UIKit.Container>("medal-badge")');
    expect(hud).toContain("scoreMedal(medalRank(summary.overall, traineeHistory))");
    expect(hud).toContain("this.medalDelayRemaining = REVEAL_DELAY_SEC;");
    expect(hud).toContain("medalPopScale(t)");
    const uikitml = read("../ui/lesson.uikitml");
    expect(uikitml).toContain('id="medal-badge"');
    expect(uikitml).toContain('id="medal-text"');
  });
});
