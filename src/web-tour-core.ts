/**
 * FIRST-RUN GUIDED ATTENTION — the pure core (no DOM).
 *
 * The founder's brief (docs/NEXT-PROMPT-GUIDED-ATTENTION.md): "there is so
 * much on the screen that first time users do not know where to start or
 * where to look." A short, skippable spotlight sequence on first load dims
 * the landing and lights ONE thing at a time, ending on START.
 *
 * Gating reuses the empty-history law (the in-headset guide's rule): the
 * tour shows only while sessionRecorder.count() === 0 AND the dismissal key
 * is unset. Skipping, finishing, or a mid-sequence walk all stamp the key —
 * the tour never replays once dismissed or once a walk exists.
 *
 * DOM/timing live in web-tour.ts; this module stays vitest-loadable.
 */

/** Dismissal stamp — set on skip/finish/kill, never cleared by the app. */
export const WEB_TOUR_KEY = "xrunway.web-tour.v1";

/** Start no earlier than this after page mount: the landing's one-shot
 * entrance choreography runs 1.7 s (landing.ts stamps body.settled); the
 * tour must run AFTER it, never against it. */
export const TOUR_SETTLE_DELAY_MS = 2050;

/** Give up waiting for a clean idle start after this long — a visitor who
 * is already deep in some flow by then is not "arriving". */
export const TOUR_START_WINDOW_MS = 45000;

/** What a beat points at: a landing element id, or the free "scene" region
 * of the live runway canvas (no element — a fractional viewport rect). */
export type TourTarget = "scene" | "lesson-card" | "begin-walk" | "enter-xr";

export interface TourBeat {
  readonly target: TourTarget;
  /** One line, user-facing — COPY-WORKSHEET F.38 (draft-and-tag law). */
  readonly caption: string;
  /** Auto-advance hold; click-anywhere advances sooner. */
  readonly holdMs: number;
}

/**
 * The sequence (founder brief: 3-5 beats, each ~2-3 s, END ON START, then a
 * quiet pointer onward). The first two captions are the founder's own words
 * from the brief; the last two are drafted (F.38). The run-history chip is
 * hidden at zero walks, so the closing pointer lights ENTER HEADSET.
 */
export const TOUR_BEATS: ReadonlyArray<TourBeat> = [
  { target: "scene", caption: "This is your show.", holdMs: 2800 },
  { target: "lesson-card", caption: "Set your walk.", holdMs: 2800 },
  { target: "begin-walk", caption: "When you're ready - START.", holdMs: 3200 },
  { target: "enter-xr", caption: "Got a headset? Step inside.", holdMs: 2800 },
];

/** The empty-history gate: empty history + no key = show. */
export function shouldShowWebTour(
  walkCount: number,
  dismissed: boolean,
): boolean {
  return walkCount === 0 && !dismissed;
}

/** The "scene" beat's spotlight as viewport fractions (left, top, width,
 * height) — the runway deck renders center-left under the landing chrome. */
export const SCENE_SPOT_FRAC: readonly [number, number, number, number] = [
  0.28, 0.24, 0.35, 0.68,
];
