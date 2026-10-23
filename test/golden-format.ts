/**
 * (X)RUNWAY — the golden-vector FILE FORMAT contract (SOLO-MODE.md §6.3),
 * shared by the emitter (scripts/gen-golden-vectors.mjs) and the validator
 * (test/golden-freshness.test.ts) so the two can never disagree about what a
 * well-formed vector is.
 *
 * Pinned format — one JSON per module under test/golden/:
 *   { schema: "xrunway-golden/1", module,
 *     generatedBy: { script, gitSha, date }, cases: [{ name, input, expect }] }
 * with {"$num":"nan"|"+inf"|"-inf"} sentinels wherever a number is allowed
 * (JSON cannot carry non-finite numbers; the coach-live honesty cases NEED
 * NaN/Infinity inputs). The sentinel ENCODER is pose-tapes.ts `sanitize` —
 * already the tape serializer's — reused, not duplicated.
 *
 * Comparison rule (§6.5): exact for strings/bools/nulls and effectively exact
 * for rounded/int fields; floats within 1e-9 absolute + 1e-6 relative. The
 * relative term exists because pose-derive targets pass through a Float32Array
 * (one float32 ulp is ~1.2e-7 relative) — that quantization is the ONLY real
 * driver: a Double-throughout Swift port lands ~half an f32 ulp (~6e-8 rel)
 * from the emitted targets. (Rigid-twin rotation noise, once cited here as a
 * second justification, measures <= ~3e-15 relative across every paired leaf
 * — six orders inside even the 1e-9 absolute term.) Quantized fields
 * (Math.round ints, round3/round1 WalkStats) sit far outside the tolerance,
 * so any real divergence in them still fails.
 *
 * NO vitest imports — this loads under plain node for the generator.
 */

export const GOLDEN_SCHEMA = "xrunway-golden/1";

/** Every module file the generator emits (also the freshness inventory). */
export const GOLDEN_MODULES = [
  "walk-stats",
  "coach",
  "coach-live",
  "progress",
  "pose-derive-world",
  "solo-derive",
  "gap-tape",
  "walk-replay",
  "walk-replay-solo",
  "modes",
  "coach-tables",
  "copy-variants",
  // Wave 1 (EDGE-ROADMAP): the instrument-upgrade families. Query-style
  // (each case replays {queries} through the shared test/golden-replay.ts
  // runner); NOT paired — their tapes are head-orientation/row fixtures,
  // not pose-derive walks (head-carriage carries its own roll-invariance
  // twins, and the §D twin-pitch set crosses head-carriage x hold-stats).
  "fit-core",
  "head-carriage",
  "hold-stats",
  "repeatability",
  // Wave 2 (EDGE-ROADMAP): tempo + the turn. Query-style like the Wave 1
  // families; NOT paired (op tapes / strike sets, not pose-derive walks;
  // the §D cross-module yaw agreement is an emit-time anchor against a
  // live CarriageTracker, so head-carriage stays untouched).
  "beat-stats",
  "turn-stats",
] as const;

/** Modules whose cases are pose-derive walks and therefore carry a rigid
 * frame-invariance twin per case (SOLO-MODE §6.4). */
export const PAIRED_MODULES = [
  "pose-derive-world",
  "solo-derive",
  "gap-tape",
  "walk-replay",
  "walk-replay-solo",
] as const;

/** Name suffix of the rigidly transformed twin of a pose-derive walk case. */
export const RIGID_SUFFIX = "@rigid37";

/** The rigid transform the twins are generated under: yaw about +Y, then a
 * translation — the exact freedom of an unregistered gravity-aligned ARKit
 * world frame (rotation ~37 deg; y-translation allowed, gravity stays up). */
export const RIGID_TRANSFORM = {
  yawDeg: 37,
  translate: { x: 1.7, y: 0.35, z: -2.4 },
} as const;

export interface GoldenCase {
  name: string;
  input: unknown;
  expect: unknown;
}

export interface GoldenFile {
  schema: typeof GOLDEN_SCHEMA;
  module: string;
  generatedBy: { script: string; gitSha: string; date: string };
  cases: GoldenCase[];
}

/** Decode {"$num":...} sentinels back into JS numbers (inverse of sanitize). */
export function decodeNums(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeNums);
  if (v !== null && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    if (typeof rec.$num === "string" && Object.keys(rec).length === 1) {
      if (rec.$num === "nan") return Number.NaN;
      if (rec.$num === "+inf") return Number.POSITIVE_INFINITY;
      if (rec.$num === "-inf") return Number.NEGATIVE_INFINITY;
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(rec)) out[k] = decodeNums(val);
    return out;
  }
  return v;
}

/** Float tolerance: |a-b| <= ABS + REL * max(|a|,|b|) (see header). */
export const FLOAT_ABS_TOL = 1e-9;
export const FLOAT_REL_TOL = 1e-6;

function numbersClose(a: number, b: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= FLOAT_ABS_TOL + FLOAT_REL_TOL * scale;
}

/**
 * Deep-compare two decoded golden values under the §6.5 rule. Returns null
 * when they match, else a "path: detail" string naming the FIRST mismatch —
 * the generator throws it (fail loudly) and the freshness test asserts it
 * null so the diff lands in the failure message.
 */
export function goldenDiff(a: unknown, b: unknown, path = "$"): string | null {
  if (typeof a === "number" && typeof b === "number") {
    return numbersClose(a, b) ? null : `${path}: ${a} vs ${b}`;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return `${path}: array vs non-array`;
    }
    if (a.length !== b.length) {
      return `${path}: length ${a.length} vs ${b.length}`;
    }
    for (let i = 0; i < a.length; i++) {
      const d = goldenDiff(a[i], b[i], `${path}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.join(",") !== kb.join(",")) {
      return `${path}: keys [${ka}] vs [${kb}]`;
    }
    for (const k of ka) {
      const d = goldenDiff(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}.${k}`,
      );
      if (d !== null) return d;
    }
    return null;
  }
  // strings / booleans / null / undefined / mixed types: exact.
  return Object.is(a, b) ? null : `${path}: ${String(a)} vs ${String(b)}`;
}
