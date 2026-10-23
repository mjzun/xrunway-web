import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// M9 WIRING PINS. The engine files (metrics.ts / show.ts / index.ts /
// beat-haptics.ts) import @iwsdk/core and are not vitest-loadable, so the
// load-bearing wiring seams are pinned at the SOURCE TEXT — the
// POSE_HOLD_SEC / panel-ascii file-scan precedent (show-timing.test.ts).
// The BEHAVIOR behind each seam is pinned pure elsewhere: the accumulator's
// wiring-feed tapes in beat-stats.test.ts, the §E delivery decisions in
// beat-haptics-core.test.ts, the rider order in summary-riders.test.ts.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("metrics.ts M9 seams (spec §4.1-§4.3)", () => {
  const metrics = src("../src/metrics.ts");

  it("edge-latches the max of BOTH crossing stamps (head + camera share one choke point)", () => {
    expect(metrics).toContain(
      "Math.max(this.lastCrossTime, this.poseState.poseLastCross)",
    );
  });

  it("co-samples the audio clock in the detection frame (no cross-clock conversion)", () => {
    expect(metrics).toContain("actx.currentTime - this.m9Go");
  });

  it("voids the strike-phase state on the resetCadence seam, exactly once", () => {
    const hits = metrics.match(/this\.beat\.voidStrikes\(\);/g) ?? [];
    expect(hits).toHaveLength(1);
    // ...inside resetCadence (the camera<->head handoff seam), with the
    // latch re-arm beside it.
    const body = metrics.slice(metrics.indexOf("private resetCadence()"));
    const closeBrace = body.indexOf("\n  }");
    expect(body.slice(0, closeBrace)).toContain("this.beat.voidStrikes();");
    expect(body.slice(0, closeBrace)).toContain("this.m9PrevStamp = -1;");
  });

  it("discloses reference coverage every active frame (walk-wide refSec)", () => {
    expect(metrics).toContain(
      "this.beat.addRefTime(delta, musicOn || hk !== null);",
    );
  });

  it("validates the GO anchor once at walk start (running ctx + goAudioTimeFresh)", () => {
    expect(metrics).toContain("goAudioTimeFresh(actx.currentTime, go)");
    expect(metrics).toContain('actx.state === "running"');
  });
});

describe("show.ts M9 stamp (spec §4.4 — director-finalizes-first needs no extra code)", () => {
  const show = src("../src/show.ts");

  it("freezes finalize() + nullReason() from the globals.beatLock handle", () => {
    expect(show).toContain("this.globals.beatLock");
    expect(show).toContain("const beat: BeatStats | null = bt ? bt.finalize() : null;");
    expect(show).toContain("beat === null && bt ? bt.nullReason() : null");
  });
});

describe("index.ts M9 registration (spec §2.4)", () => {
  const index = src("../src/index.ts");

  it("seeds globals.beatPrefs from storage and persists on change (the musicPrefs pattern)", () => {
    expect(index).toContain("signal<BeatPrefs>(loadBeatPrefs())");
    expect(index).toContain(
      "beatPrefsSig.subscribe((p) => saveBeatPrefs(p))",
    );
  });

  it("registers BeatHapticsSystem after MusicSystem (goAudioTime arms first — the SfxSystem precedent)", () => {
    const music = index.indexOf("registerSystem(MusicSystem");
    const beat = index.indexOf("registerSystem(BeatHapticsSystem");
    expect(music).toBeGreaterThan(-1);
    expect(beat).toBeGreaterThan(music);
    expect(index).toContain(
      ".registerSystem(BeatHapticsSystem, { priority: 33 })",
    );
  });
});

describe("summary row order (adjudication §G: HOLD -> BEAT -> TURN, before the M12 line)", () => {
  it("XR panel markup: honest Quest-3 cut keeps HEAD CARRIAGE, drops HOLD/BEAT/TURN/CONSISTENCY", () => {
    const ui = src("../ui/lesson.uikitml");
    // The shipped in-world card shows only head-measured reads (founder call:
    // PACE / RHYTHM / LINE + HEAD CARRIAGE). The moment riders (hold/beat/turn)
    // and the M12 consistency line are cut from the panel — the scoring engine
    // still computes them, they just no longer surface on the shipped card.
    expect(ui).toContain('<span id="sum-carriage">');
    expect(ui.indexOf('<span id="sum-hold"')).toBe(-1);
    expect(ui.indexOf('<span id="sum-beat"')).toBe(-1);
    expect(ui.indexOf('<span id="sum-turn"')).toBe(-1);
    expect(ui.indexOf('<span id="sum-repeat"')).toBe(-1);
  });

  it("landing markup: #sum-hold < #sum-beat < #sum-turn < #repeat-line", () => {
    const html = src("../index.html");
    const hold = html.indexOf('<span id="sum-hold"');
    const beat = html.indexOf('<span id="sum-beat"');
    const turn = html.indexOf('<span id="sum-turn"');
    const repeat = html.indexOf('<span id="repeat-line"');
    expect(hold).toBeGreaterThan(-1);
    expect(beat).toBeGreaterThan(hold);
    expect(turn).toBeGreaterThan(beat);
    expect(repeat).toBeGreaterThan(turn);
  });

  // Founder ruling 2026-07-16: the coach voice is dropped ENTIRELY — no
  // control may exist on either surface (a hidden button still shipped a
  // default-on label to the headset once; assert ABSENCE, not order).
  it("XR settings: no coach-voice pill exists; set-beat still ships", () => {
    const ui = src("../ui/lesson.uikitml");
    expect(ui.includes('id="set-coach"')).toBe(false);
    expect(ui.toLowerCase().includes("coach voice:")).toBe(false);
    expect(ui.indexOf('id="set-beat"')).toBeGreaterThan(-1);
  });

  it("landing: no coach-voice button exists; the beat button still ships", () => {
    const html = src("../index.html");
    expect(html.includes('id="coach-btn"')).toBe(false);
    expect(html.includes("COACH VOICE:")).toBe(false);
    expect(html.indexOf('id="beat-btn"')).toBeGreaterThan(-1);
  });
});
