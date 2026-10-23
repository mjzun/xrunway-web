import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BOB_THRESHOLD_CAP_M,
  BOB_THRESHOLD_FLOOR_M,
  DEFAULT_BOB_THRESHOLD_M,
  DEFAULT_HEAD_NORMALIZATION,
  DEFAULT_NORMALIZATION_STAMP,
  DEFAULT_POSTURE_SLOPE,
  FIT_STORAGE_KEY,
  POSTURE_SLOPE_NUMERATOR,
  clearFitBaseline,
  deriveHeadNormalization,
  loadFitBaseline,
  normalizationStamp,
  sanitizeBodyBaseline,
  saveFitBaseline,
} from "../src/body-baseline.ts";
import { baseline } from "./fit-helpers.ts";

const NOW = 1_700_000_100_000; // 100 s after the fixture's capturedAt

describe("head normalization defaults (the byte-identity pins)", () => {
  it("DEFAULT_HEAD_NORMALIZATION IS the deleted metrics.ts constants", () => {
    // These two numbers ARE the constants the wiring phase deletes from
    // metrics.ts (:109 BOB_THRESHOLD, :691 posture slope) — pinned here so
    // a no-baseline world scores byte-identically to today.
    expect(DEFAULT_HEAD_NORMALIZATION).toEqual({
      bobThresholdM: 0.004,
      postureSlopePerM: 350,
      stamp: "default.v1",
    });
    expect(DEFAULT_BOB_THRESHOLD_M).toBe(0.004);
    expect(DEFAULT_POSTURE_SLOPE).toBe(350);
    expect(DEFAULT_NORMALIZATION_STAMP).toBe("default.v1");
  });

  it("the slope law reproduces the default EXACTLY at the reference height", () => {
    // 560 / 1.60 === 350 in IEEE double — the byte-identity requirement that
    // pins H0 = 1.60 as the declared reference (a unit choice, not a fact).
    expect(POSTURE_SLOPE_NUMERATOR / 1.6).toBe(350);
    expect(deriveHeadNormalization(baseline({ standHeightM: 1.6 }), "t1")
      .postureSlopePerM).toBe(350);
  });

  it("null / undefined baseline returns the frozen default BY REFERENCE", () => {
    expect(deriveHeadNormalization(null, "t1")).toBe(DEFAULT_HEAD_NORMALIZATION);
    expect(deriveHeadNormalization(undefined, null)).toBe(
      DEFAULT_HEAD_NORMALIZATION,
    );
    expect(Object.isFrozen(DEFAULT_HEAD_NORMALIZATION)).toBe(true);
  });
});

describe("deriveHeadNormalization", () => {
  it("derives TH = 0.4*A and slope = 560/H from a valid baseline", () => {
    const n = deriveHeadNormalization(baseline(), "t1");
    expect(n.bobThresholdM).toBe(0.004); // 0.4 * 0.010 — the default body round-trips
    expect(n.postureSlopePerM).toBe(350); // 560 / 1.60
    expect(n.stamp).toBe("fit.v1-1700000000000");
  });

  it("promotes the shipped hysteresis law: the hip cross-check A=0.020 -> 0.008", () => {
    // The 0.4 ratio is the SAME law the hip path shipped (TH 0.008 vs
    // A 0.020, pose-derive.ts doc block) — pinned as a cross-check.
    const n = deriveHeadNormalization(baseline({ bobAmpM: 0.02 }), "t1");
    expect(n.bobThresholdM).toBeCloseTo(0.008, 12);
  });

  it("clamp floor: the lowest ACCEPTED amplitude lands exactly on it (A=0.005 -> 0.002)", () => {
    // Adjudication §K: 0.4 * 0.005 = 0.002 = BOB_THRESHOLD_FLOOR_M exactly —
    // the floor meets the ratio at the acceptance boundary, so it never
    // repairs an accepted baseline.
    const n = deriveHeadNormalization(baseline({ bobAmpM: 0.005 }), "t1");
    expect(n.bobThresholdM).toBe(0.002);
    expect(n.bobThresholdM).toBe(BOB_THRESHOLD_FLOOR_M);
  });

  it("clamp cap: A=0.05 -> 0.012 (the image path's shipped bound), not 0.02", () => {
    const n = deriveHeadNormalization(baseline({ bobAmpM: 0.05 }), "t1");
    expect(n.bobThresholdM).toBe(0.012);
    expect(n.bobThresholdM).toBe(BOB_THRESHOLD_CAP_M);
  });

  it("slope table over the acceptance heights", () => {
    const slope = (h: number): number =>
      deriveHeadNormalization(baseline({ standHeightM: h }), "t1")
        .postureSlopePerM;
    expect(slope(1.0)).toBeCloseTo(560, 10);
    expect(slope(1.4)).toBeCloseTo(400, 10);
    expect(slope(1.6)).toBe(350);
    expect(slope(1.8)).toBeCloseTo(311.111111111, 6);
    expect(slope(2.2)).toBeCloseTo(254.545454545, 6);
    // Pass-bar crossing (21 points below the 96 anchor) ranges
    // 0.0525-0.075 m over H in [1.4, 2.0] — vs the fixed 0.060 today.
    expect(21 / slope(1.4)).toBeCloseTo(0.0525, 10);
    expect(21 / slope(2.0)).toBeCloseTo(0.075, 10);
  });

  it("trainee scoping: other-trainee -> defaults; matching -> fit; falsy id -> accepted", () => {
    const b = baseline({ traineeId: "alice" });
    expect(deriveHeadNormalization(b, "bob")).toBe(DEFAULT_HEAD_NORMALIZATION);
    expect(deriveHeadNormalization(b, "alice").stamp).toBe(
      "fit.v1-1700000000000",
    );
    // The single-user-device law (mirrors rowMatchesTrainee's falsy rule).
    expect(deriveHeadNormalization(b, null).stamp).toBe("fit.v1-1700000000000");
    expect(deriveHeadNormalization(b, "").stamp).toBe("fit.v1-1700000000000");
    expect(deriveHeadNormalization(b, undefined).stamp).toBe(
      "fit.v1-1700000000000",
    );
  });

  it("any out-of-range field collapses the WHOLE baseline to defaults (atomic)", () => {
    expect(
      deriveHeadNormalization(baseline({ standHeightM: 0.9 }), "t1"),
    ).toBe(DEFAULT_HEAD_NORMALIZATION);
    expect(
      deriveHeadNormalization(baseline({ standHeightM: 2.3 }), "t1"),
    ).toBe(DEFAULT_HEAD_NORMALIZATION);
    // paceMps etc. valid — atomicity means the good fields do not survive.
    expect(
      deriveHeadNormalization(baseline({ bobAmpM: 0.004 }), "t1"),
    ).toBe(DEFAULT_HEAD_NORMALIZATION);
  });
});

describe("normalizationStamp", () => {
  it("matches deriveHeadNormalization's stamp in every branch", () => {
    expect(normalizationStamp(null, "t1")).toBe("default.v1");
    expect(normalizationStamp(baseline(), "t1")).toBe("fit.v1-1700000000000");
    expect(normalizationStamp(baseline(), "other")).toBe("default.v1");
    expect(
      normalizationStamp(baseline({ paceMps: 99 }), "t1"),
    ).toBe("default.v1");
  });
});

describe("sanitizeBodyBaseline (atomic acceptance)", () => {
  it("passes a valid baseline through, dropping unknown fields", () => {
    const withExtra = { ...baseline(), legacyCruft: 42 };
    expect(sanitizeBodyBaseline(withExtra, NOW)).toEqual(baseline());
  });

  it("accepts the acceptance-range edges", () => {
    const ok = (over: Partial<ReturnType<typeof baseline>>): void => {
      expect(sanitizeBodyBaseline(baseline(over), NOW)).not.toBeNull();
    };
    ok({ standHeightM: 1.0 });
    ok({ standHeightM: 2.2 });
    ok({ stillNoiseM: 0 });
    ok({ stillNoiseM: 0.02 });
    ok({ neutralPitchRad: -0.7 });
    ok({ neutralPitchRad: 0.7 });
    ok({ paceMps: 0.2 });
    ok({ paceMps: 2.0 });
    ok({ cadenceSpm: null });
    ok({ cadenceSpm: 50 }); // §K floor: 60 / STEP_MAX 1.2 = 50
    ok({ cadenceSpm: 160 });
    ok({ bobAmpM: 0.005 });
    ok({ bobAmpM: 0.05 });
  });

  it("rejects wholesale on any single bad field (no field-level repair)", () => {
    const bad = (v: unknown): void => {
      expect(sanitizeBodyBaseline(v, NOW)).toBeNull();
    };
    bad(null);
    bad("junk");
    bad(42);
    bad([]);
    bad({ ...baseline(), version: 2 });
    bad({ ...baseline(), version: "1" });
    bad({ ...baseline(), traineeId: "" });
    bad({ ...baseline(), traineeId: 7 });
    bad({ ...baseline(), capturedAt: 0 });
    bad({ ...baseline(), capturedAt: -5 });
    bad({ ...baseline(), capturedAt: Number.NaN });
    bad({ ...baseline(), capturedAt: Infinity });
    bad(baseline({ standHeightM: 0.99 }));
    bad(baseline({ standHeightM: 2.21 }));
    bad(baseline({ standHeightM: Number.NaN }));
    bad(baseline({ stillNoiseM: -0.001 }));
    bad(baseline({ stillNoiseM: 0.021 }));
    bad(baseline({ neutralPitchRad: 0.71 }));
    bad(baseline({ neutralPitchRad: -0.71 }));
    bad(baseline({ paceMps: 0.19 }));
    bad(baseline({ paceMps: 2.01 }));
    bad(baseline({ cadenceSpm: 49 })); // §K: below the detector's own floor
    bad(baseline({ cadenceSpm: 161 }));
    bad({ ...baseline(), cadenceSpm: "104" });
    bad({ ...baseline(), cadenceSpm: undefined });
    bad(baseline({ bobAmpM: 0.0049 }));
    bad(baseline({ bobAmpM: 0.051 }));
    bad({ ...baseline(), source: "iphone" });
    bad({ ...baseline(), source: undefined });
  });

  it("rejects a future-dated capture beyond the 60 s clock-skew slack", () => {
    expect(
      sanitizeBodyBaseline(baseline({ capturedAt: NOW + 30_000 }), NOW),
    ).not.toBeNull();
    expect(
      sanitizeBodyBaseline(baseline({ capturedAt: NOW + 120_000 }), NOW),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Persistence (node has no localStorage — a stub stands in; the last case
// removes it to pin the guarded no-storage behavior).
// ---------------------------------------------------------------------------

class MemStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

describe("fit baseline persistence", () => {
  const g = globalThis as { localStorage?: unknown };

  beforeEach(() => {
    g.localStorage = new MemStorage();
  });
  afterEach(() => {
    delete g.localStorage;
  });

  const raw = (): string | null =>
    (g.localStorage as MemStorage).getItem(FIT_STORAGE_KEY);

  it("round-trips per trainee under the binding key", () => {
    expect(FIT_STORAGE_KEY).toBe("xrunway.fit.v1");
    saveFitBaseline(baseline());
    expect(loadFitBaseline("t1")).toEqual(baseline());
    expect(loadFitBaseline("nobody")).toBeNull();
    expect(raw()).toContain('"t1"');
  });

  it("two trainees on a shared device do not clobber each other", () => {
    saveFitBaseline(baseline({ traineeId: "alice", standHeightM: 1.75 }));
    saveFitBaseline(baseline({ traineeId: "bob", standHeightM: 1.55 }));
    expect(loadFitBaseline("alice")?.standHeightM).toBe(1.75);
    expect(loadFitBaseline("bob")?.standHeightM).toBe(1.55);
  });

  it("junk store contents read as null (no partial states)", () => {
    const ls = g.localStorage as MemStorage;
    ls.setItem(FIT_STORAGE_KEY, "{not json");
    expect(loadFitBaseline("t1")).toBeNull();
    ls.setItem(FIT_STORAGE_KEY, '"a string"');
    expect(loadFitBaseline("t1")).toBeNull();
    ls.setItem(FIT_STORAGE_KEY, "[1,2]");
    expect(loadFitBaseline("t1")).toBeNull();
  });

  it("a tampered field nulls the whole entry; other entries survive", () => {
    saveFitBaseline(baseline({ traineeId: "alice" }));
    saveFitBaseline(baseline({ traineeId: "bob" }));
    const ls = g.localStorage as MemStorage;
    const store = JSON.parse(ls.getItem(FIT_STORAGE_KEY) as string);
    store.alice.standHeightM = 5; // out of range
    ls.setItem(FIT_STORAGE_KEY, JSON.stringify(store));
    expect(loadFitBaseline("alice")).toBeNull();
    expect(loadFitBaseline("bob")).not.toBeNull();
  });

  it("an entry filed under the wrong id reads as null (tamper guard)", () => {
    const ls = g.localStorage as MemStorage;
    ls.setItem(
      FIT_STORAGE_KEY,
      JSON.stringify({ mallory: baseline({ traineeId: "alice" }) }),
    );
    expect(loadFitBaseline("mallory")).toBeNull();
    expect(loadFitBaseline("alice")).toBeNull(); // not filed under alice either
  });

  it("saving an unsanitizable candidate is a NO-OP (atomic save)", () => {
    saveFitBaseline(baseline());
    saveFitBaseline(baseline({ traineeId: "t1", standHeightM: 0.5 }));
    expect(loadFitBaseline("t1")).toEqual(baseline()); // old record intact
  });

  it("save reports durable persistence honestly (read-back verified)", () => {
    // Success: written AND read back with this capture's timestamp.
    expect(saveFitBaseline(baseline())).toBe(true);
    // Unsanitizable candidate: nothing landed -> false.
    expect(saveFitBaseline(baseline({ standHeightM: 0.5 }))).toBe(false);
    // Storage that throws on write (quota) -> false, non-fatal.
    const ls = g.localStorage as MemStorage;
    (ls as unknown as { setItem(k: string, v: string): void }).setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(saveFitBaseline(baseline({ traineeId: "bob" }))).toBe(false);
  });

  it("clearFitBaseline removes exactly one trainee", () => {
    saveFitBaseline(baseline({ traineeId: "alice" }));
    saveFitBaseline(baseline({ traineeId: "bob" }));
    clearFitBaseline("alice");
    expect(loadFitBaseline("alice")).toBeNull();
    expect(loadFitBaseline("bob")).not.toBeNull();
  });

  it("a junk store is replaced wholesale on save", () => {
    const ls = g.localStorage as MemStorage;
    ls.setItem(FIT_STORAGE_KEY, "{corrupt");
    saveFitBaseline(baseline());
    expect(loadFitBaseline("t1")).toEqual(baseline());
  });

  it("no localStorage at all: load reads null, save/clear are non-fatal", () => {
    delete g.localStorage;
    expect(loadFitBaseline("t1")).toBeNull();
    expect(saveFitBaseline(baseline())).toBe(false); // honest: not persisted
    expect(() => clearFitBaseline("t1")).not.toThrow();
  });
});
