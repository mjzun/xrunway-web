import { describe, it, expect } from "vitest";
import {
  DEFAULT_PASS_THRESHOLD,
  REVEAL_DELAY_SEC,
  revealVariant,
  SFX_EVENTS,
  SFX_MASTER_LEVEL,
  SFX_VOICES,
  sfxEvent,
  sfxLevel,
  type SfxEventId,
} from "../src/sfx-timeline.js";
import { DEFAULT_MUSIC } from "../src/music-prefs.js";

// #19 — the SFX event table: every signature show moment that used to be
// silent has exactly one voiced event, wired to the right signal.

describe("SFX event table", () => {
  const PINNED: Array<[SfxEventId, string]> = [
    ["countdown-tick", "phase:countdown"],
    ["go-hit", "clock:go"],
    ["footstrike", "edge:lastStep"],
    ["pose-sting", "edge:poseBurst"],
    ["finale-hit", "edge:finishBurst"],
    ["reveal-sting", "phase:summary"],
  ];

  it("covers exactly the six pinned signature moments", () => {
    expect(SFX_EVENTS).toHaveLength(PINNED.length);
    for (const [id, trigger] of PINNED) {
      const spec = sfxEvent(id);
      expect(spec.trigger).toBe(trigger);
    }
  });

  it("every edge:* trigger names a SHARED durable flag (readers must latch privately, never clear)", () => {
    const edges = SFX_EVENTS.filter((e) => e.trigger.startsWith("edge:"));
    expect(edges.map((e) => e.trigger).sort()).toEqual([
      "edge:finishBurst",
      "edge:lastStep",
      "edge:poseBurst",
    ]);
  });

  it("keeps every voice level sane (0 < level ≤ 1, relative to the SFX master)", () => {
    for (const e of SFX_EVENTS) {
      expect(e.level).toBeGreaterThan(0);
      expect(e.level).toBeLessThanOrEqual(1);
    }
  });

  it("footstrike stays the SUBTLEST voice (a tick, not a beat)", () => {
    const foot = sfxEvent("footstrike");
    for (const e of SFX_EVENTS) {
      if (e.id !== "footstrike") {
        expect(e.level).toBeGreaterThan(foot.level);
      }
    }
    // Even at full show energy the foot tap stays under the tick level.
    const maxFoot = SFX_VOICES.foot.baseGain + SFX_VOICES.foot.energySpan;
    expect(maxFoot).toBeLessThanOrEqual(foot.level);
  });

  it("only clock/phase-scheduled events are marked cancellable-scheduled", () => {
    for (const e of SFX_EVENTS) {
      expect(e.scheduled).toBe(!e.trigger.startsWith("edge:"));
    }
  });

  it("throws on an unknown event id (table is the single source)", () => {
    expect(() => sfxEvent("applause" as SfxEventId)).toThrow(/unknown sfx event/);
  });
});

describe("sfxLevel — the music engine's pref law, shared (#6)", () => {
  it("mute kills the layer entirely", () => {
    expect(sfxLevel({ enabled: false, volume: 1 })).toBe(0);
    expect(sfxLevel({ enabled: false, volume: 0.3 })).toBe(0);
  });

  it("volume scales the master linearly when enabled", () => {
    expect(sfxLevel({ enabled: true, volume: 1 })).toBeCloseTo(SFX_MASTER_LEVEL, 9);
    expect(sfxLevel({ enabled: true, volume: 0.5 })).toBeCloseTo(SFX_MASTER_LEVEL * 0.5, 9);
    expect(sfxLevel({ enabled: true, volume: 0 })).toBe(0);
  });

  it("the defaults give an audible-but-under-the-music bed", () => {
    const v = sfxLevel(DEFAULT_MUSIC);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(0.7); // music MASTER_LEVEL — sfx sits under the bed
  });
});

describe("revealVariant — graded score-reveal sting", () => {
  it("grades against the stamped run-mode pass bar", () => {
    expect(revealVariant(82, 82)).toBe("pass");
    expect(revealVariant(81.9, 82)).toBe("needswork");
    expect(revealVariant(76, 75)).toBe("pass");
  });

  it("falls back to the shared 75 bar for stamp-less legacy summaries", () => {
    expect(DEFAULT_PASS_THRESHOLD).toBe(75);
    expect(revealVariant(75, null)).toBe("pass");
    expect(revealVariant(74, undefined)).toBe("needswork");
  });

  it("PASS and NEEDS-WORK stings are melodically distinct (no shared notes)", () => {
    const pass = new Set<number>(SFX_VOICES.reveal.pass);
    for (const n of SFX_VOICES.reveal.needswork) {
      expect(pass.has(n)).toBe(false);
    }
    // pass ascends, needswork descends — the two must never read alike.
    const p = SFX_VOICES.reveal.pass;
    const w = SFX_VOICES.reveal.needswork;
    for (let i = 1; i < p.length; i++) expect(p[i]).toBeGreaterThan(p[i - 1]);
    for (let i = 1; i < w.length; i++) expect(w[i]).toBeLessThan(w[i - 1]);
  });

  it("the reveal waits its own beat after the finale hit", () => {
    expect(REVEAL_DELAY_SEC).toBeGreaterThan(0.3);
    expect(REVEAL_DELAY_SEC).toBeLessThan(2);
  });
});
