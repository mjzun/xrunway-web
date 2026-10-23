/**
 * (X)RUNWAY brand system + stage layout map.
 * Single source of truth — every module imports its colors and positions from here.
 *
 * Brand: near-black stage, Carolina Blue accent (#4B9CD3 — UNC's official web
 * hex, Pantone 542 C), editorial contrast.
 * "TRAINING. CONFIDENCE. ONE HEADSET AT A TIME."
 */

import { MODES } from "./modes.js";

export const BRAND = {
  /** Stage black — cool near-black, never pure #000. */
  bg: 0x0a0c10,
  bgDeep: 0x05070a,
  /** Carolina Blue — the (X) accent. UNC official web hex #4B9CD3. */
  accent: 0x4b9cd3,
  accentSoft: 0x8ec4e8,
  accentDeep: 0x2f7cb3,
  white: 0xf2f5f8,
  silver: 0x8a8f96,
  /** Warm gold rim accent (sparingly — fixtures, skin-light). */
  gold: 0xd9b78a,
  /** Deep navy floor base (derived from bg — the live floor's resting tone). */
  navy: 0x060f1b,
  /** Warm white — gold-family hot core (crossing medallion, white-hot highlights). */
  warmWhite: 0xfff7e6,
} as const;

/** CSS twins of BRAND for DOM + uikitml use. */
export const BRAND_CSS = {
  bg: "#0a0c10",
  bgDeep: "#05070a",
  accent: "#4b9cd3",
  accentSoft: "#8ec4e8",
  accentDeep: "#2f7cb3",
  white: "#f2f5f8",
  silver: "#8a8f96",
  gold: "#d9b78a",
  navy: "#060f1b",
  warmWhite: "#fff7e6",
} as const;

/** 0xRRGGBB → normalized [r, g, b], quantized to 4 decimals (GLSL literal precision). */
export function hexToRgb01(hex: number): [number, number, number] {
  const q = (v: number) => Math.round((v / 255) * 1e4) / 1e4;
  return [q((hex >> 16) & 0xff), q((hex >> 8) & 0xff), q(hex & 0xff)];
}

/** GLSL vec3 literal for a BRAND hex — e.g. `vec3(0.2941, 0.6118, 0.8275)`. */
export function glslVec3(hex: number): string {
  const [r, g, b] = hexToRgb01(hex);
  const f = (v: number) => v.toFixed(4);
  return `vec3(${f(r)}, ${f(g)}, ${f(b)})`;
}

/**
 * Stage layout, in meters, in WORLD space — FIRST PERSON.
 * The trainee (AR origin, local-floor) stands at (0, 0, 0) at the TOP of the
 * runway and physically walks it: down to the pose mark near the far end,
 * holds, turns, and walks back. The deck is a thin overlay flush with the
 * real floor — its top surface IS the live shader.
 *
 *            -Z  (far)
 *   ┌──────────────────────┐
 *   │   [X]  pose mark     │   z = POSE_MARK_Z
 *  [A]│      DECK        │[A]  audience risers at x = ±AUDIENCE_X
 *   │  │  live shader   │  │
 *   │  │  + footprints  │  │
 *   └──┴────────────────┴──┘   z = DECK_NEAR_Z  (start line, just ahead)
 *            trainee (0,0,0)
 *            +Z (behind the trainee)
 */
export const STAGE = {
  /** Catwalk deck — a thin floor overlay, NOT a raised platform. */
  deckWidth: 1.4,
  deckLength: 7,
  deckHeight: 0.02,
  /** Gap between the trainee's start position and the deck's near edge. */
  nearGap: 0.25,

  /** Audience risers, both sides. */
  audienceX: 1.65,
  audienceRows: 2,
  audiencePerRow: 9,

  /** Spot truss height. */
  trussY: 2.75,
} as const;

/** Near edge of the deck (world z, negative = ahead of the trainee). */
export const DECK_NEAR_Z = -STAGE.nearGap;
/** Far edge of the deck. */
export const DECK_FAR_Z = -STAGE.nearGap - STAGE.deckLength;
/** Deck center. */
export const DECK_CENTER_Z = -STAGE.nearGap - STAGE.deckLength / 2;
/** Top surface of the deck (world y). */
export const DECK_TOP_Y = STAGE.deckHeight;
/** The pose mark — walk here, hold the pose, turn, walk back. */
export const POSE_MARK_Z = DECK_FAR_Z + 0.6;
/** Where the walk starts/ends (round-trip detection threshold). */
export const START_LINE_Z = DECK_NEAR_Z - 0.15;

/** Lesson copy — single source for HUD + landing. The fields shared with the
 * Beginner training mode are sourced from MODES[0] so editing the mode can't
 * desync them (the recorder/HUD already read the ACTIVE mode); the rest is
 * lesson-only chrome. */
const BEGINNER = MODES[0];
export const LESSON = {
  number: BEGINNER.number,
  title: BEGINNER.label,
  durationLabel: `${BEGINNER.walkSeconds} SECONDS`,
  /** Default trainee identity (overridden by UserPrefs at runtime). */
  traineeName: "TRAINEE",
  traineeId: "001",
  location: "AR",
  greeting: BEGINNER.greeting,
  instruction: BEGINNER.instruction,
  quote: '"The runway is yours before your first step."',
  /** Walk length in seconds (TIME box counts down from this). */
  walkSeconds: BEGINNER.walkSeconds,
} as const;
