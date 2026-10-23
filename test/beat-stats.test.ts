import { describe, expect, it } from "vitest";

import {
  advancePulseTick,
  BEAT_CADENCE_MIN_INTERVALS,
  BEAT_DRIFT_MIN_SPM,
  BEAT_EARCON_HZ,
  BEAT_FLAM_SUPPRESS_SEC,
  BEAT_GO_FRESH_AFTER_SEC,
  BEAT_GO_STALE_BEFORE_SEC,
  BEAT_GRID_SPM_MAX,
  BEAT_GRID_SPM_MIN,
  BEAT_LOCK_FAULT_R,
  BEAT_LOCK_GOOD_R,
  BEAT_MIN_STRIKES,
  BEAT_PULSE_LEAD_SEC,
  BEAT_RAYLEIGH_DIRECTION_MIN,
  BEAT_STRIKE_DEBOUNCE_SEC,
  BEAT_SUBDIV_DEADZONE_SPM,
  BeatAccumulator,
  beatCue,
  beatGridCandidates,
  beatScoreOf,
  beatStatLine,
  BEAT_EXPLAIN,
  BEAT_SETTING_TIP,
  chooseSubdivision,
  countdownFlamSuppressed,
  firstPulseTick,
  goAudioTimeFresh,
  wrapPhaseBeats,
} from "../src/beat-stats.ts";
import { MUSIC_BPM_OPTIONS } from "../src/music-prefs.ts";
import { SCORE_MAX, SCORE_MIN } from "../src/pose-derive.ts";
import { COUNTDOWN_SEC } from "../src/show-timing.ts";
import { STEP_DEBOUNCE_SEC } from "../src/walk-stats.ts";
import {
  clusterTimes,
  feedBeatOps,
  FIXTURE_BPM,
  lockedTimes,
  makeBeat,
  PERIOD_1X,
  PERIOD_2X,
  runBeatOps,
  runStrikes,
  strikeOps,
  uniformTimes,
  type BeatOp,
} from "./beat-helpers.ts";

const ASCII = /^[\x20-\x7E]+$/;

// ---------------------------------------------------------------------------
// Constants — the derivations' arithmetic, pinned.
// ---------------------------------------------------------------------------

describe("beat grid candidates (per deliverable tempo)", () => {
  it("the plausible-cadence window", () => {
    expect(BEAT_GRID_SPM_MIN).toBe(45);
    expect(BEAT_GRID_SPM_MAX).toBe(160);
  });

  it("every deliverable tempo (and the legacy fixture) yields a 2:1 pair inside the window", () => {
    for (const bpm of [...MUSIC_BPM_OPTIONS, FIXTURE_BPM]) {
      const g = beatGridCandidates(bpm);
      expect(g.fastSpm).toBeCloseTo(g.slowSpm * 2, 12); // the halved-angle law
      expect(g.fastSpm).toBeLessThanOrEqual(BEAT_GRID_SPM_MAX);
      expect(g.slowSpm).toBeGreaterThanOrEqual(BEAT_GRID_SPM_MIN);
    }
  });

  it("62 BPM (half-time): the walker's grids are the half-beat and the beat", () => {
    // The founder's option semantics: music at half the emerging step rate —
    // a trainee striding ~124 spm is ON the half-beat, not off the grid.
    const g = beatGridCandidates(62);
    expect(g).toEqual({
      fastSpm: 124,
      fastSub: "half-beat",
      slowSpm: 62,
      slowSub: "beat",
      boundarySpm: 62 * Math.SQRT2,
    });
  });

  it("100 / 125 / legacy 122: beat over 2-beat", () => {
    expect(beatGridCandidates(100)).toMatchObject({
      fastSpm: 100,
      fastSub: "beat",
      slowSpm: 50,
      slowSub: "2-beat",
    });
    expect(beatGridCandidates(125)).toMatchObject({
      fastSpm: 125,
      slowSpm: 62.5,
    });
    expect(beatGridCandidates(FIXTURE_BPM)).toMatchObject({
      fastSpm: 122,
      fastSub: "beat",
      slowSpm: 61,
      slowSub: "2-beat",
    });
  });

  it("the boundary is the GEOMETRIC mean of the pair (ratio symmetry)", () => {
    for (const bpm of [...MUSIC_BPM_OPTIONS, FIXTURE_BPM]) {
      const g = beatGridCandidates(bpm);
      expect(g.boundarySpm).toBeCloseTo(Math.sqrt(g.fastSpm * g.slowSpm), 12);
      // Both grids off by the same factor at the boundary.
      expect(g.fastSpm / g.boundarySpm).toBeCloseTo(
        g.boundarySpm / g.slowSpm,
        12,
      );
    }
  });

  it("strike debounce is a pinned alias of the stats layer's own", () => {
    expect(BEAT_STRIKE_DEBOUNCE_SEC).toBe(STEP_DEBOUNCE_SEC);
  });

  it("direction gate is the ln(100) Rayleigh 1% line", () => {
    expect(BEAT_RAYLEIGH_DIRECTION_MIN).toBe(Math.log(100));
  });

  it("score map anchors and lowest-bar crossing", () => {
    expect(beatScoreOf(1)).toBe(SCORE_MAX);
    expect(beatScoreOf(0)).toBe(SCORE_MIN);
    // 40 + 60*fc (the perfect=100 rescale): the lowest bar (75) crossing
    // moved from fc = 35/58 to 35/60.
    expect(beatScoreOf(35 / 60)).toBeCloseTo(75, 10);
    // The copy bands' own arithmetic: 0.72 ~ the (old) challenge crossing,
    // 0.45 maps under every pass bar (40 + 60 * 0.45 = 67.0 < 75).
    expect(beatScoreOf(BEAT_LOCK_GOOD_R)).toBeCloseTo(40 + 60 * 0.72, 10);
    expect(beatScoreOf(BEAT_LOCK_FAULT_R)).toBeCloseTo(67.0, 10);
  });
});

// ---------------------------------------------------------------------------
// wrapPhaseBeats — the +-0.5 edge law.
// ---------------------------------------------------------------------------

describe("wrapPhaseBeats", () => {
  it("wraps to [-0.5, 0.5) with the +0.5 edge folding negative", () => {
    expect(Object.is(wrapPhaseBeats(0.5), -0.5)).toBe(true);
    expect(wrapPhaseBeats(-0.5)).toBe(-0.5);
    expect(wrapPhaseBeats(0)).toBe(0);
    expect(wrapPhaseBeats(0.25)).toBe(0.25);
    expect(wrapPhaseBeats(1.25)).toBe(0.25);
    expect(wrapPhaseBeats(-1.3)).toBeCloseTo(-0.3, 12);
    expect(wrapPhaseBeats(3.5)).toBe(-0.5);
  });

  it("stays in range over a sweep", () => {
    for (let i = -40; i <= 40; i++) {
      const w = wrapPhaseBeats(i * 0.173);
      expect(w).toBeGreaterThanOrEqual(-0.5);
      expect(w).toBeLessThan(0.5);
    }
  });
});

// ---------------------------------------------------------------------------
// goAudioTimeFresh — the clock-bridge validation half.
// ---------------------------------------------------------------------------

describe("goAudioTimeFresh", () => {
  const now = 100;

  it("accepts a go inside the window, edges INCLUSIVE", () => {
    expect(goAudioTimeFresh(now, now)).toBe(true);
    expect(goAudioTimeFresh(now, now - BEAT_GO_STALE_BEFORE_SEC)).toBe(true);
    expect(goAudioTimeFresh(now, now + BEAT_GO_FRESH_AFTER_SEC)).toBe(true);
  });

  it("rejects just past either edge", () => {
    expect(goAudioTimeFresh(now, now - BEAT_GO_STALE_BEFORE_SEC - 1e-9)).toBe(
      false,
    );
    expect(goAudioTimeFresh(now, now + BEAT_GO_FRESH_AFTER_SEC + 1e-9)).toBe(
      false,
    );
  });

  it("rejects a previous run's stale anchor and a future go", () => {
    expect(goAudioTimeFresh(now, now - 40)).toBe(false);
    expect(goAudioTimeFresh(now, now + 1)).toBe(false);
  });

  it("rejects junk (absent global, dead ctx, manual edits)", () => {
    expect(goAudioTimeFresh(now, undefined)).toBe(false);
    expect(goAudioTimeFresh(now, null)).toBe(false);
    expect(goAudioTimeFresh(now, Number.NaN)).toBe(false);
    expect(goAudioTimeFresh(now, Number.POSITIVE_INFINITY)).toBe(false);
    expect(goAudioTimeFresh(now, "99.9")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The subdivision chooser.
// ---------------------------------------------------------------------------

describe("chooseSubdivision (at the legacy fixture tempo)", () => {
  const B = beatGridCandidates(FIXTURE_BPM).boundarySpm; // 86.267...
  const FB = FIXTURE_BPM;

  it("clear cadences pick their own side", () => {
    expect(chooseSubdivision(61, null, FB)).toBe("2-beat");
    expect(chooseSubdivision(122, null, FB)).toBe("beat");
    expect(chooseSubdivision(90.4, null, FB)).toBe("beat"); // outside the zone
  });

  it("inside the dead zone the FIT cadence breaks the tie by ITS side", () => {
    expect(chooseSubdivision(85, 95, FB)).toBe("beat");
    expect(chooseSubdivision(85, 75, FB)).toBe("2-beat");
  });

  it("dead zone without a decisive FIT falls to the cadence's exact side", () => {
    expect(chooseSubdivision(85, null, FB)).toBe("2-beat");
    expect(chooseSubdivision(86.2, null, FB)).toBe("2-beat"); // just under B
    expect(chooseSubdivision(86.35, null, FB)).toBe("beat"); // just over B
    // FIT itself inside the zone is not decisive:
    expect(chooseSubdivision(85, 88, FB)).toBe("2-beat");
    expect(chooseSubdivision(B, null, FB)).toBe("beat"); // >= B = the fast side
  });

  it("cadence null: FIT decides at any value, else the slow-candidate fallback", () => {
    expect(chooseSubdivision(null, 95, FB)).toBe("beat");
    expect(chooseSubdivision(null, 70, FB)).toBe("2-beat");
    expect(chooseSubdivision(null, 85, FB)).toBe("2-beat"); // side(85) < B
    expect(chooseSubdivision(null, null, FB)).toBe("2-beat");
  });

  it("non-finite inputs read as null (law-6 gate)", () => {
    expect(chooseSubdivision(Number.NaN, null, FB)).toBe("2-beat");
    expect(chooseSubdivision(85, Number.NaN, FB)).toBe("2-beat");
    expect(chooseSubdivision(null, Number.POSITIVE_INFINITY, FB)).toBe(
      "2-beat",
    );
  });

  it("dead-zone width matches the constant", () => {
    expect(chooseSubdivision(B + BEAT_SUBDIV_DEADZONE_SPM + 0.01, 60, FB)).toBe(
      "beat", // just outside: cadence wins over FIT
    );
    expect(chooseSubdivision(B + BEAT_SUBDIV_DEADZONE_SPM - 0.01, 60, FB)).toBe(
      "2-beat", // just inside: FIT (decisive, low side) wins
    );
  });
});

describe("chooseSubdivision (per deliverable tempo)", () => {
  it("62 BPM: an emerging-cadence walker (~124 spm) is ON the half-beat", () => {
    expect(chooseSubdivision(124, null, 62)).toBe("half-beat");
    expect(chooseSubdivision(120, null, 62)).toBe("half-beat");
    // A true on-beat stroller (~62 spm) picks the beat grid.
    expect(chooseSubdivision(62, null, 62)).toBe("beat");
    // Both-null falls to the SLOW candidate — "beat" at 62 (the conservative
    // default is tempo-relative, not a hardcoded name).
    expect(chooseSubdivision(null, null, 62)).toBe("beat");
    // Boundary 87.68: dead zone + FIT tie-break still work.
    const B62 = beatGridCandidates(62).boundarySpm;
    expect(chooseSubdivision(B62 - 1, 124, 62)).toBe("half-beat"); // FIT decisive
    expect(chooseSubdivision(B62 - 5, null, 62)).toBe("beat"); // clear side
  });

  it("100 BPM: everyday walkers sit on the beat; slow stalkers on the 2-beat", () => {
    expect(chooseSubdivision(100, null, 100)).toBe("beat");
    expect(chooseSubdivision(96, null, 100)).toBe("beat");
    expect(chooseSubdivision(55, null, 100)).toBe("2-beat");
    expect(chooseSubdivision(null, null, 100)).toBe("2-beat");
  });

  it("125 BPM: runway cadence locks the beat grid; the 2-beat is 62.5", () => {
    expect(chooseSubdivision(125, null, 125)).toBe("beat");
    expect(chooseSubdivision(62, null, 125)).toBe("2-beat");
    expect(beatGridCandidates(125).slowSpm).toBe(62.5);
  });
});

// ---------------------------------------------------------------------------
// The estimator — bias correction pinned against in-test analytics
// (adjudication §H: analytic values computed here, never from prose).
// ---------------------------------------------------------------------------

describe("vector strength estimator", () => {
  it("uniform (chance) phases: corrected centers on 0, raw shows the sqrt(pi)/(2 sqrt(n)) bias", () => {
    for (const n0 of [12, 25, 100]) {
      const corrected: number[] = [];
      let rawScaledSum = 0;
      let count = 0;
      for (let seed = 0; seed < 60; seed++) {
        const { stats } = runStrikes(
          uniformTimes({ n: n0, periodSec: PERIOD_2X, seed: seed + 1 }),
        );
        if (stats === null) continue; // rare debounce loss below the floor
        corrected.push(stats.vectorR);
        // E[R_raw * sqrt(n)] = sqrt(pi)/2 under uniformity — n read off the
        // row (debounce may have dropped a strike or two).
        rawScaledSum += stats.vectorRRaw * Math.sqrt(stats.strikes);
        count++;
      }
      expect(count).toBeGreaterThan(50);
      corrected.sort((a, b) => a - b);
      // Median: P(n R^2 <= 1) ~ 1 - 1/e = 0.63 > 0.5, so the corrected
      // estimator's median at chance is 0 at ANY n.
      expect(corrected[Math.floor(corrected.length / 2)]).toBeLessThanOrEqual(
        0.1,
      );
      // Mean bound: E[vectorR | uniform] ~ e^-1 * (sqrt(pi)/2) / sqrt(n-1)
      // (nR^2 ~ Exp(1); integrate the over-1 tail). 2x slack for sampling.
      const analyticMean =
        (Math.exp(-1) * (Math.sqrt(Math.PI) / 2)) / Math.sqrt(n0 - 1);
      const mean = corrected.reduce((a, v) => a + v, 0) / corrected.length;
      expect(mean).toBeLessThan(2 * analyticMean);
      // Raw bias: mean of R_raw * sqrt(n) near sqrt(pi)/2 = 0.886.
      expect(Math.abs(rawScaledSum / count - Math.sqrt(Math.PI) / 2)).toBeLessThan(
        0.2,
      );
    }
  });

  it("concentrated phases: vectorR tracks the wrapped-normal rho", () => {
    for (const sigma of [0.05, 0.16, 0.25]) {
      const { stats } = runStrikes(
        lockedTimes({ n: 200, periodSec: PERIOD_2X, sigmaBeats: sigma, seed: 42 }),
      );
      expect(stats).not.toBeNull();
      // Population resultant of a wrapped normal with SD sigma (in cycles):
      const rho = Math.exp(-((2 * Math.PI * sigma) ** 2) / 2);
      expect(Math.abs((stats as { vectorR: number }).vectorR - rho)).toBeLessThan(
        0.05,
      );
      expect(stats?.subdivision).toBe("2-beat");
      expect(stats?.gridSpm).toBe(61);
      // The correction only ever shrinks: corrected <= raw.
      expect(stats!.vectorR).toBeLessThanOrEqual(stats!.vectorRRaw + 1e-12);
    }
  });

  it("the CORRECTED worked example: n=50, R_raw=0.8 -> 0.795 (not 0.797)", () => {
    // 40 strikes at phase 0 + 10 at the evenly spread phases (vector sum 0)
    // -> R_raw = 40/50 = 0.8 EXACTLY (the cluster builder's closed form).
    const { stats } = runStrikes(clusterTimes(40, 10, PERIOD_1X));
    expect(stats).not.toBeNull();
    expect(stats!.strikes).toBe(50);
    expect(stats!.vectorRRaw).toBeCloseTo(0.8, 6);
    // vectorR = sqrt((50 * 0.64 - 1) / 49) = sqrt(31/49) = 0.79539...
    expect(stats!.vectorR).toBeCloseTo(Math.sqrt(31 / 49), 3);
    expect(stats!.vectorR).toBe(0.795);
    expect(stats!.vectorR).not.toBe(0.797); // the spec prose's arithmetic slip
    expect(stats!.rayleighNR2).toBeCloseTo(32, 1); // 50 * 0.8^2
    // ~122 spm strikes score on the beat grid; the cluster sits at phase 0.
    expect(stats!.subdivision).toBe("beat");
    expect(stats!.gridSpm).toBe(122);
    expect(Math.abs(stats!.meanPhaseBeats)).toBeLessThanOrEqual(0.001);
  });

  it("constant timing offsets rotate the mean phase but never the lock", () => {
    const times = lockedTimes({
      n: 60,
      periodSec: PERIOD_2X,
      sigmaBeats: 0.12,
      seed: 7,
    });
    const a = runStrikes(times).stats;
    const b = runStrikes(times.map((t) => t + 0.19)).stats;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // The lock and the drift are offset-invariant (why vectorR is primary).
    expect(b!.vectorR).toBe(a!.vectorR);
    expect(b!.vectorRRaw).toBe(a!.vectorRRaw);
    expect(b!.driftSpm).toBe(a!.driftSpm);
    expect(b!.strikes).toBe(a!.strikes);
    // The DETECTOR phase moves by the offset (0.19 s in 2-beat periods).
    const shift = 0.19 / PERIOD_2X;
    expect(b!.meanPhaseBeats).not.toBe(a!.meanPhaseBeats);
    expect(
      Math.abs(wrapPhaseBeats(b!.meanPhaseBeats - a!.meanPhaseBeats - shift)),
    ).toBeLessThan(0.01);
  });

  it("perfect lock reads vectorR 1 -> score at the cap", () => {
    const times: number[] = [];
    for (let k = 1; k <= 30; k++) times.push(k * PERIOD_2X);
    const { stats } = runStrikes(times);
    expect(stats!.vectorR).toBe(1);
    expect(stats!.beatScore).toBe(100);
    expect(stats!.meanPhaseBeats).toBe(0);
    expect(stats!.cadenceSpm).toBeCloseTo(61, 1);
    expect(stats!.driftSpm).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Per-tempo scoring — heard = felt = scored at every deliverable tempo.
// ---------------------------------------------------------------------------

describe("per-tempo scoring (the multi-BPM founder call)", () => {
  it("62 BPM half-time: a locked emerging-cadence walker scores on the half-beat grid", () => {
    // The founder's own option semantics ("half time of the emerging level
    // speed"): the music beats at 62 while the trainee strides ~124 spm —
    // two steps per beat. Every OTHER step lands mid-beat, so on the old
    // single-tempo model this walker read as chance; on the half-beat
    // candidate they read locked.
    const halfBeat = 60 / 124;
    const times = lockedTimes({
      n: 30,
      periodSec: halfBeat,
      sigmaBeats: 0.04,
      seed: 21,
    });
    const { stats } = runStrikes(times, { bpm: 62 });
    expect(stats).not.toBeNull();
    expect(stats!.subdivision).toBe("half-beat");
    expect(stats!.gridSpm).toBe(124);
    expect(stats!.vectorR).toBeGreaterThan(0.9);
    expect(stats!.cadenceSpm).toBeCloseTo(124, 0);
  });

  it("100 BPM: an everyday walker locks the beat grid", () => {
    const beat = 60 / 100;
    const times = lockedTimes({
      n: 24,
      periodSec: beat,
      sigmaBeats: 0.04,
      seed: 22,
    });
    const { stats } = runStrikes(times, { bpm: 100 });
    expect(stats!.subdivision).toBe("beat");
    expect(stats!.gridSpm).toBe(100);
    expect(stats!.vectorR).toBeGreaterThan(0.9);
  });

  it("100 BPM: a LOCKED 50 spm walker never draws a false direction cue (the review's confirmed finding)", () => {
    // The 50 spm slow candidate's period is exactly STEP_MAX (1.2 s): a hard
    // interval ceiling truncated the long half of the distribution, biased
    // cadence ~+2.5 spm past the 2 spm direction floor, and coached "You ran
    // ahead of the beat" at a perfectly locked walker. The grid-aware
    // ceiling (intMaxSec, reset-latched) admits both tails. Multiple seeds —
    // the failure fired on 9 of 10 before the fix.
    for (const seed of [1, 2, 3, 4, 6, 7]) {
      const times = lockedTimes({
        n: 16, // ~a 20 s walk at 50 spm
        periodSec: 60 / 50,
        sigmaBeats: 0.04,
        seed,
      });
      const { stats, reason } = runStrikes(times, { bpm: 100 });
      expect(stats).not.toBeNull();
      expect(stats!.subdivision).toBe("2-beat");
      expect(stats!.gridSpm).toBe(50);
      expect(stats!.vectorR).toBeGreaterThan(0.9);
      expect(Math.abs(stats!.driftSpm ?? 99)).toBeLessThan(2);
      const cue = beatCue(stats, reason);
      expect(cue).toMatch(/^Locked to the beat/);
    }
  });

  it("the grid-aware interval ceiling stays STEP_MAX at 62/125/legacy 122 (legacy bytes intact)", () => {
    // Slow-candidate periods 0.968 / 0.96 / 0.984 s + 0.2 all sit under
    // STEP_MAX = 1.2, so the ceiling change is a 100-BPM-only widening —
    // pinned here by behavior: a 1.3 s interval is gated OUT at 122 but IN
    // at 100 (both give >= 4 intervals for a cadence read).
    const times: number[] = [];
    for (let k = 1; k <= 12; k++) times.push(k * 1.3);
    expect(runStrikes(times, { bpm: 122 }).stats!.cadenceSpm).toBeNull();
    const at100 = runStrikes(times, { bpm: 100 }).stats!;
    expect(at100.cadenceSpm).not.toBeNull();
    expect(at100.cadenceSpm).toBeCloseTo(60 / 1.3, 0);
  });

  it("125 BPM: a slow stroller lands the fractional 62.5 2-beat grid", () => {
    const twoBeat = 60 / 62.5;
    const times = lockedTimes({
      n: 15,
      periodSec: twoBeat,
      sigmaBeats: 0.03,
      seed: 23,
    });
    const { stats } = runStrikes(times, { bpm: 125 });
    expect(stats!.subdivision).toBe("2-beat");
    expect(stats!.gridSpm).toBe(62.5);
    expect(stats!.vectorR).toBeGreaterThan(0.9);
    // The fractional grid prints exactly (honest math, no rounding lie).
    expect(beatStatLine(stats, "no-clock")).toContain("GRID 62.5/MIN");
  });

  it("the SAME strike times score differently under different latched tempos", () => {
    // The tempo is a scored CONDITION: identical head-bob timing against a
    // different delivered grid is a different measurement — which is why the
    // walk row stamps musicBpm.
    const times = lockedTimes({
      n: 24,
      periodSec: 60 / 100,
      sigmaBeats: 0.03,
      seed: 24,
    });
    const at100 = runStrikes(times, { bpm: 100 }).stats;
    const at125 = runStrikes(times, { bpm: 125 }).stats;
    expect(at100!.vectorR).toBeGreaterThan(0.9); // on their grid
    expect(at125!.vectorR).toBeLessThan(at100!.vectorR); // off the 125 grids
  });
});

// ---------------------------------------------------------------------------
// THE CLOCK BRIDGE — co-sampling vs the naive conversion counterfactual.
// ---------------------------------------------------------------------------

describe("clock bridge (co-sampling)", () => {
  it("a 1% ECS-vs-audio skew is invisible to co-sampled stamps and fatal to converted ones", () => {
    // A perfectly on-grid walker for 60 s: true strike instants on the
    // AUDIO clock at every fixture-tempo beat.
    const audioTimes: number[] = [];
    for (let k = 1; k <= 122; k++) audioTimes.push(k * PERIOD_1X);

    // CO-SAMPLE (the shipped design): the wiring stamps audioNow - go in
    // the detection frame — the audio instants themselves.
    const co = runStrikes(audioTimes).stats;
    expect(co).not.toBeNull();
    expect(co!.gridSpm).toBe(122);
    expect(co!.vectorR).toBeGreaterThan(0.95);

    // COUNTERFACTUAL (computed here, never shipped): stamp go + walkTime
    // with the ECS walk clock running 1% fast — 0.6 s of accumulated skew
    // sweeps ~1.2 beats of phantom phase across the walk.
    const naive = runStrikes(audioTimes.map((t) => t * 1.01)).stats;
    expect(naive).not.toBeNull();
    expect(naive!.gridSpm).toBe(122); // cadence 120.8 still picks the beat grid
    expect(naive!.vectorR).toBeLessThan(0.75);
  });
});

// ---------------------------------------------------------------------------
// Wiring-feed tapes (the Wave 1 wiring-vs-tape law).
// ---------------------------------------------------------------------------

describe("wiring-feed tapes", () => {
  const locked = (n: number, opts: { offsetSec?: number; seed?: number } = {}) =>
    lockedTimes({
      n,
      periodSec: PERIOD_2X,
      sigmaBeats: 0.03,
      seed: opts.seed ?? 11,
      offsetSec: opts.offsetSec ?? 0,
    });

  it("a crossing re-fire inside the debounce window never double-counts", () => {
    const times = locked(12);
    const ops: BeatOp[] = [];
    for (const t of times) {
      ops.push({ op: "frame", dt: PERIOD_2X, strikeAt: t });
      // The cached-camera-frame re-fire: the SAME stamp delivered again.
      ops.push({ op: "frame", dt: PERIOD_2X, strikeAt: t });
      // And a near-dupe inside the debounce window.
      ops.push({
        op: "frame",
        dt: PERIOD_2X,
        strikeAt: t + BEAT_STRIKE_DEBOUNCE_SEC / 2,
      });
    }
    const { stats } = runBeatOps(ops);
    expect(stats).not.toBeNull();
    expect(stats!.strikes).toBe(12);
  });

  it("source handoff voids the pre-span: only the surviving span scores", () => {
    const preSpan = 30 * PERIOD_2X;
    const pre = uniformTimes({ n: 30, periodSec: PERIOD_2X, seed: 3 });
    const post = locked(15, { offsetSec: preSpan, seed: 4 });
    const ops: BeatOp[] = [
      ...strikeOps(pre, { source: "head" }),
      { op: "void" },
      ...strikeOps(post, { source: "camera-world" }, pre[pre.length - 1]),
    ];
    const { stats } = runBeatOps(ops);
    expect(stats).not.toBeNull();
    expect(stats!.strikes).toBe(15);
    expect(stats!.strikeSource).toBe("camera-world");
    // The chance pre-span is gone: the surviving locked span reads locked.
    expect(stats!.vectorR).toBeGreaterThan(0.85);
    // refSec SURVIVES the void — delivery disclosure is walk-wide.
    expect(stats!.refSec).toBeGreaterThan(preSpan);
  });

  it("a handoff leaving fewer than the floor reads too-few-strikes", () => {
    const pre = locked(20, { seed: 5 });
    const post = locked(BEAT_MIN_STRIKES - 2, {
      offsetSec: 20 * PERIOD_2X,
      seed: 6,
    });
    const { stats, reason } = runBeatOps([
      ...strikeOps(pre),
      { op: "void" },
      ...strikeOps(post, {}, pre[pre.length - 1]),
    ]);
    expect(stats).toBeNull();
    expect(reason).toBe("too-few-strikes");
  });

  it("music muted mid-walk TRUNCATES and resumes on the SAME grid", () => {
    const times = lockedTimes({
      n: 36,
      periodSec: PERIOD_2X,
      sigmaBeats: 0.05,
      seed: 5,
    });
    const gated: BeatOp[] = [];
    let prev = 0;
    let mutedSec = 0;
    times.forEach((t, i) => {
      const muted = i >= 12 && i < 24; // the middle third
      if (muted) mutedSec += t - prev;
      gated.push({ op: "frame", dt: t - prev, strikeAt: t, musicOn: !muted });
      prev = t;
    });
    const g = runBeatOps(gated).stats;
    const full = runStrikes(times).stats;
    expect(g).not.toBeNull();
    // The muted third's strikes are truncated out...
    expect(g!.strikes).toBe(24);
    // ...but counting resumed on the SAME absolute grid: the lock survives
    // (phase continuity — a re-anchored grid would smear it).
    expect(g!.vectorR).toBeGreaterThan(0.9);
    expect(Math.abs(g!.vectorR - full!.vectorR)).toBeLessThan(0.05);
    expect(Math.abs(g!.meanPhaseBeats - full!.meanPhaseBeats)).toBeLessThan(
      0.03,
    );
    // Truncation disclosed: refSec is the walk minus the mute span.
    const total = times[times.length - 1];
    expect(g!.refSec).toBeCloseTo(total - mutedSec, 0);
    expect(g!.refSec).toBeLessThan(full!.refSec);
  });

  it("haptic-only delivery scores (the quiet-room case)", () => {
    const { stats } = runStrikes(locked(14), {
      over: { musicOn: false, hapticKind: "haptic" },
    });
    expect(stats).not.toBeNull();
    expect(stats!.reference).toBe("haptic");
    expect(stats!.strikes).toBe(14);
  });

  it("reference label unions in fixed order regardless of chronology", () => {
    const times = locked(20);
    // Earcon strikes FIRST, music-only later -> still "music+earcon".
    const ops: BeatOp[] = times.map((t, i) =>
      i < 10
        ? {
            op: "frame",
            dt: PERIOD_2X,
            strikeAt: t,
            musicOn: false,
            hapticKind: "earcon",
          }
        : { op: "frame", dt: PERIOD_2X, strikeAt: t, musicOn: true },
    );
    expect(runBeatOps(ops).stats!.reference).toBe("music+earcon");

    const opsHaptic: BeatOp[] = times.map((t) => ({
      op: "frame",
      dt: PERIOD_2X,
      strikeAt: t,
      musicOn: true,
      hapticKind: "haptic",
    }));
    expect(runBeatOps(opsHaptic).stats!.reference).toBe("music+haptic");

    const all: BeatOp[] = times.map((t, i) => ({
      op: "frame",
      dt: PERIOD_2X,
      strikeAt: t,
      musicOn: i % 2 === 0,
      hapticKind: i < 10 ? "haptic" : "earcon",
    }));
    expect(runBeatOps(all).stats!.reference).toBe("music+haptic+earcon");
  });

  it("a suspended ctx span withholds its strikes (frozen-clock frames never stamp)", () => {
    const times = locked(24);
    const ops: BeatOp[] = times.map((t, i) => ({
      op: "frame",
      dt: PERIOD_2X,
      strikeAt: t,
      ctxRunning: !(i >= 8 && i < 16),
    }));
    const { stats } = runBeatOps(ops);
    expect(stats).not.toBeNull();
    expect(stats!.strikes).toBe(16);
  });

  it("dark frames contribute nothing (law-6 gates)", () => {
    const acc = new BeatAccumulator();
    acc.reset(true, FIXTURE_BPM, null);
    // NaN stamp: no count, no anchor poisoning.
    acc.addStrike(Number.NaN, true, null, "head");
    // NaN / non-positive dt: refSec unmoved.
    acc.addRefTime(Number.NaN, true);
    acc.addRefTime(-0.5, true);
    acc.addRefTime(0, true);
    // With nothing measured and nothing delivered, the honest reason is
    // no-reference — which pins that the junk above never accrued refSec.
    expect(acc.finalize()).toBeNull();
    expect(acc.nullReason()).toBe("no-reference");
    // A clean feed after the junk counts in full (the NaN never anchored).
    feedBeatOps(acc, strikeOps(locked(12)));
    expect(acc.finalize()!.strikes).toBe(12);
  });

  it("a mid-walk remap is a no-op (contrast: the lateral channel resets)", () => {
    const times = locked(16);
    const plain = runBeatOps(strikeOps(times)).stats;
    const ops = strikeOps(times);
    ops.splice(8, 0, { op: "remap" });
    const remapped = runBeatOps(ops).stats;
    expect(remapped).toEqual(plain);
  });

  it("WALK END (adjudication D): the director finalizes BEFORE the finishing frame's strike", () => {
    // ShowDirector runs at priority 0, MetricsSystem at 12: finishWalk stamps
    // the summary before the finishing frame's choke point delivers its
    // strike — so the final strike (and its addRefTime slice) is NOT in the
    // stamped row. <= 1 strike lost, matching walk-stats behavior.
    const times = locked(12, { seed: 9 });
    const ops = strikeOps(times);
    const acc = new BeatAccumulator();
    acc.reset(true, FIXTURE_BPM, null);
    feedBeatOps(acc, ops.slice(0, -1));
    const director = acc.finalize(); // what the summary stamps
    expect(director).not.toBeNull();
    expect(director!.strikes).toBe(11);

    // The finishing frame lands AFTER the stamp (finalize is
    // non-destructive and re-callable — the same accumulator keeps state).
    feedBeatOps(acc, ops.slice(-1));
    const after = acc.finalize();
    expect(after!.strikes).toBe(12);
    // Exactly the one finishing-frame strike + its ref slice was excluded.
    expect(after!.strikes - director!.strikes).toBe(1);
    expect(director!.refSec).toBeLessThan(after!.refSec);
  });

  it("timeout/truncation needs no special case: finalize freezes what was measured", () => {
    const times = locked(11);
    const short = runBeatOps(strikeOps(times.slice(0, 10))).stats;
    expect(short).not.toBeNull();
    expect(short!.strikes).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Reference gate + null reasons.
// ---------------------------------------------------------------------------

describe("reference gate + null reasons", () => {
  it("no reference ever delivered -> no-reference", () => {
    const { stats, reason } = runStrikes(
      lockedTimes({ n: 20, periodSec: PERIOD_2X, seed: 2 }),
      { over: { musicOn: false, hapticKind: null } },
    );
    expect(stats).toBeNull();
    expect(reason).toBe("no-reference");
  });

  it("goValid false wins over everything -> no-clock", () => {
    const { stats, reason } = runStrikes(
      lockedTimes({ n: 20, periodSec: PERIOD_2X, seed: 2 }),
      { goValid: false },
    );
    expect(stats).toBeNull();
    expect(reason).toBe("no-clock");
  });

  it("a junk latched tempo invalidates the run like a dead clock (law-6)", () => {
    for (const bpm of [Number.NaN, 0, -100, Number.POSITIVE_INFINITY]) {
      const { stats, reason } = runStrikes(
        lockedTimes({ n: 20, periodSec: PERIOD_2X, seed: 2 }),
        { bpm },
      );
      expect(stats).toBeNull();
      expect(reason).toBe("no-clock");
    }
  });

  it("reference delivered but no strikes -> too-few-strikes", () => {
    const ops: BeatOp[] = [];
    for (let i = 0; i < 40; i++) ops.push({ op: "frame", musicOn: true });
    const { stats, reason } = runBeatOps(ops);
    expect(stats).toBeNull();
    expect(reason).toBe("too-few-strikes");
  });

  it("exactly the floor scores; one under reads too-few-strikes", () => {
    const at = runStrikes(
      lockedTimes({ n: BEAT_MIN_STRIKES, periodSec: PERIOD_2X, seed: 8 }),
    );
    expect(at.stats).not.toBeNull();
    expect(at.stats!.strikes).toBe(BEAT_MIN_STRIKES);
    const under = runStrikes(
      lockedTimes({ n: BEAT_MIN_STRIKES - 1, periodSec: PERIOD_2X, seed: 8 }),
    );
    expect(under.stats).toBeNull();
    expect(under.reason).toBe("too-few-strikes");
  });

  it("cadence under the interval floor reports null cadence/drift", () => {
    // 10 counted strikes but intervals gated OUT (> STEP_MAX = 1.2 s apart
    // on a 3-beat spacing 1.475 s): phase still folds, cadence cannot.
    const times: number[] = [];
    for (let k = 1; k <= 10; k++) times.push(k * 3 * PERIOD_1X);
    const { stats } = runStrikes(times);
    expect(stats).not.toBeNull();
    expect(stats!.cadenceSpm).toBeNull();
    expect(stats!.driftSpm).toBeNull();
    // Chooser both-null (no FIT) -> the 2-beat product default.
    expect(stats!.subdivision).toBe("2-beat");
  });

  it("the FIT seed steers the chooser only through the dead zone", () => {
    // A dead-zone walker (~86 spm: period 60/86 s), FIT on the fast side.
    const period = 60 / 86;
    const times: number[] = [];
    for (let k = 1; k <= 20; k++) times.push(k * period);
    const withFit = runStrikes(times, { fit: 100 }).stats;
    const noFit = runStrikes(times).stats;
    expect(withFit!.subdivision).toBe("beat");
    expect(noFit!.subdivision).toBe("2-beat"); // 86 < B = 86.267
    // Interval floor: under 4 gated intervals cadence is null.
    expect(BEAT_CADENCE_MIN_INTERVALS).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Accumulator lifecycle.
// ---------------------------------------------------------------------------

describe("accumulator lifecycle", () => {
  it("finalize is non-destructive and re-callable", () => {
    const { acc } = runStrikes(lockedTimes({ n: 15, periodSec: PERIOD_2X, seed: 3 }));
    const a = acc.finalize();
    const b = acc.finalize();
    expect(a).toEqual(b);
  });

  it("reset clears every walk field (a stale walk never leaks)", () => {
    const acc = new BeatAccumulator();
    acc.reset(true, FIXTURE_BPM, null);
    feedBeatOps(
      acc,
      strikeOps(uniformTimes({ n: 30, periodSec: PERIOD_2X, seed: 12 }), {
        source: "camera-image",
        hapticKind: "earcon",
        musicOn: false,
      }),
    );
    acc.reset(true, FIXTURE_BPM, null);
    const times: number[] = [];
    for (let k = 1; k <= 12; k++) times.push(k * PERIOD_2X);
    feedBeatOps(acc, strikeOps(times));
    const stats = acc.finalize();
    expect(stats!.strikes).toBe(12);
    expect(stats!.vectorR).toBe(1);
    expect(stats!.reference).toBe("music");
    expect(stats!.strikeSource).toBe("head");
    expect(stats!.refSec).toBeCloseTo(times[times.length - 1], 1);
  });

  it("reset sanitizes a non-finite FIT cadence to null", () => {
    const period = 60 / 86; // dead-zone cadence
    const times: number[] = [];
    for (let k = 1; k <= 20; k++) times.push(k * period);
    const { stats } = runStrikes(times, { fit: Number.NaN });
    expect(stats!.subdivision).toBe("2-beat"); // fell to side(cadence)
  });
});

// ---------------------------------------------------------------------------
// Pulse-train arithmetic (pure — the next-phase BeatHapticsSystem wires it).
// ---------------------------------------------------------------------------

describe("pulse-train arithmetic", () => {
  const go = 200;
  const TEMPOS = [...MUSIC_BPM_OPTIONS, FIXTURE_BPM];

  it("firstPulseTick from the countdown edge covers the pre-GO beats, GO inclusive", () => {
    for (const bpm of TEMPOS) {
      const beat = 60 / bpm;
      const now = go - COUNTDOWN_SEC; // the countdown edge
      let t = firstPulseTick(now, go, beat);
      // On the go-anchored grid, at-or-after now + lead:
      expect((t - go) / beat).toBeCloseTo(Math.round((t - go) / beat), 9);
      expect(t).toBeGreaterThanOrEqual(now + BEAT_PULSE_LEAD_SEC);
      expect(t - (now + BEAT_PULSE_LEAD_SEC)).toBeLessThan(beat);
      // The 3 s countdown covers a tempo-dependent run of pre-GO beats —
      // walk the train forward to GO exactly (the k = 0 tick).
      const k = Math.round((t - go) / beat);
      expect(k).toBeLessThan(0);
      for (let i = 0; i < -k; i++) t += beat;
      expect(t).toBeCloseTo(go, 9);
    }
  });

  it("firstPulseTick mid-walk (the cached-anchor enable) lands on-grid ahead of now", () => {
    for (const bpm of TEMPOS) {
      const beat = 60 / bpm;
      const now = go + 10.3;
      const t = firstPulseTick(now, go, beat);
      expect(t).toBeGreaterThanOrEqual(now + BEAT_PULSE_LEAD_SEC);
      expect((t - go) / beat).toBeCloseTo(Math.round((t - go) / beat), 9);
      expect(t - (now + BEAT_PULSE_LEAD_SEC)).toBeLessThan(beat);
    }
  });

  it("advancePulseTick steps exactly one beat on the normal fire path", () => {
    for (const bpm of TEMPOS) {
      const beat = 60 / bpm;
      const nextT = go + 4 * beat;
      const now = nextT - BEAT_PULSE_LEAD_SEC + 0.001; // the fire frame
      expect(advancePulseTick(nextT, now, beat)).toBeCloseTo(nextT + beat, 12);
    }
  });

  it("advancePulseTick skips missed ticks WITHOUT burst-firing", () => {
    for (const bpm of TEMPOS) {
      const beat = 60 / bpm;
      const nextT = go;
      const now = go + 3 * beat + 0.1; // a GC hitch swallowed ~3 beats
      const t = advancePulseTick(nextT, now, beat);
      expect(t).toBeGreaterThan(now + BEAT_PULSE_LEAD_SEC);
      expect(t - (now + BEAT_PULSE_LEAD_SEC)).toBeLessThanOrEqual(beat);
      expect((t - go) / beat).toBeCloseTo(Math.round((t - go) / beat), 9);
    }
  });

  it("countdown flam suppression: exactly three pulses at the fixture tempo, GO untouched", () => {
    const beat = PERIOD_1X;
    let suppressed = 0;
    for (let k = 0; k <= 6; k++) {
      if (countdownFlamSuppressed(go - k * beat, go)) suppressed++;
    }
    // The 122-BPM beat ticks nearest after go-3/go-2/go-1 land 49/33/16 ms
    // after their countdown ticks — inside the 60 ms flam window.
    expect(suppressed).toBe(3);
    expect(countdownFlamSuppressed(go - 6 * beat, go)).toBe(true); // 49 ms
    expect(countdownFlamSuppressed(go - 4 * beat, go)).toBe(true); // 33 ms
    expect(countdownFlamSuppressed(go - 2 * beat, go)).toBe(true); // 16 ms
    expect(countdownFlamSuppressed(go, go)).toBe(false); // GO stays on-grid
    expect(countdownFlamSuppressed(go - beat, go)).toBe(false);
    // A pulse BEFORE a tick is never suppressed (the window is one-sided).
    expect(countdownFlamSuppressed(go - 1 - 0.01, go)).toBe(false);
    expect(countdownFlamSuppressed(go - 1 + BEAT_FLAM_SUPPRESS_SEC, go)).toBe(
      false, // the window is half-open
    );
    // Junk suppresses nothing (delivery-side law-6 gate).
    expect(countdownFlamSuppressed(Number.NaN, go)).toBe(false);
  });

  it("earcon voice: the D6 tick's MAJOR SIXTH (adjudication H label fix)", () => {
    // B6 = 1975.53 Hz over D6 = 1174.66 Hz — nine semitones, the equal-
    // tempered major sixth 2^(9/12) = 1.6818 (just ratio 5/3).
    expect(BEAT_EARCON_HZ).toBe(1976);
    expect(BEAT_EARCON_HZ / 1174.66).toBeCloseTo(2 ** (9 / 12), 2);
  });
});

// ---------------------------------------------------------------------------
// Copy builders.
// ---------------------------------------------------------------------------

describe("beat copy", () => {
  it("beatStatLine: the non-null row and all three null reasons", () => {
    expect(beatStatLine(makeBeat(), "no-clock")).toBe(
      "BEAT LOCK 80% - GRID 61/MIN - 40 STRIKES",
    );
    expect(
      beatStatLine(makeBeat({ vectorR: 0.716, gridSpm: 122, strikes: 25 }), "no-clock", " · "),
    ).toBe("BEAT LOCK 72% · GRID 122/MIN · 25 STRIKES");
    expect(beatStatLine(null, "no-clock")).toBe(
      "BEAT: NO READ - THE BEAT CLOCK WAS NOT ARMED",
    );
    expect(beatStatLine(null, "no-reference")).toBe(
      "BEAT: NO READ - NO BEAT REFERENCE WAS DELIVERED",
    );
    expect(beatStatLine(null, "too-few-strikes")).toBe(
      "BEAT: NO READ - TOO FEW STRIKES WITH THE BEAT ON",
    );
  });

  it("beatCue null branches: coachable reasons speak, no-clock stays silent", () => {
    expect(beatCue(null, "no-reference")).toBe(
      "No beat reached you this walk - turn on music or the beat pulse and the lock is scored.",
    );
    expect(beatCue(null, "too-few-strikes")).toBe(
      "Too few steps landed while the beat was on - the lock was not scored.",
    );
    expect(beatCue(null, "no-clock")).toBeNull();
  });

  it("the direction-floor rule: BOTH gates required, on the row's stats", () => {
    // Qualified: fires (ahead).
    expect(
      beatCue(
        makeBeat({ rayleighNR2: 4.7, driftSpm: 2, cadenceSpm: 63, vectorR: 0.5 }),
        "no-clock",
      ),
    ).toBe(
      "You ran ahead of the beat - 63 steps a minute against the 61 grid. Sit back into the count.",
    );
    // Behind.
    expect(
      beatCue(
        makeBeat({
          rayleighNR2: 4.7,
          driftSpm: -2.5,
          cadenceSpm: 58.5,
          vectorR: 0.5,
        }),
        "no-clock",
      ),
    ).toBe(
      "You fell behind the beat - 59 steps a minute against the 61 grid. Push up to the count.",
    );
    // Rayleigh gate: 4.5 < ln(100) = 4.605 suppresses the claim.
    expect(
      beatCue(
        makeBeat({ rayleighNR2: 4.5, driftSpm: 3, cadenceSpm: 64, vectorR: 0.5 }),
        "no-clock",
      ),
    ).toBeNull();
    // Drift floor: 1.9 < 2 suppresses; 2.0 fires (checked above).
    expect(
      beatCue(
        makeBeat({ rayleighNR2: 30, driftSpm: 1.9, cadenceSpm: 62.9, vectorR: 0.5 }),
        "no-clock",
      ),
    ).toBeNull();
    expect(BEAT_DRIFT_MIN_SPM).toBe(2);
    // Null cadence/drift can never claim a direction.
    expect(
      beatCue(
        makeBeat({ rayleighNR2: 30, driftSpm: null, cadenceSpm: null, vectorR: 0.5 }),
        "no-clock",
      ),
    ).toBeNull();
  });

  it("precedence: direction > locked > wandered; between bands is silent", () => {
    // Direction beats "locked" even at a high R.
    expect(
      beatCue(
        makeBeat({ rayleighNR2: 40, driftSpm: 3, cadenceSpm: 64, vectorR: 0.8 }),
        "no-clock",
      ),
    ).toMatch(/^You ran ahead of the beat/);
    // Locked.
    expect(beatCue(makeBeat({ vectorR: 0.72 }), "no-clock")).toBe(
      "Locked to the beat - 72 percent phase-steady on the 61 a minute grid.",
    );
    // Between bands: no claim.
    expect(beatCue(makeBeat({ vectorR: 0.6 }), "no-clock")).toBeNull();
    expect(beatCue(makeBeat({ vectorR: 0.45 }), "no-clock")).toBeNull();
    // Wandered — delivery-NEUTRAL: the channel scores against music, the
    // haptic pulse, OR the earcon, so the cue must not name music (a
    // haptic-only walk with music muted lands here too).
    expect(beatCue(makeBeat({ vectorR: 0.44 }), "no-clock")).toBe(
      "Your strikes wandered off the beat - count the beat down the deck.",
    );
    // The same cue on a haptic-referenced walk (music muted) never says
    // "music" (the review's requested invariant).
    const haptic = beatCue(
      makeBeat({ vectorR: 0.44, reference: "haptic" }),
      "no-clock",
    );
    expect(haptic).toBe(
      "Your strikes wandered off the beat - count the beat down the deck.",
    );
    expect(haptic).not.toMatch(/music/i);
  });

  it("every user-facing string is ASCII (the panel sweep's local twin)", () => {
    const strings = [
      BEAT_EXPLAIN,
      BEAT_SETTING_TIP,
      beatStatLine(makeBeat(), "no-clock"),
      beatStatLine(null, "no-clock"),
      beatStatLine(null, "no-reference"),
      beatStatLine(null, "too-few-strikes"),
      beatCue(null, "no-reference"),
      beatCue(null, "too-few-strikes"),
      beatCue(makeBeat({ vectorR: 0.9 }), "no-clock"),
      beatCue(makeBeat({ vectorR: 0.2 }), "no-clock"),
      beatCue(
        makeBeat({ rayleighNR2: 40, driftSpm: 3, cadenceSpm: 64 }),
        "no-clock",
      ),
      beatCue(
        makeBeat({ rayleighNR2: 40, driftSpm: -3, cadenceSpm: 58 }),
        "no-clock",
      ),
    ];
    for (const s of strings) {
      if (s !== null) expect(s).toMatch(ASCII);
    }
    // The setting tip discloses the flam suppression (adjudication H).
    expect(BEAT_SETTING_TIP).toContain("60 ms");
  });
});
