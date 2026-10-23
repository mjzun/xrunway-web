import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HOLD_WINDOW_SEC } from "../src/hold-stats.ts";
import {
  HOLD_NOTE_FULL_SEC,
  holdNote,
  holdTurnNotes,
  turnNote,
} from "../src/hold-turn-notes.ts";
import { holdStats } from "./hold-helpers.ts";
import { makeTurnStats } from "./turn-helpers.ts";

// F.27 — the DISPLAY-ONLY hold/turn observation notes. These answer the
// trainee's first two post-walk questions ("did I hold long enough / was my
// turn smooth") from the summary stamps, and are DELIBERATELY separate from
// the golden-pinned holdCue/turnCue rider path (hold-stats.ts / turn-stats.ts,
// runHoldQueries/runTurnQueries in golden-replay.ts). This suite exact-string
// pins every branch (the hold-stats.ts/turn-stats.ts output-pinning precedent),
// ASCII-sweeps them (the panel MSDF font has no em-dash/middle-dot glyph), and
// GUARDS the golden boundary: the module must not be reachable from any golden
// replay runner.

const ASCII = /^[\x20-\x7E]*$/;

describe("holdNote — the hold DWELL note (did I hold long enough)", () => {
  it("returns null when no hold window was measured (gated: no observation, no note)", () => {
    expect(holdNote(null)).toBeNull();
    expect(holdNote(undefined)).toBeNull();
  });

  it("a full-window hold reads the clean full-beat sentence", () => {
    // A clean hold covers the whole window (timeInWindowSec ~ 1.6, the helper
    // default). The note affirms the DWELL only (no stillness claim).
    const n = holdNote(holdStats({ timeInWindowSec: 1.6 }));
    expect(n).toEqual({
      label: "HOLD",
      text: "You held the mark for the full beat - about 1.6 s.",
      good: true,
    });
  });

  it("exactly at HOLD_NOTE_FULL_SEC counts as a full hold (>= boundary)", () => {
    expect(HOLD_NOTE_FULL_SEC).toBe(1.3);
    const n = holdNote(holdStats({ timeInWindowSec: HOLD_NOTE_FULL_SEC }));
    expect(n?.good).toBe(true);
    expect(n?.text).toBe("You held the mark for the full beat - about 1.3 s.");
  });

  it("a short-tracked hold reads the settle-in sentence with its real seconds", () => {
    const n = holdNote(holdStats({ timeInWindowSec: 0.9 }));
    expect(n).toEqual({
      label: "HOLD",
      text: "Your hold read about 0.9 s - give the pose a full, settled beat.",
      good: false,
    });
  });

  it("the full-hold threshold sits a generous 0.3 s under the fixed window", () => {
    // The derivation, pinned: full-beat cutoff = HOLD_WINDOW_SEC - 0.3.
    expect(HOLD_NOTE_FULL_SEC).toBeCloseTo(HOLD_WINDOW_SEC - 0.3, 10);
    expect(holdNote(holdStats({ timeInWindowSec: 1.29 }))?.good).toBe(false);
  });
});

describe("turnNote — the turn SMOOTHNESS note (was my turn smooth)", () => {
  it("returns null when no turn was measured (gated)", () => {
    expect(turnNote(null)).toBeNull();
    expect(turnNote(undefined)).toBeNull();
  });

  it("zero reversals on a fully-seen turn reads the smooth sentence", () => {
    const n = turnNote(makeTurnStats({ reversalCount: 0, entryClipped: false }));
    expect(n).toEqual({
      label: "TURN",
      text: "Smooth turn - one clean motion.",
      good: true,
    });
  });

  it("one reversal reads 'once'", () => {
    const n = turnNote(makeTurnStats({ reversalCount: 1 }));
    expect(n).toEqual({
      label: "TURN",
      text: "Your turn stuttered once - make it one smooth motion.",
      good: false,
    });
  });

  it("multiple reversals read the count", () => {
    expect(turnNote(makeTurnStats({ reversalCount: 3 }))?.text).toBe(
      "Your turn stuttered 3 times - make it one smooth motion.",
    );
  });

  it("a clipped turn with zero seen reversals makes NO claim (start unseen)", () => {
    // The sweep began inside the hold window — we never saw the start, so we
    // cannot vouch for smooth; but a stutter we DID see still reports.
    expect(
      turnNote(makeTurnStats({ reversalCount: 0, entryClipped: true })),
    ).toBeNull();
    expect(
      turnNote(makeTurnStats({ reversalCount: 2, entryClipped: true }))?.text,
    ).toBe("Your turn stuttered 2 times - make it one smooth motion.");
  });
});

describe("holdTurnNotes — surface order + gating", () => {
  it("emits HOLD then TURN, dropping the null ones", () => {
    const both = holdTurnNotes({
      hold: holdStats({ timeInWindowSec: 1.6 }),
      turn: makeTurnStats({ reversalCount: 2 }),
    });
    expect(both.map((n) => n.label)).toEqual(["HOLD", "TURN"]);

    // A U walk (no turn) shows only the hold line.
    expect(
      holdTurnNotes({ hold: holdStats(), turn: null }).map((n) => n.label),
    ).toEqual(["HOLD"]);

    // A dark walk (neither measured) shows nothing.
    expect(holdTurnNotes({ hold: null, turn: null })).toEqual([]);
    expect(holdTurnNotes({})).toEqual([]);
  });

  it("every emitted label + text is non-empty printable ASCII (the panel law)", () => {
    const notes = [
      holdNote(holdStats({ timeInWindowSec: 1.6 })),
      holdNote(holdStats({ timeInWindowSec: 0.7 })),
      turnNote(makeTurnStats({ reversalCount: 0 })),
      turnNote(makeTurnStats({ reversalCount: 1 })),
      turnNote(makeTurnStats({ reversalCount: 4 })),
    ].filter((n): n is NonNullable<typeof n> => n !== null);
    expect(notes.length).toBe(5);
    for (const n of notes) {
      expect(n.label).toMatch(ASCII);
      expect(n.text.trim()).not.toBe("");
      expect(n.text).toMatch(ASCII);
    }
  });
});

describe("golden boundary — the notes are OFF the golden-scored path", () => {
  it("no golden replay runner imports or reaches hold-turn-notes", () => {
    // The founder posture: hold/turn stay out of the scored golden path. This
    // module is a display-only read layer, so it must not be reachable from
    // the shared replay runners (test/golden-replay.ts) that the vector
    // generator AND the --check staleness net both execute. If a future edit
    // wires holdNote/turnNote into a golden family, this guard goes red.
    const replay = readFileSync(
      fileURLToPath(new URL("./golden-replay.ts", import.meta.url)),
      "utf8",
    );
    expect(replay).not.toContain("hold-turn-notes");
    expect(replay).not.toMatch(/\bholdNote\b/);
    expect(replay).not.toMatch(/\bturnNote\b/);
    expect(replay).not.toMatch(/\bholdTurnNotes\b/);
  });

  it("the generator does not import hold-turn-notes", () => {
    const gen = readFileSync(
      fileURLToPath(new URL("../scripts/gen-golden-vectors.mjs", import.meta.url)),
      "utf8",
    );
    expect(gen).not.toContain("hold-turn-notes");
  });
});
