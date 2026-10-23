import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PACE,
  PACE_BAND_RING,
  cyclePaceBand,
  cyclePaceBias,
  paceBandLabel,
  paceBiasLabel,
  resolvePaceOpts,
  sanitizePacePrefs,
} from "../src/pace-prefs.ts";
import {
  DEFAULT_PACE_OPTS,
  PACE_BAND_MPS,
  PACE_K_FAST,
  PACE_K_SLOW,
  paceBandScore,
} from "../src/pose-derive.ts";

// The pace-style pref (founder ask 2026-07-18): flips WHICH side of the
// target the Part B band forgives ("take your time" - directors' orders),
// plus a deliberately quiet ADVANCED band-width control. No ruler fencing
// (single-tester call); the engine latches the resolved opts per run.

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("pace prefs", () => {
  it("defaults resolve to EXACTLY the Part B constants (golden safety)", () => {
    expect(resolvePaceOpts(DEFAULT_PACE)).toEqual(DEFAULT_PACE_OPTS);
    expect(DEFAULT_PACE.bandMps).toBe(PACE_BAND_MPS);
  });

  it("takeYourTime SWAPS the slopes: slow becomes the gentle side", () => {
    const opts = resolvePaceOpts({ bias: "takeYourTime", bandMps: 0.1 });
    expect(opts).toEqual({ band: 0.1, kSlow: PACE_K_FAST, kFast: PACE_K_SLOW });
    // walking 0.2 slow now costs what 0.2 fast used to, and vice versa
    const slow = paceBandScore(0.65, 0.85, opts);
    const fast = paceBandScore(1.05, 0.85, opts);
    expect(slow).toBe(paceBandScore(1.05, 0.85)); // default's fast cost
    expect(fast).toBe(paceBandScore(0.65, 0.85)); // default's slow cost
  });

  it("sanitize repairs junk and off-ring bands to the default", () => {
    expect(sanitizePacePrefs(null)).toEqual(DEFAULT_PACE);
    expect(sanitizePacePrefs({ bias: "fast", bandMps: 0.07 })).toEqual(DEFAULT_PACE);
    expect(sanitizePacePrefs({ bias: "takeYourTime", bandMps: 0.2 })).toEqual({
      bias: "takeYourTime",
      bandMps: 0.2,
    });
  });

  it("the band cycles through the bounded ring only", () => {
    let p = { ...DEFAULT_PACE };
    const seen: number[] = [];
    for (let i = 0; i < PACE_BAND_RING.length; i++) {
      p = cyclePaceBand(p);
      seen.push(p.bandMps);
    }
    expect(new Set(seen)).toEqual(new Set(PACE_BAND_RING));
    expect(p.bandMps).toBe(DEFAULT_PACE.bandMps); // full circle
  });

  it("the bias toggles both ways and labels stay ASCII (panel-font law)", () => {
    const t = cyclePaceBias(DEFAULT_PACE);
    expect(t.bias).toBe("takeYourTime");
    expect(cyclePaceBias(t).bias).toBe("confident");
    for (const s of [paceBiasLabel(DEFAULT_PACE), paceBiasLabel(t), paceBandLabel(t)]) {
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(s), s).toBe(true);
    }
    expect(paceBiasLabel(t)).toBe("Pace style: Take your time");
  });
});

describe("pace-prefs wiring (both surfaces + the engine latch)", () => {
  const uikitml = read("../ui/lesson.uikitml");
  const html = read("../index.html");
  const hud = read("../src/hud.ts");
  const landing = read("../src/landing.ts");
  const metrics = read("../src/metrics.ts");

  it("XR settings carry the style pill + the quiet ADVANCED band pill", () => {
    expect(uikitml).toContain('id="set-pace-style"');
    expect(uikitml).toContain('id="set-pace-band"');
    // the ADVANCED kicker is the DIM variant, never the accent voice
    expect(uikitml).toContain('class="set-kicker-dim">ADVANCED');
    // the band pill is ref-tier (the quiet class), not a glass action pill
    expect(uikitml).toMatch(/id="set-pace-band" class="pill pill-ref/);
  });

  it("the web twins exist, with the band buried in a dim disclosure", () => {
    expect(html).toContain('id="pace-style-btn"');
    expect(html).toContain('id="pace-band-btn"');
    expect(html).toMatch(/<details class="adv-fold">/);
    // the pointer-events law: a summary inside the landing overlay is dead
    // without its own auto (the .edu-fold lesson)
    expect(html).toMatch(/\.adv-fold > summary \{[^}]*pointer-events: auto/);
  });

  it("both surfaces write the SAME shared signal via the cycle helpers", () => {
    expect(hud).toContain('this.onClick("set-pace-style"');
    expect(hud).toContain('this.onClick("set-pace-band"');
    expect(hud).toContain("cyclePaceBias(this.paceSig.peek())");
    expect(hud).toContain("cyclePaceBand(this.paceSig.peek())");
    expect(landing).toContain('byId<HTMLButtonElement>("pace-style-btn")');
    expect(landing).toContain("cyclePaceBias(pacePrefsSig.peek())");
    expect(landing).toContain("cyclePaceBand(pacePrefsSig.peek())");
  });

  it("MetricsSystem LATCHES the resolved opts once per run (the tempo law)", () => {
    expect(metrics).toContain("this.paceOpts = pp ? resolvePaceOpts(pp) : DEFAULT_PACE_OPTS;");
    // both scoring paths consume the latched opts, never the raw pref
    expect(metrics).toContain("paceBandScore(this.speedEma, this.idealPace, this.paceOpts)");
    expect(metrics).toContain("this.paceOpts,\n    );\n  }");
  });
});
