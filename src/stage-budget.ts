// Pure (Three-free) budget math, shared by the stage geometry builders (stage.ts,
// shaders.ts) AND the budget regression tests (test/budget.test.ts). Every helper here
// BOUNDS a stage contributor whose cost would otherwise scale with the runway size, so
// no preset and no slider extreme can re-create a GPU / main-thread overrun on the
// Quest. Keeping the caps here — importable without Three — is what lets the tests
// enforce them. See BUDGET.md for the audit + worst-case table.
import { STAGE } from "./theme.js";

/** Reactive-floor heave grid resolution (cells across × along one deck). The grid is
 *  CAPPED at these counts so a long/wide runway only gets COARSER cells, never more —
 *  the vertex budget stays fixed regardless of physical size (REVIEW-FINDINGS H1). */
export const HEAVE_SEG_X = 48;
export const HEAVE_SEG_Y = 96;
/** Audience contour column spacing + the hard cap (see {@link audienceColumnCount}). */
export const SEAT_STEP = 0.46;
export const AUDIENCE_MAX_COL = 320;
/** Overhead lamp fixtures per runway segment (always rendered, even crowd-hidden). */
export const LAMPS_MAX_PER_SEG = 32;

/** Capped heave-grid size for a footprint of (width × length) metres. Cells keep a
 *  fixed metric size up to one deck, then the COUNT saturates at HEAVE_SEG_X/Y so the
 *  vertex/triangle budget is bounded (≤ ~48×96 cells, ≤9216 tris) at any runway size. */
export function unifiedFloorGridSize(
  width: number,
  length: number,
): { nx: number; nz: number; verts: number; tris: number } {
  const cellW = STAGE.deckWidth / HEAVE_SEG_X;
  const cellL = STAGE.deckLength / HEAVE_SEG_Y;
  const nx = Math.min(HEAVE_SEG_X, Math.max(1, Math.round((width || 1) / cellW)));
  const nz = Math.min(HEAVE_SEG_Y, Math.max(1, Math.round((length || 1) / cellL)));
  return { nx, nz, verts: (nx + 1) * (nz + 1), tris: nx * nz * 2 };
}

/** Capped audience column count for a contour of `perimeter` metres (each column is up
 *  to 3 tiers + a finale seat). Saturates at AUDIENCE_MAX_COL so a huge perimeter just
 *  spaces seats further apart instead of building thousands of figures. */
export function audienceColumnCount(perimeter: number): number {
  return Math.min(AUDIENCE_MAX_COL, Math.max(8, Math.round(perimeter / SEAT_STEP)));
}

/** Capped overhead-lamp count for a runway segment of `length` metres. */
export function lampCount(segLength: number): number {
  return Math.min(LAMPS_MAX_PER_SEG, Math.max(2, Math.round(segLength / 1.9)));
}
