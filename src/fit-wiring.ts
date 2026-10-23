/**
 * (X)RUNWAY — pure FIT-flow wiring predicates (the hud-state.ts precedent):
 * the caller-side start refusals for the guided FIT capture, extracted so the
 * rule is unit-testable without an engine/DOM harness. FitSessionSystem feeds
 * its live state in; test/fit-wiring.test.ts feeds a truth table.
 *
 * The refusals are CALLER-SIDE by design (spec §4.3): FitCaptureMachine.start
 * itself only rejects junk geometry / a missing trainee id — everything about
 * the SHOW's state (phase, demo auto-pilot, mapping, an already-running fit)
 * is the engine wrapper's business, and the UI surfaces the reason line.
 */

export type FitStartRefusal =
  | "already-running"
  | "not-idle"
  | "demo"
  | "mapping";

export interface FitStartState {
  /** globals.showPhase — the fit flow is idle-only ("walk" means SCORED walk
   * everywhere; a fit must never arm the metrics/recorder machinery). */
  phase: string;
  /** globals.demoActive — the Preview Walk auto-pilot owns the rig. */
  demoActive: boolean;
  /** globals.mapMode — "off" means not mapping; anything else owns the floor. */
  mapMode: string;
  /** A fit flow is already in progress (machine.stage !== null, incl. the
   * terminal hold — re-arm only after the flow clears). */
  flowActive: boolean;
}

/** The refusal reason for a start() attempt, or null = allowed. Most-specific
 * first: an active flow refuses regardless of phase. */
export function fitStartRefusal(s: FitStartState): FitStartRefusal | null {
  if (s.flowActive) return "already-running";
  if (s.phase !== "idle") return "not-idle";
  if (s.demoActive) return "demo";
  if (s.mapMode !== "off") return "mapping";
  return null;
}
