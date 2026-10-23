import { describe, expect, it } from "vitest";

import { deriveHeadNormalization } from "../src/body-baseline.ts";
import {
  FIT_LINES,
  FIT_STILL_HOLD_SEC,
  FitCaptureMachine,
  FitWalkAccumulator,
  StillStandDetector,
  fitMinSteadySec,
  fitSteadyBand,
} from "../src/fit-session.ts";
import {
  bruteForceStd3D,
  feedDetector,
  feedWalk,
  mulberry32,
  noiseOf,
  pushHead,
  runStill,
  runWalk,
  spikeTape,
  stillTape,
  swayTape,
  walkTape,
  type HeadSample,
} from "./fit-helpers.ts";

const ASCII = /^[\x20-\x7E]+$/;

// ---------------------------------------------------------------------------
// Still-stand detector.
// ---------------------------------------------------------------------------

describe("StillStandDetector", () => {
  it("certifies a quiet stand after 5.0 s of hold (~6.0 s wall: 1 s window fill + 5 s hold)", () => {
    const det = new StillStandDetector();
    const doneAt = feedDetector(det, stillTape({ durationSec: 8 }));
    expect(doneAt).not.toBeNull();
    expect(doneAt as number).toBeGreaterThanOrEqual(5.9);
    expect(doneAt as number).toBeLessThanOrEqual(6.15);
    // The hold itself is exactly the 5.0 s law (one decimated sample slack).
    expect(det.holdSec).toBeGreaterThanOrEqual(FIT_STILL_HOLD_SEC - 1e-9);
  });

  it("result() reports the certified span's head-height mean/std and pitch mean", () => {
    const det = new StillStandDetector();
    feedDetector(
      det,
      stillTape({ heightM: 1.72, noiseStdM: 0.004, pitchRad: -0.06 }),
    );
    expect(det.done()).toBe(true);
    const r = det.result();
    // Standing HEAD height — the labeling law (§K): never body height.
    expect(r.standHeightM).toBeCloseTo(1.72, 2);
    expect(r.stillNoiseM).toBeGreaterThan(0.002);
    expect(r.stillNoiseM).toBeLessThan(0.007);
    expect(r.neutralPitchRad).toBeCloseTo(-0.06, 9);
  });

  it("windowed variance matches a brute-force recompute within 1e-9", () => {
    // Noisy enough that the gate never certifies — pure variance math check.
    for (const seed of [1, 2, 3]) {
      const det = new StillStandDetector();
      const tape = stillTape({ noiseStdM: 0.03, durationSec: 4, seed });
      feedDetector(det, tape);
      expect(det.windowFull).toBe(true);
      expect(Math.abs(det.windowStd3D() - bruteForceStd3D(tape))).toBeLessThan(
        1e-9,
      );
    }
  });

  it("decimation invariance: 72 Hz and 120 Hz feeds certify within one 30 Hz sample", () => {
    // The SAME continuous motion (deterministic, no RNG): 4 s of over-gate
    // sway, then QUIET still — certification hangs off the quiet edge. The
    // still phase carries a 0.5 mm deterministic micro-sway (std ~0.35 mm,
    // 34x under the 12 mm gate): a real tracked head is never bit-frozen,
    // and the frozen-pose guard now DROPS exact repeats as dark tracking.
    const motion = (t: number): HeadSample => ({
      dt: 0,
      x:
        t < 4
          ? 0.05 * Math.sin(2 * Math.PI * t)
          : 0.0005 * Math.sin(2 * Math.PI * t),
      y: 1.62,
      z: 0,
      pitch: -0.05,
    });
    const at = (hz: number): number | null => {
      const det = new StillStandDetector();
      const dt = 1 / hz;
      const n = Math.round(12 * hz);
      let doneAt: number | null = null;
      for (let i = 0; i < n; i++) {
        const s = motion(i * dt);
        det.push(dt, s.x, s.y, s.z, s.pitch);
        if (doneAt === null && det.done()) doneAt = (i + 1) * dt;
      }
      return doneAt;
    };
    const t72 = at(72);
    const t120 = at(120);
    expect(t72).not.toBeNull();
    expect(t120).not.toBeNull();
    expect(Math.abs((t72 as number) - (t120 as number))).toBeLessThanOrEqual(
      1 / 30 + 1 / 72 + 1e-9,
    );
  });

  it("a step spike zeroes the hold (re-certification starts over)", () => {
    // Control: the same tape without the spike certifies at ~6.0 s.
    const control = new StillStandDetector();
    const controlDone = feedDetector(
      control,
      stillTape({ durationSec: 12, seed: 11 }),
    );
    expect(controlDone as number).toBeLessThan(6.2);
    // Spiked at 3 s: the hold in progress is destroyed; certification only
    // lands after the post-spike window flush + a fresh full 5 s hold.
    const det = new StillStandDetector();
    const doneAt = feedDetector(
      det,
      spikeTape({ durationSec: 12, atSec: 3, seed: 11 }),
    );
    expect(doneAt).not.toBeNull();
    expect(doneAt as number).toBeGreaterThan(8.5);
  });

  it("a 3 cm sway never certifies (std 0.03/sqrt(2) = 0.021 >> the 0.012 gate)", () => {
    const det = new StillStandDetector();
    expect(feedDetector(det, swayTape(0.03, { durationSec: 15 }))).toBeNull();
    expect(det.holdSec).toBe(0);
  });

  it("non-finite samples are DROPPED: hold unchanged, sums untouched", () => {
    const clean = new StillStandDetector();
    const dirty = new StillStandDetector();
    const tape = stillTape({ durationSec: 8, seed: 5 });
    // Same tape, but the dirty detector also receives NaN frames mid-hold.
    let t = 0;
    for (const s of tape) {
      clean.push(s.dt, s.x, s.y, s.z, s.pitch);
      dirty.push(s.dt, s.x, s.y, s.z, s.pitch);
      t += s.dt;
      if (t > 2 && t < 2.1) {
        const before = dirty.holdSec;
        dirty.push(s.dt, s.x, Number.NaN, s.z, s.pitch);
        dirty.push(s.dt, Number.NaN, s.y, s.z, s.pitch);
        dirty.push(s.dt, s.x, s.y, s.z, Number.NaN);
        // Neither aborts NOR advances the clock (dropped, not zeroed).
        expect(dirty.holdSec).toBe(before);
      }
    }
    expect(dirty.done()).toBe(true);
    expect(dirty.result()).toEqual(clean.result()); // never reached the sums
  });

  it("junk dt is dropped; a gap re-seeds the window (the SOLO gap rule)", () => {
    const det = new StillStandDetector();
    feedDetector(det, stillTape({ durationSec: 3.5, seed: 9 }));
    const held = det.holdSec;
    expect(held).toBeGreaterThan(1);
    det.push(0, 0, 1.62, 0, 0);
    det.push(-1, 0, 1.62, 0, 0);
    det.push(Number.NaN, 0, 1.62, 0, 0);
    expect(det.holdSec).toBe(held); // dropped
    det.push(1.0, 0, 1.62, 0, 0); // 1 s outage: unobserved movement possible
    expect(det.holdSec).toBe(0);
    expect(det.windowFull).toBe(false);
  });

  it("FROZEN tracking never certifies: bit-identical repeats are dropped", () => {
    // The HoldAccumulator law mirrored: a tracked 6DoF head never emits two
    // bit-identical (x, y, z, pitch) tuples at 72-90 Hz, so a repeat is
    // frozen tracking — variance-of-literally-zero must not certify a stand
    // the sensor never measured (it would save a corrupted standHeightM /
    // neutralPitchRad under a fit.v1 stamp).
    const det = new StillStandDetector();
    for (let i = 0; i < 12 * 90; i++) {
      det.push(1 / 90, 0.2, 1.3, -0.5, -0.4); // e.g. frozen mid-crouch
    }
    expect(det.holdSec).toBe(0);
    expect(det.windowFull).toBe(false); // only the FIRST sample was evidence
    expect(det.done()).toBe(false);
  });

  it("frozen frames are dropped mid-hold; live frames after them resume", () => {
    const det = new StillStandDetector();
    const tape = stillTape({ durationSec: 3.5, seed: 13 });
    feedDetector(det, tape);
    const held = det.holdSec;
    expect(held).toBeGreaterThan(1);
    // The source freezes on the last accepted tuple for 2 s...
    const last = tape[tape.length - 1];
    for (let i = 0; i < 180; i++) {
      det.push(last.dt, last.x, last.y, last.z, last.pitch);
    }
    expect(det.holdSec).toBe(held); // dropped: no hold accrual, no clock
    // ...then resumes live (sub-gap dts, so no window re-seed) and the
    // hold keeps accruing from where the evidence left off.
    feedDetector(det, stillTape({ durationSec: 2, seed: 14 }));
    expect(det.holdSec).toBeGreaterThan(held);
  });

  it("reset() and the gap re-seed both re-arm the frozen guard", () => {
    const det = new StillStandDetector();
    det.push(1 / 90, 0.2, 1.62, -0.5, -0.05);
    det.push(1 / 90, 0.2, 1.62, -0.5, -0.05); // frozen: dropped
    det.reset();
    // After reset the SAME tuple is fresh evidence again.
    det.push(1 / 90, 0.2, 1.62, -0.5, -0.05);
    det.push(1.0, 0.2, 1.62, -0.5, -0.05); // gap: clearWindow + guard re-arm
    det.push(1 / 90, 0.2, 1.62, -0.5, -0.05); // accepted again post-gap
    // No direct counter is exposed pre-window-fill; the pin is that neither
    // push above threw and the decimation clock accepted the samples — a
    // stale guard would silently drop them. Feed a full noisy window to
    // prove the detector still works end-to-end.
    feedDetector(det, stillTape({ durationSec: 7, seed: 15 }));
    expect(det.done()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The §H steady band.
// ---------------------------------------------------------------------------

describe("fitSteadyBand (adjudication §H arithmetic)", () => {
  it("3 m legal-minimum deck: span 2.25 -> margin 0.27, floor 0.545 s", () => {
    const b = fitSteadyBand(2.25);
    expect(b.marginM).toBeCloseTo(0.27, 10);
    expect(b.loFrac).toBeCloseTo(0.12, 10);
    expect(b.hiFrac).toBeCloseTo(0.88, 10);
    // §H CORRECTED: the floor derives over the MEASURABLE span — the walk
    // stage completes at poseA - FIT_MARK_RADIUS_M (0.8 m), so the far cut
    // is max(margin, 0.8): usable = 2.25 - 0.27 - 0.8 = 1.18 m.
    expect(b.minSteadySec).toBeCloseTo((0.6 * 1.18) / 1.3, 10); // 0.5446
    // At a brisk 1.2 m/s the stage delivers ~1.18/1.2 = 0.98 s of band
    // samples -> PASSES with ~1.8x headroom (the original span-based floor
    // 1.04 s aborted every brisk walker on a legal-minimum deck).
    const usableM = 2.25 - b.marginM - Math.max(b.marginM, 0.8);
    expect(usableM).toBeCloseTo(1.18, 10);
    expect(usableM / 1.2).toBeGreaterThan(b.minSteadySec);
  });

  it("7 m default deck: span 6.25 -> margin 0.75, floor capped at 2.0 s", () => {
    const b = fitSteadyBand(6.25);
    expect(b.marginM).toBeCloseTo(0.75, 10);
    // usable = 6.25 - 0.75 - max(0.75, 0.8) = 4.70 -> 0.6*4.70/1.3 = 2.17,
    // capped at the 2.0 s statistical floor.
    expect(b.minSteadySec).toBe(2.0);
    expect(6.25 - 2 * b.marginM).toBeCloseTo(4.75, 10); // band, per §H
  });

  it("the margin cap engages on long decks (never trims more than 1.0 m)", () => {
    expect(fitSteadyBand(12).marginM).toBe(1.0);
    expect(fitMinSteadySec(12)).toBe(2.0);
  });
});

// ---------------------------------------------------------------------------
// Relaxed-walk capture.
// ---------------------------------------------------------------------------

function armedAcc(spanM: number): FitWalkAccumulator {
  const acc = new FitWalkAccumulator();
  const b = fitSteadyBand(spanM);
  acc.reset(b.loFrac, b.hiFrac, b.minSteadySec);
  return acc;
}

describe("FitWalkAccumulator", () => {
  it("bob round-trip: an A=0.010 sinusoid reads back within 5%, TH within 5% of 0.004", () => {
    const acc = armedAcc(6.25);
    feedWalk(acc, walkTape({ spanM: 6.25, bobAmpM: 0.01 }), 6.25);
    const m = acc.finalize();
    expect(m).not.toBeNull();
    expect(m!.bobAmpM).toBeGreaterThan(0.0095);
    expect(m!.bobAmpM).toBeLessThan(0.0105);
    // ...and through the 0.4 law the measured default body round-trips to
    // (within 5% of) the shipped default threshold.
    const n = deriveHeadNormalization(
      {
        version: 1,
        traineeId: "t1",
        capturedAt: 123,
        standHeightM: 1.6,
        stillNoiseM: 0.006,
        neutralPitchRad: 0,
        paceMps: m!.paceMps,
        cadenceSpm: m!.cadenceSpm,
        bobAmpM: m!.bobAmpM,
        source: "headset",
      },
      "t1",
    );
    expect(n.bobThresholdM).toBeGreaterThan(0.0038);
    expect(n.bobThresholdM).toBeLessThan(0.0042);
  });

  it("measures pace and cadence (one up-crossing per stride cycle)", () => {
    const acc = armedAcc(6.25);
    feedWalk(acc, walkTape({ spanM: 6.25, paceMps: 1.0, strideHz: 1.8 }), 6.25);
    const m = acc.finalize()!;
    expect(m.paceMps).toBeCloseTo(1.0, 2);
    expect(m.cadenceSpm).not.toBeNull();
    expect(m.cadenceSpm!).toBeGreaterThan(103);
    expect(m.cadenceSpm!).toBeLessThan(113); // 60 * 1.8 = 108
  });

  it("a mid-band pause is filtered out of the pace mean (speed < 0.3 floor)", () => {
    const acc = armedAcc(6.25);
    const tape = walkTape({ spanM: 6.25, paceMps: 1.0 });
    for (const s of tape) {
      acc.push(s.dt, s.x, s.y, s.z, s.along / 6.25);
      if (Math.abs(s.along - 3) < 0.006) {
        // Stand still for 2 s in the middle of the band.
        for (let i = 0; i < 180; i++) {
          acc.push(1 / 90, s.x, s.y, s.z, s.along / 6.25);
        }
      }
    }
    expect(acc.finalize()!.paceMps).toBeCloseTo(1.0, 2);
  });

  it("acceleration outside the band never pollutes the mean", () => {
    const acc = armedAcc(6.25);
    // Sprint through the 0.75 m entry margin at 3 m/s, then walk at 1.0.
    const dt = 1 / 90;
    let along = 0;
    let t = 0;
    while (along < 6.25) {
      const speed = along < 0.75 ? 3 : 1;
      along += speed * dt;
      t += dt;
      acc.push(dt, along, 1.6 + 0.01 * Math.sin(2 * Math.PI * 1.8 * t), 0, along / 6.25);
    }
    expect(acc.finalize()!.paceMps).toBeCloseTo(1.0, 1);
  });

  it("rejects a walk with too little steady time (atomic null)", () => {
    const acc = armedAcc(6.25); // floor 2.0 s
    const tape = walkTape({ spanM: 6.25, paceMps: 1.0 }).filter(
      (s) => s.along < 2.5, // exits the tape 1.75 s into the band
    );
    feedWalk(acc, tape, 6.25);
    expect(acc.finalize()).toBeNull();
  });

  it("rejects jogging pace and out-of-range bob amplitudes", () => {
    const jog = armedAcc(6.25);
    feedWalk(jog, walkTape({ spanM: 6.25, paceMps: 2.5 }), 6.25);
    expect(jog.finalize()).toBeNull(); // pace 2.5 > 2.0

    const glide = armedAcc(6.25);
    feedWalk(glide, walkTape({ spanM: 6.25, bobAmpM: 0.002 }), 6.25);
    expect(glide.finalize()).toBeNull(); // bob < 0.005 — noise-floor glide

    const bounce = armedAcc(6.25);
    feedWalk(bounce, walkTape({ spanM: 6.25, bobAmpM: 0.08 }), 6.25);
    expect(bounce.finalize()).toBeNull(); // bob > 0.05 — bounce artifact
  });

  it("short legal runway: pace reads, cadence honestly nulls (< 4 intervals)", () => {
    const acc = armedAcc(2.25);
    feedWalk(acc, walkTape({ spanM: 2.25, paceMps: 1.2 }), 2.25);
    const m = acc.finalize();
    expect(m).not.toBeNull(); // 1.42 s of band >= the 0.545 s §H floor
    expect(m!.paceMps).toBeCloseTo(1.2, 1);
    expect(m!.cadenceSpm).toBeNull(); // stored-only field stays honest
  });

  it("non-finite samples drop the anchor instead of spiking the pace", () => {
    const acc = armedAcc(6.25);
    const tape = walkTape({ spanM: 6.25, paceMps: 1.0 });
    let i = 0;
    for (const s of tape) {
      if (++i % 50 === 0) acc.push(s.dt, Number.NaN, s.y, s.z, s.along / 6.25);
      acc.push(s.dt, s.x, s.y, s.z, s.along / 6.25);
    }
    expect(acc.finalize()!.paceMps).toBeCloseTo(1.0, 2);
  });
});

// ---------------------------------------------------------------------------
// The flow machine.
// ---------------------------------------------------------------------------

const GEOM = { startA: 0.15, poseA: 6.4, traineeId: "t1", nowMs: 1_700_000_000_000 };

describe("FitCaptureMachine", () => {
  it("runs the happy path: mark -> stand -> walk -> saved, with a sanitized baseline", () => {
    const m = new FitCaptureMachine();
    expect(m.start({ ...GEOM })).toBe(true);
    expect(m.takeEdge()).toEqual({
      stage: "mark",
      line: FIT_LINES.mark,
      detail: null,
    });
    // Far from the mark: nothing happens.
    pushHead(m, 1 / 90, 5, 1.62, 0, 5.0, 0);
    expect(m.stage).toBe("mark");
    // On the mark (within 0.8 along / 0.6 lateral): stand begins.
    pushHead(m, 1 / 90, 0, 1.62, 0, 0.3, 0.2);
    expect(m.takeEdge()).toEqual({
      stage: "stand",
      line: FIT_LINES.stand,
      detail: null,
    });
    // Hold still until certified.
    const standEdges = runStill(m, 7, { y: 1.62, pitch: -0.06 });
    expect(standEdges.map((e) => e.stage)).toEqual(["walk"]);
    expect(standEdges[0].line).toBe(FIT_LINES.walk);
    // Walk the runway; the machine saves at the pose mark.
    const walkEdges = runWalk(m, GEOM.startA, 6.25, { paceMps: 1.0 });
    expect(m.stage).toBe("saved");
    expect(walkEdges[walkEdges.length - 1]).toEqual({
      stage: "saved",
      line: FIT_LINES.saved,
      detail: null,
    });
    const b = m.baseline!;
    expect(b.traineeId).toBe("t1");
    expect(b.capturedAt).toBe(GEOM.nowMs);
    expect(b.standHeightM).toBeCloseTo(1.62, 2);
    expect(b.neutralPitchRad).toBeCloseTo(-0.06, 3);
    expect(b.paceMps).toBeCloseTo(1.0, 1);
    expect(b.bobAmpM).toBeGreaterThan(0.008);
    expect(b.bobAmpM).toBeLessThan(0.012);
    expect(b.source).toBe("headset");
    // The saved capture derives a real fit stamp.
    expect(deriveHeadNormalization(b, "t1").stamp).toBe(
      `fit.v1-${GEOM.nowMs}`,
    );
  });

  it("edges never carry progress; the plain ref advances instead (§K)", () => {
    const m = new FitCaptureMachine();
    m.start({ ...GEOM });
    const edge = m.takeEdge()!;
    expect("progress" in edge).toBe(false);
    pushHead(m, 1 / 90, 0, 1.62, 0, 0.15, 0);
    m.takeEdge(); // stand edge
    expect(m.progress).toBe(0);
    runStill(m, 3, {});
    expect(m.progress).toBeGreaterThan(0.2); // hold fraction, live on the ref
    expect(m.progress).toBeLessThan(1);
  });

  it("re-prompts once at 12 s of failed stillness, aborts at 30 s", () => {
    const m = new FitCaptureMachine();
    m.start({ ...GEOM });
    pushHead(m, 1 / 90, 0, 1.62, 0, 0.15, 0);
    m.takeEdge(); // stand edge
    // Fidget: per-axis noise 0.02 -> 3D std ~0.035 >> the gate; never certifies.
    const edges = runStill(m, 31, { noiseStdM: 0.02 });
    expect(edges.map((e) => e.stage)).toEqual(["stand", "aborted"]);
    expect(edges[0].line).toBe(FIT_LINES.standReprompt);
    expect(edges[1]).toEqual({
      stage: "aborted",
      line: FIT_LINES.abortStandTimeout,
      detail: "stand-timeout",
    });
    expect(m.baseline).toBeNull(); // nothing persisted, ever
  });

  it("aborts when the trainee never reaches the mark (30 s)", () => {
    const m = new FitCaptureMachine();
    m.start({ ...GEOM });
    m.takeEdge();
    for (let i = 0; i < 31 * 90; i++) pushHead(m, 1 / 90, 5, 1.62, 0, 5.0, 0);
    expect(m.stage).toBe("aborted");
    expect(m.detail).toBe("mark-timeout");
    expect(m.takeEdge()!.line).toBe(FIT_LINES.abortInterrupted);
  });

  it("a dirty capture aborts as walk-not-clean (jogging pace)", () => {
    const m = new FitCaptureMachine();
    m.start({ ...GEOM });
    pushHead(m, 1 / 90, 0, 1.62, 0, 0.15, 0);
    runStill(m, 7, {});
    expect(m.stage).toBe("walk");
    runWalk(m, GEOM.startA, 6.25, { paceMps: 2.5 }); // jog: finalize -> null
    expect(m.stage).toBe("aborted");
    expect(m.detail).toBe("walk-not-clean");
    expect(m.baseline).toBeNull();
  });

  it("an out-of-range stand measurement aborts ATOMICALLY at save (no partial body)", () => {
    const m = new FitCaptureMachine();
    m.start({ ...GEOM });
    pushHead(m, 1 / 90, 0, 0.9, 0, 0.15, 0); // seated rig: head at 0.9 m
    runStill(m, 7, { y: 0.9 });
    expect(m.stage).toBe("walk"); // stillness itself certified fine
    runWalk(m, GEOM.startA, 6.25, { paceMps: 1.0, heightM: 0.9 });
    expect(m.stage).toBe("aborted"); // sanitize rejected height 0.9 < 1.0
    expect(m.detail).toBe("walk-not-clean");
    expect(m.baseline).toBeNull();
  });

  it("aborts a walk stage that never finishes (45 s timeout)", () => {
    const m = new FitCaptureMachine();
    m.start({ ...GEOM });
    pushHead(m, 1 / 90, 0, 1.62, 0, 0.15, 0);
    runStill(m, 7, {});
    expect(m.stage).toBe("walk");
    for (let i = 0; i < 46 * 90; i++) pushHead(m, 1 / 90, 0, 1.62, 0, 0.15, 0);
    expect(m.stage).toBe("aborted");
    expect(m.detail).toBe("walk-timeout");
    expect(m.takeEdge()!.line).toBe(FIT_LINES.abortWalkNotClean);
  });

  it("cancel() aborts mid-flow as an interruption; terminal stages ignore input", () => {
    const m = new FitCaptureMachine();
    m.start({ ...GEOM });
    pushHead(m, 1 / 90, 0, 1.62, 0, 0.15, 0);
    m.cancel();
    expect(m.stage).toBe("aborted");
    expect(m.detail).toBe("cancelled");
    expect(m.takeEdge()!.line).toBe(FIT_LINES.abortInterrupted);
    // Terminal: further frames change nothing, mint no edges.
    pushHead(m, 1 / 90, 0, 1.62, 0, 0.15, 0);
    expect(m.takeEdge()).toBeNull();
    m.cancel(); // no-op
    expect(m.takeEdge()).toBeNull();
    // reset() returns to inactive.
    m.reset();
    expect(m.stage).toBeNull();
    expect(m.detail).toBeNull();
  });

  it("start() refuses junk geometry / identity (stage stays null)", () => {
    const m = new FitCaptureMachine();
    expect(m.start({ ...GEOM, poseA: GEOM.startA })).toBe(false); // span 0
    expect(m.start({ ...GEOM, poseA: -1 })).toBe(false); // span < 0
    expect(m.start({ ...GEOM, startA: Number.NaN })).toBe(false);
    expect(m.start({ ...GEOM, traineeId: "" })).toBe(false);
    expect(m.start({ ...GEOM, nowMs: Number.NaN })).toBe(false);
    expect(m.stage).toBeNull();
    expect(m.takeEdge()).toBeNull();
  });

  it("non-finite head frames advance the abort clock but never the measurement", () => {
    const m = new FitCaptureMachine();
    m.start({ ...GEOM });
    pushHead(m, 1 / 90, 0, 1.62, 0, 0.15, 0);
    m.takeEdge();
    runStill(m, 3, {});
    const held = m.progress;
    m.push(1 / 90, Number.NaN, 1.62, 0, 0, 0, 0, 1, 0.15, 0);
    expect(m.progress).toBe(held); // dropped sample: hold untouched
    expect(m.stage).toBe("stand");
  });

  it("walk-stage dark frames are FORWARDED: the anchor-drop law runs in production", () => {
    // A mid-band tracking outage while the walker keeps moving: the machine
    // must forward the dark frames so FitWalkAccumulator drops its anchor —
    // pre-fix it silently skipped them, the anchor survived the outage, and
    // the resume frame differenced the whole unobserved meter into one
    // clamped 4 m/s sample (a ~+1% pace bias that lands in the SAVED
    // baseline). Post-fix the resume frame re-seeds with zero weight.
    const m = new FitCaptureMachine();
    m.start({ ...GEOM }); // span 6.25, walk ends at along 5.6 (poseA - 0.8)
    pushHead(m, 1 / 90, 0, 1.62, 0, 0.3, 0.1);
    runStill(m, 7, {});
    expect(m.stage).toBe("walk");
    const dt = 1 / 90;
    let t = 0;
    for (let along = 0; m.stage === "walk"; along += 1.0 * dt, t += dt) {
      if (along > 2.5 && along < 3.5) {
        // the outage: the walker travels a full unobserved meter
        m.push(dt, NaN, NaN, NaN, 0, 0, 0, 1, NaN, NaN);
      } else {
        pushHead(
          m,
          dt,
          along,
          1.6 + 0.01 * Math.sin(2 * Math.PI * 1.8 * t),
          0,
          GEOM.startA + along,
          0,
        );
      }
    }
    expect(m.stage).toBe("saved");
    // The resume frame carried ZERO pace weight: the saved pace is the true
    // 1.0 m/s, not 1.0 + (4 - 1) * dt / bandTime from the phantom sample.
    expect(m.baseline!.paceMps).toBeCloseTo(1.0, 2);
  });

  it("every guidance line is non-empty printable ASCII (the panel law)", () => {
    for (const [key, line] of Object.entries(FIT_LINES)) {
      expect(line, key).toMatch(ASCII);
    }
  });
});

// ---------------------------------------------------------------------------
// Helper self-checks (the golden emitter leans on these being right).
// ---------------------------------------------------------------------------

describe("fit-helpers determinism", () => {
  it("mulberry32 is deterministic and noiseOf hits its requested std", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 5; i++) expect(a()).toBe(b());
    const r = mulberry32(7);
    let sum = 0;
    let sum2 = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const v = noiseOf(r, 0.01);
      sum += v;
      sum2 += v * v;
    }
    const std = Math.sqrt(sum2 / N - (sum / N) * (sum / N));
    expect(std).toBeGreaterThan(0.009);
    expect(std).toBeLessThan(0.011);
  });
});
