/**
 * (X)RUNWAY shader suite — REV2 (first-person training simulator).
 *
 * - Live floor: the founder's warp-lines shader, moved from the (deleted) LED
 *   wall onto the RUNWAY DECK TOP. Carolina Blue family — deep navy base,
 *   blue warp lines, white-hot cores. ADAPTIVE: a soft glow tracks the
 *   trainee's position along the deck (uProgress) and every footstrike fires
 *   an expanding ripple ring (uStepTime/uStepZ, ~1.2 s life).
 * - Deck edge chase strips: Carolina Blue comet chase toward the pose mark.
 * - Audience camera flashes: cool-white per-point paparazzi blinks (Points).
 *
 * Every material declares { uTime, uEnergy }; the live floor additionally
 * declares { uProgress, uStepTime, uStepZ }. ShaderTimeSystem feeds them all
 * (tag entities with ShaderDriven) and only writes the uniforms a material
 * actually declares. GLSL is WebGL2-safe GLSL ES 1.00 (Three.js
 * ShaderMaterial default); loops are tiny (≤ 15 ring taps) for the Quest GPU
 * budget.
 *
 * Brand palette reaches GLSL as vec3 consts GENERATED from theme.ts BRAND at
 * module load (glslVec3 interpolation — no hand-mirrored hex literals here;
 * test/brand-palette.test.ts enforces it).
 */

import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
  createComponent,
  createSystem,
  type Material,
  type Object3D,
} from "@iwsdk/core";
import { type Signal } from "@preact/signals-core";

import { DEFAULT_MODE, type TrainingMode } from "./modes.js";
import { type RunwayLayout } from "./runway-layout.js";
import {
  pointInPolygon,
  shapeFloorPlan,
  type FloorPlan,
  type SegmentedPath,
} from "./runway-shape.js";

import { BRAND, DECK_NEAR_Z, STAGE, glslVec3 } from "./theme.js";
import {
  HEAVE_SEG_X,
  HEAVE_SEG_Y,
  unifiedFloorGridSize,
} from "./stage-budget.js";
import {
  DEFAULT_FLOOR_ANCHORS,
  floorAnchorUv,
  HOLD_FLASH_MAX,
} from "./show-choreo.js";

/* ------------------------------------------------------------------------ */
/* Shared timing + layout constants (TS side, injected into GLSL)            */
/* ------------------------------------------------------------------------ */

/**
 * uTime wrap period in seconds. Uniforms are float32 on the GPU; unbounded
 * elapsed seconds quantize the ring/ripple math after hours of kiosk
 * runtime. uStepTime is wrapped with the SAME modulus, and the floor shader
 * computes ripple age wrap-safely via mod().
 */
const TIME_WRAP = 3600;

/**
 * Footstrike time-to-live (seconds). The ripple visual lives ~1.2 s; past
 * this the system writes the "no step" sentinel (-1) so a stale
 * globals.lastStep can never re-fire a ghost ripple after a time wrap.
 */
const STEP_TTL = 2;
/** Pose-mark paparazzi burst: lifetime (s) and exponential decay rate. */
const BURST_TTL = 2.2;
const BURST_DECAY = 1.7;

// #45: the floor's start/pose anchors are LIVE uniforms (uAnchorStart /
// uAnchorPose), resolved from the compiled walk route into the unified
// floor's bbox-uv frame by floorAnchorUv (show-choreo.ts) — no more
// compile-time constants derived from the default 7 m deck.

/* ------------------------------------------------------------------------ */
/* Shared GLSL fragments                                                     */
/* ------------------------------------------------------------------------ */

/** Brand palette + tiny hash, shared by the fragment shaders. */
const GLSL_BRAND = /* glsl */ `
// (X)RUNWAY brand REV2 — generated from theme.ts BRAND at module load (single source).
const vec3 C_BG         = ${glslVec3(BRAND.bg)}; // stage black
const vec3 C_NAVY       = ${glslVec3(BRAND.navy)}; // deep navy floor base
const vec3 C_ACCENT     = ${glslVec3(BRAND.accent)}; // Carolina Blue
const vec3 C_ACCENTSOFT = ${glslVec3(BRAND.accentSoft)};
const vec3 C_ACCENTDEEP = ${glslVec3(BRAND.accentDeep)};
const vec3 C_WHITE      = ${glslVec3(BRAND.white)};

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

const VERT_UV = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/* ------------------------------------------------------------------------ */
/* Live floor — the deck top IS the show, and it HEAVES under each step       */
/* ------------------------------------------------------------------------ */

/** Recent footsteps fed to the floor heave — packed in vec4s (max 4 active). */
export const FLOOR_STEPS = 4;
// Live-floor cell density (HEAVE_SEG_X/Y) + the capped grid sizer live in stage-budget
// (pure, so the budget tests can enforce the bound). The visible grid is shader-drawn,
// so this only sets how finely the heave DISPLACEMENT is tessellated — coarse enough to
// stay smooth at arm's length while bounding the Quest's per-frame vertex cost.

/**
 * Live-floor geometry: a subdivided plane lying flat (rotateX) so the vertex
 * shader can HEAVE the surface up under each footstep. Uses only the BUILT-IN
 * `uv`/`position` attributes (custom attributes don't bind reliably across all
 * GPUs/emulators), so the heave reads its tile coordinate from uv.
 */
export function createHeaveFloorGeometry(
  width: number,
  length: number,
): BufferGeometry {
  const g = new PlaneGeometry(width, length, HEAVE_SEG_X, HEAVE_SEG_Y);
  g.rotateX(-Math.PI / 2); // +v points down-deck (uv.y = 0 at the near edge)
  return g;
}

/**
 * ONE continuous reactive-floor mesh for a whole shape, built in stage-root-local
 * space by clipping a single heave-density grid (over the {@link FloorPlan} bbox)
 * to the shape's `coverage` polygon (its outline — rounded for T/X/U). This gives
 * one connected surface that follows the (rounded) outline with no per-segment
 * seams. Vertices are sparse (only the corners of covered cells), and every
 * vertex's `uv` is its bbox-normalized position — the shared coordinate space the
 * floor shader reads (`uDeck` = { plan.width, plan.length }). A straight runway's
 * square outline yields the full grid, same density as before.
 */
export function createUnifiedFloorGeometry(
  plan: FloorPlan,
  coverage: Array<[number, number]>,
): BufferGeometry {
  const bw = plan.width || 1;
  const bl = plan.length || 1;
  // unifiedFloorGridSize CAPS the grid at HEAVE_SEG_X/Y: the cell size is fixed, so a
  // long/wide shape (a 60 m preset, a maxed armSpan, a big fit-to-room room) would
  // otherwise grow the vertex/triangle count with FOOTPRINT AREA — re-creating the very
  // Quest GPU overrun the crash fix removed (and worse, the bigger the runway). Bounded:
  // cells just grow coarser past one deck (imperceptible at AR distance) while the worst
  // case stays ~48x96 (≤9216 tris) regardless of physical size.
  const { nx, nz } = unifiedFloorGridSize(bw, bl);
  const dx = bw / nx;
  const dz = bl / nz;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const vmap = new Map<number, number>();
  const vert = (i: number, j: number): number => {
    const key = j * (nx + 1) + i;
    const cached = vmap.get(key);
    if (cached !== undefined) return cached;
    const x = plan.minX + i * dx;
    const z = plan.minZ + j * dz;
    const id = positions.length / 3;
    positions.push(x, 0, z);
    uvs.push((x - plan.minX) / bw, (z - plan.minZ) / bl);
    vmap.set(key, id);
    return id;
  };
  // A runway STRIP can be narrower than one (capped) cell on a maxed shape — e.g.
  // an 80 m spine caps cellL at ~0.83 m, wider than a 0.8 m arm. A centre-only
  // coverage test would then skip cells along that arm and punch HOLES in the live
  // floor. So emit a cell if its centre OR any corner lies in the coverage: thin
  // strips stay continuous (rendered a touch wider, not broken). Still bounded —
  // at most nx*nz cells — and inside cells short-circuit on the centre test, so the
  // extra corner tests only run on boundary/empty cells.
  const hw = dx * 0.5;
  const hl = dz * 0.5;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const cx = plan.minX + (i + 0.5) * dx;
      const cz = plan.minZ + (j + 0.5) * dz;
      if (
        !pointInPolygon(cx, cz, coverage) &&
        !pointInPolygon(cx - hw, cz - hl, coverage) &&
        !pointInPolygon(cx + hw, cz - hl, coverage) &&
        !pointInPolygon(cx - hw, cz + hl, coverage) &&
        !pointInPolygon(cx + hw, cz + hl, coverage)
      ) {
        continue;
      }
      const a = vert(i, j);
      const b = vert(i + 1, j);
      const c2 = vert(i, j + 1);
      const d2 = vert(i + 1, j + 1);
      indices.push(a, b, c2, b, d2, c2);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(positions, 3));
  g.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  return g;
}

// Four unrolled strike contributions (one per vec4 component). Manual unroll +
// vec4 packing avoids uniform-array indexing (flaky on some emulators).
const HEAVE_STEP_BLOCKS = ["x", "y", "z", "w"]
  .map(
    (k) => `{
    float st = uStepT.${k};
    float dt = mod(uTime - st + T_WRAP, T_WRAP);
    float valid = step(0.0, st) * (1.0 - step(LIFE, dt)); // 1 = alive strike
    vec2 dd = (vec2(uStepX.${k}, uStepA.${k}) - uv) * uDeck; // normalized -> meters
    float spatial = exp(-dot(dd, dd) * 11.0);              // ~0.3 m punch radius
    float rise = smoothstep(0.0, RISE, dt);
    float fall = exp(-dt * 4.2);
    float bounce = 1.0 + 0.26 * sin(dt * 40.0) * exp(-dt * 11.0); // settle bounce
    float hv = valid * spatial * max(rise * fall * bounce, 0.0);
    h = max(h, hv);
  }`,
  )
  .join("\n  ");

/**
 * Floor vertex shader: each recent footstep punches the surface UP a few inches
 * with a sharp rise + damped settle (a forceful, tactile heave), then passes the
 * heave amount to the fragment so the risen area flashes. Strikes are packed in
 * vec4s — uStepT/uStepA/uStepX = wrapped time / along 0..1 / across 0..1 — and
 * unrolled. uDeck (deck meters) converts the normalized uv distance to meters so
 * the punch stays round on any runway.
 */
const FLOOR_VERT = /* glsl */ `
uniform float uTime;             // wrapped seconds (% T_WRAP)
uniform float uEnergy;
uniform vec4 uStepT;             // up to 4 recent strike times (wrapped); -1 = empty
uniform vec4 uStepA;             // strike ALONG the deck, 0..1
uniform vec4 uStepX;             // strike ACROSS the deck, 0..1 (0.5 = center)
uniform vec2 uDeck;              // deck size meters (width, length)
varying vec2 vUv;
varying float vHeave;            // 0..1 heave at this point (fragment glow)

const float T_WRAP = ${TIME_WRAP.toFixed(1)};
const float AMP   = 0.2;         // peak heave (m) ~ 8 in — clearly visible bump
const float LIFE  = 0.55;        // heave lifetime (s)
const float RISE  = 0.045;       // rise-to-peak (s) — the punch

void main() {
  vUv = uv;
  float h = 0.0;
  ${HEAVE_STEP_BLOCKS}
  vHeave = clamp(h, 0.0, 1.0);
  vec3 pos = position;
  pos.y += vHeave * AMP * mix(0.7, 1.0, clamp(uEnergy, 0.0, 1.0));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

// Four unrolled footstep ripples (one per vec4 component) — each strike sends a
// CIRCLE expanding outward across the floor, like a puddle. Constant swizzle
// (.x/.y/.z/.w), no uniform-array indexing.
const RIPPLE_BLOCKS = ["x", "y", "z", "w"]
  .map(
    (k) => `{
    float st = uStepT.${k};
    float age = mod(uTime - st + T_WRAP, T_WRAP);
    float alive = step(0.0, st) * (1.0 - step(RIP_LIFE, age));
    vec2 sp = vec2((uStepX.${k} - 0.5) * uDeck.x, uStepA.${k} * uDeck.y);
    float sr = length(m - sp);
    float front = age * RIP_SPEED;
    float rg = exp(-pow((sr - front) * RIP_SHARP, 2.0))                 // lead ring
             + 0.45 * exp(-pow((sr - front + 0.26) * RIP_SHARP, 2.0))   // trailing
             + 0.22 * exp(-pow((sr - front + 0.52) * RIP_SHARP, 2.0));  // wakes
    // hold the ring near full brightness as it expands, THEN fade — so you see
    // a crisp circle sweep outward (not just a quick splash at the foot).
    ripple += rg * (1.0 - smoothstep(RIP_LIFE * 0.45, RIP_LIFE, age)) * alive;
  }`,
  )
  .join("\n  ");

const FLOOR_FRAG = /* glsl */ `
varying vec2 vUv;
varying float vHeave;    // 0..1 per-tile heave (from the vertex shader)
uniform float uTime;     // wrapped seconds (ShaderTimeSystem, % T_WRAP)
uniform float uEnergy;   // 0 house lights -> 1 full show
uniform float uProgress; // -1 outside a walk, else 0..1 trainee round-trip
uniform float uRingsOn;  // 1 = warp rings ("blue circles") on, 0 = off (toggle)
uniform float uBurst;    // 0..1 storm envelope: pose-mark hit + the FINALE (#18)
uniform float uHoldT;    // 0..1 M10 hold ramp (globals.holdLive.t01; 0 off-walk)
uniform vec4 uStepT;     // up to 4 recent strike times (wrapped); -1 = empty
uniform vec4 uStepA;     // strike ALONG the deck, 0..1
uniform vec4 uStepX;     // strike ACROSS the deck, 0..1 (0.5 = center)
uniform vec2 uDeck;      // THIS segment's size in meters (width, length)
uniform vec2 uAnchorStart; // START LINE in bbox uv (#45 — live, route-aware)
uniform vec2 uAnchorPose;  // POSE MARK in bbox uv (#45 — legB end on a U)

${GLSL_BRAND}

const float T_WRAP  = ${TIME_WRAP.toFixed(1)};  // must match ShaderTimeSystem
const float RIP_LIFE  = 1.7;   // footstep-ripple lifetime (s)
const float RIP_SPEED = 1.9;   // expansion (m/s) — leads the walk so it's seen
const float RIP_SHARP = 6.0;   // ring crispness (higher = thinner, crisper ring)

void main() {
  float e = clamp(uEnergy, 0.0, 1.0);

  // --- mosaic: quantize onto an aspect-true tile grid (~4.4 cm panels) ----
  vec2 cells = vec2(32.0, 160.0); // 1.4/32 == 7/160 -> square floor tiles
  vec2 cellId = floor(vUv * cells);
  vec2 cellUv = fract(vUv * cells) - 0.5;
  vec2 quv = (cellId + 0.5) / cells; // sample the field at tile centers

  // meters on the deck: x centered across width, y = 0 near edge -> uDeck.y
  vec2 m = vec2((quv.x - 0.5) * uDeck.x, quv.y * uDeck.y);

  // --- trainee anchor ------------------------------------------------------
  // uProgress folds down (0..0.5) and back (0.5..1). Outside a walk it is
  // -1, which clamps to the start line — so the glow rests exactly where the
  // trainee will stand, and every transition in/out of a walk is CONTINUOUS
  // (no pops; intensity rides uEnergy, which the director lerps smoothly).
  // #45: the anchors are LIVE bbox-uv points from the compiled route (2-D —
  // on a U the pose mark sits on legB, off the bbox centerline).
  float p = clamp(uProgress, 0.0, 1.0);
  float fold = 1.0 - abs(2.0 * p - 1.0);
  vec2 aUv = mix(uAnchorStart, uAnchorPose, fold);
  vec2 aPos = vec2((aUv.x - 0.5) * uDeck.x, aUv.y * uDeck.y); // m-space

  // ring focus: slow drift at idle, pulled onto the trainee as energy rises
  vec2 idleC = vec2(0.28 * sin(uTime * 0.09),
                    uDeck.y * (0.5 + 0.33 * sin(uTime * 0.05)));
  float lockT = smoothstep(0.30, 0.85, e);
  vec2 focus = mix(idleC, aPos, lockT);

  vec2 d = m - focus;
  float r = length(d * vec2(1.0, 0.42)); // stretch rings down the walk axis

  // --- warp rings (founder's reference shader, made periodic in r) --------
  // 3 color channels x 5 taps = 15 taps total (Quest fragment budget).
  float t = uTime * mix(0.05, 0.40, e);  // slow crawl -> hypnotic show
  float lw = mix(0.0008, 0.0028, e);     // line energy
  float spread = mix(0.010, 0.045, e);   // chromatic channel separation
  vec3 rings = vec3(0.0);
  for (int j = 0; j < 3; j++) {
    float pj = t + spread * float(j);
    for (int i = 1; i <= 5; i++) {
      float f = fract(r - pj + float(i) * 0.045);
      rings[j] += lw * float(i * i) / max(min(f, 1.0 - f), 1.5e-3);
    }
  }
  rings = min(rings, vec3(1.5));

  // lines energize around the trainee (kept gentle so the near-field doesn't
  // blow out to white and bury the per-step ripple — the headline reaction)
  float prox = exp(-(d.x * d.x * 1.6 + d.y * d.y * 0.30));
  rings *= 1.0 + 0.7 * prox * lockT;
  // Floor-glow toggle (founder call 2026-07-13: the "blue circles" can distract):
  // gate ONLY the always-on warp rings here. The per-step footstrike ripples,
  // the adaptive position glow, the edge chase + the M10 hold ring all stay.
  rings *= uRingsOn;

  // navy depth -> Carolina Blue lines -> white-hot cores
  vec3 col = rings.x * C_ACCENTDEEP * 0.95
           + rings.y * C_ACCENT
           + rings.z * mix(C_ACCENTSOFT, C_WHITE, 0.60) * 0.80;

  // --- adaptive glow: the floor knows where the trainee is (kept subtle so
  //     the per-step ripples below stay the dominant reaction) ---------------
  vec2 g = m - aPos;
  float glow = exp(-(g.x * g.x * 2.4 + g.y * g.y * 0.50));
  col += (C_ACCENT * 0.7 + C_ACCENTSOFT * 0.3) * glow * mix(0.06, 0.16, e);

  // --- footstep ripples: EVERY recent strike sends a bright CIRCLE expanding
  // outward across the floor — like walking through a puddle. Up to 4 at once,
  // fed by the step buffer (uStepT/uStepA/uStepX). This is the headline reaction.
  float ripple = 0.0;
  ${RIPPLE_BLOCKS}
  // (the ripple ring + heave core are added AFTER the soft-clip below, so they
  // stay crisp bright accents instead of being compressed into the floor blue.)

  // --- idle heartbeat: the floor never reads dead ---------------------------
  float breathe = 0.5 + 0.5 * sin(uTime * 0.4);
  col += C_ACCENT * exp(-r * r * 0.6) * mix(0.035, 0.008, e)
       * (0.6 + 0.4 * breathe);

  // --- floor physicality ----------------------------------------------------
  float tile = 1.0 - smoothstep(0.32, 0.50, max(abs(cellUv.x), abs(cellUv.y)));
  col *= mix(0.62, 1.0, tile);           // soft panel seams (not LED grout)
  col *= 0.93 + 0.14 * hash12(cellId);   // per-tile gain variance

  // subtle sheen band sweeping toward the pose mark
  col *= 1.0 + 0.06 * e * sin(vUv.y * 9.0 - uTime * (0.3 + 1.3 * e));

  // master exposure rides energy; soft-clip; deep-navy floor base.
  // Held back at high energy so the floor stays rich blue (not blown white)
  // and the bright ripple ring + heave flash read as distinct accents.
  col *= mix(0.55, 0.78, e * e);
  // burst moment (pose mark + finale, #18): the whole floor lifts with the
  // flash storm — a bounded +35% swell that decays with uBurst, applied
  // BEFORE the soft-clip so it can never blow out (passthrough-safe).
  col *= 1.0 + 0.35 * clamp(uBurst, 0.0, 1.0);
  col = col / (1.0 + col * 0.40);
  col = max(col, C_NAVY);

  // --- footstep reaction OVER the soft-clipped floor: a crisp bright ring
  //     expands from EVERY strike (puddle-like), and the struck tile flashes a
  //     hot core where the floor heaves up. This is the headline reaction.
  //     Clamped so overlapping rings read as distinct circles, not a white mass.
  vec3 ripCol = C_WHITE * 0.9 + C_ACCENTSOFT * 0.6;
  col += ripCol * min(ripple, 1.25) * (0.8 + 0.45 * e);
  col += mix(C_ACCENT, C_WHITE, 0.65) * min(vHeave, 1.0) * (0.55 + 0.35 * e);

  // --- M10 hold ring: while the trainee holds the pose mark, the light pools
  //     around their feet — an additive ring centered on the POSE MARK anchor,
  //     easing from a 0.9 m approach read down to 0.18 m (inside the 0.4 m
  //     mark radius: "the light found you") as the measured hold ramp rises.
  //     Driven by uHoldT = globals.holdLive.t01 (ShowDirector's window ramp;
  //     released over 0.6 s after the window). Added AFTER the soft-clip like
  //     the ripple ring so it reads as a crisp accent; bounded (<= ~1.35 peak
  //     channel) and inside the deck-border melt below — passthrough-safe.
  //     Brand palette only; zero geometry, zero draw calls.
  float holdT = clamp(uHoldT, 0.0, 1.0);
  if (holdT > 0.0) {
    vec2 hp = m - vec2((uAnchorPose.x - 0.5) * uDeck.x, uAnchorPose.y * uDeck.y);
    // RIP_SHARP-family width (6.0 -> ~17 cm 1/e half-width): reads as a ring,
    // not a hairline, on the ~4.4 cm tile grid.
    float hring = exp(-pow((length(hp) - mix(0.9, 0.18, holdT)) * 6.0, 2.0));
    col += (C_ACCENT * 0.75 + C_ACCENTSOFT * 0.45)
         * hring * holdT * (0.4 + 0.6 * e);
  }

  // melt into the real floor at the deck border
  float edge = smoothstep(0.0, 0.060, vUv.x)
             * (1.0 - smoothstep(0.940, 1.0, vUv.x))
             * smoothstep(0.0, 0.030, vUv.y)
             * (1.0 - smoothstep(0.970, 1.0, vUv.y));
  col = mix(C_NAVY * 0.45, col, edge);

  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * Live floor material — the deck's TOP SURFACE (1.4 × 7 m).
 *
 * UV contract: vUv.x spans the deck WIDTH; vUv.y runs along the WALK AXIS
 * with 0 at the NEAR edge (trainee start) and 1 at the far end. A standard
 * `PlaneGeometry(STAGE.deckWidth, STAGE.deckLength)` with `rotation.x =
 * -PI/2` (normal up) maps exactly like this — the geometry's +Y edge lands
 * at world -Z (far end).
 *
 * Uniforms (ShaderTimeSystem feeds all of them — tag the entity
 * ShaderDriven):
 * - uTime, uEnergy — as every suite material.
 * - uProgress — globals.walkProgress: -1 outside a walk, else 0..1
 *   round-trip. The adaptive glow folds it down-and-back; at -1 it rests on
 *   the start line, so walk transitions never pop.
 * - uStepTime, uStepZ — last footstrike (wrapped seconds + deck-local 0..1):
 *   an expanding ripple ring radiates from each strike, fading ~1.2 s.
 *   uStepTime -1 = no live step.
 *
 * Idle: slow, dim, elegant. Energy 1: full warp-line show centered on the
 * trainee.
 */
export function createLiveFloorMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uEnergy: { value: 0 },
      uProgress: { value: -1 },
      // Floor-glow toggle (globals.floorRingsVisible): 1 = warp rings on.
      uRingsOn: { value: 1 },
      // Storm envelope: pose-mark paparazzi burst + the finale re-fire (#18).
      uBurst: { value: 0 },
      // M10 hold ramp (globals.holdLive.t01) — rests at 0 outside a hold.
      uHoldT: { value: 0 },
      // Recent-footstep ring buffer (heave + glow). Seeded empty (-1).
      // Recent-footstep buffers (heave + glow). 4 strikes packed per vec4.
      uStepT: { value: new Float32Array(4).fill(-1) }, // wrapped times
      uStepA: { value: new Float32Array(4) }, // along 0..1
      uStepX: { value: new Float32Array(4) }, // across 0..1 (0.5 center)
      uDeck: { value: new Float32Array([STAGE.deckWidth, STAGE.deckLength]) },
      // #45: LIVE route anchors (bbox uv) — seeded with the default 7 m deck's
      // marks; ShaderTimeSystem re-derives them from every compiled path.
      uAnchorStart: {
        value: new Float32Array([
          DEFAULT_FLOOR_ANCHORS.startX,
          DEFAULT_FLOOR_ANCHORS.startY,
        ]),
      },
      uAnchorPose: {
        value: new Float32Array([
          DEFAULT_FLOOR_ANCHORS.poseX,
          DEFAULT_FLOOR_ANCHORS.poseY,
        ]),
      },
    },
    vertexShader: FLOOR_VERT,
    fragmentShader: FLOOR_FRAG,
  });
}

/* ------------------------------------------------------------------------ */
/* Deck edge chase strips                                                    */
/* ------------------------------------------------------------------------ */

// The chase coordinate is derived from WORLD z (theme.ts stage map), so one
// shared material drives both strips in perfect sync no matter how the strip
// boxes are constructed or oriented. Assumes the stage root sits at the world
// origin (the (X)RUNWAY layout contract).
const CHASE_VERT = /* glsl */ `
const float NEAR_Z = ${DECK_NEAR_Z.toFixed(4)}; // deck near edge (world z)
const float LEN    = ${STAGE.deckLength.toFixed(4)}; // deck length (m)
varying float vAlong; // 0 at near edge -> 1 at the far (pose-mark) end
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vAlong = clamp((NEAR_Z - wp.z) / LEN, 0.0, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const CHASE_FRAG = /* glsl */ `
varying float vAlong;
uniform float uTime;
uniform float uEnergy;

${GLSL_BRAND}

void main() {
  float e = clamp(uEnergy, 0.0, 1.0);

  // idle: dim slow breathe drifting toward the pose mark
  float breathe = 0.10 + 0.07 * (0.5 + 0.5 * sin(uTime * 0.7 - vAlong * 4.0));

  // show: comet chase running down the walk axis (vAlong increases far-ward)
  float phase = vAlong * 9.0 - uTime * mix(0.15, 1.90, e);
  float comet = pow(fract(phase), mix(8.0, 5.0, e));
  float comet2 = pow(fract(phase + 0.5), 9.0) * e * 0.6; // offset second layer

  float blend = smoothstep(0.12, 0.55, e);
  float i = mix(breathe, 0.12 + (comet + comet2) * (0.5 + 0.9 * e), blend);

  // Carolina Blue body, white-hot comet heads, faint soft-blue floor
  vec3 col = C_ACCENT * i + C_WHITE * pow(i, 3.0) * 0.65 + C_ACCENTSOFT * 0.02;
  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * Deck edge light-strip material — share ONE instance across both strips.
 * Energy 0: dim slow breathe. Energy 1: fast Carolina Blue comet chase
 * toward the pose mark. Uniforms: { uTime, uEnergy }. Tag the strip
 * entities ShaderDriven.
 */
export function createChaseStripMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uEnergy: { value: 0 },
    },
    vertexShader: CHASE_VERT,
    fragmentShader: CHASE_FRAG,
  });
}

/* ------------------------------------------------------------------------ */
/* Perimeter edge strip — ONE continuous chase running the whole outline.     */
/* ------------------------------------------------------------------------ */

// The comet chases along a per-vertex arc-length fraction (aAlong) instead of
// world z, so it flows around the shape's outline (T/X/U) — not just straight
// down the spine. Reuses CHASE_FRAG.
const PERIMETER_VERT = /* glsl */ `
attribute float aAlong;
varying float vAlong;
void main() {
  vAlong = aAlong;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export function createPerimeterStripMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uEnergy: { value: 0 },
    },
    vertexShader: PERIMETER_VERT,
    fragmentShader: CHASE_FRAG,
  });
}

/**
 * A thin ribbon hugging the INSIDE of a shape's outline loop (from
 * {@link shapeOutline}, CCW, stage-root-local), inset by `stripW` toward the
 * interior. Each edge becomes a quad extended `stripW` at both ends so corners
 * overlap cleanly (no gaps). Carries a per-vertex `aAlong` = cumulative
 * perimeter fraction (0..1) so the chase comet runs around the whole shape.
 * Replaces the per-segment edge strips that crossed at every junction.
 */
export function createPerimeterStripGeometry(
  outline: Array<[number, number]>,
  stripW = 0.07,
): BufferGeometry {
  const n = outline.length;
  const positions: number[] = [];
  const along: number[] = [];
  const indices: number[] = [];
  const y = STAGE.deckHeight + 0.006;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const [x1, z1] = outline[i];
    const [x2, z2] = outline[(i + 1) % n];
    total += Math.hypot(x2 - x1, z2 - z1);
  }
  total = total || 1;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const [x1, z1] = outline[i];
    const [x2, z2] = outline[(i + 1) % n];
    let dx = x2 - x1;
    let dz = z2 - z1;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const nx = -dz; // left normal -> interior for a CCW loop
    const nz = dx;
    const ex = dx * stripW;
    const ez = dz * stripW;
    const ox0 = x1 - ex;
    const oz0 = z1 - ez;
    const ox1 = x2 + ex;
    const oz1 = z2 + ez;
    const base = positions.length / 3;
    positions.push(
      ox0, y, oz0,
      ox1, y, oz1,
      ox0 + nx * stripW, y, oz0 + nz * stripW,
      ox1 + nx * stripW, y, oz1 + nz * stripW,
    );
    const a0 = acc / total;
    const a1 = (acc + len) / total;
    along.push(a0, a1, a0, a1);
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    acc += len;
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(positions, 3));
  g.setAttribute("aAlong", new Float32BufferAttribute(along, 1));
  g.setIndex(indices);
  return g;
}

/* ------------------------------------------------------------------------ */
/* Audience camera flashes                                                   */
/* ------------------------------------------------------------------------ */

// Geometry contract: a `aRand` float attribute in [0,1) per point.
const FLASH_VERT = /* glsl */ `
attribute float aRand;
uniform float uTime;
uniform float uEnergy;
uniform float uBurst;   // 0..1 paparazzi burst when the trainee hits the pose mark
uniform float uIdleGlint; // PIT ONLY: resting camera-ready lens glint (see below)
varying float vFlash;

void main() {
  float e = clamp(uEnergy, 0.0, 1.0);
  float b = clamp(uBurst, 0.0, 1.0);

  // Per-point constant blink clock (~1 Hz, jittered) so energy changes never
  // cause phase jumps; FREQUENCY scales purely via per-cycle probability.
  // A burst spins the clock faster so the storm visibly accelerates.
  float rate = (0.85 + 0.75 * fract(aRand * 5.71)) * (1.0 + 1.6 * b);
  float cycle = uTime * rate + aRand * 39.17;
  float ph = fract(cycle);

  // gate: does this point fire this cycle? 0 at e<=0.1 -> storm at e=1; a burst
  // forces the fire-probability toward a full storm regardless of show energy.
  float h = fract(sin(floor(cycle) * 12.9898 + aRand * 78.233) * 43758.5453);
  float q = max(max(e - 0.10, 0.0) / 0.90, b);
  float gate = step(h, (0.65 + 0.34 * b) * q * q);

  vFlash = gate * exp(-ph * 16.0) * (1.0 + 0.7 * b); // sharp attack, fast decay

  // PIT ONLY (uIdleGlint = 1, the crowd cloud keeps 0): a faint always-on
  // camera-ready glint, slow-pulsing per lens, so the press pack reads from
  // the START LINE even on a 20 m+ mapped runway where the figures are a
  // distant speck (founder call 2026-07-22: "visible from the start").
  // The glint UNDERLAYS the blink: max(), so a real flash always wins.
  float glint = uIdleGlint * (0.16 + 0.10 * sin(uTime * (1.3 + aRand) + aRand * 31.7));
  vFlash = max(vFlash, glint);

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float size = vFlash * (90.0 + 70.0 * fract(aRand * 7.31));
  // Perspective attenuation with a FIRING-GATED floor: at a long mapped
  // runway (20 m+) the raw size/-z shrinks a flash below one pixel and the
  // far end reads dead - a real show's pit twinkles from anywhere in the
  // house (founder report 2026-07-22). The floor scales with vFlash so a
  // decayed blink still vanishes; between blinks size is exactly 0.
  float px = size / max(0.6, -mv.z);
  float minPx = 3.5 * clamp(vFlash * 4.0, 0.0, 1.0);
  gl_PointSize = min(max(px, minPx), 72.0);
  gl_Position = projectionMatrix * mv;
}
`;

const FLASH_FRAG = /* glsl */ `
varying float vFlash;

void main() {
  if (vFlash < 0.004) discard;
  vec2 p = gl_PointCoord - 0.5;

  float core = 1.0 - smoothstep(0.0, 0.5, length(p));
  core *= core;
  // tiny horizontal lens streak — paparazzi glint
  float streak = exp(-abs(p.y) * 22.0) * exp(-abs(p.x) * 7.0);

  float a = (core + streak * 0.6) * vFlash;
  vec3 col = vec3(0.9200, 0.9650, 1.0000); // cool flash-white, blue whisper
  gl_FragColor = vec4(col * a, a);
}
`;

/**
 * Camera-flash material for ONE THREE.Points cloud over the audience.
 * Requires a per-point float attribute `aRand` in [0,1).
 * Energy 0: silence. Energy 1: cool-white paparazzi storm.
 * Uniforms: { uTime, uEnergy }. Tag the entity ShaderDriven.
 */
export function createCameraFlashMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uEnergy: { value: 0 },
      uBurst: { value: 0 },
      // Default 0 = the crowd cloud's exact legacy look; the pit builder
      // flips its OWN material instance to 1 (ShaderTimeSystem drives only
      // uTime/uEnergy/uBurst, so this survives the per-frame writes).
      uIdleGlint: { value: 0 },
    },
    vertexShader: FLASH_VERT,
    fragmentShader: FLASH_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}

const CROSSING_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Hero medallion for the X crossing: Carolina-Blue concentric rings expanding
// from a warm-white pulsing core, with a slow rotating 4-point star gleam that
// echoes the X arms, and a white flare on the pose burst. Additive over the
// live floor so the crossing reads as the dramatic centre of the runway.
const CROSSING_FRAG = `
precision mediump float;
uniform float uTime;
uniform float uEnergy;
uniform float uBurst;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;          // -1..1 across the disc
  float d = length(p);
  if (d > 1.0) discard;
  float e = clamp(uEnergy, 0.0, 1.0);
  float b = clamp(uBurst, 0.0, 1.0);
  float ang = atan(p.y, p.x);

  float ring = 0.5 + 0.5 * sin(d * 20.0 - uTime * (1.2 + 3.0 * e));
  ring = pow(ring, 4.0) * smoothstep(1.0, 0.2, d);

  float pulse = 0.6 + 0.4 * sin(uTime * (1.5 + 2.0 * e));
  float core = smoothstep(0.34, 0.0, d) * pulse;

  float star = pow(abs(cos(ang * 2.0 - uTime * 0.25)), 10.0);
  float gleam = star * smoothstep(1.0, 0.05, d) * (0.35 + 0.45 * e);

  float edge = smoothstep(1.0, 0.62, d);

  vec3 cAccent = ${glslVec3(BRAND.accent)}; // Carolina Blue
  vec3 cCore = ${glslVec3(BRAND.warmWhite)}; // warm white core
  float lum = (ring * 0.5 + gleam) * (0.28 + 0.9 * e) + core * (1.0 + 1.7 * b);
  vec3 col = mix(cAccent, cCore, clamp(core + gleam + b * 0.7, 0.0, 1.0));
  float a = clamp(lum * edge, 0.0, 1.0);
  gl_FragColor = vec4(col * a, a);
}
`;

/**
 * Hero crossing medallion for the X shape — a flat additive disc placed at the
 * crossing centre. Uniforms: { uTime, uEnergy, uBurst }. Tag the entity
 * ShaderDriven; lay it flat (rotation.x = -PI/2) just above the live floor.
 */
// ---------------------------------------------------------------------------
// Replay-ghost hologram — the LIGHT CROQUIS material (the 2026-07-27 visual
// research pass, docs/RESEARCH-ghost-visual.md; 12 adversarially-verified
// techniques). THE ROOT-CAUSE FIX over the rejected v2/v3 figure: normal
// alpha blending composited a near-black low-fresnel core OVER the dark
// house — a translucent dark statue by construction. This material is
// ADDITIVE (it can only add light), self-lit (interior body-glow gradient,
// never a hollow rim), with visible AA'd scan bands, an incandescent white
// rolloff at energy peaks, the hem light-dissolve that condenses the figure
// out of the floor glow, and a "presence" hotspot at the MEASURED head —
// the one honestly-tracked point burns hottest. Still ONE pass per mesh
// (the Meta overdraw law); DoubleSide so the far rim adds through the near
// side for a free volumetric read.
// ---------------------------------------------------------------------------

const HOLOGRAM_VERT = /* glsl */ `
uniform float uEchoPush;
varying vec3 vNormalW;
varying vec3 vWorldPos;
void main() {
  // Echo shells inflate along the normal so a trailing rim peeks outside
  // the hero silhouette (0 on the hero ghost).
  vec4 wp = modelMatrix * vec4(position + normal * uEchoPush, 1.0);
  vNormalW = mat3(modelMatrix) * normal;
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const HOLOGRAM_FRAG = /* glsl */ `
precision mediump float;
uniform float uTime;
uniform vec3 uTint;
uniform float uBaseY;      // world y of the figure's hem (deck + bob)
uniform vec3 uHeadCenter;  // world center of the head oval (the measured point)
uniform float uHeadHot;    // hotspot gain (hero 1.2, silver 0.7)
uniform float uHeadWarn;   // 0..1 out-of-band head pitch -> amber head
uniform float uSpeedNorm;  // smoothed recorded speed 0..1
uniform float uGhostGain;  // hero 1.0 / silver 0.8 / echo shells lower
varying vec3 vNormalW;
varying vec3 vWorldPos;
void main() {
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 N = normalize(vNormalW);
  // abs() = facing-invariant fresnel: DoubleSide correctness without a
  // gl_FrontFacing branch (Adreno-safe).
  float ndv = abs(dot(N, V));
  float fres = pow(1.0 - ndv, 1.5); // wide mid-tone band for the white rolloff
  float ly = vWorldPos.y - uBaseY;  // height above the hem, both meshes

  // Scan bands: sawtooth, pow-sharpened, slow upward drift, faded out by
  // fwidth where they would alias to shimmer (Quest headroom).
  float saw = mod((vWorldPos.y - uTime * 0.035) * 13.0, 1.0);
  float band = pow(saw, 3.0);
  band *= smoothstep(0.5, 0.15, fwidth(vWorldPos.y) * 13.0);

  // Interior body-glow: the figure has a body, not just a rim — brighter
  // toward chest/head.
  float grad = mix(0.35, 1.0, smoothstep(0.0, 1.7, ly));

  float energy = 0.12 * grad
               + 2.2 * fres
               + band * (0.10 + 0.55 * fres);
  // Tame the extreme grazing edge so the rim glows, never clips wide.
  energy *= smoothstep(0.85, 0.25, fres) * 0.6 + 0.7;

  // Micro-life: luminance only — a ~7 s breathe, a slow shimmer, and the
  // RECORDED speed feeding overall gain. Never vertex animation.
  energy *= 0.85 + 0.15 * sin(uTime * 0.9);
  energy *= 0.94 + 0.06 * sin(vWorldPos.y * 7.0 + uTime * 3.7);
  energy *= 1.0 + 0.13 * uSpeedNorm;

  // Hem light-dissolve: geometry touches the deck, the LIGHT condenses out
  // of the floor glow (the v1 "floating pill" can never recur).
  energy *= smoothstep(0.0, 0.14, ly);

  // The measured point burns hottest — the honesty marker.
  float headRegion = smoothstep(0.13, 0.0, distance(vWorldPos, uHeadCenter));
  energy += headRegion * uHeadHot;

  // Gain scales ENERGY (before the rolloff) so a subordinate ghost also
  // rolls to white LESS — a 0.8-gain silver must never outshine the hero.
  energy *= uGhostGain;

  // Incandescent rolloff: Carolina at mid-energy, cool blue-white at peaks.
  vec3 col = mix(uTint, vec3(0.88, 0.96, 1.0), smoothstep(0.9, 2.2, energy)) * energy;

  // CARRIAGE on the head (slate wave 1): when the RECORDED pitch leaves the
  // M8 band, the head's glow warms toward amber — the chin drop made
  // visible, on measured data only. uHeadWarn 0..1, driven by the theater.
  col = mix(col, vec3(1.0, 0.58, 0.24) * energy, uHeadWarn * headRegion);

  // 8-bit banding guard over the near-black house.
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;

  gl_FragColor = vec4(col, 1.0); // additive: attenuation lives in RGB
}
`;

/** Per-figure knobs for the shared hologram material. */
export interface HologramOpts {
  /** Overall gain: hero 1.0, silver comparison 0.8, echo shells 0.4/0.15. */
  gain?: number;
  /** Head-hotspot gain (hero 1.6, silver 1.2). */
  headHot?: number;
  /** Normal inflation in meters for trailing echo shells. */
  echoPush?: number;
}

/** One-pass ADDITIVE hologram material for the replay ghost figures.
 * `uTime` is advanced by ReplayTheaterSystem's visual clock (drifts while
 * paused); `uBaseY`/`uHeadCenter`/`uSpeedNorm` follow the figure per frame.
 * DoubleSide + depthTest + no depthWrite: still one translucent pass per
 * mesh — the far rim ADDS through the near side (volumetric read), it never
 * needs a second draw. */
export function createHologramMaterial(
  tintHex: number,
  opts: HologramOpts = {},
): ShaderMaterial {
  const mat = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uTint: { value: new Color(tintHex) },
      uBaseY: { value: 0 },
      uHeadCenter: { value: new Vector3(0, 1.69, 0) },
      uHeadHot: { value: opts.headHot ?? 1.2 },
      uHeadWarn: { value: 0 },
      uSpeedNorm: { value: 0 },
      uGhostGain: { value: opts.gain ?? 1 },
      uEchoPush: { value: opts.echoPush ?? 0 },
    },
    vertexShader: HOLOGRAM_VERT,
    fragmentShader: HOLOGRAM_FRAG,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });
  mat.forceSinglePass = true;
  return mat;
}

// ---------------------------------------------------------------------------
// SDF FOOTPRINTS + the REPLAY LIGHT RAIL (founder 2026-07-27: "more tactile
// and high fidelity foot step markers and line... not flat images").
// No textures anywhere: the pump sole/heel is an analytic signed-distance
// field evaluated per fragment (vector-crisp at any distance), embossed by a
// screen-derivative normal so it reads PRESSED INTO the deck; the trace is a
// floor ribbon + a small vertical light FIN (a flat floor line vanishes at
// grazing seat-level angles) with energy pulses traveling the path in
// recorded time order.
// ---------------------------------------------------------------------------

const FOOTPRINT_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vTint;
varying float vSeed;
varying vec3 vCamLocal;
void main() {
  vUv = uv;
  vTint = vec3(1.0);
  float seed = 0.0;
  mat4 m = modelMatrix;
  #ifdef USE_INSTANCING
    m = m * instanceMatrix;
    seed = instanceMatrix[3].x * 7.31 + instanceMatrix[3].z * 3.7;
  #endif
  #ifdef USE_INSTANCING_COLOR
    vTint = instanceColor;
  #endif
  vSeed = seed;
  // The print transform chain is rigid + optional mirror (scale.x = -1) =>
  // orthogonal => inverse = transpose. Camera into quad-local meters
  // (x across the print, z along it, y up out of the floor) for the
  // parallax march.
  vCamLocal = transpose(mat3(m)) * (cameraPosition - vec3(m[3][0], m[3][1], m[3][2]));
  gl_Position = projectionMatrix * viewMatrix * m * vec4(position, 1.0);
}
`;

const FOOTPRINT_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uEnergy;
varying vec2 vUv;
varying vec3 vTint;
varying float vSeed;
varying vec3 vCamLocal;

// Quad extent in meters (PlaneGeometry(0.13, 0.3) laid flat).
#define QW 0.13
#define QL 0.3
// Impression depth + the displaced-soil lip height (meters).
#define PIT_DEPTH 0.012
#define LIP_H 0.0035

float sdSeg(vec2 p, vec2 a, vec2 b, float ra, float rb) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - mix(ra, rb, h);
}
float sdRoundBox(vec2 p, vec2 c, vec2 half_, float r) {
  vec2 q = abs(p - c) - half_ + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float sdPrint(vec2 p) {
  float sole = smin(
    sdSeg(p, vec2(0.53, 0.62), vec2(0.545, 0.76), 0.085, 0.150),
    sdSeg(p, vec2(0.545, 0.76), vec2(0.50, 0.885), 0.150, 0.118),
    0.05
  );
  float heel = sdRoundBox(p, vec2(0.50, 0.27), vec2(0.105, 0.092), 0.055);
  return smin(sole, heel, 0.045);
}
// The impression heightfield (meters): a pressed pit inside the print, a
// raised displaced-soil lip just OUTSIDE the edge — the dinosaur-print
// profile.
float heightAt(vec2 p) {
  float d = sdPrint(p);
  float pit = smoothstep(0.02, -0.05, d);
  float lip = exp(-pow((d - 0.018) / 0.014, 2.0));
  return -PIT_DEPTH * pit + LIP_H * lip;
}

void main() {
  // Fragment position in quad-local meters on the floor plane (y = 0).
  vec3 fragL = vec3((vUv.x - 0.5) * QW, 0.0, (0.5 - vUv.y) * QL);
  vec3 rd = normalize(fragL - vCamLocal);
  rd.y = min(rd.y, -0.08); // grazing guard: the ray must descend
  // PARALLAX OCCLUSION: march the view ray into the heightfield so the
  // impression truly sinks below the floor and shifts with the viewpoint.
  vec2 uvStep = vec2(rd.x / QW, -rd.z / QL);
  float span = (PIT_DEPTH + LIP_H + 0.002) / -rd.y; // meters of ray to cover full depth
  const int STEPS = 14;
  float dt = span / float(STEPS);
  vec2 uvp = vUv;
  float y = LIP_H + 0.001; // start just above the lip
  vec2 uvHit = uvp;
  float yHit = y;
  for (int i = 0; i < STEPS; i++) {
    uvp += uvStep * dt;
    y += rd.y * dt;
    if (y <= heightAt(uvp)) { uvHit = uvp; yHit = y; break; }
    uvHit = uvp;
    yHit = y;
  }
  // 3 refinement halvings around the crossing.
  float back = dt * 0.5;
  for (int i = 0; i < 3; i++) {
    vec2 u2 = uvHit - uvStep * back;
    float y2 = yHit - rd.y * back;
    if (y2 > heightAt(u2)) { back *= 0.5; }
    else { uvHit = u2; yHit = y2; back *= 0.5; }
  }

  float d = sdPrint(uvHit);
  float pit = smoothstep(0.02, -0.05, d);
  float lip = exp(-pow((d - 0.018) / 0.014, 2.0));
  // Surface normal of the impression (finite differences, meters).
  float e = 0.012;
  float dhdx = (heightAt(uvHit + vec2(e, 0.0)) - heightAt(uvHit - vec2(e, 0.0))) / (2.0 * e * QW);
  float dhdz = (heightAt(uvHit + vec2(0.0, e)) - heightAt(uvHit - vec2(0.0, e))) / (2.0 * e * QL);
  vec3 n = normalize(vec3(-dhdx, 1.0, dhdz));
  float lit = clamp(dot(n, normalize(vec3(-0.35, 0.75, 0.5))), 0.0, 1.0);
  float depthF = clamp(-yHit / PIT_DEPTH, 0.0, 1.0);

  // The pressed walls in the deck's own soil tone; the trainee's light
  // POOLS at the bottom of the impression (instanceColor = dim/hot).
  vec3 soil = vec3(0.055, 0.075, 0.105) * (0.35 + 0.75 * lit);
  float pool = (0.35 + 0.65 * depthF) * (0.6 + 0.4 * sin(uTime * 1.2 + vSeed));
  vec3 col = soil + vTint * pit * pool * (0.3 + 0.7 * depthF);
  col += vTint * lip * lit * 0.3; // the displaced lip catches the key light
  col *= 1.0 + 0.3 * uEnergy;

  // The pit occludes the glowing floor beneath (a hole is not translucent);
  // the lip ring blends out into the untouched deck.
  float alpha = clamp(pit * 0.96 + lip * 0.5, 0.0, 0.96);
  // Ambient occlusion of the crevice: darker where deep AND near a wall.
  col *= 1.0 - 0.35 * pit * (1.0 - depthF);
  gl_FragColor = vec4(col, alpha);
}
`;

/** The parallax-occlusion footprint IMPRESSION (InstancedMesh-aware:
 * instanceMatrix applied, instanceColor = the FootprintGlowSystem dim/hot
 * channel pooling in the pit). The interior is near-opaque — a pressed
 * hole occludes the floor — and shifts with the viewpoint like a real
 * depression. Drive uTime/uEnergy via ShaderDriven. */
export function createFootprintMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uEnergy: { value: 0 },
    },
    vertexShader: FOOTPRINT_VERT,
    fragmentShader: FOOTPRINT_FRAG,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
}

const TRACE_VERT = /* glsl */ `
attribute float aT;
attribute float aWarn;
varying vec2 vUv;
varying float vT;
varying float vWarn;
void main() {
  vUv = uv;
  vT = aT;
  vWarn = aWarn;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const TRACE_FRAG = /* glsl */ `
precision mediump float;
uniform float uTime;
uniform vec3 uTint;
uniform vec3 uAmber;
uniform float uKind; // 0 = floor ribbon (uv.x across), 1 = vertical fin (uv.y up)
varying vec2 vUv;
varying float vT;
varying float vWarn;
void main() {
  float g;
  if (uKind < 0.5) {
    float c = vUv.x * 2.0 - 1.0;
    g = exp(-c * c * 4.0); // hot core line, soft gaussian edges
  } else {
    g = pow(1.0 - vUv.y, 1.8) * 0.85; // the fin fades with height
  }
  // Energy pulses traveling the path in RECORDED time order (vT is the
  // sample's tape time) — the line flows the way the walk went.
  float flow = 0.70 + 0.42 * pow(0.5 + 0.5 * sin(6.2832 * (vT * 0.42 - uTime * 0.55)), 2.0);
  vec3 col = mix(uTint * 1.3, uAmber, vWarn);
  gl_FragColor = vec4(col * g * flow, 1.0); // additive
}
`;

/** The replay light-rail material: `kind` 0 = the floor ribbon, 1 = the
 * vertical fin that keeps the line visible from grazing seat-level angles.
 * One additive pass each; vT/aWarn ride vertex attributes. */
export function createTraceMaterial(kind: 0 | 1, tintHex: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uTint: { value: new Color(tintHex) },
      uAmber: { value: new Color(1.0, 0.5, 0.12) },
      uKind: { value: kind },
    },
    vertexShader: TRACE_VERT,
    fragmentShader: TRACE_FRAG,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });
}

const GEM_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const GEM_FRAG = /* glsl */ `
precision mediump float;
uniform float uTime;
uniform vec3 uTint;
varying vec2 vUv;
void main() {
  // Diamond-metric radial glow: a small standing gem of light.
  float d = abs(vUv.x - 0.5) + abs(vUv.y - 0.5);
  float glow = pow(smoothstep(0.5, 0.04, d), 2.0);
  float tw = 0.8 + 0.2 * sin(uTime * 2.1 + vUv.y * 3.0);
  gl_FragColor = vec4(uTint * glow * tw, 1.0); // additive
}
`;

/** The pace "beat gems": crossed vertical quads with a diamond-falloff glow
 * — readable from every angle, replacing the flat tick bars. */
export function createBeatGemMaterial(tintHex: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uTint: { value: new Color(tintHex) },
    },
    vertexShader: GEM_VERT,
    fragmentShader: GEM_FRAG,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });
}

export function createCrossingMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uEnergy: { value: 0 },
      uBurst: { value: 0 },
    },
    vertexShader: CROSSING_VERT,
    fragmentShader: CROSSING_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}

/* ------------------------------------------------------------------------ */
/* ShaderDriven tag + ShaderTimeSystem                                       */
/* ------------------------------------------------------------------------ */

/** Tag for any entity whose mesh/points material has uTime/uEnergy uniforms. */
export const ShaderDriven = createComponent("ShaderDriven", {});

function isDrivenMaterial(mat: Material): mat is ShaderMaterial {
  const sm = mat as ShaderMaterial;
  return (
    sm.isShaderMaterial === true &&
    sm.uniforms !== undefined &&
    sm.uniforms.uTime !== undefined &&
    sm.uniforms.uEnergy !== undefined
  );
}

/**
 * Cached per-material uniform refs, resolved ONCE on qualify so update()
 * touches plain objects only — and only the uniforms a material declares
 * (the optional ones are null for chase/flash materials).
 */
interface DrivenTarget {
  uTime: { value: number };
  uEnergy: { value: number };
  uProgress: { value: number } | null;
  /** Floor only: the warp-rings ("blue circles") on/off toggle. */
  uRingsOn: { value: number } | null;
  /** Floor only: recent-footstep heave buffers (vec4-packed) + deck size. */
  uStepT: { value: Float32Array } | null;
  uStepA: { value: Float32Array } | null;
  uStepX: { value: Float32Array } | null;
  uDeck: { value: Float32Array } | null;
  uBurst: { value: number } | null;
  /** Floor only (M10): the live hold ramp (globals.holdLive.t01, 0 absent). */
  uHoldT: { value: number } | null;
  /** Floor only (#45): live start-line / pose-mark anchors in bbox uv. */
  uAnchorStart: { value: Float32Array } | null;
  uAnchorPose: { value: Float32Array } | null;
  /** Which runway segment this floor material belongs to (0 = spine). */
  segIndex: number;
  /** Unified-floor bounding box [w, l] (set on the one continuous floor), or
   * null for a legacy per-segment floor whose uDeck follows its segment rect. */
  unifiedDeck: Float32Array | null;
}

function toTarget(sm: ShaderMaterial): DrivenTarget {
  return {
    uTime: sm.uniforms.uTime,
    uEnergy: sm.uniforms.uEnergy,
    uProgress: sm.uniforms.uProgress ?? null,
    uRingsOn: sm.uniforms.uRingsOn ?? null,
    uStepT: sm.uniforms.uStepT ?? null,
    uStepA: sm.uniforms.uStepA ?? null,
    uStepX: sm.uniforms.uStepX ?? null,
    uDeck: sm.uniforms.uDeck ?? null,
    uBurst: sm.uniforms.uBurst ?? null,
    uHoldT: sm.uniforms.uHoldT ?? null,
    uAnchorStart: sm.uniforms.uAnchorStart ?? null,
    uAnchorPose: sm.uniforms.uAnchorPose ?? null,
    segIndex: (sm.userData?.segIndex as number | undefined) ?? 0,
    unifiedDeck: (sm.userData?.unifiedDeck as Float32Array | undefined) ?? null,
  };
}

/**
 * Pushes time + show energy into every ShaderDriven material, plus the REV2
 * adaptive uniforms into materials that declare them:
 * - uProgress  <- globals.walkProgress (signal, peek; -1 outside a walk)
 * - uStepTime / uStepZ <- globals.lastStep plain ref { time, z } | null
 *   (time = ECS update() seconds, wrapped to the shared TIME_WRAP modulus;
 *   REV3: z is ALREADY the deck-local along FRACTION 0..1 — fed straight to
 *   uStepZ; a step older than STEP_TTL or a null ref writes the -1 "no step"
 *   sentinel).
 *
 * Material/uniform refs are cached per entity on qualify (one traverse),
 * dropped on disqualify, and flattened into a plain array — zero per-frame
 * allocation.
 */
export class ShaderTimeSystem extends createSystem({
  driven: { required: [ShaderDriven] },
}) {
  /** entity.index -> that entity's driven uniform targets. */
  private targets!: Map<number, DrivenTarget[]>;
  /** Flattened cache iterated in update() — rebuilt only on (dis)qualify. */
  private flat!: DrivenTarget[];
  /** Shader-clock time (s) the active pose-mark burst started; -1 = none. */
  private burstT0 = -1;
  /** Private rising-edge latch for globals.poseBurst (we no longer clear the
   *  shared flag, so other consumers — the HUD turn-back cue — still see it). */
  private burstConsumed = false;
  /** Private rising-edge latch for globals.finishBurst (#18: the finale re-fires
   *  the same uBurst storm; same never-clear-the-shared-flag law as poseBurst —
   *  StageMoodSystem and the SFX layer edge the flag with their own latches). */
  private finishConsumed = false;

  // -- Footstep heave buffers — ONE 4-strike ring buffer PER SEGMENT (keyed by
  //    segIndex). A strike on segment N (globals.lastStep.seg) ripples only that
  //    segment's floor mesh; idle segments keep the -1 sentinel. vec4-packed:
  //    wrapped time + normalized along/across, alternating left/right.
  private readonly stepBuffers = new Map<
    number,
    { stepT: Float32Array; stepA: Float32Array; stepX: Float32Array; head: number; parity: number }
  >();
  /** Reused -1 fill for segments with no live strikes. */
  private readonly emptySteps = new Float32Array(4).fill(-1);
  /** lastStep.time of the most recently consumed strike (rising-edge detect). */
  private lastConsumedStep = -1;
  /** Shape resolved into the unified-floor frame (bbox + per-segment local
   * placement) — used to map a footstrike onto the one continuous floor's uv. */
  private floorPlan: FloorPlan | null = null;
  /** #45: live start/pose anchors (bbox uv), re-derived on every remap and
   * copied into floor materials that declare uAnchorStart/uAnchorPose.
   * Preallocated — updated in the compiledPath subscription, never per frame. */
  private readonly anchorStart = new Float32Array([
    DEFAULT_FLOOR_ANCHORS.startX,
    DEFAULT_FLOOR_ANCHORS.startY,
  ]);
  private readonly anchorPose = new Float32Array([
    DEFAULT_FLOOR_ANCHORS.poseX,
    DEFAULT_FLOOR_ANCHORS.poseY,
  ]);

  /** Re-derive the route anchors for a (new) compiled path (#45). */
  private applyAnchors(path: SegmentedPath): void {
    const a = floorAnchorUv(path);
    this.anchorStart[0] = a.startX;
    this.anchorStart[1] = a.startY;
    this.anchorPose[0] = a.poseX;
    this.anchorPose[1] = a.poseY;
  }

  private segBuffer(seg: number): {
    stepT: Float32Array;
    stepA: Float32Array;
    stepX: Float32Array;
    head: number;
    parity: number;
  } {
    let b = this.stepBuffers.get(seg);
    if (b === undefined) {
      b = {
        stepT: new Float32Array(4).fill(-1),
        stepA: new Float32Array(4),
        stepX: new Float32Array(4),
        head: 0,
        parity: 0,
      };
      this.stepBuffers.set(seg, b);
    }
    return b;
  }

  init(): void {
    this.targets = new Map();
    this.flat = [];

    this.cleanupFuncs.push(
      this.queries.driven.subscribe(
        "qualify",
        (entity) => {
          const root = entity.object3D as Object3D | undefined;
          if (!root) {
            return;
          }
          const found: DrivenTarget[] = [];
          root.traverse((obj) => {
            const mat = (obj as unknown as { material?: Material | Material[] })
              .material;
            if (!mat) {
              return;
            }
            if (Array.isArray(mat)) {
              for (const m of mat) {
                if (isDrivenMaterial(m)) {
                  found.push(toTarget(m));
                }
              }
            } else if (isDrivenMaterial(mat)) {
              found.push(toTarget(mat));
            }
          });
          if (found.length > 0) {
            this.targets.set(entity.index, found);
            this.rebuildFlat();
          }
        },
        true, // replay entities that qualified before this system registered
      ),
    );

    this.cleanupFuncs.push(
      this.queries.driven.subscribe("disqualify", (entity) => {
        if (this.targets.delete(entity.index)) {
          this.rebuildFlat();
        }
      }),
    );

    // Prune per-segment strike buffers when the route shrinks (e.g. U→straight),
    // so buffers for removed segments don't persist as a slow leak.
    const pathSig = this.globals.compiledPath as
      | Signal<SegmentedPath>
      | undefined;
    if (pathSig !== undefined) {
      this.floorPlan = shapeFloorPlan(pathSig.peek());
      this.applyAnchors(pathSig.peek());
      this.cleanupFuncs.push(
        pathSig.subscribe((p) => {
          this.floorPlan = shapeFloorPlan(p);
          this.applyAnchors(p);
          const segCount = p.segments.length;
          for (const seg of this.stepBuffers.keys()) {
            if (seg >= segCount) this.stepBuffers.delete(seg);
          }
        }),
      );
    }
  }

  private rebuildFlat(): void {
    this.flat.length = 0;
    for (const list of this.targets.values()) {
      for (let i = 0; i < list.length; i++) {
        this.flat.push(list[i]);
      }
    }
  }

  update(_delta: number, time: number): void {
    const energySignal = this.globals.showEnergy as Signal<number> | undefined;
    const energy = energySignal !== undefined ? energySignal.peek() : 0;

    // Mode intensity biases the whole show energy the suite sees: Challenge
    // (1.0) drives the floor crawl / chase / flashes harder than Beginner
    // (0.35) at the same phase, so the four modes feel visually distinct.
    const modeSig = this.globals.activeMode as Signal<TrainingMode> | undefined;
    const intensity = modeSig !== undefined ? modeSig.peek().intensity : DEFAULT_MODE.intensity;
    const energyBiased = energy * (0.72 + 0.28 * intensity);

    // Pose-mark paparazzi burst: ShowDirector sets globals.poseBurst = true when
    // the trainee reaches the mark and holds it (clearing only at walk-start).
    // Fire once on the rising edge via a PRIVATE latch and do NOT clear the
    // shared flag — the HUD turn-back cue rising-edges the same flag at a lower
    // priority, so clearing it here would starve it.
    if (this.globals.poseBurst === true) {
      if (!this.burstConsumed) {
        this.burstT0 = time;
        this.burstConsumed = true;
      }
    } else {
      this.burstConsumed = false;
    }
    // Finale burst (#18): crossing the finish line re-fires the storm — same
    // uBurst pipeline (flash cloud when the crowd is visible, X-crossing flare,
    // live-floor lift), same private-latch discipline. In immersive XR with the
    // crowd hidden there is no flash cloud to drive; the floor + crossing (and
    // the stage/music finale beats) still carry the moment, and the uniform
    // write itself is harmless.
    if (this.globals.finishBurst === true) {
      if (!this.finishConsumed) {
        this.burstT0 = time;
        this.finishConsumed = true;
      }
    } else {
      this.finishConsumed = false;
    }
    let burst = 0;
    if (this.burstT0 >= 0) {
      const age = time - this.burstT0;
      if (age >= 0 && age < BURST_TTL) {
        burst = Math.exp(-age * BURST_DECAY);
      } else {
        this.burstT0 = -1;
      }
    }
    // M10 flash surge on MEASURED stillness: the hold FLOORS the decaying
    // burst at HOLD_FLASH_MAX * still01 * t01 — the poseBurst edge still
    // fires its sting above it, and the surge dies the moment the trainee
    // moves (still01 is the accumulator's live head-speed read) or the
    // window releases (t01). Capped at 0.7 so the sustained storm sits at
    // flash gate scale ~0.89, below the finale's ~0.99 wall (HOLD_FLASH_MAX
    // derivation) — the finale stays the show's peak. NO new uniform: the
    // existing uBurst pipeline (flash cloud, floor lift, crossing flare)
    // carries it. Peeked defensively + finiteness-gated.
    const holdLive = this.globals.holdLive as
      | { t01: number; still01: number }
      | null
      | undefined;
    let holdT = 0;
    if (holdLive != null && Number.isFinite(holdLive.t01)) {
      holdT = holdLive.t01 < 0 ? 0 : holdLive.t01 > 1 ? 1 : holdLive.t01;
      const s01 = Number.isFinite(holdLive.still01)
        ? holdLive.still01 < 0
          ? 0
          : holdLive.still01 > 1
            ? 1
            : holdLive.still01
        : 0;
      const surge = HOLD_FLASH_MAX * s01 * holdT;
      if (surge > burst) {
        burst = surge;
      }
    }

    const progressSignal = this.globals.walkProgress as
      | Signal<number>
      | undefined;
    const progress = progressSignal !== undefined ? progressSignal.peek() : -1;

    // Footstep ring buffer (drives the floor heave). lastStep is a PLAIN ref
    // { time, z } where z is the deck-local along FRACTION (0..1). On a NEW
    // strike (time changed) push it as wrapped-time + deck-meters position,
    // alternating left/right so successive steps heave opposite sides.
    const wrapped = time % TIME_WRAP;
    const pathSig = this.globals.compiledPath as
      | Signal<SegmentedPath>
      | undefined;
    const path = pathSig ? pathSig.peek() : undefined;
    const lastStep = this.globals.lastStep as
      | { time: number; z: number; seg?: number }
      | null
      | undefined;
    if (
      lastStep &&
      lastStep.time !== this.lastConsumedStep &&
      time - lastStep.time < STEP_TTL
    ) {
      this.lastConsumedStep = lastStep.time;
      const plan = this.floorPlan;
      const seg = lastStep.seg ?? 0;
      // Map the strike (struck segment + along-fraction) into the ONE continuous
      // floor's bbox-normalized uv, so the ripple fires at the foot on the actual
      // leg/arm — not at the bbox center line. All strikes share buffer 0 (one
      // floor). A strike on a segment that no longer exists (route shrank) is
      // dropped; lastConsumedStep is already advanced so it won't retry.
      if (plan && seg < plan.segments.length) {
        const ps = plan.segments[seg];
        const frac = lastStep.z < 0 ? 0 : lastStep.z > 1 ? 1 : lastStep.z;
        const dAlong = (frac - 0.5) * ps.length; // meters from segment center
        const buf = this.segBuffer(0);
        // Alternate the foot ~16 cm L/R of the segment centerline (meters).
        const lat = (buf.parity === 0 ? 1 : -1) * 0.16;
        buf.parity ^= 1;
        const sy = Math.sin(ps.yaw);
        const cy = Math.cos(ps.yaw);
        // segment-local (along, lat) -> stage-root-local (matches the geometry).
        const lx = ps.cx + -sy * dAlong + cy * lat;
        const lz = ps.cz + -cy * dAlong + -sy * lat;
        buf.stepT[buf.head] = lastStep.time % TIME_WRAP;
        buf.stepA[buf.head] = (lz - plan.minZ) / (plan.length || 1); // along 0..1
        buf.stepX[buf.head] = (lx - plan.minX) / (plan.width || 1); // across 0..1
        buf.head = (buf.head + 1) % 4;
      }
    }
    // Retire strikes past their lifetime (every segment) so a time-wrap can't
    // re-fire them.
    for (const buf of this.stepBuffers.values()) {
      for (let i = 0; i < 4; i++) {
        if (buf.stepT[i] >= 0) {
          const age = (wrapped - buf.stepT[i] + TIME_WRAP) % TIME_WRAP;
          if (age > STEP_TTL) buf.stepT[i] = -1;
        }
      }
    }

    // Wrap before upload: uniforms are float32 on the GPU, and unbounded
    // elapsed seconds quantize the periodic shader math after hours of runtime.
    // Floor-glow toggle: gate the warp rings when globals.floorRingsVisible is
    // false (peek - zero-alloc, read once for every floor material this frame).
    const floorRingsSig = this.globals.floorRingsVisible as
      | Signal<boolean>
      | undefined;
    const ringsOn = (floorRingsSig?.peek() ?? true) ? 1 : 0;
    const flat = this.flat;
    for (let i = 0; i < flat.length; i++) {
      const tgt = flat[i];
      tgt.uTime.value = wrapped;
      tgt.uEnergy.value = energyBiased;
      if (tgt.uProgress !== null) {
        tgt.uProgress.value = progress;
      }
      if (tgt.uRingsOn !== null) {
        tgt.uRingsOn.value = ringsOn;
      }
      if (tgt.uStepT !== null) {
        // Route this floor material its OWN segment's strike buffer + deck size.
        const buf = this.stepBuffers.get(tgt.segIndex);
        tgt.uStepT.value.set(buf ? buf.stepT : this.emptySteps);
        if (buf) {
          if (tgt.uStepA !== null) tgt.uStepA.value.set(buf.stepA);
          if (tgt.uStepX !== null) tgt.uStepX.value.set(buf.stepX);
        }
        if (tgt.uDeck !== null) {
          if (tgt.unifiedDeck !== null) {
            // One continuous floor: uDeck is the shape bounding box (fixed).
            tgt.uDeck.value[0] = tgt.unifiedDeck[0];
            tgt.uDeck.value[1] = tgt.unifiedDeck[1];
          } else {
            const rect = path?.segments[tgt.segIndex]?.rect;
            tgt.uDeck.value[0] = rect ? rect.width : STAGE.deckWidth;
            tgt.uDeck.value[1] = rect ? rect.length : STAGE.deckLength;
          }
        }
        // #45: live route anchors (recomputed only on remap; cheap copy here
        // keeps rebuilt/requalified floor materials in sync, zero alloc).
        if (tgt.uAnchorStart !== null) {
          tgt.uAnchorStart.value.set(this.anchorStart);
        }
        if (tgt.uAnchorPose !== null) {
          tgt.uAnchorPose.value.set(this.anchorPose);
        }
      }
      if (tgt.uBurst !== null) {
        tgt.uBurst.value = burst;
      }
      // M10 hold ramp — plumbed exactly like uBurst (0 when no hold is live).
      if (tgt.uHoldT !== null) {
        tgt.uHoldT.value = holdT;
      }
    }
  }
}
