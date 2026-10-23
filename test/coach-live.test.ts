import { describe, expect, it } from "vitest";

import {
  COACH_EARCONS,
  CUE_COOLDOWN_SEC,
  FAULT_HOLD_SEC,
  FINAL_GUARD_PROGRESS,
  FINAL_GUARD_SEC,
  LATERAL_CUE_M,
  LIVE_CUE_KINDS,
  LIVE_CUE_TEXT,
  LiveCoachPolicy,
  MAX_PER_KIND,
  PACE_DELTA_CUE_MPS,
  POSTURE_CUE_M,
  SETTLE_SEC,
  SOLO_CUE_GATES,
  SOLO_LATERAL_CUE_M,
  SOLO_POSTURE_CUE_M,
  TURN_SUPPRESS_SEC,
  WEB_CUE_GATES,
  type LiveCue,
} from "../src/coach-live.ts";
import { HOLD_RELEASE_SEC, HOLD_WINDOW_SEC } from "../src/hold-stats.ts";
// sample()/run() + the 2 Hz STEP grid are SHARED with the golden-vector
// generator (test/case-helpers.ts) so the vectors and this suite are provably
// the same truth (SOLO-MODE §6.1).
import { STEP, run, sample } from "./case-helpers.ts";

const EARLIEST = SETTLE_SEC + FAULT_HOLD_SEC; // 7.5 s

describe("live coach policy — clean walks and phase gating", () => {
  it("a clean walk never cues", () => {
    const cues = run(new LiveCoachPolicy(), 90, () => sample());
    expect(cues).toEqual([]);
  });

  it("never cues outside the walk phase, whatever the channels say", () => {
    const cues = run(new LiveCoachPolicy(), 60, () =>
      sample({ walking: false, paceDeltaMps: 2, absLateralM: 1, postureM: 0.3 }),
    );
    expect(cues).toEqual([]);
  });

  it("all-null channels never cue (channel honesty: nothing measured)", () => {
    const cues = run(new LiveCoachPolicy(), 60, () =>
      sample({ paceDeltaMps: null, absLateralM: null, postureM: null }),
    );
    expect(cues).toEqual([]);
  });
});

describe("live coach policy — settle window + hysteresis", () => {
  it("a fault held from t=0 first cues at SETTLE + HOLD (never earlier)", () => {
    const cues = run(new LiveCoachPolicy(), 20, () =>
      sample({ paceDeltaMps: 0.4 }),
    );
    expect(cues.length).toBeGreaterThan(0);
    expect(cues[0].t).toBe(EARLIEST);
    expect(cues[0].cue.kind).toBe("pace-fast");
  });

  it("a fault shorter than the hold never cues", () => {
    // Fast only for 2.0 s (well past settle) — under FAULT_HOLD_SEC.
    const cues = run(new LiveCoachPolicy(), 30, (t) =>
      sample({ paceDeltaMps: t >= 10 && t < 12 ? 0.5 : 0 }),
    );
    expect(cues).toEqual([]);
  });

  it("a clean sample restarts the fault clock", () => {
    // Fast from 6 s on, but one clean sample at 8 s: the clock restarts at
    // 8.5, so the cue lands at 11 — not at 8.5 (6 + HOLD).
    const cues = run(new LiveCoachPolicy(), 20, (t) =>
      sample({ paceDeltaMps: t >= 6 && t !== 8 ? 0.4 : 0 }),
    );
    expect(cues[0].t).toBe(11);
  });

  it("a sign flip restarts the fault clock (fast -> slow)", () => {
    // Fast until 7 s (held since 5 — one sample short of firing), then slow:
    // the slow clock starts at 7 and matures at 9.5 as pace-slow.
    const cues = run(new LiveCoachPolicy(), 20, (t) =>
      sample({ paceDeltaMps: t < 7 ? 0.4 : -0.4 }),
    );
    expect(cues[0]).toMatchObject({ t: 9.5, cue: { kind: "pace-slow" } });
  });

  it("a channel going null clears its fault clock", () => {
    // Lateral fault from 5 s, channel drops at 7 s, returns at 8 s: the
    // clock restarts at 8 and the cue lands at 10.5 — not 7.5.
    const cues = run(new LiveCoachPolicy(), 20, (t) =>
      sample({ absLateralM: t === 7 || t === 7.5 ? null : 0.3 }),
    );
    expect(cues[0]).toMatchObject({ t: 10.5, cue: { kind: "center-up" } });
  });
});

describe("live coach policy — thresholds (metrics.ts-checked bands)", () => {
  it("pace gate is strict: exactly 0.25 m/s off never cues, just above does", () => {
    const at = run(new LiveCoachPolicy(), 30, () =>
      sample({ paceDeltaMps: PACE_DELTA_CUE_MPS }),
    );
    expect(at).toEqual([]);
    const above = run(new LiveCoachPolicy(), 30, () =>
      sample({ paceDeltaMps: PACE_DELTA_CUE_MPS + 0.01 }),
    );
    expect(above[0].cue.kind).toBe("pace-fast");
  });

  it("slow pace cues pace-slow", () => {
    const cues = run(new LiveCoachPolicy(), 30, () =>
      sample({ paceDeltaMps: -0.3 }),
    );
    expect(cues[0].cue.kind).toBe("pace-slow");
  });

  it("lateral gate is strict at 0.20 m", () => {
    const at = run(new LiveCoachPolicy(), 30, () =>
      sample({ absLateralM: LATERAL_CUE_M }),
    );
    expect(at).toEqual([]);
    const above = run(new LiveCoachPolicy(), 30, () =>
      sample({ absLateralM: LATERAL_CUE_M + 0.01 }),
    );
    expect(above[0].cue.kind).toBe("center-up");
  });

  it("posture gate is strict at 0.06 m; sign picks the kind", () => {
    const at = run(new LiveCoachPolicy(), 30, () =>
      sample({ postureM: POSTURE_CUE_M }),
    );
    expect(at).toEqual([]);
    const high = run(new LiveCoachPolicy(), 30, () =>
      sample({ postureM: POSTURE_CUE_M + 0.01 }),
    );
    expect(high[0].cue.kind).toBe("posture-drop"); // riding high -> settle
    const low = run(new LiveCoachPolicy(), 30, () =>
      sample({ postureM: -(POSTURE_CUE_M + 0.01) }),
    );
    expect(low[0].cue.kind).toBe("posture-lift"); // sinking -> lift
  });
});

describe("live coach policy — final guard", () => {
  it("never cues inside the last 4 s of the walk clock", () => {
    const cues = run(new LiveCoachPolicy(), 30, () =>
      sample({ paceDeltaMps: 0.5, walkRemainingSec: FINAL_GUARD_SEC }),
    );
    expect(cues).toEqual([]);
  });

  it("cues right up to the guard boundary", () => {
    const cues = run(new LiveCoachPolicy(), 10, () =>
      sample({ paceDeltaMps: 0.5, walkRemainingSec: FINAL_GUARD_SEC + 0.1 }),
    );
    expect(cues[0].t).toBe(EARLIEST);
  });

  // The guard is route-aware, not clock-only: out-and-back walks END
  // positionally (show.ts FINISH_RADIUS), routinely with 20+ s on the clock —
  // a cue fired on the last sample before the finish edge gets chopped
  // mid-word by the summary flip, on top of the finale payoff.
  it("never cues past FINAL_GUARD_PROGRESS, whatever the clock says", () => {
    const cues = run(new LiveCoachPolicy(), 30, () =>
      sample({
        paceDeltaMps: 0.5,
        walkRemainingSec: 20,
        walkProgress01: FINAL_GUARD_PROGRESS,
      }),
    );
    expect(cues).toEqual([]);
  });

  it("cues right up to the progress boundary", () => {
    const cues = run(new LiveCoachPolicy(), 10, () =>
      sample({
        paceDeltaMps: 0.5,
        walkRemainingSec: 20,
        walkProgress01: FINAL_GUARD_PROGRESS - 0.01,
      }),
    );
    expect(cues[0].t).toBe(EARLIEST);
  });

  it("the return-leg rusher is guarded at the finish approach", () => {
    // A sustained rusher: first cue at 7.5 s. The rush also shortens the
    // walk, so by the cooldown's end the route is nearly finished — the
    // second cue must be swallowed by the positional guard, not fired into
    // the finish line.
    const cues = run(new LiveCoachPolicy(), 30, (t) =>
      sample({
        paceDeltaMps: 0.4,
        absLateralM: 0.3, // a second kind, so the no-repeat rule can't hide the guard
        walkRemainingSec: 40,
        walkProgress01: Math.min(1, t / 17),
      }),
    );
    expect(cues.length).toBe(1);
    expect(cues[0]).toMatchObject({ t: EARLIEST, cue: { kind: "pace-fast" } });
  });
});

describe("live coach policy — turn-back / pose-beat suppression", () => {
  it("out-and-back: faults cannot accumulate during the turn window", () => {
    // Clean until the mark at t=10; a lateral fault starts exactly there
    // (the turn swing). Suppression clears timers until 10 + TURN_SUPPRESS;
    // tracking resumes at 14 and the cue lands at 16.5 — NOT at 14 (which a
    // mute-only window would have allowed by aging the fault through it).
    const MARK = 10;
    const cues = run(new LiveCoachPolicy(), 30, (t) =>
      sample({
        markAtSec: t >= MARK ? MARK : null,
        absLateralM: t >= MARK ? 0.3 : 0,
      }),
    );
    expect(cues[0]).toMatchObject({
      t: MARK + TURN_SUPPRESS_SEC + FAULT_HOLD_SEC,
      cue: { kind: "center-up" },
    });
  });

  it("one-way (U): reaching the mark suppresses for the rest of the walk", () => {
    const MARK = 10;
    const cues = run(new LiveCoachPolicy(), 40, (t) =>
      sample({
        oneWayRoute: true,
        markAtSec: t >= MARK ? MARK : null,
        paceDeltaMps: 0.6,
        absLateralM: 0.4,
      }),
    );
    // Only the pre-mark cue(s) exist; nothing after the mark.
    expect(cues.length).toBeGreaterThan(0);
    for (const c of cues) {
      expect(c.t).toBeLessThan(MARK);
    }
  });

  // M10 §4.6 existing-behavior pin: the live coach is ALREADY structurally
  // silent through the whole hold window + release span — TURN_SUPPRESS_SEC
  // (4 s, timer-CLEARING) covers HOLD_WINDOW_SEC + HOLD_RELEASE_SEC (2.2 s)
  // on out-and-back routes, and one-way routes stay suppressed to the walk's
  // end. The hold wiring therefore changes NOTHING here; this test is the
  // tripwire that would fire if either constant ever shrank past the other.
  it("stays silent through the hold window + release on BOTH route classes (M10 pin)", () => {
    expect(TURN_SUPPRESS_SEC).toBeGreaterThan(
      HOLD_WINDOW_SEC + HOLD_RELEASE_SEC,
    );
    const MARK = 10;
    const holdSpan = HOLD_WINDOW_SEC + HOLD_RELEASE_SEC; // 2.2 s
    for (const oneWay of [false, true]) {
      // Every fault channel blazing from the mark on (the bolted hold).
      const cues = run(new LiveCoachPolicy(), 30, (t) =>
        sample({
          oneWayRoute: oneWay,
          markAtSec: t >= MARK ? MARK : null,
          paceDeltaMps: t >= MARK ? 0.8 : 0,
          absLateralM: t >= MARK ? 0.5 : 0,
          postureM: t >= MARK ? 0.2 : 0,
        }),
      );
      for (const c of cues) {
        // No cue anywhere inside [mark, mark + window + release].
        expect(
          c.t < MARK || c.t > MARK + holdSpan,
          `cue "${c.cue.kind}" at ${c.t}s landed inside the hold span (oneWay=${oneWay})`,
        ).toBe(true);
        // One-way: never after the mark at all.
        if (oneWay) {
          expect(c.t).toBeLessThan(MARK);
        }
      }
    }
  });
});

describe("live coach policy — cadence: cooldown, per-kind cap, no repeats", () => {
  it("enforces >= 9 s between any two cues, with pace > center priority", () => {
    const cues = run(new LiveCoachPolicy(), 25, () =>
      sample({ paceDeltaMps: 0.4, absLateralM: 0.3 }),
    );
    expect(cues[0]).toMatchObject({ t: EARLIEST, cue: { kind: "pace-fast" } });
    expect(cues[1]).toMatchObject({
      t: EARLIEST + CUE_COOLDOWN_SEC,
      cue: { kind: "center-up" },
    });
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i].t - cues[i - 1].t).toBeGreaterThanOrEqual(
        CUE_COOLDOWN_SEC,
      );
    }
  });

  it("full priority order pace > center > posture, then round-robin by the no-repeat rule", () => {
    const cues = run(new LiveCoachPolicy(), 80, () =>
      sample({ paceDeltaMps: 0.4, absLateralM: 0.3, postureM: 0.1 }),
    );
    expect(cues.map((c) => c.cue.kind)).toEqual([
      "pace-fast", // priority 1
      "center-up", // pace blocked back-to-back
      "pace-fast", // eligible again (count 1 -> 2)
      "center-up", // count 2
      "posture-drop", // pace + center capped
      // posture-drop can't repeat back-to-back and everything else is
      // capped -> silence for the rest of the walk.
    ]);
  });

  it("a single persistent fault cues ONCE (same kind never repeats back-to-back)", () => {
    const cues = run(new LiveCoachPolicy(), 90, () =>
      sample({ paceDeltaMps: 0.5 }),
    );
    expect(cues.length).toBe(1);
  });

  it("caps every kind at MAX_PER_KIND per walk", () => {
    const cues = run(new LiveCoachPolicy(), 120, () =>
      sample({ paceDeltaMps: 0.4, absLateralM: 0.3 }),
    );
    const byKind = new Map<string, number>();
    for (const c of cues) {
      byKind.set(c.cue.kind, (byKind.get(c.cue.kind) ?? 0) + 1);
    }
    for (const [, n] of byKind) {
      expect(n).toBeLessThanOrEqual(MAX_PER_KIND);
    }
    expect(cues.length).toBe(4); // 2x pace-fast + 2x center-up, alternating
  });
});

describe("live coach policy — channel honesty", () => {
  it("no pace channel -> the pace fault never cues, lower priorities still do", () => {
    const cues = run(new LiveCoachPolicy(), 30, () =>
      sample({ paceDeltaMps: null, absLateralM: 0.3 }),
    );
    expect(cues[0].cue.kind).toBe("center-up");
    expect(cues.every((c) => !c.cue.kind.startsWith("pace"))).toBe(true);
  });

  it("no lateral channel -> no center cue", () => {
    const cues = run(new LiveCoachPolicy(), 40, () =>
      sample({ absLateralM: null, postureM: -0.1 }),
    );
    expect(cues[0].cue.kind).toBe("posture-lift");
    expect(cues.every((c) => c.cue.kind !== "center-up")).toBe(true);
  });

  it("no posture channel -> no posture cue", () => {
    const cues = run(new LiveCoachPolicy(), 60, () =>
      sample({ postureM: null, paceDeltaMps: 0.4 }),
    );
    expect(
      cues.every((c) => !c.cue.kind.startsWith("posture")),
    ).toBe(true);
  });

  it("center copy never names a side (the lateral sign is route-relative)", () => {
    const lower = LIVE_CUE_TEXT["center-up"].toLowerCase();
    expect(lower).not.toContain("left");
    expect(lower).not.toContain("right");
  });
});

describe("live coach policy — reset / clearFaults lifecycle", () => {
  it("reset() re-arms counters and cooldown for a new walk", () => {
    const policy = new LiveCoachPolicy();
    const first = run(policy, 30, () => sample({ paceDeltaMps: 0.5 }));
    expect(first.length).toBe(1);
    policy.reset();
    const second = run(policy, 30, () => sample({ paceDeltaMps: 0.5 }));
    expect(second[0]).toMatchObject({ t: EARLIEST, cue: { kind: "pace-fast" } });
  });

  it("clearFaults() restarts fault clocks but keeps counters (mid-walk remap)", () => {
    const policy = new LiveCoachPolicy();
    // Age a lateral fault to one sample short of firing, then remap.
    const pre = run(policy, 7, () => sample({ absLateralM: 0.3 }));
    expect(pre).toEqual([]);
    policy.clearFaults();
    // The clock restarts at the next sample (7.5) -> fires at 10, not 7.5.
    const cues: Array<{ t: number; cue: LiveCue }> = [];
    for (let t = 7.5; t <= 15; t += STEP) {
      const cue = policy.decideLiveCue(sample({ absLateralM: 0.3 }), t);
      if (cue) cues.push({ t, cue });
    }
    expect(cues[0].t).toBe(10);
  });

  it("clearFaults() does NOT refund per-kind counts", () => {
    const policy = new LiveCoachPolicy();
    // Exhaust pace-fast (2) by alternating with center-up.
    const cues = run(policy, 120, () =>
      sample({ paceDeltaMps: 0.4, absLateralM: 0.3 }),
    );
    expect(
      cues.filter((c) => c.cue.kind === "pace-fast").length,
    ).toBe(MAX_PER_KIND);
    policy.clearFaults();
    // Keep the pace fault sustained long past every window: capped stays capped.
    for (let t = 121; t <= 200; t += STEP) {
      const cue = policy.decideLiveCue(sample({ paceDeltaMps: 0.4 }), t);
      expect(cue).toBeNull();
    }
  });
});

describe("live coach policy — channel honesty: non-finite values (night-review)", () => {
  it("the sticky-NaN pace repro: NaN from t=5 fires NOTHING (used to speak 'pace-slow' at 7.5)", () => {
    // Reachable end-to-end: a junk pose-frame hip coordinate makes
    // metrics.ts's poseSpeedEma sticky-NaN for the rest of the walk, and the
    // system tap forwarded NaN - idealPace. NaN fails every clean-sample
    // test, so pre-fix it matured through the hold as a fabricated fault.
    const cues = run(new LiveCoachPolicy(), 60, (t) =>
      sample({ paceDeltaMps: t >= 5 ? Number.NaN : 0 }),
    );
    expect(cues).toEqual([]);
  });

  it("NaN routes through the same clear path as null on EVERY channel", () => {
    for (const key of ["paceDeltaMps", "absLateralM", "postureM"] as const) {
      const cues = run(new LiveCoachPolicy(), 60, () =>
        sample({ [key]: Number.NaN }),
      );
      expect(cues, key).toEqual([]);
    }
  });

  it("Infinity is equally unmeasured — no cue", () => {
    const cues = run(new LiveCoachPolicy(), 60, () =>
      sample({
        paceDeltaMps: Number.POSITIVE_INFINITY,
        absLateralM: Number.POSITIVE_INFINITY,
        postureM: Number.NEGATIVE_INFINITY,
      }),
    );
    expect(cues).toEqual([]);
  });

  it("a NaN sample RESTARTS an aging fault clock (clears, never mutes)", () => {
    // Fault from 6 s, one NaN sample at 8 s, fault resumes at 8.5: the clock
    // restarts and the cue lands at 11 — not at 8.5 (6 + HOLD).
    const cues = run(new LiveCoachPolicy(), 20, (t) =>
      sample({ paceDeltaMps: t === 8 ? Number.NaN : t >= 6 ? 0.4 : 0 }),
    );
    expect(cues[0].t).toBe(11);
  });
});

describe("live coach — closed-gate law (night-review: the system clears, never freezes)", () => {
  it("fault clocks cleared while gated: re-enabling mid-walk needs a fresh hold", () => {
    const policy = new LiveCoachPolicy();
    // Lateral fault observed t=6..8 (2 s — under the hold), then COACH VOICE
    // toggles off. CoachLiveSystem's closed gate calls clearFaults() per
    // blocked sample (instead of skipping decide entirely, which froze
    // `since` and let 22 s of UNOBSERVED "hold" fire a cue instantly on
    // re-enable — the line may have been clean the whole time).
    for (let t = 6; t <= 8; t += STEP) {
      expect(policy.decideLiveCue(sample({ absLateralM: 0.3 }), t)).toBeNull();
    }
    for (let t = 8.5; t < 30; t += STEP) {
      policy.clearFaults(); // what the closed gate now does each sample
    }
    // Gate reopens at t=30 with the fault still present: no instant fire —
    // the fresh hold matures at 32.5.
    const cues: Array<{ t: number; cue: LiveCue }> = [];
    for (let t = 30; t <= 40; t += STEP) {
      const cue = policy.decideLiveCue(sample({ absLateralM: 0.3 }), t);
      if (cue) cues.push({ t, cue });
    }
    expect(cues[0]).toMatchObject({ t: 32.5, cue: { kind: "center-up" } });
  });
});

describe("live coach — the mark latch is load-bearing (night-review: remap re-arms posePrev)", () => {
  it("a latched markAt suppresses the turn's pace collapse; a lost latch fabricates 'pace-slow'", () => {
    // The physical turn at the pose mark: pace legitimately collapses. With
    // markAtSec latched, the TURN_SUPPRESS window clears the fault clocks.
    const latched = run(new LiveCoachPolicy(), 18.5, (t) =>
      sample({
        markAtSec: t >= 15 ? 15 : null,
        paceDeltaMps: t >= 15 ? -0.6 : 0,
      }),
    );
    expect(latched).toEqual([]);
    // Lost latch (the un-re-armed posePrev edge after a mid-walk remap —
    // CoachLiveSystem now resets posePrev WITH markAt): the same collapse
    // matures into a spurious cue at 17.5.
    const lost = run(new LiveCoachPolicy(), 18.5, (t) =>
      sample({ markAtSec: null, paceDeltaMps: t >= 15 ? -0.6 : 0 }),
    );
    expect(lost[0]).toMatchObject({ t: 17.5, cue: { kind: "pace-slow" } });
  });
});

describe("live coach policy — cue gate sets (web default / SOLO re-derived)", () => {
  it("the gate sets carry the derived constants, not free copies", () => {
    expect(WEB_CUE_GATES).toEqual({
      paceDeltaMps: PACE_DELTA_CUE_MPS,
      lateralM: LATERAL_CUE_M,
      postureM: POSTURE_CUE_M,
    });
    expect(SOLO_CUE_GATES).toEqual({
      paceDeltaMps: PACE_DELTA_CUE_MPS, // pace carries unchanged
      lateralM: SOLO_LATERAL_CUE_M,
      postureM: SOLO_POSTURE_CUE_M,
    });
  });

  it("a bare construction runs the web gates (every existing site unchanged)", () => {
    // 0.17 m sits between the solo gate (0.15) and the web gate (0.20).
    const web = run(new LiveCoachPolicy(), 30, () =>
      sample({ absLateralM: 0.17 }),
    );
    expect(web).toEqual([]);
  });

  it("solo gates trip the re-derived lateral bar the web gate ignores", () => {
    const solo = run(new LiveCoachPolicy(SOLO_CUE_GATES), 30, () =>
      sample({ absLateralM: 0.17 }),
    );
    expect(solo.length).toBeGreaterThan(0);
    expect(solo[0].cue.kind).toBe("center-up");
    expect(solo[0].t).toBe(EARLIEST);
  });

  it("solo gates stay silent on the posture band the web gate would nag", () => {
    // 0.065 m: above web 0.06, under solo 0.075 — the §3 hip channel rides
    // ~2 cm of gait bob, so the web gate would false-positive on it.
    const web = run(new LiveCoachPolicy(), 60, () =>
      sample({ postureM: 0.065 }),
    );
    expect(web.length).toBeGreaterThan(0);
    const solo = run(new LiveCoachPolicy(SOLO_CUE_GATES), 60, () =>
      sample({ postureM: 0.065 }),
    );
    expect(solo).toEqual([]);
  });

  it("solo gates are strict at their thresholds (<= never trips)", () => {
    const atLat = run(new LiveCoachPolicy(SOLO_CUE_GATES), 30, () =>
      sample({ absLateralM: SOLO_LATERAL_CUE_M }),
    );
    const atPost = run(new LiveCoachPolicy(SOLO_CUE_GATES), 30, () =>
      sample({ postureM: SOLO_POSTURE_CUE_M }),
    );
    expect(atLat).toEqual([]);
    expect(atPost).toEqual([]);
  });
});

describe("live coach cue table — copy + earcons", () => {
  const ASCII = /^[\x20-\x7E]*$/;

  it("every kind has short, non-empty, printable-ASCII spoken copy", () => {
    for (const kind of LIVE_CUE_KINDS) {
      const text = LIVE_CUE_TEXT[kind];
      expect(text.trim().length, kind).toBeGreaterThan(0);
      expect(text, kind).toMatch(ASCII);
      // Mid-stride lines must stay speakable in ~2 s.
      expect(text.length, kind).toBeLessThanOrEqual(60);
    }
  });

  it("every kind has a distinct, valid earcon recipe", () => {
    const seen = new Set<string>();
    for (const kind of LIVE_CUE_KINDS) {
      const e = COACH_EARCONS[kind];
      expect(e.notes[0], kind).toBeGreaterThan(0);
      expect(e.notes[1], kind).toBeGreaterThan(0);
      expect(e.span, kind).toBeGreaterThan(0);
      expect(e.decay, kind).toBeGreaterThan(0);
      seen.add(JSON.stringify(e));
    }
    expect(seen.size).toBe(LIVE_CUE_KINDS.length); // learnable = distinct
  });

  it("earcon contours mirror the correction (fast falls, slow rises)", () => {
    expect(COACH_EARCONS["pace-fast"].notes[0]).toBeGreaterThan(
      COACH_EARCONS["pace-fast"].notes[1],
    );
    expect(COACH_EARCONS["pace-slow"].notes[0]).toBeLessThan(
      COACH_EARCONS["pace-slow"].notes[1],
    );
    expect(COACH_EARCONS["posture-drop"].notes[0]).toBeGreaterThan(
      COACH_EARCONS["posture-drop"].notes[1],
    );
    expect(COACH_EARCONS["posture-lift"].notes[0]).toBeLessThan(
      COACH_EARCONS["posture-lift"].notes[1],
    );
  });
});
