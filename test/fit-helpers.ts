/**
 * (X)RUNWAY — SHARED FIT case builders: the single source of test-case truth
 * for BOTH the vitest suites (test/body-baseline.test.ts,
 * test/fit-session.test.ts) and the future "fit-core" golden-vector family
 * (scripts/gen-golden-vectors.mjs — registered in the Wave 1 VECTORS commit,
 * the pinned bootstrap order).
 *
 * NO vitest imports allowed in this file: it must load under plain `node`
 * (the case-helpers.ts law). Deterministic by construction — tape noise
 * comes from a seeded PRNG (mulberry32), never Math.random, so a golden
 * emitter and a test replay the SAME tape bit-for-bit.
 */

import type { BodyBaseline } from "../src/body-baseline.ts";
import {
  FIT_STILL_SAMPLE_HZ,
  FitCaptureMachine,
  FitWalkAccumulator,
  StillStandDetector,
} from "../src/fit-session.ts";

// ---------------------------------------------------------------------------
// Deterministic noise.
// ---------------------------------------------------------------------------

/** mulberry32 — tiny seeded PRNG; uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Zero-mean uniform noise of a given STANDARD DEVIATION: uniform on
 *  [-w/2, w/2] has std w/sqrt(12), so w = std * sqrt(12). */
export function noiseOf(rand: () => number, stdM: number): number {
  return (rand() - 0.5) * stdM * Math.sqrt(12);
}

// ---------------------------------------------------------------------------
// Baseline fixture.
// ---------------------------------------------------------------------------

/** A fully valid BodyBaseline; override the fields under test. Values are
 *  the documented default body (H 1.60, A 0.010 -> the byte-identity pins). */
export function baseline(over: Partial<BodyBaseline> = {}): BodyBaseline {
  return {
    version: 1,
    traineeId: "t1",
    capturedAt: 1_700_000_000_000,
    standHeightM: 1.6,
    stillNoiseM: 0.006,
    neutralPitchRad: -0.05,
    paceMps: 0.94,
    cadenceSpm: 104,
    bobAmpM: 0.01,
    source: "headset",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Head-sample tapes (the detector's input grid).
// ---------------------------------------------------------------------------

/** One raw head sample as the detector consumes it. */
export interface HeadSample {
  dt: number;
  x: number;
  y: number;
  z: number;
  pitch: number;
}

export interface StillTapeOpts {
  /** Input frame rate (Hz) BEFORE the detector's 30 Hz decimation. */
  hz?: number;
  durationSec?: number;
  /** Standing head height (m). */
  heightM?: number;
  /** Per-axis positional noise std (m). */
  noiseStdM?: number;
  pitchRad?: number;
  seed?: number;
}

/** A quiet standing tape: fixed position + seeded noise on all three axes. */
export function stillTape(opts: StillTapeOpts = {}): HeadSample[] {
  const {
    hz = 90,
    durationSec = 8,
    heightM = 1.62,
    noiseStdM = 0.004,
    pitchRad = -0.06,
    seed = 7,
  } = opts;
  const rand = mulberry32(seed);
  const dt = 1 / hz;
  const n = Math.round(durationSec * hz);
  const out: HeadSample[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      dt,
      x: 0.2 + noiseOf(rand, noiseStdM),
      y: heightM + noiseOf(rand, noiseStdM),
      z: -0.5 + noiseOf(rand, noiseStdM),
      pitch: pitchRad,
    });
  }
  return out;
}

/** A standing tape carrying a horizontal sinusoidal sway of amplitude
 *  `ampM` at `freqHz` on x (std = amp/sqrt(2) over full periods). */
export function swayTape(
  ampM: number,
  opts: StillTapeOpts & { freqHz?: number } = {},
): HeadSample[] {
  const { hz = 90, durationSec = 12, heightM = 1.62, freqHz = 1 } = opts;
  const dt = 1 / hz;
  const n = Math.round(durationSec * hz);
  const out: HeadSample[] = [];
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    out.push({
      dt,
      x: ampM * Math.sin(2 * Math.PI * freqHz * t),
      y: heightM,
      z: 0,
      pitch: 0,
    });
  }
  return out;
}

/** A still tape with one step-like ramp (`travelM` over `rampSec`) injected
 *  at `atSec` — the hold-zeroing fixture. */
export function spikeTape(
  opts: StillTapeOpts & { atSec?: number; travelM?: number; rampSec?: number } = {},
): HeadSample[] {
  const { atSec = 3, travelM = 0.3, rampSec = 0.3 } = opts;
  const tape = stillTape({ durationSec: 10, ...opts });
  let t = 0;
  for (const s of tape) {
    if (t >= atSec) {
      const k = Math.min(1, (t - atSec) / rampSec);
      s.x += travelM * k;
    }
    t += s.dt;
  }
  return tape;
}

/** Feed a tape; returns the wall-clock seconds at which done() first became
 *  true, or null if it never did. */
export function feedDetector(
  det: StillStandDetector,
  tape: ReadonlyArray<HeadSample>,
): number | null {
  let t = 0;
  let doneAt: number | null = null;
  for (const s of tape) {
    det.push(s.dt, s.x, s.y, s.z, s.pitch);
    t += s.dt;
    if (doneAt === null && det.done()) doneAt = t;
  }
  return doneAt;
}

/** Brute-force reference for the detector's windowed 3D std: recompute from
 *  the last `windowN` DECIMATED samples of an independently decimated tape.
 *  Mirrors the detector's own decimation (accumulate dt, emit each 1/30 s,
 *  bank at most one period) so the two see the same sample set. */
export function bruteForceStd3D(
  tape: ReadonlyArray<HeadSample>,
  windowN: number = FIT_STILL_SAMPLE_HZ,
): number {
  const period = 1 / FIT_STILL_SAMPLE_HZ;
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  let acc = 0;
  for (const s of tape) {
    if (!(s.dt > 0)) continue;
    acc += s.dt;
    if (acc < period) continue;
    acc -= period;
    if (acc > period) acc = period;
    xs.push(s.x);
    ys.push(s.y);
    zs.push(s.z);
  }
  if (xs.length < windowN) return Infinity;
  const varOf = (arr: number[]): number => {
    const w = arr.slice(arr.length - windowN);
    const mean = w.reduce((a, b) => a + b, 0) / windowN;
    return w.reduce((a, b) => a + (b - mean) * (b - mean), 0) / windowN;
  };
  return Math.sqrt(varOf(xs) + varOf(ys) + varOf(zs));
}

// ---------------------------------------------------------------------------
// Relaxed-walk tapes (the accumulator's / machine's input grid).
// ---------------------------------------------------------------------------

export interface WalkSample {
  dt: number;
  x: number;
  y: number;
  z: number;
  /** Global-along meters (projectRoute space) — the machine input; direct
   *  accumulator feeds divide by span themselves. */
  along: number;
}

export interface WalkTapeOpts {
  hz?: number;
  /** Walk span (m) — the tape travels startA=0 .. along=spanM. */
  spanM?: number;
  paceMps?: number;
  /** Head vertical-bob amplitude (m) and stride rate (Hz — one up-crossing,
   *  i.e. one counted step interval, per cycle). */
  bobAmpM?: number;
  strideHz?: number;
  heightM?: number;
}

/** A clean relaxed walk down the runway: constant pace, sinusoidal head bob
 *  of known amplitude/rate — the bob round-trip + cadence fixture. */
export function walkTape(opts: WalkTapeOpts = {}): WalkSample[] {
  const {
    hz = 90,
    spanM = 6.25,
    paceMps = 1.0,
    bobAmpM = 0.01,
    strideHz = 1.8,
    heightM = 1.6,
  } = opts;
  const dt = 1 / hz;
  const n = Math.ceil(spanM / paceMps / dt);
  const out: WalkSample[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i * dt;
    const along = Math.min(paceMps * t, spanM);
    out.push({
      dt,
      x: along, // straight segment: world x IS the along axis here
      y: heightM + bobAmpM * Math.sin(2 * Math.PI * strideHz * t),
      z: 0,
      along,
    });
  }
  return out;
}

/** Feed a walk tape straight into an accumulator (alongFrac = along/span). */
export function feedWalk(
  acc: FitWalkAccumulator,
  tape: ReadonlyArray<WalkSample>,
  spanM: number,
): void {
  for (const s of tape) acc.push(s.dt, s.x, s.y, s.z, s.along / spanM);
}

// ---------------------------------------------------------------------------
// Machine driving.
// ---------------------------------------------------------------------------

/** Quaternion components for a pure head pitch (rotation about +X): with the
 *  head-orient convention fy = sin(pitch), so pitchOf round-trips exactly. */
export function pitchQuat(pitchRad: number): {
  qx: number;
  qy: number;
  qz: number;
  qw: number;
} {
  return {
    qx: Math.sin(pitchRad / 2),
    qy: 0,
    qz: 0,
    qw: Math.cos(pitchRad / 2),
  };
}

/** Push one frame into the machine from position + route + plain pitch. */
export function pushHead(
  m: FitCaptureMachine,
  dt: number,
  x: number,
  y: number,
  z: number,
  along: number,
  lateral: number,
  pitchRad = 0,
): void {
  const q = pitchQuat(pitchRad);
  m.push(dt, x, y, z, q.qx, q.qy, q.qz, q.qw, along, lateral);
}

/** Hold still at the mark long enough to certify: standing frames at `hz`
 *  for `sec` seconds, collecting each frame's edge (transition-accurate). */
export function runStill(
  m: FitCaptureMachine,
  sec: number,
  opts: { hz?: number; x?: number; y?: number; z?: number; along?: number; lateral?: number; pitch?: number; seed?: number; noiseStdM?: number } = {},
): Array<NonNullable<ReturnType<FitCaptureMachine["takeEdge"]>>> {
  const {
    hz = 90,
    x = 0,
    y = 1.62,
    z = 0,
    along = 0.15,
    lateral = 0,
    pitch = -0.06,
    seed = 3,
    noiseStdM = 0.003,
  } = opts;
  const rand = mulberry32(seed);
  const dt = 1 / hz;
  const n = Math.round(sec * hz);
  const edges: Array<NonNullable<ReturnType<FitCaptureMachine["takeEdge"]>>> = [];
  for (let i = 0; i < n; i++) {
    pushHead(
      m,
      dt,
      x + noiseOf(rand, noiseStdM),
      y + noiseOf(rand, noiseStdM),
      z + noiseOf(rand, noiseStdM),
      along,
      lateral,
      pitch,
    );
    const e = m.takeEdge();
    if (e) edges.push(e);
  }
  return edges;
}

/** Walk the machine from startA to past the pose mark with a clean tape. */
export function runWalk(
  m: FitCaptureMachine,
  startA: number,
  spanM: number,
  opts: WalkTapeOpts = {},
): Array<NonNullable<ReturnType<FitCaptureMachine["takeEdge"]>>> {
  const tape = walkTape({ spanM, ...opts });
  const edges: Array<NonNullable<ReturnType<FitCaptureMachine["takeEdge"]>>> = [];
  for (const s of tape) {
    pushHead(m, s.dt, s.x, s.y, s.z, startA + s.along, 0, 0);
    const e = m.takeEdge();
    if (e) edges.push(e);
    if (m.stage === "saved" || m.stage === "aborted") break;
  }
  return edges;
}
