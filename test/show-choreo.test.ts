import { describe, it, expect } from "vitest";
import {
  DEFAULT_FLOOR_ANCHORS,
  FINALE_ATTACK_SEC,
  FINALE_HOLD_SEC,
  FINALE_TOTAL_SEC,
  finaleEnvelope,
  floorAnchorUv,
  HOLD_FLASH_MAX,
  HOLD_HOUSE_DIM,
  HOLD_SPOT_TIGHTEN,
  holdRampT01,
  holdReleaseStep,
  IDLE_SWEEP_FRAC,
  idleSweepAmplitude,
} from "../src/show-choreo.js";
import { HOLD_RELEASE_SEC, HOLD_WINDOW_SEC } from "../src/hold-stats.js";
import {
  compileShape,
  DEFAULT_SHAPE,
  PRESET_RUNWAYS,
  sanitizeShape,
} from "../src/runway-shape.js";
import { POSE_INSET, START_INSET } from "../src/runway-layout.js";
import { STAGE } from "../src/theme.js";

// #18 — the finale beat: the spotlight snap + house-lights swell ride this
// envelope from the finish edge; it must attack fast, hold the hero moment,
// release cleanly, and be exactly 0 outside its window (so the summary mood
// resumes untouched).

describe("finaleEnvelope", () => {
  it("is silent before the finish edge and after full release", () => {
    expect(finaleEnvelope(-0.001)).toBe(0);
    expect(finaleEnvelope(FINALE_TOTAL_SEC)).toBe(0);
    expect(finaleEnvelope(FINALE_TOTAL_SEC + 10)).toBe(0);
  });

  it("snaps on: full level by the end of the attack", () => {
    expect(finaleEnvelope(0)).toBe(0);
    expect(finaleEnvelope(FINALE_ATTACK_SEC / 2)).toBeCloseTo(0.5, 9);
    expect(finaleEnvelope(FINALE_ATTACK_SEC)).toBe(1);
  });

  it("holds the hero beat at 1 through the hold window", () => {
    expect(finaleEnvelope((FINALE_ATTACK_SEC + FINALE_HOLD_SEC) / 2)).toBe(1);
    expect(finaleEnvelope(FINALE_HOLD_SEC)).toBe(1);
  });

  it("releases linearly back to the summary mood", () => {
    const mid = (FINALE_HOLD_SEC + FINALE_TOTAL_SEC) / 2;
    expect(finaleEnvelope(mid)).toBeCloseTo(0.5, 9);
    expect(finaleEnvelope(FINALE_TOTAL_SEC - 1e-6)).toBeLessThan(1e-4);
  });

  it("stays bounded in [0, 1] across the whole window (light-level safety)", () => {
    for (let t = -1; t <= FINALE_TOTAL_SEC + 1; t += 0.01) {
      const v = finaleEnvelope(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("keeps a sane beat shape: attack < hold < total", () => {
    expect(FINALE_ATTACK_SEC).toBeGreaterThan(0);
    expect(FINALE_HOLD_SEC).toBeGreaterThan(FINALE_ATTACK_SEC);
    expect(FINALE_TOTAL_SEC).toBeGreaterThan(FINALE_HOLD_SEC);
  });
});

// M10 THE HOLD — the presentation ramp + the stagecraft light-budget scalars.
// The MEASUREMENT is hold-stats.ts's (its own suite); these pins lock the
// pure math the director / stage / shader systems consume per frame.

describe("holdRampT01 (M10 — the published hold ramp)", () => {
  it("is 0 at and before the mark, and for junk clocks (dark-frame law)", () => {
    expect(holdRampT01(0)).toBe(0);
    expect(holdRampT01(-1)).toBe(0);
    expect(holdRampT01(Number.NaN)).toBe(0);
    expect(holdRampT01(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("rises linearly over the measured window to exactly 1", () => {
    expect(holdRampT01(HOLD_WINDOW_SEC / 2)).toBeCloseTo(0.5, 12);
    expect(holdRampT01(HOLD_WINDOW_SEC)).toBe(1);
  });

  it("releases linearly over HOLD_RELEASE_SEC, then rests at 0", () => {
    expect(holdRampT01(HOLD_WINDOW_SEC + HOLD_RELEASE_SEC / 2)).toBeCloseTo(
      0.5,
      12,
    );
    expect(holdRampT01(HOLD_WINDOW_SEC + HOLD_RELEASE_SEC)).toBe(0);
    expect(holdRampT01(HOLD_WINDOW_SEC + HOLD_RELEASE_SEC + 10)).toBe(0);
    expect(holdRampT01(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("stays bounded in [0, 1] across the whole span (light-level safety)", () => {
    for (let t = -1; t <= HOLD_WINDOW_SEC + HOLD_RELEASE_SEC + 1; t += 0.01) {
      const v = holdRampT01(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("holdReleaseStep (M10 — the walk->summary release decay)", () => {
  it("steps down by delta / HOLD_RELEASE_SEC (holdRampT01's release slope)", () => {
    const dt = 1 / 72;
    expect(holdReleaseStep(1, dt)).toBeCloseTo(1 - dt / HOLD_RELEASE_SEC, 12);
    expect(holdReleaseStep(0.5, dt)).toBeCloseTo(0.5 - dt / HOLD_RELEASE_SEC, 12);
  });

  it("reproduces holdRampT01's release tail when iterated from 1.0", () => {
    // A U finish flips walk->summary at t01 ~ 1.0; iterating the step must
    // trace the same linear tail the ramp would have played (frame after the
    // flip stays within one frame-slope of the pre-flip value — the review's
    // no-step pin).
    const dt = 1 / 72;
    let v = holdRampT01(HOLD_WINDOW_SEC); // 1.0 at the flip frame
    expect(holdReleaseStep(v, dt)).toBeCloseTo(
      holdRampT01(HOLD_WINDOW_SEC + dt),
      12,
    );
    let t = HOLD_WINDOW_SEC;
    for (let i = 0; i < 100; i++) {
      v = holdReleaseStep(v, dt);
      t += dt;
      expect(v).toBeCloseTo(holdRampT01(t), 9);
    }
    expect(v).toBe(0); // 100 frames at 72 Hz > 0.6 s — fully released
  });

  it("floors at exactly 0 and never undershoots", () => {
    expect(holdReleaseStep(0, 1 / 72)).toBe(0);
    expect(holdReleaseStep(0.001, 10)).toBe(0);
  });

  it("junk value or delta drives no light (dark-frame law)", () => {
    expect(holdReleaseStep(Number.NaN, 1 / 72)).toBe(0);
    expect(holdReleaseStep(1, Number.NaN)).toBe(0);
    expect(holdReleaseStep(1, Number.NEGATIVE_INFINITY)).toBe(0);
    expect(holdReleaseStep(Number.POSITIVE_INFINITY, 1 / 72)).toBe(0);
  });
});

describe("M10 stagecraft scalars (the GPU/light-budget arithmetic)", () => {
  it("spot cone survives the worst-case overlap (full show + finale + hold)", () => {
    // stage.ts: spot.angle = 0.38 - (0.08 + 0.05*intensity)*energy
    //                        - 0.06*finale - HOLD_SPOT_TIGHTEN*holdT.
    // Worst case: intensity 1, energy 1, finale 1, holdT 1 (U route: finale
    // fires at window end while the release still holds).
    const worst = 0.38 - (0.08 + 0.05 * 1) * 1 - 0.06 * 1 - HOLD_SPOT_TIGHTEN;
    expect(HOLD_SPOT_TIGHTEN).toBe(0.06); // the finale's own tighten quantum
    expect(worst).toBeCloseTo(0.13, 12);
    expect(worst).toBeGreaterThan(0); // the cone never closes
  });

  it("house dim is one photographic stop at full energy, floor at black", () => {
    // stage.ts: hemi = max(0, 0.5 - 0.32*energy + 0.35*finale
    //                          - HOLD_HOUSE_DIM*holdT*energy).
    const fullShowHouse = 0.5 - 0.32 * 1; // 0.18
    expect(HOLD_HOUSE_DIM).toBeCloseTo(fullShowHouse / 2, 12); // a halving
    // Worst case without the finale swell: still above black.
    expect(fullShowHouse - HOLD_HOUSE_DIM * 1 * 1).toBeCloseTo(0.09, 12);
    expect(fullShowHouse - HOLD_HOUSE_DIM).toBeGreaterThan(0);
  });

  it("flash surge floor stays below the finale wall", () => {
    // shaders.ts FLASH_VERT gate scale = 0.65 + 0.34*b: b = 1 (finale) ->
    // 0.99 (the wall); the sustained stillness storm at HOLD_FLASH_MAX ->
    // ~0.888 — visibly a storm, and the finale stays the show's peak.
    expect(HOLD_FLASH_MAX).toBe(0.7);
    const gate = (b: number) => 0.65 + 0.34 * b;
    expect(gate(HOLD_FLASH_MAX)).toBeCloseTo(0.888, 3);
    expect(gate(HOLD_FLASH_MAX)).toBeLessThan(gate(1));
  });
});

// #45 — choreography scales with the MAPPED runway, with the 7 m default
// preserved: the sweep amplitude is byte-identical to the legacy hard-coded
// STAGE.deckLength * 0.33, and the floor anchors resolve to the classic
// start-line / pose-mark insets (in the unified floor's CORRECT uv
// orientation — the legacy compile-time constants were baked in the old
// plane frame, which the unified bbox geometry inverted).

describe("idleSweepAmplitude (#45 — spotlight idle sweep)", () => {
  it("reproduces the legacy hard-coded amplitude at the default 7 m", () => {
    expect(idleSweepAmplitude(STAGE.deckLength)).toBeCloseTo(
      STAGE.deckLength * 0.33,
      12,
    );
    expect(IDLE_SWEEP_FRAC).toBe(0.33);
  });

  it("scales linearly with the mapped length (a 60 m deck is swept end to end)", () => {
    expect(idleSweepAmplitude(20)).toBeCloseTo(6.6, 9);
    expect(idleSweepAmplitude(60)).toBeCloseTo(19.8, 9);
  });
});

describe("floorAnchorUv (#45 — live start/pose anchors, bbox-uv frame)", () => {
  it("default 7 m straight: anchors sit exactly on the classic marks", () => {
    const a = floorAnchorUv(compileShape(DEFAULT_SHAPE));
    // Centerline across; start line START_INSET from the near (uv.y = 1) end,
    // pose mark POSE_INSET from the far (uv.y = 0) end.
    expect(a.startX).toBeCloseTo(0.5, 9);
    expect(a.poseX).toBeCloseTo(0.5, 9);
    expect(a.startY).toBeCloseTo(1 - START_INSET / STAGE.deckLength, 9);
    expect(a.poseY).toBeCloseTo(POSE_INSET / STAGE.deckLength, 9);
  });

  it("longer straight runways keep the METRIC insets (fractions re-derive)", () => {
    const a = floorAnchorUv(
      compileShape(sanitizeShape({ kind: "straight", spineLength: 20 })),
    );
    expect(a.startY).toBeCloseTo(1 - START_INSET / 20, 9);
    expect(a.poseY).toBeCloseTo(POSE_INSET / 20, 9);
  });

  it("anchors are placement-invariant (world center/yaw never leak in)", () => {
    const home = floorAnchorUv(
      compileShape(sanitizeShape({ kind: "U", spineLength: 7, armSpan: 2 })),
    );
    const moved = floorAnchorUv(
      compileShape(
        sanitizeShape({
          kind: "U",
          spineLength: 7,
          armSpan: 2,
          centerX: 5.2,
          centerZ: -11,
          yaw: 1.1,
        }),
      ),
    );
    expect(moved.startX).toBeCloseTo(home.startX, 9);
    expect(moved.startY).toBeCloseTo(home.startY, 9);
    expect(moved.poseX).toBeCloseTo(home.poseX, 9);
    expect(moved.poseY).toBeCloseTo(home.poseY, 9);
  });

  it("U: the pose anchor lands on legB (off the bbox centerline), start on legA", () => {
    const path = compileShape(
      sanitizeShape({ kind: "U", spineLength: 7, armSpan: 2, spineWidth: 1.4 }),
    );
    const a = floorAnchorUv(path);
    // legA is one side of the horseshoe, legB the other.
    expect(a.startX).toBeLessThan(0.35);
    expect(a.poseX).toBeGreaterThan(0.65);
    // Both route ends sit near the OPEN end of the U (uv.y toward 1) — the
    // pose mark is NOT at the bbox far end the way the legacy constant assumed.
    expect(a.startY).toBeGreaterThan(0.9);
    expect(a.poseY).toBeGreaterThan(0.85);
  });

  it("every anchor stays inside the floor's uv space on all preset shapes", () => {
    for (const preset of PRESET_RUNWAYS) {
      const a = floorAnchorUv(compileShape(sanitizeShape(preset.shape)));
      for (const v of [a.startX, a.startY, a.poseX, a.poseY]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("DEFAULT_FLOOR_ANCHORS (the material seeds) match the default shape", () => {
    expect(DEFAULT_FLOOR_ANCHORS).toEqual(floorAnchorUv(compileShape(DEFAULT_SHAPE)));
  });
});
