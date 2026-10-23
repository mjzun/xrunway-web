/**
 * (X)RUNWAY - F.27 post-walk HOLD + TURN observation notes.
 *
 * A DISPLAY-ONLY read layer over the M10 hold (hold-stats.ts) + M11 turn
 * (turn-stats.ts) engines: it answers the trainee's first two post-walk
 * questions - "did I hold long enough?" and "was my turn smooth?" - from the
 * SUMMARY stamps both surfaces already carry (summary.hold.timeInWindowSec /
 * summary.turn.reversalCount). Rendered as two quiet observation lines on the
 * XR panel (hud.ts) and the desktop card (landing.ts).
 *
 * DELIBERATELY SEPARATE from holdCue / turnCue (hold-stats.ts / turn-stats.ts):
 * those are golden-pinned (runHoldQueries / runTurnQueries in
 * test/golden-replay.ts) and live on the buildSummaryRiders path the honest
 * 3-metric card drops. Keeping hold/turn OUT of the scored golden path is a
 * founder posture, so this layer never touches them: it is NOT in any golden
 * vector, NOT in the scored coach report (buildCoachReport), and NOT recorded
 * (session-recorder.ts). It computes at render time and feeds two lines only.
 *
 * HONESTY: every quantity is a HEAD-MOTION read - the DWELL seconds inside the
 * fixed hold window and the head-yaw sweep REVERSALS through the turn. Never a
 * scored metric on the card, never a foot pivot, never poise/presence. Gated:
 * a note exists ONLY when there IS a measured observation - a null hold/turn
 * (never marked, one-way route, tracking dark) yields no note (the moment-read
 * disclosures already carry those facts), so a U walk shows one line and a
 * tracking-dark walk shows none.
 *
 * ASCII punctuation only (both surfaces; the XR panel MSDF font has no em-dash
 * or middle-dot glyph). The per-branch outputs are exact-string pinned + ASCII
 * swept in test/hold-turn-notes.test.ts (the hold-stats.ts / turn-stats.ts
 * output-pinning precedent) - NOT a golden family.
 */

import { HOLD_WINDOW_SEC, type HoldStats } from "./hold-stats.js";
import type { TurnStats } from "./turn-stats.js";

/**
 * Dwell (s) at/above which the hold note calls the beat FULLY held. The hold
 * window is HOLD_WINDOW_SEC = 1.6 s and timeInWindowSec is the MEASURED
 * coverage of it: the arming straddle frame carries weight 0 and the closing
 * straddle only a partial sliver, so even a perfectly tracked hold can read a
 * couple tenths under 1.6. 0.3 s of slack (~19% of the beat) is generous
 * headroom - a genuinely settled beat is never called short, while a beat cut
 * by more than that honestly reads as not-yet-a-full-hold. Rounded to kill f64
 * noise (1.6 - 0.3 = 1.3000000000000003) so the >= compare is clean; tracks
 * the window if the founder ever lengthens it.
 */
export const HOLD_NOTE_FULL_SEC = Math.round((HOLD_WINDOW_SEC - 0.3) * 10) / 10;

/**
 * One observational post-walk note. `good` = a clean/positive read (surfaces
 * MAY tint it, but it is never a pass/fail score); `label` names the channel
 * ("HOLD" | "TURN") for the surfaces that prefix it.
 */
export interface HoldTurnNote {
  label: "HOLD" | "TURN";
  text: string;
  good: boolean;
}

/**
 * The summary fields these notes read - STRUCTURAL (ShowSummary satisfies it)
 * so this module never imports the engine-coupled show.ts (the
 * summary-riders.ts precedent). Only the MEASURED stats are consumed; the null
 * REASONS are not - a null read yields no note (the moment-read rows disclose
 * why on their own).
 */
export interface HoldTurnNoteSummary {
  hold?: HoldStats | null;
  turn?: TurnStats | null;
}

/**
 * The HOLD dwell note - "did I hold long enough?". Null (no note) unless a
 * hold window was actually measured (a null hold - never marked / never
 * settled / tracking dark - is disclosed by the moment-read row, not here).
 * The DWELL only: stillness/mark accuracy stay holdCue's business, so this
 * never claims "settled/still" on the full-beat branch.
 */
export function holdNote(
  hold: HoldStats | null | undefined,
): HoldTurnNote | null {
  if (hold == null) return null;
  const secs = hold.timeInWindowSec.toFixed(1);
  if (hold.timeInWindowSec >= HOLD_NOTE_FULL_SEC) {
    return {
      label: "HOLD",
      text: `You held the mark for the full beat - about ${secs} s.`,
      good: true,
    };
  }
  return {
    label: "HOLD",
    text: `Your hold read about ${secs} s - give the pose a full, settled beat.`,
    good: false,
  };
}

/**
 * The TURN smoothness note - "was my turn smooth?". Null (no note) unless a
 * full turn was measured (a null turn - one-way route, no 180, tracking dark -
 * is disclosed by the moment-read row, not here). A clipped turn (the sweep
 * began inside the hold window) can still report a stutter it DID see, but
 * never claims "smooth" - the start was never observed.
 */
export function turnNote(
  turn: TurnStats | null | undefined,
): HoldTurnNote | null {
  if (turn == null) return null;
  if (turn.reversalCount >= 1) {
    const times =
      turn.reversalCount === 1 ? "once" : `${turn.reversalCount} times`;
    return {
      label: "TURN",
      text: `Your turn stuttered ${times} - make it one smooth motion.`,
      good: false,
    };
  }
  if (turn.entryClipped) return null; // start unseen: can't vouch for smooth
  return { label: "TURN", text: "Smooth turn - one clean motion.", good: true };
}

/** Both notes in surface order (HOLD then TURN), skipping the null ones. */
export function holdTurnNotes(s: HoldTurnNoteSummary): HoldTurnNote[] {
  const out: HoldTurnNote[] = [];
  const h = holdNote(s.hold ?? null);
  if (h !== null) out.push(h);
  const t = turnNote(s.turn ?? null);
  if (t !== null) out.push(t);
  return out;
}
