/**
 * A/B characterization harness for the deriveFromPoseWorld extraction
 * (SOLO-MODE.md §6.2 / Phase A1a — the "run the pre- and post-refactor builds
 * against the same synthetic frame tape" escape hatch).
 *
 * MetricsSystem is @iwsdk/core-coupled and cannot import into node, so the
 * PRE side does not replicate the math (the pose-derive-demo.mjs drift trap).
 * Instead it executes the REAL pre-refactor source: it slices the private
 * methods + shared constants straight out of a metrics.ts file (a git
 * worktree of the pre-refactor tree), erases the TS syntax mechanically with
 * typescript.transpileModule (no hand edits), and runs them against a plain
 * `this` shim carrying the same instance fields. beginWalkTracking and
 * resetCadence are sliced and executed too, so walk-start/handoff state comes
 * from the real code, not a re-implementation.
 *
 * The POST side imports the extracted src/pose-derive.ts directly (node type
 * stripping) via the shared makeRealSession in pose-tapes.ts — the exact
 * implementation vitest asserts against.
 *
 * Both sides run the SAME tapes through the SAME driver and serializer
 * (pose-tapes.ts), so equivalence is a byte-level diff:
 *
 *   git worktree add --detach /tmp/xrunway-pre <pre-refactor-sha>
 *   node test/pose-derive-tape.mjs --pre  /tmp/xrunway-pre/src/metrics.ts > pre.json
 *   node test/pose-derive-tape.mjs --post > post.json
 *   diff pre.json post.json   # must be empty
 *
 * `--post` output is also the checked-in golden fixture
 * (test/pose-derive-world.golden.json) the vitest suite replays.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";

import {
  buildTapes,
  makeRealSession,
  runTape,
  serializeRecords,
} from "./pose-tapes.ts";

// ---------------------------------------------------------------------------
// Source slicing — executes the real pre-refactor code, never a replica.
// ---------------------------------------------------------------------------

/** Slice a class method (signature through balanced braces) as a free function. */
function sliceMethod(src, name) {
  const m = src.match(new RegExp(`^  private ${name}\\(`, "m"));
  if (!m) throw new Error(`method ${name} not found in source`);
  const start = m.index;
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`unbalanced braces slicing ${name}`);
  return "function " + src.slice(start + "  private ".length, end);
}

/** Slice a top-level `const NAME = ...;` line verbatim. */
function sliceConst(src, name) {
  const m = src.match(new RegExp(`^const ${name} = .*;$`, "m"));
  if (!m) throw new Error(`const ${name} not found in source`);
  return m[0];
}

/** Slice a top-level function declaration (balanced braces). */
function sliceFunction(src, name) {
  const m = src.match(new RegExp(`^function ${name}\\(`, "m"));
  if (!m) throw new Error(`function ${name} not found in source`);
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf("{", m.index); i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return src.slice(m.index, end);
}

function transpile(code) {
  return ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

async function importCode(code) {
  const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  return import(url);
}

/** Build the PRE-refactor session factory from a metrics.ts source file. */
async function buildPreFactory(metricsPath) {
  const src = readFileSync(metricsPath, "utf8");
  const synthesized = [
    sliceConst(src, "SCORE_MIN"),
    sliceConst(src, "SCORE_MAX"),
    sliceConst(src, "NEUTRAL"),
    sliceConst(src, "IDEAL_PACE"),
    sliceConst(src, "STEP_MIN"),
    sliceConst(src, "STEP_MAX"),
    sliceConst(src, "RING_SIZE"),
    sliceFunction(src, "clampScore"),
    // DEFAULT_MODE is only the beginWalkTracking fallback when no mode signal
    // exists; the shim always provides modeSig, so this value is never read.
    "const DEFAULT_MODE = { idealPace: 0.85 };",
    sliceMethod(src, "kpOk"),
    sliceMethod(src, "beginWalkTracking"),
    sliceMethod(src, "resetCadence"),
    sliceMethod(src, "deriveFromPoseWorld"),
    "export { kpOk, beginWalkTracking, resetCadence, deriveFromPoseWorld, RING_SIZE, NEUTRAL };",
  ].join("\n\n");
  const mod = await importCode(transpile(synthesized));

  // The real WalkStatsAccumulator from the SAME tree as the target source.
  const walkStatsSrc = readFileSync(
    join(dirname(metricsPath), "walk-stats.ts"),
    "utf8",
  );
  const { WalkStatsAccumulator } = await importCode(transpile(walkStatsSrc));

  return (idealPace) => {
    // `this` shim: the MetricsSystem instance fields the sliced methods touch,
    // with the class-field initializer values from metrics.ts.
    const stats = new WalkStatsAccumulator();
    const shim = {
      // helpers the sliced body calls as this.*
      kpOk: mod.kpOk,
      stats,
      modeSig: { peek: () => ({ idealPace }) },
      globals: {},
      // lifecycle
      active: false,
      walkTime: 0,
      publishAcc: 0,
      smooth: new Float32Array(7),
      target: new Float32Array(7),
      // head-path state (touched by beginWalkTracking/resetCadence)
      havePrev: false,
      baselineY: 0,
      baselineAcc: 0,
      baselineSamples: 0,
      bobBaseline: 0,
      bobSign: 0,
      lastCrossTime: -1,
      intervals: new Float32Array(mod.RING_SIZE),
      intervalIdx: 0,
      intervalCount: 0,
      speedEma: 0,
      latEma: 0,
      heightDevEma: 0,
      // pose-path state
      posePrevHipX: 0,
      posePrevHipZ: 0,
      poseHavePrev: false,
      poseSpeedEma: 0,
      poseLatEma: 0,
      poseUprightEma: 0.92,
      poseHeadingX: 0,
      poseHeadingZ: -1,
      poseBobBaseline: 0,
      poseBobHavePrev: false,
      poseBobSign: 0,
      poseLastCross: -1,
      poseLastT: -1,
      poseHeadingValid: false,
      lastUsedExternal: false,
      idealPace: 0.85,
    };
    mod.beginWalkTracking.call(shim); // the REAL walk-start reset
    return {
      derive: (frame, poseDt, walkTime) => {
        shim.walkTime = walkTime; // update() accumulates this before deriving
        mod.deriveFromPoseWorld.call(shim, frame, poseDt);
      },
      resetCadence: () => mod.resetCadence.call(shim),
      snapshot: () => ({
        posePrevHipX: shim.posePrevHipX,
        posePrevHipZ: shim.posePrevHipZ,
        poseHavePrev: shim.poseHavePrev,
        poseSpeedEma: shim.poseSpeedEma,
        poseLatEma: shim.poseLatEma,
        poseUprightEma: shim.poseUprightEma,
        poseHeadingX: shim.poseHeadingX,
        poseHeadingZ: shim.poseHeadingZ,
        poseHeadingValid: shim.poseHeadingValid,
        poseBobBaseline: shim.poseBobBaseline,
        poseBobHavePrev: shim.poseBobHavePrev,
        poseBobSign: shim.poseBobSign,
        poseLastCross: shim.poseLastCross,
        intervals: Array.from(shim.intervals),
        intervalIdx: shim.intervalIdx,
        intervalCount: shim.intervalCount,
      }),
      targets: () => Array.from(shim.target),
      live: () => ({
        pace: stats.livePaceMps,
        lat: stats.liveLateralM,
        post: stats.livePostureM,
      }),
      finalize: (durationSec) => stats.finalize(durationSec),
    };
  };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const mode = args[0];
let makeSession;
if (mode === "--pre") {
  if (!args[1]) {
    console.error("usage: node test/pose-derive-tape.mjs --pre <path/to/pre-refactor/metrics.ts>");
    process.exit(2);
  }
  makeSession = await buildPreFactory(args[1]);
  console.error(`[pose-derive-tape] PRE mode: sliced ${args[1]}`);
} else if (mode === "--post") {
  makeSession = makeRealSession;
  console.error("[pose-derive-tape] POST mode: src/pose-derive.ts via pose-tapes.makeRealSession");
} else {
  console.error("usage: node test/pose-derive-tape.mjs --pre <metrics.ts> | --post");
  process.exit(2);
}

const records = buildTapes().map((tape) => runTape(makeSession, tape));
process.stdout.write(serializeRecords(records));
console.error(
  `[pose-derive-tape] ${records.length} tapes, ${records.reduce((a, r) => a + r.steps.length, 0)} steps recorded`,
);
