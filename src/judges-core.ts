/**
 * (X)RUNWAY — THE JUDGES' TABLE, the pure pieces (vitest-loadable; the ECS/
 * render side lives in judges-paddles.ts, the table build in stage.ts).
 * Display-only theatrics: the paddles show the summary's OWN numbers.
 */

import type { ShowSummary } from "./show.js";

/** The three shipped metrics, in judge order (left to right at the table). */
export const PADDLE_METRICS: ReadonlyArray<{
  key: "pace" | "carriage" | "line";
  label: string;
}> = [
  { key: "pace", label: "PACE" },
  { key: "carriage", label: "CARRIAGE" },
  { key: "line", label: "LINE" },
];

/** Per-paddle raise stagger (s) — the jury raises left to right. */
export const PADDLE_STAGGER_SEC = 0.18;
/** Raise travel time per paddle (s), eased. */
export const PADDLE_RAISE_SEC = 0.55;

/** The three shown values off a summary — the SAME reads as the walk card /
 * summary rows. Null = the channel never engaged (renders "-"). */
export function paddleValues(
  s: ShowSummary,
): Array<{ label: string; value: number | null }> {
  return [
    { label: "PACE", value: Math.round(s.scores.pace) },
    {
      label: "CARRIAGE",
      value: s.carriage ? Math.round(s.carriage.carriageScore) : null,
    },
    { label: "LINE", value: Math.round(s.scores.footPlacement) },
  ];
}

/** Eased raise progress [0,1] for paddle `i` at `t` seconds past the reveal
 * anchor. Pure (the medalPopScale pattern). */
export function paddleRaise01(t: number, i: number): number {
  const local = (t - i * PADDLE_STAGGER_SEC) / PADDLE_RAISE_SEC;
  const c = local < 0 ? 0 : local > 1 ? 1 : local;
  return c * c * (3 - 2 * c); // smoothstep
}
