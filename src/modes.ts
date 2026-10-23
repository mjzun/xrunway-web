/**
 * (X)RUNWAY — Training modes.
 *
 * The four modes from the business model: Beginner Walk, Emerging Runway,
 * Commercial Modeling, and the Performance Challenge. Each tunes the LESSON
 * (copy + pacing), the AI-coach scoring (ideal pace, the per-metric weighting
 * that rolls up the overall score, the pass threshold), and a subtle visual
 * intensity. The active mode lives on `world.globals.activeMode` (a signal);
 * ShowDirector reads its walk length + weights, MetricsSystem reads its ideal
 * pace + pass threshold, and the HUD/landing show its copy.
 */

import type { MetricSnapshot } from "./show.js";

export type ModeId = "beginner" | "highfashion" | "commercial" | "challenge";

export interface TrainingMode {
  id: ModeId;
  /** Lesson number shown in the HUD ("01".."04"). */
  number: string;
  /** Title, e.g. "BEGINNER WALK". */
  label: string;
  /** One-line description for the mode picker. */
  tagline: string;
  greeting: string;
  instruction: string;
  /** Walk length in seconds (the TIME box counts down from this). */
  walkSeconds: number;
  /** Ideal catwalk head speed (m/s) the pace metric scores against. */
  idealPace: number;
  /** Checkbox / pass threshold for this mode. */
  passThreshold: number;
  /** Overall-score weighting — MUST sum to 1. */
  weights: Record<keyof MetricSnapshot, number>;
  /** Visual/energy mood bias 0..1 (drama). Beginner calm, Challenge intense. */
  intensity: number;
}

export const MODES: ReadonlyArray<TrainingMode> = [
  {
    id: "beginner",
    number: "01",
    label: "BEGINNER WALK",
    tagline: "Learn the fundamentals — posture, pace, and a clean line.",
    greeting: "Ready, {name}?",
    instruction:
      "Stand tall, eyes on one far point. Long strides - one foot in front of the other, down the invisible line. Steady to the beat. Hit the mark, hold, then bring it home.",
    walkSeconds: 20,
    idealPace: 0.85,
    passThreshold: 78,
    weights: {
      posture: 0.2,
      pace: 0.15,
      rhythm: 0.15,
      footPlacement: 0.2,
      presence: 0.1,
      confidence: 0.1,
      presentation: 0.1,
    },
    intensity: 0.35,
  },
  {
    // Internal id stays "highfashion" (renaming it would ripple through the
    // modes.json golden id + Swift mirror + data-mode + records); only the shown
    // LABEL becomes EMERGING (founder call 2026-07-08 — ~125 spm industry
    // cadence tier). The tagline/greeting/instruction below still read
    // "high-fashion" and are the founder's to rewrite in the no-AI-text pass.
    id: "highfashion",
    number: "02",
    label: "EMERGING RUNWAY",
    tagline: "Slow, commanding, editorial. Own the room before your first step.",
    greeting: "Own it, {name}.",
    // PACE-RECONCILE Part A (2026-07-11): removed "a faster beat" - EMERGING is
    // scored the SLOWEST target (0.72 m/s), so "faster" contradicted the score.
    // Aligned to the mode's identity (tagline "Slow, commanding, editorial").
    // DRAFTED-BY-CLAUDE, tagged F.25 in COPY-WORKSHEET - VETO/REWRITE.
    instruction:
      "Slow and commanding. Long, controlled strides - never rush it. Head level and still, eyes locked on your point. Make the walk yours. Hit the mark, hold, and let them look.",
    walkSeconds: 20,
    idealPace: 0.72,
    passThreshold: 80,
    weights: {
      posture: 0.2,
      presence: 0.2,
      presentation: 0.2,
      rhythm: 0.15,
      pace: 0.1,
      footPlacement: 0.1,
      confidence: 0.05,
    },
    intensity: 0.85,
  },
  {
    id: "commercial",
    number: "03",
    label: "COMMERCIAL MODELING",
    tagline: "Natural, approachable, relatable. The everyday confident walk.",
    greeting: "Keep it natural, {name}.",
    instruction:
      "Relax into it. An easy, natural pace, soft shoulders, a friendly energy. Approachable beats dramatic here - sell trust, not intimidation.",
    walkSeconds: 20,
    idealPace: 0.95,
    passThreshold: 75,
    weights: {
      confidence: 0.2,
      presentation: 0.2,
      pace: 0.15,
      posture: 0.15,
      presence: 0.1,
      footPlacement: 0.1,
      rhythm: 0.1,
    },
    intensity: 0.55,
  },
  {
    id: "challenge",
    number: "04",
    label: "PERFORMANCE CHALLENGE",
    tagline: "Fast, precise, demanding. Prove every step under pressure.",
    greeting: "Bring it, {name}.",
    instruction:
      "Pick up the pace and hold the line. Crisp footwork, locked rhythm, no wobble. The bar is high - every step is scored. Go.",
    walkSeconds: 20,
    idealPace: 1.05,
    passThreshold: 82,
    weights: {
      pace: 0.2,
      rhythm: 0.2,
      footPlacement: 0.2,
      posture: 0.15,
      presentation: 0.1,
      confidence: 0.1,
      presence: 0.05,
    },
    intensity: 1.0,
  },
];

export const DEFAULT_MODE = MODES[0];

export function getMode(id: ModeId): TrainingMode {
  return MODES.find((m) => m.id === id) ?? DEFAULT_MODE;
}

const MODE_STORAGE_KEY = "xrunway.mode.v1";

/** The persisted mode (survives reloads), or the default if none/unavailable. */
export function loadMode(): TrainingMode {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_MODE;
    const id = localStorage.getItem(MODE_STORAGE_KEY) as ModeId | null;
    return id ? getMode(id) : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

/** Persist the active mode id so the picker selection survives a reload. */
export function saveMode(mode: TrainingMode): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(MODE_STORAGE_KEY, mode.id);
    }
  } catch {
    /* storage full / unavailable — non-fatal. */
  }
}
