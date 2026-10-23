/**
 * (X)RUNWAY — SHARED M9 beat case builders: the single source of test-case
 * truth for BOTH the vitest suite (test/beat-stats.test.ts) and the future
 * `beat-stats` golden-family emitter in scripts/gen-golden-vectors.mjs (the
 * hold-helpers.ts pattern — the VECTORS commit registers the family; these
 * builders are ready for it).
 *
 * NO vitest imports allowed in this file: it must load under plain `node`
 * (the generator runs via node's TS type-stripping). Assertions stay in the
 * suite.
 *
 * THE WIRING-FEED LAW (the Wave 1 tape lesson): the op tapes here model the
 * stream the ENGINE actually feeds, per the M9 wiring spec + adjudication:
 * - one frame op per engine frame; a strike is delivered ONLY when the
 *   frame's ctx was running (the choke point's `ctx.state === "running"`
 *   gate lives in the WIRING — a suspended-clock frame never calls
 *   addStrike, so the tape must model the withheld call, not a gated one);
 * - `strikeAt` is the CO-SAMPLED audio-clock stamp (audioNow - go read in
 *   the detection frame) — never a converted walk-clock value;
 * - addRefTime runs on EVERY active frame with refLive = musicOn || walk
 *   pulse live (the wiring snippet's own arithmetic);
 * - `{ op: "void" }` is the resetCadence seam (camera<->head handoff);
 * - `{ op: "remap" }` is DELIBERATELY a no-op — the mid-walk runway remap
 *   resets the lateral channel but never touches M9 (strike timing is
 *   geometry-independent); the marker exists so a tape can assert the
 *   contrast case byte-for-byte;
 * - walk-end (adjudication §D, director-finalizes-first): the suite calls
 *   finalize() BEFORE feeding the final frame — finalize is non-destructive
 *   and re-callable, so the same tape pins the <= 1 excluded strike.
 */

import {
  BeatAccumulator,
  type BeatNullReason,
  type BeatStats,
  type BeatStrikeSource,
} from "../src/beat-stats.ts";
import { beatSecOf } from "../src/show-timing.ts";

/**
 * The FIXTURE tempo: the legacy 122 BPM engine constant every existing tape
 * was recorded at. The product's deliverable tempos are 62/100/125
 * (music-prefs.ts) — 122 stays pinned HERE as data so the historical golden
 * tapes replay byte-identically through the now-tempo-parameterized core
 * (the walkSeconds fixture-decoupling lesson). New per-tempo cases pass
 * their own bpm explicitly.
 */
export const FIXTURE_BPM = 122;

// ---------------------------------------------------------------------------
// Deterministic randomness (dependency-free): mulberry32 + Box-Muller.
// ---------------------------------------------------------------------------

/** mulberry32 — the standard tiny seeded PRNG (32-bit state, [0, 1) out). */
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

/** One standard-normal draw via Box-Muller (two uniform draws per call —
 *  simple beats stateful here; the epsilon floor guards log(0)). */
export function gauss(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// Strike-time builders (audio-clock tSinceGo values, seconds).
// ---------------------------------------------------------------------------

/**
 * A locked walker: strikes at offsetSec + k * periodSec + jitter, jitter ~
 * N(0, (sigmaBeats * periodSec)^2) — phase on the periodSec grid is
 * N(offset/period, sigmaBeats^2) wrapped, so the analytic population
 * resultant is the wrapped-normal rho = exp(-(2*pi*sigmaBeats)^2 / 2).
 * Times are NOT sorted: a rare large-jitter inversion produces a
 * non-monotone stamp the accumulator's debounce drops, exactly like the
 * real feed would.
 */
export function lockedTimes(o: {
  n: number;
  periodSec: number;
  sigmaBeats?: number;
  offsetSec?: number;
  seed?: number;
}): number[] {
  const rand = mulberry32(o.seed ?? 1);
  const sigma = (o.sigmaBeats ?? 0) * o.periodSec;
  const offset = o.offsetSec ?? 0;
  const out: number[] = [];
  for (let k = 1; k <= o.n; k++) {
    out.push(offset + k * o.periodSec + (sigma > 0 ? gauss(rand) * sigma : 0));
  }
  return out;
}

/**
 * A chance walker: strikes at (k + u_k) * periodSec with u_k uniform [0, 1)
 * — phases on the periodSec grid are uniform on the circle. Consecutive
 * intervals can dip under the debounce (P ~ 1.2% per pair), dropping a
 * strike occasionally — the suite reads the ACTUAL counted n off the row.
 */
export function uniformTimes(o: {
  n: number;
  periodSec: number;
  seed?: number;
}): number[] {
  const rand = mulberry32(o.seed ?? 1);
  const out: number[] = [];
  for (let k = 1; k <= o.n; k++) {
    out.push((k + rand()) * o.periodSec);
  }
  return out;
}

/**
 * The EXACT-R_raw cluster builder (the adjudication-§H worked example's
 * tape): nCluster strikes at phase 0 plus nSpread strikes at the evenly
 * spread phases j/nSpread (whose unit vectors sum to EXACTLY zero), so
 *
 *   R_raw = nCluster / (nCluster + nSpread)      (40/50 = 0.8 exactly)
 *
 * Interleaved (nCluster/nSpread cluster strikes, then one spread strike,
 * repeated) so consecutive phase deltas stay >= -0.5 and every inter-strike
 * interval >= 0.5 * periodSec — clear of the 0.15 s debounce on either
 * grid. Times: t_i = (i + 1 + phase_i) * periodSec (i = 0-based emit
 * order), so the mean interval is ~periodSec and the chooser reads the
 * grid's own cadence. nCluster must divide evenly by nSpread.
 */
export function clusterTimes(
  nCluster: number,
  nSpread: number,
  periodSec: number,
): number[] {
  const per = nCluster / nSpread;
  const phases: number[] = [];
  for (let j = 0; j < nSpread; j++) {
    for (let k = 0; k < per; k++) phases.push(0);
    // wrap j/nSpread into [-0.5, 0.5) — same circle point, monotone-safe.
    const p = j / nSpread;
    phases.push(p >= 0.5 ? p - 1 : p);
  }
  return phases.map((p, i) => (i + 1 + p) * periodSec);
}

// ---------------------------------------------------------------------------
// Wiring-feed op tapes.
// ---------------------------------------------------------------------------

/** Tape frame delta (s) — binary-exact (1/4) so repeated addition sums
 *  exactly and refSec asserts come out as clean numbers. */
export const BEAT_TAPE_DT = 0.25;

/** One engine frame as the M9 wiring sees it. */
export interface BeatFrameOp {
  op: "frame";
  /** ECS frame delta (s) — feeds addRefTime. Default BEAT_TAPE_DT. */
  dt?: number;
  /** Co-sampled audio-clock strike stamp (tSinceGo, s) — present only on a
   *  frame whose strike latch fired. */
  strikeAt?: number;
  /** musicPrefs.enabled && volume > 0 at this frame (peek). Default true. */
  musicOn?: boolean;
  /** globals.beatDelivery.walk at this frame. Default null. */
  hapticKind?: "haptic" | "earcon" | null;
  /** The derive path owning this frame. Default "head". */
  source?: BeatStrikeSource;
  /** ctx.state === "running" — false models the suspended clock: the wiring
   *  WITHHOLDS addStrike entirely. Default true. */
  ctxRunning?: boolean;
}

export type BeatOp =
  | BeatFrameOp
  /** The resetCadence seam (camera<->head handoff) -> voidStrikes(). */
  | { op: "void" }
  /** Mid-walk runway remap — a DOCUMENTED no-op on M9 (geometry-blind). */
  | { op: "remap" };

/** Feed an op tape through the accumulator exactly as the wiring would. */
export function feedBeatOps(
  acc: BeatAccumulator,
  ops: readonly BeatOp[],
): void {
  for (const o of ops) {
    if (o.op === "void") {
      acc.voidStrikes();
      continue;
    }
    if (o.op === "remap") {
      continue; // geometry-blind: the wiring adds one comment, no call
    }
    const dt = o.dt ?? BEAT_TAPE_DT;
    const musicOn = o.musicOn ?? true;
    const hk = o.hapticKind ?? null;
    if ((o.ctxRunning ?? true) && o.strikeAt !== undefined) {
      acc.addStrike(o.strikeAt, musicOn, hk, o.source ?? "head");
    }
    acc.addRefTime(dt, musicOn || hk !== null);
  }
}

/** Strike times -> one frame op per strike, dt = the gap since the previous
 *  strike (walk and audio clocks tick at the same rate in a same-clock
 *  tape), so refSec tracks the tape's span. `over` applies to every frame;
 *  `from` anchors the first gap (a tape segment appended after `from`
 *  seconds of walk must not re-bill the elapsed span into its first dt). */
export function strikeOps(
  times: readonly number[],
  over: Omit<BeatFrameOp, "op" | "strikeAt" | "dt"> = {},
  from = 0,
): BeatOp[] {
  const ops: BeatOp[] = [];
  let prev = from;
  for (const t of times) {
    ops.push({ op: "frame", dt: t - prev, strikeAt: t, ...over });
    prev = t;
  }
  return ops;
}

export interface BeatRun {
  acc: BeatAccumulator;
  stats: BeatStats | null;
  reason: BeatNullReason;
}

/** reset(goValid, bpm, fit) -> feed -> finalize + nullReason in one move.
 *  `bpm` defaults to the FIXTURE tempo (122) so the historical tapes replay
 *  unchanged; per-tempo cases pass their own. */
export function runBeatOps(
  ops: readonly BeatOp[],
  o: { goValid?: boolean; bpm?: number; fit?: number | null } = {},
): BeatRun {
  const acc = new BeatAccumulator();
  acc.reset(o.goValid ?? true, o.bpm ?? FIXTURE_BPM, o.fit ?? null);
  feedBeatOps(acc, ops);
  return { acc, stats: acc.finalize(), reason: acc.nullReason() };
}

/** Strike times straight through (all-frames-referenced unless overridden). */
export function runStrikes(
  times: readonly number[],
  o: {
    goValid?: boolean;
    bpm?: number;
    fit?: number | null;
    over?: Omit<BeatFrameOp, "op" | "strikeAt" | "dt">;
  } = {},
): BeatRun {
  return runBeatOps(strikeOps(times, o.over ?? {}), o);
}

/** A BeatStats literal with locked-walk defaults — the copy-branch builder
 *  (beatStatLine/beatCue are pure functions of the struct). Defaults sit
 *  clear of the direction gates (|drift| < 2) so cue tests opt in
 *  explicitly. */
export function makeBeat(over: Partial<BeatStats> = {}): BeatStats {
  return {
    strikes: 40,
    vectorR: 0.8,
    vectorRRaw: 0.81,
    meanPhaseBeats: 0.12,
    rayleighNR2: 26.24,
    subdivision: "2-beat",
    gridSpm: 61,
    cadenceSpm: 61.5,
    driftSpm: 0.5,
    refSec: 20,
    reference: "music",
    strikeSource: "head",
    beatScore: 86.4,
    ...over,
  };
}

/** Grid period (s) for a subdivision AT THE FIXTURE TEMPO — test-side sugar
 *  (the historical tapes' grids: 122 spm / 61 spm). */
export const PERIOD_1X = beatSecOf(FIXTURE_BPM); // every beat, 122 spm
export const PERIOD_2X = 2 * beatSecOf(FIXTURE_BPM); // every 2nd beat, 61 spm
