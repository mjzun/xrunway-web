import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LATERAL_CUE_M, PACE_DELTA_CUE_MPS } from "../src/coach-live.js";
import { M8_GLANCE_PITCH_DEG } from "../src/head-carriage.js";
import {
  buildReplayTrack,
  REPLAY_MAX_MARKERS_PER_KIND,
  replayMarkers,
  trackPoseAt,
  type ReplayPose,
} from "../src/replay-core.js";
import type { MetricSample } from "../src/session-recorder.js";
import { SessionRecorder } from "../src/session-recorder.js";
import { DEFAULT_LAYOUT } from "../src/runway-layout.js";

// Replay Theater (display-only): the pure core + the wiring seams. The
// scoring-copy review's lesson applies — a dead pill ships green unless the
// markup AND the consumer wiring are both pinned, so every surface seam is
// file-scanned here.

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** A minimal in-band sample; override per test. */
function sample(over: Partial<MetricSample> & { t: number }): MetricSample {
  return {
    pace: 90,
    posture: 90,
    rhythm: 90,
    footPlacement: 90,
    presence: 90,
    confidence: 90,
    presentation: 90,
    paceMps: 0.85,
    lateralM: 0,
    headPitchDeg: 0,
    headYawDeg: 0,
    source: "head",
    alongM: over.t * 0.85,
    ...over,
  };
}

describe("replay-core: track building", () => {
  it("builds a track from along-bearing samples and reports the duration", () => {
    const track = buildReplayTrack([
      sample({ t: 0 }),
      sample({ t: 0.5 }),
      sample({ t: 1.0 }),
    ]);
    expect(track).not.toBeNull();
    expect(track!.points.length).toBe(3);
    expect(track!.duration).toBe(1.0);
  });

  it("is null when the along channel never recorded (camera walks, legacy rows)", () => {
    expect(
      buildReplayTrack([
        sample({ t: 0, alongM: null }),
        sample({ t: 0.5, alongM: null }),
      ]),
    ).toBeNull();
    // Legacy rows predate the field entirely.
    const legacy = sample({ t: 0 });
    delete (legacy as Partial<MetricSample>).alongM;
    expect(buildReplayTrack([legacy, legacy])).toBeNull();
    // One usable point is not a trajectory.
    expect(
      buildReplayTrack([sample({ t: 0 }), sample({ t: 0.5, alongM: null })]),
    ).toBeNull();
  });

  it("interpolates pose and flips the travel direction on the return leg", () => {
    const track = buildReplayTrack([
      sample({ t: 0, alongM: 0, lateralM: 0 }),
      sample({ t: 1, alongM: 1, lateralM: 0.2 }),
      sample({ t: 2, alongM: 0.4, lateralM: 0 }),
    ])!;
    const cursor = { i: 0 };
    const pose: ReplayPose = {
      along: 0,
      lateral: 0,
      pitchDeg: 0,
      speed: 0,
      dir: 1,
    };
    trackPoseAt(track, 0.5, cursor, pose);
    expect(pose.along).toBeCloseTo(0.5, 6);
    expect(pose.lateral).toBeCloseTo(0.1, 6);
    expect(pose.dir).toBe(1);
    trackPoseAt(track, 1.5, cursor, pose);
    expect(pose.along).toBeCloseTo(0.7, 6);
    expect(pose.dir).toBe(-1);
  });
});

describe("replay-core: coaching markers use the ENGINE thresholds", () => {
  it("marks lateral drift strictly beyond LATERAL_CUE_M (the live-coach gate)", () => {
    const at = LATERAL_CUE_M; // exactly at the gate — NOT a violation
    const past = LATERAL_CUE_M + 0.05;
    const markers = replayMarkers(
      [
        sample({ t: 10, lateralM: at }),
        sample({ t: 10.5, lateralM: past }),
        sample({ t: 11.0, lateralM: -past }),
        sample({ t: 11.5, lateralM: 0 }),
        sample({ t: 30, lateralM: 0 }), // long tape — clear of the final guard
      ],
      null,
    );
    const line = markers.filter((m) => m.kind === "line");
    // 10.5 and 11.0 are CONSECUTIVE violating samples → ONE clustered event,
    // anchored at the peak (both equal — the first peak wins).
    expect(line.length).toBe(1);
    expect(line[0].t).toBe(10.5);
  });

  it("honors the live coach's settle window for pace/line (never the head)", () => {
    const early = replayMarkers(
      [
        sample({ t: 1, lateralM: LATERAL_CUE_M + 0.3, paceMps: 3, headPitchDeg: -30 }),
      ],
      0.85,
    );
    // The standing start is never flagged for pace/line…
    expect(early.filter((m) => m.kind !== "head")).toEqual([]);
    // …but an M8 head drop counts from t=0 (its own semantics).
    expect(early.filter((m) => m.kind === "head").length).toBe(1);
  });

  it("marks pace strictly outside PACE_DELTA_CUE_MPS of the walk's own ideal", () => {
    const ideal = 0.85;
    const markers = replayMarkers(
      [
        sample({ t: 10, paceMps: ideal + PACE_DELTA_CUE_MPS }), // at the gate
        sample({ t: 10.5, paceMps: ideal + PACE_DELTA_CUE_MPS + 0.1 }),
        sample({ t: 11.0, paceMps: ideal }),
        sample({ t: 11.5, paceMps: ideal - PACE_DELTA_CUE_MPS - 0.2 }),
        sample({ t: 30, paceMps: ideal }), // long tape — clear of the final guard
      ],
      ideal,
    );
    const pace = markers.filter((m) => m.kind === "pace");
    expect(pace.length).toBe(2); // two separate events (in-band gap between)
    expect(pace[0].t).toBe(10.5);
    expect(pace[1].t).toBe(11.5);
    // No ideal → the kind is disabled entirely.
    expect(
      replayMarkers([sample({ t: 10, paceMps: 3 })], null).filter(
        (m) => m.kind === "pace",
      ),
    ).toEqual([]);
  });

  it("clears the pose/turn beat when the record measured a turn", () => {
    const turnStart = 12;
    const tape = [
      sample({ t: 8, lateralM: LATERAL_CUE_M + 0.2 }), // real drift, cueable
      sample({ t: 9, lateralM: 0 }),
      sample({ t: 11, lateralM: LATERAL_CUE_M + 0.4 }), // inside the hold band
      sample({ t: 13, lateralM: LATERAL_CUE_M + 0.4 }), // inside the turn clear
      sample({ t: 30, lateralM: 0 }),
    ];
    const withTurn = replayMarkers(tape, null, turnStart).filter(
      (m) => m.kind === "line",
    );
    expect(withTurn.map((m) => m.t)).toEqual([8]);
    // No turn stamp (tracking dark / U) — only settle + final guard apply.
    const noTurn = replayMarkers(tape, null, null).filter(
      (m) => m.kind === "line",
    );
    // 11 + 13 are consecutive violating samples → one clustered event.
    expect(noTurn.map((m) => m.t)).toEqual([8, 11]);
  });

  it("marks head drops at M8_GLANCE_PITCH_DEG (the M8 head-drop line)", () => {
    const markers = replayMarkers(
      [
        sample({ t: 0, headPitchDeg: M8_GLANCE_PITCH_DEG + 1 }), // above the line
        sample({ t: 0.5, headPitchDeg: M8_GLANCE_PITCH_DEG }), // at = a drop
        sample({ t: 1.0, headPitchDeg: 0 }),
      ],
      null,
    );
    const head = markers.filter((m) => m.kind === "head");
    expect(head.length).toBe(1);
    expect(head[0].t).toBe(0.5);
  });

  it("caps each kind at the most severe events and never marks unplaceable samples", () => {
    const rows: MetricSample[] = [];
    for (let i = 0; i < 12; i++) {
      // Alternate violation / clean so each violation is its own event;
      // severity grows with i, so the kept set is the LAST four.
      rows.push(
        sample({ t: i, lateralM: LATERAL_CUE_M + 0.01 + i * 0.01 }),
        sample({ t: i + 0.5, lateralM: 0 }),
      );
    }
    rows.push(sample({ t: 40, lateralM: 0 })); // clear of the final guard
    const line = replayMarkers(rows, null).filter((m) => m.kind === "line");
    expect(line.length).toBe(REPLAY_MAX_MARKERS_PER_KIND);
    // Time-ordered output, and every kept event is from the severe tail.
    expect(line.map((m) => m.t)).toEqual([8, 9, 10, 11]);
    // A violating value with no along/lateral position can't be placed on
    // the runway — never marks (the camera-image path).
    expect(
      replayMarkers(
        [sample({ t: 0, headPitchDeg: -40, alongM: null, lateralM: null })],
        null,
      ),
    ).toEqual([]);
  });
});

describe("replay data channel: recorder alongM (additive-optional)", () => {
  it("records alongM at mm resolution and nulls junk", () => {
    const rec = new SessionRecorder(() => 1000);
    rec.beginWalk(DEFAULT_LAYOUT, "head");
    const m = {
      pace: 90,
      posture: 90,
      rhythm: 90,
      footPlacement: 90,
      presence: 90,
      confidence: 90,
      presentation: 90,
    };
    rec.sample(m, "head", 0.85, 0.01, 0, 0, 1.23456);
    rec.sample(m, "head", 0.85, 0.01, 0, 0, Number.NaN);
    rec.sample(m, "head", 0.85, 0.01, 0, 0); // legacy caller — no arg
    const s = rec.latest();
    // beginWalk leaves current open; samples buffer on it.
    const cur = (rec as unknown as { current: { samples: MetricSample[] } })
      .current;
    expect(s).toBeNull();
    expect(cur.samples[0].alongM).toBe(1.235);
    expect(cur.samples[1].alongM).toBeNull();
    expect(cur.samples[2].alongM).toBeNull();
  });
});

describe("replay theater: the wiring seams (file-scan pins)", () => {
  const html = read("../index.html");
  const landing = read("../src/landing.ts");
  const hud = read("../src/hud.ts");
  const uikitml = read("../ui/lesson.uikitml");
  const metrics = read("../src/metrics.ts");
  const stage = read("../src/stage.ts");
  const indexTs = read("../src/index.ts");
  const recorder = read("../src/session-recorder.ts");

  it("web summary: the REPLAY control + legend exist and landing wires them", () => {
    expect(html).toContain('id="sum-replay"');
    expect(html).toContain('id="replay-legend"');
    // The honest-card CSS-specificity law: [hidden] paired with !important.
    expect(html).toMatch(/#sum-replay\[hidden\][\s\S]{0,160}display:\s*none\s*!important/);
    // The overlay steps aside while the ghost plays.
    expect(html).toMatch(/#landing\[data-replay="1"\]\s*\{\s*display:\s*none/);
    expect(landing).toContain('byId("sum-replay")');
    expect(landing).toContain("replayControls");
    expect(landing).toContain("replayActive");
    expect(landing).toContain('dataset.replay = "1"');
  });

  it("XR panel: the REPLAY pill exists and hud wires + gates it", () => {
    expect(uikitml).toContain('id="replay-button"');
    expect(hud).toContain('this.onClick("replay-button"');
    expect(hud).toContain("replayControls");
    // Availability gate lives in the summary render.
    expect(hud).toMatch(/setDisplay\(\s*this\.el\("replay-button"\)/);
  });

  it("the data channel is wired end-to-end (metrics -> walk-stats -> recorder)", () => {
    expect(metrics).toContain("liveAlongM = projFoot.globalAlong");
    // Camera frames dark the tap at the wiring (pose-derive is golden-locked).
    expect(metrics).toContain("this.stats.liveAlongM = null");
    expect(recorder).toContain("acc ? acc.liveAlongM : null");
  });

  it("the system is registered and the stage exports the front row", () => {
    expect(indexTs).toContain("registerSystem(ReplayTheaterSystem");
    expect(stage).toContain("audienceFrontRowLocal");
  });

  it("the replay PLAYER (founder 2026-07-23): transport wired on both ends", () => {
    const replay = read("../src/replay-theater.ts");
    // System side: pause/speed/seek/state + the pause-aware clocks.
    for (const s of [
      "pause: () =>",
      "resume: () =>",
      "setSpeed: (rate) =>",
      "seek: (frac) =>",
      "state: () =>",
      "private seekTo(",
      "this.armClock += delta;",
      "this.paused ? 0 : delta * this.speed",
    ]) {
      expect(replay).toContain(s);
    }
    // A paused tape never auto-exits; web keys are Escape-exit + Space-pause
    // (any-input-exits is XR-only now — the bar owns the pointer).
    // effDuration = the LONGER tape in a VS BEST comparison (ghost-vs-ghost).
    expect(replay).toContain("!this.paused && this.replayT > this.effDuration()");
    expect(replay).toContain("private effDuration()");
    // Ghost-vs-ghost seams: controls + the second tape + the legend export.
    expect(replay).toContain("compareAvailableFor: (id) =>");
    expect(replay).toContain("startCompareFor: (id) =>");
    expect(replay).toContain("private bestOther(");
    expect(replay).toContain("replay-ghost-compare");
    expect(replay).toContain("this.globals.replayCompare = null;");
    expect(replay).toContain('e.key === "Escape"');
    expect(replay).not.toContain("onPointerDown");
    // Bar markup + landing wiring.
    for (const id of ["rp-play", "rp-restart", "rp-speed", "rp-track", "rp-fill", "rp-time", "rp-exit"]) {
      expect(html).toContain(`id="${id}"`);
      expect(landing).toContain(`"${id}"`);
    }
    expect(html).toMatch(/#replay-bar\[hidden\][\s\S]{0,60}display: none !important/);
  });

  it("coached moments (finding 5): auto slow-mo + the engine's own cue copy", () => {
    const replay = read("../src/replay-theater.ts");
    const core = read("../src/replay-core.ts");
    // The cue table reuses METRIC_COACH verbatim for pace/line (never
    // re-worded engine copy); the head line is the F.36 draft.
    expect(core).toContain("pace: METRIC_COACH.pace");
    expect(core).toContain("line: METRIC_COACH.footPlacement");
    expect(core).toContain("REPLAY_COACH_LEAD_SEC");
    // The ramp engages only at user-speed 1, restores after the beat, and
    // an explicit setSpeed cancels it (the user always drives).
    expect(replay).toContain("this.speed === 1");
    expect(replay).toContain("REPLAY_COACH_HOLD_SEC");
    expect(replay).toMatch(/setSpeed: \(rate\) => \{[\s\S]{0,400}this\.coachMarker = null;/);
    // The web cue line exists + is painted from the plain ref.
    expect(html).toContain('id="replay-cue"');
    expect(landing).toContain("g.replayCue");
  });

  it("run history: honest-3 cards + per-walk live replay (founder 2026-07-22)", () => {
    const replay = read("../src/replay-theater.ts");
    // History replays start from idle for a SPECIFIC record; any phase
    // change away from the start phase exits.
    expect(replay).toContain("startFor: (id) => this.startReplay(id)");
    expect(replay).toContain('id !== undefined && phase === "idle"');
    expect(replay).toContain("p !== this.startPhase");
    // The cards gate on availability and close the panel into the replay.
    expect(landing).toContain("rc.availableFor(r.id)");
    expect(landing).toContain("rc.startFor(r.id)");
    // The history detail is the HONEST card: exactly the walk-card reads,
    // and the old 7-bar composite caption is gone.
    expect(landing).toContain("HONEST_MINI");
    expect(landing).not.toContain('"COMPOSITE"');
    expect(landing).not.toContain('["posture", "PO"]');
    expect(html).not.toContain("sp-mini-cap");
    // 3 columns, with a per-metric value readout.
    expect(html).toMatch(/\.sp-mini \{[\s\S]{0,200}repeat\(3, 1fr\)/);
    expect(html).toContain(".sp-mini-val");
  });
});
