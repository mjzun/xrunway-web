/**
 * (X)RUNWAY — stage set, REV3 (layout-driven first-person AR training sim).
 *
 * REV2 shipped a fixed deck hard-wired to "runs down world -Z, centered on
 * x=0". REV3's licensing pitch is "map your unique runway": the user maps the
 * virtual runway onto THEIR real floor, so the whole set must re-fit a single
 * editable `RunwayLayout` (globals.runwayLayout, a Signal). This module:
 *
 *   - Builds the ENTIRE set under one stage root in runway-LOCAL space (runway
 *     center at local origin, forward = local -Z, +lateral = local +X). The
 *     root carries the world placement: position = (centerX, 0, centerZ),
 *     rotation.y = yaw. Deck, live-floor plane, edge strips, pose mark, shoe
 *     prints, audience, truss/fixtures, spot, shadow catcher are ALL parametric
 *     on layout.length / layout.width.
 *   - Relayouts on the runwayLayout signal: a position/yaw-only change is a
 *     cheap root-transform update; a length/width change disposes the
 *     layout-dependent children (entity.dispose() — frees GPU resources) and
 *     rebuilds them. Mapping is a discrete action, so the rebuild cost is fine.
 *     StageMoodSystem / FootprintGlowSystem use marker components + qualify
 *     (replayExisting) so they re-acquire refs after a rebuild.
 *   - Renders a light Carolina-Blue MAP PREVIEW overlay while globals.mapMode
 *     != "off": a translucent layout outline (draftLayout if set, else the
 *     committed layout), a start marker + line to the live reticle, and a floor
 *     reticle ring. Cheap lines/rings; fully hidden when mapMode == "off".
 *     The mapMode / draftLayout / mapPoints / reticle globals are written by
 *     MappingSystem and created in index.ts — read defensively (may be
 *     undefined early).
 *
 * Carolina Blue only. Zero per-frame allocation in the systems. Draw-call
 * budget unchanged from REV2 (the preview adds a few thin line/ring meshes,
 * only while mapping).
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CapsuleGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  createComponent,
  createSystem,
  CylinderGeometry,
  DoubleSide,
  Euler,
  ExtrudeGeometry,
  HemisphereLight,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Points,
  Quaternion,
  RingGeometry,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  SpotLight,
  SRGBColorSpace,
  Vector3,
  type Entity,
  type World,
} from "@iwsdk/core";
import type { Signal } from "@preact/signals-core";

import type {
  AudienceLive,
  AudienceLiveSeat,
  AudienceSeatEntry,
} from "./crowd-gaze-core.js";

import {
  createCameraFlashMaterial,
  createCrossingMaterial,
  createLiveFloorMaterial,
  createPerimeterStripGeometry,
  createPerimeterStripMaterial,
  createFootprintMaterial,
  createUnifiedFloorGeometry,
  ShaderDriven,
} from "./shaders.js";
import {
  DEFAULT_LAYOUT,
  poseAlong,
  startAlong,
  type RunwayLayout,
} from "./runway-layout.js";
import {
  compileShape,
  DEFAULT_SHAPE,
  pointInPolygon,
  roundOutline,
  routeToWorld,
  shapeFloorPlan,
  shapeOutline,
  type FloorPlan,
  type SegmentedPath,
} from "./runway-shape.js";
import { DEFAULT_MODE, type TrainingMode } from "./modes.js";
import {
  FINALE_TOTAL_SEC,
  finaleEnvelope,
  HOLD_HOUSE_DIM,
  HOLD_SPOT_TIGHTEN,
  idleSweepAmplitude,
} from "./show-choreo.js";
import { BRAND, BRAND_CSS, STAGE } from "./theme.js";
import { SEAT_STEP, audienceColumnCount, lampCount } from "./stage-budget.js";
import type { AudienceModel } from "./audience-assets.js";

/* ------------------------------------------------------------------------ */
/* Marker components — systems find their scene objects through these.       */
/* (REV2 law carried into REV3: qualify/replay subscriptions, NO module-     */
/* scope singleton refs — so a relayout rebuild re-acquires cleanly.)        */
/* ------------------------------------------------------------------------ */

const StageSpotRig = createComponent("StageSpotRig", {});
const StageHemiLight = createComponent("StageHemiLight", {});
const StagePoseMark = createComponent("StagePoseMark", {});
const FootprintGuides = createComponent("FootprintGuides", {});
/** Tags the runway root entity so MappingSystem etc. could find it if needed. */
const StageRoot = createComponent("StageRoot", {});

/* ------------------------------------------------------------------------ */
/* Walk-path layout (LOCAL space). All distances derive from layout.length / */
/* layout.width so the prints + audience + pose mark re-fit on a remap.       */
/*                                                                            */
/* LOCAL FRAME: runway center at the origin, forward (start -> pose) = -Z,    */
/* +lateral = +X. Local z spans [-length/2 (far/pose end) .. +length/2        */
/* (near/start end)]. `along` (runway-layout.ts) is 0 at the near/start end   */
/* and `length` at the far/pose end, so:  localZ(along) = length/2 - along.   */
/* ------------------------------------------------------------------------ */

/** Spacing between consecutive footstrikes down the deck. */
const STRIDE = 0.62;
/** Cross-step: prints land +/-0.02 m off the center line. */
const PRINT_X = 0.02;
/** Toe-out, radians (sign applied per foot). */
const TOE_OUT = 0.1;

/** Local Z (m) of an `along` coordinate. Forward = -Z, near/start = +length/2. */
function localZForAlong(length: number, along: number): number {
  return length / 2 - along;
}

/** Print tints (build-time constants; FootprintGlowSystem writes them). */
const FOOT_DIM = new Color(BRAND.accentDeep).multiplyScalar(0.55);
const FOOT_NEAR = new Color(BRAND.accent);
const FOOT_HOT = new Color(BRAND.accentSoft).lerp(new Color(BRAND.white), 0.45);

/** Deterministic hash — keeps audience jitter / flash spread stable per build. */
function rnd(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/* ------------------------------------------------------------------------ */
/* Geometry merge helper (REV2): transform each part by its local matrix,    */
/* then concatenate position / normal / uv / index. Keeps indexed geometry.  */
/* ------------------------------------------------------------------------ */

function mergeParts(parts: BufferGeometry[]): BufferGeometry {
  let vCount = 0;
  let iCount = 0;
  for (const g of parts) {
    vCount += g.attributes.position.count;
    iCount += g.index !== null ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  let vo = 0;
  let io = 0;
  for (const g of parts) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array as Float32Array, vo * 3);
    nor.set(g.attributes.normal.array as Float32Array, vo * 3);
    if (g.attributes.uv !== undefined) {
      uv.set(g.attributes.uv.array as Float32Array, vo * 2);
    }
    if (g.index !== null) {
      const src = g.index.array;
      for (let i = 0; i < src.length; i++) {
        idx[io + i] = (src[i] as number) + vo;
      }
      io += src.length;
    } else {
      for (let i = 0; i < n; i++) {
        idx[io + i] = vo + i;
      }
      io += n;
    }
    vo += n;
    g.dispose();
  }
  const merged = new BufferGeometry();
  merged.setAttribute("position", new BufferAttribute(pos, 3));
  merged.setAttribute("normal", new BufferAttribute(nor, 3));
  merged.setAttribute("uv", new BufferAttribute(uv, 2));
  merged.setIndex(new BufferAttribute(idx, 1));
  return merged;
}

/* Build-time matrix scratch (the build runs on map/resize; never per-frame). */
const _p = new Vector3();
const _q = new Quaternion();
const _e = new Euler();
const _s = new Vector3();
const _m = new Matrix4();
const _m2 = new Matrix4();
const _a = new Vector3();
const _b = new Vector3();
const _col = new Color();
const Y_UP = new Vector3(0, 1, 0);

/** Bake a TRS transform into a part geometry and return it. */
function part(
  g: BufferGeometry,
  px: number,
  py: number,
  pz: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = 1,
  sz = 1,
): BufferGeometry {
  _m.compose(
    _p.set(px, py, pz),
    _q.setFromEuler(_e.set(rx, ry, rz)),
    _s.set(sx, sy, sz),
  );
  g.applyMatrix4(_m);
  return g;
}

type V3 = readonly [number, number, number];

/** Capsule limb spanning joint a -> joint b (caps sink into the joints). */
function limb(
  radius: number,
  a: V3,
  b: V3,
  radial = 6,
  sx = 1,
  sz = 1,
): BufferGeometry {
  _a.set(a[0], a[1], a[2]);
  _b.set(b[0], b[1], b[2]);
  const len = _a.distanceTo(_b);
  const g = new CapsuleGeometry(radius, Math.max(0.02, len - radius * 0.8), 2, radial);
  _p.addVectors(_a, _b).multiplyScalar(0.5);
  _b.sub(_a).normalize();
  _q.setFromUnitVectors(Y_UP, _b);
  _m.compose(_p, _q, _s.set(sx, 1, sz));
  g.applyMatrix4(_m);
  return g;
}

/* ------------------------------------------------------------------------ */
/* Audience — 4 modeled seated pose variants, each ONE merged geometry.      */
/* Local frame: origin at the seat surface, the body faces +z (yawed toward  */
/* the deck per instance). Feet drop 0.42 m to the step below.               */
/* ------------------------------------------------------------------------ */

interface SeatedPose {
  pelvis: V3;
  neckBase: V3;
  head: V3;
  headRx: number;
  headRz: number;
  shoulders: [V3, V3];
  elbows: [V3, V3];
  wrists: [V3, V3];
  hands: [V3, V3];
  hips: [V3, V3];
  knees: [V3, V3];
  ankles: [V3, V3];
  feet: [V3, V3];
  feetRx: [number, number];
  /** Phone held at the hand (variant "phone-raised" only). */
  phone: { pos: V3; rx: number } | null;
}

const LEGS_STD: Pick<SeatedPose, "hips" | "knees" | "ankles" | "feet" | "feetRx"> = {
  hips: [
    [-0.1, 0.07, 0.04],
    [0.1, 0.07, 0.04],
  ],
  knees: [
    [-0.115, 0.1, 0.43],
    [0.115, 0.1, 0.43],
  ],
  ankles: [
    [-0.125, -0.33, 0.47],
    [0.125, -0.33, 0.47],
  ],
  feet: [
    [-0.125, -0.375, 0.55],
    [0.125, -0.375, 0.55],
  ],
  feetRx: [0, 0],
};

/** 0 upright-attentive · 1 lean-forward · 2 legs-crossed · 3 phone-raised. */
const POSES: SeatedPose[] = [
  {
    // Upright, attentive, hands resting on the thighs.
    pelvis: [0, 0.1, 0.01],
    neckBase: [0, 0.6, -0.02],
    head: [0, 0.745, -0.02],
    headRx: -0.02,
    headRz: 0,
    shoulders: [
      [-0.175, 0.555, -0.015],
      [0.175, 0.555, -0.015],
    ],
    elbows: [
      [-0.205, 0.33, 0.06],
      [0.205, 0.33, 0.06],
    ],
    wrists: [
      [-0.15, 0.21, 0.275],
      [0.15, 0.21, 0.275],
    ],
    hands: [
      [-0.14, 0.19, 0.315],
      [0.14, 0.19, 0.315],
    ],
    ...LEGS_STD,
    phone: null,
  },
  {
    // Leaning forward, elbows on knees, hands meeting at the center.
    pelvis: [0, 0.1, -0.01],
    neckBase: [0, 0.5, 0.21],
    head: [0, 0.615, 0.27],
    headRx: -0.28,
    headRz: 0,
    shoulders: [
      [-0.17, 0.485, 0.19],
      [0.17, 0.485, 0.19],
    ],
    elbows: [
      [-0.135, 0.16, 0.43],
      [0.135, 0.16, 0.43],
    ],
    wrists: [
      [-0.05, 0.2, 0.52],
      [0.05, 0.2, 0.52],
    ],
    hands: [
      [-0.025, 0.205, 0.545],
      [0.025, 0.205, 0.545],
    ],
    ...LEGS_STD,
    hips: [
      [-0.11, 0.07, 0.04],
      [0.11, 0.07, 0.04],
    ],
    knees: [
      [-0.135, 0.1, 0.43],
      [0.135, 0.1, 0.43],
    ],
    phone: null,
  },
  {
    // Legs crossed (right over left), leaning back, hand to chin.
    pelvis: [0, 0.105, 0.03],
    neckBase: [0, 0.615, -0.085],
    head: [0, 0.755, -0.095],
    headRx: 0,
    headRz: 0.06,
    shoulders: [
      [-0.175, 0.565, -0.075],
      [0.175, 0.565, -0.075],
    ],
    elbows: [
      [-0.21, 0.33, 0.02],
      [0.21, 0.33, 0.05],
    ],
    wrists: [
      [-0.1, 0.5, 0.02],
      [0.12, 0.25, 0.27],
    ],
    hands: [
      [-0.055, 0.6, -0.01],
      [0.09, 0.235, 0.31],
    ],
    hips: [
      [-0.1, 0.07, 0.04],
      [0.1, 0.08, 0.04],
    ],
    knees: [
      [-0.115, 0.11, 0.43],
      [-0.03, 0.225, 0.4],
    ],
    ankles: [
      [-0.125, -0.33, 0.47],
      [-0.075, -0.1, 0.565],
    ],
    feet: [
      [-0.125, -0.375, 0.55],
      [-0.085, -0.155, 0.625],
    ],
    feetRx: [0, 0.55],
    phone: null,
  },
  {
    // Phone raised, filming the walk; head tipped up to the screen.
    pelvis: [0, 0.1, 0.005],
    neckBase: [0, 0.605, -0.03],
    head: [0, 0.745, -0.025],
    headRx: -0.18,
    headRz: 0,
    shoulders: [
      [-0.175, 0.555, -0.02],
      [0.175, 0.555, -0.02],
    ],
    elbows: [
      [-0.205, 0.33, 0.06],
      [0.225, 0.34, 0.13],
    ],
    wrists: [
      [-0.15, 0.21, 0.275],
      [0.155, 0.62, 0.26],
    ],
    hands: [
      [-0.14, 0.19, 0.315],
      [0.135, 0.675, 0.285],
    ],
    ...LEGS_STD,
    phone: { pos: [0.125, 0.73, 0.3], rx: -0.22 },
  },
];

interface VariantBuild {
  /** Skin parts (head, neck, hands) — instanced with a per-seat SKIN tone. */
  skinGeom: BufferGeometry;
  /** Outfit parts (torso, sleeves, legs, feet) — instanced with a per-seat OUTFIT tone. */
  clothGeom: BufferGeometry;
  /** This pose's head transform (figure-local) — where the separate hair mesh sits. */
  headLocal: Matrix4;
  /** Seat-local transform for the emissive phone screen (variant 3 only). */
  phoneLocal: Matrix4 | null;
}

/**
 * Assemble one seated body (~850 tris): head + neck, shaped torso (chest >
 * waist) with shoulder + pelvis caps, bent arms with hands, seated legs with
 * feet — all parts matrix-baked and merged into a single BufferGeometry.
 */
function buildSeatedVariant(pose: SeatedPose): VariantBuild {
  // Two part lists so the figure isn't one flat colour: SKIN (head/neck/hands,
  // tinted a per-seat skin tone) vs CLOTH (torso/sleeves/legs/feet + a dark hair
  // cap, tinted a per-seat outfit tone). Each list merges to one geometry → one
  // InstancedMesh, so the crowd is still a few draw calls.
  const skin: BufferGeometry[] = [];
  const cloth: BufferGeometry[] = [];

  // Torso: chest-to-waist tapered cylinder along pelvis -> neck base,
  // elliptical cross-section (wide x, shallow z).
  _a.set(pose.pelvis[0], pose.pelvis[1], pose.pelvis[2]);
  _b.set(pose.neckBase[0], pose.neckBase[1], pose.neckBase[2]);
  const torsoLen = _a.distanceTo(_b);
  const torso = new CylinderGeometry(0.15, 0.118, torsoLen, 9, 2);
  _p.addVectors(_a, _b).multiplyScalar(0.5);
  _b.sub(_a).normalize();
  _q.setFromUnitVectors(Y_UP, _b);
  _m.compose(_p, _q, _s.set(1.18, 1, 0.72));
  torso.applyMatrix4(_m);
  cloth.push(torso);

  // Shoulder + pelvis caps (flattened ellipsoids).
  cloth.push(
    part(
      new SphereGeometry(0.165, 8, 4),
      pose.neckBase[0], pose.neckBase[1] - 0.015, pose.neckBase[2],
      0, 0, 0, 1.0, 0.45, 0.62,
    ),
  );
  cloth.push(
    part(
      new SphereGeometry(0.125, 7, 4),
      pose.pelvis[0], pose.pelvis[1], pose.pelvis[2],
      0, 0, 0, 1.25, 0.7, 0.95,
    ),
  );

  // Neck + head (skin).
  skin.push(
    limb(0.04, pose.neckBase, [pose.head[0], pose.head[1] - 0.06, pose.head[2]], 6),
  );
  skin.push(
    part(
      new SphereGeometry(0.09, 8, 6),
      pose.head[0], pose.head[1], pose.head[2],
      pose.headRx, 0, pose.headRz, 0.88, 1.1, 0.95,
    ),
  );
  // Hair is now a SEPARATE per-seat mesh (its own colour + style + bald), placed at
  // this head transform — so capture the head's local placement for the instancer.
  const headLocal = new Matrix4().compose(
    _p.set(pose.head[0], pose.head[1], pose.head[2]),
    _q.setFromEuler(_e.set(pose.headRx, 0, pose.headRz)),
    _s.set(1, 1, 1),
  );

  for (let s = 0; s < 2; s++) {
    // Arms (sleeves = cloth); hand at the end (skin).
    cloth.push(limb(0.043, pose.shoulders[s], pose.elbows[s], 6));
    cloth.push(limb(0.036, pose.elbows[s], pose.wrists[s], 6));
    skin.push(
      part(
        new SphereGeometry(0.042, 5, 4),
        pose.hands[s][0], pose.hands[s][1], pose.hands[s][2],
        0, 0, 0, 0.85, 1.15, 1.3,
      ),
    );
    // Legs: hip -> knee -> ankle, foot box (cloth).
    cloth.push(limb(0.066, pose.hips[s], pose.knees[s], 7));
    cloth.push(limb(0.05, pose.knees[s], pose.ankles[s], 6));
    cloth.push(
      part(
        new BoxGeometry(0.08, 0.05, 0.2),
        pose.feet[s][0], pose.feet[s][1], pose.feet[s][2],
        pose.feetRx[s], 0, 0,
      ),
    );
  }

  let phoneLocal: Matrix4 | null = null;
  if (pose.phone !== null) {
    phoneLocal = new Matrix4().compose(
      _p.set(pose.phone.pos[0], pose.phone.pos[1], pose.phone.pos[2]),
      _q.setFromEuler(_e.set(pose.phone.rx, Math.PI, 0)),
      _s.set(1, 1, 1),
    );
  }
  return {
    skinGeom: mergeParts(skin),
    clothGeom: mergeParts(cloth),
    headLocal,
    phoneLocal,
  };
}

/** Dark fashion-crowd outfit palette (instanceColor; base material is white). */
const OUTFITS = [
  0x0b0d12, 0x121119, 0x191c24, 0x0e1016, 0x232730, 0x101820, 0x1a2a3a,
] as const;

/** Statement-piece accents (the 2026-07-15 art direction: real front rows read
 *  dark-neutral with a MINORITY of saturated statement pieces — Paris opulent
 *  vs Milan monochrome; docs/CROWD-OPTIONS.md). Worn on the TOP only, by
 *  ~ACCENT_RATE of seats: oxblood, cobalt, emerald, mustard, ivory, violet. */
const ACCENT_OUTFITS = [
  0x7d1f2e, 0x1f3f8f, 0x1d6b48, 0xb08a2e, 0xd8d2c6, 0x5a2a6e,
] as const;
const ACCENT_RATE = 0.16;

/** Diverse skin tones (instanceColor on the white skin material) — light → deep,
 *  so heads + hands read as people rather than monochrome silhouettes. */
const SKIN_TONES = [
  0xf3d3b8, 0xeab48d, 0xdd9b6c, 0xc68642, 0xa9714a, 0x8d5a34, 0x6f4327, 0xf7ddc4,
] as const;

/** Natural hair colours (instanceColor on the white hair material): black → near-
 *  black → dark/medium/light brown → dark blonde → grey. */
const HAIR_TONES = [
  0x09070a, 0x141019, 0x2b1d12, 0x402a18, 0x5e4326, 0x8a5a2b, 0xb0894e, 0x9a9590,
] as const;

/** Hair STYLES — small geometries centred on the head ORIGIN (the head transform is
 *  applied per seat), so each caps/falls around the head wherever the pose puts it.
 *  Index 0 short, 1 medium, 2 long (reads feminine), 3 bun (reads feminine),
 *  4 crop (a full rounded head of hair — the fullest, reads for either sex). The
 *  face (+z front) is left clear. Built once.
 *
 *  The caps were re-tuned (2026-07-05): the old "short" was a small, flat cap
 *  perched high on the crown, so it read as a shaved/balding scalp on the ~46%
 *  of men who wore it — the crowd looked bald. Every cap now sits LOWER and
 *  FULLER (bigger radius, less flatten, pushed back off the face) so short hair
 *  reads as hair, and the new crop adds a distinctly fuller silhouette. */
function buildHairStyles(): BufferGeometry[] {
  const cap = (r: number, sy: number, yz: [number, number]): BufferGeometry =>
    part(new SphereGeometry(r, 8, 5), 0, yz[0], yz[1], 0, 0, 0, 1.05, sy, 1.08);
  // Fuller + lower than before (0.097/0.78/[0.02,-0.012]) so it caps the head
  // instead of perching on the crown.
  const short = mergeParts([cap(0.101, 0.88, [0.008, -0.022])]);
  const medium = mergeParts([cap(0.106, 0.92, [0.006, -0.028])]);
  const long = mergeParts([
    cap(0.106, 0.94, [0.006, -0.03]),
    // back-fall: a flattened slab hanging behind + below the head to the shoulders.
    part(new BoxGeometry(0.15, 0.26, 0.055), 0, -0.085, -0.052, 0.12, 0, 0, 1, 1, 1),
  ]);
  const bun = mergeParts([
    cap(0.103, 0.9, [0.006, -0.024]),
    part(new SphereGeometry(0.05, 7, 5), 0, 0.055, -0.082, 0, 0, 0, 1, 1, 1),
  ]);
  // Crop: the fullest cap — a nearly-round head of hair (thick short / afro /
  // curly silhouette) covering the crown and sides, face left clear.
  const crop = mergeParts([cap(0.11, 0.98, [0.002, -0.03])]);
  return [short, medium, long, bun, crop];
}

/** Per-instance colour by sub-mesh role — shared by the seated crowd and the
 *  photographer pit. Seeded off the slot index i (deterministic across rebuilds);
 *  `withAccents` gates the statement-piece minority (the seated crowd wears them,
 *  the working press stays dark). Role "fixed" keeps the GLB's own materials. */
function colorSeatByRole(
  im: InstancedMesh,
  role: string,
  c: number,
  i: number,
  withAccents: boolean,
): void {
  if (role === "skin") {
    _col
      .setHex(SKIN_TONES[Math.floor(rnd(i * 5.3 + 23) * SKIN_TONES.length)])
      .multiplyScalar(0.9 + rnd(i * 2.7 + 7) * 0.2);
    im.setColorAt(c, _col);
  } else if (role === "hair") {
    _col
      .setHex(HAIR_TONES[Math.floor(rnd(i * 4.9 + 13) * HAIR_TONES.length)])
      .multiplyScalar(0.85 + rnd(i * 3.3 + 29) * 0.3);
    im.setColorAt(c, _col);
  } else if (role === "top" || role === "cloth") {
    // A minority of seats wear a saturated statement top (the 2026-07-15 art
    // direction); everyone else stays in the dark-neutral palette.
    if (withAccents && rnd(i * 7.9 + 61) < ACCENT_RATE) {
      _col
        .setHex(
          ACCENT_OUTFITS[Math.floor(rnd(i * 8.3 + 67) * ACCENT_OUTFITS.length)],
        )
        .multiplyScalar(0.92 + rnd(i * 4.3 + 41) * 0.16);
    } else {
      _col
        .setHex(OUTFITS[Math.floor(rnd(i * 9.7 + 31) * OUTFITS.length)])
        .multiplyScalar(0.85 + rnd(i * 4.3 + 41) * 0.4);
    }
    im.setColorAt(c, _col);
  } else if (role === "bottom") {
    // Independent pick so tops and bottoms mix like real outfits.
    _col
      .setHex(OUTFITS[Math.floor(rnd(i * 6.1 + 53) * OUTFITS.length)])
      .multiplyScalar(0.8 + rnd(i * 3.7 + 17) * 0.35);
    im.setColorAt(c, _col);
  } else if (role === "shoes") {
    // Shoes stay deep near-black with a whisper of variance.
    _col.setHex(0x0b0d12).multiplyScalar(0.8 + rnd(i * 2.3 + 11) * 0.5);
    im.setColorAt(c, _col);
  }
}

/** Instance loaded audience models at the seat slots (the "Mixamo route"). Each
 *  model's sub-meshes get their own InstancedMesh (textures intact); seats round-
 *  robin across the available models for variety. Named `audience-model-*` so the
 *  crowd toggle + dispose handle them like the procedural figures. */
function instanceAudienceModels(
  models: AudienceModel[],
  slots: Array<{ x: number; y: number; z: number; yaw: number; sc: number }>,
  add: (obj: Object3D) => Entity,
  dum: Object3D,
  liveSeats?: AudienceLiveSeat[],
  withAccents = true,
): void {
  const n = models.length;
  const modelOf = slots.map((_, i) => i % n);
  const counts = new Array<number>(n).fill(0);
  for (const mi of modelOf) counts[mi]++;
  const groups = models.map((model, mi) =>
    model.map((sub, si) => {
      const im = new InstancedMesh(sub.geom, sub.mat, Math.max(1, counts[mi]));
      im.name = `audience-model-${mi}-${si}`;
      im.frustumCulled = false;
      return im;
    }),
  );
  const cursors = new Array<number>(n).fill(0);
  slots.forEach((sl, i) => {
    const mi = modelOf[i];
    dum.position.set(sl.x, sl.y, sl.z);
    dum.rotation.set(0, sl.yaw, 0);
    dum.scale.setScalar(sl.sc);
    dum.updateMatrix();
    const c = cursors[mi];
    // Per-seat colour variety by sub-mesh ROLE (the procedural figures'
    // exact pattern: white base materials x seeded instanceColor from the
    // same palettes) — without this, round-robined models read as clones.
    // Role "fixed" (no part_ prefix in the GLB) keeps its own materials.
    for (let si = 0; si < groups[mi].length; si++) {
      const im = groups[mi][si];
      im.setMatrixAt(c, dum.matrix);
      colorSeatByRole(im, models[mi][si].role, c, i, withAccents);
    }
    // Crowd-gaze capture: the seat's frozen base matrix + every sub-mesh
    // slot it owns, so CrowdGazeSystem can yaw the WHOLE figure later.
    if (liveSeats) {
      liveSeats.push({
        px: sl.x,
        pz: sl.z,
        baseYaw: sl.yaw,
        base: dum.matrix.clone(),
        entries: groups[mi].map((im) => ({ im, index: c, local: null })),
        curYaw: 0,
        curLean: 0,
      });
    }
    cursors[mi]++;
  });
  // Park any model NO slot used (fewer slots than models — the judges' 3
  // figures over 4 models): its Math.max(1, 0) placeholder instance would
  // otherwise render at the ORIGIN with the identity matrix and the WHITE
  // base material — a giant pale figure seated mid-runway (caught live,
  // 2026-07-22). The hair-mesh park pattern: far below the floor, near-zero
  // scale.
  dum.position.set(0, -50, 0);
  dum.rotation.set(0, 0, 0);
  dum.scale.setScalar(0.0001);
  dum.updateMatrix();
  for (let mi = 0; mi < n; mi++) {
    if (cursors[mi] === 0) {
      for (const im of groups[mi]) im.setMatrixAt(0, dum.matrix);
    }
  }
  for (const group of groups) {
    for (const im of group) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      add(im);
    }
  }
}

/**
 * THE JUDGES' TABLE (idea-starter #3): three seated judge figures at a low
 * table beside the pose mark, facing it — the theatrical delivery surface
 * for the scores the summary already computed (JudgesPaddlesSystem raises
 * one scored paddle per shipped metric above the table at the reveal).
 *
 * Root-local frame (x = lateral, z = len/2 - along); (jx, jz) is the TABLE
 * center the contour seats already cleared. Judges are 3 instanced figures
 * from the SAME loaded audience models (round-robin, dark press palette, no
 * statement accents — a jury reads uniform), seated on a riser BEHIND the
 * table, each yawed to face the pose mark. They register in the crowd-gaze
 * liveSeats, so the jury tracks the walker like everyone else. All meshes
 * are `audience-judges-*` — crowd-gated + disposed with the set.
 *
 * Exports globals.judgesPaddles (ROOT-LOCAL paddle anchors above the table,
 * stale-cleared by buildSet) for the paddle system; null when the judges
 * never built (crowd hidden / no models).
 */
function buildJudgesTable(
  world: World,
  models: AudienceModel[],
  jx: number,
  jz: number,
  poseLx: number,
  poseLz: number,
  add: (obj: Object3D) => Entity,
  dum: Object3D,
  liveSeats: AudienceLiveSeat[],
): void {
  // Judges sit BEHIND the table (further from the runway, +x beyond jx);
  // the table front faces the mark. The row runs along local z.
  const seatX = jx + 0.55;
  const riserH = 0.22;
  const seatZs = [jz - 0.72, jz, jz + 0.72];

  // Riser platform under table + chairs.
  const riser = new BoxGeometry(1.9, riserH, 2.6);
  riser.translate(jx + 0.25, riserH / 2, jz);
  const riserMesh = new Mesh(
    riser,
    new MeshStandardMaterial({ color: 0x0c0f14, roughness: 0.95, metalness: 0.05 }),
  );
  riserMesh.name = "audience-judges-riser";
  add(riserMesh);

  // The table: one dark slab body + a thin Carolina trim line along the top
  // front edge (the brand's one accent — a judges' desk, not a light show).
  const tableBody = new BoxGeometry(0.62, 0.78, 2.3);
  tableBody.translate(jx, riserH + 0.39, jz);
  const tableMesh = new Mesh(
    tableBody,
    new MeshStandardMaterial({ color: 0x10141b, roughness: 0.85, metalness: 0.08 }),
  );
  tableMesh.name = "audience-judges-table";
  add(tableMesh);
  const trim = new BoxGeometry(0.02, 0.02, 2.3);
  trim.translate(jx - 0.31, riserH + 0.78, jz);
  const trimMesh = new Mesh(
    trim,
    new MeshBasicMaterial({ color: BRAND.accent }),
  );
  trimMesh.name = "audience-judges-trim";
  add(trimMesh);

  // Three seated judges: the pit's mini-instancing pattern via the shared
  // slot instancer (fresh InstancedMeshes; names stay audience-model-* which
  // the crowd gating already covers). Slight inward yaw per judge: face the
  // pose mark (a +Z-facing model under rotation.y = a faces (sin a, cos a)).
  const judgeSlots = seatZs.map((z, i) => ({
    x: seatX,
    y: riserH,
    z,
    yaw: Math.atan2(poseLx - seatX, poseLz - z) + (i - 1) * 0.02,
    sc: 0.99 + i * 0.01,
  }));
  instanceAudienceModels(models, judgeSlots, add, dum, liveSeats, false);

  // Paddle anchors: above the table front, one per judge (ROOT-LOCAL — the
  // paddle system converts with the live spine placement, the front-row
  // export convention). Yaw faces the mark; the system billboards anyway.
  const g = world.globals as Record<string, unknown>;
  const prev = g.__judgesPaddlesRev;
  const rev = (typeof prev === "number" ? prev : 0) + 1;
  g.__judgesPaddlesRev = rev;
  g.judgesPaddles = {
    rev,
    anchors: seatZs.map((z) => ({
      x: jx - 0.15,
      y: riserH + 1.32,
      z,
      yaw: Math.atan2(poseLx - jx, poseLz - z),
    })),
  };
}

/**
 * The photographer pit (the 2026-07-15 art direction, verified against the
 * 500px fashion-week guide: "the riser, or 'the pit'" — dozens of
 * photographers crammed at the runway's END, shooting the walk head-on).
 * Two rows of STANDING press figures past the far end of the walk route,
 * facing the pose mark, cameras up: a front row on the floor and a back row
 * on a low riser block. Figures come from pit-0..3.glb (loadPitModels) with
 * the same role-based instanceColor variety as the crowd — but NO statement
 * accents (working press wears dark). Skipped entirely when no pit models
 * loaded. GPU: ~9 instanced figures + one merged camera-prop InstancedMesh
 * + one riser box — negligible next to the seated crowd.
 */
function buildPhotographerPit(
  models: AudienceModel[],
  path: SegmentedPath,
  add: (obj: Object3D) => Entity,
  dum: Object3D,
): void {
  const n = models.length;
  if (n === 0) return;
  // ROOT-LOCAL frame (THE 2026-07-22 double-placement fix): this builder's
  // meshes are parented under the PLACED stage root, but it used to compute
  // WORLD coordinates via routeToWorld — the placement applied twice. At the
  // default layout (yaw 0) that was a quiet 3.75 m push past the end (the
  // old "back row in a black hole" reports); on a ROTATED mapped runway the
  // double rotation flung the whole pit off the runway ("the camera people
  // disappeared"). Everything below is spine-local now: un-place the route
  // points with the spine transform, headings relative to the spine yaw.
  const spineRect = path.segments[0].rect;
  const csL = Math.cos(spineRect.yaw);
  const snL = Math.sin(spineRect.yaw);
  const toL = (wx: number, wz: number): [number, number] => [
    (wx - spineRect.centerX) * csL - (wz - spineRect.centerZ) * snL,
    (wx - spineRect.centerX) * snL + (wz - spineRect.centerZ) * csL,
  ];
  const endW = routeToWorld(path, path.totalAlong, 0);
  const poseW = routeToWorld(path, path.poseRouteAlong, 0);
  const [endLx2, endLz2] = toL(endW.x, endW.z);
  const [poseLx2, poseLz2] = toL(poseW.x, poseW.z);
  const end = { x: endLx2, z: endLz2, yaw: endW.yaw - spineRect.yaw };
  const pose = { x: poseLx2, z: poseLz2 };
  const fx = -Math.sin(end.yaw);
  const fz = -Math.cos(end.yaw);
  // Lateral (across-the-runway) unit direction — perpendicular to f.
  const lx = -fz;
  const lz = fx;
  const spineW = path.segments[0].rect.width;
  const spread = Math.max(0.55, spineW * 0.45);
  // Two rows: front on the floor, back raised on the pit riser.
  const PIT_ROWS = [
    { gap: 0.6, y: 0, lats: [-1.5, -0.5, 0.5, 1.5] },
    { gap: 1.25, y: 0.38, lats: [-2, -1, 0, 1, 2] },
  ];
  const figures: Array<{
    x: number;
    z: number;
    y: number;
    yaw: number;
    sc: number;
    mirror: boolean;
  }> = [];
  PIT_ROWS.forEach((row, ri) => {
    row.lats.forEach((u, ci) => {
      const i = ri * 16 + ci; // colour/scale seed, disjoint rows
      const lat = u * spread * 0.62 + (rnd(i * 5.1 + 3) - 0.5) * 0.1;
      const gap = row.gap + (rnd(i * 6.7 + 19) - 0.5) * 0.12;
      const x = end.x + fx * gap + lx * lat;
      const z = end.z + fz * gap + lz * lat;
      // Face the pose mark (a +Z-facing model under rotation.y = a looks
      // toward (sin a, cos a) -> a = atan2(dx, dz)).
      const yaw =
        Math.atan2(pose.x - x, pose.z - z) + (rnd(i * 3.9 + 7) - 0.5) * 0.1;
      figures.push({
        x,
        z,
        y: row.y,
        yaw,
        sc: 0.97 + rnd(i * 4.7 + 29) * 0.08,
        // The pack ships ONE covering-eyes pose per sex, so every figure
        // raises the same arm — a salute line. Mirror roughly half (checker
        // across each row) so camera arms alternate like a real crammed pit.
        mirror: (ri + ci) % 2 === 1,
      });
    });
  });

  // Instance the pit models round-robin across the figures (the crowd pattern).
  const modelOf = figures.map((_, i) => i % n);
  const counts = new Array<number>(n).fill(0);
  for (const mi of modelOf) counts[mi]++;
  const groups = models.map((model, mi) =>
    model.map((sub, si) => {
      // DoubleSide: mirrored instances (negative X scale) reverse the winding,
      // which FrontSide would cull inside-out. Pit-only materials, 9 figures.
      const mat = (Array.isArray(sub.mat) ? sub.mat[0] : sub.mat).clone();
      mat.side = DoubleSide;
      const im = new InstancedMesh(sub.geom, mat, Math.max(1, counts[mi]));
      im.name = `audience-pit-${mi}-${si}`;
      im.frustumCulled = false;
      return im;
    }),
  );
  const cursors = new Array<number>(n).fill(0);
  figures.forEach((f, i) => {
    const mi = modelOf[i];
    dum.position.set(f.x, f.y, f.z);
    dum.rotation.set(0, f.yaw, 0);
    dum.scale.set(f.mirror ? -f.sc : f.sc, f.sc, f.sc);
    dum.updateMatrix();
    const c = cursors[mi];
    for (let si = 0; si < groups[mi].length; si++) {
      const im = groups[mi][si];
      im.setMatrixAt(c, dum.matrix);
      colorSeatByRole(im, models[mi][si].role, c, i + 300, false); // press: no accents
    }
    cursors[mi]++;
  });
  for (const group of groups) {
    for (const im of group) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      add(im);
    }
  }

  // The pit riser under the back row: one low block spanning its lateral spread.
  const backRow = PIT_ROWS[1];
  const spanHalf = Math.abs(backRow.lats[0]) * spread * 0.62 + 0.45;
  const riser = new BoxGeometry(spanHalf * 2, backRow.y, 0.7);
  riser.translate(0, backRow.y / 2, 0);
  const rm = new Matrix4().makeRotationY(end.yaw);
  rm.setPosition(end.x + fx * backRow.gap, 0, end.z + fz * backRow.gap);
  riser.applyMatrix4(rm);
  const riserMesh = new Mesh(
    riser,
    new MeshStandardMaterial({ color: 0x0c0f14, roughness: 0.95, metalness: 0.05 }),
  );
  riserMesh.name = "audience-pit-riser";
  add(riserMesh);

  // The pit's own downlight: the hero spot + lamp spill never reach past the
  // runway end, so without this the press pack reads as silhouettes against
  // the void. One distance-limited spot from above the end edge, aimed into
  // the pack. The `audience-` name prefix keeps it crowd-gated (hidden in
  // immersive XR with the rest of the pit).
  const pitTarget = new Object3D();
  pitTarget.name = "audience-pit-spot-target";
  pitTarget.position.set(end.x + fx * 0.95, 0, end.z + fz * 0.95);
  // Positioned near-overhead of the pack (not in front of it) with a wider
  // cone, so the RISER row is inside the beam too — from the runway the back
  // row otherwise fades into the dark (founder demo report, 2026-07-16).
  // Length-scaled intensity (founder call 2026-07-22: the pit must READ from
  // the start line on a long mapped runway — at 20 m+ the pack is a distant
  // speck, so it earns a brighter pool; the 7 m default is unchanged ×1).
  const lenBoost = Math.min(
    2.2,
    Math.max(1, path.segments[0].rect.length / 9),
  );
  const pitSpot = new SpotLight(0xe9e4da, 15 * lenBoost, 9, 0.7, 0.45, 1.2);
  pitSpot.name = "audience-pit-spot";
  pitSpot.position.set(end.x + fx * 0.25, STAGE.trussY, end.z + fz * 0.25);
  pitSpot.castShadow = false;
  pitSpot.target = pitTarget;
  add(pitTarget);
  add(pitSpot);

  // Camera FLASHES from the pit lenses — the same blink shader as the crowd
  // cloud, one point per press figure at its lens tip. Own Points object so
  // the fragile crowd-anchor math stays untouched; the `audience-pit-` name
  // keeps it crowd-gated. The lens = the smallest-volume "fixed" sub-mesh of
  // each pit model (the camera body is the other, bigger one).
  const lensLocal = models.map((model) => {
    let best: { c: Vector3; vol: number } | null = null;
    for (const sub of model) {
      if (sub.role !== "fixed") continue;
      sub.geom.computeBoundingBox();
      const bb = sub.geom.boundingBox;
      if (!bb) continue;
      const size = bb.getSize(new Vector3());
      const vol = size.x * size.y * size.z;
      if (best === null || vol < best.vol) {
        best = { c: bb.getCenter(new Vector3()), vol };
      }
    }
    return best ? best.c : null;
  });
  const pitFlashPos: number[] = [];
  const pitFlashRand: number[] = [];
  const _fv = new Vector3();
  figures.forEach((f, i) => {
    const local = lensLocal[modelOf[i]];
    if (local === null) return;
    dum.position.set(f.x, f.y, f.z);
    dum.rotation.set(0, f.yaw, 0);
    dum.scale.set(f.mirror ? -f.sc : f.sc, f.sc, f.sc);
    dum.updateMatrix();
    _fv.copy(local);
    _fv.z += 0.08; // just past the lens front
    _fv.applyMatrix4(dum.matrix);
    pitFlashPos.push(_fv.x, _fv.y, _fv.z);
    pitFlashRand.push(rnd(i * 12.3 + 71));
  });
  if (pitFlashPos.length > 0) {
    const pfGeom = new BufferGeometry();
    pfGeom.setAttribute("position", new BufferAttribute(new Float32Array(pitFlashPos), 3));
    pfGeom.setAttribute("aRand", new BufferAttribute(new Float32Array(pitFlashRand), 1));
    const pitMat = createCameraFlashMaterial();
    // The pit's OWN material instance: resting camera-ready lens glints so
    // the press pack reads from the start line at any runway length
    // (ShaderTimeSystem only drives uTime/uEnergy/uBurst — this sticks).
    pitMat.uniforms.uIdleGlint.value = 1;
    const pitFlashes = new Points(pfGeom, pitMat);
    pitFlashes.name = "audience-pit-flashes";
    pitFlashes.frustumCulled = false;
    add(pitFlashes).addComponent(ShaderDriven);
  }
}

/* ------------------------------------------------------------------------ */
/* Canvas textures (procedural, zero external assets).                       */
/* ------------------------------------------------------------------------ */

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * The (X) pose mark — Carolina-Blue glow, white-hot core, flanking
 * parenthesis arcs. Sized to read from the far end of the deck.
 */
function makePoseMarkTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, 256, 256);
    ctx.lineCap = "round";
    const accent = BRAND_CSS.accent;
    const soft = BRAND_CSS.accentSoft;
    const white = BRAND_CSS.white;

    // Parenthesis arcs — the "( )" of the wordmark.
    ctx.shadowColor = accent;
    ctx.shadowBlur = 14;
    ctx.strokeStyle = soft;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(128, 128, 104, Math.PI * 0.65, Math.PI * 1.35);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(128, 128, 104, -Math.PI * 0.35, Math.PI * 0.35);
    ctx.stroke();

    // The X: accent glow body, then a white-hot core.
    const strokes: Array<[number, number, number, number]> = [
      [80, 80, 176, 176],
      [176, 80, 80, 176],
    ];
    ctx.shadowBlur = 22;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 22;
    for (const [x1, y1, x2, y2] of strokes) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.shadowBlur = 10;
    ctx.strokeStyle = soft;
    ctx.lineWidth = 12;
    for (const [x1, y1, x2, y2] of strokes) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.strokeStyle = white;
    ctx.lineWidth = 4.5;
    for (const [x1, y1, x2, y2] of strokes) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Radial dark fade that seats the flat deck on the real floor in AR. */
function makeShadowTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const grad = ctx.createRadialGradient(64, 64, 6, 64, 64, 64);
    grad.addColorStop(0, "rgba(3, 4, 6, 0.8)");
    grad.addColorStop(0.62, "rgba(3, 4, 6, 0.5)");
    grad.addColorStop(1, "rgba(3, 4, 6, 0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
  }
  return new CanvasTexture(canvas);
}

/* ------------------------------------------------------------------------ */
/* Layout-driven SET BUILD. Everything below the root, in LOCAL space.       */
/* Returns the list of created child entities so a relayout can dispose them. */
/* ------------------------------------------------------------------------ */

/**
 * ONE solid deck body for the whole shape — a single mesh extruded straight down
 * from the rounded `outline` polygon. Replaces the per-segment BoxGeometry decks
 * that overlapped at junctions and read as "stacked rectangles": the U is one
 * horseshoe slab, the X one cross slab. Top face at y = STAGE.deckHeight (just
 * under the live floor); side walls drop to the ground (y = 0).
 *
 * The outline is root-local [x, z]. THREE.Shape lives in its own XY plane and
 * ExtrudeGeometry pushes along +Z; we author shapeY = -z and then rotateX(-90°),
 * which maps (x, -z, depth) -> world (x, depth, z) — top cap up at y = depth, no
 * Z-mirror. We normalize the loop to CW in (x,z) (== CCW in the shape's (x,-z)
 * plane) so ExtrudeGeometry winds the top cap up and the side walls OUTWARD for
 * the default front-side material — no DoubleSide overdraw, no inverted deck.
 */
/** Offset a closed [x,z] loop OUTWARD by `d` (each vertex along the averaged
 * outward normal of its two edges). Used for the contact-shadow halo so it peeks
 * just past the deck edge while still following the silhouette. */
function expandOutline(
  poly: Array<[number, number]>,
  d: number,
): Array<[number, number]> {
  let area2 = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    area2 += a[0] * b[1] - b[0] * a[1];
  }
  const lp = area2 < 0 ? poly.slice().reverse() : poly.slice(); // CCW
  const M = lp.length;
  return lp.map((p, i) => {
    const a = lp[(i - 1 + M) % M];
    const b = lp[(i + 1) % M];
    let nx = b[1] - a[1]; // outward normal of chord a->b for a CCW loop
    let nz = -(b[0] - a[0]);
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    return [p[0] + nx * d, p[1] + nz * d] as [number, number];
  });
}

function buildDeckBody(outline: Array<[number, number]>): Mesh {
  let area2 = 0; // 2x signed area in (x,z): >0 = CCW
  for (let i = 0, n = outline.length; i < n; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % n];
    area2 += a[0] * b[1] - b[0] * a[1];
  }
  const loop = area2 > 0 ? outline.slice().reverse() : outline; // force CW in (x,z)
  const shape = new Shape();
  shape.moveTo(loop[0][0], -loop[0][1]); // shapeY = -z
  for (let i = 1; i < loop.length; i++) shape.lineTo(loop[i][0], -loop[i][1]);
  shape.closePath();
  const geom = new ExtrudeGeometry(shape, {
    depth: STAGE.deckHeight,
    bevelEnabled: false,
    steps: 1,
  });
  geom.rotateX(-Math.PI / 2); // top cap -> y = STAGE.deckHeight, bottom -> y = 0
  geom.computeVertexNormals();
  const mesh = new Mesh(
    geom,
    new MeshStandardMaterial({ color: BRAND.bgDeep, roughness: 0.4, metalness: 0.6 }),
  );
  mesh.name = "deck-body";
  return mesh;
}

/**
 * Shape-aware audience: a seated gallery flanks BOTH sides of every walkable
 * segment, faced inward, with any seat that lands on a deck (junctions) culled —
 * which automatically fills a U's courtyard, an X's four quadrants and a T's
 * head, with no per-shape code. A finale front-row sits just past the pose mark,
 * facing back down the route. Reuses the seated-pose variants/materials/outfits
 * + tiered risers. Returns flat [x,y,z,...] flash anchors (a sample of seats)
 * so the camera-flash cloud clusters on the actual crowd.
 */
function buildShapeAudience(
  world: World,
  root: Entity,
  plan: FloorPlan,
  path: SegmentedPath,
  outline: Array<[number, number]>,
  created: Entity[],
  pitActive: boolean,
): number[] {
  const add = (obj: Object3D): Entity => {
    const e = world.createTransformEntity(obj, { parent: root });
    created.push(e);
    return e;
  };

  // Normalize the outline to CCW so the OUTWARD unit normal of an edge tangent
  // t=(tx,tz) is (tz,-tx). The audience is placed by walking THIS contour and
  // offsetting each sample OUTWARD — which (a) hugs the unique silhouette, (b)
  // fills a U's courtyard automatically (the courtyard edge's outward normal
  // points INTO the courtyard), and (c) can never land on the deck because every
  // seat is strictly outside the boundary. No per-segment galleries, no AABB cull.
  let area2 = 0;
  for (let i = 0, n = outline.length; i < n; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % n];
    area2 += a[0] * b[1] - b[0] * a[1];
  }
  const loop = area2 < 0 ? outline.slice().reverse() : outline.slice();
  const N = loop.length;

  // Walk start (entrance) + pose mark, in root-local space — used to keep the
  // audience off the entrance mouth and to thicken the crowd at the finale.
  const r0 = path.segments[0].rect;
  const cs = Math.cos(r0.yaw);
  const sn = Math.sin(r0.yaw);
  const toLocal = (wx: number, wz: number): [number, number] => [
    (wx - r0.centerX) * cs - (wz - r0.centerZ) * sn,
    (wx - r0.centerX) * sn + (wz - r0.centerZ) * cs,
  ];
  const start = routeToWorld(path, 0, 0);
  const [startLx, startLz] = toLocal(start.x, start.z);
  const pose = routeToWorld(path, path.poseRouteAlong, 0);
  const [poseLx, poseLz] = toLocal(pose.x, pose.z);
  // THE JUDGES' TABLE (idea-starter #3): three seated judges at a table on
  // the trainee's RIGHT of the pose mark (root-local +x = +lateral), facing
  // it. Needs loaded audience models (the shipped GLB crowd); the contour
  // seats clear a disc around the table (the pit exclusion pattern).
  const judgesModels = (world.globals as Record<string, unknown>)
    .audienceModels as AudienceModel[] | undefined;
  const judgesActive = judgesModels !== undefined && judgesModels.length > 0;
  const spineHalfW = path.segments[0].rect.width / 2;
  const judgesLx = poseLx + spineHalfW + 1.45;
  const judgesLz = poseLz;
  const judgesR2 = judgesActive ? 1.7 ** 2 : 0;
  // Photographer-pit clearance: when the pit builds (pit models loaded), clear
  // the end-cap seats so the standing press owns the head-on position — the
  // deeper tiers behind it survive and read as crowd-behind-the-pit.
  const routeEnd = routeToWorld(path, path.totalAlong, 0);
  const [endLx, endLz] = toLocal(routeEnd.x, routeEnd.z);
  const pitR2 = pitActive
    ? Math.max(1.7, path.segments[0].rect.width * 0.9) ** 2
    : 0;

  // Resample the contour by arc length into evenly spaced columns.
  let L = 0;
  const edgeLen: number[] = [];
  for (let i = 0; i < N; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % N];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    edgeLen.push(d);
    L += d;
  }
  // CAP the column count (audienceColumnCount). Each column places up to 3 tiers + a
  // finale seat, so the crowd (instanced figures + merged risers + flash cloud) scales
  // with the contour PERIMETER. A user maxing the sliders (an 80m U, ~422 m perimeter)
  // would otherwise build ~900 columns / ~2700 seats — a build-time hitch + a heavy
  // instance/vertex load if the crowd is toggled on. The cap sits just above the largest
  // shipped preset (~267) so every preset stays full; beyond that, seats space further.
  const Ncol = audienceColumnCount(L);
  const P: Array<[number, number]> = [];
  const nRaw: Array<[number, number]> = [];
  let ei = 0;
  let acc = 0; // arc length at the start of edge ei
  for (let c = 0; c < Ncol; c++) {
    const s = (c / Ncol) * L;
    while (ei < N - 1 && s > acc + edgeLen[ei]) {
      acc += edgeLen[ei];
      ei++;
    }
    const a = loop[ei];
    const b = loop[(ei + 1) % N];
    const u = edgeLen[ei] > 1e-6 ? (s - acc) / edgeLen[ei] : 0;
    P.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
    let tx = b[0] - a[0];
    let tz = b[1] - a[1];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    nRaw.push([tz, -tx]); // outward normal for a CCW loop
  }
  // Smooth the normals so the offset rows curve cleanly through corners instead
  // of kinking (and converge gently in concave pockets).
  const nOut = nRaw.map((nv, c) => {
    const p = nRaw[(c - 1 + Ncol) % Ncol];
    const q = nRaw[(c + 1) % Ncol];
    let nx = nv[0] + 0.5 * p[0] + 0.5 * q[0];
    let nz = nv[1] + 0.5 * p[1] + 0.5 * q[1];
    const l = Math.hypot(nx, nz) || 1;
    return [nx / l, nz / l] as [number, number];
  });

  // Min-distance spatial hash: rejects any seat within SEP of an existing one,
  // so opposing rows in a tight U courtyard / X quadrant can't interpenetrate
  // (they fill with as many seats as actually fit, facing in, no jam).
  const SEP = 0.42;
  const cells = new Map<string, Array<[number, number]>>();
  const free = (x: number, z: number): boolean => {
    const ci = Math.floor(x / SEP);
    const cj = Math.floor(z / SEP);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const arr = cells.get(`${ci + di},${cj + dj}`);
        if (arr) {
          for (const [px, pz] of arr) {
            if ((px - x) ** 2 + (pz - z) ** 2 < SEP * SEP) return false;
          }
        }
      }
    }
    const key = `${ci},${cj}`;
    let arr = cells.get(key);
    if (!arr) {
      arr = [];
      cells.set(key, arr);
    }
    arr.push([x, z]);
    return true;
  };

  interface Slot {
    x: number;
    y: number;
    z: number;
    yaw: number;
    sc: number;
  }
  const slots: Slot[] = [];
  /** Finale front-row seats (spine-local) — exported for Replay Theater. */
  const frontRow: Array<{ x: number; y: number; z: number; yaw: number }> = [];
  const riserParts: BufferGeometry[] = [];
  const dum = new Object3D();
  let idx = 0;

  // Tiered rows: each offset further OUTWARD along the contour normal + higher,
  // so the crowd rakes up like real stadium seating.
  const ROWS = [
    { gap: 0.55, h: 0.42 },
    { gap: 1.17, h: 0.84 },
    { gap: 1.79, h: 1.26 },
  ];

  // Place one inward-faced seat + its pedestal riser at contour point (px,pz)
  // with outward normal (nx,nz), offset out by `gap`, seat surface at height `h`.
  const placeSeat = (
    px: number,
    pz: number,
    nx: number,
    nz: number,
    gap: number,
    h: number,
  ): void => {
    const j = rnd(idx * 7.3 + 1);
    const k = rnd(idx * 3.1 + 9);
    idx++;
    const x = px + nx * gap + (j - 0.5) * 0.08;
    const z = pz + nz * gap + (k - 0.5) * 0.08;
    if (pointInPolygon(x, z, outline)) return; // defensive: never on the deck
    if (!free(x, z)) return; // no interpenetration
    // Seated body faces +z by default; face inward = -nOut -> atan2(-nx,-nz).
    const yaw = Math.atan2(-nx, -nz) + (j - 0.5) * 0.34;
    slots.push({ x, y: h, z, yaw, sc: 0.94 + k * 0.1 });
    // Per-seat pedestal block (merged into one mesh). Width ~ seat spacing so
    // neighbours touch into a continuous curved bench that follows the contour
    // and steps up by tier — no long straight bars, no fold at reflex corners.
    const ped = new BoxGeometry(0.5, h, 0.5);
    ped.translate(0, h / 2, 0);
    const m = new Matrix4().makeRotationY(yaw);
    m.setPosition(x, 0, z);
    ped.applyMatrix4(m);
    riserParts.push(ped);
  };

  // Column nearest the pose mark — the finale thickens the ring around it.
  let poseCol = 0;
  let poseBest = Infinity;
  for (let c = 0; c < Ncol; c++) {
    const d = (P[c][0] - poseLx) ** 2 + (P[c][1] - poseLz) ** 2;
    if (d < poseBest) {
      poseBest = d;
      poseCol = c;
    }
  }

  // Scale the entrance mouth + the finale band by the WALKABLE strip width (the
  // spine), NOT plan.width (the whole-shape bbox X-span). A wide-arm T/X has a huge
  // bbox width — using it would carve a tens-of-metres exclusion disc around the
  // entrance (deleting most of the gallery) and mark the whole contour as "finale"
  // (collapsing the tiers to one front row). For a straight runway spineW ==
  // plan.width, so this is unchanged.
  const spineW = path.segments[0].rect.width;
  const entranceR2 = (spineW * 0.85) ** 2; // no audience at the walk-on mouth
  const finaleSpan = Math.max(2, Math.round((spineW * 1.1) / SEAT_STEP));
  for (let c = 0; c < Ncol; c++) {
    const px = P[c][0];
    const pz = P[c][1];
    if ((px - startLx) ** 2 + (pz - startLz) ** 2 < entranceR2) continue;
    if (pitR2 > 0 && (px - endLx) ** 2 + (pz - endLz) ** 2 < pitR2) continue;
    if (
      judgesR2 > 0 &&
      (px - judgesLx) ** 2 + (pz - judgesLz) ** 2 < judgesR2
    ) {
      continue; // the judges' table owns this stretch of the front row
    }
    const nx = nOut[c][0];
    const nz = nOut[c][1];
    // March OUTWARD to find a FACING deck edge across the gap (the far leg of a
    // U courtyard / the opposite arm of an X). If one is within reach, only seat
    // tiers that stay on THIS side of the gap's midline — otherwise opposing rows
    // from the two edges cross the centerline and end up back-to-back, facing
    // AWAY from the runway (the U-courtyard bug). Open edges (no facing deck) keep
    // all tiers, so a straight runway is unchanged.
    let gapDepth = Infinity;
    for (let d = 0.4; d <= 3.8; d += 0.2) {
      if (pointInPolygon(px + nx * d, pz + nz * d, outline)) {
        gapDepth = d;
        break;
      }
    }
    const maxGap = gapDepth === Infinity ? Infinity : gapDepth * 0.5 - 0.3;
    for (const row of ROWS) {
      if (row.gap <= maxGap) placeSeat(px, pz, nx, nz, row.gap, row.h);
    }
    // Finale: thicken the ring head-on to the pose mark with a low front row.
    const dd = Math.abs(c - poseCol);
    const circ = Math.min(dd, Ncol - dd);
    if (circ <= finaleSpan && 0.34 <= maxGap) {
      const before = slots.length;
      placeSeat(px, pz, nx, nz, 0.34, 0.24);
      // Export the finale front row for Replay Theater's viewpoint (SPINE-
      // LOCAL frame — the stage root carries the spine center + yaw). Only
      // seats that actually placed (the dedup/deck guards can reject).
      if (slots.length > before) {
        const s = slots[slots.length - 1];
        frontRow.push({ x: s.x, y: s.y, z: s.z, yaw: s.yaw });
      }
    }
  }
  (world.globals as Record<string, unknown>).audienceFrontRowLocal =
    frontRow.length > 0 ? frontRow : null;

  if (riserParts.length > 0) {
    const risers = new Mesh(
      mergeParts(riserParts),
      new MeshStandardMaterial({ color: 0x0c0f14, roughness: 0.95, metalness: 0.05 }),
    );
    risers.name = "audience-risers";
    add(risers);
  }

  // Custom audience models (the "Mixamo route") take over if any GLBs loaded —
  // instanced with their own textures, at the SAME seat slots. Otherwise fall
  // through to the procedural skin/cloth figures below.
  const audModels = (world.globals as Record<string, unknown>).audienceModels as
    | AudienceModel[]
    | undefined;
  // Crowd-gaze live export (CROWD GAZE build): every SEATED figure registers
  // its base matrix + instanced-mesh slots so CrowdGazeSystem can turn the
  // whole figure toward the walker. The pit press is EXCLUDED by design (it
  // already faces the pose mark and never registers here).
  const liveSeats: AudienceLiveSeat[] = [];
  const publishLive = (): void => {
    const g = world.globals as Record<string, unknown>;
    // buildSet nulls audienceLive up-front and stashes the last rev — read
    // the stash so the counter stays monotonic across rebuilds.
    const stash = g.__audienceLiveRev;
    const rev = (typeof stash === "number" ? stash : 0) + 1;
    g.__audienceLiveRev = rev;
    g.audienceLive = { rev, seats: liveSeats } satisfies AudienceLive;
  };
  if (audModels !== undefined && audModels.length > 0) {
    instanceAudienceModels(audModels, slots, add, dum, liveSeats);
    if (judgesActive) {
      buildJudgesTable(
        world,
        audModels,
        judgesLx,
        judgesLz,
        poseLx,
        poseLz,
        add,
        dum,
        liveSeats,
      );
    }
    publishLive();
    const anchors: number[] = [];
    const stride = Math.max(1, Math.floor(slots.length / 90));
    for (let i = 0; i < slots.length; i += stride) {
      anchors.push(slots[i].x, slots[i].y + 0.62, slots[i].z);
    }
    return anchors;
  }

  // Instance the seats. Each seat = a pose (SKIN + CLOTH meshes) + a separate HAIR
  // mesh (its own colour, 1 of 4 styles, or bald) + a SEX cue (size + hair). So the
  // crowd reads as varied men & women with different hair, not clones.
  const builds = POSES.map(buildSeatedVariant);
  const hairGeoms = buildHairStyles();
  const skinMat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.0 });
  const hairMat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0.0 });
  const clothMats = [
    new MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0.05 }),
    new MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.04 }),
    new MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.78,
      metalness: 0.05,
      clearcoat: 0.35,
      clearcoatRoughness: 0.55,
    }),
    new MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0.05 }),
  ];
  const mkIM = (
    geom: BufferGeometry,
    mat: MeshStandardMaterial | MeshPhysicalMaterial,
    count: number,
    name: string,
  ): InstancedMesh => {
    const im = new InstancedMesh(geom, mat, Math.max(1, count));
    im.name = name;
    im.frustumCulled = false;
    return im;
  };

  // Per-seat attributes (deterministic): pose, sex, hair style (-1 = bald).
  // Hair styles: 0 short, 1 medium, 2 long, 3 bun, 4 crop (fullest). Women
  // lean long/bun/medium; men lean short/medium/crop. Baldness is now RARE
  // (~6% of men, ~3% of the whole crowd) — the old 16% male-bald plus a
  // scalp-like short cap made the room look bald; short is fuller now and
  // most men wear real hair.
  const poseOf = new Int8Array(slots.length);
  const femaleOf = new Uint8Array(slots.length);
  const hairOf = new Int8Array(slots.length);
  const counts = [0, 0, 0, 0];
  const hairCounts = new Array<number>(hairGeoms.length).fill(0);
  for (let i = 0; i < slots.length; i++) {
    const rp = rnd(i * 13.7 + 17);
    const p = rp < 0.32 ? 0 : rp < 0.58 ? 1 : rp < 0.78 ? 2 : 3;
    poseOf[i] = p;
    counts[p]++;
    femaleOf[i] = rnd(i * 8.1 + 3) < 0.5 ? 1 : 0;
    // NO HAIR (2026-07-05 founder call): the procedural hair read bald/elderly
    // no matter how it was tuned, so the crowd is now HAIRLESS. Every seat is
    // -1, so every hair mesh has count 0 and the loop below parks it far under
    // the floor (nothing renders). buildHairStyles stays but produces nothing.
    hairOf[i] = -1;
  }

  const skinMeshes = builds.map((b, v) => mkIM(b.skinGeom, skinMat, counts[v], `audience-skin-v${v}`));
  const clothMeshes = builds.map((b, v) => mkIM(b.clothGeom, clothMats[v], counts[v], `audience-cloth-v${v}`));
  const hairMeshes = hairGeoms.map((g, s) => mkIM(g, hairMat, hairCounts[s], `audience-hair-s${s}`));
  const phones = new InstancedMesh(
    new PlaneGeometry(0.046, 0.092),
    new MeshBasicMaterial({ color: 0xcfe6ff, side: DoubleSide }),
    Math.max(1, counts[3]),
  );
  phones.name = "audience-phones";
  phones.frustumCulled = false;

  const cursors = [0, 0, 0, 0];
  const hairCursors = new Array<number>(hairGeoms.length).fill(0);
  let phoneIdx = 0;
  slots.forEach((sl, i) => {
    const v = poseOf[i];
    // Women a touch smaller — a gentle sex cue on top of hair length.
    const sexScale = femaleOf[i] ? 0.93 : 1.02;
    dum.position.set(sl.x, sl.y, sl.z);
    dum.rotation.set(0, sl.yaw, (rnd(i * 3.1 + 5) - 0.5) * 0.05);
    dum.scale.setScalar(sl.sc * sexScale);
    dum.updateMatrix();
    const c = cursors[v];
    skinMeshes[v].setMatrixAt(c, dum.matrix);
    clothMeshes[v].setMatrixAt(c, dum.matrix);
    _col
      .setHex(OUTFITS[Math.floor(rnd(i * 9.7 + 31) * OUTFITS.length)])
      .multiplyScalar(0.85 + rnd(i * 4.3 + 41) * 0.4);
    clothMeshes[v].setColorAt(c, _col);
    _col
      .setHex(SKIN_TONES[Math.floor(rnd(i * 5.3 + 23) * SKIN_TONES.length)])
      .multiplyScalar(0.9 + rnd(i * 2.7 + 7) * 0.2);
    skinMeshes[v].setColorAt(c, _col);
    cursors[v]++;
    // Hair: place at the head (seat matrix × pose head-local), tint a hair tone.
    const h = hairOf[i];
    if (h >= 0) {
      const hc = hairCursors[h];
      _m2.multiplyMatrices(dum.matrix, builds[v].headLocal);
      hairMeshes[h].setMatrixAt(hc, _m2);
      _col
        .setHex(HAIR_TONES[Math.floor(rnd(i * 4.9 + 13) * HAIR_TONES.length)])
        .multiplyScalar(0.85 + rnd(i * 3.3 + 29) * 0.3);
      hairMeshes[h].setColorAt(hc, _col);
      hairCursors[h]++;
    }
    // Crowd-gaze capture (procedural figures): skin + cloth at this cursor;
    // the pose-3 phone rides along via its seat-local matrix so a turned
    // figure's phone turns with it. (Hair is currently empty — hairless
    // crowd — so no hair entry.)
    const gazeEntries: AudienceSeatEntry[] = [
      { im: skinMeshes[v], index: c, local: null },
      { im: clothMeshes[v], index: c, local: null },
    ];
    if (v === 3 && builds[3].phoneLocal !== null) {
      gazeEntries.push({ im: phones, index: phoneIdx, local: builds[3].phoneLocal });
      _m2.multiplyMatrices(dum.matrix, builds[3].phoneLocal);
      phones.setMatrixAt(phoneIdx, _m2);
      phoneIdx++;
    }
    liveSeats.push({
      px: sl.x,
      pz: sl.z,
      baseYaw: sl.yaw,
      base: dum.matrix.clone(),
      entries: gazeEntries,
      curYaw: 0,
      curLean: 0,
    });
  });
  // Park any unused instance (a hair style nobody got) far below the floor.
  dum.position.set(0, -50, 0);
  dum.scale.setScalar(0.0001);
  dum.updateMatrix();
  for (let h = 0; h < hairMeshes.length; h++) {
    if (hairCounts[h] === 0) hairMeshes[h].setMatrixAt(0, dum.matrix);
  }
  for (const im of [...skinMeshes, ...clothMeshes, ...hairMeshes]) {
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    add(im);
  }
  if (phoneIdx === 0) {
    phones.setMatrixAt(0, dum.matrix);
  }
  phones.instanceMatrix.needsUpdate = true;
  add(phones);

  publishLive();

  // Flash anchors: ~90 seats sampled at head height for the camera-flash cloud.
  const anchors: number[] = [];
  const stride = Math.max(1, Math.floor(slots.length / 90));
  for (let i = 0; i < slots.length; i += stride) {
    anchors.push(slots[i].x, slots[i].y + 0.62, slots[i].z);
  }
  return anchors;
}

function buildSet(world: World, root: Entity, path: SegmentedPath): Entity[] {
  const created: Entity[] = [];
  const layout = path.segments[0].rect; // the spine — drives every show element
  const plan = shapeFloorPlan(path);
  // The ONE silhouette every ground element hugs: the exact union outline, with
  // convex (0.6) + concave (0.3) corners rounded for T/X/U (straight stays
  // square). Computed ONCE here so the deck, floor, strip, audience and shadow
  // all share the identical polygon — they can never drift apart at a corner.
  const isStraight = path.kind === "straight";
  const outline = roundOutline(
    shapeOutline(plan),
    isStraight ? 0 : 0.6,
    isStraight ? 0 : 0.3,
  );
  const add = (obj: Object3D): Entity => {
    const e = world.createTransformEntity(obj, { parent: root });
    created.push(e);
    return e;
  };

  const len = layout.length;
  const wid = layout.width;
  // LOCAL extents: deck spans local z [-len/2 (far/pose), +len/2 (near/start)].
  const halfLen = len / 2;
  // Pose mark sits POSE_INSET in from the far end -> local z derived via along.
  const poseZ = localZForAlong(len, poseAlong(layout)); // negative (toward far)
  const nearEdgeZ = halfLen; // local z of the near (start) edge

  // -- 1. ONE solid deck body: a single mesh extruded from the whole shape
  //       outline (replaces the per-segment boxes that overlapped at junctions
  //       and read as "stacked rectangles"). The U is one horseshoe slab, the X
  //       one cross slab. The live floor + strip sit on top of this same outline.
  add(buildDeckBody(outline));

  // -- 3. The (X) pose mark — walk here, pose, turn. ------------------------
  const markGeom = new PlaneGeometry(0.66, 0.66);
  markGeom.rotateX(-Math.PI / 2);
  const markMat = new MeshBasicMaterial({
    map: makePoseMarkTexture(),
    transparent: true,
    depthWrite: false,
  });
  const poseMark = new Mesh(markGeom, markMat);
  poseMark.name = "pose-mark";
  poseMark.position.set(0, STAGE.deckHeight + 0.003, poseZ);
  poseMark.renderOrder = 1;
  add(poseMark).addComponent(StagePoseMark);

  // -- 4. Shoe prints: heeled-pump soles, ONE InstancedMesh, length-fitted. --
  // First print just past the near edge; last print stops short of the pose
  // mark; count derives from the gap so it re-fits any layout length.
  const printFirstZ = nearEdgeZ - 0.35; // toward -z from the near edge
  const printLastZ = poseZ + 0.42; // short of the (X) mark (toward +z)
  const printSpan = printFirstZ - printLastZ; // positive: extends toward -z
  const printCount = Math.max(1, Math.floor(printSpan / STRIDE) + 1);

  const printGeom = new PlaneGeometry(0.13, 0.3);
  printGeom.rotateX(-Math.PI / 2); // toe (uv v=1) points down-deck (-z)
  // SDF footprint (2026-07-27 founder: "tactile... not flat images"): the
  // pump sole/heel is analytic distance-field math, embossed by a screen-
  // derivative normal + a breathing pressure glow. instanceColor still
  // carries the FootprintGlowSystem dim/hot tint; mirrored left prints work
  // (the SDF is evaluated in uv space, DoubleSide).
  const printMat = createFootprintMaterial();
  const prints = new InstancedMesh(printGeom, printMat, printCount);
  prints.name = "shoe-prints";
  prints.frustumCulled = false;
  prints.renderOrder = 2;
  const dummy = new Object3D();
  for (let i = 0; i < printCount; i++) {
    const side = i % 2 === 0 ? 1 : -1; // lead right, mirror left
    const jx = (rnd(i * 3.7 + 2) - 0.5) * 0.01;
    const jr = (rnd(i * 5.1 + 4) - 0.5) * 0.04;
    dummy.position.set(
      side * PRINT_X + jx,
      STAGE.deckHeight + 0.004,
      printFirstZ - i * STRIDE,
    );
    dummy.rotation.set(0, -side * TOE_OUT + jr, 0); // toe-out, organic jitter
    dummy.scale.set(side, 1, 1); // mirror the right-foot art for left strikes
    dummy.updateMatrix();
    prints.setMatrixAt(i, dummy.matrix);
    prints.setColorAt(i, FOOT_DIM);
  }
  prints.instanceMatrix.needsUpdate = true;
  prints.instanceColor!.needsUpdate = true;
  // Stash the print-layout numbers FootprintGlowSystem needs to map progress
  // -> instance index (local-space now), so it never re-imports world consts.
  const printsEnt = add(prints);
  printsEnt.addComponent(FootprintGuides);
  // uTime/uEnergy for the SDF emboss shimmer + walk-energy lift.
  printsEnt.addComponent(ShaderDriven);
  const printsAny = prints as unknown as Record<string, number>;
  printsAny.userFirstZ = printFirstZ;
  printsAny.userLastZ = printLastZ;
  printsAny.userStride = STRIDE;
  printsAny.userCount = printCount;
  printsAny.userPoseZ = poseZ;
  // Start/finish line local z (near end, START_INSET in from the near edge).
  printsAny.userStartZ = localZForAlong(len, startAlong());

  // Audience + camera-flashes are the heaviest part of a rebuild (4 merged
  // humanoids + InstancedMeshes with per-seat matrices + the flash Points cloud).
  // When the crowd is hidden — the default in immersive XR — SKIP building them
  // entirely, so a size commit / fit-to-room rebuild in the headset stays cheap.
  // The P0 crash fix hid the crowd from the RENDER budget; this drops it from the
  // REBUILD budget too. The crowd toggle rebuilds the set (rebuildSet), so turning
  // it back on re-creates them.
  const crowdSig = (world.globals as Record<string, unknown>).crowdVisible as
    | Signal<boolean>
    | undefined;
  // Replay Theater reads the finale front-row seat slots for its viewpoint;
  // clear the export up-front so a crowd-hidden build never leaves a STALE
  // list from the previous set (the system falls back to a computed seat).
  (world.globals as Record<string, unknown>).audienceFrontRowLocal = null;
  // Crowd-gaze: same staleness law — a crowd-hidden rebuild must never leave
  // the gaze system holding DISPOSED InstancedMeshes. (Keep the rev counter
  // monotonic across builds: null carries no rev, so stash it.)
  {
    const g = world.globals as Record<string, unknown>;
    const live = g.audienceLive as { rev?: number } | null | undefined;
    if (live && typeof live.rev === "number") {
      g.__audienceLiveRev = live.rev;
    }
    g.audienceLive = null;
    // Judges' paddle anchors: same staleness law (rev stashed by the builder).
    g.judgesPaddles = null;
  }
  if (crowdSig === undefined || crowdSig.peek()) {
    // Photographer pit (2026-07-15 art direction): standing press at the walk's
    // end. Only when pit models loaded — and then the end-cap seats clear out.
    const pitModels = (world.globals as Record<string, unknown>).pitModels as
      | AudienceModel[]
      | undefined;
    const pitActive = pitModels !== undefined && pitModels.length > 0;
    const flashAnchors = buildShapeAudience(
      world,
      root,
      plan,
      path,
      outline,
      created,
      pitActive,
    );
    if (pitActive) {
      const addPit = (obj: Object3D): Entity => {
        const e = world.createTransformEntity(obj, { parent: root });
        created.push(e);
        return e;
      };
      buildPhotographerPit(pitModels, path, addPit, new Object3D());
    }

    // -- 6. Camera flashes: ONE Points cloud clustered on the actual crowd. -----
    // Anchored to a sample of audience seats (buildShapeAudience), so the flashes
    // surround the trainee on every shape instead of just lining the spine.
    const FLASHES = Math.max(1, Math.floor(flashAnchors.length / 3));
    const fPos = new Float32Array(
      flashAnchors.length > 0 ? flashAnchors : [0, -10, 0],
    );
    const fRand = new Float32Array(FLASHES);
    for (let i = 0; i < FLASHES; i++) {
      fPos[i * 3 + 1] += rnd(i * 2.9 + 5) * 0.5; // lift flashes above the seat
      fRand[i] = rnd(i * 11.7 + 13);
    }
    const flashGeom = new BufferGeometry();
    flashGeom.setAttribute("position", new BufferAttribute(fPos, 3));
    flashGeom.setAttribute("aRand", new BufferAttribute(fRand, 1));
    const flashes = new Points(flashGeom, createCameraFlashMaterial());
    flashes.name = "camera-flashes";
    flashes.frustumCulled = false;
    add(flashes).addComponent(ShaderDriven);
  }

  // -- 7. Truss GRID over the whole shape bbox + fixtures hung only where they
  //       sit over the deck + ONE SpotLight + ONE HemisphereLight. The old rig
  //       was two bars across the spine only, so a T/X/U's arms had no light
  //       overhead; now the grid spans the bbox (covering every arm) and the
  //       lamps follow the actual silhouette (pointInPolygon), not the bbox.
  const bx0 = plan.minX;
  const bx1 = plan.maxX;
  const bz0 = plan.minZ;
  const bz1 = plan.maxZ;
  const bboxW = plan.width || 1;
  const bboxL = plan.length || 1;
  const margin = 0.6;
  const nCross = Math.min(14, Math.max(2, Math.round(bboxL / 2.4)));
  const crossZs: number[] = [];
  for (let i = 0; i < nCross; i++) {
    crossZs.push(bz0 + ((i + 0.5) / nCross) * bboxL);
  }
  const railXs = [bx0 - margin * 0.4, bx1 + margin * 0.4];
  const trussParts: BufferGeometry[] = [];
  for (const z of crossZs) {
    // cross bar along X spanning the bbox width (+ margin)
    const g = new CylinderGeometry(0.035, 0.035, bboxW + margin, 10);
    g.rotateZ(Math.PI / 2); // lie along x
    g.translate((bx0 + bx1) / 2, STAGE.trussY, z);
    trussParts.push(g);
  }
  for (const x of railXs) {
    // rail along Z spanning the bbox length (+ margin) — frames the grid
    const g = new CylinderGeometry(0.035, 0.035, bboxL + margin, 10);
    g.rotateX(Math.PI / 2); // lie along z
    g.translate(x, STAGE.trussY, (bz0 + bz1) / 2);
    trussParts.push(g);
  }
  const truss = new Mesh(
    mergeParts(trussParts),
    new MeshStandardMaterial({ color: 0x141a21, roughness: 0.6, metalness: 0.8 }),
  );
  truss.name = "truss";
  add(truss);

  // Fixtures (lamps) hang ALONG each runway segment's centerline — so every leg
  // / arm gets light overhead, not just the spine. (A bbox grid would miss the
  // narrow 1.4 m-wide arms between samples.) Dedup at junctions where segments
  // overlap so the crossing doesn't double up.
  const coneParts: BufferGeometry[] = [];
  const lensParts: BufferGeometry[] = [];
  const lampAt: Array<[number, number]> = [];
  const placeLamp = (x: number, z: number): void => {
    for (const [px, pz] of lampAt) {
      if ((px - x) ** 2 + (pz - z) ** 2 < 0.7 * 0.7) return; // dedup at junctions
    }
    lampAt.push([x, z]);
    const cone = new ConeGeometry(0.075, 0.18, 8);
    cone.rotateX(Math.PI); // point down
    cone.translate(x, STAGE.trussY - 0.13, z);
    coneParts.push(cone);
    const lens = new CircleGeometry(0.05, 12);
    lens.rotateX(Math.PI / 2); // face down
    lens.translate(x, STAGE.trussY - 0.225, z);
    lensParts.push(lens);
  };
  for (const seg of plan.segments) {
    const adx = -Math.sin(seg.yaw);
    const adz = -Math.cos(seg.yaw);
    const nLamp = lampCount(seg.length);
    for (let l = 0; l < nLamp; l++) {
      const a = ((l + 0.5) / nLamp - 0.5) * seg.length;
      placeLamp(seg.cx + adx * a, seg.cz + adz * a);
    }
  }
  const fixtures = new Mesh(
    mergeParts(coneParts),
    new MeshStandardMaterial({ color: 0x141a21, roughness: 0.5, metalness: 0.85 }),
  );
  fixtures.name = "fixtures";
  add(fixtures);
  const lenses = new Mesh(
    mergeParts(lensParts),
    new MeshBasicMaterial({ color: BRAND.white }),
  );
  lenses.name = "fixture-lenses";
  add(lenses);

  const spotTarget = new Object3D();
  spotTarget.name = "stage-spot-target";
  spotTarget.position.set(0, STAGE.deckHeight, 0);
  add(spotTarget);

  const spot = new SpotLight(0xf6ead8, 6, 0, 0.38, 0.4, 1.2);
  spot.name = "stage-spot";
  spot.position.set(0, STAGE.trussY - 0.07, 0.35);
  spot.castShadow = false;
  spot.target = spotTarget;
  add(spot).addComponent(StageSpotRig);

  // Ground tint = deep Carolina: the cheap "lit by the floor glow" bounce.
  const hemi = new HemisphereLight(BRAND.white, 0x143046, 0.5);
  hemi.name = "house-fill";
  add(hemi).addComponent(StageHemiLight);

  // -- 8. Shadow catcher: a soft contact shadow that follows the SHAPE outline
  //       (expanded a touch so a halo peeks past the deck edge) instead of a
  //       spine-sized rectangle — so a T/X/U grounds its arms too and never
  //       re-asserts a bounding rectangle. UVs are normalized over the bbox so
  //       the radial fade maps once across the silhouette.
  const shadowPoly = expandOutline(outline, 0.3);
  const shadowShape = new Shape();
  shadowShape.moveTo(shadowPoly[0][0], -shadowPoly[0][1]);
  for (let i = 1; i < shadowPoly.length; i++) {
    shadowShape.lineTo(shadowPoly[i][0], -shadowPoly[i][1]);
  }
  shadowShape.closePath();
  const shadowGeo = new ShapeGeometry(shadowShape);
  shadowGeo.rotateX(-Math.PI / 2);
  shadowGeo.computeBoundingBox();
  const sbb = shadowGeo.boundingBox!;
  const suv = shadowGeo.attributes.uv;
  const sw = sbb.max.x - sbb.min.x || 1;
  const sl = sbb.max.z - sbb.min.z || 1;
  const sp = shadowGeo.attributes.position;
  for (let i = 0; i < suv.count; i++) {
    suv.setXY(i, (sp.getX(i) - sbb.min.x) / sw, (sp.getZ(i) - sbb.min.z) / sl);
  }
  suv.needsUpdate = true;
  const shadow = new Mesh(
    shadowGeo,
    new MeshBasicMaterial({ map: makeShadowTexture(), transparent: true, depthWrite: false }),
  );
  shadow.name = "shadow-catcher";
  shadow.position.set(0, 0.0008, 0);
  shadow.renderOrder = -1;
  add(shadow);

  // (Arms/legs need no per-segment sub-roots anymore: the single extruded deck
  // body + the one unified floor + the one perimeter strip already cover the
  // whole T/X/U via the shared `outline`. No more overlapping per-segment boxes.)

  // -- 10. ONE continuous reactive floor, a single heave-density grid clipped to
  //        the (rounded) outline. Replaces the per-segment floor planes (which
  //        stacked + overlapped at every junction) with one connected, seam-free
  //        surface that follows the rounded silhouette. uv is bbox-normalized so
  //        the floor shader reads a single shared coordinate space (uDeck = bbox).
  const floorMat = createLiveFloorMaterial();
  floorMat.side = DoubleSide;
  floorMat.userData.segIndex = 0;
  floorMat.userData.unifiedDeck = new Float32Array([plan.width, plan.length]);
  floorMat.uniforms.uDeck.value[0] = plan.width;
  floorMat.uniforms.uDeck.value[1] = plan.length;
  const liveFloor = new Mesh(createUnifiedFloorGeometry(plan, outline), floorMat);
  liveFloor.name = "live-floor";
  liveFloor.frustumCulled = false; // bounds change as tiles heave
  liveFloor.position.set(0, STAGE.deckHeight + 0.0015, 0);
  add(liveFloor).addComponent(ShaderDriven);

  // -- 11. ONE perimeter edge strip hugging the whole (rounded) outline (replaces
  //        the per-segment strips that crossed at every junction). The chase comet
  //        runs around the shape via a per-vertex arc-length attribute.
  const stripMat = createPerimeterStripMaterial();
  stripMat.side = DoubleSide;
  const strip = new Mesh(createPerimeterStripGeometry(outline), stripMat);
  strip.name = "edge-strips";
  strip.frustumCulled = false;
  add(strip).addComponent(ShaderDriven);

  // -- 12. Hero (X) crossing: a glowing Carolina-Blue medallion at the centre
  //        where the spine and crossbar meet, so the X reads as one dramatic
  //        crossing instead of two overlapping strips. X only (a straight/T/U
  //        has no true crossing). Centre = the perpendicular arm's center
  //        projected onto the spine; sits flat just above the live floor.
  if (path.kind === "X") {
    const spine = plan.segments[0];
    const adx = -Math.sin(spine.yaw);
    const adz = -Math.cos(spine.yaw);
    let perp = plan.segments[1] ?? spine;
    for (let i = 1; i < plan.segments.length; i++) {
      const s = plan.segments[i];
      if (Math.abs(Math.cos(s.yaw - spine.yaw)) < 0.2) {
        perp = s;
        break;
      }
    }
    const along = (perp.cx - spine.cx) * adx + (perp.cz - spine.cz) * adz;
    const crossX = spine.cx + adx * along;
    const crossZ = spine.cz + adz * along;
    const radius = Math.max(spine.width, perp.width) * 1.05;
    const medallion = new Mesh(new CircleGeometry(radius, 48), createCrossingMaterial());
    medallion.name = "crossing-hero";
    medallion.rotation.x = -Math.PI / 2; // lie flat, facing up
    medallion.position.set(crossX, STAGE.deckHeight + 0.0035, crossZ);
    medallion.frustumCulled = false;
    add(medallion).addComponent(ShaderDriven);
  }

  return created;
}

/* ------------------------------------------------------------------------ */
/* MAP-FORMING PREVIEW — light Carolina overlay while mapping (mapMode!=off). */
/* Built ONCE under the root (local origin); each frame the MapPreviewSystem  */
/* reads the mapping globals and re-points cheap lines/rings in WORLD space   */
/* (the preview meshes sit on a child whose transform is reset to identity so */
/* their geometry is authored directly in world coordinates).                 */
/* ------------------------------------------------------------------------ */

const MapPreviewTag = createComponent("MapPreviewTag", {});

/** Geometry/uniform handles the preview system pokes each frame (no alloc). */
interface PreviewHandles {
  group: Object3D;
  outline: Line; // 5-vertex closed rectangle outline of the layout
  outlinePos: Float32Array;
  startRing: Mesh; // ring at the placed start point
  reticleRing: Mesh; // ring at the live floor reticle
  startLine: Line; // start -> reticle
  startLinePos: Float32Array;
}

function buildMapPreview(world: World, root: Entity): PreviewHandles {
  const group = new Object3D();
  group.name = "map-preview";
  group.visible = false;
  const groupEntity = world.createTransformEntity(group, { parent: root });
  groupEntity.addComponent(MapPreviewTag);

  const lineMat = new LineBasicMaterial({
    color: BRAND.accentSoft,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
  });
  const ringMat = new MeshBasicMaterial({
    color: BRAND.accent,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    side: DoubleSide,
  });

  // Outline: a closed rectangle (5 points). Authored in LOCAL group space,
  // but the group is reparented to a world-identity slot below so its vertices
  // are effectively world coordinates we rewrite each frame.
  const outlinePos = new Float32Array(5 * 3);
  const outlineGeom = new BufferGeometry();
  outlineGeom.setAttribute("position", new BufferAttribute(outlinePos, 3));
  const outline = new Line(outlineGeom, lineMat);
  outline.name = "preview-outline";
  outline.frustumCulled = false;
  outline.renderOrder = 3;
  group.add(outline);

  const startLinePos = new Float32Array(2 * 3);
  const startLineGeom = new BufferGeometry();
  startLineGeom.setAttribute("position", new BufferAttribute(startLinePos, 3));
  const startLine = new Line(startLineGeom, lineMat);
  startLine.name = "preview-start-line";
  startLine.frustumCulled = false;
  startLine.renderOrder = 3;
  group.add(startLine);

  const ringGeom = new RingGeometry(0.16, 0.22, 28);
  ringGeom.rotateX(-Math.PI / 2); // lie flat on the floor
  const startRing = new Mesh(ringGeom, ringMat);
  startRing.name = "preview-start-ring";
  startRing.frustumCulled = false;
  startRing.renderOrder = 4;
  startRing.visible = false;
  group.add(startRing);

  const reticleGeom = new RingGeometry(0.12, 0.17, 28);
  reticleGeom.rotateX(-Math.PI / 2);
  const reticleRing = new Mesh(reticleGeom, ringMat.clone());
  reticleRing.name = "preview-reticle-ring";
  reticleRing.frustumCulled = false;
  reticleRing.renderOrder = 4;
  reticleRing.visible = false;
  group.add(reticleRing);

  return {
    group,
    outline,
    outlinePos,
    startRing,
    reticleRing,
    startLine,
    startLinePos,
  };
}

/* ------------------------------------------------------------------------ */
/* createStage — builds the layout-driven set + preview, wires the relayout   */
/* subscription. Called AFTER globals exist (index.ts).                       */
/* ------------------------------------------------------------------------ */

export function createStage(world: World): Entity {
  const root = world.createTransformEntity();
  root.object3D!.name = "stage-root";
  root.addComponent(StageRoot);

  const pathSig = (world.globals as Record<string, unknown>).compiledPath as
    | Signal<SegmentedPath>
    | undefined;
  let current: SegmentedPath =
    pathSig !== undefined ? pathSig.peek() : compileShape(DEFAULT_SHAPE);

  // World placement is a ROOT transform set from the SPINE center + yaw; the
  // set lives in spine-local space (arms are relative sub-roots that move with).
  const applyPlacement = (path: SegmentedPath): void => {
    const obj = root.object3D;
    if (obj === undefined) return;
    const spine = path.segments[0].rect;
    obj.position.set(spine.centerX, 0, spine.centerZ);
    obj.rotation.set(0, spine.yaw, 0);
  };
  applyPlacement(current);

  // Shape-dependent children (disposed + rebuilt on a dimension/structure change).
  let setEntities = buildSet(world, root, current);

  // Rebuild the shape-dependent children (deck, reactive floor, audience). Disposes
  // the current set — freeing GPU, including InstancedMesh instance buffers — then
  // rebuilds from the CURRENT compiled path. Used on a structure/dimension change
  // AND on a crowd toggle: the audience is built LAZILY (buildSet skips it while the
  // crowd is hidden), so showing/hiding the crowd must rebuild to create/free those
  // meshes rather than just flip .visible.
  const rebuildSet = (): void => {
    // Dispose in REVERSE creation order: an arm's sub-root is pushed to
    // setEntities BEFORE its child deck entities, so reverse order disposes +
    // detaches each child first, leaving the sub-root nothing to double-free.
    // entity.dispose() frees geometry/material/textures but NOT an InstancedMesh's
    // instanceMatrix/instanceColor GPU buffers — dispose those explicitly first.
    for (let i = setEntities.length - 1; i >= 0; i--) {
      const e = setEntities[i];
      if (!e.active) continue;
      const obj = e.object3D;
      if (obj !== undefined) {
        obj.traverse((o) => {
          const im = o as InstancedMesh;
          if (im.isInstancedMesh === true) im.dispose();
        });
      }
      e.dispose();
    }
    setEntities = buildSet(world, root, current);
  };

  // Crowd toggle: rebuild so the audience is created/freed to match g.crowdVisible
  // (auto-hidden in immersive XR for clear passthrough + GPU headroom — index.ts).
  // crowdVisible only flips on the NonImmersive<->immersive crossing + manual
  // toggles, so this never thrashes on a Quest focus blink. The dedup guard skips
  // a no-op re-emit.
  const crowdSig = (world.globals as Record<string, unknown>).crowdVisible as
    | Signal<boolean>
    | undefined;
  if (crowdSig !== undefined) {
    const cf = (world.globals as Record<string, unknown>).cleanupFuncs;
    let lastCrowd = crowdSig.peek();
    const unsub = crowdSig.subscribe(() => {
      const now = crowdSig.peek();
      if (now === lastCrowd) return;
      lastCrowd = now;
      rebuildSet();
    });
    if (Array.isArray(cf)) (cf as Array<() => void>).push(unsub);
  }

  // Custom audience models (the "Mixamo route") load asynchronously after startup
  // (index.ts) and bump g.audienceRev when ready — rebuild so the crowd swaps from
  // the procedural figures to the loaded models.
  const audRev = (world.globals as Record<string, unknown>).audienceRev as
    | Signal<number>
    | undefined;
  if (audRev !== undefined) {
    const cf = (world.globals as Record<string, unknown>).cleanupFuncs;
    let lastRev = audRev.peek();
    const unsub = audRev.subscribe(() => {
      const now = audRev.peek();
      if (now === lastRev) return;
      lastRev = now;
      rebuildSet();
    });
    if (Array.isArray(cf)) (cf as Array<() => void>).push(unsub);
  }

  // The map preview is built ONCE (cheap, static buffers we rewrite per frame)
  // and parented under a SEPARATE world-anchored entity so its lines/rings are
  // authored directly in world space (independent of the runway yaw).
  const previewRoot = world.createTransformEntity();
  previewRoot.object3D!.name = "map-preview-root";
  const preview = buildMapPreview(world, previewRoot);
  // Hand the preview handles to the system via globals (read defensively).
  (world.globals as Record<string, unknown>).__stageMapPreview = preview;

  // Relayout: a pure placement move (spine center/yaw) is a cheap root transform
  // — the arms are relative, so they move with it. A dimension/structure change
  // (spine size, segment count, or an arm's size) rebuilds the set. dispose()
  // frees GPU; the new children re-fire qualify so the systems re-acquire.
  if (pathSig !== undefined) {
    const cleanup = pathSig.subscribe((next) => {
      const prev = current.segments[0].rect;
      const nextSpine = next.segments[0].rect;
      let structureChanged =
        next.segments.length !== current.segments.length ||
        next.kind !== current.kind ||
        Math.abs(nextSpine.length - prev.length) > 1e-4 ||
        Math.abs(nextSpine.width - prev.width) > 1e-4;
      if (!structureChanged) {
        // Compare each arm RELATIVE to the spine. A pure placement move (spine
        // center/yaw) translates+rotates the spine and arms together via the
        // root transform, so comparing arm WORLD centers would needlessly
        // rebuild the whole set on every position/rotation nudge. Un-rotate each
        // arm's offset into spine-local space: only a relative move — an X's
        // crossAt slide, a T↔X switch — changes it, and THAT must rebuild the
        // crossbar (else the deck renders at the old spot while ripples land at
        // the new one).
        // Un-project each arm center into spine-local (along, lateral) using the
        // INVERSE of alongLateralToWorld (its forward map is non-standard:
        // x = cx − sin·d + cos·lat, z = cz − cos·d − sin·lat). These coords are
        // invariant under a pure placement rotation, so a yaw nudge doesn't
        // rebuild; an X crossAt slide moves `along`, which does.
        const c = Math.cos(nextSpine.yaw);
        const s = Math.sin(nextSpine.yaw);
        const cP = Math.cos(prev.yaw);
        const sP = Math.sin(prev.yaw);
        for (let i = 1; i < next.segments.length; i++) {
          const a = next.segments[i].rect;
          const b = current.segments[i].rect;
          const aox = a.centerX - nextSpine.centerX;
          const aoz = a.centerZ - nextSpine.centerZ;
          const box = b.centerX - prev.centerX;
          const boz = b.centerZ - prev.centerZ;
          if (
            Math.abs(a.length - b.length) > 1e-4 ||
            Math.abs(a.width - b.width) > 1e-4 ||
            Math.abs(aox * s + aoz * c - (box * sP + boz * cP)) > 1e-4 ||
            Math.abs(aox * c - aoz * s - (box * cP - boz * sP)) > 1e-4 ||
            Math.abs(a.yaw - nextSpine.yaw - (b.yaw - prev.yaw)) > 1e-4
          ) {
            structureChanged = true;
            break;
          }
        }
      }
      const placementChanged =
        Math.abs(nextSpine.centerX - prev.centerX) > 1e-4 ||
        Math.abs(nextSpine.centerZ - prev.centerZ) > 1e-4 ||
        Math.abs(nextSpine.yaw - prev.yaw) > 1e-4;
      current = next;
      if (placementChanged || structureChanged) applyPlacement(next);
      // A dimension/structure change rebuilds the set (deck/floor/audience) from
      // the new path (= `current`, set above). rebuildSet reads g.crowdVisible, so
      // the rebuilt audience already respects the toggle — no re-apply needed.
      if (structureChanged) rebuildSet();
    });
    // The stage is permanent (single-level app, world never torn down), so the
    // subscription lives for the lifetime of the world. We still register the
    // unsubscriber in globals.cleanupFuncs per the REV3 contract, so any future
    // teardown path (or the integrator) can dispose it.
    const cf = (world.globals as Record<string, unknown>).cleanupFuncs as
      | Array<() => void>
      | undefined;
    if (Array.isArray(cf)) {
      cf.push(cleanup);
    } else {
      (world.globals as Record<string, unknown>).cleanupFuncs = [cleanup];
    }
  }

  return root;
}

/* ------------------------------------------------------------------------ */
/* MapPreviewSystem — drives the Carolina map-forming overlay each frame.     */
/* Reads globals.mapMode (Signal<string>, "off" when inactive),               */
/* globals.draftLayout (RunwayLayout|null), globals.mapPoints                 */
/* ({ start, end }), globals.reticle ({x,z}|null). All read defensively       */
/* (MappingSystem owns + creates them; they may be undefined early). Hidden    */
/* entirely while mapMode == "off". Zero per-frame allocation.                */
/* ------------------------------------------------------------------------ */

export class MapPreviewSystem extends createSystem({
  preview: { required: [MapPreviewTag] },
}) {
  private handles: PreviewHandles | null = null;
  private corners!: Float32Array; // scratch for the 4 outline corners (x,z)*4

  init(): void {
    this.corners = new Float32Array(8);
    this.cleanupFuncs.push(
      this.queries.preview.subscribe(
        "qualify",
        () => {
          const h = (this.globals as Record<string, unknown>)
            .__stageMapPreview as PreviewHandles | undefined;
          if (h !== undefined) this.handles = h;
        },
        true,
      ),
      this.queries.preview.subscribe("disqualify", () => {
        this.handles = null;
      }),
    );
  }

  update(): void {
    const h = this.handles;
    if (h === null) return;

    const modeSig = (this.globals as Record<string, unknown>).mapMode as
      | Signal<string>
      | undefined;
    const mode = modeSig !== undefined ? modeSig.peek() : "off";
    if (mode === "off") {
      if (h.group.visible) h.group.visible = false;
      return;
    }
    h.group.visible = true;

    // --- Outline: draft layout if set, else the committed layout. -----------
    const draft = (this.globals as Record<string, unknown>).draftLayout as
      | RunwayLayout
      | null
      | undefined;
    const committed = (this.globals as Record<string, unknown>).runwayLayout as
      | Signal<RunwayLayout>
      | undefined;
    const layout =
      draft !== null && draft !== undefined
        ? draft
        : committed !== undefined
          ? committed.peek()
          : null;

    if (layout !== null) {
      // Rectangle corners in WORLD space from the layout frame.
      const s = Math.sin(layout.yaw);
      const c = Math.cos(layout.yaw);
      const fx = -s;
      const fz = -c; // forward unit
      const rx = c;
      const rz = -s; // right unit
      const hl = layout.length / 2;
      const hw = layout.width / 2;
      const cx = layout.centerX;
      const cz = layout.centerZ;
      // 4 corners: (+/-forward) x (+/-right)
      const corners = this.corners;
      corners[0] = cx + fx * hl + rx * hw;
      corners[1] = cz + fz * hl + rz * hw;
      corners[2] = cx + fx * hl - rx * hw;
      corners[3] = cz + fz * hl - rz * hw;
      corners[4] = cx - fx * hl - rx * hw;
      corners[5] = cz - fz * hl - rz * hw;
      corners[6] = cx - fx * hl + rx * hw;
      corners[7] = cz - fz * hl + rz * hw;
      const op = h.outlinePos;
      const y = 0.012;
      for (let i = 0; i < 4; i++) {
        op[i * 3] = corners[i * 2];
        op[i * 3 + 1] = y;
        op[i * 3 + 2] = corners[i * 2 + 1];
      }
      op[12] = corners[0];
      op[13] = y;
      op[14] = corners[1];
      (h.outline.geometry.attributes.position as BufferAttribute).needsUpdate =
        true;
      h.outline.visible = true;
    } else {
      h.outline.visible = false;
    }

    // --- Start marker + line to the live reticle. ---------------------------
    const mapPoints = (this.globals as Record<string, unknown>).mapPoints as
      | { start: { x: number; z: number } | null; end: { x: number; z: number } | null }
      | undefined;
    const reticle = (this.globals as Record<string, unknown>).reticle as
      | { x: number; z: number }
      | null
      | undefined;

    const start =
      mapPoints !== undefined && mapPoints !== null ? mapPoints.start : null;
    if (start !== null && start !== undefined) {
      h.startRing.position.set(start.x, 0.013, start.z);
      h.startRing.visible = true;
    } else {
      h.startRing.visible = false;
    }

    if (reticle !== null && reticle !== undefined) {
      h.reticleRing.position.set(reticle.x, 0.013, reticle.z);
      h.reticleRing.visible = true;
    } else {
      h.reticleRing.visible = false;
    }

    // Line start -> reticle while placing the end.
    if (
      start !== null &&
      start !== undefined &&
      reticle !== null &&
      reticle !== undefined
    ) {
      const lp = h.startLinePos;
      lp[0] = start.x;
      lp[1] = 0.012;
      lp[2] = start.z;
      lp[3] = reticle.x;
      lp[4] = 0.012;
      lp[5] = reticle.z;
      (h.startLine.geometry.attributes.position as BufferAttribute).needsUpdate =
        true;
      h.startLine.visible = true;
    } else {
      h.startLine.visible = false;
    }
  }
}

/* ------------------------------------------------------------------------ */
/* StageMoodSystem — house ambiance <-> show ambiance, driven by showEnergy.  */
/* The spotlight follows THE TRAINEE (this.player.head, WORLD space — no      */
/* change needed for REV3). Pose mark pulses with energy. Marker components + */
/* qualify/replay so a relayout rebuild re-acquires the refs.                 */
/* ------------------------------------------------------------------------ */
export class StageMoodSystem extends createSystem({
  spotRig: { required: [StageSpotRig] },
  hemiLight: { required: [StageHemiLight] },
  poseMark: { required: [StagePoseMark] },
}) {
  private spot: SpotLight | null = null;
  private spotTarget: Object3D | null = null;
  private hemi: HemisphereLight | null = null;
  private markMat: MeshBasicMaterial | null = null;

  private focusPos!: Vector3;
  private headPos!: Vector3;
  private houseCol!: Color;
  private showCol!: Color;

  /** Finale beat (#18): private rising-edge latch for globals.finishBurst —
   * the flag is shared and durable (ShaderTimeSystem / SFX edge it too), so
   * this system NEVER clears it; it only mirrors it into its own prev. */
  private finishPrev = false;
  /** Seconds since the finish edge; ≥ FINALE_TOTAL_SEC = no finale active. */
  private finaleT = Infinity;
  /** #45: LIVE spine length for the idle sweep — everything else in this file
   * already derives from the mapped layout; the sweep was the last fixed-7 m
   * holdout (±2.31 m forever — a dead far deck on a long mapped runway). */
  private sweepLen: number = STAGE.deckLength;

  init(): void {
    this.focusPos = new Vector3();
    this.headPos = new Vector3();
    this.houseCol = new Color(0xf6ead8); // warm house tungsten
    this.showCol = new Color(0xeaf4ff); // cool show white (Carolina cast)

    // #45: follow the mapped runway length (the derived spine layout signal —
    // recomputes on every remap; the stage root carries world placement, so
    // the sweep stays in runway-local space).
    const layoutSig = this.globals.runwayLayout as
      | Signal<RunwayLayout>
      | undefined;
    if (layoutSig !== undefined) {
      this.sweepLen = layoutSig.peek().length;
      this.cleanupFuncs.push(
        layoutSig.subscribe((l) => {
          this.sweepLen = l.length;
        }),
      );
    }

    this.cleanupFuncs.push(
      this.queries.spotRig.subscribe(
        "qualify",
        (entity) => {
          const obj = entity.object3D as unknown as SpotLight | undefined;
          if (obj !== undefined && obj.isSpotLight === true) {
            this.spot = obj;
            this.spotTarget = obj.target;
          }
        },
        true,
      ),
      this.queries.spotRig.subscribe("disqualify", () => {
        this.spot = null;
        this.spotTarget = null;
      }),
      this.queries.hemiLight.subscribe(
        "qualify",
        (entity) => {
          const obj = entity.object3D as unknown as HemisphereLight | undefined;
          if (obj !== undefined && obj.isHemisphereLight === true) {
            this.hemi = obj;
          }
        },
        true,
      ),
      this.queries.hemiLight.subscribe("disqualify", () => {
        this.hemi = null;
      }),
      this.queries.poseMark.subscribe(
        "qualify",
        (entity) => {
          const mesh = entity.object3D as unknown as Mesh | undefined;
          if (mesh !== undefined && mesh.isMesh === true) {
            this.markMat = mesh.material as MeshBasicMaterial;
          }
        },
        true,
      ),
      this.queries.poseMark.subscribe("disqualify", () => {
        this.markMat = null;
      }),
    );
  }

  update(delta: number, time: number): void {
    const energySig = this.globals.showEnergy as Signal<number> | undefined;
    const energy = energySig !== undefined ? energySig.peek() : 0;
    const progSig = this.globals.walkProgress as Signal<number> | undefined;
    const walkProgress = progSig !== undefined ? progSig.peek() : -1;
    // Mode intensity tightens + brightens the show beam (Challenge harder than
    // Beginner at the same phase) — coherent with the shader-suite energy bias.
    const modeSig = this.globals.activeMode as Signal<TrainingMode> | undefined;
    const intensity =
      modeSig !== undefined ? modeSig.peek().intensity : DEFAULT_MODE.intensity;
    // M10 hold beat: ShowDirector publishes a PLAIN {t01, still01} ref while
    // the trainee holds the mark (0 off-walk / released). Peeked defensively
    // (partial worlds run without the director) + finiteness-gated — a junk
    // value must not fold into light levels.
    const holdLive = this.globals.holdLive as
      | { t01: number; still01: number }
      | null
      | undefined;
    const holdT =
      holdLive != null && Number.isFinite(holdLive.t01)
        ? holdLive.t01 < 0
          ? 0
          : holdLive.t01 > 1
            ? 1
            : holdLive.t01
        : 0;

    // Finale beat (#18): on the finish edge the show gets its payoff moment —
    // the spot SNAPS onto the trainee (walkProgress is already -1 in summary,
    // which used to dump the beam straight back into the idle sweep) and the
    // house lights swell up, riding the pure finaleEnvelope, then everything
    // eases back into the regular summary mood. Bounded light-level changes
    // on stage fixtures only — passthrough never floods.
    const finish = this.globals.finishBurst === true;
    if (finish && !this.finishPrev) {
      this.finaleT = 0;
    }
    this.finishPrev = finish;
    let finale = 0;
    if (this.finaleT < FINALE_TOTAL_SEC) {
      finale = finaleEnvelope(this.finaleT);
      this.finaleT += delta;
    }

    const spot = this.spot;
    const target = this.spotTarget;
    if (spot !== null && target !== null) {
      // Hero-branch gate rides the finale WINDOW (finaleT), not the envelope
      // value: the linear attack means finaleEnvelope(0) === 0 (pinned by
      // test/show-choreo.test.ts), so a `finale > 0` gate dumped the FIRST
      // finale frame into the idle sweep — one visible lerp step toward the
      // sweep point (meters on a long mapped runway, #45) at the exact
      // finish edge, before the attack recovered (night-review #24). finaleT
      // initializes to Infinity, so pre-first-finish idle behavior and the
      // release handback at t >= TOTAL are unchanged.
      if (walkProgress >= 0 || this.finaleT < FINALE_TOTAL_SEC) {
        // The walk is the trainee's: follow their head (WORLD space), aim at
        // the torso. The spot target is local to the runway root, but lerping
        // toward the head's world position keeps it tracking regardless of the
        // root yaw because three resolves target.position in the target's
        // parent space — and the spotlight aims via getWorldPosition. To stay
        // frame-correct under a yawed root we convert the head into the
        // target's parent (root) local space.
        this.player.head.getWorldPosition(this.headPos);
        const parent = target.parent;
        if (parent !== null) {
          parent.worldToLocal(this.headPos);
        }
        this.focusPos.set(
          this.headPos.x,
          Math.max(0.2, this.headPos.y - 0.55),
          this.headPos.z,
        );
      } else {
        // Idle: slow elegant sweep along the deck (LOCAL space — runway center
        // is the local origin, so sweep around 0 on both axes). #45: amplitude
        // derives from the LIVE mapped length (7 m default is byte-identical
        // to the old STAGE.deckLength * 0.33), so a 20-60 m runway is swept
        // end to end instead of hovering over a small central patch.
        this.focusPos.set(
          Math.sin(time * 0.31) * 0.35,
          STAGE.deckHeight + 0.55,
          Math.sin(time * 0.19) * idleSweepAmplitude(this.sweepLen),
        );
      }
      // Exp smoothing, framerate independent.
      const k = 1 - Math.exp(-7 * delta);
      target.position.lerp(this.focusPos, k);

      // Finale: the hero beam — brighter and tighter on the trainee while the
      // envelope holds, decaying smoothly back to the energy-driven look.
      spot.intensity =
        (6 + 26 * energy * (0.82 + 0.34 * intensity)) * (1 + 0.9 * finale);
      spot.color.lerpColors(this.houseCol, this.showCol, energy);
      // Tighter beam at full show, tighter still for high-intensity modes —
      // and tighter onto the trainee through the measured hold (M10: the
      // finale's own 0.06 tighten quantum reused; worst-case overlap
      // 0.38 - 0.13 - 0.06 - 0.06 = 0.13 rad > 0, see HOLD_SPOT_TIGHTEN).
      spot.angle =
        0.38 -
        (0.08 + 0.05 * intensity) * energy -
        0.06 * finale -
        HOLD_SPOT_TIGHTEN * holdT;
      spot.penumbra = 0.4;
    }

    if (this.hemi !== null) {
      // House lights down for the show — and UP for the finale bow (#18).
      // M10: the hold dims the house ONE PHOTOGRAPHIC STOP at full energy
      // (0.18 -> 0.09, see HOLD_HOUSE_DIM); the * energy factor keeps
      // idle/summary untouched, the clamp keeps the floor at black — stage
      // fixtures only, passthrough never floods (the finale precedent).
      this.hemi.intensity = Math.max(
        0,
        0.5 - 0.32 * energy + 0.35 * finale - HOLD_HOUSE_DIM * holdT * energy,
      );
    }

    if (this.markMat !== null) {
      // Gentle beacon pulse; brightens with show energy (white-hot at walk).
      const pulse = (Math.sin(time * 2.1) * 0.5 + 0.5) * (0.25 + 0.5 * energy);
      const level = Math.min(1, 0.45 + 0.55 * energy + pulse * 0.18);
      this.markMat.color.setScalar(level);
    }
  }
}

/* ------------------------------------------------------------------------ */
/* FootprintGlowSystem — brightens the prints around the trainee.            */
/* Keyed to globals.walkProgress (-1 outside a walk, 0..0.5 down, 0.5..1     */
/* back). REV3: print layout is LOCAL + parametric, so the system reads the  */
/* print-layout numbers stashed on the InstancedMesh on qualify (re-acquired */
/* after a relayout rebuild). Writes instanceColor only when the active      */
/* indices change. Zero per-frame allocation.                                */
/* ------------------------------------------------------------------------ */
export class FootprintGlowSystem extends createSystem({
  guides: { required: [FootprintGuides] },
}) {
  private mesh: InstancedMesh | null = null;
  private activeIdx = -1; // print under the trainee
  private aheadIdx = -1; // next strike in the direction of travel

  // Print-layout numbers (LOCAL z), read off the mesh on qualify.
  private firstZ = 0;
  private startZ = 0;
  private poseZ = 0;
  private stride = STRIDE;
  private count = 0;

  init(): void {
    this.cleanupFuncs.push(
      this.queries.guides.subscribe(
        "qualify",
        (entity) => {
          const obj = entity.object3D as unknown as InstancedMesh | undefined;
          if (obj !== undefined && obj.isInstancedMesh === true) {
            this.mesh = obj;
            const a = obj as unknown as Record<string, number>;
            this.firstZ = a.userFirstZ ?? 0;
            this.startZ = a.userStartZ ?? 0;
            this.poseZ = a.userPoseZ ?? 0;
            this.stride = a.userStride ?? STRIDE;
            this.count = a.userCount ?? obj.count;
            this.activeIdx = -1;
            this.aheadIdx = -1;
          }
        },
        true,
      ),
      this.queries.guides.subscribe("disqualify", () => {
        this.mesh = null;
        this.activeIdx = -1;
        this.aheadIdx = -1;
      }),
    );
  }

  update(): void {
    const mesh = this.mesh;
    if (mesh === null) return;
    const progSig = this.globals.walkProgress as Signal<number> | undefined;
    const progress = progSig !== undefined ? progSig.peek() : -1;

    let idx = -1;
    let ahead = -1;
    if (progress >= 0) {
      // Fold the round-trip into one-way deck position 0..1, then map to LOCAL
      // z: the trainee travels from the start line (near, +z) to the pose mark
      // (far, -z). Prints are indexed from firstZ (near) decreasing by stride.
      const t = progress <= 0.5 ? progress * 2 : (1 - progress) * 2;
      const z = this.startZ + t * (this.poseZ - this.startZ);
      idx = Math.round((this.firstZ - z) / this.stride);
      idx = Math.min(this.count - 1, Math.max(0, idx));
      const dir = progress <= 0.5 ? 1 : -1; // leg 2 walks back up the indices
      const next = idx + dir;
      if (next >= 0 && next < this.count) ahead = next;
    }
    if (idx === this.activeIdx && ahead === this.aheadIdx) return;

    // Restore the previous pair, then light the new one.
    if (this.activeIdx >= 0) mesh.setColorAt(this.activeIdx, FOOT_DIM);
    if (this.aheadIdx >= 0) mesh.setColorAt(this.aheadIdx, FOOT_DIM);
    if (idx >= 0) mesh.setColorAt(idx, FOOT_HOT);
    if (ahead >= 0 && ahead !== idx) mesh.setColorAt(ahead, FOOT_NEAR);
    this.activeIdx = idx;
    this.aheadIdx = ahead;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }
}
