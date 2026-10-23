/**
 * (X)RUNWAY — golden-vector generator (SOLO-MODE.md §6, Phase A1b).
 *
 *   node scripts/gen-golden-vectors.mjs
 *
 * Emits test/golden/<module>.json — the drift lock the Swift Solo port's
 * XCTest target consumes. THE PIPELINE RULE IS ENFORCED HERE: the script runs
 * `npx vitest run` first and REFUSES to emit while the suite is red, then
 * imports the REAL src modules (walk-stats, coach, coach-live, progress,
 * session-grading, pose-derive, modes) and the vitest suites' own SHARED case
 * builders (test/case-helpers.ts) so tests and vectors are provably the same
 * truth. Expected values are never hand-copied — every `expect` below is the
 * live output of the real module over the recorded `input`.
 *
 * Execution: plain node with native TS type-stripping — exactly how
 * test/pose-derive-tape.mjs executes the extracted module. One wrinkle: src
 * files import each other with ".js" specifiers (the vite/tsc convention),
 * which node's stripper does not remap, so a tiny synchronous resolve hook
 * (module.registerHooks) retries a failed relative ".js" resolution as ".ts".
 * All project imports are dynamic so they resolve after the hook installs.
 *
 * File format + comparison rule: test/golden-format.ts (shared with the
 * validating test/golden-freshness.test.ts). Non-finite numbers ride the
 * {"$num":"nan"|"+inf"|"-inf"} sentinels via pose-tapes.ts `sanitize`.
 *
 * Determinism: byte-identical output on every run at the same CLEAN HEAD —
 * no Date.now, no Math.random; the generatedBy stamp uses HEAD's sha and
 * HEAD's COMMIT date (git show -s --format=%cI), not wall time. Emission
 * REFUSES a dirty src/test/scripts tree (the stamp must reproduce the
 * bytes): commit the code change first, regenerate at the clean HEAD, then
 * commit the vectors as the follow-up.
 *
 * Modes:
 *   node scripts/gen-golden-vectors.mjs           # emit (vitest-gated)
 *   node scripts/gen-golden-vectors.mjs --expect-stale=<family,...>
 *     # the deliberate-semantic-change escape: gate vitest WITHOUT the two
 *     # golden-net files (they are red by definition once a locked module's
 *     # behavior legitimately changes), and refuse to write unless every
 *     # family NOT named rebuilds byte-identical to disk — declared drift
 *     # only, never silent drift. Use ONLY for a reviewed semantic change.
 *   node scripts/gen-golden-vectors.mjs --check   # staleness net: rebuild
 *     in memory, diff vs the checked-in files ignoring generatedBy, exit
 *     nonzero on ANY divergence (wired into `npm test` after vitest — no
 *     recursion, no writes). The replay runners themselves live in
 *     test/golden-replay.ts, shared with test/golden-replay.test.ts, so
 *     the emitters and the nets are provably the same code.
 *
 * ANALYTIC ANCHORS (SOLO-MODE §6.5): where closed-form simulation truth
 * exists (gap-tape/walk-replay pace + cadence, solo-derive clean-line and
 * slouch, the nan-junk == normal-walk dt/anchor invariant), the builders
 * assert it and THROW before emitting — TS-generated vectors pin "matches
 * the web"; the anchors pin "is physically correct".
 *
 * Replicated seams (documented, minimal — everything scoring-relevant is
 * imported, never re-implemented):
 *  - the fresh-frame gate + walk clock around deriveWorld (metrics.ts
 *    update(): derive once per distinct frame.t with the true inter-pose dt;
 *    walkTime += delta) — the same seam test/pose-tapes.ts replicates;
 *  - the display smoothing + ~6 Hz rounded publish (metrics.ts update()) —
 *    the CONSTANTS AND FORMS (NEUTRAL, PUBLISH_INTERVAL, rampInWeight,
 *    displayBlend) are imported from src/metrics-wiring.ts, the module
 *    metrics.ts itself runs; only the accumulate-and-modulo loop shape is
 *    replicated here;
 *  - the 2 Hz cue sampling + channel taps (coach-live-system.ts update():
 *    sampleAcc >= COACH_SAMPLE_SEC — imported from src/coach-live.ts — ->
 *    LiveCueInput from the walk-stats live taps, paceDeltaMps =
 *    livePaceMps - idealPace under Number.isFinite);
 *  - the finish rollup (show.ts finishWalk(): overall = clamp(0..100,
 *    round(sum scores[key] * mode.weights[key] over the canonical METRICS
 *    key order)), durationSec = round1(elapsed), stats.finalize(elapsed));
 *  - the Solo walk model's synthesized cue context (SOLO-MODE §2:
 *    walkProgress01 = elapsed/duration (clock-based), markAtSec = the MOST
 *    RECENT travel-heading reversal, re-armed per lap at EITHER end (§2's
 *    "fire repeatedly"; near-end reversals mark too — §5's bias toward
 *    over-triggering: an extra mark wrongly clears fault clocks for 4 s =
 *    benign, a missed one = false cues), walkRemainingSec = walkSeconds -
 *    elapsed) — emitted INTO the vector (input.cueContext) so consumers
 *    replay data, not rules.
 *
 * FRAME-INVARIANCE (the §6.4 honesty check): every pose-derive walk is
 * emitted twice — raw, and rigidly transformed (yaw 37 deg about +Y plus a
 * translation: the full freedom of an unregistered gravity-aligned ARKit
 * frame). The generator verifies the two expected outputs are identical
 * (goldenDiff: exact strings/ints, 1e-9+1e-6-rel floats for IEEE rotation
 * noise) and THROWS if they differ — a failure here means a scoring channel
 * depends on the sender's arbitrary world frame, which Solo mode forbids.
 * A 30 vs 60 Hz sanity check on the walk-replay stats guards the EMA forms'
 * promised rate-independence the same way.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// --- resolve shim: retry relative ".js" as ".ts" (see header) --------------

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith(".") && specifier.endsWith(".js")) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw err;
    }
  },
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "test", "golden");
// The committed Swift mirror (SOLO-MODE §6 drift lock, Swift half). `--check`
// deep-compares it against the freshly-built in-memory vectors too, so a
// "regenerate test/golden/ but forget sync-golden.sh" mistake goes RED at the
// repo `npm test`, not just at the Swift build's preBuildScripts gate.
const MIRROR_DIR = join(
  ROOT,
  "native",
  "ios-companion",
  "Tests",
  "XRunwayCoreTests",
  "golden",
);
const SCRIPT = "scripts/gen-golden-vectors.mjs";

/** --check: rebuild every family in memory and diff against the checked-in
 * test/golden/*.json (ignoring generatedBy — provenance legitimately
 * differs), exit nonzero on any divergence. Runs NO vitest (npm test wires
 * `vitest run && … --check`, so the suite already ran — no recursion) and
 * writes NOTHING. This is the staleness net the drift lock was missing: a
 * scoring change without regeneration goes red here on every `npm test`. */
const CHECK = process.argv.includes("--check");

/**
 * --expect-stale=<family,...> — the DELIBERATE-SEMANTIC-CHANGE escape (added
 * in the Wave 1 review fix pass, which changed the hold-window arming law):
 * once a locked module's behavior legitimately changes, the checked-in
 * vectors are honestly stale, the replay net is necessarily red, and the
 * plain vitest gate would deadlock regeneration forever. Under this flag:
 * - the vitest gate runs WITHOUT the two golden-net files (everything else
 *   must still be green — a red unit suite still refuses);
 * - before writing, every family NOT named must rebuild BYTE-IDENTICAL to
 *   disk (ignoring generatedBy) — the escape cannot hide drift it did not
 *   declare; a typo'd family name refuses.
 * The flag is for the vectors-regeneration step of a reviewed semantic
 * change ONLY; plain emission stays fully gated.
 */
const EXPECT_STALE = (() => {
  const arg = process.argv.find((a) => a.startsWith("--expect-stale="));
  if (!arg) return null;
  const set = new Set(
    arg
      .slice("--expect-stale=".length)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (set.size === 0) {
    console.error("[golden] --expect-stale requires at least one family name");
    process.exit(2);
  }
  return set;
})();
if (CHECK && EXPECT_STALE) {
  console.error("[golden] --check and --expect-stale are mutually exclusive");
  process.exit(2);
}

if (!CHECK) {
  // --- 1) pipeline rule: vitest green or NO vectors -------------------------
  // Under --expect-stale the two golden-net files are excluded by EXPLICIT
  // file list (never a glob override — vitest's --exclude replaces config
  // globs and could unshield node_modules); every other suite must be green.
  let vitestArgs = ["vitest", "run"];
  if (EXPECT_STALE) {
    const testFiles = readdirSync(join(ROOT, "test"))
      .filter(
        (f) =>
          f.endsWith(".test.ts") &&
          f !== "golden-replay.test.ts" &&
          f !== "golden-freshness.test.ts",
      )
      .map((f) => join("test", f));
    vitestArgs = ["vitest", "run", ...testFiles];
    console.error(
      `[golden] --expect-stale=${[...EXPECT_STALE].join(",")} — gating on ` +
        `${testFiles.length} suites (golden nets excluded; they are red by ` +
        `definition until this regen lands).`,
    );
  }
  console.error("[golden] running the vitest suite (red suite = no emission)…");
  try {
    execFileSync("npx", vitestArgs, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    process.stderr.write(String(err.stdout ?? ""));
    process.stderr.write(String(err.stderr ?? ""));
    console.error("[golden] REFUSING to emit: the vitest suite is red.");
    process.exit(1);
  }
  console.error("[golden] suite green.");

  // --- 1b) provenance rule: never emit from a dirty tree --------------------
  // The generatedBy stamp is HEAD's sha, but every module imports from the
  // WORKING TREE: emitting with uncommitted src/test/script changes stamps a
  // sha that cannot reproduce the bytes (the SOLO-MODE §6 "stale vector is
  // detectable" promise would lie). Honest flow: commit the code change,
  // regen at the clean HEAD, commit the vectors as the follow-up.
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain", "--", "src", "scripts", "test", ":(exclude)test/golden"],
    { cwd: ROOT },
  )
    .toString()
    .trim();
  if (dirty) {
    console.error(
      "[golden] REFUSING to emit from a dirty tree — the generatedBy sha " +
        "would not reproduce these bytes. Commit first, then regenerate:\n" +
        dirty,
    );
    process.exit(1);
  }
}

const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT })
  .toString()
  .trim();
const date = execFileSync("git", ["show", "-s", "--format=%cI", "HEAD"], {
  cwd: ROOT,
})
  .toString()
  .trim();

// --- 2) the REAL modules + the suites' shared case builders ----------------

const { CLEAN_WALK_CUE, METRIC_COACH, METRIC_EXPLAIN, buildCoachReport } =
  await import("../src/coach.ts");
const {
  COACH_EARCONS,
  COACH_EARCON_LEVEL,
  LIVE_CUE_TEXT,
  LiveCoachPolicy,
  PACE_DELTA_CUE_MPS,
  SOLO_CUE_GATES,
  SOLO_LATERAL_CUE_M,
  SOLO_LATERAL_CUE_SMOOTH_RATE,
  SOLO_POSTURE_CUE_M,
} = await import("../src/coach-live.ts");
const { SOLO_COPY_VARIANTS } = await import("../src/coach-copy.ts");
const { MODES } = await import("../src/modes.ts");
const {
  SOLO_GAP_SEC,
  SOLO_HEADING_STABLE_MIN,
  SOLO_LATERAL_BASELINE_SEC,
  SOLO_POSTURE_SLOPE,
  SOLO_TURN_EXCLUDE_SEC,
} = await import("../src/pose-derive.ts");
const {
  buildSoloTapes,
  buildTapes,
  makeRealSession,
  makeSoloSession,
  runTape,
  sanitize,
  walkKeypoints,
} = await import("../test/pose-tapes.ts");
// The PURE replay runners — the SAME code the web-side staleness net
// (test/golden-replay.test.ts + this script's --check mode) executes, so
// vectors and their replay are provably one truth.
const {
  deriveExpect,
  gatesFor,
  runBeatQueries,
  runCarriageQueries,
  runFitQueries,
  runHoldQueries,
  runLiveEvents,
  runProgressQueries,
  runRepeatabilityQueries,
  runReplay,
  runSoloReplay,
  runTurnQueries,
  runWalkStatsOps,
} = await import("../test/golden-replay.ts");
const helpers = await import("../test/case-helpers.ts");
const { sample, run, coachContext, noteContext, snap, stats, row, scored, modeRow } =
  helpers;
const {
  GOLDEN_SCHEMA,
  PAIRED_MODULES,
  RIGID_SUFFIX,
  RIGID_TRANSFORM,
  decodeNums,
  goldenDiff,
} = await import("../test/golden-format.ts");
// Wave 1 families — the SHARED case builders (the case-helpers law: the
// suites and the vectors are provably one truth) + the constants the
// analytic anchors cite. Same-named builders are aliased per family.
const {
  baseline: fitBaseline,
  mulberry32,
  noiseOf,
  pitchQuat,
  spikeTape: fitSpikeTape,
  stillTape: fitStillTape,
  swayTape: fitSwayTape,
  walkTape: fitWalkTape,
} = await import("../test/fit-helpers.ts");
const { calibrated, makeCarriage } = await import("../test/carriage-helpers.ts");
const {
  HOLD_TAPE_DT,
  HOLD_TAPE_FRAMES,
  HOLD_TAPE_FRAMES_ARMED,
  Q_IDENTITY,
  boltTape,
  ditherQ,
  holdStats,
  quatPitch: holdQuatPitch,
  quatYaw: holdQuatYaw,
  quatYawPitch,
  rimFreezeTape,
  stepTape: holdStepTape,
  stillTape: holdStillTape,
  tape: holdTape,
  transitTape,
} = await import("../test/hold-helpers.ts");
const { benchRow, fullWalks, paceWalks, slice, walkRow } = await import(
  "../test/repeat-helpers.ts"
);
const { FIT_STILL_STD_M } = await import("../src/fit-session.ts");
const {
  HOLD_MARK_FAULT_CM,
  HOLD_MARK_GOOD_CM,
  HOLD_STILL_GOOD_NORM_CM,
  HOLD_WINDOW_SEC,
} = await import("../src/hold-stats.ts");
const { SERIES_MAX } = await import("../src/progress.ts");
// Wave 2 families — the SHARED case builders (beat-helpers / turn-helpers,
// the committed op-tape drivers) + the constants the analytic anchors cite.
// NOTE: beat-helpers also exports mulberry32 — NOT destructured here (the
// fit-helpers one at the top already owns the name; same algorithm).
const {
  clusterTimes,
  lockedTimes,
  makeBeat,
  PERIOD_1X,
  PERIOD_2X,
  strikeOps,
  uniformTimes,
} = await import("../test/beat-helpers.ts");
const {
  TURN_TAPE_DT,
  cleanPivot,
  fullProtocolOps,
  makeTurnStats,
  protocolPrelude,
  returnLeg,
} = await import("../test/turn-helpers.ts");
const {
  BEAT_FLAM_SUPPRESS_SEC,
  BEAT_GO_FRESH_AFTER_SEC,
  BEAT_GO_STALE_BEFORE_SEC,
  BEAT_LOCK_FAULT_R,
  BEAT_LOCK_GOOD_R,
  BEAT_MIN_STRIKES,
  BEAT_PULSE_LEAD_SEC,
  BEAT_STRIKE_DEBOUNCE_SEC,
  BEAT_SUBDIV_DEADZONE_SPM,
  beatGridCandidates,
  wrapPhaseBeats,
} = await import("../src/beat-stats.ts");
const { COUNTDOWN_SEC } = await import("../src/show-timing.ts");
// The FIXTURE tempo's beat period (the multi-BPM wave): the historical beat
// tapes stay authored at the legacy 122 — PERIOD_1X (beat-helpers) IS that
// beat; the alias keeps the emitter's arithmetic reading as before.
const BEAT = PERIOD_1X;
const { STEP_DEBOUNCE_SEC } = await import("../src/walk-stats.ts");
const {
  TURN_DIP_FAULT_FRAC,
  TURN_DUR_BASE_HI_SEC,
  TURN_DUR_BASE_LO_SEC,
  TURN_DUR_BASE_PACE_MPS,
} = await import("../src/turn-stats.ts");
const { LATERAL_CUE_M, POSTURE_CUE_M } = await import("../src/coach-live.ts");
const { HOLD_REF_HEAD_M } = await import("../src/hold-stats.ts");

const files = [];
function emit(module, cases) {
  const names = new Set();
  for (const c of cases) {
    if (names.has(c.name)) throw new Error(`${module}: duplicate case ${c.name}`);
    names.add(c.name);
  }
  files.push({
    schema: GOLDEN_SCHEMA,
    module,
    generatedBy: { script: SCRIPT, gitSha, date },
    cases,
  });
}

// =============================================================================
// walk-stats — ops tapes (the A4 §"golden-vector proposal" case shape).
// =============================================================================

// runWalkStatsOps lives in test/golden-replay.ts (shared with the net).

function walkStatsCases() {
  const t = (name, ops) => ({
    name,
    input: { ops },
    expect: runWalkStatsOps(ops),
  });
  return [
    t("finalize-null-when-nothing-ran", [
      { op: "reset", idealPace: 0.85 },
      { op: "finalize", durationSec: 30 },
    ]),
    t("pace-duration-weighted-mean", [
      { op: "reset", idealPace: 0.85 },
      { op: "addPace", v: 1, dt: 1 },
      { op: "addPace", v: 2, dt: 3 },
      { op: "finalize", durationSec: 4 },
    ]),
    t("pace-mm-rounding", [
      { op: "reset", idealPace: 0.85 },
      { op: "addPace", v: 1.23456, dt: 1 },
      { op: "finalize", durationSec: 1 },
    ]),
    // The A4 "JS-rounding landmine": signed means can be negative, and JS
    // Math.round(-2.5) is -2 (half toward +Infinity), not banker's/away-0.
    t("negative-half-rounding-landmine", [
      { op: "reset", idealPace: 0.85 },
      { op: "addLateral", v: -0.0025, dt: 1 },
      { op: "addPosture", v: -0.0035, dt: 1 },
      { op: "finalize", durationSec: 2 },
    ]),
    t("non-finite-and-non-positive-dt-samples-rejected", [
      { op: "reset", idealPace: 0.85 },
      { op: "addPace", v: NaN, dt: 1 },
      { op: "addPace", v: Infinity, dt: 1 },
      { op: "addPace", v: 1, dt: 0 },
      { op: "addPace", v: 1, dt: -1 },
      { op: "addLateral", v: NaN, dt: 1 },
      { op: "addPosture", v: -Infinity, dt: 1 },
      { op: "addPace", v: 1.5, dt: 0.5 },
      { op: "finalize", durationSec: 1 },
    ]),
    t("weave-cancels-signed-mean-not-abs", [
      { op: "reset", idealPace: 0.85 },
      { op: "addLateral", v: 0.2, dt: 1 },
      { op: "addLateral", v: -0.2, dt: 1 },
      { op: "finalize", durationSec: 2 },
    ]),
    t("channels-null-independently", [
      { op: "reset", idealPace: 0.85 },
      { op: "addPosture", v: 0.05, dt: 2 },
      { op: "finalize", durationSec: 2 },
    ]),
    t("step-debounce-edges", [
      { op: "reset", idealPace: 0.85 },
      { op: "addStep", at: 1 },
      { op: "addStep", at: 1.1 }, // < STEP_DEBOUNCE_SEC after 1.0 -> same step
      { op: "addStep", at: 1.15 }, // exactly the debounce gap -> counts
      { op: "addStep", at: 5 }, // no upper bound: a pause is still a step
      { op: "finalize", durationSec: 60 },
    ]),
    t("cadence-round1-half-case", [
      { op: "reset", idealPace: 0.85 },
      { op: "addStep", at: 1 },
      { op: "addStep", at: 2 },
      { op: "addStep", at: 3 },
      { op: "addStep", at: 4 },
      { op: "addStep", at: 5 },
      { op: "finalize", durationSec: 80 }, // 3.75 spm -> round1 -> 3.8
    ]),
    t("source-dominance-most-time-wins", [
      { op: "reset", idealPace: 0.85 },
      { op: "noteSource", source: "head", dt: 2 },
      { op: "noteSource", source: "camera-world", dt: 3 },
      { op: "finalize", durationSec: 5 },
    ]),
    t("source-tie-keeps-head", [
      { op: "reset", idealPace: 0.85 },
      { op: "noteSource", source: "camera-world", dt: 2 },
      { op: "noteSource", source: "head", dt: 2 },
      { op: "finalize", durationSec: 4 },
    ]),
    t("source-tie-image-beats-world", [
      { op: "reset", idealPace: 0.85 },
      { op: "noteSource", source: "camera-world", dt: 2 },
      { op: "noteSource", source: "camera-image", dt: 2 },
      { op: "finalize", durationSec: 4 },
    ]),
    t("source-non-positive-dt-ignored", [
      { op: "reset", idealPace: 0.85 },
      { op: "noteSource", source: "camera-world", dt: 0 },
      { op: "noteSource", source: "camera-world", dt: -3 },
      { op: "noteSource", source: "head", dt: 0.1 },
      { op: "finalize", durationSec: 1 },
    ]),
    t("resetLateral-clears-only-centerline", [
      { op: "reset", idealPace: 0.85 },
      { op: "addPace", v: 1, dt: 1 },
      { op: "addLateral", v: 0.3, dt: 1 },
      { op: "addStep", at: 0.5 },
      { op: "resetLateral" },
      { op: "addLateral", v: -0.1, dt: 1 },
      { op: "finalize", durationSec: 2 },
    ]),
    t("finalize-non-destructive", [
      { op: "reset", idealPace: 0.85 },
      { op: "addPace", v: 1, dt: 1 },
      { op: "finalize", durationSec: 1 },
      { op: "finalize", durationSec: 1 }, // identical
      { op: "addPace", v: 3, dt: 1 },
      { op: "finalize", durationSec: 2 }, // keeps accumulating
    ]),
    t("reset-rearms-everything-incl-debounce-clock", [
      { op: "reset", idealPace: 0.85 },
      { op: "addPace", v: 1, dt: 1 },
      { op: "addStep", at: 1 },
      { op: "addStep", at: 1.05 }, // debounced
      { op: "reset", idealPace: 1.05 },
      { op: "addStep", at: 1.1 }, // counts: the debounce clock re-armed
      { op: "finalize", durationSec: 1 },
    ]),
    t("mixed-cadence-weighting", [
      { op: "reset", idealPace: 0.95 },
      { op: "addPace", v: 1, dt: 0.011 },
      { op: "addPace", v: 1, dt: 0.011 },
      { op: "addPace", v: 1, dt: 0.011 },
      { op: "addPace", v: 2, dt: 0.033 },
      { op: "finalize", durationSec: 0.066 },
    ]),
    t("zero-duration-cadence-null", [
      { op: "reset", idealPace: 0.85 },
      { op: "addStep", at: 0.1 },
      { op: "finalize", durationSec: 0 },
    ]),
    // The live-tap surface (the exact fields coach-live-system samples at
    // 2 Hz and the session recorder taps at 6 Hz): passthrough incl. a
    // non-finite value (taps are dumb assignable fields — honesty gating
    // happens at the CONSUMERS), and reset() nulls all three.
    t("reset-nulls-the-live-taps", [
      { op: "reset", idealPace: 0.85 },
      { op: "setLive", pace: 1.5, lat: 0.4, post: -0.1 },
      { op: "readLive" },
      { op: "setLive", pace: NaN, lat: 0.4, post: -0.1 },
      { op: "readLive" },
      { op: "reset", idealPace: 0.95 },
      { op: "readLive" },
      { op: "noteSource", source: "head", dt: 1 },
      { op: "addPace", v: 0.9, dt: 1 },
      { op: "addStep", at: 0.01 },
      { op: "finalize", durationSec: 30 },
    ]),
  ];
}

// =============================================================================
// coach — CoachContext -> full CoachReport (exact strings, honesty gates).
// =============================================================================

function coachCases() {
  const cases = [];
  const add = (name, ctx) => {
    cases.push({
      name,
      input: {
        scores: ctx.scores,
        overall: ctx.overall,
        mode: { passThreshold: ctx.mode.passThreshold, weights: ctx.mode.weights },
        stats: ctx.stats,
        oneWayRoute: ctx.oneWayRoute,
      },
      expect: { report: buildCoachReport(ctx) },
    });
  };

  // Verdict rounding (the UIs' Math.round law) + rounded display overall.
  for (const overall of [78, 77.5, 77.49, 77, 83.6]) {
    add(`verdict-overall-${overall}`, coachContext({ overall }));
  }
  // Every mode's own bar, at and just under.
  for (const m of MODES) {
    add(`bar-${m.id}-at`, coachContext({ mode: m, overall: m.passThreshold }));
    add(
      `bar-${m.id}-under`,
      coachContext({ mode: m, overall: m.passThreshold - 1 }),
    );
  }
  // Note selection: clean walks, ranking, cap, tie-break.
  add("notes-empty-all-clear", coachContext({ scores: snap(90) }));
  add("notes-empty-exactly-at-bar", coachContext({ scores: snap(78) }));
  add("notes-empty-rounds-up-to-bar", coachContext({ scores: snap(77.6) }));
  add(
    "notes-ranked-weight-x-shortfall",
    coachContext({
      scores: snap(95, { posture: 70, pace: 60, presence: 77 }),
      overall: 70,
    }),
  );
  add("notes-capped-at-three", coachContext({ scores: snap(50), overall: 50 }));
  add(
    "notes-tie-break-m1-m7-order",
    coachContext({
      scores: snap(95, { presence: 70, confidence: 70 }),
      overall: 85,
    }),
  );
  // Directional/honesty gates — one below-line metric per case (noteContext).
  const note = (name, key, st, oneWay = false) =>
    cases.push({
      name,
      input: {
        scores: noteContext(key, st, oneWay).scores,
        overall: 85,
        mode: {
          passThreshold: helpers.BEGINNER.passThreshold,
          weights: helpers.BEGINNER.weights,
        },
        stats: st,
        oneWayRoute: oneWay,
      },
      expect: { report: buildCoachReport(noteContext(key, st, oneWay)) },
    });
  note(
    "pace-directional-fast",
    "pace",
    stats({ meanPaceMps: 1.1, idealPaceMps: 0.72, paceDeltaMps: 0.38 }),
  );
  note(
    "pace-directional-slow",
    "pace",
    stats({ meanPaceMps: 0.55, idealPaceMps: 0.85, paceDeltaMps: -0.3 }),
  );
  note("pace-null-channel-generic", "pace", stats());
  note(
    "pace-dead-on-generic",
    "pace",
    stats({ meanPaceMps: 0.85, idealPaceMps: 0.85, paceDeltaMps: 0 }),
  );
  note(
    "pace-sub-display-resolution-generic",
    "pace",
    stats({ meanPaceMps: 0.853, idealPaceMps: 0.85, paceDeltaMps: 0.003 }),
  );
  note(
    "pace-just-past-display-resolution",
    "pace",
    stats({ meanPaceMps: 0.86, idealPaceMps: 0.85, paceDeltaMps: 0.01 }),
  );
  note("posture-rode-above-cm", "posture", stats({ postureDriftM: 0.035 }));
  note("posture-sank-below-cm", "posture", stats({ postureDriftM: -0.02 }));
  note("posture-sub-cm-generic", "posture", stats({ postureDriftM: 0.004 }));
  note("posture-null-generic", "posture", stats());
  note(
    "foot-oneway-consistent-right",
    "footPlacement",
    stats({ meanLateralM: 0.08, meanAbsLateralM: 0.09 }),
    true,
  );
  note(
    "foot-oneway-consistent-left",
    "footPlacement",
    stats({ meanLateralM: -0.08, meanAbsLateralM: 0.09 }),
    true,
  );
  note(
    "foot-out-and-back-never-names-side",
    "footPlacement",
    stats({ meanLateralM: 0.08, meanAbsLateralM: 0.09 }),
    false,
  );
  note(
    "foot-inconsistent-magnitude-only",
    "footPlacement",
    stats({ meanLateralM: 0.02, meanAbsLateralM: 0.09 }),
    true,
  );
  note(
    "foot-exactly-at-consistency-bound",
    "footPlacement",
    stats({ meanLateralM: 0.06, meanAbsLateralM: 0.1 }),
    true,
  );
  note(
    "foot-sub-cm-generic",
    "footPlacement",
    stats({ meanLateralM: 0.002, meanAbsLateralM: 0.004 }),
    true,
  );
  note("rhythm-cites-steps-and-cadence", "rhythm", stats({ steps: 58, cadenceSpm: 96.2 }));
  note("rhythm-no-steps-generic", "rhythm", stats());
  const rich = stats({
    meanPaceMps: 1.2,
    paceDeltaMps: 0.35,
    meanLateralM: 0.1,
    meanAbsLateralM: 0.12,
    postureDriftM: -0.05,
    steps: 60,
    cadenceSpm: 100,
  });
  note("presence-composite-stays-generic", "presence", rich);
  note("confidence-composite-stays-generic", "confidence", rich);
  note("presentation-composite-stays-generic", "presentation", rich);
  note("stats-null-generic", "pace", null);
  return cases;
}

// =============================================================================
// coach-live — 2 Hz sampled timelines -> cue lists (the suite's own grid).
// =============================================================================

const LIVE_GRID = helpers.STEP;

function liveEvents(until, at) {
  const events = [];
  for (let i = 1; i * LIVE_GRID <= until + 1e-9; i++) {
    const t = i * LIVE_GRID;
    events.push({ t, sample: at(t) });
  }
  return events;
}

// runLiveEvents (the events-list replay, the generalization of run()) lives
// in test/golden-replay.ts (shared with the net).

function coachLiveCases() {
  const cases = [];
  // Op-less tapes: expect computed via the SUITE's own run() helper, and the
  // event replay is cross-checked against it (one truth, two consumers).
  // `gates` tags the case's cue-gate set ("solo" | omitted = web) — omitted
  // for web so every pre-existing case stays byte-identical.
  const tape = (name, until, at, gates) => {
    const events = liveEvents(until, at);
    const viaHelper = run(
      new LiveCoachPolicy(gatesFor(gates)),
      until,
      at,
    ).map((c) => ({
      t: c.t,
      kind: c.cue.kind,
      text: c.cue.text,
    }));
    const viaEvents = runLiveEvents(events, gatesFor(gates));
    const d = goldenDiff(viaHelper, viaEvents);
    if (d !== null) {
      throw new Error(`coach-live ${name}: event replay diverged from run(): ${d}`);
    }
    const input =
      gates === undefined
        ? { grid: LIVE_GRID, events }
        : { grid: LIVE_GRID, gates, events };
    cases.push({
      name,
      input,
      expect: { cues: viaHelper },
    });
  };

  tape("clean-walk-never-cues", 90, () => sample());
  tape("outside-walk-phase-never-cues", 60, () =>
    sample({ walking: false, paceDeltaMps: 2, absLateralM: 1, postureM: 0.3 }),
  );
  tape("all-null-channels-never-cue", 60, () =>
    sample({ paceDeltaMps: null, absLateralM: null, postureM: null }),
  );
  tape("fault-from-start-cues-at-settle-plus-hold", 20, () =>
    sample({ paceDeltaMps: 0.4 }),
  );
  tape("fault-shorter-than-hold-never-cues", 30, (t) =>
    sample({ paceDeltaMps: t >= 10 && t < 12 ? 0.5 : 0 }),
  );
  tape("clean-sample-restarts-fault-clock", 20, (t) =>
    sample({ paceDeltaMps: t >= 6 && t !== 8 ? 0.4 : 0 }),
  );
  tape("sign-flip-restarts-fault-clock", 20, (t) =>
    sample({ paceDeltaMps: t < 7 ? 0.4 : -0.4 }),
  );
  tape("channel-null-clears-fault-clock", 20, (t) =>
    sample({ absLateralM: t === 7 || t === 7.5 ? null : 0.3 }),
  );
  tape("pace-gate-strict-at-threshold", 30, () =>
    sample({ paceDeltaMps: 0.25 }),
  );
  tape("pace-gate-fires-just-above", 30, () => sample({ paceDeltaMps: 0.26 }));
  tape("pace-slow-cues-pace-slow", 30, () => sample({ paceDeltaMps: -0.3 }));
  tape("lateral-gate-strict-at-threshold", 30, () =>
    sample({ absLateralM: 0.2 }),
  );
  tape("lateral-gate-fires-just-above", 30, () =>
    sample({ absLateralM: 0.21 }),
  );
  tape("posture-gate-strict-at-threshold", 30, () =>
    sample({ postureM: 0.06 }),
  );
  tape("posture-high-cues-drop", 30, () => sample({ postureM: 0.07 }));
  tape("posture-low-cues-lift", 30, () => sample({ postureM: -0.07 }));
  tape("final-guard-clock-blocks", 30, () =>
    sample({ paceDeltaMps: 0.5, walkRemainingSec: 4 }),
  );
  tape("final-guard-clock-boundary-fires", 10, () =>
    sample({ paceDeltaMps: 0.5, walkRemainingSec: 4.1 }),
  );
  tape("final-guard-progress-blocks", 30, () =>
    sample({ paceDeltaMps: 0.5, walkRemainingSec: 20, walkProgress01: 0.9 }),
  );
  tape("final-guard-progress-boundary-fires", 10, () =>
    sample({ paceDeltaMps: 0.5, walkRemainingSec: 20, walkProgress01: 0.89 }),
  );
  // ABSENT walkRemainingSec: the emitter never omits it (it uses
  // POSITIVE_INFINITY for "no clock"), but a hand-authored or future-emitter
  // sample could — and TS reads the missing field as `undefined`, so the
  // clock half of the final guard `undefined <= FINAL_GUARD_SEC` is FALSE
  // (guard skipped) and the held pace fault cues. This pins the TS
  // absent-field semantics so a Swift port that coerces absent -> 0 (which
  // would FALSELY trip the guard, 0 <= 4) is caught. `undefined` is dropped by
  // JSON.stringify, so the emitted sample carries no walkRemainingSec key.
  tape("absent-walk-remaining-skips-clock-guard", 20, () =>
    sample({ paceDeltaMps: 0.5, walkRemainingSec: undefined }),
  );
  tape("return-leg-rusher-guarded-at-finish", 30, (t) =>
    sample({
      paceDeltaMps: 0.4,
      absLateralM: 0.3,
      walkRemainingSec: 40,
      walkProgress01: Math.min(1, t / 17),
    }),
  );
  tape("turn-suppression-out-and-back", 30, (t) =>
    sample({
      markAtSec: t >= 10 ? 10 : null,
      absLateralM: t >= 10 ? 0.3 : 0,
    }),
  );
  tape("one-way-suppresses-to-walk-end", 40, (t) =>
    sample({
      oneWayRoute: true,
      markAtSec: t >= 10 ? 10 : null,
      paceDeltaMps: 0.6,
      absLateralM: 0.4,
    }),
  );
  tape("cooldown-and-pace-over-center-priority", 25, () =>
    sample({ paceDeltaMps: 0.4, absLateralM: 0.3 }),
  );
  tape("full-priority-round-robin-then-caps", 80, () =>
    sample({ paceDeltaMps: 0.4, absLateralM: 0.3, postureM: 0.1 }),
  );
  tape("single-persistent-fault-cues-once", 90, () =>
    sample({ paceDeltaMps: 0.5 }),
  );
  tape("per-kind-caps-across-the-walk", 120, () =>
    sample({ paceDeltaMps: 0.4, absLateralM: 0.3 }),
  );
  tape("no-pace-channel-lower-priorities-still-cue", 30, () =>
    sample({ paceDeltaMps: null, absLateralM: 0.3 }),
  );
  tape("no-lateral-channel-no-center-cue", 40, () =>
    sample({ absLateralM: null, postureM: -0.1 }),
  );
  tape("no-posture-channel-no-posture-cue", 60, () =>
    sample({ postureM: null, paceDeltaMps: 0.4 }),
  );
  tape("sticky-nan-pace-fires-nothing", 60, (t) =>
    sample({ paceDeltaMps: t >= 5 ? NaN : 0 }),
  );
  tape("nan-lateral-fires-nothing", 60, () => sample({ absLateralM: NaN }));
  tape("nan-posture-fires-nothing", 60, () => sample({ postureM: NaN }));
  tape("infinity-is-equally-unmeasured", 60, () =>
    sample({
      paceDeltaMps: Infinity,
      absLateralM: Infinity,
      postureM: -Infinity,
    }),
  );
  tape("nan-sample-restarts-aging-fault", 20, (t) =>
    sample({ paceDeltaMps: t === 8 ? NaN : t >= 6 ? 0.4 : 0 }),
  );
  tape("mark-latch-suppresses-turn-pace-collapse", 18.5, (t) =>
    sample({
      markAtSec: t >= 15 ? 15 : null,
      paceDeltaMps: t >= 15 ? -0.6 : 0,
    }),
  );
  tape("lost-mark-latch-fabricates-pace-slow", 18.5, (t) =>
    sample({ markAtSec: null, paceDeltaMps: t >= 15 ? -0.6 : 0 }),
  );
  // PER-LAP re-arm (SOLO-MODE §2): the mark UPDATES mid-walk. (a) The
  // SECOND mark re-clears the fault clocks: a fault from t=18 would mature
  // at 20.5, but the lap-2 mark at 20 suppresses through 24, so the cue
  // lands at 26.5 — a first-turn-only port cues at 20.5 and goes red.
  tape("second-mark-re-clears-fault-clocks", 30, (t) =>
    sample({
      markAtSec: t >= 20 ? 20 : t >= 10 ? 10 : null,
      absLateralM: t >= 18 ? 0.3 : 0,
    }),
  );
  // (b) A fault maturing BETWEEN two suppression windows still cues (17.5,
  // after mark-1's window [10,14) and before mark-2 at 25) — a port that
  // over-suppresses everything after the first mark emits nothing and
  // goes red.
  tape("fault-between-marks-still-cues", 40, (t) =>
    sample({
      markAtSec: t >= 25 ? 25 : t >= 10 ? 10 : null,
      paceDeltaMps: t >= 15 ? 0.5 : 0,
    }),
  );

  // SOLO cue gates (coach-live.ts SOLO_CUE_GATES — the §3 re-derived
  // thresholds actually WIRED into a policy). Each case sits BETWEEN the web
  // and solo gate values, so a port that hard-codes the web gates (or the
  // solo ones) goes red in one direction or the other:
  //  - lateral 0.17: over solo 0.15 (cues) / under web 0.20 (web silent);
  //  - posture 0.065: over web 0.06 (web cues) / under solo 0.075 (silent).
  tape(
    "solo-lateral-between-gates-cues",
    30,
    () => sample({ absLateralM: 0.17 }),
    "solo",
  );
  tape(
    "solo-lateral-strict-at-threshold",
    30,
    () => sample({ absLateralM: 0.15 }),
    "solo",
  );
  tape(
    "solo-posture-between-gates-stays-silent",
    60,
    () => sample({ postureM: 0.065 }),
    "solo",
  );
  tape(
    "solo-posture-fires-just-above",
    30,
    () => sample({ postureM: -0.08 }),
    "solo",
  );
  tape(
    "solo-pace-gate-carries-unchanged",
    30,
    () => sample({ paceDeltaMps: 0.26 }),
    "solo",
  );

  // The closed-gate law needs ops interleaved (clearFaults per gated sample).
  {
    const events = [];
    for (let t = 6; t <= 8; t += LIVE_GRID) {
      events.push({ t, sample: sample({ absLateralM: 0.3 }) });
    }
    for (let t = 8.5; t < 30; t += LIVE_GRID) {
      events.push({ t, op: "clearFaults" });
    }
    for (let t = 30; t <= 40; t += LIVE_GRID) {
      events.push({ t, sample: sample({ absLateralM: 0.3 }) });
    }
    cases.push({
      name: "closed-gate-clears-needs-fresh-hold",
      input: { grid: LIVE_GRID, events },
      expect: { cues: runLiveEvents(events) },
    });
  }
  // reset() re-arms counters/cooldown for a new walk.
  {
    const events = [
      ...liveEvents(30, () => sample({ paceDeltaMps: 0.5 })),
      { t: 30, op: "reset" },
      ...liveEvents(30, () => sample({ paceDeltaMps: 0.5 })).map((e) => ({
        t: 30 + e.t,
        sample: e.sample,
      })),
    ];
    cases.push({
      name: "reset-rearms-counters-and-cooldown",
      input: { grid: LIVE_GRID, events },
      expect: { cues: runLiveEvents(events) },
    });
  }
  return cases;
}

// =============================================================================
// progress — rows + queries (incl. the session-grading rules it grades with).
// =============================================================================

// runProgressQueries lives in test/golden-replay.ts (shared with the net).

function progressCases() {
  const cases = [];
  const c = (name, rows, queries) =>
    cases.push({
      name,
      input: { rows, queries },
      expect: { results: runProgressQueries(rows, queries) },
    });

  c(
    "qualifying-set-and-sort",
    [
      row(2, 80),
      row(0, 70),
      row(1, 90, { synthetic: true }),
      row(3, null),
      row(4, NaN),
      { startedAt: "junk", overall: 66 },
      row(5, 84),
    ],
    [
      { fn: "realScoredRows" },
      { fn: "personalBest" },
      { fn: "overallSeries" },
      { fn: "latestIsPersonalBest" },
    ],
  );
  // EQUAL-startedAt tie ordering (pins the Swift .enumerated() stable-sort
  // tiebreak in realScoredRows — V8's sort is stable, Swift's is not). Two
  // real-scored rows share startedAt=61000, fed [80, 70]; a stable sort keeps
  // input order (80 then 70), an unstable one may swap them. overallSeries and
  // modeStats.last both READ that order, so all three queries redden if the
  // tiebreak is dropped. A leading earlier row anchors the ascending sort.
  c(
    "equal-startedat-keeps-input-order",
    [
      { startedAt: 61000, overall: 80, modeId: "beginner", passThreshold: 78 },
      { startedAt: 61000, overall: 70, modeId: "beginner", passThreshold: 78 },
      { startedAt: 1000, overall: 90, modeId: "beginner", passThreshold: 78 },
    ],
    [
      { fn: "realScoredRows" },
      { fn: "overallSeries" },
      { fn: "modeStats" },
    ],
  );
  // Interleaved-bucket FIRST-WALKED order (pins the modeStats manual `order`
  // array that preserves JS Map insertion order). Walk challenge (t=1000),
  // then beginner (t=61000), then challenge again (t=121000): first-seen order
  // is [challenge, beginner], reverse-alphabetical, so a regression that
  // iterates SORTED keys would yield [beginner, challenge] and redden. The
  // startedAt keys are distinct and ascending, so this isolates insertion
  // order from the sort tiebreak above.
  c(
    "interleaved-buckets-keep-first-walked-order",
    [
      { startedAt: 1000, overall: 80, modeId: "challenge", passThreshold: 82 },
      { startedAt: 61000, overall: 76, modeId: "beginner", passThreshold: 78 },
      { startedAt: 121000, overall: 84, modeId: "challenge", passThreshold: 82 },
    ],
    [{ fn: "modeStats" }],
  );
  c(
    "personal-best-tie-keeps-earliest",
    [row(0, 84), row(1, 84)],
    [{ fn: "personalBest" }, { fn: "latestIsPersonalBest" }],
  );
  c(
    "synthetic-highest-never-best",
    [row(0, 70), row(1, 99, { synthetic: true })],
    [{ fn: "personalBest" }, { fn: "latestIsPersonalBest" }],
  );
  c("rolling-average-windows", [], [
    { fn: "rollingAverage", args: { values: [1, 1, 1, 70, 72, 74, 76, 78] } },
    { fn: "rollingAverage", args: { values: [70, 80] } },
    { fn: "rollingAverage", args: { values: [81] } },
    { fn: "rollingAverage", args: { values: [] } },
  ]);
  c("trend-delta-window-rule", [], [
    { fn: "trendDelta", args: { values: [60, 60, 60, 60, 60, 70, 72, 74, 76, 78] } },
    { fn: "trendDelta", args: { values: [60, 62, 70, 72] } },
    { fn: "trendDelta", args: { values: [60, 70, 80] } },
    { fn: "trendDelta", args: { values: [60, 70] } },
    { fn: "trendDelta", args: { values: [60] } },
    { fn: "trendDelta", args: { values: [1, 2, 3], window: 0 } },
  ]);
  c(
    "series-cap-last-20",
    Array.from({ length: 25 }, (_, i) => scored(i, 60 + i)),
    [{ fn: "overallSeries" }, { fn: "progressReport" }],
  );
  c(
    "metric-trends-missing-scores-dont-vote",
    [scored(0, 70), row(1, 75), scored(2, 76), scored(3, 78)],
    [{ fn: "metricTrends" }],
  );
  c(
    "latest-best-tie-is-not-new",
    [row(0, 84), row(1, 80), row(2, 84)],
    [{ fn: "latestIsPersonalBest" }],
  );
  c(
    "newer-synthetic-row-blocks-announce",
    [row(0, 70), row(1, 84), row(2, 90, { synthetic: true })],
    [{ fn: "latestIsPersonalBest" }],
  );
  c(
    "mode-stats-grouping",
    [
      modeRow(0, "beginner", 70),
      modeRow(1, "challenge", 84, 82),
      modeRow(2, "beginner", 81),
      modeRow(3, "beginner", 76),
    ],
    [{ fn: "modeStats" }],
  );
  c(
    "mode-stats-own-bar-grading",
    [
      modeRow(0, "challenge", 79, 82),
      modeRow(1, "commercial", 76, 75),
      modeRow(2, "commercial", 76, null),
    ],
    [{ fn: "modeStats" }],
  );
  c(
    "legacy-bucket-never-mastered",
    [
      modeRow(0, null, 80, null),
      modeRow(1, null, 80, null),
      modeRow(2, "", 80, null),
      modeRow(3, null, 80, null),
      modeRow(4, null, 80, null),
    ],
    [{ fn: "modeStats" }, { fn: "masteryJustEarned", args: { modeId: "legacy" } }],
  );
  c(
    "mastery-recency-rule",
    [60, 80, 80, 60, 80].map((v, i) => modeRow(i, "beginner", v)),
    [{ fn: "modeStats" }],
  );
  c(
    "early-passes-buried-not-mastery",
    [80, 80, 60, 60, 60].map((v, i) => modeRow(i, "beginner", v)),
    [{ fn: "modeStats" }],
  );
  c(
    "mastery-just-earned-on-newest-walk",
    [80, 60, 80, 80].map((v, i) => modeRow(i, "beginner", v)),
    [
      { fn: "masteryJustEarned", args: { modeId: "beginner" } },
      { fn: "masteryJustEarned", args: { modeId: "challenge" } },
      { fn: "modeStats" },
    ],
  );
  c(
    "already-mastered-never-reannounces",
    [80, 80, 80, 80].map((v, i) => modeRow(i, "beginner", v)),
    [{ fn: "masteryJustEarned", args: { modeId: "beginner" } }],
  );
  c(
    "newer-preview-row-blocks-mastery-moment",
    [
      ...[80, 60, 80, 80].map((v, i) => modeRow(i, "beginner", v)),
      modeRow(4, "beginner", 95, 78, { synthetic: true }),
    ],
    [{ fn: "masteryJustEarned", args: { modeId: "beginner" } }],
  );
  c(
    "mastery-lost-then-reearned-announces-again",
    [80, 80, 80, 60, 60, 60, 80, 80, 80].map((v, i) => modeRow(i, "beginner", v)),
    [{ fn: "masteryJustEarned", args: { modeId: "beginner" } }],
  );
  c(
    "fewer-than-pass-count-walks-never-mastery",
    [90, 90].map((v, i) => modeRow(i, "beginner", v)),
    [
      { fn: "masteryJustEarned", args: { modeId: "beginner" } },
      { fn: "modeStats" },
    ],
  );
  c(
    "progress-report-composite",
    [scored(0, 70), scored(1, 74), row(2, 90, { synthetic: true }), scored(3, 78), scored(4, 82)],
    [{ fn: "progressReport" }],
  );
  c(
    "grading-own-bar-and-legacy-fallback",
    [
      modeRow(0, "challenge", 79, 82),
      modeRow(1, "commercial", 76, 75),
      row(2, 76),
      row(3, 74),
      row(4, 90, { synthetic: true }),
      row(5, null),
    ],
    [
      { fn: "rowPassed", args: { row: { overall: 79, passThreshold: 82 } } },
      { fn: "rowPassed", args: { row: { overall: 76, passThreshold: 75 } } },
      { fn: "rowPassed", args: { row: { overall: 76 } } },
      { fn: "rowPassed", args: { row: { overall: 74 } } },
      { fn: "rowPassed", args: { row: { overall: 75, passThreshold: NaN } } },
      { fn: "rowPassed", args: { row: { overall: null } } },
      { fn: "rowPassThreshold", args: { row: { overall: 50 } } },
      { fn: "rowPassThreshold", args: { row: { overall: 50, passThreshold: 82 } } },
      { fn: "isSyntheticRow", args: { row: { synthetic: true } } },
      { fn: "isSyntheticRow", args: { row: {} } },
      { fn: "filterHistoryRows", args: { filter: "all" } },
      { fn: "filterHistoryRows", args: { filter: "pass" } },
      { fn: "filterHistoryRows", args: { filter: "low" } },
    ],
  );
  c("trainee-scoping-rules", [], [
    { fn: "rowMatchesTrainee", args: { row: { trainee: { id: "a" } }, traineeId: null } },
    { fn: "rowMatchesTrainee", args: { row: { trainee: { id: "a" } }, traineeId: "" } },
    { fn: "rowMatchesTrainee", args: { row: { trainee: { id: "a" } }, traineeId: "a" } },
    { fn: "rowMatchesTrainee", args: { row: { trainee: { id: "a" } }, traineeId: "b" } },
    { fn: "rowMatchesTrainee", args: { row: {}, traineeId: "b" } },
    { fn: "rowMatchesTrainee", args: { row: { trainee: null }, traineeId: "b" } },
    { fn: "rowMatchesTrainee", args: { row: { trainee: { id: 7 } }, traineeId: "b" } },
  ]);
  return cases;
}

// =============================================================================
// pose-derive-world / gap-tape — frame tapes + rigid frame-invariance twins.
// =============================================================================

const YAW = (RIGID_TRANSFORM.yawDeg * Math.PI) / 180;
const COS = Math.cos(YAW);
const SIN = Math.sin(YAW);
const TR = RIGID_TRANSFORM.translate;

function rigidKeypoint(k) {
  return {
    x: COS * k.x + SIN * k.z + TR.x,
    y: k.y + TR.y,
    z: -SIN * k.x + COS * k.z + TR.z,
    score: k.score,
  };
}

function rigidTape(tape) {
  return {
    ...tape,
    name: `${tape.name}${RIGID_SUFFIX}`,
    events: tape.events.map((ev) =>
      ev.kind === "frame"
        ? {
            ...ev,
            keypoints: Object.fromEntries(
              Object.entries(ev.keypoints).map(([n, k]) => [n, rigidKeypoint(k)]),
            ),
          }
        : ev,
    ),
  };
}

// deriveExpect (checkpointed expectations) lives in test/golden-replay.ts.

function tapePair(tape, makeSession = makeRealSession) {
  const twin = rigidTape(tape);
  const rawExpect = deriveExpect(runTape(makeSession, tape));
  const twinExpect = deriveExpect(runTape(makeSession, twin));
  const d = goldenDiff(rawExpect, twinExpect);
  if (d !== null) {
    throw new Error(
      `FRAME-INVARIANCE VIOLATED (${tape.name}): a scoring channel depends on ` +
        `the sender's arbitrary world frame — ${d}`,
    );
  }
  const mk = (t, expect) => ({
    name: t.name,
    input: { idealPace: t.idealPace, durationSec: t.durationSec, events: t.events },
    expect,
  });
  return [mk(tape, rawExpect), mk(twin, twinExpect)];
}

/** ANALYTIC ANCHOR (SOLO-MODE §6.5): TS-generated vectors pin "matches the
 * web", not "is physically correct" — so where closed-form truth exists,
 * assert it BEFORE emitting (the FRAME-INVARIANCE throw pattern; expected
 * values still never hand-copied into the vectors). */
function analytic(name, detail, ok) {
  if (!ok) {
    throw new Error(
      `ANALYTIC ANCHOR VIOLATED (${name}): ${detail} — a scoring channel ` +
        `diverged from independently-derived physical truth; refusing to ` +
        `lock the wrong measurement in as spec`,
    );
  }
}

function poseDeriveWorldCases() {
  const cases = buildTapes().flatMap((tape) => tapePair(tape));
  // Physical invariant (the dt/anchor law): nan-junk is the SAME 1.1 m/s
  // walker as normal-walk plus two bail frames — junk frames must not move
  // the duration-weighted true-pace mean.
  const final = (n) => cases.find((c) => c.name === n).expect.final;
  analytic(
    "pose-derive-world",
    `nan-junk meanPaceMps ${final("nan-junk").meanPaceMps} != normal-walk ${
      final("normal-walk").meanPaceMps
    }`,
    final("nan-junk").meanPaceMps === final("normal-walk").meanPaceMps,
  );
  return cases;
}

/** The §3 SOLO producer (pose-derive.ts soloDeriveWorld) — hip-height-drift
 * M1 + signed hip-path lateral, driven through the SAME seam/driver as the
 * web family (makeSoloSession). Inputs may carry per-frame turnExcluded
 * flags (data, not rules — the Swift harness replays them). */
function soloDeriveCases() {
  const cases = buildSoloTapes().flatMap((tape) =>
    tapePair(tape, makeSoloSession),
  );
  const final = (n) => cases.find((c) => c.name === n).expect.final;
  // Closed-form anchors for the §3 channels (simulation truth, not module
  // output): the zero-sway line has NO lateral deviation and its walker
  // holds 1.0 m/s at constant height; the slouch drops the hip exactly
  // 5 cm for the second half of a 6 s walk -> time-weighted -0.025 m.
  const clean = final("solo-clean-line");
  analytic(
    "solo-derive/clean-line lateral",
    `meanLateralM ${clean.meanLateralM} / meanAbsLateralM ${clean.meanAbsLateralM} (truth: 0)`,
    clean.meanLateralM === 0 && clean.meanAbsLateralM === 0,
  );
  analytic(
    "solo-derive/clean-line pace",
    `meanPaceMps ${clean.meanPaceMps} (truth: 1.0)`,
    Math.abs(clean.meanPaceMps - 1.0) <= 0.02,
  );
  analytic(
    "solo-derive/clean-line posture",
    `postureDriftM ${clean.postureDriftM} (truth: ~0)`,
    Math.abs(clean.postureDriftM) <= 0.005,
  );
  const slouch = final("solo-slouch");
  analytic(
    "solo-derive/slouch",
    `postureDriftM ${slouch.postureDriftM} (truth: -0.025)`,
    Math.abs(slouch.postureDriftM - -0.025) <= 0.006,
  );
  return cases;
}

/** The §2 gap rule at derive level: a 2 s outage during which the walker kept
 * moving (resume 2 m ahead). resetCadence + the re-armed frame gate mean the
 * resume frame carries ZERO stats weight: no outage-spanning pace sample, no
 * phantom steps, rhythm re-warms from an empty ring. */
function gapTapeCases() {
  const HZ = 30;
  const MS = 1000 / HZ;
  const events = [];
  const frameAt = (i) => {
    const t = i * MS;
    const time = t / 1000;
    return {
      kind: "frame",
      t,
      walkTime: t / 1000 + 1 / HZ,
      keypoints: walkKeypoints({
        time,
        posX: 1.0 * time,
        posZ: 0,
        dirX: 1,
        dirZ: 0,
        stepHz: 1.8,
        bobAmp: 0.02,
        swayAmp: 0.03,
        leanAmp: 0.05,
      }),
    };
  };
  for (let i = 0; i < 3 * HZ; i++) events.push(frameAt(i)); // 0..3 s
  events.push({ kind: "gap", walkTime: 5 });
  for (let i = 5 * HZ; i < 8 * HZ; i++) events.push(frameAt(i)); // 5..8 s
  const tape = { name: "gap-jump", idealPace: 0.95, durationSec: 8, events };
  const cases = tapePair(tape);
  // Simulation truth: a 1.0 m/s walker measured over 6 s of frames, with the
  // outage carrying ZERO weight (the §2 gap rule) — the mean pace must sit
  // at the walker's speed, the step count at stepHz * measured seconds, and
  // cadence must be the closed-form rollup of its own steps over the
  // 8 s walk duration.
  const final = cases[0].expect.final;
  analytic(
    "gap-tape pace",
    `meanPaceMps ${final.meanPaceMps} (truth: 1.0)`,
    Math.abs(final.meanPaceMps - 1.0) <= 0.03,
  );
  analytic(
    "gap-tape steps",
    `steps ${final.steps} (truth: ~${1.8 * 6})`,
    Math.abs(final.steps - 1.8 * 6) <= 2,
  );
  analytic(
    "gap-tape cadence",
    `cadenceSpm ${final.cadenceSpm} vs steps/(8/60)`,
    final.cadenceSpm === Math.round((final.steps / (8 / 60)) * 10) / 10,
  );
  return cases;
}

// =============================================================================
// walk-replay — the whole Solo loop in one vector, at 30 AND 60 Hz.
// =============================================================================

// Fixture duration is FIXED: this tape's speed/lateral profile, its scripted
// cue story, and the pace/cadence anchors are all authored for a 45 s walk.
// Override walkSeconds ON THE MODE OBJECT (not just the local seconds) so EVERY
// internal read — cue timing, walk timeout — sees 45, decoupling the vector from
// the live mode's walkSeconds (the shareable demo cut it to 20 s).
const REPLAY_MODE = { ...MODES.find((m) => m.id === "commercial"), walkSeconds: 45 };
const REPLAY_SECONDS = REPLAY_MODE.walkSeconds; // 45 (pinned above)
// The Solo walking line (multi-lap out-and-back). 9 m, not the 6 m warning
// boundary: under the §2 PER-LAP turn suppression a 6 m line suppresses
// every mid-walk cue (each ~6 s lap re-clears the fault clocks — exactly
// why SOLO-MODE §2 warns on lines under ~6 m), which would leave the
// walk-replay vector with an empty cue timeline. 9 m laps leave room for
// the scripted faults to mature BETWEEN suppression windows, so the vector
// pins the suppression/firing interplay, not just suppression.
const LINE_LENGTH_M = 9;
// PUBLISH_INTERVAL / COACH_SAMPLE_SEC / ramp+blend are IMPORTED from the real
// modules above (metrics-wiring.ts, coach-live.ts) — never replicated (#12).

/** Deliberate coaching material: rush (pace-fast), drag (pace-slow), rush
 * again (cap/no-repeat exercise); ideal 0.95 m/s otherwise. */
function replaySpeedAt(t) {
  if (t >= 8 && t < 14) return 1.45;
  if (t >= 22 && t < 28) return 0.5;
  if (t >= 31 && t < 37) return 1.45;
  return 0.95;
}

/** Frames + the synthesized Solo cue context (SOLO-MODE §2/A4) for one rate. */
function buildReplayWalk(hz) {
  const n = Math.round(REPLAY_SECONDS * hz);
  const dtMs = 1000 / hz;
  const delta = 1 / hz;
  const frames = [];
  let pos = 0;
  let dir = 1;
  let walkTime = 0;
  let markAtSec = null;
  const markPerFrame = [];
  for (let i = 0; i < n; i++) {
    walkTime += delta;
    if (i > 0) {
      const time = (i - 1) * (dtMs / 1000);
      pos += dir * replaySpeedAt(time) * delta;
      // Per-lap turn detection (SOLO-MODE §2): EVERY travel-heading
      // reversal re-arms the mark — far end AND near end (the over-trigger
      // bias, see the header). A single-latch model only worked for lap 1
      // and pinned the wrong suppression timeline as spec.
      if (pos >= LINE_LENGTH_M) {
        pos = 2 * LINE_LENGTH_M - pos;
        markAtSec = walkTime;
        dir = -1;
      } else if (pos <= 0) {
        pos = -pos;
        markAtSec = walkTime;
        dir = 1;
      }
    }
    const t = i * dtMs;
    frames.push({
      t,
      walkTime,
      keypoints: walkKeypoints({
        time: t / 1000,
        posX: pos,
        posZ: 0,
        dirX: dir,
        dirZ: 0,
        stepHz: 1.8,
        bobAmp: 0.02,
        swayAmp: 0.03,
        leanAmp: 0.05,
      }),
    });
    markPerFrame.push(markAtSec);
  }
  return { frames, markPerFrame };
}

// runReplay (deriveWorld + walk-stats through the documented metrics/
// coach-live/show seams) lives in test/golden-replay.ts (shared with the
// net, which re-drives it from the vector's own emitted cueContext).

function replayCase(hz) {
  const { frames, markPerFrame } = buildReplayWalk(hz);
  const twinFrames = frames.map((f) => ({
    ...f,
    keypoints: Object.fromEntries(
      Object.entries(f.keypoints).map(([n, k]) => [n, rigidKeypoint(k)]),
    ),
  }));
  const marks = (i) => markPerFrame[i];
  const raw = runReplay(hz, frames, REPLAY_MODE, REPLAY_SECONDS, marks);
  const twin = runReplay(hz, twinFrames, REPLAY_MODE, REPLAY_SECONDS, marks);
  const { cueContext, ...rawExpect } = raw;
  const { cueContext: _tc, ...twinExpect } = twin;
  const d = goldenDiff(rawExpect, twinExpect);
  if (d !== null) {
    throw new Error(
      `FRAME-INVARIANCE VIOLATED (walk-replay-${hz}hz): ${d} — a channel ` +
        `depends on the sender's arbitrary world frame`,
    );
  }
  const inputBase = {
    modeId: REPLAY_MODE.id,
    idealPace: REPLAY_MODE.idealPace,
    passThreshold: REPLAY_MODE.passThreshold,
    weights: REPLAY_MODE.weights,
    walkSeconds: REPLAY_SECONDS,
    hz,
    durationSec: REPLAY_SECONDS,
    cueContext,
  };
  return [
    { name: `walk-replay-${hz}hz`, input: { ...inputBase, frames }, expect: rawExpect },
    {
      name: `walk-replay-${hz}hz${RIGID_SUFFIX}`,
      input: { ...inputBase, frames: twinFrames },
      expect: twinExpect,
    },
  ];
}

function walkReplayCases() {
  const cases30 = replayCase(30);
  const cases60 = replayCase(60);
  // Rate-independence sanity (the reason the 60 Hz vector exists): the
  // dt-based EMA/stats forms must land in the same place from either rate.
  const s30 = cases30[0].expect.finalStats;
  const s60 = cases60[0].expect.finalStats;
  if (Math.abs(s30.meanPaceMps - s60.meanPaceMps) > 0.05) {
    throw new Error(
      `RATE-DEPENDENCE: meanPaceMps 30 Hz ${s30.meanPaceMps} vs 60 Hz ${s60.meanPaceMps}`,
    );
  }
  if (
    s30.cadenceSpm === null ||
    s60.cadenceSpm === null ||
    Math.abs(s30.cadenceSpm - s60.cadenceSpm) > 6
  ) {
    throw new Error(
      `RATE-DEPENDENCE: cadenceSpm 30 Hz ${s30.cadenceSpm} vs 60 Hz ${s60.cadenceSpm}`,
    );
  }
  // Simulation truth: the time-weighted mean of the scripted speed profile
  // (numerically integrated from replaySpeedAt itself, not hand-summed) and
  // the scripted gait cadence (stepHz 1.8 -> 108 spm).
  let speedIntegral = 0;
  const STEPS = 45000;
  for (let k = 0; k < STEPS; k++) {
    speedIntegral += replaySpeedAt((k / STEPS) * REPLAY_SECONDS);
  }
  const trueMean = speedIntegral / STEPS;
  for (const [hz, s] of [
    [30, s30],
    [60, s60],
  ]) {
    analytic(
      `walk-replay-${hz}hz pace`,
      `meanPaceMps ${s.meanPaceMps} (truth: ${trueMean.toFixed(4)})`,
      Math.abs(s.meanPaceMps - trueMean) <= 0.03,
    );
    analytic(
      `walk-replay-${hz}hz cadence`,
      `cadenceSpm ${s.cadenceSpm} (truth: 108)`,
      Math.abs(s.cadenceSpm - 108) <= 3,
    );
  }
  return [...cases30, ...cases60];
}

// =============================================================================
// walk-replay-solo — the SOLO ENGINE loop in one vector, at 30 AND 60 Hz:
// soloDeriveWorld (§3 channels + SOLO_TURN_EXCLUDE_SEC windows), the §2 gap
// rule (SOLO_GAP_SEC → resetCadence + re-seed), frame-driven real-dt ticks,
// and the SOLO-gated 2 Hz policy (SOLO_CUE_GATES). The Swift consumption
// rule is different from walk-replay ON PURPOSE: the XCTest drives the
// PRODUCTION SoloWalkCore with these frames + marks (not a test-local loop
// mirror), so the engine assembly itself is under the drift lock. Marks are
// GROUND TRUTH from the synthetic walker (the tape knows its reversals) —
// the turn DETECTOR is separately unit-tested, ships flagged, and gets its
// own vectors once the heuristic is fixed on real walks (SOLO-MODE §8).
// COPY NOTE: cue/report strings are emitted with the WEB tables; the Swift
// runner renders .solo copy and applies the vector-locked copy-variants
// substitution to the EXPECTED strings before exact comparison (the
// documented coach-copy.ts consumption rule).
// =============================================================================

// Fixture duration is FIXED: the solo tape's scripted losses (the 1.2 s outage,
// the two slouch ramps, the warm-up) and the ~96.5 spm cadence anchor are all
// authored for a 60 s walk. Override walkSeconds ON THE MODE OBJECT so every
// internal read sees 60, decoupling the vector from the live mode's walkSeconds
// (the shareable demo cut it to 20 s).
const SOLO_REPLAY_MODE = { ...MODES.find((m) => m.id === "beginner"), walkSeconds: 60 };
const SOLO_REPLAY_SECONDS = SOLO_REPLAY_MODE.walkSeconds; // 60 (pinned above)
// 12 m: long enough (laps ~14 s at the 0.85 ideal) that the scripted faults
// mature BETWEEN the per-lap turn-suppression windows — the same reasoning
// that sized walk-replay's 9 m line, with more room because THREE fault
// channels must each find a clear window here.
const SOLO_LINE_LENGTH_M = 12;
// The §2 outage: frames DROPPED for 1.2 s (twice SOLO_GAP_SEC) mid-leg,
// away from every reversal (~39.5 and ~53.7) and every scripted fault.
const SOLO_GAP_START = 45;
const SOLO_GAP_END = 46.2;

/** Pace script: one rush (pace-fast material); ideal 0.85 otherwise. The
 * turn reversals are instantaneous in the synthetic walker (position
 * reflects), so pace never legitimately collapses — pace-slow stays
 * unexercised here and is pinned by the coach-live event tapes instead. */
function soloSpeedAt(t) {
  if (t >= 7 && t < 13) return 1.25;
  return 0.85;
}

/** Lateral fault (m, perpendicular to the line): a sustained +-0.42 m WEAVE
 * at 0.25 Hz over [15, 25] — 2.5 cycles, ending on zero. The weave is the
 * fault this channel can honestly sustain: a slow parallel drift is
 * absorbed by the heading EMA (your travel line follows you) and a sharp
 * side-step is excluded by the stability gate — both discovered by this
 * family's own anchors (see SOLO_LATERAL_CUE_SMOOTH_RATE). Sizing: the
 * heading absorbs ~28% at 0.25 Hz, so the raw offset reads ~+-0.30, the
 * smoothed cue input climbs past the 0.15 gate ~4-5 s in and plateaus
 * ~0.19-0.21, and the direction swing stays ~38 deg — inside the 0.9
 * heading-stability bar (the occasional blip at a swing extreme is covered
 * by the sampler's SOLO_GAP_SEC dark-hold). Starts at 15 — inside mark-1's
 * cue-suppression window, which holds fault CLOCKS clear but lets the
 * smoothed input climb, exactly like a real walker starting to wander
 * during the turn. */
function soloLateralAt(t) {
  if (t < 15 || t > 25) return 0;
  return 0.42 * Math.sin(2 * Math.PI * 0.25 * (t - 15));
}

/** Hip-height slouch (m, subtracted from hips + shoulders; ankles stay on
 * the floor): 0.12 m clears SOLO_POSTURE_CUE_M (0.075) + the ±0.02 gait bob
 * riding the raw signed tap at every 2 Hz sample phase — a 0.09 m slouch
 * aliases against the bob and randomly restarts the fault clock. */
function soloSlouchAt(t) {
  if (t < 30) return 0;
  if (t < 31) return 0.12 * (t - 30);
  if (t < 38) return 0.12;
  if (t < 39) return 0.12 * (1 - (t - 38));
  return 0;
}

const SOLO_SLOUCH_JOINTS = [
  "leftHip",
  "rightHip",
  "leftShoulder",
  "rightShoulder",
];

/** Frames (with the §2 gap window REMOVED) + sparse ground-truth marks in
 * the FILTERED frame index space. */
function buildSoloReplayWalk(hz) {
  const n = Math.round(SOLO_REPLAY_SECONDS * hz);
  const dtMs = 1000 / hz;
  const delta = 1 / hz;
  const all = [];
  let pos = 0;
  let dir = 1;
  let walkTime = 0;
  let markAtSec = null;
  for (let i = 0; i < n; i++) {
    walkTime += delta;
    if (i > 0) {
      const time = (i - 1) * delta;
      pos += dir * soloSpeedAt(time) * delta;
      // Per-lap ground truth: EVERY reversal marks — far end AND near end
      // (the §2 both-ends decision, same model as walk-replay).
      if (pos >= SOLO_LINE_LENGTH_M) {
        pos = 2 * SOLO_LINE_LENGTH_M - pos;
        markAtSec = walkTime;
        dir = -1;
      } else if (pos <= 0) {
        pos = -pos;
        markAtSec = walkTime;
        dir = 1;
      }
    }
    const t = i * dtMs;
    const time = t / 1000;
    const kp = walkKeypoints({
      time,
      posX: pos,
      posZ: soloLateralAt(time),
      dirX: dir,
      dirZ: 0,
      stepHz: 1.8,
      bobAmp: 0.02,
      swayAmp: 0.03,
      leanAmp: 0.05,
    });
    const drop = soloSlouchAt(time);
    if (drop > 0) {
      for (const name of SOLO_SLOUCH_JOINTS) {
        const k = kp[name];
        kp[name] = { ...k, y: k.y - drop };
      }
    }
    all.push({ t, walkTime, keypoints: kp, markSoFar: markAtSec });
  }
  // Drop the outage window; re-index the sparse marks against the frames
  // that remain (a mark never lands inside the gap by construction).
  const frames = [];
  const marks = [];
  let lastMark = null;
  for (const f of all) {
    const time = f.t / 1000;
    if (time >= SOLO_GAP_START && time < SOLO_GAP_END) continue;
    if (f.markSoFar !== null && f.markSoFar !== lastMark) {
      marks.push({ frameIdx: frames.length, atSec: f.markSoFar });
      lastMark = f.markSoFar;
    }
    frames.push({ t: f.t, walkTime: f.walkTime, keypoints: f.keypoints });
  }
  return { frames, marks };
}

function soloReplayCase(hz) {
  const { frames, marks } = buildSoloReplayWalk(hz);
  const twinFrames = frames.map((f) => ({
    ...f,
    keypoints: Object.fromEntries(
      Object.entries(f.keypoints).map(([n, k]) => [n, rigidKeypoint(k)]),
    ),
  }));
  const modeParams = {
    idealPace: SOLO_REPLAY_MODE.idealPace,
    passThreshold: SOLO_REPLAY_MODE.passThreshold,
    weights: SOLO_REPLAY_MODE.weights,
    walkSeconds: SOLO_REPLAY_SECONDS,
  };
  const raw = runSoloReplay(frames, modeParams, marks);
  const twin = runSoloReplay(twinFrames, modeParams, marks);
  const { cueContext, ...rawExpect } = raw;
  const { cueContext: _tc, ...twinExpect } = twin;
  const d = goldenDiff(rawExpect, twinExpect);
  if (d !== null) {
    throw new Error(
      `FRAME-INVARIANCE VIOLATED (walk-replay-solo-${hz}hz): ${d} — a ` +
        `channel depends on the sender's arbitrary world frame`,
    );
  }
  const inputBase = {
    modeId: SOLO_REPLAY_MODE.id,
    idealPace: SOLO_REPLAY_MODE.idealPace,
    passThreshold: SOLO_REPLAY_MODE.passThreshold,
    weights: SOLO_REPLAY_MODE.weights,
    walkSeconds: SOLO_REPLAY_SECONDS,
    hz,
    durationSec: SOLO_REPLAY_SECONDS,
    marks,
    cueContext,
  };
  return [
    {
      name: `walk-replay-solo-${hz}hz`,
      input: { ...inputBase, frames },
      expect: rawExpect,
    },
    {
      name: `walk-replay-solo-${hz}hz${RIGID_SUFFIX}`,
      input: { ...inputBase, frames: twinFrames },
      expect: twinExpect,
    },
  ];
}

function walkReplaySoloCases() {
  const cases30 = soloReplayCase(30);
  const cases60 = soloReplayCase(60);
  const s30 = cases30[0].expect.finalStats;
  const s60 = cases60[0].expect.finalStats;
  // Rate independence must survive the NEW rules too (gap coalescing,
  // marks, turn windows) — the reason the 30 Hz emission exists.
  if (Math.abs(s30.meanPaceMps - s60.meanPaceMps) > 0.05) {
    throw new Error(
      `RATE-DEPENDENCE (solo): meanPaceMps 30 Hz ${s30.meanPaceMps} vs ` +
        `60 Hz ${s60.meanPaceMps}`,
    );
  }
  if (
    s30.cadenceSpm === null ||
    s60.cadenceSpm === null ||
    Math.abs(s30.cadenceSpm - s60.cadenceSpm) > 6
  ) {
    throw new Error(
      `RATE-DEPENDENCE (solo): cadenceSpm 30 Hz ${s30.cadenceSpm} vs ` +
        `60 Hz ${s60.cadenceSpm}`,
    );
  }
  // Simulation truth: the scripted speed profile's time-weighted mean —
  // including the weave's own lateral velocity, which is real walked speed
  // (hypot of along-line and perpendicular components) — the scripted
  // 1.8 Hz gait (108 spm), the SCRIPTED cue story (one fault per channel,
  // each sized to its SOLO gate), the single scripted outage, and the
  // slouch's signed direction in the record.
  let speedIntegral = 0;
  const STEPS = 60000;
  const eps = SOLO_REPLAY_SECONDS / STEPS;
  for (let k = 0; k < STEPS; k++) {
    const tk = (k / STEPS) * SOLO_REPLAY_SECONDS;
    const vLat = (soloLateralAt(tk + eps) - soloLateralAt(tk)) / eps;
    speedIntegral += Math.hypot(soloSpeedAt(tk), vLat);
  }
  const trueMean = speedIntegral / STEPS;
  for (const [hz, cases, s] of [
    [30, cases30, s30],
    [60, cases60, s60],
  ]) {
    analytic(
      `walk-replay-solo-${hz}hz pace`,
      `meanPaceMps ${s.meanPaceMps} (truth: ${trueMean.toFixed(4)})`,
      Math.abs(s.meanPaceMps - trueMean) <= 0.03,
    );
    // Cadence truth for THIS tape is 108 spm (1.8 Hz gait) MINUS the
    // scripted perturbations' derivable cost: the 1.2 s outage + post-gap
    // bob re-seed (~4 steps), the two 1 s slouch ramps dragging the bob
    // baseline (dev pinned one-sided ~1.8 s each, ~6 steps), and the
    // walk-start crossing warm-up (~1.5) — ≈ 96.5 spm observed. A detector
    // regression shows up as a step-function move out of [90, 103], not as
    // this scripted, explainable deficit.
    analytic(
      `walk-replay-solo-${hz}hz cadence`,
      `cadenceSpm ${s.cadenceSpm} (truth: ~96.5 after scripted losses)`,
      s.cadenceSpm >= 90 && s.cadenceSpm <= 103,
    );
    const kinds = cases[0].expect.cues.map((c) => c.kind);
    analytic(
      `walk-replay-solo-${hz}hz cue story`,
      `cues [${kinds.join(", ")}] (truth: pace-fast, center-up, posture-lift)`,
      kinds.length === 3 &&
        kinds[0] === "pace-fast" &&
        kinds[1] === "center-up" &&
        kinds[2] === "posture-lift",
    );
    analytic(
      `walk-replay-solo-${hz}hz gap rule`,
      `gapResets ${cases[0].expect.gapResets} (truth: 1)`,
      cases[0].expect.gapResets === 1,
    );
    analytic(
      `walk-replay-solo-${hz}hz slouch sign`,
      `postureDriftM ${s.postureDriftM} (truth: negative, slouch-dominated)`,
      typeof s.postureDriftM === "number" && s.postureDriftM < -0.005,
    );
    analytic(
      `walk-replay-solo-${hz}hz lateral magnitude`,
      `meanAbsLateralM ${s.meanAbsLateralM} (truth: sway + one excursion)`,
      typeof s.meanAbsLateralM === "number" &&
        s.meanAbsLateralM > 0.01 &&
        s.meanAbsLateralM < 0.08,
    );
  }
  return [...cases30, ...cases60];
}

// =============================================================================
// coach-tables — the copy/earcon tables + solo cue thresholds, emitted whole
// (SOLO-MODE A4: the Swift copy tables must not be able to fork from TS;
// METRIC_EXPLAIN/CLEAN_WALK_CUE surface only as DOM tooltips/summary copy,
// so no behavioral vector can ever pin them — only table emission can).
// =============================================================================

function coachTablesCases() {
  return [
    {
      name: "copy-and-earcon-tables",
      input: {},
      expect: {
        METRIC_EXPLAIN,
        METRIC_COACH,
        CLEAN_WALK_CUE,
        LIVE_CUE_TEXT,
        COACH_EARCONS,
        COACH_EARCON_LEVEL,
      },
    },
    {
      name: "solo-cue-thresholds",
      input: {},
      expect: {
        PACE_DELTA_CUE_MPS, // carries unchanged into Solo
        SOLO_LATERAL_CUE_M,
        SOLO_POSTURE_CUE_M,
        SOLO_POSTURE_SLOPE,
        SOLO_HEADING_STABLE_MIN,
        SOLO_LATERAL_BASELINE_SEC,
        SOLO_GAP_SEC,
        SOLO_TURN_EXCLUDE_SEC,
        SOLO_LATERAL_CUE_SMOOTH_RATE,
      },
    },
  ];
}

// =============================================================================
// copy-variants — the §5 Solo copy-variant table (part of the golden spec):
// web column built from the REAL tables/builders, solo column from
// src/coach-copy.ts. Swift applies the substitution before exact comparison.
// =============================================================================

function copyVariantCases() {
  return SOLO_COPY_VARIANTS.map((v) => ({
    name: `${v.surface}:${v.key}`,
    input: { surface: v.surface, key: v.key },
    expect: { web: v.web, solo: v.solo },
  }));
}

// =============================================================================
// modes — the constants table the port needs verbatim.
// =============================================================================

function modesCases() {
  return MODES.map((m) => ({
    name: `mode-${m.id}`,
    input: { id: m.id },
    expect: {
      id: m.id,
      idealPace: m.idealPace,
      passThreshold: m.passThreshold,
      weights: m.weights,
      walkSeconds: m.walkSeconds,
    },
  }));
}

// =============================================================================
// Wave 1 families — fit-core / head-carriage / hold-stats / repeatability.
// Query-style cases (the progress pattern): the input carries DATA ONLY
// (tapes, frames, op lists, literal wire rows, scalar args); expected values
// are ALWAYS the live modules' output over that data via the SHARED runners
// in test/golden-replay.ts (the same code the replay net executes). Seeded
// helper tapes are SERIALIZED into the input — consumers replay data, not
// rules. The §D TWIN-PITCH quaternion set below is emitted into BOTH the
// head-carriage and hold-stats families with emit-time analytic anchors that
// the two modules' pitch extraction agrees exactly.
// =============================================================================

const DEG2RAD = Math.PI / 180;

// =============================================================================
// fit-core — the FIT session capture core + the body-baseline derivation.
// =============================================================================

function fitCoreCases() {
  const cases = [];
  const c = (name, queries) => {
    const results = runFitQueries(queries);
    cases.push({ name, input: { queries }, expect: { results } });
    return results;
  };
  const detector = (name, samples) =>
    c(name, [{ fn: "detector", args: { samples } }])[0];
  const walk = (name, spanM, samples) =>
    c(name, [{ fn: "walk", args: { spanM, samples } }])[0];
  const machine = (name, cfg, events) =>
    c(name, [{ fn: "machine", args: { cfg, events } }])[0];

  // --- the still-stand detector ---------------------------------------------
  const quiet = detector(
    "detector-quiet-stand-certifies",
    fitStillTape({ durationSec: 8 }),
  );
  analytic(
    "fit-core/quiet-stand",
    `doneAtSec ${quiet.doneAtSec} (truth: ~6.0 = 1 s window fill + the 5.0 s hold law)`,
    quiet.doneAtSec !== null && quiet.doneAtSec >= 5.9 && quiet.doneAtSec <= 6.15,
  );
  analytic(
    "fit-core/quiet-stand result",
    `standHeightM ${quiet.result?.standHeightM} (truth 1.62), neutralPitchRad ${quiet.result?.neutralPitchRad} (truth -0.06)`,
    quiet.result !== null &&
      Math.abs(quiet.result.standHeightM - 1.62) <= 0.01 &&
      Math.abs(quiet.result.neutralPitchRad - -0.06) <= 1e-9,
  );

  const sway3 = detector(
    "detector-3cm-sway-never-certifies",
    fitSwayTape(0.03, { durationSec: 12 }),
  );
  analytic(
    "fit-core/3cm-sway",
    `holdSec ${sway3.holdSec}, windowStd3D ${sway3.windowStd3D} (truth: 0.03/sqrt(2) = 0.0212 >> the 0.012 gate)`,
    sway3.doneAtSec === null &&
      sway3.holdSec === 0 &&
      Math.abs(sway3.windowStd3D - 0.03 / Math.SQRT2) <= 0.002,
  );
  // The gate BOUNDARY (sway std lands on FIT_STILL_STD_M itself): whatever
  // side the live gate takes at its own edge is recorded — the Swift port
  // must land on the same side (identical fold order, bit-identical sums).
  detector(
    "detector-sway-at-gate-boundary",
    fitSwayTape(FIT_STILL_STD_M * Math.SQRT2, { durationSec: 12 }),
  );

  const spike = detector(
    "detector-step-spike-restarts-hold",
    fitSpikeTape({ durationSec: 12, atSec: 3, seed: 11 }),
  );
  const spikeCtl = detector(
    "detector-spike-control-certifies-early",
    fitStillTape({ durationSec: 12, seed: 11 }),
  );
  analytic(
    "fit-core/spike-restart",
    `spiked doneAt ${spike.doneAtSec} vs control ${spikeCtl.doneAtSec} (truth: the hold restarts after the spike)`,
    spikeCtl.doneAtSec !== null &&
      spikeCtl.doneAtSec < 6.2 &&
      spike.doneAtSec !== null &&
      spike.doneAtSec > 8.5,
  );

  const junkDt = detector("detector-junk-dt-samples-dropped", [
    ...fitStillTape({ durationSec: 3.5, seed: 9 }),
    { dt: 0, x: 0, y: 1.62, z: 0, pitch: 0 },
    { dt: -1, x: 0, y: 1.62, z: 0, pitch: 0 },
    { dt: NaN, x: 0, y: 1.62, z: 0, pitch: 0 },
  ]);
  analytic(
    "fit-core/junk-dt-dropped",
    `holdSec ${junkDt.holdSec} (truth: > 1 — dropped samples neither zero nor advance the hold)`,
    junkDt.holdSec > 1,
  );
  const gapped = detector("detector-gap-reseeds-window", [
    ...fitStillTape({ durationSec: 3.5, seed: 9 }),
    { dt: 1.0, x: 0, y: 1.62, z: 0, pitch: 0 },
  ]);
  analytic(
    "fit-core/gap-rule",
    `holdSec ${gapped.holdSec}, windowFull ${gapped.windowFull} (truth: a > FIT_GAP_SEC outage re-seeds everything)`,
    gapped.holdSec === 0 && gapped.windowFull === false,
  );

  // Decimation invariance: the SAME continuous motion (4 s over-gate sway,
  // then QUIET still) sampled at 72 vs 120 Hz must certify within one
  // decimated 30 Hz sample (+ one input frame). The still phase carries a
  // deterministic 0.5 mm micro-sway (std ~0.35 mm, 34x under the 12 mm
  // gate): a real tracked head is never bit-frozen, and the frozen-pose
  // guard now DROPS exact repeats as dark tracking.
  const decTape = (hz) => {
    const dt = 1 / hz;
    const n = Math.round(12 * hz);
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = i * dt;
      out.push({
        dt,
        x:
          t < 4
            ? 0.05 * Math.sin(2 * Math.PI * t)
            : 0.0005 * Math.sin(2 * Math.PI * t),
        y: 1.62,
        z: 0,
        pitch: -0.05,
      });
    }
    return out;
  };
  const d72 = detector("detector-decimation-72hz", decTape(72));
  const d120 = detector("detector-decimation-120hz", decTape(120));
  analytic(
    "fit-core/decimation-invariance",
    `doneAt 72 Hz ${d72.doneAtSec} vs 120 Hz ${d120.doneAtSec}`,
    d72.doneAtSec !== null &&
      d120.doneAtSec !== null &&
      Math.abs(d72.doneAtSec - d120.doneAtSec) <= 1 / 30 + 1 / 72 + 1e-9,
  );

  // Frozen-pose guard (the HoldAccumulator law mirrored): a bit-identical
  // (x, y, z, pitch) stream is frozen tracking, not stillness — variance of
  // literally zero must never certify a stand the sensor never measured.
  const frozenStand = detector(
    "detector-frozen-tracking-never-certifies",
    Array.from({ length: 12 * 90 }, () => ({
      dt: 1 / 90,
      x: 0.2,
      y: 1.3, // e.g. frozen mid-crouch: certifying would save a 1.3 m "body"
      z: -0.5,
      pitch: -0.4,
    })),
  );
  analytic(
    "fit-core/frozen-stand-guard",
    `holdSec ${frozenStand.holdSec}, windowFull ${frozenStand.windowFull}, done ${frozenStand.done} (truth: only the FIRST sample is evidence — the stand stage times out instead of certifying frozen tracking)`,
    frozenStand.holdSec === 0 &&
      frozenStand.windowFull === false &&
      frozenStand.done === false,
  );

  // --- the relaxed-walk capture ---------------------------------------------
  const cleanWalk = walk(
    "walk-clean-6m25-pace-cadence-bob",
    6.25,
    fitWalkTape({ spanM: 6.25 }),
  );
  analytic(
    "fit-core/walk-bob-round-trip",
    `bobAmpM ${cleanWalk?.bobAmpM} (truth: the scripted A = 0.010 within 5% — MAD * pi/2)`,
    cleanWalk !== null && cleanWalk.bobAmpM > 0.0095 && cleanWalk.bobAmpM < 0.0105,
  );
  analytic(
    "fit-core/walk-pace-cadence",
    `paceMps ${cleanWalk?.paceMps} (truth 1.0), cadenceSpm ${cleanWalk?.cadenceSpm} (truth 108 = 60 * 1.8)`,
    Math.abs(cleanWalk.paceMps - 1.0) <= 0.01 &&
      cleanWalk.cadenceSpm !== null &&
      cleanWalk.cadenceSpm > 103 &&
      cleanWalk.cadenceSpm < 113,
  );

  const tooShort = walk(
    "walk-too-little-steady-time-null",
    6.25,
    fitWalkTape({ spanM: 6.25 }).filter((s) => s.along < 2.5),
  );
  const jog = walk(
    "walk-jog-pace-rejected",
    6.25,
    fitWalkTape({ spanM: 6.25, paceMps: 2.5 }),
  );
  const glide = walk(
    "walk-glide-bob-rejected",
    6.25,
    fitWalkTape({ spanM: 6.25, bobAmpM: 0.002 }),
  );
  const bounce = walk(
    "walk-bounce-bob-rejected",
    6.25,
    fitWalkTape({ spanM: 6.25, bobAmpM: 0.08 }),
  );
  analytic(
    "fit-core/walk-acceptance-atomic",
    `steady-short ${tooShort}, jog ${jog}, glide ${glide}, bounce ${bounce} (truth: all null — no partial body)`,
    tooShort === null && jog === null && glide === null && bounce === null,
  );
  const shortDeck = walk(
    "walk-short-legal-deck-cadence-nulls",
    2.25,
    fitWalkTape({ spanM: 2.25, paceMps: 1.2 }),
  );
  analytic(
    "fit-core/§H-3m-deck-accumulator",
    `paceMps ${shortDeck?.paceMps}, cadenceSpm ${shortDeck?.cadenceSpm} (truth: 1.42 s of band >= the corrected 0.545 s floor -> PASSES; cadence honestly null)`,
    shortDeck !== null &&
      Math.abs(shortDeck.paceMps - 1.2) <= 0.05 &&
      shortDeck.cadenceSpm === null,
  );

  const bands = c("steady-band-adjudication-h-table", [
    { fn: "steadyBand", args: { spanM: 2.25 } },
    { fn: "steadyBand", args: { spanM: 6.25 } },
    { fn: "steadyBand", args: { spanM: 12 } },
  ]);
  analytic(
    "fit-core/§H-band-arithmetic",
    `margins [${bands.map((b) => b.marginM)}], floors [${bands.map((b) => b.minSteadySec)}]`,
    // Floors derive over the MEASURABLE span (fitMinSteadySec: usable =
    // span - margin - max(margin, FIT_MARK_RADIUS_M 0.8)) — 3 m deck:
    // usable 2.25 - 0.27 - 0.8 = 1.18 -> 0.6*1.18/1.3.
    Math.abs(bands[0].marginM - 0.27) <= 1e-9 &&
      Math.abs(bands[0].minSteadySec - (0.6 * (2.25 - 0.27 - 0.8)) / 1.3) <=
        1e-9 &&
      Math.abs(bands[1].marginM - 0.75) <= 1e-9 &&
      bands[1].minSteadySec === 2 &&
      bands[2].marginM === 1 &&
      bands[2].minSteadySec === 2,
  );

  // --- the guided flow machine (frames are DATA, authored by the seeded
  // builders exactly the way the suite's runStill/runWalk drive the machine) -
  const stillFrames = (sec, opts = {}) => {
    const {
      hz = 90,
      x = 0,
      y = 1.62,
      z = 0,
      along = 0.3,
      lateral = 0.1,
      pitch = -0.06,
      seed = 3,
      noiseStdM = 0.003,
    } = opts;
    const rand = mulberry32(seed);
    const q = pitchQuat(pitch);
    const dt = 1 / hz;
    const n = Math.round(sec * hz);
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({
        dt,
        x: x + noiseOf(rand, noiseStdM),
        y: y + noiseOf(rand, noiseStdM),
        z: z + noiseOf(rand, noiseStdM),
        qx: q.qx,
        qy: q.qy,
        qz: q.qz,
        qw: q.qw,
        along,
        lateral,
      });
    }
    return out;
  };
  const walkFrames = (startA, spanM, opts = {}) =>
    fitWalkTape({ spanM, ...opts }).map((s) => ({
      dt: s.dt,
      x: s.x,
      y: s.y,
      z: s.z,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
      along: startA + s.along,
      lateral: 0,
    }));
  // 7 m default deck: poseA = 7 - 0.6, startA = 0.15 (span 6.25, §H).
  const GEOM7 = { startA: 0.15, poseA: 6.4, traineeId: "t1", nowMs: 1_700_000_000_000 };
  // 3 m legal-minimum deck: poseA = 3 - 0.6 (span 2.25, §H).
  const GEOM3 = { startA: 0.15, poseA: 2.4, traineeId: "t1", nowMs: 1_700_000_000_000 };

  const happy7 = machine("machine-7m-deck-1.0mps-saves", GEOM7, [
    ...stillFrames(7),
    ...walkFrames(GEOM7.startA, 6.25, { paceMps: 1.0 }),
  ]);
  analytic(
    "fit-core/§H-7m-machine",
    `stage ${happy7.stage} (truth: saved — 4.75 s of band >= the 2.0 s floor)`,
    happy7.stage === "saved" && happy7.baseline !== null,
  );
  analytic(
    "fit-core/happy-path-baseline",
    `H ${happy7.baseline?.standHeightM} pace ${happy7.baseline?.paceMps} bob ${happy7.baseline?.bobAmpM}`,
    Math.abs(happy7.baseline.standHeightM - 1.62) <= 0.01 &&
      Math.abs(happy7.baseline.paceMps - 1.0) <= 0.05 &&
      happy7.baseline.bobAmpM > 0.008 &&
      happy7.baseline.bobAmpM < 0.012 &&
      happy7.baseline.capturedAt === GEOM7.nowMs &&
      happy7.baseline.source === "headset",
  );

  // 3 m deck at the MACHINE level: the walk stage ENDS at poseA - 0.8 (the
  // mark slack), so the machine measures ~0.53 m LESS band than the raw §H
  // band arithmetic. The floor is therefore derived over the MEASURABLE
  // span (fitMinSteadySec: usable = span - margin - max(margin, 0.8) ->
  // 1.18 m -> floor 0.545 s on this deck — the emitter pass caught the
  // original span-based floor aborting every brisk walker on a legal
  // minimum deck). Both natural paces now SAVE: ~1.18 s of band at
  // 1.0 m/s and ~0.98 s at 1.2 m/s, each >= 0.545 s.
  const m3slow = machine("machine-3m-deck-1.0mps-saves", GEOM3, [
    ...stillFrames(7),
    ...walkFrames(GEOM3.startA, 2.25, { paceMps: 1.0 }),
  ]);
  analytic(
    "fit-core/3m-machine-1.0mps",
    `stage ${m3slow.stage}, cadence ${m3slow.baseline?.cadenceSpm} (truth: saves with cadence honestly null on the short deck)`,
    m3slow.stage === "saved" &&
      m3slow.baseline !== null &&
      m3slow.baseline.cadenceSpm === null &&
      Math.abs(m3slow.baseline.paceMps - 1.0) <= 0.05,
  );
  const m3brisk = machine("machine-3m-deck-1.2mps-saves", GEOM3, [
    ...stillFrames(7),
    ...walkFrames(GEOM3.startA, 2.25, { paceMps: 1.2 }),
  ]);
  analytic(
    "fit-core/3m-machine-1.2mps",
    `stage ${m3brisk.stage}, pace ${m3brisk.baseline?.paceMps} (truth: the corrected measurable-span floor 0.545 s accepts the brisk ~0.98 s read)`,
    m3brisk.stage === "saved" &&
      m3brisk.baseline !== null &&
      Math.abs(m3brisk.baseline.paceMps - 1.2) <= 0.06,
  );

  const jogM = machine("machine-jog-aborts-walk-not-clean", GEOM7, [
    ...stillFrames(7),
    ...walkFrames(GEOM7.startA, 6.25, { paceMps: 2.5 }),
  ]);
  analytic(
    "fit-core/machine-jog",
    `stage ${jogM.stage} detail ${jogM.detail} (truth: aborted walk-not-clean, nothing saved)`,
    jogM.stage === "aborted" && jogM.detail === "walk-not-clean" && jogM.baseline === null,
  );

  const seated = machine("machine-seated-rig-atomic-reject", GEOM7, [
    ...stillFrames(7, { y: 0.9 }),
    ...walkFrames(GEOM7.startA, 6.25, { paceMps: 1.0, heightM: 0.9 }),
  ]);
  analytic(
    "fit-core/machine-seated-atomic",
    `stage ${seated.stage} detail ${seated.detail} (truth: sanitize rejects height 0.9 < 1.0 at save — atomic)`,
    seated.stage === "aborted" && seated.detail === "walk-not-clean" && seated.baseline === null,
  );

  const farFrame = {
    dt: 1 / 30,
    x: 5,
    y: 1.62,
    z: 0,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    along: 5,
    lateral: 0,
  };
  const markTimeout = machine(
    "machine-mark-timeout-aborts",
    GEOM7,
    Array.from({ length: Math.round(31 * 30) }, () => farFrame),
  );
  analytic(
    "fit-core/mark-timeout",
    `stage ${markTimeout.stage} detail ${markTimeout.detail}`,
    markTimeout.stage === "aborted" && markTimeout.detail === "mark-timeout",
  );

  const standTimeout = machine("machine-stand-timeout-after-reprompt", GEOM7, [
    ...stillFrames(0.2),
    ...stillFrames(31, { hz: 30, noiseStdM: 0.02, seed: 5 }),
  ]);
  analytic(
    "fit-core/stand-timeout",
    `stage ${standTimeout.stage} detail ${standTimeout.detail}, edges ${standTimeout.edges.length} (truth: mark, stand, reprompt, aborted)`,
    standTimeout.stage === "aborted" &&
      standTimeout.detail === "stand-timeout" &&
      standTimeout.edges.length === 4,
  );

  const walkTimeout = machine("machine-walk-timeout-aborts", GEOM7, [
    ...stillFrames(7),
    ...stillFrames(46, { hz: 30, seed: 4 }),
  ]);
  analytic(
    "fit-core/walk-timeout",
    `stage ${walkTimeout.stage} detail ${walkTimeout.detail}`,
    walkTimeout.stage === "aborted" && walkTimeout.detail === "walk-timeout",
  );

  const onMark = {
    dt: 1 / 90,
    x: 0,
    y: 1.62,
    z: 0,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    along: 0.3,
    lateral: 0.1,
  };
  const cancelled = machine("machine-cancel-is-an-interruption", GEOM7, [
    onMark,
    { op: "cancel" },
    farFrame, // terminal: ignored, no further edge
  ]);
  analytic(
    "fit-core/cancel",
    `stage ${cancelled.stage} detail ${cancelled.detail}, edges ${cancelled.edges.length} (truth: mark, stand, aborted — and nothing after)`,
    cancelled.stage === "aborted" &&
      cancelled.detail === "cancelled" &&
      cancelled.edges.length === 3,
  );

  const refusals = c("machine-start-refusals", [
    { fn: "machine", args: { cfg: { ...GEOM7, poseA: GEOM7.startA }, events: [] } },
    { fn: "machine", args: { cfg: { ...GEOM7, poseA: -1 }, events: [] } },
    { fn: "machine", args: { cfg: { ...GEOM7, startA: NaN }, events: [] } },
    { fn: "machine", args: { cfg: { ...GEOM7, traineeId: "" }, events: [] } },
    { fn: "machine", args: { cfg: { ...GEOM7, nowMs: NaN }, events: [] } },
  ]);
  analytic(
    "fit-core/start-refusals",
    `startOk [${refusals.map((r) => r.startOk)}]`,
    refusals.every((r) => r.startOk === false && r.stage === null && r.edges.length === 0),
  );

  const dark = machine("machine-dark-frame-drops-sample", GEOM7, [
    ...stillFrames(3),
    { dt: 1 / 90, x: NaN, y: 1.62, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, along: 0.3, lateral: 0.1 },
  ]);
  analytic(
    "fit-core/dark-frame-dropped",
    `stage ${dark.stage} progress ${dark.progress} (truth: still standing, hold untouched)`,
    dark.stage === "stand" && dark.progress > 0.2 && dark.progress < 1,
  );

  // Walk-stage dark FORWARDING: a mid-band outage while the walker keeps
  // moving must reach the accumulator so its anchor-drop law runs in
  // production — pre-fix the machine silently skipped dark frames and the
  // resume frame differenced the whole unobserved meter into one clamped
  // 4 m/s pace sample (~+1% bias saved into the baseline).
  const darkWalkFrames = walkFrames(GEOM7.startA, 6.25, { paceMps: 1.0 }).map(
    (f) =>
      f.along - GEOM7.startA > 2.5 && f.along - GEOM7.startA < 3.5
        ? { ...f, x: NaN, y: NaN, z: NaN, along: NaN, lateral: NaN }
        : f,
  );
  const darkWalk = machine("machine-walk-dark-stretch-reseeds", GEOM7, [
    ...stillFrames(7),
    ...darkWalkFrames,
  ]);
  analytic(
    "fit-core/walk-dark-forwarding",
    `stage ${darkWalk.stage} pace ${darkWalk.baseline?.paceMps} (truth: saved at the true 1.0 m/s — the resume frame carries ZERO pace weight, not one clamped 4 m/s sample)`,
    darkWalk.stage === "saved" &&
      darkWalk.baseline !== null &&
      Math.abs(darkWalk.baseline.paceMps - 1.0) <= 0.005,
  );

  // --- deriveHeadNormalization / normalizationStamp / sanitize ---------------
  const NOW = 1_700_000_100_000; // 100 s after the fixture's capturedAt
  const derives = c("derive-identity-and-clamp-laws", [
    { fn: "derive", args: { baseline: null, traineeId: "t1" } },
    { fn: "derive", args: { baseline: fitBaseline(), traineeId: "t1" } },
    { fn: "derive", args: { baseline: fitBaseline({ bobAmpM: 0.02 }), traineeId: "t1" } },
    { fn: "derive", args: { baseline: fitBaseline({ bobAmpM: 0.005 }), traineeId: "t1" } },
    { fn: "derive", args: { baseline: fitBaseline({ bobAmpM: 0.05 }), traineeId: "t1" } },
    { fn: "derive", args: { baseline: fitBaseline({ standHeightM: 1.0 }), traineeId: "t1" } },
    { fn: "derive", args: { baseline: fitBaseline({ standHeightM: 1.4 }), traineeId: "t1" } },
    { fn: "derive", args: { baseline: fitBaseline({ standHeightM: 1.8 }), traineeId: "t1" } },
    { fn: "derive", args: { baseline: fitBaseline({ standHeightM: 2.2 }), traineeId: "t1" } },
  ]);
  analytic(
    "fit-core/identity-pin",
    `derive(null) ${JSON.stringify(derives[0])} (truth: the deleted metrics.ts constants, stamped default.v1 — byte identity)`,
    goldenDiff(derives[0], {
      bobThresholdM: 0.004,
      postureSlopePerM: 350,
      stamp: "default.v1",
    }) === null &&
      derives[0].bobThresholdM === 0.004 &&
      derives[0].postureSlopePerM === 350,
  );
  analytic(
    "fit-core/default-body-round-trips",
    `TH ${derives[1].bobThresholdM} slope ${derives[1].postureSlopePerM} stamp ${derives[1].stamp}`,
    derives[1].bobThresholdM === 0.004 &&
      derives[1].postureSlopePerM === 350 &&
      derives[1].stamp === "fit.v1-1700000000000",
  );
  analytic(
    "fit-core/clamp-floor-at-acceptance-edge",
    `A 0.005 -> TH ${derives[3].bobThresholdM} (truth: exactly 0.002 — 0.4 * 0.005 meets the floor)`,
    derives[3].bobThresholdM === 0.002,
  );
  analytic(
    "fit-core/clamp-cap",
    `A 0.05 -> TH ${derives[4].bobThresholdM} (truth 0.012 — the image path's shipped bound)`,
    derives[4].bobThresholdM === 0.012,
  );
  analytic(
    "fit-core/hip-cross-check",
    `A 0.02 -> TH ${derives[2].bobThresholdM} (truth 0.008 — the shipped hip-path ratio)`,
    Math.abs(derives[2].bobThresholdM - 0.008) <= 1e-12,
  );
  analytic(
    "fit-core/slope-law-560-over-H",
    `slopes [${[derives[5], derives[6], derives[7], derives[8]].map((d) => d.postureSlopePerM)}]`,
    derives[5].postureSlopePerM === 560 &&
      Math.abs(derives[6].postureSlopePerM - 400) <= 1e-9 &&
      Math.abs(derives[7].postureSlopePerM - 560 / 1.8) <= 1e-9 &&
      Math.abs(derives[8].postureSlopePerM - 560 / 2.2) <= 1e-9,
  );

  const scoping = c("derive-scoping-and-atomic-reject", [
    { fn: "derive", args: { baseline: fitBaseline({ traineeId: "alice" }), traineeId: "bob" } },
    { fn: "derive", args: { baseline: fitBaseline({ traineeId: "alice" }), traineeId: "alice" } },
    { fn: "derive", args: { baseline: fitBaseline({ traineeId: "alice" }), traineeId: null } },
    { fn: "derive", args: { baseline: fitBaseline({ traineeId: "alice" }), traineeId: "" } },
    { fn: "derive", args: { baseline: fitBaseline({ traineeId: "alice" }) } },
    { fn: "derive", args: { baseline: fitBaseline({ standHeightM: 0.9 }), traineeId: "t1" } },
    { fn: "derive", args: { baseline: fitBaseline({ standHeightM: 2.3 }), traineeId: "t1" } },
    { fn: "derive", args: { baseline: fitBaseline({ bobAmpM: 0.004 }), traineeId: "t1" } },
  ]);
  analytic(
    "fit-core/trainee-scoping",
    `stamps [${scoping.map((n) => n.stamp)}]`,
    scoping[0].stamp === "default.v1" &&
      scoping[1].stamp === "fit.v1-1700000000000" &&
      scoping[2].stamp === "fit.v1-1700000000000" &&
      scoping[3].stamp === "fit.v1-1700000000000" &&
      scoping[4].stamp === "fit.v1-1700000000000",
  );
  analytic(
    "fit-core/atomic-junk-field-reject",
    `height 0.9 / 2.3 / bob 0.004 stamps [${[scoping[5], scoping[6], scoping[7]].map((n) => n.stamp)}] (truth: all default.v1 — good fields never survive)`,
    scoping[5].stamp === "default.v1" &&
      scoping[6].stamp === "default.v1" &&
      scoping[7].stamp === "default.v1",
  );

  c("normalization-stamp-tokens", [
    { fn: "stamp", args: { baseline: null, traineeId: "t1" } },
    { fn: "stamp", args: { baseline: fitBaseline(), traineeId: "t1" } },
    { fn: "stamp", args: { baseline: fitBaseline(), traineeId: "other" } },
    { fn: "stamp", args: { baseline: fitBaseline({ paceMps: 99 }), traineeId: "t1" } },
  ]);

  const dropKey = (obj, key) => {
    const o = { ...obj };
    delete o[key];
    return o;
  };
  const accepts = c("sanitize-acceptance-edges", [
    { fn: "sanitize", args: { value: { ...fitBaseline(), legacyCruft: 42 }, nowMs: NOW } },
    ...[
      { standHeightM: 1.0 },
      { standHeightM: 2.2 },
      { stillNoiseM: 0 },
      { stillNoiseM: 0.02 },
      { neutralPitchRad: -0.7 },
      { neutralPitchRad: 0.7 },
      { paceMps: 0.2 },
      { paceMps: 2.0 },
      { cadenceSpm: null },
      { cadenceSpm: 50 }, // §K floor: 60 / STEP_MAX 1.2
      { cadenceSpm: 160 },
      { bobAmpM: 0.005 },
      { bobAmpM: 0.05 },
      { capturedAt: NOW + 30_000 }, // inside the 60 s clock-skew slack
    ].map((over) => ({ fn: "sanitize", args: { value: fitBaseline(over), nowMs: NOW } })),
  ]);
  analytic(
    "fit-core/sanitize-accepts",
    `non-null ${accepts.filter((v) => v !== null).length}/${accepts.length}; extra field dropped`,
    accepts.every((v) => v !== null) && goldenDiff(accepts[0], fitBaseline()) === null,
  );
  const rejects = c("sanitize-atomic-rejections", [
    ...[null, "junk", 42, []].map((value) => ({
      fn: "sanitize",
      args: { value, nowMs: NOW },
    })),
    ...[
      { version: 2 },
      { version: "1" },
      { traineeId: "" },
      { traineeId: 7 },
      { capturedAt: 0 },
      { capturedAt: -5 },
      { capturedAt: NaN },
      { capturedAt: Infinity },
      { capturedAt: NOW + 120_000 }, // beyond the clock-skew slack
      { standHeightM: 0.99 },
      { standHeightM: 2.21 },
      { standHeightM: NaN },
      { stillNoiseM: -0.001 },
      { stillNoiseM: 0.021 },
      { neutralPitchRad: 0.71 },
      { neutralPitchRad: -0.71 },
      { paceMps: 0.19 },
      { paceMps: 2.01 },
      { cadenceSpm: 49 }, // §K: below the detector's own floor
      { cadenceSpm: 161 },
      { cadenceSpm: "104" },
      { bobAmpM: 0.0049 },
      { bobAmpM: 0.051 },
      { source: "iphone" },
    ].map((over) => ({
      fn: "sanitize",
      args: { value: { ...fitBaseline(), ...over }, nowMs: NOW },
    })),
    { fn: "sanitize", args: { value: dropKey(fitBaseline(), "cadenceSpm"), nowMs: NOW } },
    { fn: "sanitize", args: { value: dropKey(fitBaseline(), "source"), nowMs: NOW } },
  ]);
  analytic(
    "fit-core/sanitize-atomic",
    `nulls ${rejects.filter((v) => v === null).length}/${rejects.length} (truth: every single-field fault rejects the WHOLE baseline)`,
    rejects.every((v) => v === null),
  );

  c("fit-constants", [{ fn: "constants" }]);

  return cases;
}

// =============================================================================
// The §D TWIN-PITCH shared quaternion set — one construction, two families.
// Pitch values are one-decimal so round1 comparisons are exact; yaw rides
// along on some entries to prove pitch extraction survives composition.
// =============================================================================

const TWIN_PITCH_SET = [
  { pitchDeg: -30, yawDeg: 0 },
  { pitchDeg: -12.2, yawDeg: 10 },
  { pitchDeg: -7, yawDeg: 0 },
  { pitchDeg: 3, yawDeg: -25 },
  { pitchDeg: 15.5, yawDeg: 0 },
  { pitchDeg: 45, yawDeg: 5 },
];

function twinQuat(pitchDeg, yawDeg) {
  return quatYawPitch(yawDeg * DEG2RAD, pitchDeg * DEG2RAD);
}

/** The carriage-side twin read: neutral pinned to EXACTLY 0 via the FIT rung
 * (no stand, so the walk-window fallback never engages), one quat frame —
 * livePitchDevDeg SEEDS RAW, so it IS the tracker's extracted pitch. */
function twinCarriageOps(q) {
  return [
    { op: "begin-walk", fitNeutralPitchRad: 0 },
    { op: "quat-frame", q: [q.qx, q.qy, q.qz, q.qw] },
  ];
}

// =============================================================================
// head-carriage — the M8 tracker, score/blend arithmetic, copy builders.
// =============================================================================

function headCarriageCases() {
  const cases = [];
  const c = (name, queries) => {
    const results = runCarriageQueries(queries);
    cases.push({ name, input: { queries }, expect: { results } });
    return results;
  };
  const t = (name, ops) => c(name, [{ fn: "tape", args: { ops } }])[0];

  // --- roll invariance (the module's own invariance twin) --------------------
  const rollTape = (roll) => [
    ...calibrated(0),
    { op: "frame", pitchDeg: -20, yawDeg: 15, rollDeg: roll, reps: 20 },
  ];
  const plain = t("roll-invariance-plain", rollTape(0));
  const rolled = t("roll-invariance-rolled-25deg", rollTape(25));
  analytic(
    "head-carriage/roll-invariance",
    `rolled vs plain stats diff ${goldenDiff(rolled.stats, plain.stats)}`,
    goldenDiff(rolled.stats, plain.stats) === null,
  );

  // --- yaw error sign law (+ = the trainee's right) ---------------------------
  const yawRight = t("yaw-sign-head-right-of-heading", [
    ...calibrated(0),
    { op: "frame", yawDeg: 30 - 90, walkYawDeg: 30 },
  ]);
  analytic(
    "head-carriage/yaw-sign-right",
    `liveYawDevDeg ${yawRight.liveYawDevDeg} (truth: +90 — RIGHT of the heading)`,
    Math.abs(yawRight.liveYawDevDeg - 90) <= 1e-9,
  );
  const yawLeft = t("yaw-sign-head-left-reads-negative", [
    ...calibrated(0),
    { op: "frame", yawDeg: 20, walkYawDeg: 0 },
  ]);
  analytic(
    "head-carriage/yaw-sign-left",
    `liveYawDevDeg ${yawLeft.liveYawDevDeg} (truth: -20)`,
    Math.abs(yawLeft.liveYawDevDeg - -20) <= 1e-9,
  );

  // --- band accounting + rate independence ----------------------------------
  const bandPitch = t("pitch-band-fraction-60pct", [
    ...calibrated(0),
    { op: "frame", pitchDeg: 3, reps: 48 },
    { op: "frame", pitchDeg: 20, reps: 32 },
  ]);
  analytic(
    "head-carriage/pitch-band",
    `pitchInBandFrac ${bandPitch.stats?.pitchInBandFrac} over ${bandPitch.stats?.measuredSec} s (truth: 6/10)`,
    bandPitch.stats?.pitchInBandFrac === 0.6 && bandPitch.stats?.measuredSec === 10,
  );
  const bandYaw = t("yaw-band-fraction-75pct", [
    ...calibrated(0),
    { op: "frame", yawDeg: -5, reps: 24 },
    { op: "frame", yawDeg: -30, reps: 8 },
  ]);
  analytic(
    "head-carriage/yaw-band",
    `yawInBandFrac ${bandYaw.stats?.yawInBandFrac} (truth: 3/4)`,
    bandYaw.stats?.yawInBandFrac === 0.75,
  );
  const rateTape = (dt, mul) => [
    ...calibrated(0),
    { op: "frame", pitchDeg: 3, yawDeg: 4, dt, reps: 48 * mul },
    { op: "frame", pitchDeg: 20, yawDeg: 30, dt, reps: 32 * mul },
  ];
  const coarse = t("rate-independence-32hz", rateTape(1 / 32, 4));
  const fine = t("rate-independence-64hz", rateTape(1 / 64, 8));
  analytic(
    "head-carriage/rate-independence",
    `stats diff ${goldenDiff(fine.stats, coarse.stats)}`,
    goldenDiff(fine.stats, coarse.stats) === null,
  );

  // --- HEAD DROP hysteresis (one dip, one event) ------------------------------
  const settle = { op: "frame", pitchDeg: 0, reps: 16 };
  const oneDip = t("head-drop-one-dip-counts-once", [
    ...calibrated(0),
    { op: "frame", pitchDeg: 0, reps: 4 },
    { op: "frame", pitchDeg: -25, reps: 12 },
    settle,
  ]);
  analytic(
    "head-carriage/one-dip-one-event",
    `glanceCount ${oneDip.stats?.glanceCount} at ${oneDip.stats?.firstGlanceAtSec} s (truth: 1 @ 0.6)`,
    oneDip.stats?.glanceCount === 1 && oneDip.stats?.firstGlanceAtSec === 0.6,
  );
  const noRecount = t("head-drop-recover-minus12-no-recount", [
    ...calibrated(0),
    { op: "frame", pitchDeg: -25, reps: 4 },
    { op: "frame", pitchDeg: -12, reps: 4 },
    { op: "frame", pitchDeg: -25, reps: 4 },
    settle,
  ]);
  analytic(
    "head-carriage/hysteresis-holds-below-rearm",
    `glanceCount ${noRecount.stats?.glanceCount} (truth: 1 — -12 is under the -10 re-arm)`,
    noRecount.stats?.glanceCount === 1,
  );
  const rearm8 = t("head-drop-recover-minus8-rearms", [
    ...calibrated(0),
    { op: "frame", pitchDeg: -25, reps: 4 },
    { op: "frame", pitchDeg: -8, reps: 4 },
    { op: "frame", pitchDeg: -25, reps: 4 },
    settle,
  ]);
  const rearm5 = t("head-drop-recover-minus5-rearms", [
    ...calibrated(0),
    { op: "frame", pitchDeg: -25, reps: 4 },
    { op: "frame", pitchDeg: -5, reps: 4 },
    { op: "frame", pitchDeg: -25, reps: 4 },
    settle,
  ]);
  analytic(
    "head-carriage/rearm-above-minus10",
    `counts ${rearm8.stats?.glanceCount}/${rearm5.stats?.glanceCount} (truth: 2 and 2)`,
    rearm8.stats?.glanceCount === 2 && rearm5.stats?.glanceCount === 2,
  );
  const shallow = t("head-drop-minus14-never-trips", [
    ...calibrated(0),
    { op: "frame", pitchDeg: -14, reps: 8 },
    settle,
  ]);
  analytic(
    "head-carriage/trip-line-strict",
    `glanceCount ${shallow.stats?.glanceCount} firstAt ${shallow.stats?.firstGlanceAtSec}`,
    shallow.stats?.glanceCount === 0 && shallow.stats?.firstGlanceAtSec === null,
  );
  const dropCost = t("head-drop-costs-band-time-once", [
    ...calibrated(0),
    { op: "frame", pitchDeg: -25, reps: 8 },
    { op: "frame", pitchDeg: 0, reps: 24 },
  ]);
  analytic(
    "head-carriage/no-double-penalty",
    `glance ${dropCost.stats?.glanceCount}, pitchFrac ${dropCost.stats?.pitchInBandFrac} (truth: 1 and 0.75)`,
    dropCost.stats?.glanceCount === 1 && dropCost.stats?.pitchInBandFrac === 0.75,
  );

  // --- neutral chain: stand -> fit -> walk (adjudication §K) ------------------
  const standWins = t("neutral-stand-mean-wins", [
    ...calibrated(5),
    { op: "frame", pitchDeg: 5, reps: 24 },
  ]);
  analytic(
    "head-carriage/neutral-stand",
    `source ${standWins.stats?.neutralSource} neutral ${standWins.stats?.neutralPitchDeg} dev ${standWins.stats?.meanPitchDevDeg}`,
    standWins.stats?.neutralSource === "stand" &&
      standWins.stats?.neutralPitchDeg === 5 &&
      standWins.stats?.pitchInBandFrac === 1 &&
      standWins.stats?.meanPitchDevDeg === 0,
  );
  const speedGated = t("neutral-approach-speed-gated", [
    { op: "reset-neutral" },
    { op: "stand", pitchDeg: 5, speedMps: 0, reps: 8 },
    { op: "stand", pitchDeg: -20, speedMps: 1.0, reps: 8 },
    { op: "begin-walk" },
    { op: "frame", pitchDeg: 5, reps: 24 },
  ]);
  analytic(
    "head-carriage/stand-speed-gate",
    `neutral ${speedGated.stats?.neutralPitchDeg} (truth: 5 — walking-speed samples are approach motion)`,
    speedGated.stats?.neutralSource === "stand" && speedGated.stats?.neutralPitchDeg === 5,
  );
  const insaneStand = t("neutral-insane-stand-falls-to-walk", [
    ...calibrated(-25),
    { op: "frame", pitchDeg: -25, reps: 24 },
  ]);
  analytic(
    "head-carriage/insane-stand-discarded",
    `source ${insaneStand.stats?.neutralSource} neutral ${insaneStand.stats?.neutralPitchDeg} glances ${insaneStand.stats?.glanceCount}`,
    insaneStand.stats?.neutralSource === "walk" &&
      insaneStand.stats?.neutralPitchDeg === -25 &&
      insaneStand.stats?.pitchInBandFrac === 1 &&
      insaneStand.stats?.glanceCount === 0,
  );
  const fitTertiary = t("neutral-fit-tertiary-rescues-insane-stand", [
    ...calibrated(-25, 3 * DEG2RAD),
    { op: "frame", pitchDeg: 3, reps: 24 },
  ]);
  analytic(
    "head-carriage/fit-tertiary",
    `source ${fitTertiary.stats?.neutralSource} neutral ${fitTertiary.stats?.neutralPitchDeg} (truth: fit / 3 — the §K FIT<->M8 chain)`,
    fitTertiary.stats?.neutralSource === "fit" &&
      fitTertiary.stats?.neutralPitchDeg === 3 &&
      fitTertiary.stats?.pitchInBandFrac === 1,
  );
  const insaneFit = t("neutral-insane-fit-same-gate", [
    ...calibrated(-25, 20 * DEG2RAD),
    { op: "frame", pitchDeg: 0, reps: 24 },
  ]);
  analytic(
    "head-carriage/insane-fit-discarded",
    `source ${insaneFit.stats?.neutralSource} (truth: walk — one sane gate for every calibration)`,
    insaneFit.stats?.neutralSource === "walk",
  );
  const standOverFit = t("neutral-sane-stand-outranks-fit", [
    ...calibrated(5, 3 * DEG2RAD),
    { op: "frame", pitchDeg: 5, reps: 24 },
  ]);
  analytic(
    "head-carriage/chain-order",
    `source ${standOverFit.stats?.neutralSource} neutral ${standOverFit.stats?.neutralPitchDeg}`,
    standOverFit.stats?.neutralSource === "stand" && standOverFit.stats?.neutralPitchDeg === 5,
  );
  const walkWindow = t("neutral-walk-window-running-mean", [
    { op: "begin-walk" },
    { op: "frame", pitchDeg: 4, reps: 24 },
  ]);
  analytic(
    "head-carriage/walk-fallback",
    `source ${walkWindow.stats?.neutralSource} neutral ${walkWindow.stats?.neutralPitchDeg}`,
    walkWindow.stats?.neutralSource === "walk" &&
      walkWindow.stats?.neutralPitchDeg === 4 &&
      walkWindow.stats?.pitchInBandFrac === 1,
  );
  const darkWindow = t("neutral-dark-window-seeds-first-live-sample", [
    { op: "begin-walk" },
    { op: "frame", pitchDeg: 6, dt: 1 },
    { op: "frame", pitchDeg: 6, dt: 0.5, reps: 2 },
  ]);
  analytic(
    "head-carriage/first-sample-seed",
    `neutral ${darkWindow.stats?.neutralPitchDeg} frac ${darkWindow.stats?.pitchInBandFrac}`,
    darkWindow.stats?.neutralSource === "walk" &&
      darkWindow.stats?.neutralPitchDeg === 6 &&
      darkWindow.stats?.pitchInBandFrac === 1,
  );
  const rerun = t("neutral-stand-survives-rerun", [
    ...calibrated(5),
    { op: "frame", pitchDeg: 5, reps: 24 },
    { op: "begin-walk" },
    { op: "frame", pitchDeg: 5, reps: 24 },
  ]);
  analytic(
    "head-carriage/stand-survives-rerun",
    `source ${rerun.stats?.neutralSource} neutral ${rerun.stats?.neutralPitchDeg} (truth: only resetNeutral clears the stand)`,
    rerun.stats?.neutralSource === "stand" && rerun.stats?.neutralPitchDeg === 5,
  );

  // --- turn window (yaw-dark) + the return flip / one-way rule ---------------
  const suppressedBase = [
    ...calibrated(0),
    { op: "frame", yawDeg: 0, reps: 32 },
  ];
  const calm = t("turn-window-suppressed-calm", [
    ...suppressedBase,
    { op: "frame", yawDeg: 0, suppressed: true, reps: 24 },
  ]);
  const wild = t("turn-window-suppressed-wild", [
    ...suppressedBase,
    { op: "frame", yawDeg: 90, suppressed: true, reps: 24 },
  ]);
  analytic(
    "head-carriage/turn-window-dark",
    `wild vs calm diff ${goldenDiff(wild.stats, calm.stats)}; wild yawFrac ${wild.stats?.yawInBandFrac}, tap ${wild.liveYawDevDeg}`,
    goldenDiff(wild.stats, calm.stats) === null &&
      wild.stats?.yawInBandFrac === 1 &&
      wild.liveYawDevDeg === null,
  );
  const pitchThrough = t("turn-window-pitch-keeps-measuring", [
    ...calibrated(0),
    { op: "frame", pitchDeg: 0, reps: 16 },
    { op: "frame", pitchDeg: 20, suppressed: true, reps: 16 },
  ]);
  analytic(
    "head-carriage/pitch-through-turn",
    `pitchFrac ${pitchThrough.stats?.pitchInBandFrac} over ${pitchThrough.stats?.measuredSec} s (truth: 0.5 / 4)`,
    pitchThrough.stats?.pitchInBandFrac === 0.5 && pitchThrough.stats?.measuredSec === 4,
  );
  const flipped = t("return-flip-in-band", [
    ...calibrated(0),
    { op: "frame", yawDeg: 180, walkYawDeg: 0, returning: true, reps: 20 },
  ]);
  const unflipped = t("return-flip-negative-control", [
    ...calibrated(0),
    { op: "frame", yawDeg: 180, walkYawDeg: 0, returning: false, reps: 20 },
  ]);
  analytic(
    "head-carriage/return-flip",
    `returning yawFrac ${flipped.stats?.yawInBandFrac} vs unflipped ${unflipped.stats?.yawInBandFrac} (truth: 1 vs 0)`,
    flipped.stats?.yawInBandFrac === 1 && unflipped.stats?.yawInBandFrac === 0,
  );
  const oneWay = t("one-way-suppressed-to-walk-end", [
    ...calibrated(0),
    { op: "frame", yawDeg: 0, reps: 8 },
    { op: "frame", yawDeg: 170, suppressed: true, reps: 24 },
  ]);
  analytic(
    "head-carriage/one-way-rule",
    `yawFrac ${oneWay.stats?.yawInBandFrac} (truth: 1 — only the pre-mark second counts)`,
    oneWay.stats?.yawInBandFrac === 1,
  );
  const yawUnderMin = t("yaw-under-min-sec-null", [
    ...calibrated(0),
    { op: "frame", yawDeg: 0, reps: 4 },
    { op: "frame", yawDeg: 0, suppressed: true, reps: 24 },
  ]);
  analytic(
    "head-carriage/yaw-min-sec",
    `yawFrac ${yawUnderMin.stats?.yawInBandFrac} (truth: null — under one gait cycle a fraction is a coin flip)`,
    yawUnderMin.stats?.yawInBandFrac === null,
  );
  const nearVertical = t("near-vertical-yaw-dark", [
    ...calibrated(0),
    { op: "frame", yawDeg: 0, reps: 8 },
    { op: "frame", pitchDeg: 80, reps: 8 },
  ]);
  analytic(
    "head-carriage/min-horiz-gate",
    `tap ${nearVertical.liveYawDevDeg}, yawFrac ${nearVertical.stats?.yawInBandFrac} (truth: null tap, gated frames credit nothing)`,
    nearVertical.liveYawDevDeg === null && nearVertical.stats?.yawInBandFrac === 1,
  );

  // --- mid-walk remap (resetYawChannel) --------------------------------------
  const remap = t("remap-clears-yaw-only", [
    ...calibrated(0),
    { op: "frame", yawDeg: 30, reps: 16 },
    { op: "frame", pitchDeg: -25, reps: 4 },
    { op: "reset-yaw" },
    { op: "frame", yawDeg: 0, reps: 16 },
  ]);
  analytic(
    "head-carriage/remap-resets-yaw-only",
    `yawFrac ${remap.stats?.yawInBandFrac}, glances ${remap.stats?.glanceCount}, measured ${remap.stats?.measuredSec}`,
    remap.stats?.yawInBandFrac === 1 &&
      remap.stats?.glanceCount === 1 &&
      remap.stats?.measuredSec === 4.5,
  );
  const remapTap = t("remap-nulls-live-yaw-tap", [
    ...calibrated(0),
    { op: "frame", yawDeg: 30, reps: 16 },
    { op: "reset-yaw" },
  ]);
  const remapReseed = t("remap-tap-reseeds-raw", [
    ...calibrated(0),
    { op: "frame", yawDeg: 30, reps: 16 },
    { op: "reset-yaw" },
    { op: "frame", yawDeg: -4 },
  ]);
  analytic(
    "head-carriage/remap-tap",
    `after reset ${remapTap.liveYawDevDeg}, after reseed ${remapReseed.liveYawDevDeg} (truth: null then RAW +4)`,
    remapTap.liveYawDevDeg === null && Math.abs(remapReseed.liveYawDevDeg - 4) <= 1e-9,
  );

  // --- finiteness (dark frames == clean twin) ---------------------------------
  const cleanTwin = t("dark-frames-clean-twin", [
    ...calibrated(0),
    { op: "frame", pitchDeg: 3, reps: 16 },
  ]);
  const dirtyTwin = t("dark-frames-carry-zero-weight", [
    ...calibrated(0),
    { op: "frame", pitchDeg: 3, reps: 8 },
    { op: "dark-frame", reps: 4 },
    { op: "bad-dt-frame", dt: 0 },
    { op: "bad-dt-frame", dt: -0.1 },
    { op: "bad-dt-frame", dt: NaN },
    { op: "frame", pitchDeg: 3, reps: 8 },
  ]);
  analytic(
    "head-carriage/dark-frame-equivalence",
    `dirty vs clean diff ${goldenDiff(dirtyTwin.stats, cleanTwin.stats)}`,
    goldenDiff(dirtyTwin.stats, cleanTwin.stats) === null,
  );
  const tapsHold = t("dark-frame-taps-hold-last-value", [
    ...calibrated(0),
    { op: "frame", pitchDeg: 5, yawDeg: 4 },
    { op: "dark-frame", reps: 3 },
  ]);
  analytic(
    "head-carriage/taps-hold-through-dark",
    `pitch tap ${tapsHold.livePitchDevDeg}, yaw tap ${tapsHold.liveYawDevDeg} (truth: 5 and -4, never NaN)`,
    Math.abs(tapsHold.livePitchDevDeg - 5) <= 1e-9 &&
      Math.abs(tapsHold.liveYawDevDeg - -4) <= 1e-9,
  );

  // --- engage + finalize contract ---------------------------------------------
  const underEngage = t("under-engage-not-finalized", [
    ...calibrated(0),
    { op: "frame", pitchDeg: 0, reps: 15 },
  ]);
  const atEngage = t("exactly-engage-finalizes", [
    ...calibrated(0),
    { op: "frame", pitchDeg: 0, reps: 16 },
  ]);
  analytic(
    "head-carriage/engage-criterion",
    `1.875 s engaged ${underEngage.engaged} stats ${underEngage.stats}; 2.0 s engaged ${atEngage.engaged} measured ${atEngage.stats?.measuredSec}`,
    underEngage.engaged === false &&
      underEngage.stats === null &&
      atEngage.engaged === true &&
      atEngage.stats?.measuredSec === 2,
  );
  const cleared = t("begin-walk-clears-walk-state", [
    ...calibrated(0),
    { op: "frame", pitchDeg: -25, reps: 24 },
    { op: "begin-walk" },
  ]);
  analytic(
    "head-carriage/begin-walk-clears",
    `engaged ${cleared.engaged}, taps ${cleared.livePitchDevDeg}/${cleared.liveYawDevDeg}`,
    cleared.engaged === false &&
      cleared.stats === null &&
      cleared.livePitchDevDeg === null &&
      cleared.liveYawDevDeg === null,
  );

  // --- §D TWIN-PITCH (shared quaternion set — see hold-stats' twin case) ------
  const twinResults = c(
    "twin-pitch-shared-quats",
    TWIN_PITCH_SET.map((e) => ({
      fn: "tape",
      args: { ops: twinCarriageOps(twinQuat(e.pitchDeg, e.yawDeg)) },
    })),
  );
  TWIN_PITCH_SET.forEach((e, i) => {
    analytic(
      `head-carriage/twin-pitch ${e.pitchDeg} deg`,
      `livePitchDevDeg ${twinResults[i].livePitchDevDeg} (truth: the constructed pitch, exactly)`,
      Math.abs(twinResults[i].livePitchDevDeg - e.pitchDeg) <= 1e-9,
    );
  });

  // --- score mapping + the M5 presence blend ----------------------------------
  const scores = c("score-map-anchors", [
    { fn: "score", args: { pitchFrac: 1, yawFrac: 1 } },
    { fn: "score", args: { pitchFrac: 0, yawFrac: 0 } },
    { fn: "score", args: { pitchFrac: 35 / 60, yawFrac: null } },
    { fn: "score", args: { pitchFrac: 0.5, yawFrac: null } },
    { fn: "score", args: { pitchFrac: 1, yawFrac: 0 } },
  ]);
  analytic(
    "head-carriage/score-anchors",
    `[${scores}] (truth: 100 cap, 40 floor, 75 at fc=35/60, 70, 76 - the 40+60 map)`,
    Math.abs(scores[0] - 100) <= 1e-9 &&
      Math.abs(scores[1] - 40) <= 1e-9 &&
      Math.abs(scores[2] - 75) <= 1e-9 &&
      Math.abs(scores[3] - 70) <= 1e-9 &&
      Math.abs(scores[4] - 76) <= 1e-9,
  );
  const blends = c("presence-blend-one-shot", [
    { fn: "blend", args: { legacy: 80, carriage: 40 } },
    { fn: "blend", args: { legacy: 60, carriage: 98 } },
    { fn: "blend", args: { legacy: 90, carriage: 90 } },
  ]);
  analytic(
    "head-carriage/blend-arithmetic",
    `[${blends}] (truth: 70, 69.5, 90 — the 0.75/0.25 convex law)`,
    Math.abs(blends[0] - 70) <= 1e-9 &&
      Math.abs(blends[1] - 69.5) <= 1e-9 &&
      Math.abs(blends[2] - 90) <= 1e-9,
  );
  const stepBlends = c("step-blend-idempotence-pin", [
    {
      fn: "stepBlend",
      args: {
        legacy0: 0,
        steps: [{ derived: true, target4: 80, engaged: true, carriageScore: 90 }],
      },
    },
    {
      // The §B PIN: repeated cached frames (target4 = previous output) must
      // leave target[4] BIT-identical — the latch never absorbs a blend.
      fn: "stepBlend",
      args: {
        legacy0: 62,
        steps: [
          { derived: true, target4: 80, engaged: true, carriageScore: 90 },
          { derived: false, target4: null, engaged: true, carriageScore: 90 },
          { derived: false, target4: null, engaged: true, carriageScore: 90 },
        ],
      },
    },
    {
      // Head re-seed frame: no derive ran; blend holds from the stale-but-
      // valid latch, never from the frame's target4.
      fn: "stepBlend",
      args: {
        legacy0: 70,
        steps: [{ derived: false, target4: 55.5, engaged: true, carriageScore: 90 }],
      },
    },
    {
      // Not engaged: pass-through, but the latch still tracks derives.
      fn: "stepBlend",
      args: {
        legacy0: 0,
        steps: [
          { derived: true, target4: 77, engaged: false, carriageScore: 40 },
          { derived: false, target4: 77, engaged: false, carriageScore: 40 },
        ],
      },
    },
  ]);
  {
    const pin = stepBlends[1];
    analytic(
      "head-carriage/§B-idempotence",
      `outputs [${pin.outputs}] latch ${pin.latchLegacy} (truth: bit-identical outputs, latch stays 80)`,
      pin.outputs[1] === pin.outputs[0] &&
        pin.outputs[2] === pin.outputs[0] &&
        pin.latchLegacy === 80,
    );
    analytic(
      "head-carriage/§B-not-engaged-passthrough",
      `outputs [${stepBlends[3].outputs}] latch ${stepBlends[3].latchLegacy}`,
      stepBlends[3].outputs[0] === 77 &&
        stepBlends[3].outputs[1] === 77 &&
        stepBlends[3].latchLegacy === 77,
    );
  }

  // --- copy builders (§K HEAD DROPS naming; never a gaze claim) ---------------
  const lines = c("carriage-line-branches", [
    {
      fn: "line",
      args: {
        stats: makeCarriage({ pitchInBandFrac: 0.84, yawInBandFrac: 0.91, glanceCount: 2 }),
      },
    },
    {
      fn: "line",
      args: {
        stats: makeCarriage({ pitchInBandFrac: 0.84, yawInBandFrac: 0.91 }),
        sep: " · ",
      },
    },
    { fn: "line", args: { stats: makeCarriage({ pitchInBandFrac: 0.5, yawInBandFrac: null }) } },
    { fn: "line", args: { stats: makeCarriage({ glanceCount: 1 }) } },
    { fn: "line", args: { stats: null } },
  ]);
  analytic(
    "head-carriage/line-branches",
    `full "${lines[0]}", yaw-null "${lines[2]}"`,
    lines[0] === "HEAD CARRIAGE - CHIN LEVEL 84% - FACING ON LINE 91% - 2 HEAD DROPS" &&
      lines[2] === "HEAD CARRIAGE - CHIN LEVEL 50% - NO HEAD DROPS" &&
      lines[3] === "HEAD CARRIAGE - CHIN LEVEL 100% - FACING ON LINE 100% - 1 HEAD DROP" &&
      lines[4] === null,
  );
  const cues = c("presence-cue-branches", [
    { fn: "cue", args: { stats: makeCarriage({ glanceCount: 1 }) } },
    { fn: "cue", args: { stats: makeCarriage({ glanceCount: 3, meanPitchDevDeg: -6 }) } },
    {
      fn: "cue",
      args: {
        stats: makeCarriage({ pitchInBandFrac: 0.5, meanPitchDevDeg: -4.2, yawInBandFrac: 0.9 }),
      },
    },
    {
      fn: "cue",
      args: {
        stats: makeCarriage({ pitchInBandFrac: 0.5, meanPitchDevDeg: 2.4, yawInBandFrac: 0.9 }),
      },
    },
    {
      fn: "cue",
      args: {
        stats: makeCarriage({ pitchInBandFrac: 1, meanPitchDevDeg: 0.4, yawInBandFrac: 0.6 }),
      },
    },
    {
      fn: "cue",
      args: {
        stats: makeCarriage({ pitchInBandFrac: 0.9, meanPitchDevDeg: -2, yawInBandFrac: 0.5 }),
      },
    },
    {
      fn: "cue",
      args: {
        stats: makeCarriage({ pitchInBandFrac: 0.3, meanPitchDevDeg: -5, yawInBandFrac: 0.7 }),
      },
    },
    {
      fn: "cue",
      args: {
        stats: makeCarriage({ pitchInBandFrac: 0.9, meanPitchDevDeg: 0.3, yawInBandFrac: 0.9 }),
      },
    },
    {
      fn: "cue",
      args: {
        stats: makeCarriage({ pitchInBandFrac: 0.95, meanPitchDevDeg: -0.4, yawInBandFrac: null }),
      },
    },
  ]);
  analytic(
    "head-carriage/cue-selection",
    `drops-first "${cues[0]}", deficit winners "${cues[5]}"/"${cues[6]}", guards ${cues[7]}/${cues[8]}`,
    cues[0] === "You dropped your head to the deck once - chin level, hold the far wall." &&
      cues[1] === "You dropped your head to the deck 3 times - chin level, hold the far wall." &&
      cues[2] === "Your chin averaged 4 deg below neutral - level it and hold the far wall." &&
      cues[3] === "Your chin averaged 2 deg above neutral - level it and hold the far wall." &&
      cues[4] ===
        "Your head faced off the walk line 40 percent of the walk - pick the far point and hold it." &&
      cues[5].includes("faced off the walk line") &&
      cues[6].includes("Your chin averaged") &&
      cues[7] === null &&
      cues[8] === null,
  );

  // applyCarriageNotes — the report post-processor (adjudication §I: identity
  // unless carriage + presence note + qualifying cue all hold). Contexts are
  // the coach family's own serializable shape.
  const slimCtx = (ctx) => ({
    scores: ctx.scores,
    overall: ctx.overall,
    mode: { passThreshold: ctx.mode.passThreshold, weights: ctx.mode.weights },
    stats: ctx.stats,
    oneWayRoute: ctx.oneWayRoute,
  });
  const presenceCtx = slimCtx(noteContext("presence", null));
  const cleanCtx = slimCtx(coachContext());
  const richCtx = slimCtx(
    coachContext({ scores: snap(95, { presence: 50, posture: 50 }), overall: 85 }),
  );
  const applied = c("apply-carriage-notes", [
    { fn: "applyNotes", args: { context: presenceCtx, carriage: makeCarriage({ glanceCount: 1 }) } },
    { fn: "applyNotes", args: { context: presenceCtx, carriage: null } },
    { fn: "applyNotes", args: { context: cleanCtx, carriage: makeCarriage({ glanceCount: 2 }) } },
    {
      fn: "applyNotes",
      args: {
        context: presenceCtx,
        carriage: makeCarriage({ meanPitchDevDeg: 0.2, yawInBandFrac: 0.95 }),
      },
    },
    { fn: "applyNotes", args: { context: richCtx, carriage: makeCarriage({ glanceCount: 1 }) } },
  ]);
  analytic(
    "head-carriage/apply-notes-identity-law",
    `identities [${applied.map((r) => r.identity)}] (truth: upgrade, identity, identity, identity, upgrade)`,
    applied[0].identity === false &&
      applied[0].report.notes[0].directional === true &&
      applied[0].report.notes[0].key === "presence" &&
      applied[1].identity === true &&
      applied[2].identity === true &&
      applied[3].identity === true &&
      applied[4].identity === false &&
      applied[4].report.notes.length === 2,
  );

  // --- the frozen-pose guard (the HoldAccumulator law mirrored onto M8) ------
  const frozenWalk = t("frozen-tape-zero-measured-time", [
    ...calibrated(0),
    { op: "frame", pitchDeg: 0, reps: 16 }, // 2 s live -> engaged
    // 20 s of bit-identical tracking: the FIRST frozen frame is a new tuple
    // (0.125 s), every repeat is zero weight — measuredSec must not claim
    // the frozen stretch as measured carriage.
    { op: "frame", pitchDeg: 3, frozen: true, reps: 160 },
  ]);
  const ditheredWalk = t("dithered-stream-fully-measured", [
    ...calibrated(0),
    { op: "frame", pitchDeg: 0, reps: 16 },
    { op: "frame", pitchDeg: 3, reps: 160 }, // the runner's q/-q dither
  ]);
  analytic(
    "head-carriage/frozen-pose-guard",
    `frozen measured ${frozenWalk.stats?.measuredSec} vs dithered ${ditheredWalk.stats?.measuredSec}, frozen taps ${frozenWalk.livePitchDevDeg}/${frozenWalk.liveYawDevDeg} (truth: 2.1 vs 22 — a real 90 Hz stream is never bit-identical; frozen taps disclose null)`,
    frozenWalk.stats?.measuredSec === 2.1 &&
      frozenWalk.livePitchDevDeg === null &&
      frozenWalk.liveYawDevDeg === null &&
      ditheredWalk.stats?.measuredSec === 22,
  );

  // --- markTurnFlags — the M8 yaw-flag LAW the engine wiring runs -------------
  const turnFlags = c("mark-turn-flags-law", [
    { fn: "markTurnFlags", args: { markAtWalkTime: -1, walkTime: 10, routeOneWay: false } },
    { fn: "markTurnFlags", args: { markAtWalkTime: -1, walkTime: 10, routeOneWay: true } },
    { fn: "markTurnFlags", args: { markAtWalkTime: 10, walkTime: 12, routeOneWay: false } },
    // The boundary at exactly M8_TURN_EXCLUDE_SEC: STRICT `<` — yaw
    // measures again at the edge (out-and-back keeps the flip).
    { fn: "markTurnFlags", args: { markAtWalkTime: 10, walkTime: 14, routeOneWay: false } },
    { fn: "markTurnFlags", args: { markAtWalkTime: 10, walkTime: 13.999999, routeOneWay: false } },
    // One-way (U): dark from the mark to the walk's end, never returning.
    { fn: "markTurnFlags", args: { markAtWalkTime: 10, walkTime: 110, routeOneWay: true } },
  ]);
  analytic(
    "head-carriage/mark-turn-flags",
    `flags ${JSON.stringify(turnFlags)}`,
    turnFlags[0].returning === false &&
      turnFlags[0].yawSuppressed === false &&
      turnFlags[1].returning === false &&
      turnFlags[1].yawSuppressed === false &&
      turnFlags[2].returning === true &&
      turnFlags[2].yawSuppressed === true &&
      turnFlags[3].returning === true &&
      turnFlags[3].yawSuppressed === false &&
      turnFlags[4].yawSuppressed === true &&
      turnFlags[5].returning === false &&
      turnFlags[5].yawSuppressed === true,
  );

  c("carriage-strings-and-constants", [{ fn: "tables" }]);

  return cases;
}

// =============================================================================
// hold-stats — the M10 accumulator, height ladder, copy branches.
// =============================================================================

function holdStatsCases() {
  const cases = [];
  const c = (name, queries) => {
    const results = runHoldQueries(queries);
    cases.push({ name, input: { queries }, expect: { results } });
    return results;
  };
  const t = (name, frames, opts = {}) =>
    c(name, [{ fn: "tape", args: { frames, ...opts } }])[0];
  /** Sub-cm sway: dAlong alternates +-amp about 0 (RMS = amp exactly —
   * arms on frame 0, 34 frames fill the rebased window 16 folds a side). */
  const holdSwayTape = (ampM) =>
    holdTape(HOLD_TAPE_FRAMES_ARMED, (i) => ({
      dAlong: (i % 2 === 0 ? 1 : -1) * ampM,
      lat: 0,
    }));

  // --- ANALYTIC ANCHOR tapes ---------------------------------------------------
  const frozen = t("frozen-trainee-rms-exactly-zero", holdStillTape(-0.1, 0.05));
  analytic(
    "hold-stats/frozen-rms-zero",
    `stillnessRmsCm ${frozen.stats?.stillnessRmsCm} markErr ${frozen.stats?.markErrCm} time ${frozen.stats?.timeInWindowSec} liveStill ${frozen.liveStill01}`,
    frozen.stats?.stillnessRmsCm === 0 &&
      frozen.stats?.markAlongCm === -10 &&
      frozen.stats?.markLatCm === 5 &&
      frozen.stats?.markErrCm === 11.2 &&
      frozen.stats?.timeInWindowSec === HOLD_WINDOW_SEC &&
      frozen.stats?.orientRmsDeg === 0 &&
      frozen.liveStill01 === 1,
  );
  const bolt = t("bolt-sweep-l-over-sqrt12", boltTape(0.85));
  {
    const truthCm = ((0.85 * HOLD_WINDOW_SEC) / Math.sqrt(12)) * 100;
    analytic(
      "hold-stats/bolt-l-over-sqrt12",
      `stillnessRmsCm ${bolt.stats?.stillnessRmsCm} (truth: L/sqrt(12) = ${truthCm.toFixed(2)} cm within 2%)`,
      bolt.stats !== null &&
        Math.abs(bolt.stats.stillnessRmsCm - truthCm) / truthCm < 0.02 &&
        bolt.stats.stillnessNormRmsCm > 5 &&
        bolt.liveStill01 === 0,
    );
  }
  const step = t("two-level-adjustment-step-rms-15", holdStepTape(0.3));
  analytic(
    "hold-stats/step-half-amplitude",
    `stillnessRmsCm ${step.stats?.stillnessRmsCm} (truth: exactly 15 = 0.30/2 * 100)`,
    step.stats?.stillnessRmsCm === 15,
  );

  // --- junk-frame tape == clean twin (the finiteness law) ----------------------
  const cleanStep = holdStepTape(0.12);
  const junky = [];
  for (let i = 0; i < cleanStep.length; i++) {
    junky.push(cleanStep[i]);
    if (i % 5 === 2) {
      junky.push({
        t: cleanStep[i].t + 0.01,
        dt: 0.01,
        dAlong: NaN,
        lat: 0,
        q: Q_IDENTITY,
      });
    }
  }
  const junkTwin = t("junk-frames-tape", junky);
  const cleanTwin = t("junk-frames-clean-twin", cleanStep);
  analytic(
    "hold-stats/junk-clean-equivalence",
    `stats diff ${goldenDiff(junkTwin.stats, cleanTwin.stats)}`,
    // The RECORD is junk-invariant; the presentation-only liveStill01
    // legitimately diverges (each junk frame drops the speed anchor — the
    // re-seed law), so the equivalence pin covers finalize() only.
    goldenDiff(junkTwin.stats, cleanTwin.stats) === null,
  );

  // --- the window-overlap clamp (owned by the accumulator) ---------------------
  const partial = t("window-clamp-partial-overlap", [
    // Arms ON the mark (tArm = 0.1), then one frame whose rebased span
    // [1.5, 1.7] straddles window close.
    { t: 0.1, dt: 0.1, dAlong: 0, lat: 0, q: Q_IDENTITY },
    { t: 1.8, dt: 0.2, dAlong: 0.01, lat: 0, q: { qx: 0, qy: 0, qz: 0.001, qw: 1 } },
  ]);
  analytic(
    "hold-stats/window-clamp",
    `timeInWindowSec ${partial.stats?.timeInWindowSec} (truth: exactly the rebased [1.5, 1.6] sliver = 0.1)`,
    partial.stats?.timeInWindowSec === 0.1,
  );
  const latchOnly = t("window-latch-frame-zero-weight", [
    { t: 0, dt: 0.014, dAlong: 0.5, lat: 0.5, q: Q_IDENTITY },
  ]);
  analytic(
    "hold-stats/latch-frame",
    `stats ${latchOnly.stats} reason ${latchOnly.nullReason} armed ${latchOnly.armed} (truth: null / no-data — the mark WAS seen; 0.5 m out never arms)`,
    latchOnly.stats === null &&
      latchOnly.nullReason === "no-data" &&
      latchOnly.armed === false,
  );
  const postWindow = t("window-post-window-frame-ignored", [
    ...holdStillTape(0, 0),
    { t: 1.8, dt: 0.05, dAlong: 3, lat: 3, q: Q_IDENTITY },
  ]);
  analytic(
    "hold-stats/post-window-ignored",
    `time ${postWindow.stats?.timeInWindowSec} markAlong ${postWindow.stats?.markAlongCm}`,
    postWindow.stats?.timeInWindowSec === HOLD_WINDOW_SEC &&
      postWindow.stats?.markAlongCm === 0,
  );
  const truncated = t(
    "window-truncated-feed-disclosed",
    holdStillTape(-0.02, 0.01).slice(0, 14),
  );
  analytic(
    "hold-stats/truncation-disclosed",
    `time ${truncated.stats?.timeInWindowSec}, line "${truncated.line}" (truth: armed at frame 0 -> 13 rebased 0.05 s folds = 0.65)`,
    truncated.stats?.timeInWindowSec === 0.65 && truncated.line.startsWith("HOLD 0.7S"),
  );

  // --- null contract + reasons (adjudication §K) --------------------------------
  const neverMarked = t("never-marked-empty-window", []);
  analytic(
    "hold-stats/never-marked",
    `reason ${neverMarked.nullReason}, line "${neverMarked.line}"`,
    neverMarked.stats === null &&
      neverMarked.nullReason === "never-marked" &&
      neverMarked.line === "HOLD: NO READ - THE WALK ENDED BEFORE THE MARK" &&
      neverMarked.cue === "You never reached the pose mark - the hold was not measured.",
  );
  const junkOnly = t("no-data-junk-only-window", [
    { t: 0.1, dt: 0.05, dAlong: NaN, lat: 0, q: Q_IDENTITY },
    { t: 0.15, dt: 0.05, dAlong: 0, lat: Infinity, q: Q_IDENTITY },
  ]);
  analytic(
    "hold-stats/no-data",
    `reason ${junkOnly.nullReason}, line "${junkOnly.line}"`,
    junkOnly.stats === null &&
      junkOnly.nullReason === "no-data" &&
      junkOnly.line === "HOLD: NO READ - THE HOLD WINDOW WAS NOT MEASURED",
  );
  const badClock = t("junk-dt-or-t-skips-frame", [
    { t: NaN, dt: 0.05, dAlong: 0, lat: 0, q: Q_IDENTITY },
    { t: 0.1, dt: NaN, dAlong: 0, lat: 0, q: Q_IDENTITY },
    { t: 0.1, dt: 0, dAlong: 0, lat: 0, q: Q_IDENTITY },
    { t: 0.1, dt: -0.05, dAlong: 0, lat: 0, q: Q_IDENTITY },
  ]);
  analytic(
    "hold-stats/bad-clock-skips",
    `stats ${badClock.stats} reason ${badClock.nullReason}`,
    badClock.stats === null && badClock.nullReason === "no-data",
  );

  // --- orientation folds --------------------------------------------------------
  const nanQuat = t(
    "nan-quat-folds-position-only",
    holdTape(HOLD_TAPE_FRAMES_ARMED, () => ({
      dAlong: -0.03,
      lat: 0.02,
      q: { qx: NaN, qy: 0, qz: 0, qw: 1 },
    })),
  );
  analytic(
    "hold-stats/nan-quat",
    `time ${nanQuat.stats?.timeInWindowSec} markAlong ${nanQuat.stats?.markAlongCm} orient ${nanQuat.stats?.orientRmsDeg}`,
    nanQuat.stats?.timeInWindowSec === HOLD_WINDOW_SEC &&
      nanQuat.stats?.markAlongCm === -3 &&
      nanQuat.stats?.orientRmsDeg === null,
  );
  const gimbalQ = holdQuatPitch(89 * DEG2RAD);
  const gimbal = t(
    "gimbal-lock-skips-orientation-only",
    holdTape(HOLD_TAPE_FRAMES_ARMED, (i) => ({
      dAlong: (i % 2 === 0 ? 1 : -1) * 0.01,
      lat: 0,
      q: gimbalQ,
    })),
  );
  analytic(
    "hold-stats/gimbal-gate",
    `rms ${gimbal.stats?.stillnessRmsCm} orient ${gimbal.stats?.orientRmsDeg} (truth: position folds at 1 cm, yaw is meaningless)`,
    gimbal.stats?.stillnessRmsCm === 1 && gimbal.stats?.orientRmsDeg === null,
  );
  const pitchDisp = t(
    "orient-pitch-dispersion-2deg",
    holdTape(HOLD_TAPE_FRAMES_ARMED, (i) => ({
      dAlong: 0,
      lat: 0,
      q: holdQuatPitch((i % 2 === 0 ? 2 : -2) * DEG2RAD),
    })),
  );
  const yawDisp = t(
    "orient-yaw-dispersion-2deg",
    holdTape(HOLD_TAPE_FRAMES_ARMED, (i) => ({
      dAlong: 0,
      lat: 0,
      q: holdQuatYaw((i % 2 === 0 ? 2 : -2) * DEG2RAD),
    })),
  );
  const rss = t(
    "orient-rss-of-pitch-and-yaw",
    holdTape(HOLD_TAPE_FRAMES_ARMED, (i) => {
      const s = i % 2 === 0 ? 1 : -1;
      return { dAlong: 0, lat: 0, q: quatYawPitch(s * 2 * DEG2RAD, s * 2 * DEG2RAD) };
    }),
  );
  const seam = t(
    "orient-yaw-seam-unwrap",
    holdTape(HOLD_TAPE_FRAMES_ARMED, (i) => ({
      dAlong: 0,
      lat: 0,
      q: holdQuatYaw((i % 2 === 0 ? 1 : -1) * (Math.PI - 2 * DEG2RAD)),
    })),
  );
  analytic(
    "hold-stats/orientation-closed-forms",
    `pitch ${pitchDisp.stats?.orientRmsDeg}, yaw ${yawDisp.stats?.orientRmsDeg}, rss ${rss.stats?.orientRmsDeg}, seam ${seam.stats?.orientRmsDeg} (truth: 2 / 2 / 2.8 / 2 — never ~180)`,
    pitchDisp.stats?.orientRmsDeg === 2 &&
      yawDisp.stats?.orientRmsDeg === 2 &&
      rss.stats?.orientRmsDeg === 2.8 &&
      seam.stats?.orientRmsDeg === 2,
  );

  // --- the height ladder (fit -> walk -> ref) + the per-row stamp --------------
  const ref = t("height-ref-identity", holdSwayTape(0.02));
  const fit19 = t("height-fit-stamps-and-scales", holdSwayTape(0.02), { fit: 1.9 });
  analytic(
    "hold-stats/height-fit-rung",
    `ref ${ref.stats?.heightSource}/${ref.stats?.stillnessNormRmsCm}, fit ${fit19.stats?.heightSource}/${fit19.stats?.stillnessNormRmsCm}`,
    ref.stats?.heightSource === "ref" &&
      ref.stats?.headHeightM === 1.6 &&
      ref.stats?.stillnessRmsCm === 2 &&
      ref.stats?.stillnessNormRmsCm === 2 &&
      fit19.stats?.heightSource === "fit" &&
      fit19.stats?.headHeightM === 1.9 &&
      fit19.stats?.stillnessNormRmsCm === 1.7,
  );
  const tall = t(
    "height-equal-skill-normalizes-identically",
    holdSwayTape((0.02 * 1.9) / 1.6),
    { fit: 1.9 },
  );
  analytic(
    "hold-stats/equal-skill",
    `tall raw ${tall.stats?.stillnessRmsCm} norm ${tall.stats?.stillnessNormRmsCm} vs ref norm ${ref.stats?.stillnessNormRmsCm}`,
    tall.stats !== null &&
      tall.stats.stillnessRmsCm > ref.stats.stillnessRmsCm &&
      tall.stats.stillnessNormRmsCm === ref.stats.stillnessNormRmsCm,
  );
  const walkRung = t("height-walk-middle-rung", holdSwayTape(0.02), { walkBase: 1.8 });
  const bothRungs = t("height-fit-wins-over-walk", holdSwayTape(0.02), {
    fit: 1.9,
    walkBase: 1.8,
  });
  const lowWalk = t("height-low-walk-base-falls-to-ref", holdSwayTape(0.02), {
    walkBase: 0.4,
  });
  const nanWalk = t("height-nan-walk-base-falls-to-ref", holdSwayTape(0.02), {
    walkBase: NaN,
  });
  const junkFit = t("height-junk-fit-falls-to-walk", holdSwayTape(0.02), {
    fit: NaN,
    walkBase: 1.7,
  });
  analytic(
    "hold-stats/height-ladder",
    `walk ${walkRung.stats?.heightSource}/${walkRung.stats?.headHeightM}, both ${bothRungs.stats?.heightSource}, low ${lowWalk.stats?.heightSource}, nan ${nanWalk.stats?.heightSource}, junk-fit ${junkFit.stats?.heightSource}/${junkFit.stats?.headHeightM}`,
    walkRung.stats?.heightSource === "walk" &&
      walkRung.stats?.headHeightM === 1.8 &&
      bothRungs.stats?.heightSource === "fit" &&
      bothRungs.stats?.headHeightM === 1.9 &&
      lowWalk.stats?.heightSource === "ref" &&
      nanWalk.stats?.heightSource === "ref" &&
      junkFit.stats?.heightSource === "walk" &&
      junkFit.stats?.headHeightM === 1.7,
  );

  // --- the frozen-pose guard -----------------------------------------------------
  const frozenGuard = t(
    "frozen-pose-bit-repeats-zero-weight",
    Array.from({ length: HOLD_TAPE_FRAMES_ARMED }, (_, i) => ({
      t: (i + 1) * HOLD_TAPE_DT,
      dt: HOLD_TAPE_DT,
      dAlong: 0.1,
      lat: -0.05,
      q: Q_IDENTITY,
    })),
  );
  analytic(
    "hold-stats/frozen-pose-guard",
    `armed ${frozenGuard.armed} stats ${frozenGuard.stats} reason ${frozenGuard.nullReason} (truth: the guard runs BEFORE arming — a static camera never even ARMS; the read is null/no-data)`,
    frozenGuard.armed === false &&
      frozenGuard.stats === null &&
      frozenGuard.nullReason === "no-data",
  );
  const frozenOnMark = t(
    "frozen-pose-on-mark-zero-window",
    Array.from({ length: HOLD_TAPE_FRAMES_ARMED }, (_, i) => ({
      t: (i + 1) * HOLD_TAPE_DT,
      dt: HOLD_TAPE_DT,
      dAlong: 0,
      lat: 0,
      q: Q_IDENTITY,
    })),
  );
  analytic(
    "hold-stats/frozen-after-arming",
    `armed ${frozenOnMark.armed} stats ${frozenOnMark.stats} (truth: arms on the mark, but the arming frame folds 0 and every frozen repeat folds 0 — null/no-data)`,
    frozenOnMark.armed === true &&
      frozenOnMark.stats === null &&
      frozenOnMark.nullReason === "no-data",
  );
  const live8 = holdStillTape(0, 0).slice(0, 8);
  const f8 = holdStillTape(0, 0)[7];
  const freezeRecover = t("frozen-pose-speed-reseeds", [
    ...live8,
    ...Array.from({ length: 8 }, (_, k) => ({
      t: (9 + k) * HOLD_TAPE_DT,
      dt: HOLD_TAPE_DT,
      dAlong: f8.dAlong,
      lat: f8.lat,
      q: f8.q,
    })),
    ...Array.from({ length: HOLD_TAPE_FRAMES - 16 }, (_, k) => {
      const i = 16 + k;
      return {
        t: (i + 1) * HOLD_TAPE_DT,
        dt: HOLD_TAPE_DT,
        dAlong: 0.5,
        lat: 0,
        q: ditherQ(i),
      };
    }),
  ]);
  analytic(
    "hold-stats/freeze-never-differenced",
    `liveStill01 ${freezeRecover.liveStill01}, time ${freezeRecover.stats?.timeInWindowSec} (truth: 1 and 1.15 — armed at frame 0, frames 1-7 fold 0.35 s, the freeze folds 0, the recovery folds 0.80 s; the re-seed, not a phantom 10 m/s jump)`,
    freezeRecover.liveStill01 === 1 && freezeRecover.stats?.timeInWindowSec === 1.15,
  );

  // --- the ARMING law (the arrival gate) + the jointly-satisfiable pin ---------
  const approach = t(
    "arming-approach-never-arms",
    Array.from({ length: 7 }, (_, i) => ({
      t: (i + 1) * HOLD_TAPE_DT,
      dt: HOLD_TAPE_DT,
      dAlong: -0.4 + 0.0425 * (i + 1), // 0.85 m/s, still 0.11 m short
      lat: 0,
      q: ditherQ(i),
    })),
  );
  const armPos = t("arming-position-eps", [
    { t: 0.05, dt: 0.05, dAlong: -0.2, lat: 0, q: Q_IDENTITY },
    { t: 0.1, dt: 0.05, dAlong: -0.04, lat: 0, q: ditherQ(1) },
  ]);
  const armSpeed = t("arming-speed-short-of-mark", [
    { t: 0.05, dt: 0.05, dAlong: -0.3, lat: 0, q: Q_IDENTITY },
    { t: 0.1, dt: 0.05, dAlong: -0.295, lat: 0, q: ditherQ(1) }, // 0.1 m/s
  ]);
  analytic(
    "hold-stats/arming-law",
    `approach ${approach.armed}, position ${armPos.armed}@${armPos.armedAtSec}, speed ${armSpeed.armed}@${armSpeed.armedAtSec}`,
    approach.armed === false &&
      approach.stats === null &&
      armPos.armed === true &&
      armPos.armedAtSec === 0.1 &&
      armSpeed.armed === true &&
      armSpeed.armedAtSec === 0.1,
  );
  const transit085 = t("transit-decel-0.85mps-clean-hold", transitTape(0.85));
  const transit200 = t("transit-decel-2.0mps-clean-hold", transitTape(2.0));
  analytic(
    "hold-stats/honest-arrival-good-band",
    `0.85: still ${transit085.stats?.stillnessNormRmsCm} mark ${transit085.stats?.markErrCm}; 2.0: still ${transit200.stats?.stillnessNormRmsCm} mark ${transit200.stats?.markErrCm} (truth: the HOLD_ARRIVE_EPS_M residual-transit arithmetic — both inside the 2 cm / 15 cm good bands, full 1.6 s measured)`,
    transit085.stats !== null &&
      transit085.stats.timeInWindowSec === HOLD_WINDOW_SEC &&
      transit085.stats.stillnessNormRmsCm <= HOLD_STILL_GOOD_NORM_CM &&
      transit085.stats.markErrCm <= HOLD_MARK_GOOD_CM &&
      transit085.cue.endsWith("a clean hold.") &&
      transit200.stats !== null &&
      transit200.stats.stillnessNormRmsCm <= HOLD_STILL_GOOD_NORM_CM &&
      transit200.stats.markErrCm <= HOLD_MARK_GOOD_CM &&
      transit200.cue.endsWith("a clean hold."),
  );
  const rim = t("rim-freeze-mark-fault", rimFreezeTape());
  analytic(
    "hold-stats/rim-freeze-jointly-satisfiable",
    `still ${rim.stats?.stillnessRmsCm} mark ${rim.stats?.markErrCm}, cue "${rim.cue}" (truth: RMS 0 but markErr = 40 = HOLD_MARK_FAULT_CM — stopping at the latch rim earns the mark fault; the two bands are jointly satisfiable ONLY by an honest on-mark hold)`,
    rim.stats?.stillnessRmsCm === 0 &&
      rim.stats?.markErrCm === HOLD_MARK_FAULT_CM &&
      rim.cue ===
        "Your hold settled 40 cm short of the mark - walk all the way onto it before you set.",
  );
  const darkMarked = c("mark-reached-all-dark-window", [
    { fn: "tape", args: { frames: [], markReached: true } },
  ])[0];
  analytic(
    "hold-stats/wiring-side-mark-latch",
    `reason ${darkMarked.nullReason}, line "${darkMarked.line}" (truth: the wiring latches markReached() on the reachedMark edge BEFORE its finiteness gate, so an all-dark window reads no-data, never never-marked)`,
    darkMarked.stats === null &&
      darkMarked.nullReason === "no-data" &&
      darkMarked.line === "HOLD: NO READ - THE HOLD WINDOW WAS NOT MEASURED",
  );

  // --- finalize is non-destructive / height re-resolution ------------------------
  const repeatQ = { fn: "tape", args: { frames: holdStepTape(0.1), walkBase: 1.7 } };
  const repeated = c("finalize-repeatable", [repeatQ, repeatQ]);
  analytic(
    "hold-stats/finalize-non-destructive",
    `diff ${goldenDiff(repeated[0], repeated[1])}`,
    goldenDiff(repeated[0], repeated[1]) === null,
  );
  const reResolve = c("finalize-height-re-resolution", [
    { fn: "tape", args: { frames: holdSwayTape(0.02) } },
    { fn: "tape", args: { frames: holdSwayTape(0.02), walkBase: 1.8 } },
  ]);
  analytic(
    "hold-stats/height-re-resolution",
    `sources ${reResolve[0].stats?.heightSource}/${reResolve[1].stats?.heightSource}, raw ${reResolve[1].stats?.stillnessRmsCm}`,
    reResolve[0].stats?.heightSource === "ref" &&
      reResolve[1].stats?.heightSource === "walk" &&
      reResolve[1].stats?.stillnessRmsCm === 2,
  );

  // --- §D TWIN-PITCH (the SAME quaternion set as head-carriage; alternating
  // +-pitch under a fixed yaw makes orientRmsDeg read |pitch| exactly) --------
  const twinResults = c(
    "twin-pitch-shared-quats",
    TWIN_PITCH_SET.map((e) => ({
      fn: "tape",
      args: {
        frames: holdTape(HOLD_TAPE_FRAMES_ARMED, (i) => ({
          dAlong: 0,
          lat: 0,
          q: twinQuat(i % 2 === 0 ? e.pitchDeg : -e.pitchDeg, e.yawDeg),
        })),
      },
    })),
  );
  TWIN_PITCH_SET.forEach((e, i) => {
    const holdRms = twinResults[i].stats?.orientRmsDeg;
    const carriagePitch = runCarriageQueries([
      { fn: "tape", args: { ops: twinCarriageOps(twinQuat(e.pitchDeg, e.yawDeg)) } },
    ])[0].livePitchDevDeg;
    analytic(
      `hold-stats/twin-pitch ${e.pitchDeg} deg (§D cross-family)`,
      `hold orientRmsDeg ${holdRms} vs carriage |pitch| ${Math.abs(carriagePitch)} (truth: the two modules extract the SAME pitch)`,
      holdRms === Math.round(Math.abs(carriagePitch) * 10) / 10 &&
        Math.abs(Math.abs(carriagePitch) - Math.abs(e.pitchDeg)) <= 1e-9,
    );
  });

  // --- copy branch matrix (HoldStats literals — the holdStats() fixture) --------
  const copyResults = c("copy-branch-matrix", [
    {
      fn: "copy",
      args: {
        stats: holdStats({ timeInWindowSec: 1.6, stillnessRmsCm: 2.4, markErrCm: 11.2 }),
        nullReason: "never-marked",
      },
    },
    {
      fn: "copy",
      args: {
        stats: holdStats({ timeInWindowSec: 0.7, stillnessRmsCm: 1.9, markErrCm: 9 }),
        nullReason: "never-marked",
      },
    },
    { fn: "copy", args: { stats: null, nullReason: "never-marked" } },
    { fn: "copy", args: { stats: null, nullReason: "no-data" } },
    {
      // Drift fault CITES THE RAW cm and wins over the mark fault.
      fn: "copy",
      args: {
        stats: holdStats({
          stillnessRmsCm: 6.2,
          stillnessNormRmsCm: 5.2,
          markErrCm: 50,
          markAlongCm: 50,
          markLatCm: 2,
        }),
        nullReason: "never-marked",
      },
    },
    {
      fn: "copy",
      args: {
        stats: holdStats({ stillnessNormRmsCm: 3, markErrCm: 45, markAlongCm: -44, markLatCm: 9 }),
        nullReason: "never-marked",
      },
    },
    {
      fn: "copy",
      args: {
        stats: holdStats({ stillnessNormRmsCm: 3, markErrCm: 45, markAlongCm: 44, markLatCm: 9 }),
        nullReason: "never-marked",
      },
    },
    {
      // Diagonal miss: never names a side — the window can contain the turn.
      fn: "copy",
      args: {
        stats: holdStats({ stillnessNormRmsCm: 3, markErrCm: 42, markAlongCm: 30, markLatCm: 30 }),
        nullReason: "never-marked",
      },
    },
    {
      fn: "copy",
      args: {
        stats: holdStats({ stillnessRmsCm: 1.4, stillnessNormRmsCm: 1.4, markErrCm: 10 }),
        nullReason: "never-marked",
      },
    },
    {
      fn: "copy",
      args: {
        stats: holdStats({ stillnessRmsCm: 3.1, stillnessNormRmsCm: 3.1, markErrCm: 20 }),
        nullReason: "never-marked",
      },
    },
    {
      fn: "copy",
      args: {
        stats: holdStats({ stillnessRmsCm: 1.4, stillnessNormRmsCm: 1.4, markErrCm: 25 }),
        nullReason: "never-marked",
      },
    },
  ]);
  analytic(
    "hold-stats/copy-branches",
    `measured "${copyResults[0].line}", drift "${copyResults[4].cue}"`,
    copyResults[0].line === "HOLD 1.6S - STILL 2.4 CM - MARK 11 CM" &&
      copyResults[1].line === "HOLD 0.7S - STILL 1.9 CM - MARK 9 CM" &&
      copyResults[4].cue ===
        "You drifted 6.2 cm through the hold - hit the mark, freeze, count the beat." &&
      copyResults[5].cue ===
        "Your hold settled 45 cm short of the mark - walk all the way onto it before you set." &&
      copyResults[6].cue ===
        "Your hold settled 45 cm past the mark - stop on it, not through it." &&
      copyResults[7].cue ===
        "Your hold settled 42 cm off the mark - land it, square up, then freeze." &&
      copyResults[8].cue === "Held 1.4 cm still, 10 cm off the mark - a clean hold." &&
      copyResults[9].cue === null &&
      copyResults[10].cue === null,
  );

  c("hold-strings-and-constants", [{ fn: "tables" }]);

  return cases;
}

// =============================================================================
// repeatability — the M12 query matrix over literal wire-format rows.
// =============================================================================

function repeatabilityCases() {
  const cases = [];
  const c = (name, rows, queries) => {
    const results = runRepeatabilityQueries(rows, queries);
    cases.push({ name, input: { rows, queries }, expect: { results } });
    return results;
  };
  const report = { fn: "repeatabilityReport" };

  // --- the CV pin + the corrected outlier arithmetic ---------------------------
  const cvPin = c("cv-pin-three-walks", paceWalks([0.8, 0.85, 0.9]), [report])[0];
  analytic(
    "repeatability/cv-closed-form",
    `mean ${cvPin.pace.mean} sd ${cvPin.pace.sdSample} cv ${cvPin.pace.cvPct}`,
    Math.abs(cvPin.pace.mean - 0.85) <= 1e-12 &&
      Math.abs(cvPin.pace.sdSample - 0.05) <= 1e-12 &&
      Math.abs(cvPin.pace.cvPct - (100 * 0.05) / 0.85) <= 1e-9 &&
      cvPin.cadence === null &&
      cvPin.outlier === null,
  );
  analytic(
    "repeatability/within-is-an-upper-bound",
    `verdict "${cvPin.verdictLine}" (truth: 5.88 ceils to 6 — never rounds down)`,
    cvPin.verdictLine === "LAST 3 MATCHED WALKS AGREED WITHIN 6% ON PACE." &&
      cvPin.compactLine === "3 MATCHED WALKS: PACE SPREAD 6%" &&
      cvPin.detailLine === "PACE CV 6%",
  );

  // The M12 builder's CORRECTED 15%-outlier case (the roadmap's 12% exemplar
  // sits below the derived guard; 0.7225 = 0.85 * 0.85 -> exactly -15% vs
  // the others' mean).
  const outlierRows = paceWalks([0.84, 0.85, 0.85, 0.86, 0.7225]);
  const outlierNewest = c("outlier-newest-slower-15pct", outlierRows, [report])[0];
  analytic(
    "repeatability/corrected-outlier-arithmetic",
    `index ${outlierNewest.outlier?.index} deltaPct ${outlierNewest.outlier?.deltaPct} (truth: walk 5, exactly -15 vs the others' mean 0.85)`,
    outlierNewest.outlier !== null &&
      outlierNewest.outlier.index === 5 &&
      Math.abs(outlierNewest.outlier.deltaPct - -15) <= 1e-9 &&
      outlierNewest.verdictLine ===
        "WALKS 1-4 AGREED WITHIN 2% ON PACE; WALK 5 WAS 15% SLOWER." &&
      outlierNewest.compactLine.endsWith("- WALK 5 15% SLOW"),
  );
  const faster = c(
    "outlier-faster-direction",
    paceWalks([0.85, 0.85, 0.85, 0.9775]),
    [report],
  )[0];
  analytic(
    "repeatability/faster-template",
    `deltaPct ${faster.outlier?.deltaPct}, verdict "${faster.verdictLine}"`,
    Math.abs(faster.outlier.deltaPct - 15) <= 1e-9 &&
      faster.verdictLine === "WALKS 1-3 AGREED WITHIN 1% ON PACE; WALK 4 WAS 15% FASTER." &&
      faster.compactLine.endsWith("- WALK 4 15% FAST"),
  );
  const midOutlier = c(
    "outlier-mid-window-named-exception",
    paceWalks([0.85, 0.7225, 0.85, 0.85]),
    [report],
  )[0];
  analytic(
    "repeatability/named-exception-template",
    `verdict "${midOutlier.verdictLine}"`,
    midOutlier.outlier?.index === 2 &&
      midOutlier.verdictLine ===
        "WALK 2 WAS 15% SLOWER ON PACE THAN THE OTHER 3, WHICH AGREED WITHIN 1%.",
  );
  const uniform = c(
    "outlier-dominance-guard-uniform-spread",
    paceWalks([0.7, 0.85, 1.0]),
    [report],
  )[0];
  analytic(
    "repeatability/dominance-guard",
    `outlier ${uniform.outlier} (truth: null — m1 == m2 scapegoats nobody)`,
    uniform.outlier === null,
  );
  const partialVote = c(
    "outlier-requires-full-pace-voting",
    fullWalks([
      { pace: 0.85, cadence: 100 },
      { pace: null, cadence: 100 },
      { pace: 0.85, cadence: 100 },
      { pace: 0.85, cadence: 100 },
      { pace: 0.7225, cadence: 100 },
    ]),
    [report],
  )[0];
  analytic(
    "repeatability/full-voting-guard",
    `walks ${partialVote.walks} pace.n ${partialVote.pace?.n} outlier ${partialVote.outlier}`,
    partialVote.walks === 5 && partialVote.pace?.n === 4 && partialVote.outlier === null,
  );

  // --- the qualifying window (group-scoped recency) -----------------------------
  c("empty-history-null", [], [report]);
  c("below-min-walks-null", paceWalks([0.85, 0.86]), [report]);
  const interleaved = c(
    "window-interleaved-groups",
    [
      walkRow(0, { stats: slice({ meanPaceMps: 1.0 }) }),
      walkRow(1, { stats: slice({ meanPaceMps: 1.0 }) }),
      walkRow(2, { modeId: "challenge", stats: slice({ meanPaceMps: 2.0 }) }),
      walkRow(3, { stats: slice({ meanPaceMps: 0.8 }) }),
      walkRow(4, { stats: slice({ meanPaceMps: 0.82 }) }),
      walkRow(5, { modeId: "challenge", stats: slice({ meanPaceMps: 2.0 }) }),
      walkRow(6, { stats: slice({ meanPaceMps: 0.84 }) }),
      walkRow(7, { stats: slice({ meanPaceMps: 0.86 }) }),
      walkRow(8, { modeId: "challenge", stats: slice({ meanPaceMps: 2.0 }) }),
      walkRow(9, { stats: slice({ meanPaceMps: 0.88 }) }),
    ],
    [report],
  )[0];
  analytic(
    "repeatability/group-scoped-recency",
    `walks ${interleaved.walks} mean ${interleaved.pace?.mean} (truth: the last 5 GROUP rows -> mean 0.84)`,
    interleaved.walks === 5 && Math.abs(interleaved.pace.mean - 0.84) <= 1e-12,
  );
  const reversed = c(
    "window-input-order-invariance",
    [...outlierRows].reverse(),
    [report],
  )[0];
  analytic(
    "repeatability/order-invariance",
    `diff ${goldenDiff(reversed, outlierNewest)}`,
    goldenDiff(reversed, outlierNewest) === null,
  );
  const narrow = c(
    "window-narrower-argument",
    paceWalks([0.5, 0.5, 0.84, 0.85, 0.86]),
    [{ fn: "repeatabilityReport", args: { window: 3 } }],
  )[0];
  analytic(
    "repeatability/window-argument",
    `walks ${narrow.walks} mean ${narrow.pace?.mean}`,
    narrow.walks === 3 && Math.abs(narrow.pace.mean - 0.85) <= 1e-12,
  );

  // --- reference-row guards -----------------------------------------------------
  c(
    "ref-newest-mode-owns-window",
    [
      ...paceWalks([0.85, 0.85, 0.85]),
      walkRow(3, { modeId: "challenge", stats: slice({ meanPaceMps: 1.05 }) }),
    ],
    [report],
  );
  c(
    "ref-mixed-shape-never-aggregates",
    [
      ...paceWalks([0.85, 0.85, 0.85]),
      walkRow(3, { shapeKind: "U", stats: slice({ meanPaceMps: 0.85 }) }),
    ],
    [report],
  );
  const sensorSplit = c(
    "ref-sensor-is-a-different-ruler",
    [
      walkRow(0, { stats: slice({ meanPaceMps: 0.85 }) }),
      walkRow(1, { primarySource: "iphone-arkit", stats: slice({ meanPaceMps: 0.84 }) }),
      walkRow(2, { stats: slice({ meanPaceMps: 0.86 }) }),
      walkRow(3, { stats: slice({ meanPaceMps: 0.85 }) }),
    ],
    [report],
  )[0];
  analytic(
    "repeatability/sensor-split",
    `walks ${sensorSplit.walks} source ${sensorSplit.source}`,
    sensorSplit.walks === 3 && sensorSplit.source === "head",
  );
  c(
    "ref-legacy-shapekind-null",
    [
      ...paceWalks([0.85, 0.85, 0.85]),
      walkRow(3, { shapeKind: null, stats: slice({ meanPaceMps: 0.85 }) }),
    ],
    [report],
  );
  c(
    "ref-junk-modeid-null",
    [
      ...paceWalks([0.85, 0.85, 0.85]),
      walkRow(3, { modeId: "", stats: slice({ meanPaceMps: 0.85 }) }),
    ],
    [report],
  );
  const syntheticNewest = c(
    "ref-synthetic-newest-skipped",
    [
      ...paceWalks([0.8, 0.85, 0.9]),
      walkRow(3, {
        synthetic: true,
        primarySource: "preview",
        stats: slice({ meanPaceMps: 2.0 }),
      }),
    ],
    [report],
  )[0];
  analytic(
    "repeatability/synthetic-never-anchors",
    `walks ${syntheticNewest.walks} mean ${syntheticNewest.pace?.mean}`,
    syntheticNewest.walks === 3 && Math.abs(syntheticNewest.pace.mean - 0.85) <= 1e-12,
  );
  c(
    "unscored-rows-never-qualify",
    [
      ...paceWalks([0.85, 0.85]),
      walkRow(2, { overall: null, stats: slice({ meanPaceMps: 0.85 }) }),
    ],
    [report],
  );

  // --- the §A normalization stamp over LITERAL wire rows -------------------------
  const fitSplit = c(
    "norm-fit-row-splits-window",
    [
      walkRow(0, { normalization: "fit.v1-123", stats: slice({ meanPaceMps: 0.85 }) }),
      walkRow(1, { stats: slice({ meanPaceMps: 0.84 }) }),
      walkRow(2, { stats: slice({ meanPaceMps: 0.86 }) }),
      walkRow(3, { stats: slice({ meanPaceMps: 0.85 }) }),
    ],
    [report],
  )[0];
  const refitFresh = c(
    "norm-refit-starts-fresh-null",
    [
      ...paceWalks([0.85, 0.85, 0.85]),
      walkRow(3, { normalization: "fit.v1-123", stats: slice({ meanPaceMps: 0.85 }) }),
    ],
    [report],
  )[0];
  const legacyMerge = c(
    "norm-legacy-null-default-merge",
    [
      walkRow(0, { stats: slice({ meanPaceMps: 0.84 }) }),
      walkRow(1, { normalization: null, stats: slice({ meanPaceMps: 0.85 }) }),
      walkRow(2, { normalization: "default.v1", stats: slice({ meanPaceMps: 0.86 }) }),
    ],
    [report],
  )[0];
  analytic(
    "repeatability/§A-stamp-law",
    `fit-split walks ${fitSplit.walks}, re-fit ${refitFresh}, legacy-merge walks ${legacyMerge.walks}`,
    fitSplit.walks === 3 && refitFresh === null && legacyMerge.walks === 3,
  );
  const normTokens = c("row-normalization-tokens", [], [
    { fn: "rowNormalization", args: { row: {} } },
    { fn: "rowNormalization", args: { row: { normalization: null } } },
    { fn: "rowNormalization", args: { row: { normalization: "" } } },
    { fn: "rowNormalization", args: { row: { normalization: 42 } } },
    { fn: "rowNormalization", args: { row: { normalization: "fit.v1-123" } } },
  ]);
  analytic(
    "repeatability/§A-reader",
    `tokens [${normTokens}]`,
    normTokens[0] === "default.v1" &&
      normTokens[1] === "default.v1" &&
      normTokens[2] === "default.v1" &&
      normTokens[3] === "default.v1" &&
      normTokens[4] === "fit.v1-123",
  );

  // --- channel voting -------------------------------------------------------------
  const cadUnder = c(
    "channel-cadence-under-3-voters",
    fullWalks([
      { pace: 0.84, cadence: 100 },
      { pace: 0.85 },
      { pace: 0.85 },
      { pace: 0.85, cadence: 102 },
      { pace: 0.86 },
    ]),
    [report],
  )[0];
  analytic(
    "repeatability/channel-voters",
    `cadence ${cadUnder.cadence} pace.n ${cadUnder.pace?.n}`,
    cadUnder.cadence === null && cadUnder.pace?.n === 5,
  );
  const cadOnly = c(
    "channel-cadence-only-templates",
    fullWalks([{ cadence: 96 }, { cadence: 100 }, { cadence: 104 }]),
    [report],
  )[0];
  analytic(
    "repeatability/cadence-templates",
    `verdict "${cadOnly.verdictLine}"`,
    cadOnly.pace === null &&
      cadOnly.outlier === null &&
      cadOnly.verdictLine === "LAST 3 MATCHED WALKS AGREED WITHIN 4% ON CADENCE." &&
      cadOnly.compactLine === "3 MATCHED WALKS: CADENCE SPREAD 4%" &&
      cadOnly.detailLine === "CADENCE CV 4%",
  );
  const bothDark = c(
    "channel-both-dark-no-verdict",
    fullWalks([{ lateral: 0.02 }, { lateral: 0.03 }, { lateral: 0.04 }]),
    [report],
  )[0];
  analytic(
    "repeatability/no-relative-channel",
    `report ${bothDark}`,
    bothDark === null,
  );
  c(
    "channel-nonfinite-never-votes",
    fullWalks([
      { pace: 0.85, cadence: NaN },
      { pace: 0.85, cadence: 0 },
      { pace: 0.85, cadence: -5 },
      { pace: 0.85, cadence: 100 },
    ]),
    [report],
  );

  // --- detail line + display floors ------------------------------------------------
  const detail3 = c(
    "detail-three-segments-head-path-suffix",
    fullWalks([
      { pace: 0.8, cadence: 96, lateral: 0.02 },
      { pace: 0.85, cadence: 100, lateral: 0.024 },
      { pace: 0.9, cadence: 104, lateral: 0.028 },
    ]),
    [report],
  )[0];
  analytic(
    "repeatability/detail-line",
    `"${detail3.detailLine}" lateral ${detail3.lateralSpreadM}`,
    Math.abs(detail3.lateralSpreadM - 0.004) <= 1e-9 &&
      detail3.detailLine === "PACE CV 6% - CADENCE CV 4% - CENTER SD UNDER 1 CM (HEAD PATH)" &&
      detail3.verdictLine === "LAST 3 MATCHED WALKS AGREED WITHIN 6% ON PACE AND 4% ON CADENCE." &&
      detail3.compactLine === "3 MATCHED WALKS: PACE SPREAD 6%, CADENCE 4%",
  );
  const lateralDrop = c(
    "detail-lateral-under-3-voters-drops-suffix",
    fullWalks([
      { pace: 0.8, cadence: 96, lateral: 0.02 },
      { pace: 0.85, cadence: 100 },
      { pace: 0.9, cadence: 104, lateral: 0.028 },
    ]),
    [report],
  )[0];
  analytic(
    "repeatability/lateral-suffix-drops",
    `"${lateralDrop.detailLine}"`,
    lateralDrop.lateralSpreadM === null && lateralDrop.detailLine === "PACE CV 6% - CADENCE CV 4%",
  );
  const cmScale = c(
    "detail-cm-scale-spread",
    fullWalks([
      { pace: 0.85, lateral: 0.01 },
      { pace: 0.85, lateral: 0.05 },
      { pace: 0.85, lateral: 0.09 },
    ]),
    [report],
  )[0];
  analytic(
    "repeatability/cm-scale",
    `"${cmScale.detailLine}"`,
    Math.abs(cmScale.lateralSpreadM - 0.04) <= 1e-9 &&
      cmScale.detailLine === "PACE CV UNDER 1% - CENTER SD 4 CM (HEAD PATH)",
  );
  const identical = c("identical-walks-floor-1pct", paceWalks([0.85, 0.85, 0.85]), [
    report,
  ])[0];
  analytic(
    "repeatability/never-a-0pct-claim",
    `"${identical.verdictLine}" / "${identical.detailLine}"`,
    identical.verdictLine === "LAST 3 MATCHED WALKS AGREED WITHIN 1% ON PACE." &&
      identical.detailLine === "PACE CV UNDER 1%",
  );
  const withins = c("within-pct-ceil-with-floor", [], [
    { fn: "withinPct", args: { v: 0 } },
    { fn: "withinPct", args: { v: 0.2 } },
    { fn: "withinPct", args: { v: 4.4 } },
    { fn: "withinPct", args: { v: 6 } },
  ]);
  analytic(
    "repeatability/withinPct-law",
    `[${withins}] (truth: 1, 1, 5, 6 — ceil with a floor of 1)`,
    withins[0] === 1 && withins[1] === 1 && withins[2] === 5 && withins[3] === 6,
  );

  // --- the benchmark query layer ----------------------------------------------------
  const stampTrust = c("benchmark-stamp-trust", [], [
    { fn: "isBenchmarkRow", args: { row: walkRow(0) } },
    { fn: "isBenchmarkRow", args: { row: benchRow(0, 80) } },
    { fn: "isBenchmarkRow", args: { row: benchRow(0, 80, { modeId: "challenge" }) } },
  ]);
  analytic(
    "repeatability/stamp-trust",
    `[${stampTrust}] (truth: an unstamped beginner+straight legacy row is NOT a benchmark row)`,
    stampTrust[0] === false && stampTrust[1] === true && stampTrust[2] === true,
  );
  const newestGroup = c(
    "benchmark-rows-newest-group",
    [
      benchRow(0, 70),
      benchRow(1, 72, { normalization: "fit.v1-100" }),
      benchRow(2, 75),
      benchRow(3, 78),
    ],
    [{ fn: "benchmarkRows" }, { fn: "benchmarkSeries" }],
  );
  analytic(
    "repeatability/benchmark-group",
    `overalls [${newestGroup[0].map((r) => r.overall)}]`,
    goldenDiff(newestGroup[0].map((r) => r.overall), [70, 75, 78]) === null &&
      goldenDiff(newestGroup[1], [70, 75, 78]) === null,
  );
  const refitSeries = c(
    "benchmark-refit-fresh-series",
    [benchRow(0, 70), benchRow(1, 75), benchRow(2, 80, { normalization: "fit.v1-200" })],
    [{ fn: "benchmarkRows" }, { fn: "benchmarkHeadline" }, { fn: "benchmarkLine" }],
  );
  analytic(
    "repeatability/refit-is-a-baseline-not-a-trend",
    `group [${refitSeries[0].map((r) => r.overall)}], headline ${refitSeries[1]}`,
    goldenDiff(refitSeries[0].map((r) => r.overall), [80]) === null &&
      refitSeries[1] === null &&
      refitSeries[2] === null,
  );
  c(
    "benchmark-sensor-change-fresh-series",
    [benchRow(0, 70), benchRow(1, 75), benchRow(2, 80, { primarySource: "iphone-arkit" })],
    [{ fn: "benchmarkRows" }],
  );
  const negControl = c(
    "benchmark-section-a-negative-control",
    [
      benchRow(0, 70, { normalization: "fit.v1-123" }),
      benchRow(1, 75),
      benchRow(2, 80, { normalization: null }),
      benchRow(3, 85, { normalization: "default.v1" }),
    ],
    [{ fn: "benchmarkRows" }],
  )[0];
  analytic(
    "repeatability/§A-negative-control",
    `overalls [${negControl.map((r) => r.overall)}] (truth: absent/null/default.v1 merge; fit splits)`,
    goldenDiff(negControl.map((r) => r.overall), [75, 80, 85]) === null,
  );
  const dropJunk = c(
    "benchmark-synthetic-and-unscored-drop",
    [
      benchRow(0, 70),
      benchRow(1, 95, { synthetic: true, primarySource: "preview" }),
      { ...benchRow(2, 80), overall: null },
      benchRow(3, 78),
    ],
    [{ fn: "benchmarkRows" }],
  )[0];
  analytic(
    "repeatability/benchmark-qualifying-set",
    `overalls [${dropJunk.map((r) => r.overall)}]`,
    goldenDiff(dropJunk.map((r) => r.overall), [70, 78]) === null,
  );
  const capRows = Array.from({ length: SERIES_MAX + 5 }, (_, i) => benchRow(i, 60 + i));
  const capped = c("benchmark-series-cap", capRows, [
    { fn: "benchmarkSeries" },
    { fn: "benchmarkSeries", args: { max: 3 } },
  ]);
  analytic(
    "repeatability/series-cap",
    `len ${capped[0].length} first ${capped[0][0]} last3 [${capped[1]}]`,
    capped[0].length === SERIES_MAX &&
      capped[0][0] === 65 &&
      capped[0][capped[0].length - 1] === 60 + SERIES_MAX + 4 &&
      goldenDiff(capped[1], [60 + SERIES_MAX + 2, 60 + SERIES_MAX + 3, 60 + SERIES_MAX + 4]) ===
        null,
  );
  const headline = c(
    "benchmark-headline-rounded-delta",
    [benchRow(0, 71.4), benchRow(1, 79.2), benchRow(2, 83.6)],
    [{ fn: "benchmarkHeadline" }, { fn: "benchmarkLine" }],
  );
  analytic(
    "repeatability/delta-from-rounded-shown",
    `shown [${headline[0].shown}] delta ${headline[0].delta}, line "${headline[1]}"`,
    goldenDiff(headline[0].shown, [71, 79, 84]) === null &&
      headline[0].delta === 13 && // 84 - 71, never the raw 12.2
      headline[0].firstShownAt === 1000 &&
      headline[0].lastAt === 1000 + 2 * 60_000 &&
      headline[1] === "BENCHMARK 71 -> 79 -> 84 (+13)",
  );
  const lastThree = c(
    "benchmark-headline-last-3-of-4",
    [benchRow(0, 60), benchRow(1, 71), benchRow(2, 79), benchRow(3, 84)],
    [{ fn: "benchmarkHeadline" }],
  )[0];
  analytic(
    "repeatability/headline-window",
    `walks ${lastThree.walks} shown [${lastThree.shown}] firstShownAt ${lastThree.firstShownAt}`,
    lastThree.walks === 4 &&
      goldenDiff(lastThree.shown, [71, 79, 84]) === null &&
      lastThree.firstShownAt === 1000 + 60_000,
  );
  const twoRow = c(
    "benchmark-line-two-row-plus",
    [benchRow(0, 78), benchRow(1, 80)],
    [{ fn: "benchmarkHeadline" }, { fn: "benchmarkLine" }],
  );
  const even = c(
    "benchmark-line-even",
    [benchRow(0, 80), benchRow(1, 80)],
    [{ fn: "benchmarkLine" }],
  );
  const down = c(
    "benchmark-line-negative",
    [benchRow(0, 84), benchRow(1, 80)],
    [{ fn: "benchmarkLine" }],
  );
  analytic(
    "repeatability/line-suffix-branches",
    `"${twoRow[1]}" / "${even[0]}" / "${down[0]}"`,
    twoRow[1] === "BENCHMARK 78 -> 80 (+2)" &&
      even[0] === "BENCHMARK 80 -> 80 (EVEN)" &&
      down[0] === "BENCHMARK 84 -> 80 (-4)",
  );
  const underTwo = c(
    "benchmark-headline-under-2-null",
    [benchRow(0, 71)],
    [{ fn: "benchmarkHeadline" }, { fn: "benchmarkLine" }],
  );
  const unstamped = c(
    "benchmark-headline-unstamped-null",
    [walkRow(0), walkRow(1)],
    [{ fn: "benchmarkHeadline" }],
  );
  analytic(
    "repeatability/one-walk-is-a-baseline",
    `single ${underTwo[0]}, unstamped ${unstamped[0]}`,
    underTwo[0] === null && underTwo[1] === null && unstamped[0] === null,
  );
  const walkStart = c("benchmark-config-at-walk-start", [], [
    { fn: "benchmarkConfigAtWalkStart", args: { synthetic: false, modeId: "beginner", shapeKind: "straight" } },
    { fn: "benchmarkConfigAtWalkStart", args: { synthetic: true, modeId: "beginner", shapeKind: "straight" } },
    { fn: "benchmarkConfigAtWalkStart", args: { synthetic: false, modeId: "challenge", shapeKind: "straight" } },
    { fn: "benchmarkConfigAtWalkStart", args: { synthetic: false, modeId: "beginner", shapeKind: "T" } },
    { fn: "benchmarkConfigAtWalkStart", args: { synthetic: false, modeId: null, shapeKind: "straight" } },
    { fn: "benchmarkConfigAtWalkStart", args: { synthetic: false, modeId: "beginner", shapeKind: null } },
  ]);
  analytic(
    "repeatability/walk-start-predicate",
    `[${walkStart}]`,
    goldenDiff(walkStart, [true, false, false, false, false, false]) === null,
  );
  const finalizeRederive = c("benchmark-at-finalize-section-g", [], [
    { fn: "benchmarkAtFinalize", args: { stamped: true, modeId: "beginner" } },
    { fn: "benchmarkAtFinalize", args: { stamped: true, modeId: "challenge" } },
    { fn: "benchmarkAtFinalize", args: { stamped: false, modeId: "beginner" } },
    { fn: "benchmarkAtFinalize", args: { modeId: "beginner" } }, // stamped ABSENT
    { fn: "benchmarkAtFinalize", args: { stamped: true, modeId: null } },
  ]);
  analytic(
    "repeatability/§G-finalize-rederivation",
    `[${finalizeRederive}] (truth: only true+beginner survives the summary-stamp override)`,
    goldenDiff(finalizeRederive, [true, false, false, false, false]) === null,
  );

  c("repeat-constants-and-disclosures", [], [{ fn: "constants" }]);

  return cases;
}

// =============================================================================
// Wave 2 families — beat-stats / turn-stats (M9 BEAT LOCK + M11 THE TURN).
// Query-style cases over the SHARED runners in test/golden-replay.ts; op
// tapes come from the committed beat-helpers/turn-helpers builders and are
// SERIALIZED into the input (data, not rules; NaN/Infinity ride the sanitize
// sentinels). Wave 2 adjudication §F: the runners landed in the CODE commit
// (fa840f3+); this emitter + the GOLDEN_MODULES registration + the JSONs +
// the Swift mirror sync land in the VECTORS commit. Every `expect` is the
// live module's output over the recorded input; the analytic anchors below
// THROW before emitting.
// =============================================================================

// =============================================================================
// beat-stats — the M9 accumulator, estimator, chooser, clock bridge, pulse
// train and copy builders.
// =============================================================================

function beatStatsCases() {
  const cases = [];
  const c = (name, queries) => {
    const results = runBeatQueries(queries);
    cases.push({ name, input: { queries }, expect: { results } });
    return results;
  };
  const t = (name, ops, opts = {}) =>
    c(name, [{ fn: "tape", args: { ops, ...opts } }])[0];
  const tapeQ = (ops, opts = {}) => ({ fn: "tape", args: { ops, ...opts } });
  /** The suite's own locked-walker shorthand (2-beat grid, tight jitter). */
  const locked = (n, opts = {}) =>
    lockedTimes({
      n,
      periodSec: PERIOD_2X,
      sigmaBeats: 0.03,
      seed: opts.seed ?? 11,
      offsetSec: opts.offsetSec ?? 0,
    });

  // --- the estimator over the three strike-set builders -----------------------
  {
    const sigmas = [0.05, 0.16, 0.25];
    const rows = c(
      "locked-walker-tracks-wrapped-normal-rho",
      sigmas.map((sigma) => ({
        fn: "tape",
        args: {
          ops: strikeOps(
            lockedTimes({
              n: 200,
              periodSec: PERIOD_2X,
              sigmaBeats: sigma,
              seed: 42,
            }),
          ),
        },
      })),
    );
    sigmas.forEach((sigma, i) => {
      // Population resultant of a wrapped normal with SD sigma (in cycles) —
      // in-emitter analytic truth, never prose (adjudication §H).
      const rho = Math.exp(-((2 * Math.PI * sigma) ** 2) / 2);
      const s = rows[i].stats;
      analytic(
        `beat-stats/locked sigma=${sigma}`,
        `vectorR ${s?.vectorR} (truth: wrapped-normal rho ${rho.toFixed(4)} within 0.05)`,
        s !== null &&
          Math.abs(s.vectorR - rho) < 0.05 &&
          s.subdivision === "2-beat" &&
          s.gridSpm === 61 &&
          s.vectorR <= s.vectorRRaw + 1e-12,
      );
    });
  }
  {
    const rows = c(
      "uniform-chance-corrected-r-stays-small",
      [1, 2, 3].map((seed) => ({
        fn: "tape",
        args: {
          ops: strikeOps(uniformTimes({ n: 25, periodSec: PERIOD_2X, seed })),
        },
      })),
    );
    rows.forEach((r, i) => {
      analytic(
        `beat-stats/uniform seed=${i + 1}`,
        `vectorR ${r.stats?.vectorR} raw ${r.stats?.vectorRRaw} (truth: chance stays under 0.55; the correction only ever shrinks)`,
        r.stats !== null &&
          r.stats.vectorR < 0.55 &&
          r.stats.vectorR <= r.stats.vectorRRaw + 1e-12,
      );
    });
  }
  {
    // The exact-R_raw cluster builder: nCluster at phase 0 + nSpread evenly
    // spread (vector sum EXACTLY zero) -> R_raw = nCluster/(nCluster+nSpread).
    const rows = c("rayleigh-correction-exact-cluster-pins", [
      { fn: "tape", args: { ops: strikeOps(clusterTimes(40, 10, PERIOD_1X)) } },
      { fn: "tape", args: { ops: strikeOps(clusterTimes(8, 2, PERIOD_1X)) } },
    ]);
    const big = rows[0].stats;
    analytic(
      "beat-stats/§H-0.795-pin",
      `n ${big?.strikes} rRaw ${big?.vectorRRaw} r ${big?.vectorR} nR2 ${big?.rayleighNR2} (truth: n=50, R_raw=0.8 -> sqrt(31/49) = 0.795, NOT the spec prose's 0.797; nR2 = 32)`,
      big !== null &&
        big.strikes === 50 &&
        big.vectorRRaw === 0.8 &&
        big.vectorR === 0.795 &&
        big.vectorR === Math.round(Math.sqrt(31 / 49) * 1000) / 1000 &&
        big.vectorR !== 0.797 &&
        big.rayleighNR2 === 32 &&
        big.subdivision === "beat" &&
        big.gridSpm === 122 &&
        Math.abs(big.meanPhaseBeats) <= 0.001,
    );
    const small = rows[1].stats;
    analytic(
      "beat-stats/small-n-law",
      `n ${small?.strikes} rRaw ${small?.vectorRRaw} r ${small?.vectorR} (truth: n=10 at the SAME R_raw=0.8 corrects harder -> sqrt(5.4/9) = 0.775)`,
      small !== null &&
        small.strikes === 10 &&
        small.vectorRRaw === 0.8 &&
        small.vectorR === Math.round(Math.sqrt((10 * 0.64 - 1) / 9) * 1000) / 1000,
    );
  }
  {
    const rows = c("min-strikes-floor-edge", [
      {
        fn: "tape",
        args: {
          ops: strikeOps(
            lockedTimes({ n: BEAT_MIN_STRIKES, periodSec: PERIOD_2X, seed: 8 }),
          ),
        },
      },
      {
        fn: "tape",
        args: {
          ops: strikeOps(
            lockedTimes({
              n: BEAT_MIN_STRIKES - 1,
              periodSec: PERIOD_2X,
              seed: 8,
            }),
          ),
        },
      },
    ]);
    analytic(
      "beat-stats/floor-edge",
      `at ${rows[0].stats?.strikes}, under ${rows[1].nullReason}`,
      rows[0].stats !== null &&
        rows[0].stats.strikes === BEAT_MIN_STRIKES &&
        rows[1].stats === null &&
        rows[1].nullReason === "too-few-strikes" &&
        rows[1].line === "BEAT: NO READ - TOO FEW STRIKES WITH THE BEAT ON" &&
        rows[1].cue ===
          "Too few steps landed while the beat was on - the lock was not scored.",
    );
  }
  {
    const times = [];
    for (let k = 1; k <= 30; k++) times.push(k * PERIOD_2X);
    const r = t("perfect-lock-caps-the-score", strikeOps(times));
    analytic(
      "beat-stats/perfect-lock",
      `r ${r.stats?.vectorR} score ${r.stats?.beatScore} phase ${r.stats?.meanPhaseBeats} drift ${r.stats?.driftSpm}`,
      r.stats !== null &&
        r.stats.vectorR === 1 &&
        r.stats.beatScore === 100 &&
        r.stats.meanPhaseBeats === 0 &&
        r.stats.driftSpm === 0 &&
        r.line === "BEAT LOCK 100% - GRID 61/MIN - 30 STRIKES",
    );
  }
  {
    // Constant timing offsets (the head-bob detector lag class) rotate the
    // mean phase but never the lock — WHY vectorR is the primary number.
    const times = lockedTimes({
      n: 60,
      periodSec: PERIOD_2X,
      sigmaBeats: 0.12,
      seed: 7,
    });
    const rows = c("constant-offset-invariance", [
      tapeQ(strikeOps(times)),
      tapeQ(strikeOps(times.map((tm) => tm + 0.19))),
    ]);
    const a = rows[0].stats;
    const b = rows[1].stats;
    const shift = 0.19 / PERIOD_2X;
    analytic(
      "beat-stats/offset-invariance",
      `r ${a?.vectorR}/${b?.vectorR} phase ${a?.meanPhaseBeats} -> ${b?.meanPhaseBeats}`,
      a !== null &&
        b !== null &&
        b.vectorR === a.vectorR &&
        b.vectorRRaw === a.vectorRRaw &&
        b.driftSpm === a.driftSpm &&
        b.strikes === a.strikes &&
        b.meanPhaseBeats !== a.meanPhaseBeats &&
        Math.abs(wrapPhaseBeats(b.meanPhaseBeats - a.meanPhaseBeats - shift)) <
          0.01,
    );
  }
  {
    // THE CLOCK BRIDGE: co-sampled stamps vs the naive-conversion
    // counterfactual under a 1% ECS-vs-audio skew (computed here, never
    // shipped) — the reason the wiring stamps audioNow - go per frame.
    const audioTimes = [];
    for (let k = 1; k <= 122; k++) audioTimes.push(k * BEAT);
    const rows = c("clock-bridge-co-sample-vs-skew", [
      tapeQ(strikeOps(audioTimes)),
      tapeQ(strikeOps(audioTimes.map((tm) => tm * 1.01))),
    ]);
    analytic(
      "beat-stats/co-sampling-law",
      `co r ${rows[0].stats?.vectorR}, naive r ${rows[1].stats?.vectorR} (truth: invisible co-sampled, fatal converted)`,
      rows[0].stats !== null &&
        rows[0].stats.gridSpm === 122 &&
        rows[0].stats.vectorR > 0.95 &&
        rows[1].stats !== null &&
        rows[1].stats.gridSpm === 122 &&
        rows[1].stats.vectorR < 0.75,
    );
  }

  // --- wiring-feed tapes -------------------------------------------------------
  {
    const times = locked(12);
    const ops = [];
    for (const tm of times) {
      ops.push({ op: "frame", dt: PERIOD_2X, strikeAt: tm });
      // The cached-camera-frame re-fire: the SAME stamp delivered again...
      ops.push({ op: "frame", dt: PERIOD_2X, strikeAt: tm });
      // ...and a near-dupe inside the debounce window.
      ops.push({
        op: "frame",
        dt: PERIOD_2X,
        strikeAt: tm + BEAT_STRIKE_DEBOUNCE_SEC / 2,
      });
    }
    const r = t("debounce-refire-never-double-counts", ops);
    analytic(
      "beat-stats/debounce",
      `strikes ${r.stats?.strikes} (truth: 12)`,
      r.stats?.strikes === 12,
    );
  }
  {
    const preSpan = 30 * PERIOD_2X;
    const pre = uniformTimes({ n: 30, periodSec: PERIOD_2X, seed: 3 });
    const post = locked(15, { offsetSec: preSpan, seed: 4 });
    const r = t("void-handoff-surviving-span-scores", [
      ...strikeOps(pre, { source: "head" }),
      { op: "void" },
      ...strikeOps(post, { source: "camera-world" }, pre[pre.length - 1]),
    ]);
    analytic(
      "beat-stats/void-handoff",
      `strikes ${r.stats?.strikes} source ${r.stats?.strikeSource} r ${r.stats?.vectorR} refSec ${r.stats?.refSec}`,
      r.stats !== null &&
        r.stats.strikes === 15 &&
        r.stats.strikeSource === "camera-world" &&
        r.stats.vectorR > 0.85 &&
        // refSec SURVIVES the void — delivery disclosure is walk-wide.
        r.stats.refSec > preSpan,
    );
  }
  {
    // Coverage: the metrics.ts choke point stamps strikeSource from the
    // frame's own arbitration state — "head" | "camera-world" |
    // "camera-image" (walk-stats source labels). The first two are pinned by
    // the void-handoff case above; this locks the third so the Swift port's
    // source-label handling is exercised for every reachable branch (the
    // walk-stats source-coverage precedent).
    const times = locked(15, { seed: 9 });
    const r = t(
      "strike-source-camera-image",
      strikeOps(times, { source: "camera-image" }),
    );
    analytic(
      "beat-stats/camera-image-source",
      `strikes ${r.stats?.strikes} source ${r.stats?.strikeSource}`,
      r.stats !== null &&
        r.stats.strikes === 15 &&
        r.stats.strikeSource === "camera-image",
    );
  }
  {
    const pre = locked(20, { seed: 5 });
    const post = locked(BEAT_MIN_STRIKES - 2, {
      offsetSec: 20 * PERIOD_2X,
      seed: 6,
    });
    const r = t("void-handoff-under-floor-null", [
      ...strikeOps(pre),
      { op: "void" },
      ...strikeOps(post, {}, pre[pre.length - 1]),
    ]);
    analytic(
      "beat-stats/handoff-under-floor",
      `stats ${r.stats} reason ${r.nullReason}`,
      r.stats === null && r.nullReason === "too-few-strikes",
    );
  }
  {
    // THE REFERENCE GATE: music muted mid-walk TRUNCATES (counting stops)
    // and resumes on the SAME absolute grid; refSec discloses the mute span.
    const times = lockedTimes({
      n: 36,
      periodSec: PERIOD_2X,
      sigmaBeats: 0.05,
      seed: 5,
    });
    const gated = [];
    let prev = 0;
    let mutedSec = 0;
    times.forEach((tm, i) => {
      const muted = i >= 12 && i < 24; // the middle third
      if (muted) mutedSec += tm - prev;
      gated.push({ op: "frame", dt: tm - prev, strikeAt: tm, musicOn: !muted });
      prev = tm;
    });
    const rows = c("reference-gate-mute-mid-walk-truncates", [
      tapeQ(gated),
      tapeQ(strikeOps(times)),
    ]);
    const g = rows[0].stats;
    const full = rows[1].stats;
    const total = times[times.length - 1];
    analytic(
      "beat-stats/mute-truncates-same-grid",
      `strikes ${g?.strikes} r ${g?.vectorR} refSec ${g?.refSec} vs full ${full?.refSec} (truth: 24 counted, lock survives on the unmoved grid, refSec ~ ${(total - mutedSec).toFixed(1)})`,
      g !== null &&
        full !== null &&
        g.strikes === 24 &&
        g.vectorR > 0.9 &&
        Math.abs(g.vectorR - full.vectorR) < 0.05 &&
        Math.abs(g.meanPhaseBeats - full.meanPhaseBeats) < 0.03 &&
        Math.abs(g.refSec - (total - mutedSec)) <= 0.5 &&
        g.refSec < full.refSec,
    );
  }
  {
    const times20 = locked(20);
    const rows = c("reference-kinds-fixed-order-label", [
      tapeQ(strikeOps(locked(14), { musicOn: false, hapticKind: "haptic" })),
      tapeQ(
        times20.map((tm, i) =>
          i < 10
            ? {
                op: "frame",
                dt: PERIOD_2X,
                strikeAt: tm,
                musicOn: false,
                hapticKind: "earcon",
              }
            : { op: "frame", dt: PERIOD_2X, strikeAt: tm, musicOn: true },
        ),
      ),
      tapeQ(
        times20.map((tm) => ({
          op: "frame",
          dt: PERIOD_2X,
          strikeAt: tm,
          musicOn: true,
          hapticKind: "haptic",
        })),
      ),
      tapeQ(
        times20.map((tm, i) => ({
          op: "frame",
          dt: PERIOD_2X,
          strikeAt: tm,
          musicOn: i % 2 === 0,
          hapticKind: i < 10 ? "haptic" : "earcon",
        })),
      ),
    ]);
    analytic(
      "beat-stats/reference-labels",
      `[${rows.map((r) => r.stats?.reference)}] (truth: haptic-only scores; label unions in fixed order regardless of chronology)`,
      rows[0].stats?.reference === "haptic" &&
        rows[0].stats?.strikes === 14 &&
        rows[1].stats?.reference === "music+earcon" &&
        rows[2].stats?.reference === "music+haptic" &&
        rows[3].stats?.reference === "music+haptic+earcon",
    );
  }
  {
    // Suspended ctx (frozen audio clock): the wiring WITHHOLDS addStrike —
    // the tape models the withheld call, not a gated one.
    const times = locked(24);
    const r = t(
      "suspended-ctx-withholds-strikes",
      times.map((tm, i) => ({
        op: "frame",
        dt: PERIOD_2X,
        strikeAt: tm,
        ctxRunning: !(i >= 8 && i < 16),
      })),
    );
    analytic(
      "beat-stats/suspended-ctx",
      `strikes ${r.stats?.strikes} (truth: 16 of 24)`,
      r.stats?.strikes === 16,
    );
  }
  {
    const emptyFrames = [];
    for (let i = 0; i < 40; i++) emptyFrames.push({ op: "frame", musicOn: true });
    const rows = c("null-reason-taxonomy", [
      tapeQ(
        strikeOps(lockedTimes({ n: 20, periodSec: PERIOD_2X, seed: 2 }), {
          musicOn: false,
        }),
      ),
      tapeQ(strikeOps(lockedTimes({ n: 20, periodSec: PERIOD_2X, seed: 2 })), {
        goValid: false,
      }),
      tapeQ(emptyFrames),
    ]);
    analytic(
      "beat-stats/null-taxonomy",
      `[${rows.map((r) => r.nullReason)}] (truth: no-reference / no-clock wins over everything / too-few-strikes)`,
      rows[0].stats === null &&
        rows[0].nullReason === "no-reference" &&
        rows[0].line === "BEAT: NO READ - NO BEAT REFERENCE WAS DELIVERED" &&
        rows[0].cue ===
          "No beat reached you this walk - turn on music or the beat pulse and the lock is scored." &&
        rows[1].stats === null &&
        rows[1].nullReason === "no-clock" &&
        rows[1].line === "BEAT: NO READ - THE BEAT CLOCK WAS NOT ARMED" &&
        rows[1].cue === null &&
        rows[2].stats === null &&
        rows[2].nullReason === "too-few-strikes",
    );
  }
  {
    // Law-6 gates: junk stamps/deltas contribute NOTHING (the mid-tape
    // finalize pins that the junk never accrued refSec — reason
    // no-reference, not too-few-strikes), and the NaN stamp never anchors
    // the debounce (the clean feed after it counts in full).
    const r = t("dark-inputs-contribute-nothing", [
      { op: "frame", dt: NaN, strikeAt: NaN },
      { op: "frame", dt: -0.5 },
      { op: "frame", dt: 0 },
      { op: "finalize" },
      ...strikeOps(locked(12)),
    ]);
    analytic(
      "beat-stats/law6-junk",
      `mid ${r.finals?.[0]?.nullReason}, final strikes ${r.stats?.strikes}`,
      r.finals[0].stats === null &&
        r.finals[0].nullReason === "no-reference" &&
        r.stats !== null &&
        r.stats.strikes === 12,
    );
  }
  {
    // Mid-walk runway remap: a DOCUMENTED no-op on M9 (geometry-blind) —
    // the contrast case to the lateral channel's reset, byte-for-byte.
    const times = locked(16);
    const remapOps = strikeOps(times);
    remapOps.splice(8, 0, { op: "remap" });
    const rows = c("remap-is-a-no-op", [
      tapeQ(strikeOps(times)),
      tapeQ(remapOps),
    ]);
    analytic(
      "beat-stats/remap-noop",
      `diff ${goldenDiff(rows[1], rows[0])}`,
      goldenDiff(rows[1], rows[0]) === null,
    );
  }
  {
    // WALK END (adjudication §D, director-finalizes-first): the summary is
    // stamped BEFORE the finishing frame's strike — exactly one strike (and
    // its addRefTime slice) is excluded from the stamped row.
    const ops = strikeOps(locked(12, { seed: 9 }));
    const r = t("walk-end-director-finalizes-first", [
      ...ops.slice(0, -1),
      { op: "finalize" },
      ...ops.slice(-1),
    ]);
    const director = r.finals[0];
    analytic(
      "beat-stats/§D-final-strike-excluded",
      `director ${director.stats?.strikes} vs after ${r.stats?.strikes}; refSec ${director.stats?.refSec} < ${r.stats?.refSec}`,
      director.stats !== null &&
        director.stats.strikes === 11 &&
        r.stats !== null &&
        r.stats.strikes === 12 &&
        r.stats.strikes - director.stats.strikes === 1 &&
        director.stats.refSec < r.stats.refSec,
    );
  }
  {
    // Cadence interval floor: 3-beat spacing (1.48 s) is gated out of the
    // interval chain (> STEP_MAX) — phase still folds, cadence cannot.
    const times = [];
    for (let k = 1; k <= 10; k++) times.push(k * 3 * BEAT);
    const r = t("cadence-under-interval-floor-null", strikeOps(times));
    analytic(
      "beat-stats/cadence-gate",
      `cadence ${r.stats?.cadenceSpm} drift ${r.stats?.driftSpm} sub ${r.stats?.subdivision}`,
      r.stats !== null &&
        r.stats.cadenceSpm === null &&
        r.stats.driftSpm === null &&
        r.stats.subdivision === "2-beat",
    );
  }
  {
    // The FIT natural-cadence seed steers the chooser ONLY through the dead
    // zone; a non-finite FIT reads as null (law-6 gate at reset()).
    const period = 60 / 86; // a dead-zone walker (~86 spm)
    const times = [];
    for (let k = 1; k <= 20; k++) times.push(k * period);
    const rows = c("fit-seed-steers-only-the-dead-zone", [
      { fn: "tape", args: { ops: strikeOps(times), fit: 100 } },
      { fn: "tape", args: { ops: strikeOps(times) } },
      { fn: "tape", args: { ops: strikeOps(times), fit: NaN } },
    ]);
    analytic(
      "beat-stats/fit-dead-zone",
      `[${rows.map((r) => r.stats?.subdivision)}] (truth: beat / 2-beat / 2-beat)`,
      rows[0].stats?.subdivision === "beat" &&
        rows[1].stats?.subdivision === "2-beat" &&
        rows[2].stats?.subdivision === "2-beat",
    );
  }

  // --- per-tempo scoring (the multi-BPM wave: heard = felt = scored) -----------
  {
    // 62 BPM half-time (the founder's option semantics: music at half the
    // emerging step rate): a locked ~124 spm walker is ON the half-beat
    // grid — on the old single-tempo model every other strike landed
    // mid-beat and read as chance.
    const halfBeat = 60 / 124;
    const r = t(
      "tempo-62-half-time-locks-the-half-beat",
      strikeOps(
        lockedTimes({ n: 30, periodSec: halfBeat, sigmaBeats: 0.04, seed: 21 }),
      ),
      { bpm: 62 },
    );
    analytic(
      "beat-stats/62-half-beat",
      `sub ${r.stats?.subdivision} grid ${r.stats?.gridSpm} r ${r.stats?.vectorR}`,
      r.stats !== null &&
        r.stats.subdivision === "half-beat" &&
        r.stats.gridSpm === 124 &&
        r.stats.vectorR > 0.9,
    );
  }
  {
    const r = t(
      "tempo-100-everyday-locks-the-beat",
      strikeOps(
        lockedTimes({ n: 24, periodSec: 60 / 100, sigmaBeats: 0.04, seed: 22 }),
      ),
      { bpm: 100 },
    );
    analytic(
      "beat-stats/100-beat",
      `sub ${r.stats?.subdivision} grid ${r.stats?.gridSpm} r ${r.stats?.vectorR}`,
      r.stats !== null &&
        r.stats.subdivision === "beat" &&
        r.stats.gridSpm === 100 &&
        r.stats.vectorR > 0.9,
    );
  }
  {
    // The review's confirmed finding, pinned: the 50 spm slow candidate's
    // period is exactly STEP_MAX (1.2 s) — a hard interval ceiling truncated
    // the long half of a LOCKED 50 spm walker's intervals, biased cadence
    // past the 2 spm direction floor and coached "ran ahead" at a locked
    // walker. The grid-aware ceiling (intMaxSec) keeps |drift| under the
    // floor and the cue "Locked".
    const r = t(
      "tempo-100-locked-50spm-never-false-direction",
      strikeOps(
        lockedTimes({ n: 16, periodSec: 60 / 50, sigmaBeats: 0.04, seed: 1 }),
      ),
      { bpm: 100 },
    );
    analytic(
      "beat-stats/no-false-direction-at-50spm",
      `sub ${r.stats?.subdivision} grid ${r.stats?.gridSpm} drift ${r.stats?.driftSpm} cue "${r.cue}"`,
      r.stats !== null &&
        r.stats.subdivision === "2-beat" &&
        r.stats.gridSpm === 50 &&
        r.stats.vectorR > 0.9 &&
        Math.abs(r.stats.driftSpm) < 2 &&
        r.cue !== null &&
        r.cue.startsWith("Locked to the beat"),
    );
  }
  {
    // 125 BPM: a slow stroller lands the FRACTIONAL 62.5 2-beat grid, and
    // the stat line prints the honest fraction.
    const r = t(
      "tempo-125-fractional-2-beat-grid",
      strikeOps(
        lockedTimes({ n: 15, periodSec: 60 / 62.5, sigmaBeats: 0.03, seed: 23 }),
      ),
      { bpm: 125 },
    );
    analytic(
      "beat-stats/125-fractional-grid",
      `sub ${r.stats?.subdivision} grid ${r.stats?.gridSpm} line "${r.line}"`,
      r.stats !== null &&
        r.stats.subdivision === "2-beat" &&
        r.stats.gridSpm === 62.5 &&
        r.stats.vectorR > 0.9 &&
        r.line.includes("GRID 62.5/MIN"),
    );
  }
  {
    // The tempo is a scored CONDITION: identical strike times against a
    // different latched tempo is a different measurement (why the walk row
    // stamps musicBpm).
    const times = lockedTimes({
      n: 24,
      periodSec: 60 / 100,
      sigmaBeats: 0.03,
      seed: 24,
    });
    const rows = c("tempo-is-a-scored-condition", [
      { fn: "tape", args: { ops: strikeOps(times), bpm: 100 } },
      { fn: "tape", args: { ops: strikeOps(times), bpm: 125 } },
    ]);
    analytic(
      "beat-stats/tempo-condition",
      `r@100 ${rows[0].stats?.vectorR} vs r@125 ${rows[1].stats?.vectorR}`,
      rows[0].stats !== null &&
        rows[1].stats !== null &&
        rows[0].stats.vectorR > 0.9 &&
        rows[1].stats.vectorR < rows[0].stats.vectorR,
    );
  }
  {
    // A junk latched tempo invalidates the run like a dead clock (law-6 at
    // reset: without a tempo the grid never validly existed).
    const junkTimes = lockedTimes({ n: 20, periodSec: PERIOD_2X, seed: 2 });
    const rows = c("tempo-junk-reads-no-clock", [
      { fn: "tape", args: { ops: strikeOps(junkTimes), bpm: NaN } },
      { fn: "tape", args: { ops: strikeOps(junkTimes), bpm: 0 } },
    ]);
    analytic(
      "beat-stats/junk-tempo",
      `[${rows.map((r) => r.nullReason)}] (truth: no-clock both)`,
      rows[0].stats === null &&
        rows[0].nullReason === "no-clock" &&
        rows[1].stats === null &&
        rows[1].nullReason === "no-clock",
    );
  }
  {
    // The per-tempo pulse train: the hand pulses the DELIVERED beat grid.
    const go = 300;
    const rows = c(
      "pulse-train-per-tempo",
      [62, 100, 125].flatMap((bpm) => [
        { fn: "firstTick", args: { now: go - COUNTDOWN_SEC, go, bpm } },
        {
          fn: "advanceTick",
          args: { next: go + 4 * (60 / bpm), now: go + 4 * (60 / bpm), bpm },
        },
      ]),
    );
    [62, 100, 125].forEach((bpm, i) => {
      const beat = 60 / bpm;
      const first = rows[i * 2];
      const adv = rows[i * 2 + 1];
      analytic(
        `beat-stats/pulse-train@${bpm}`,
        `first ${first} adv ${adv} (truth: on the ${bpm} BPM go-anchored grid)`,
        Math.abs((first - go) / beat - Math.round((first - go) / beat)) < 1e-9 &&
          first >= go - COUNTDOWN_SEC + BEAT_PULSE_LEAD_SEC &&
          Math.abs(adv - (go + 5 * beat)) < 1e-9,
      );
    });
  }

  // --- the pure helpers ---------------------------------------------------------
  {
    const B = beatGridCandidates(122).boundarySpm; // the fixture pair's boundary
    const D = BEAT_SUBDIV_DEADZONE_SPM;
    const matrix = [
      [61, null],
      [122, null],
      [90.4, null], // outside the zone: the cadence's own side
      [85, 95], // dead zone, decisive FIT high side
      [85, 75], // dead zone, decisive FIT low side
      [85, null], // dead zone, no FIT -> the cadence's exact side
      [86.2, null], // just under B
      [86.35, null], // just over B
      [85, 88], // FIT itself inside the zone is NOT decisive
      [B, null], // >= B = the fast side
      [null, 95], // cadence null: FIT decides at any value
      [null, 70],
      [null, 85],
      [null, null], // both null -> the 2-beat product default
      [NaN, null], // non-finite reads as null (law-6)
      [85, NaN],
      [null, Infinity],
      [B + D + 0.01, 60], // just outside: cadence wins over FIT
      [B + D - 0.01, 60], // just inside: FIT (decisive, low side) wins
    ];
    const rows = c(
      "subdivision-chooser-matrix",
      // bpm rides the query as EXPLICIT fixture data (the multi-BPM wave).
      matrix.map(([cadence, fit]) => ({
        fn: "chooser",
        args: { cadence, fit, bpm: 122 },
      })),
    );
    analytic(
      "beat-stats/chooser-matrix",
      `[${rows}]`,
      goldenDiff(rows, [
        "2-beat",
        "beat",
        "beat",
        "beat",
        "2-beat",
        "2-beat",
        "2-beat",
        "beat",
        "2-beat",
        "beat",
        "beat",
        "2-beat",
        "2-beat",
        "2-beat",
        "2-beat",
        "2-beat",
        "2-beat",
        "beat",
        "2-beat",
      ]) === null,
    );
  }
  {
    const now = 100;
    const rows = c("go-audio-time-freshness-window", [
      { fn: "goFresh", args: { now, go: now } },
      { fn: "goFresh", args: { now, go: now - BEAT_GO_STALE_BEFORE_SEC } },
      { fn: "goFresh", args: { now, go: now + BEAT_GO_FRESH_AFTER_SEC } },
      { fn: "goFresh", args: { now, go: now - BEAT_GO_STALE_BEFORE_SEC - 1e-9 } },
      { fn: "goFresh", args: { now, go: now + BEAT_GO_FRESH_AFTER_SEC + 1e-9 } },
      { fn: "goFresh", args: { now, go: now - 40 } }, // a previous run's anchor
      { fn: "goFresh", args: { now, go: now + 1 } }, // the future is never fresh
      { fn: "goFresh", args: { now, go: null } },
      { fn: "goFresh", args: { now, go: NaN } },
      { fn: "goFresh", args: { now, go: Infinity } },
      { fn: "goFresh", args: { now, go: "99.9" } }, // junk global: type-gated
    ]);
    analytic(
      "beat-stats/go-window-arithmetic",
      `[${rows}] (truth: edges INCLUSIVE, both sides strict past them, junk rejected)`,
      goldenDiff(rows, [
        true,
        true,
        true,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
      ]) === null,
    );
  }
  {
    const rows = c(
      "wrap-phase-edges",
      [0.5, -0.5, 0, 0.25, 1.25, -1.3, 3.5].map((x) => ({
        fn: "wrap",
        args: { x },
      })),
    );
    analytic(
      "beat-stats/wrap-edges",
      `[${rows}] (truth: the +0.5 edge always folds to -0.5 — half-open by construction)`,
      Object.is(rows[0], -0.5) &&
        rows[1] === -0.5 &&
        rows[2] === 0 &&
        rows[3] === 0.25 &&
        rows[4] === 0.25 &&
        Math.abs(rows[5] - -0.3) < 1e-12 &&
        rows[6] === -0.5,
    );
  }
  {
    const go = 200;
    const rows = c("pulse-train-arithmetic", [
      { fn: "firstTick", args: { now: go - COUNTDOWN_SEC, go } },
      { fn: "firstTick", args: { now: go + 10.3, go } },
      {
        fn: "advanceTick",
        args: { next: go + 4 * BEAT, now: go + 4 * BEAT - BEAT_PULSE_LEAD_SEC + 0.001 },
      },
      { fn: "advanceTick", args: { next: go, now: go + 3 * BEAT + 0.1 } },
      ...[0, 1, 2, 3, 4, 5, 6].map((k) => ({
        fn: "flam",
        args: { pulse: go - k * BEAT, go },
      })),
      { fn: "flam", args: { pulse: go - 1 - 0.01, go } },
      { fn: "flam", args: { pulse: go - 1 + BEAT_FLAM_SUPPRESS_SEC, go } },
      { fn: "flam", args: { pulse: NaN, go } },
    ]);
    const t0 = rows[0];
    analytic(
      "beat-stats/first-tick-countdown-edge",
      `t ${t0} (truth: on the go-anchored grid, at-or-after now+lead, k = -6, +6 beats hits GO exactly)`,
      Math.abs((t0 - go) / BEAT - Math.round((t0 - go) / BEAT)) < 1e-9 &&
        t0 >= go - COUNTDOWN_SEC + BEAT_PULSE_LEAD_SEC &&
        t0 - (go - COUNTDOWN_SEC + BEAT_PULSE_LEAD_SEC) < BEAT &&
        Math.round((t0 - go) / BEAT) === -6 &&
        Math.abs(t0 + 6 * BEAT - go) < 1e-9,
    );
    const t1 = rows[1];
    analytic(
      "beat-stats/first-tick-mid-walk-enable",
      `t ${t1} (truth: the cached-anchor enable lands on-grid ahead of now)`,
      t1 >= go + 10.3 + BEAT_PULSE_LEAD_SEC &&
        t1 - (go + 10.3 + BEAT_PULSE_LEAD_SEC) < BEAT &&
        Math.abs((t1 - go) / BEAT - Math.round((t1 - go) / BEAT)) < 1e-9,
    );
    analytic(
      "beat-stats/advance-one-beat",
      `t ${rows[2]} (truth: the normal fire path lands exactly one beat later)`,
      Math.abs(rows[2] - (go + 5 * BEAT)) < 1e-12,
    );
    const t3 = rows[3];
    analytic(
      "beat-stats/advance-skips-without-burst",
      `t ${t3} (truth: a GC hitch never burst-fires catchup pulses)`,
      t3 > go + 3 * BEAT + 0.1 + BEAT_PULSE_LEAD_SEC &&
        t3 - (go + 3 * BEAT + 0.1 + BEAT_PULSE_LEAD_SEC) <= BEAT &&
        Math.abs((t3 - go) / BEAT - Math.round((t3 - go) / BEAT)) < 1e-9,
    );
    const flams = rows.slice(4, 11);
    analytic(
      "beat-stats/three-flam-suppression",
      `[${flams}] then ${rows[11]}/${rows[12]}/${rows[13]} (truth: EXACTLY three suppressed (k=2/4/6 land 16/33/49 ms after their countdown ticks), GO untouched, one-sided half-open window, junk suppresses nothing)`,
      flams.filter(Boolean).length === 3 &&
        flams[0] === false &&
        flams[2] === true &&
        flams[4] === true &&
        flams[6] === true &&
        rows[11] === false &&
        rows[12] === false &&
        rows[13] === false,
    );
  }
  {
    const rows = c("score-map-and-bar-crossings", [
      { fn: "score", args: { r: 1 } },
      { fn: "score", args: { r: 0 } },
      { fn: "score", args: { r: 35 / 60 } },
      { fn: "score", args: { r: BEAT_LOCK_GOOD_R } },
      { fn: "score", args: { r: BEAT_LOCK_FAULT_R } },
    ]);
    analytic(
      "beat-stats/score-anchors",
      `[${rows}] (truth: 100 cap, 40 floor, the lowest bar 75 crosses at R = 35/60, the copy bands' own arithmetic)`,
      rows[0] === 100 &&
        rows[1] === 40 &&
        Math.abs(rows[2] - 75) <= 1e-9 &&
        Math.abs(rows[3] - (40 + 60 * 0.72)) <= 1e-9 &&
        Math.abs(rows[4] - 67.0) <= 1e-9,
    );
  }

  // --- copy builders --------------------------------------------------------------
  {
    const rows = c("copy-branch-matrix", [
      { fn: "copy", args: { stats: makeBeat(), nullReason: "no-clock" } },
      {
        fn: "copy",
        args: {
          stats: makeBeat({ vectorR: 0.716, gridSpm: 122, strikes: 25 }),
          nullReason: "no-clock",
          sep: " · ",
        },
      },
      { fn: "copy", args: { stats: null, nullReason: "no-clock" } },
      { fn: "copy", args: { stats: null, nullReason: "no-reference" } },
      { fn: "copy", args: { stats: null, nullReason: "too-few-strikes" } },
      // THE DIRECTION FLOOR (three gates, on the ROW's disclosed stats).
      {
        fn: "copy",
        args: {
          stats: makeBeat({ rayleighNR2: 4.7, driftSpm: 2, cadenceSpm: 63, vectorR: 0.5 }),
          nullReason: "no-clock",
        },
      },
      {
        fn: "copy",
        args: {
          stats: makeBeat({ rayleighNR2: 4.7, driftSpm: -2.5, cadenceSpm: 58.5, vectorR: 0.5 }),
          nullReason: "no-clock",
        },
      },
      {
        // 4.5 < ln(100) = 4.605: NO direction claim without demonstrated
        // above-chance entrainment (the cue only fires when R clears the gate).
        fn: "copy",
        args: {
          stats: makeBeat({ rayleighNR2: 4.5, driftSpm: 3, cadenceSpm: 64, vectorR: 0.5 }),
          nullReason: "no-clock",
        },
      },
      {
        fn: "copy",
        args: {
          stats: makeBeat({ rayleighNR2: 30, driftSpm: 1.9, cadenceSpm: 62.9, vectorR: 0.5 }),
          nullReason: "no-clock",
        },
      },
      {
        fn: "copy",
        args: {
          stats: makeBeat({ rayleighNR2: 30, driftSpm: null, cadenceSpm: null, vectorR: 0.5 }),
          nullReason: "no-clock",
        },
      },
      // Precedence: direction > locked > wandered; between bands is silent.
      {
        fn: "copy",
        args: {
          stats: makeBeat({ rayleighNR2: 40, driftSpm: 3, cadenceSpm: 64, vectorR: 0.8 }),
          nullReason: "no-clock",
        },
      },
      { fn: "copy", args: { stats: makeBeat({ vectorR: 0.72 }), nullReason: "no-clock" } },
      { fn: "copy", args: { stats: makeBeat({ vectorR: 0.6 }), nullReason: "no-clock" } },
      { fn: "copy", args: { stats: makeBeat({ vectorR: 0.45 }), nullReason: "no-clock" } },
      { fn: "copy", args: { stats: makeBeat({ vectorR: 0.44 }), nullReason: "no-clock" } },
    ]);
    analytic(
      "beat-stats/direction-floor-and-precedence",
      `qualified "${rows[5].cue}", gated ${rows[7].cue}/${rows[8].cue}/${rows[9].cue}, precedence "${rows[10].cue}"`,
      rows[0].line === "BEAT LOCK 80% - GRID 61/MIN - 40 STRIKES" &&
        rows[1].line === "BEAT LOCK 72% · GRID 122/MIN · 25 STRIKES" &&
        rows[2].line === "BEAT: NO READ - THE BEAT CLOCK WAS NOT ARMED" &&
        rows[5].cue ===
          "You ran ahead of the beat - 63 steps a minute against the 61 grid. Sit back into the count." &&
        rows[6].cue ===
          "You fell behind the beat - 59 steps a minute against the 61 grid. Push up to the count." &&
        rows[7].cue === null &&
        rows[8].cue === null &&
        rows[9].cue === null &&
        rows[10].cue !== null &&
        rows[10].cue.startsWith("You ran ahead of the beat") &&
        rows[11].cue ===
          "Locked to the beat - 72 percent phase-steady on the 61 a minute grid." &&
        rows[12].cue === null &&
        rows[13].cue === null &&
        rows[14].cue ===
          "Your strikes wandered off the beat - count the beat down the deck.",
    );
  }
  {
    const [tables] = c("beat-strings-and-constants", [{ fn: "tables" }]);
    analytic(
      "beat-stats/derivation-pins",
      `candidates ${JSON.stringify(tables.gridCandidates?.[122])}, debounce ${tables.BEAT_STRIKE_DEBOUNCE_SEC}, gate ${tables.BEAT_RAYLEIGH_DIRECTION_MIN}`,
      tables.BEAT_STRIKE_DEBOUNCE_SEC === STEP_DEBOUNCE_SEC && // the pinned alias
        tables.BEAT_RAYLEIGH_DIRECTION_MIN === Math.log(100) &&
        // The per-tempo candidate pairs (the multi-BPM wave's drift lock):
        // the legacy 122 pair is byte-preserved; 62 is the half-time pair.
        tables.gridCandidates[122].fastSpm === 122 &&
        tables.gridCandidates[122].slowSpm === 61 &&
        Math.abs(tables.gridCandidates[122].boundarySpm - 61 * Math.SQRT2) <=
          1e-9 &&
        tables.gridCandidates[62].fastSub === "half-beat" &&
        tables.gridCandidates[62].fastSpm === 124 &&
        tables.gridCandidates[100].slowSpm === 50 &&
        tables.gridCandidates[125].slowSpm === 62.5 &&
        tables.BEAT_GRID_SPM_MIN === 45 &&
        tables.BEAT_GRID_SPM_MAX === 160 &&
        tables.BEAT_SETTING_TIP.includes("60 ms") && // §H flam disclosure
        Math.abs(tables.BEAT_EARCON_HZ / 1174.66 - 2 ** (9 / 12)) < 0.01, // major sixth
    );
  }

  return cases;
}

// =============================================================================
// turn-stats — the M11 tracker, protocol segmentation, sub-measures, reason
// taxonomy and copy builders.
// =============================================================================

function turnStatsCases() {
  const cases = [];
  const c = (name, queries) => {
    const results = runTurnQueries(queries);
    cases.push({ name, input: { queries }, expect: { results } });
    return results;
  };
  const t = (name, ops, opts = {}) =>
    c(name, [{ fn: "tape", args: { ops, ...opts } }])[0];
  const tapeQ = (ops, opts = {}) => ({ fn: "tape", args: { ops, ...opts } });
  /** ops with the prelude's begin-walk swapped for a different mode pace. */
  const withPace = (ops, idealPace) => [
    { op: "begin-walk", fit: null, oneWay: false, idealPace },
    ...ops.slice(1),
  ];
  /** The SAME wall-clock protocol at HALF the frame interval (rate twin):
   * every event lands at the same second, only the sampling grid changes. */
  const halfRate = (ops) =>
    ops.map((o) => {
      if (o.op === "frame" || o.op === "dark-frame" || o.op === "freeze") {
        return { ...o, dt: (o.dt ?? TURN_TAPE_DT) / 2, reps: (o.reps ?? 1) * 2 };
      }
      if (o.op === "sweep") {
        return { ...o, dt: (o.dt ?? TURN_TAPE_DT) / 2, frames: o.frames * 2 };
      }
      return o;
    });

  // --- the full protocol (prelude -> hold-occupied beat -> pivot -> return) ---
  {
    const r = t("full-protocol-canonical", fullProtocolOps(), { walkBase: 1.6 });
    const s = r.stats;
    analytic(
      "turn-stats/full-protocol-closed-forms",
      `start ${s?.startAtSec} dur ${s?.durationSec} meas ${s?.measuredSec} sweep ${s?.sweepDeg} reacq ${s?.reacquireSec}`,
      s !== null &&
        s.startAtSec === 4.13 &&
        s.durationSec === 1.25 &&
        s.measuredSec === 1.38 &&
        s.sweepDeg === 137.5 && // 170 - 32.5, closed form
        s.entryClipped === false &&
        // Hold-window wander (out to 60 deg) never leaks into the turn:
        s.reversalCount === 0 &&
        s.sweepMonotoneFrac === 1 &&
        s.durBandLoSec === 0.9 &&
        s.durBandHiSec === 2.22 &&
        s.dipCm === 0 &&
        s.dipFrac === 0 &&
        s.heightM === 1.6 &&
        s.heightSource === "walk" &&
        s.pitchInBandFrac === 1 &&
        s.reacquireSec === 0.75 && // the sustained stretch ENTRY, not entry+sustain
        s.reacquireCapped === false &&
        r.line === "TURN 1.3S - ONE MOTION - DIP 0 CM - LINE IN 0.8S" &&
        r.cue === "One motion in 1.3 s, level all the way round - a clean turn.",
    );
  }
  {
    // Rate independence where the core promises it: the discrete verdicts
    // and normalized fractions are sampling-grid-free; the frame-quantized
    // seconds may move by at most one COARSE frame; the sweep endpoints by
    // at most one coarse sweep step.
    const coarseOps = fullProtocolOps();
    const rows = c("full-protocol-rate-independence", [
      tapeQ(coarseOps, { walkBase: 1.6 }),
      tapeQ(halfRate(coarseOps), { walkBase: 1.6 }),
    ]);
    const a = rows[0].stats;
    const b = rows[1].stats;
    analytic(
      "turn-stats/rate-independence",
      `coarse start/dur/meas/sweep/reacq ${a?.startAtSec}/${a?.durationSec}/${a?.measuredSec}/${a?.sweepDeg}/${a?.reacquireSec} vs fine ${b?.startAtSec}/${b?.durationSec}/${b?.measuredSec}/${b?.sweepDeg}/${b?.reacquireSec}`,
      a !== null &&
        b !== null &&
        b.entryClipped === a.entryClipped &&
        b.reversalCount === a.reversalCount &&
        b.sweepMonotoneFrac === a.sweepMonotoneFrac &&
        b.dipFrac === a.dipFrac &&
        b.heightSource === a.heightSource &&
        b.pitchInBandFrac === a.pitchInBandFrac &&
        b.reacquireCapped === a.reacquireCapped &&
        b.durBandLoSec === a.durBandLoSec &&
        b.durBandHiSec === a.durBandHiSec &&
        Math.abs(b.startAtSec - a.startAtSec) <= TURN_TAPE_DT + 1e-9 &&
        Math.abs(b.durationSec - a.durationSec) <= TURN_TAPE_DT + 1e-9 &&
        Math.abs(b.measuredSec - a.measuredSec) <= TURN_TAPE_DT + 1e-9 &&
        Math.abs(b.reacquireSec - a.reacquireSec) <= TURN_TAPE_DT + 1e-9 &&
        Math.abs(b.sweepDeg - a.sweepDeg) <= 14,
    );
  }

  // --- the dip channel (adjudication §A) ---------------------------------------
  {
    const dipOps = [...protocolPrelude(), ...cleanPivot(1.54), ...returnLeg()];
    const rows = c("dip-unit-anchor-and-height-ladder", [
      tapeQ(dipOps, { walkBase: 1.6 }),
      tapeQ(
        [
          { op: "begin-walk", fit: 1.7, oneWay: false, idealPace: 0.85 },
          ...dipOps.slice(1),
        ],
        { walkBase: 1.6 },
      ),
      tapeQ([...protocolPrelude(), ...cleanPivot(0.35), ...returnLeg()], {
        walkBase: 0.4,
      }),
    ]);
    const base = rows[0].stats;
    analytic(
      "turn-stats/§A-dipFrac-unit-anchor",
      `dipCm ${base?.dipCm} dipFrac ${base?.dipFrac} (truth: a 6 cm dip at 1.6 m reads dipFrac 0.0375 === TURN_DIP_FAULT_FRAC EXACTLY — meters over meters, round4)`,
      base !== null &&
        base.dipCm === 6 &&
        base.dipFrac === 0.0375 &&
        base.dipFrac === TURN_DIP_FAULT_FRAC &&
        TURN_DIP_FAULT_FRAC === POSTURE_CUE_M / HOLD_REF_HEAD_M &&
        rows[0].cue ===
          "You sank 6 cm through the turn - stay tall as you come around.",
    );
    analytic(
      "turn-stats/height-ladder",
      `fit ${rows[1].stats?.heightSource}/${rows[1].stats?.heightM}/${rows[1].stats?.dipFrac}, ref ${rows[2].stats?.heightSource}/${rows[2].stats?.heightM} (truth: dip DELTA always vs the walk baseline; only the DENOMINATOR walks the fit -> walk -> ref ladder)`,
      rows[1].stats?.heightSource === "fit" &&
        rows[1].stats?.heightM === 1.7 &&
        rows[1].stats?.dipCm === 6 &&
        rows[1].stats?.dipFrac === Math.round(((1.6 - 1.54) / 1.7) * 10000) / 10000 &&
        rows[2].stats?.heightSource === "ref" &&
        rows[2].stats?.heightM === HOLD_REF_HEAD_M &&
        rows[2].stats?.dipCm === 5 &&
        rows[2].stats?.dipFrac ===
          Math.round(((0.4 - 0.35) / HOLD_REF_HEAD_M) * 10000) / 10000,
    );
  }
  {
    const rows = c("dip-null-discipline", [
      tapeQ(fullProtocolOps(), { walkBase: null }),
      tapeQ(
        [
          ...protocolPrelude(),
          { op: "sweep", devFrom: 5, devTo: 100, frames: 6, headY: 1.55 },
          { op: "frame", devDeg: 110, headY: NaN },
          { op: "sweep", devFrom: 120, devTo: 170, frames: 4, headY: 1.55 },
          ...returnLeg(),
        ],
        { walkBase: 1.6 },
      ),
    ]);
    analytic(
      "turn-stats/dip-nulls",
      `dark-base dip ${rows[0].stats?.dipCm} line "${rows[0].line}", NaN-frame dip ${rows[1].stats?.dipCm}`,
      rows[0].stats !== null &&
        rows[0].stats.dipCm === null &&
        rows[0].stats.dipFrac === null &&
        rows[0].stats.heightM === null &&
        rows[0].stats.heightSource === null &&
        rows[0].line === "TURN 1.3S - ONE MOTION - LINE IN 0.8S" &&
        rows[1].stats?.dipCm === 5, // the NaN headY frame never entered the EMA
    );
  }

  // --- entry-clipped sweeps (adjudication §C) + the §H dtEff trim ---------------
  {
    const rows = c("entry-clipped-section-c", [
      tapeQ(
        [
          ...protocolPrelude(40),
          { op: "sweep", devFrom: 66, devTo: 170, frames: 4, lat: 0.02 },
          { op: "frame", devDeg: 172, lat: 0.05, reps: 10 },
        ],
        { walkBase: 1.6 },
      ),
      tapeQ(
        [
          ...protocolPrelude(40),
          { op: "sweep", devFrom: 66, devTo: 170, frames: 4, lat: 0.02, headY: 1.5 },
          { op: "frame", devDeg: 172, lat: 0.05, reps: 10 },
        ],
        { walkBase: 1.6 },
      ),
      tapeQ(
        [
          ...protocolPrelude(25),
          { op: "sweep", devFrom: 18, devTo: 4, frames: 2, lat: 0.02 },
          ...cleanPivot(),
          ...returnLeg(),
        ],
        { walkBase: 1.6 },
      ),
    ]);
    const s = rows[0].stats;
    analytic(
      "turn-stats/§C-clipped-remainder",
      `clipped ${s?.entryClipped} start ${s?.startAtSec} dur ${s?.durationSec} meas ${s?.measuredSec}, cue ${rows[0].cue}`,
      s !== null &&
        s.entryClipped === true &&
        s.startAtSec === 3.88 && // the straddle frame itself
        s.durationSec === 0.5 &&
        // The §H dtEff trim: the straddle frame carries only its post-open
        // sliver (0.025 minus the 1.6 float excess) -> round2 lands at 0.52.
        s.measuredSec === 0.52 &&
        s.durationSec < s.durBandLoSec &&
        rows[0].cue === null && // duration verdict + whip cue SUPPRESSED
        rows[0].line ===
          "TURN 0.5S FROM THE HOLD RELEASE - ONE MOTION - DIP 0 CM - LINE IN 0.0S" &&
        rows[1].stats?.entryClipped === true &&
        // The dip fault still cues on a clipped turn (dip outranks everything):
        rows[1].cue ===
          "You sank 10 cm through the turn - stay tall as you come around." &&
        // An aborted clipped entry clears the stamp (hold wander, not a sweep):
        rows[2].stats?.entryClipped === false &&
        rows[2].stats?.reversalCount === 0,
    );
  }

  // --- the reason taxonomy (adjudication §B) -------------------------------------
  {
    const rows = c("never-settled-vs-tracking-dark", [
      tapeQ([
        { op: "begin-walk" },
        { op: "frame", devDeg: 0, lat: 0.1, reps: 16 },
        { op: "mark" },
        // A rolling 180 on the move: live stream, the hold never arms.
        { op: "sweep", devFrom: 0, devTo: 180, frames: 24, lat: 0.1 },
        { op: "frame", devDeg: 178, lat: 0.1, reps: 8 },
      ]),
      tapeQ([
        { op: "begin-walk" },
        { op: "frame", devDeg: 0, lat: 0.1, reps: 16 },
        { op: "mark" },
        { op: "freeze", reps: 30 }, // bit-identical repeats: zero accepted
      ]),
    ]);
    analytic(
      "turn-stats/§B-discrimination",
      `rolling ${rows[0].nullReason}, frozen-mark ${rows[1].nullReason} (truth: a motion fact vs a sensor fact — from THIS tracker's own accepted seconds, never the hold's null reason)`,
      rows[0].stats === null &&
        rows[0].nullReason === "never-settled" &&
        rows[0].line === "TURN: NO READ - YOU NEVER SETTLED ON THE MARK" &&
        rows[0].cue === null &&
        rows[1].stats === null &&
        rows[1].nullReason === "tracking-dark" &&
        rows[1].line === "TURN: NO READ - TRACKING WENT DARK AT THE MARK" &&
        rows[1].cue === null,
    );
  }
  {
    const rows = c("turned-in-hold-vs-dark-span", [
      tapeQ([...protocolPrelude(120), { op: "frame", devDeg: 120, reps: 10 }]),
      tapeQ([...protocolPrelude(120), { op: "dark-frame", reps: 10 }]),
      tapeQ([...protocolPrelude(), { op: "dark-frame", reps: 20 }]),
    ]);
    analytic(
      "turn-stats/turned-in-hold",
      `[${rows.map((r) => r.nullReason)}] (truth: turned-in-hold on a measured span; a dark span floors to tracking-dark)`,
      rows[0].stats === null &&
        rows[0].nullReason === "turned-in-hold" &&
        rows[0].line === "TURN: NO READ - THE TURN HAPPENED INSIDE THE HOLD WINDOW" &&
        rows[0].cue ===
          "You turned inside the hold beat - freeze for the count, then turn." &&
        rows[1].nullReason === "tracking-dark" &&
        rows[2].nullReason === "tracking-dark",
    );
  }
  {
    const rows = c("commit-latch-outranks-the-floor", [
      // Committed with only ~0.4 accepted seconds: truncation, never dark.
      tapeQ([...protocolPrelude(), { op: "sweep", devFrom: 30, devTo: 130, frames: 3 }]),
      tapeQ([...protocolPrelude(), { op: "sweep", devFrom: 5, devTo: 130, frames: 8 }]),
      // A frozen stream can never complete a turn: committed, then frozen.
      tapeQ([
        ...protocolPrelude(),
        { op: "sweep", devFrom: 5, devTo: 150, frames: 8, lat: 0.02 },
        { op: "freeze", reps: 20 },
      ]),
    ]);
    analytic(
      "turn-stats/walk-ended-mid-turn",
      `[${rows.map((r) => r.nullReason)}]`,
      rows.every((r) => r.stats === null && r.nullReason === "walk-ended-mid-turn") &&
        rows[0].line === "TURN: NO READ - THE WALK ENDED MID-TURN" &&
        rows[0].cue === "The walk ended mid-turn - finish the turn and bring it home.",
    );
  }
  {
    const rows = c("no-turn-verdicts", [
      // Entered but never committed at walk end: abort semantics -> no-turn.
      tapeQ([...protocolPrelude(), { op: "frame", devDeg: 60, reps: 12 }]),
      tapeQ([...protocolPrelude(), { op: "frame", devDeg: 4, reps: 16 }]),
    ]);
    analytic(
      "turn-stats/no-turn",
      `[${rows.map((r) => r.nullReason)}]`,
      rows.every((r) => r.stats === null && r.nullReason === "no-turn") &&
        rows[0].line === "TURN: NO READ - NO 180 TURN ON THE HEAD PATH" &&
        rows[0].cue ===
          "No 180 showed on the head path - turn at the mark and face the walk home.",
    );
  }
  {
    const rows = c("mark-latch-laws", [
      tapeQ([{ op: "begin-walk" }, { op: "frame", devDeg: 0, reps: 20 }]),
      // An armed hold implies a reached mark (the defensive latch): never
      // "never-marked" past it.
      tapeQ([
        { op: "begin-walk" },
        { op: "frame", devDeg: 0, reps: 2 },
        { op: "hold-armed" },
      ]),
    ]);
    analytic(
      "turn-stats/mark-latches",
      `[${rows.map((r) => r.nullReason)}]`,
      rows[0].stats === null &&
        rows[0].nullReason === "never-marked" &&
        rows[0].line === "TURN: NO READ - THE WALK ENDED BEFORE THE MARK" &&
        rows[0].cue === null &&
        rows[1].stats === null &&
        rows[1].nullReason === "tracking-dark",
    );
  }

  // --- frozen-pose repeats weigh EXACTLY like dark frames -------------------------
  {
    const rows = c("frozen-repeats-weigh-like-dark", [
      tapeQ(
        [
          ...protocolPrelude(),
          { op: "sweep", devFrom: 5, devTo: 100, frames: 6, lat: 0.02 },
          { op: "dark-frame", reps: 4 },
          { op: "sweep", devFrom: 110, devTo: 170, frames: 4, lat: 0.02 },
          ...returnLeg(),
        ],
        { walkBase: 1.6 },
      ),
      tapeQ(
        [
          ...protocolPrelude(),
          { op: "sweep", devFrom: 5, devTo: 150, frames: 8, lat: 0.02 },
          { op: "freeze", reps: 8 },
          { op: "sweep", devFrom: 150, devTo: 165, frames: 2, lat: 0.02 },
          ...returnLeg(),
        ],
        { walkBase: 1.6 },
      ),
    ]);
    analytic(
      "turn-stats/frozen-equals-dark",
      `dark meas ${rows[0].stats?.measuredSec} dur ${rows[0].stats?.durationSec}; frozen meas ${rows[1].stats?.measuredSec} (truth: both credit ZERO — duration spans the gap on the walk clock, measured does not; no reversal minted)`,
      rows[0].stats !== null &&
        rows[0].stats.measuredSec === 1.25 &&
        rows[0].stats.durationSec === 1.63 &&
        rows[0].stats.reversalCount === 0 &&
        rows[0].stats.sweepMonotoneFrac === 1 &&
        rows[1].stats !== null &&
        rows[1].stats.measuredSec === 1.25 &&
        rows[1].stats.reversalCount === 0 &&
        rows[1].stats.measuredSec === rows[0].stats.measuredSec,
    );
  }

  // --- U routes: the machine is dark by protocol ----------------------------------
  {
    const uOps = fullProtocolOps();
    uOps[0] = { op: "begin-walk", fit: null, oneWay: true, idealPace: 0.85 };
    const rows = c("u-route-dark", [
      tapeQ(uOps, { walkBase: 1.6 }),
      tapeQ([
        ...protocolPrelude(),
        { op: "reset-route", oneWay: true },
        { op: "frame", devDeg: 0, reps: 4 },
      ]),
    ]);
    analytic(
      "turn-stats/one-way-route",
      `[${rows.map((r) => r.nullReason)}]`,
      rows.every(
        (r) =>
          r.stats === null &&
          r.nullReason === "one-way-route" &&
          r.line === "TURN: NO TURN ON A ONE-WAY ROUTE" &&
          r.cue === null,
      ),
    );
  }

  // --- remap + idempotent edges -----------------------------------------------------
  {
    const rows = c("remap-and-idempotent-edges", [
      tapeQ(
        [
          ...protocolPrelude(),
          { op: "sweep", devFrom: 5, devTo: 100, frames: 6, lat: 0.02 }, // mid-turn...
          { op: "reset-route", oneWay: false }, // ...remap discards it wholesale
          { op: "frame", devDeg: 0, lat: 0.3, reps: 4 },
          { op: "mark" },
          { op: "frame", devDeg: 0, lat: 0.05, reps: 2 },
          { op: "hold-armed" },
          { op: "frame", devDeg: 4, lat: 0.02, reps: 13 },
          ...cleanPivot(),
          ...returnLeg(),
        ],
        { walkBase: 1.6 },
      ),
      tapeQ([
        ...protocolPrelude(),
        { op: "sweep", devFrom: 5, devTo: 100, frames: 6 },
        { op: "reset-route", oneWay: false },
      ]),
      tapeQ(
        [
          { op: "begin-walk" },
          { op: "frame", devDeg: 0, lat: 0.3, reps: 8 },
          { op: "mark" },
          { op: "frame", devDeg: 0, lat: 0.05, reps: 2 },
          { op: "hold-armed" },
          { op: "frame", devDeg: 4, lat: 0.02, reps: 13 },
          { op: "mark" }, // repeated edges must be ignored (first call wins)
          { op: "hold-armed" },
          ...cleanPivot(),
          ...returnLeg(),
        ],
        { walkBase: 1.6 },
      ),
    ]);
    analytic(
      "turn-stats/remap-latch-laws",
      `fresh start ${rows[0].stats?.startAtSec} band ${rows[0].stats?.durBandHiSec}, immediate ${rows[1].nullReason}, double-edge dur ${rows[2].stats?.durationSec}`,
      rows[0].stats !== null &&
        rows[0].stats.durationSec === 1.25 &&
        rows[0].stats.startAtSec > 6 && // the SECOND geometry's pivot
        rows[0].stats.durBandHiSec === 2.22 && // band snapshot survives remap
        rows[0].stats.entryClipped === false &&
        rows[1].stats === null &&
        rows[1].nullReason === "never-marked" &&
        rows[2].stats !== null &&
        rows[2].stats.durationSec === 1.25,
    );
  }

  // --- sweep smoothness (deadband zigzag + monotone fraction) -----------------------
  {
    const mk = (devs) => [
      ...protocolPrelude(),
      ...devs.map((d) => ({ op: "frame", devDeg: d, lat: 0.02 })),
      ...returnLeg(),
    ];
    const rows = c("sweep-smoothness-anchors", [
      tapeQ(mk([25, 50, 80, 70, 100, 120, 110, 140, 165]), { walkBase: 1.6 }),
      tapeQ(mk([25, 50, 47, 75, 72, 100, 130, 165]), { walkBase: 1.6 }),
      tapeQ(mk([25, 60, 100, 88, 130, 165]), { walkBase: 1.6 }),
      tapeQ(
        [
          ...protocolPrelude(-4),
          { op: "sweep", devFrom: -5, devTo: -170, frames: 12, lat: 0.02 },
          { op: "frame", devDeg: -172, lat: 0.05, reps: 10 },
        ],
        { walkBase: 1.6 },
      ),
      tapeQ(
        [
          ...protocolPrelude(),
          { op: "sweep", devFrom: 5, devTo: 185, frames: 12, lat: 0.02 },
          { op: "frame", devDeg: 186, lat: 0.05, reps: 10 },
        ],
        { walkBase: 1.6 },
      ),
    ]);
    analytic(
      "turn-stats/zigzag-vs-clean-anchors",
      `stutter ${rows[0].stats?.reversalCount}/${rows[0].stats?.sweepMonotoneFrac}, wobble ${rows[1].stats?.reversalCount}, single ${rows[2].stats?.reversalCount}, left ${rows[3].stats?.sweepDeg}, overshoot ${rows[4].stats?.reversalCount}`,
      // Two 10-deg retreats: net 140, total 140 + 2*(10+10) = 180.
      rows[0].stats?.reversalCount === 2 &&
        rows[0].stats?.sweepDeg === 140 &&
        rows[0].stats?.sweepMonotoneFrac === Math.round((140 / 180) * 1000) / 1000 &&
        rows[0].cue ===
          "Your head swept back 2 times mid-turn - one motion, commit the turn." &&
        // Sub-deadband wobble is gait oscillation, never a stutter:
        rows[1].stats?.reversalCount === 0 &&
        rows[1].stats?.sweepMonotoneFrac === 1 &&
        rows[2].stats?.reversalCount === 1 &&
        rows[2].cue ===
          "Your head swept back once mid-turn - one motion, commit the turn." &&
        // A LEFT turn measures identically (sign symmetry):
        rows[3].stats?.sweepDeg === 137.5 &&
        rows[3].stats?.reversalCount === 0 &&
        rows[3].stats?.sweepMonotoneFrac === 1 &&
        // Overshoot past 180 unwraps through the seam (no fake reversal):
        rows[4].stats?.reversalCount === 0 &&
        rows[4].stats?.sweepMonotoneFrac === 1,
    );
  }

  // --- duration band (mode-scaled) + glances ------------------------------------------
  {
    const slowPivot = [{ op: "sweep", devFrom: 5, devTo: 170, frames: 20, lat: 0.02 }];
    const rows = c("duration-band-and-glances", [
      tapeQ(withPace([...protocolPrelude(), ...slowPivot, ...returnLeg()], 1.05), {
        walkBase: 1.6,
      }),
      tapeQ(withPace([...protocolPrelude(), ...slowPivot, ...returnLeg()], 0.72), {
        walkBase: 1.6,
      }),
      tapeQ(
        [
          ...protocolPrelude(),
          { op: "sweep", devFrom: 5, devTo: 170, frames: 6, lat: 0.02 },
          ...returnLeg(),
        ],
        { walkBase: 1.6 },
      ),
      tapeQ(
        [
          ...protocolPrelude(),
          { op: "sweep", devFrom: 4, devTo: 60, frames: 4, lat: 0.02 },
          { op: "sweep", devFrom: 46, devTo: 4, frames: 4, lat: 0.02 }, // back on line: abort
          ...cleanPivot(),
          ...returnLeg(),
        ],
        { walkBase: 1.6 },
      ),
    ]);
    analytic(
      "turn-stats/mode-scaled-duration",
      `challenge ${rows[0].stats?.durationSec}s vs hi ${rows[0].stats?.durBandHiSec}, highfashion band ${rows[1].stats?.durBandLoSec}-${rows[1].stats?.durBandHiSec}, whip ${rows[2].stats?.durationSec}, glance-abort start ${rows[3].stats?.startAtSec}`,
      // The same 2.13 s turn is OVER the challenge band and INSIDE highfashion's:
      rows[0].stats?.durationSec === 2.13 &&
        rows[0].stats?.durBandHiSec === 1.8 &&
        rows[0].cue === "The turn took 2.1 s - hit the mark, turn, and go." &&
        rows[1].stats?.durBandLoSec === 1.06 &&
        rows[1].stats?.durBandHiSec === 2.62 &&
        rows[1].cue === "One motion in 2.1 s, level all the way round - a clean turn." &&
        rows[2].stats !== null &&
        rows[2].stats.durationSec < rows[2].stats.durBandLoSec &&
        rows[2].cue ===
          `You whipped the turn in ${rows[2].stats.durationSec.toFixed(1)} s - give it one controlled beat.` &&
        // The discarded glance leaks nothing: fresh entry, zero reversals.
        rows[3].stats?.startAtSec === 5.13 &&
        rows[3].stats?.reversalCount === 0 &&
        rows[3].stats?.entryClipped === false,
    );
  }

  // --- line re-acquisition on the return leg ---------------------------------------
  {
    const pivotOps = [...protocolPrelude(), ...cleanPivot()];
    const rows = c("reacquisition-matrix", [
      tapeQ(
        [
          ...pivotOps,
          { op: "frame", devDeg: 172, lat: 0.1, reps: 2 }, // 0.25 s: not sustained
          { op: "frame", devDeg: 172, lat: 0.4, reps: 2 },
          { op: "frame", devDeg: 172, lat: 0.1, reps: 8 },
        ],
        { walkBase: 1.6 },
      ),
      tapeQ([...pivotOps, { op: "frame", devDeg: 172, lat: 0.5, reps: 12 }], {
        walkBase: 1.6,
      }),
      tapeQ([...pivotOps, { op: "dark-frame", reps: 12 }], { walkBase: 1.6 }),
      tapeQ([...pivotOps, { op: "frame", devDeg: 172, lat: 0.5, reps: 6 }], {
        walkBase: 1.6,
      }),
      tapeQ([...pivotOps, { op: "frame", devDeg: 172, lat: 0.05, reps: 10 }], {
        walkBase: 1.6,
      }),
      tapeQ(
        [
          ...pivotOps,
          { op: "frame", devDeg: 172, lat: 0.1, reps: 3 }, // 0.375 s: almost
          { op: "frame", devDeg: 172, lat: NaN, reps: 1 }, // gap breaks evidence
          { op: "frame", devDeg: 171, lat: 0.1, reps: 8 },
        ],
        { walkBase: 1.6 },
      ),
      tapeQ(
        [
          ...pivotOps,
          { op: "frame", devDeg: 172, lat: 0.5, reps: 26 }, // 3.25 s off line
          { op: "frame", devDeg: 172, lat: 0.1, reps: 8 },
        ],
        { walkBase: 1.6 },
      ),
      tapeQ([...pivotOps, { op: "dark-frame", lat: 0.1, reps: 10 }], {
        walkBase: 1.6,
      }),
    ]);
    analytic(
      "turn-stats/reacquisition-sustain-cap-dark",
      `S-swing ${rows[0].stats?.reacquireSec}, capped ${rows[1].stats?.reacquireSec}/${rows[1].stats?.reacquireCapped}, dark ${rows[2].stats?.reacquireSec}, floor ${rows[3].stats?.reacquireSec}, on-line ${rows[4].stats?.reacquireSec}, reset ${rows[5].stats?.reacquireSec}, slow ${rows[6].stats?.reacquireSec}, yaw-dark ${rows[7].stats?.reacquireSec}`,
      rows[0].stats?.reacquireSec === 0.5 && // the first SUSTAINED stretch wins
        rows[0].stats?.reacquireCapped === false &&
        rows[1].stats?.reacquireSec === 1.5 && // never re-centered: full span, capped
        rows[1].stats?.reacquireCapped === true &&
        rows[1].line.includes("LINE NOT RE-CENTERED") &&
        rows[1].cue ===
          "You never got back on the line after the turn - find center, then drive home." &&
        rows[2].stats?.reacquireSec === null && // a dark return claims nothing
        rows[2].stats?.reacquireCapped === false &&
        !rows[2].line.includes("LINE") &&
        rows[3].stats?.reacquireSec === null && // under TURN_RETURN_MIN_SEC
        rows[4].stats?.reacquireSec === 0 && // turned ON the line: 0.0 legitimately
        rows[5].stats?.reacquireSec === 0.5 && // dark lateral resets the candidate
        rows[6].stats?.reacquireSec === 3.25 &&
        rows[6].cue ===
          "It took 3.3 s to find the line again after the turn - square up and go." &&
        rows[7].stats?.reacquireSec === 0, // yaw-dark but lateral-live still folds
    );
  }

  // --- carriage pitch through the turn (the M8 raw tap, consumed) -------------------
  {
    const rows = c("pitch-through-the-turn", [
      tapeQ(
        [
          ...protocolPrelude(),
          { op: "sweep", devFrom: 5, devTo: 60, frames: 4, lat: 0.02, pitchDev: null },
          { op: "sweep", devFrom: 74, devTo: 130, frames: 4, lat: 0.02, pitchDev: 10 },
          { op: "sweep", devFrom: 140, devTo: 158, frames: 2, lat: 0.02, pitchDev: 3 },
          { op: "frame", devDeg: 165, lat: 0.02, pitchDev: 3 },
          ...returnLeg(),
        ],
        { walkBase: 1.6 },
      ),
      tapeQ(
        [
          ...protocolPrelude(),
          { op: "sweep", devFrom: 5, devTo: 170, frames: 12, lat: 0.02, pitchDev: null },
          ...returnLeg(),
        ],
        { walkBase: 1.6 },
      ),
      tapeQ(
        [
          ...protocolPrelude(),
          { op: "sweep", devFrom: 5, devTo: 100, frames: 6, lat: 0.02, pitchDev: 7 },
          { op: "sweep", devFrom: 112, devTo: 170, frames: 5, lat: 0.02, pitchDev: -7.5 },
          ...returnLeg(),
        ],
        { walkBase: 1.6 },
      ),
    ]);
    analytic(
      "turn-stats/pitch-tap",
      `partial ${rows[0].stats?.pitchInBandFrac}, all-dark ${rows[1].stats?.pitchInBandFrac}, band-edge ${rows[2].stats?.pitchInBandFrac} (truth: null-tap frames fold nothing; the band is M8's own, inclusive)`,
      rows[0].stats?.pitchInBandFrac === Math.round((0.375 / 0.875) * 1000) / 1000 &&
        rows[1].stats?.pitchInBandFrac === null &&
        rows[2].stats?.pitchInBandFrac === Math.round((6 / 11) * 1000) / 1000,
    );
  }

  // --- junk-clock frames are inert ---------------------------------------------------
  {
    const rows = c("junk-clock-frames-inert", [
      tapeQ(fullProtocolOps(), { walkBase: 1.6 }),
      tapeQ(
        [
          ...protocolPrelude(),
          { op: "bad-dt-frame", dt: 0 },
          { op: "bad-dt-frame", dt: -1 },
          { op: "bad-dt-frame", dt: NaN },
          ...cleanPivot(),
          ...returnLeg(),
        ],
        { walkBase: 1.6 },
      ),
    ]);
    analytic(
      "turn-stats/bad-clock-inert",
      `diff ${goldenDiff(rows[1].stats, rows[0].stats)}`,
      goldenDiff(rows[1].stats, rows[0].stats) === null,
    );
  }

  // --- the mode band table, from the LIVE turnDurBand (§H: never prose) ---------------
  {
    const paces = MODES.map((m) => m.idealPace);
    const rows = c("mode-band-table-live", [
      ...paces.map((pace) => ({ fn: "band", args: { pace } })),
      { fn: "band", args: { pace: NaN } },
      { fn: "band", args: { pace: 0 } },
      { fn: "band", args: { pace: -1 } },
      { fn: "band", args: { pace: Infinity } },
    ]);
    paces.forEach((pace, i) => {
      const scale = TURN_DUR_BASE_PACE_MPS / pace;
      analytic(
        `turn-stats/band ${MODES[i].id}`,
        `${JSON.stringify(rows[i])} (truth: round2 of the base band x ${scale.toFixed(3)})`,
        rows[i].lo === Math.round(TURN_DUR_BASE_LO_SEC * scale * 100) / 100 &&
          rows[i].hi === Math.round(TURN_DUR_BASE_HI_SEC * scale * 100) / 100,
      );
    });
    // The adjudication-§H spot table, keyed by pace (from the LIVE rows).
    const spot = new Map([
      [0.85, { lo: 0.9, hi: 2.22 }],
      [0.72, { lo: 1.06, hi: 2.62 }],
      [0.95, { lo: 0.81, hi: 1.99 }],
      [1.05, { lo: 0.73, hi: 1.8 }],
    ]);
    paces.forEach((pace, i) => {
      const s = spot.get(pace);
      if (s) {
        analytic(
          `turn-stats/§H-band-spot pace=${pace}`,
          `${JSON.stringify(rows[i])} vs ${JSON.stringify(s)}`,
          goldenDiff(rows[i], s) === null,
        );
      }
    });
    const base = { lo: 0.9, hi: 2.22 };
    analytic(
      "turn-stats/band-junk-identity",
      `junk bands ${JSON.stringify(rows.slice(paces.length))}`,
      goldenDiff(rows.slice(paces.length), [base, base, base, base]) === null,
    );
  }

  // --- the §D TWIN-YAW shared quaternion set ------------------------------------------
  // Wave 1's twin-pitch set crossed head-carriage x hold-stats as EMITTED
  // cases in both families; this wave head-carriage.json is FROZEN (no
  // --expect-stale), so the twin lives as a turn-stats case ONLY and the
  // cross-module agreement is proven AT EMIT TIME: a LIVE CarriageTracker is
  // run over the exact quaternions the turn runner feeds (derived below with
  // the runner's own arithmetic: theta = psi - dev, q = (0, sin(theta/2), 0,
  // cos(theta/2)); the runner's double-cover parity negates q per frame,
  // which is extraction-invariant — every extracted term is quadratic in the
  // components). Both modules share head-orient.ts and the
  // atan2-vs-(-sin psi, -cos psi) yaw convention, so the deviations must
  // agree to float-roundtrip precision — WITHOUT touching head-carriage.json.
  {
    const TWIN_YAW_SET = [12.2, 32.5, 61.7, 95.3, 128.4, 170.2];
    const TWIN_YAW_WALK_DEG = 25;
    const r = t(
      "twin-yaw-shared-quats-section-d",
      [
        ...protocolPrelude(),
        ...TWIN_YAW_SET.map((devDeg) => ({
          op: "frame",
          devDeg,
          walkYawDeg: TWIN_YAW_WALK_DEG,
          lat: 0.02,
          headY: 1.6,
        })),
        { op: "frame", devDeg: 172, walkYawDeg: TWIN_YAW_WALK_DEG, lat: 0.05, reps: 10 },
      ],
      { walkBase: 1.6 },
    );
    analytic(
      "turn-stats/§D-twin turn side",
      `start ${r.stats?.startAtSec} sweep ${r.stats?.sweepDeg} (truth: entry at 32.5, exit at 170.2 -> sweep 137.7 EXACTLY iff the extraction is exact)`,
      r.stats !== null &&
        r.stats.startAtSec === 4.13 &&
        r.stats.sweepDeg === Math.round((170.2 - 32.5) * 10) / 10 &&
        r.stats.reversalCount === 0 &&
        r.stats.sweepMonotoneFrac === 1,
    );
    for (const devDeg of TWIN_YAW_SET) {
      const psi = TWIN_YAW_WALK_DEG * DEG2RAD;
      const theta = psi - devDeg * DEG2RAD; // the turn runner's own feed math
      const [carriage] = runCarriageQueries([
        {
          fn: "tape",
          args: {
            ops: [
              { op: "begin-walk" },
              {
                op: "quat-frame",
                q: [0, Math.sin(theta / 2), 0, Math.cos(theta / 2)],
                walkYawDeg: TWIN_YAW_WALK_DEG,
              },
            ],
          },
        },
      ]);
      analytic(
        `turn-stats/§D-twin yaw ${devDeg} deg`,
        `LIVE CarriageTracker liveYawDevDeg ${carriage.liveYawDevDeg} (truth: the turn tape's constructed deviation, to float-roundtrip precision)`,
        Math.abs(carriage.liveYawDevDeg - devDeg) <= 1e-9,
      );
    }
  }

  // --- copy builders (every branch; TurnStats literals via the fixture) ---------------
  {
    const copyQ = (stats, nullReason, sep) => ({
      fn: "copy",
      args: sep === undefined ? { stats, nullReason } : { stats, nullReason, sep },
    });
    const reasons = [
      "one-way-route",
      "never-marked",
      "never-settled",
      "turned-in-hold",
      "no-turn",
      "walk-ended-mid-turn",
      "tracking-dark",
    ];
    const rows = c("copy-branch-matrix", [
      ...reasons.map((reason) => copyQ(null, reason)),
      copyQ(makeTurnStats({ durationSec: 1.4, dipCm: 2.1, reacquireSec: 1.2 }), "no-turn"),
      copyQ(
        makeTurnStats({ durationSec: 1.4, dipCm: 2.1, reacquireSec: 1.2 }),
        "no-turn",
        " · ",
      ),
      copyQ(makeTurnStats({ durationSec: 1.4, reversalCount: 1 }), "no-turn"),
      copyQ(makeTurnStats({ durationSec: 1.4, reversalCount: 3 }), "no-turn"),
      copyQ(
        makeTurnStats({
          durationSec: 1.4,
          dipCm: null,
          dipFrac: null,
          heightM: null,
          heightSource: null,
          reacquireSec: null,
        }),
        "no-turn",
      ),
      copyQ(
        makeTurnStats({
          durationSec: 1.4,
          dipCm: null,
          dipFrac: null,
          reacquireSec: 4.2,
          reacquireCapped: true,
        }),
        "no-turn",
      ),
      copyQ(
        makeTurnStats({
          durationSec: 0.6,
          entryClipped: true,
          dipCm: null,
          dipFrac: null,
          reacquireSec: null,
        }),
        "no-turn",
      ),
      // turnCue selection order:
      copyQ(
        makeTurnStats({
          dipCm: 8,
          dipFrac: 0.05,
          reversalCount: 2,
          durationSec: 3.5,
          reacquireCapped: true,
        }),
        "no-turn",
      ),
      copyQ(makeTurnStats({ reversalCount: 1, durationSec: 3.5 }), "no-turn"),
      copyQ(
        makeTurnStats({ durationSec: 3.5, reacquireSec: 5, reacquireCapped: true }),
        "no-turn",
      ),
      copyQ(makeTurnStats({ durationSec: 0.6 }), "no-turn"),
      copyQ(makeTurnStats({ durationSec: 0.6, entryClipped: true }), "no-turn"),
      copyQ(makeTurnStats({ durationSec: 3.5, entryClipped: true }), "no-turn"),
      copyQ(makeTurnStats({ reacquireSec: 4.5 }), "no-turn"),
      copyQ(makeTurnStats({ reacquireSec: 6, reacquireCapped: true }), "no-turn"),
      copyQ(makeTurnStats({ durationSec: 1.4 }), "no-turn"),
      copyQ(
        makeTurnStats({ dipCm: null, dipFrac: null, heightM: null, heightSource: null }),
        "no-turn",
      ),
      copyQ(makeTurnStats({ reacquireSec: null }), "no-turn"),
      copyQ(makeTurnStats({ durationSec: 1.4, reacquireSec: 2.5 }), "no-turn"),
      copyQ(makeTurnStats({ durationSec: 1.4, entryClipped: true }), "no-turn"),
    ]);
    analytic(
      "turn-stats/copy-branches",
      `null lines [${rows.slice(0, 7).map((r) => r.line)}]; selection "${rows[14].cue}" > "${rows[15].cue}" > "${rows[16].cue}"`,
      rows[0].line === "TURN: NO TURN ON A ONE-WAY ROUTE" &&
        rows[0].cue === null &&
        rows[1].line === "TURN: NO READ - THE WALK ENDED BEFORE THE MARK" &&
        rows[1].cue === null &&
        rows[2].line === "TURN: NO READ - YOU NEVER SETTLED ON THE MARK" &&
        rows[2].cue === null && // holdCue owns the mark facts
        rows[3].cue ===
          "You turned inside the hold beat - freeze for the count, then turn." &&
        rows[4].cue ===
          "No 180 showed on the head path - turn at the mark and face the walk home." &&
        rows[5].cue === "The walk ended mid-turn - finish the turn and bring it home." &&
        rows[6].line === "TURN: NO READ - TRACKING WENT DARK AT THE MARK" &&
        rows[6].cue === null &&
        rows[7].line === "TURN 1.4S - ONE MOTION - DIP 2 CM - LINE IN 1.2S" &&
        rows[8].line === "TURN 1.4S · ONE MOTION · DIP 2 CM · LINE IN 1.2S" &&
        rows[9].line.includes("1 SWEEP-BACK - ") &&
        rows[10].line.includes("3 SWEEP-BACKS") &&
        rows[11].line === "TURN 1.4S - ONE MOTION" && // null sub-channels omit
        rows[12].line === "TURN 1.4S - ONE MOTION - LINE NOT RE-CENTERED" &&
        rows[13].line === "TURN 0.6S FROM THE HOLD RELEASE - ONE MOTION" &&
        rows[14].cue === "You sank 8 cm through the turn - stay tall as you come around." &&
        rows[15].cue ===
          "Your head swept back once mid-turn - one motion, commit the turn." &&
        rows[16].cue === "The turn took 3.5 s - hit the mark, turn, and go." &&
        rows[17].cue === "You whipped the turn in 0.6 s - give it one controlled beat." &&
        rows[18].cue === null && // clipped suppresses BOTH duration verdicts
        rows[19].cue === null &&
        rows[20].cue ===
          "It took 4.5 s to find the line again after the turn - square up and go." &&
        rows[21].cue ===
          "You never got back on the line after the turn - find center, then drive home." &&
        rows[22].cue === "One motion in 1.4 s, level all the way round - a clean turn." &&
        rows[23].cue === null && // an unmeasured dip cannot back "level all the way round"
        rows[24].cue === null && // an unmeasured return leg cannot back clean either
        rows[25].cue === "One motion in 1.4 s, level all the way round - a clean turn." &&
        rows[26].cue === null, // clipped between bands: no claim
    );
  }
  {
    const [tables] = c("turn-strings-and-constants", [{ fn: "tables" }]);
    analytic(
      "turn-stats/derivation-pins",
      `enter/commit/exit ${tables.TURN_ENTER_DEG}/${tables.TURN_COMMIT_DEG}/${tables.TURN_EXIT_DEG}, dip ${tables.TURN_DIP_FAULT_FRAC}, hi ${tables.TURN_DUR_BASE_HI_SEC}`,
      tables.TURN_EXIT_DEG === 180 - tables.TURN_ENTER_DEG &&
        tables.TURN_ENTER_DEG < tables.TURN_COMMIT_DEG &&
        tables.TURN_COMMIT_DEG < tables.TURN_EXIT_DEG &&
        tables.TURN_DIP_FAULT_FRAC === POSTURE_CUE_M / HOLD_REF_HEAD_M &&
        tables.TURN_DIP_FAULT_FRAC === 0.0375 &&
        tables.TURN_REACQ_BAR_M === LATERAL_CUE_M &&
        tables.TURN_DUR_BASE_HI_SEC === 4 / 1.8 && // declared AS its derivation (§H)
        tables.TURN_DUR_BASE_PACE_MPS === 0.85 &&
        tables.TURN_EXPLAIN.includes(`${HOLD_WINDOW_SEC.toFixed(1)} s hold window`) &&
        tables.TURN_EXPLAIN.includes(`${tables.TURN_REV_DEADBAND_DEG} deg`) &&
        tables.TURN_EXPLAIN.includes(`${tables.TURN_REACQ_BAR_M.toFixed(2)} m`) &&
        tables.PRESENTATION_EXPLAIN_WITH_TURN.includes("does not feed this score"),
    );
  }

  return cases;
}

// =============================================================================
// Build everything, THEN write (an invariance throw emits nothing).
// =============================================================================

console.error("[golden] building vector families…");
emit("walk-stats", walkStatsCases());
emit("coach", coachCases());
emit("coach-live", coachLiveCases());
emit("progress", progressCases());
emit("pose-derive-world", poseDeriveWorldCases());
emit("solo-derive", soloDeriveCases());
emit("gap-tape", gapTapeCases());
emit("walk-replay", walkReplayCases());
emit("walk-replay-solo", walkReplaySoloCases());
emit("modes", modesCases());
emit("coach-tables", coachTablesCases());
emit("copy-variants", copyVariantCases());
// Wave 1 (registered in golden-format.ts GOLDEN_MODULES by the VECTORS
// commit — the adjudication §J bootstrap order).
emit("fit-core", fitCoreCases());
emit("head-carriage", headCarriageCases());
emit("hold-stats", holdStatsCases());
emit("repeatability", repeatabilityCases());
// Wave 2 (registered in golden-format.ts GOLDEN_MODULES by the VECTORS
// commit — the adjudication §F bootstrap order; head-carriage stays
// byte-identical this wave, no --expect-stale).
emit("beat-stats", beatStatsCases());
emit("turn-stats", turnStatsCases());

// Paired modules: every raw case must carry its rigid twin (belt to the
// braces above — the freshness test re-validates this on every vitest run).
for (const file of files) {
  if (!PAIRED_MODULES.includes(file.module)) continue;
  const names = new Set(file.cases.map((c) => c.name));
  for (const c of file.cases) {
    if (c.name.endsWith(RIGID_SUFFIX)) continue;
    if (!names.has(`${c.name}${RIGID_SUFFIX}`)) {
      throw new Error(`${file.module}: ${c.name} is missing its rigid twin`);
    }
  }
}

function serializeGolden(file) {
  const s = sanitize(file);
  const lines = ["{"];
  lines.push(` "schema": ${JSON.stringify(s.schema)},`);
  lines.push(` "module": ${JSON.stringify(s.module)},`);
  lines.push(` "generatedBy": ${JSON.stringify(s.generatedBy)},`);
  lines.push(' "cases": [');
  s.cases.forEach((c, i) => {
    lines.push("  {");
    lines.push(`   "name": ${JSON.stringify(c.name)},`);
    lines.push(`   "input": ${JSON.stringify(c.input)},`);
    lines.push(`   "expect": ${JSON.stringify(c.expect)}`);
    lines.push(`  }${i < s.cases.length - 1 ? "," : ""}`);
  });
  lines.push(" ]");
  lines.push("}");
  return lines.join("\n") + "\n";
}

if (CHECK) {
  // Rebuild-in-memory vs disk, ignoring generatedBy (provenance legitimately
  // differs across regens of the same behavior). Round both sides through
  // the same serialize/decode so non-finite sentinels compare as numbers.
  let failed = 0;
  for (const file of files) {
    const path = join(OUT_DIR, `${file.module}.json`);
    let disk;
    try {
      disk = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      console.error(`[golden --check] ${file.module}: unreadable — ${err.message}`);
      failed++;
      continue;
    }
    const mem = decodeNums(JSON.parse(serializeGolden(file)));
    delete mem.generatedBy;
    const dsk = decodeNums(disk);
    delete dsk.generatedBy;
    const d = goldenDiff(mem, dsk);
    if (d !== null) {
      console.error(`[golden --check] STALE test/golden/${file.module}.json — ${d}`);
      failed++;
    }
  }
  const onDisk = readdirSync(OUT_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
  for (const m of onDisk) {
    if (!files.some((f) => f.module === m)) {
      console.error(`[golden --check] ORPHAN test/golden/${m}.json — not emitted by this generator`);
      failed++;
    }
  }

  // Swift-mirror freshness (SOLO-MODE §6 drift lock, Swift half). The mirror
  // at native/ios-companion/Tests/XRunwayCoreTests/golden/ is a committed copy
  // consumed by the Swift XCTest suite. Deep-compare each mirror family
  // against the freshly-built in-memory vectors (ignoring generatedBy), so
  // regenerating test/golden/ without re-running sync-golden.sh goes RED here
  // — closing the "regenerate but forget the mirror" gap on the repo side, not
  // only at the Swift build's preBuildScripts gate.
  let mirrorFiles = [];
  try {
    mirrorFiles = readdirSync(MIRROR_DIR).filter((f) => f.endsWith(".json"));
  } catch (err) {
    console.error(
      `[golden --check] mirror dir unreadable at ${MIRROR_DIR} — run native/ios-companion/scripts/sync-golden.sh (${err.message})`,
    );
    failed++;
  }
  for (const file of files) {
    const path = join(MIRROR_DIR, `${file.module}.json`);
    let disk;
    try {
      disk = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      console.error(
        `[golden --check] MIRROR MISSING/unreadable ${file.module}.json — run sync-golden.sh (${err.message})`,
      );
      failed++;
      continue;
    }
    const mem = decodeNums(JSON.parse(serializeGolden(file)));
    delete mem.generatedBy;
    const dsk = decodeNums(disk);
    delete dsk.generatedBy;
    const d = goldenDiff(mem, dsk);
    if (d !== null) {
      console.error(
        `[golden --check] STALE MIRROR ${file.module}.json — ${d}; run native/ios-companion/scripts/sync-golden.sh`,
      );
      failed++;
    }
  }
  for (const f of mirrorFiles) {
    const m = f.replace(/\.json$/, "");
    if (!files.some((file) => file.module === m)) {
      console.error(
        `[golden --check] ORPHAN MIRROR ${f} — not emitted by this generator; run sync-golden.sh`,
      );
      failed++;
    }
  }

  if (failed > 0) {
    console.error(
      `[golden --check] ${failed} stale/invalid module(s): the checked-in ` +
        `vectors do not match the working tree. Regenerate deliberately: ` +
        `node ${SCRIPT}`,
    );
    process.exit(1);
  }
  console.error(
    `[golden --check] all ${files.length} families match the working tree.`,
  );
} else {
  // --expect-stale write-side guard: the escape declares WHICH families may
  // move; every other family must rebuild byte-identical to disk (ignoring
  // generatedBy) or NOTHING is written — undeclared drift refuses loudly.
  if (EXPECT_STALE) {
    for (const name of EXPECT_STALE) {
      if (!files.some((f) => f.module === name)) {
        console.error(
          `[golden] --expect-stale names unknown family "${name}" — refusing.`,
        );
        process.exit(2);
      }
    }
    let undeclared = 0;
    for (const file of files) {
      if (EXPECT_STALE.has(file.module)) continue;
      const path = join(OUT_DIR, `${file.module}.json`);
      let disk = null;
      try {
        disk = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        console.error(
          `[golden] UNDECLARED NEW family ${file.module} (no disk file) — ` +
            `add it to --expect-stale if intended.`,
        );
        undeclared++;
        continue;
      }
      const mem = decodeNums(JSON.parse(serializeGolden(file)));
      delete mem.generatedBy;
      const dsk = decodeNums(disk);
      delete dsk.generatedBy;
      const d = goldenDiff(mem, dsk);
      if (d !== null) {
        console.error(
          `[golden] UNDECLARED DRIFT in ${file.module} — ${d} — the ` +
            `--expect-stale escape only covers the named families; refusing.`,
        );
        undeclared++;
      }
    }
    if (undeclared > 0) {
      process.exit(1);
    }
    console.error(
      `[golden] --expect-stale verified: only [${[...EXPECT_STALE].join(", ")}] differ.`,
    );
  }
  mkdirSync(OUT_DIR, { recursive: true });
  let totalCases = 0;
  for (const file of files) {
    const path = join(OUT_DIR, `${file.module}.json`);
    writeFileSync(path, serializeGolden(file));
    totalCases += file.cases.length;
    console.error(`[golden]  test/golden/${file.module}.json — ${file.cases.length} cases`);
  }
  console.error(
    `[golden] emitted ${files.length} files, ${totalCases} cases @ ${gitSha.slice(0, 7)}`,
  );
}
