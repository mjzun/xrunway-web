/**
 * (X)RUNWAY — post-walk summary NOTE RIDERS (adjudication §G, generalized
 * ONCE in the M9 wiring).
 *
 * The scored-summary surfaces (hud.ts XR panel, landing.ts DOM card) show up
 * to three coach notes; measurement channels beyond M1-M7 "ride along" after
 * them. This module is the ONE ordered rider list — HOLD > BEAT > TURN (§G
 * build order; M11 appended its rider here and touched no slot loop) — so
 * the two surfaces can never disagree on order or gating:
 * - coach notes keep priority: the surfaces render report.notes first and
 *   hand riders only the remaining room, so on the XR panel's three slots
 *   the LOWEST-precedence rider drops first (list order + slot exhaustion —
 *   no extra arbitration code); the DOM card has no slot cap and appends
 *   every rider (the shipped M10 behavior, kept).
 * - each rider is gated on its summary STAMP (field !== undefined — only a
 *   director-built summary carries it; legacy fixtures produce no riders).
 *   The TURN stamp law differs (turnRowStamped below): the director stamps
 *   turn null AND reason null when NO tracker was installed (metrics-less
 *   world), so the turn gate is the both-null hide law, not !== undefined;
 * - the absent-reason fallbacks make the WEAKER claim: "no-data" for hold
 *   (window unmeasured, not "the walk ended early"), "no-clock" for beat
 *   (an internal condition — beatCue yields no note for it), and
 *   "tracking-dark" for turn (the weakest sensor claim — turnCue yields no
 *   note for it; inert in practice: a stamped turn row always carries its
 *   reason);
 * - a channel whose cue is null (between copy bands / an internal-only null
 *   reason) contributes no rider at all.
 *
 * Pure + dependency-light (the hud-state.ts precedent) so the precedence law
 * is unit-tested without a DOM/Three harness. Event-time only (one summary
 * per walk) — the per-call array allocation is fine. ASCII by construction
 * (hold-stats/beat-stats copy verbatim).
 */

import { beatCue, type BeatNullReason, type BeatStats } from "./beat-stats.js";
import { holdCue, type HoldNullReason, type HoldStats } from "./hold-stats.js";
import { turnCue, type TurnNullReason, type TurnStats } from "./turn-stats.js";

/** One rider: a labeled channel note for a free summary slot. */
export interface SummaryRider {
  /** Slot label, upper-case ASCII ("HOLD" | "BEAT" | later "TURN"). */
  label: string;
  /** The channel's own cue sentence (its module's copy, verbatim). */
  text: string;
}

/** The summary fields the riders read — STRUCTURAL (ShowSummary satisfies
 * it), so this module never imports the engine-coupled show.ts. */
export interface RiderSummary {
  hold?: HoldStats | null;
  holdNullReason?: HoldNullReason | null;
  beat?: BeatStats | null;
  beatNullReason?: BeatNullReason | null;
  turn?: TurnStats | null;
  turnNullReason?: TurnNullReason | null;
}

/** The M11 turn PRESENCE law, shared by the rider below AND both summary
 * surfaces (hud.ts sum-turn / landing.ts #sum-turn — so the two surfaces
 * and the rider can never disagree): the turn row exists only when the
 * ANALYZER ran — a measured read (turn non-null) or a disclosed null
 * (reason non-null). The both-null case is a summary built without a
 * tracker (metrics-less world) or a legacy fixture: nothing ran, nothing
 * to disclose, the row hides. Unlike hold/beat — whose reasons are always
 * stamped beside a director — the director deliberately stamps the turn
 * reason null when globals.turnTrack is absent (show.ts finishWalk). */
export function turnRowStamped(s: RiderSummary): boolean {
  return s.turn != null || (s.turnNullReason ?? null) !== null;
}

/** Build the ordered rider list for one walk's summary (precedence
 * HOLD > BEAT > TURN — §G build order; see the module header for the
 * gating + fallback laws). */
export function buildSummaryRiders(s: RiderSummary): SummaryRider[] {
  const riders: SummaryRider[] = [];
  if (s.hold !== undefined) {
    const cue = holdCue(s.hold, s.holdNullReason ?? "no-data");
    if (cue !== null) {
      riders.push({ label: "HOLD", text: cue });
    }
  }
  if (s.beat !== undefined) {
    const cue = beatCue(s.beat, s.beatNullReason ?? "no-clock");
    if (cue !== null) {
      riders.push({ label: "BEAT", text: cue });
    }
  }
  if (turnRowStamped(s)) {
    const cue = turnCue(s.turn ?? null, s.turnNullReason ?? "tracking-dark");
    if (cue !== null) {
      riders.push({ label: "TURN", text: cue });
    }
  }
  return riders;
}
