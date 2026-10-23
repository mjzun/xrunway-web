/**
 * (X)RUNWAY — FIT SESSION body baseline: the per-trainee record, its atomic
 * sanitizer, the localStorage persistence, and the ONE scoring-facing surface
 * (`deriveHeadNormalization`) that turns a baseline into the head path's bob
 * hysteresis + posture slope.
 *
 * WHY THIS FILE EXISTS (EDGE-ROADMAP "FIT SESSION", Wave 1): the head path
 * scores every body with two one-size constants — BOB_THRESHOLD 0.004 m and
 * the posture slope 350 (metrics.ts). FIT measures the trainee once (~60 s)
 * and re-derives BOTH from the measurement, so a tall walker's 6 cm drift is
 * judged as the fraction of THEIR frame it actually is. The cross-cutting
 * Wave 1 laws (design brief) are binding here:
 * - BYTE-IDENTITY: with no baseline (or a junk / stale / other-trainee one)
 *   the derived normalization is EXACTLY today's constants — scoring cannot
 *   drift for anyone who never runs FIT.
 * - STAMPING: every normalization carries a stamp ("default.v1" /
 *   "fit.v1-<capturedAt ms>") that walk records persist, so pre-FIT and
 *   post-FIT scores are never trended as one series (adversary A's rule).
 *   The row-side reader (`rowNormalization`) lives in session-grading.ts
 *   beside rowMatchesTrainee — NOT here (adjudication §A: one reader helper).
 *
 * Dependency-free by design (no @iwsdk/core, no DOM; localStorage access is
 * guarded) so the golden-vector generator and vitest import the REAL code —
 * the walk-stats.ts / pose-derive.ts pattern. Nothing here runs per frame:
 * derivation happens ONCE per walk (MetricsSystem.beginWalkTracking locks it
 * beside idealPace), persistence once per FIT save / trainee switch.
 */

// ---------------------------------------------------------------------------
// The normalization surface (what metrics.ts deriveFromHead consumes).
// ---------------------------------------------------------------------------

/** The two head-path scoring constants FIT re-derives, plus the stamp that
 *  says which basis produced them. Locked per RUN by MetricsSystem — a FIT
 *  save or trainee switch mid-walk never re-normalizes a running walk. */
export interface HeadNormalization {
  /** deriveFromHead's vertical-bob zero-crossing hysteresis (m). */
  bobThresholdM: number;
  /** Posture points lost per meter of |head-height deviation| EMA. */
  postureSlopePerM: number;
  /** "default.v1" | "fit.v1-<capturedAt ms>" — persisted onto walk records. */
  stamp: string;
}

/** Stamp value meaning "the factory constants scored this walk". Legacy rows
 *  (persisted before the FIT wave, field absent) deliberately read as this
 *  same token via session-grading's rowNormalization: identical constants
 *  scored both, so they ARE one series. */
export const DEFAULT_NORMALIZATION_STAMP = "default.v1";

/**
 * The shipped head-path bob hysteresis (m) — the exact value of the
 * BOB_THRESHOLD constant at metrics.ts:109 ("Vertical-bob zero-crossing
 * hysteresis (m) — HEAD path"). Named here so the byte-identity pin is a
 * single exported number the tests and the wiring phase both point at.
 */
export const DEFAULT_BOB_THRESHOLD_M = 0.004;

/**
 * The shipped head-path posture slope — the bare 350 in metrics.ts:691
 * (`posture = 96 - heightDevEma * 350`), given a name. Its meaning is derived
 * at POSTURE_SLOPE_NUMERATOR below.
 */
export const DEFAULT_POSTURE_SLOPE = 350;

/**
 * BOB_HYST_RATIO = 0.4 — the hysteresis scaling law (TH = 0.4 * A).
 *
 * The codebase already contains this law twice, tuned by hand per body
 * segment (pose-derive.ts:54-74 documents both amplitudes):
 *   head path: TH = 0.004 m against a damped-head bob amplitude A = 0.010 m
 *                                                          -> TH/A = 0.40
 *   hip  path: TH = 0.008 m against a hip bob amplitude    A = 0.020 m
 *                                                          -> TH/A = 0.40
 * FIT does not invent a ratio, it PROMOTES the shipped one. Why 0.4 is
 * physically right: crossings fire when the deviation from the slow EMA
 * baseline exceeds TH. For a sinusoidal bob of amplitude A the detector needs
 * TH < A to see every stride (miss margin), and TH >> sensor jitter +
 * residual sway to never false-fire (the EMA at rate 1.2 removes sway below
 * ~0.2 Hz; Quest 6DoF jitter is sub-mm). 0.4*A leaves a 2.5x detect margin on
 * top and sits 8x above a 0.5 mm jitter floor at the default amplitude.
 * DEFAULT EQUIVALENCE: A defaults to 0.010 -> TH = 0.4 * 0.010 = 0.004 m —
 * byte-identical to DEFAULT_BOB_THRESHOLD_M.
 */
export const BOB_HYST_RATIO = 0.4;

/**
 * Derived-threshold clamps: TH in [0.002, 0.012] m.
 * FLOOR 0.002 = half today's default: still 4x a sub-mm tracking jitter,
 * protects a legitimately flat glider from a threshold at the noise floor.
 * Note the floor never REPAIRS an accepted baseline: the lowest amplitude
 * sanitize accepts is FIT_BOB_AMP_MIN_M = 0.005, and 0.4 * 0.005 = 0.002
 * exactly — the ratio meets the floor at the acceptance boundary.
 * CAP 0.012 = 0.4 * 0.030: amplitudes above ~3 cm at the HEAD are bounce/jog
 * artifacts, not catwalk gait — and 0.012 is also the image path's own
 * foot-bob threshold (metrics.ts:477), a shipped upper-bound precedent. The
 * cap binds for accepted amplitudes in (0.030, 0.050].
 */
export const BOB_THRESHOLD_FLOOR_M = 0.002;
export const BOB_THRESHOLD_CAP_M = 0.012;

/**
 * DEFAULT_HEAD_HEIGHT_M (H0) = 1.60 m — the DECLARED reference head height at
 * which the shipped posture slope 350 is defined. This is a unit choice for
 * expressing the slope per body, not an independently verified fact about
 * the rig the 350 was tuned on: what pins it is the byte-identity
 * requirement below (560 / 1.60 === 350 exactly, IEEE double).
 */
export const DEFAULT_HEAD_HEIGHT_M = 1.6;

/**
 * POSTURE_SLOPE_NUMERATOR = 560 and slope(H) = 560 / H.
 *
 * Today (metrics.ts:691): posture = 96 - heightDevEma * 350. What does 350
 * MEAN? Express the deviation as a fraction of head height H:
 *   score = 96 - k * (dev / H * 100)   with k = points per 1% of head height.
 * At the declared reference H0 = 1.60 m (DEFAULT_HEAD_HEIGHT_M above):
 *   k = 350 * H0 / 100 = 350 * 1.60 / 100 = 5.6 points per %-height.
 * Sanity from the other direction: the lowest pass bar (75, modes.ts) sits
 * 21 points below the 96 anchor; the shipped curve crosses it at
 * dev = 21/350 = 0.060 m = 3.75% of 1.60 m, and 21 / 3.75% = 5.6 pts/%.
 * FIT-normalized form:
 *   postureSlopePerM(H) = 100 * k / H = 560 / H.
 * DEFAULT EQUIVALENCE: H = 1.60 -> 560/1.60 = 350 exactly (IEEE double) —
 * byte-identical to DEFAULT_POSTURE_SLOPE.
 * Worked examples: H = 1.80 -> 311.1 (a tall walker's 6 cm drift is a smaller
 * fraction of THEIR frame: 100 - 0.06*311.1 = 81.3 vs today's 75.0);
 * H = 1.40 -> 400.0 (a shorter walker is held to the same %-of-frame bar).
 * The pass-bar crossing dev = 21H/560 = 0.0375*H ranges 0.0525-0.075 m over
 * H in [1.4, 2.0] (vs the fixed 0.060 today). Slope bounds are implied by
 * the height acceptance range [1.0, 2.2] m: slope in [254.5, 560] — no
 * separate clamp needed.
 */
export const POSTURE_SLOPE_NUMERATOR = 560;

/** The factory normalization — EXACTLY the two deleted-in-wiring metrics.ts
 *  constants plus the default stamp. Frozen and returned BY REFERENCE from
 *  deriveHeadNormalization so the byte-identity pin is also an identity pin. */
export const DEFAULT_HEAD_NORMALIZATION: HeadNormalization = Object.freeze({
  bobThresholdM: DEFAULT_BOB_THRESHOLD_M,
  postureSlopePerM: DEFAULT_POSTURE_SLOPE,
  stamp: DEFAULT_NORMALIZATION_STAMP,
});

// ---------------------------------------------------------------------------
// The baseline record + its acceptance table (sanitize is ATOMIC).
// ---------------------------------------------------------------------------

/**
 * One FIT capture for one trainee. HONESTY LAW: every field is a HEAD
 * measurement from headset tracking — standHeightM is standing HEAD height
 * (the headset's height above the registered floor), never body height; any
 * user-facing copy must label it "head height". Not a posture or body scan.
 */
export interface BodyBaseline {
  version: 1;
  traineeId: string;
  /** Epoch ms of the capture — also the stamp's identity: re-running FIT
   *  mints a new capturedAt, hence a new stamp, hence a new trend series
   *  (a re-measured body is a new comparison basis). */
  capturedAt: number;
  /** Standing HEAD height (m): mean head y over the certified-still span. */
  standHeightM: number;
  /** Idle-noise floor (m): std of head y over the certified-still span. */
  stillNoiseM: number;
  /** Mean head pitch over the certified-still span; + = head pitch above
   *  horizontal (head orientation, not gaze — asin of the forward ray's y,
   *  head-orient.ts convention). Stored for the M8 neutral fallback chain
   *  and the baseline card; NOT consumed by scoring here. */
  neutralPitchRad: number;
  /** Relaxed-walk natural pace (m/s). STORED ONLY this wave (drill input). */
  paceMps: number;
  /** Relaxed-walk cadence (steps/min); null when fewer than 4 clean step
   *  intervals were seen. STORED ONLY this wave. */
  cadenceSpm: number | null;
  /** Head vertical-bob amplitude (m) from the relaxed walk (A = MAD * pi/2,
   *  see fit-session.ts) — the input to the TH = 0.4*A law. */
  bobAmpM: number;
  /** Capture instrument. Only "headset" exists this wave; the field exists
   *  so the roadmap's optional iPhone-keypoint upgrade can extend it. */
  source: "headset";
}

/**
 * Acceptance ranges — ONE table, applied atomically (ANY failure -> the whole
 * baseline reads as null; no field-level repair — honesty: no partially
 * measured body). Each bound's arithmetic:
 * - standHeightM [1.00, 2.20] m: seated rigs and giants both read as junk;
 *   also bounds the derived slope to [254.5, 560] (see the slope derivation).
 * - stillNoiseM [0, 0.020] m: a "still" span noisier than the certification
 *   gate region is junk (the still gate itself is 0.012 3D RMS; the stored
 *   noise is y-only, kept under a slightly looser 0.020 lid).
 * - neutralPitchRad [-0.7, 0.7] (+-40 deg): outside that the trainee was
 *   inspecting the floor/ceiling, not standing neutral.
 * - paceMps [0.2, 2.0]: below = not a walk, above = jogging.
 * - cadenceSpm null or [50, 160] spm: the 50 floor is DERIVED from the step
 *   detector's own interval window — intervals are gated to STEP_MAX = 1.2 s
 *   (pose-derive.ts:47), so the slowest cadence the detector can report is
 *   60/1.2 = 50 spm; 160 is the human-gait ceiling (above it is running
 *   turnover, not catwalk walking).
 * - bobAmpM [0.005, 0.05] m: below = glide indistinguishable from tracking
 *   noise at head level; above = bounce artifact (see BOB_THRESHOLD_CAP_M).
 */
export const FIT_HEIGHT_MIN_M = 1.0;
export const FIT_HEIGHT_MAX_M = 2.2;
export const FIT_STILL_NOISE_MAX_M = 0.02;
export const FIT_NEUTRAL_PITCH_MAX_RAD = 0.7;
export const FIT_PACE_MIN_MPS = 0.2;
export const FIT_PACE_MAX_MPS = 2.0;
export const FIT_CADENCE_MIN_SPM = 50;
export const FIT_CADENCE_MAX_SPM = 160;
export const FIT_BOB_AMP_MIN_M = 0.005;
export const FIT_BOB_AMP_MAX_M = 0.05;

/** capturedAt may not sit further than this in the future (clock-skew slack
 *  for a record written by another device/tab moments ago). */
export const FIT_CAPTURED_AT_SLACK_MS = 60_000;

function inRange(v: unknown, lo: number, hi: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
}

/**
 * The shared validation core. `nowMs === null` skips the wall-clock
 * future-date check — deriveHeadNormalization uses that form so the scoring
 * lock (and the golden vectors replaying it) is fully deterministic; the
 * persistence boundary always passes a real clock.
 */
function validateBodyBaseline(
  v: unknown,
  nowMs: number | null,
): BodyBaseline | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.version !== 1) return null;
  if (typeof o.traineeId !== "string" || o.traineeId.length === 0) return null;
  const capturedAt = o.capturedAt;
  if (
    typeof capturedAt !== "number" ||
    !Number.isFinite(capturedAt) ||
    capturedAt <= 0 ||
    (nowMs !== null && capturedAt > nowMs + FIT_CAPTURED_AT_SLACK_MS)
  ) {
    return null;
  }
  if (!inRange(o.standHeightM, FIT_HEIGHT_MIN_M, FIT_HEIGHT_MAX_M)) return null;
  if (!inRange(o.stillNoiseM, 0, FIT_STILL_NOISE_MAX_M)) return null;
  if (
    !inRange(
      o.neutralPitchRad,
      -FIT_NEUTRAL_PITCH_MAX_RAD,
      FIT_NEUTRAL_PITCH_MAX_RAD,
    )
  ) {
    return null;
  }
  if (!inRange(o.paceMps, FIT_PACE_MIN_MPS, FIT_PACE_MAX_MPS)) return null;
  const cadence = o.cadenceSpm;
  if (
    cadence !== null &&
    !inRange(cadence, FIT_CADENCE_MIN_SPM, FIT_CADENCE_MAX_SPM)
  ) {
    return null;
  }
  if (!inRange(o.bobAmpM, FIT_BOB_AMP_MIN_M, FIT_BOB_AMP_MAX_M)) return null;
  if (o.source !== "headset") return null;
  // Rebuild fresh (defensive copy — drops unknown extra fields, so a
  // persisted record is exactly the schema, nothing more).
  return {
    version: 1,
    traineeId: o.traineeId,
    capturedAt,
    standHeightM: o.standHeightM,
    stillNoiseM: o.stillNoiseM,
    neutralPitchRad: o.neutralPitchRad,
    paceMps: o.paceMps,
    cadenceSpm: cadence,
    bobAmpM: o.bobAmpM,
    source: "headset",
  };
}

/**
 * Coerce anything (stored JSON, manual edits, an in-flight FIT candidate)
 * into a valid BodyBaseline — or null, ATOMICALLY (the acceptance table
 * above). `nowMs` is injectable for deterministic tests.
 */
export function sanitizeBodyBaseline(
  v: unknown,
  nowMs: number = Date.now(),
): BodyBaseline | null {
  return validateBodyBaseline(v, nowMs);
}

// ---------------------------------------------------------------------------
// The derivation (the ONLY consumer-facing math in this module).
// ---------------------------------------------------------------------------

/**
 * Turn a (possibly absent/junk/foreign) baseline into the head path's
 * normalization. Returns DEFAULT_HEAD_NORMALIZATION — the frozen factory
 * object, by reference — when:
 * - `b` is null/undefined or fails ANY acceptance range (atomic), or
 * - a truthy `currentTraineeId` is given and the baseline belongs to someone
 *   else. A FALSY currentTraineeId filters nothing (the single-user-device
 *   law, mirroring session-grading's rowMatchesTrainee).
 * Otherwise:
 *   bobThresholdM   = clamp(0.4 * bobAmpM, 0.002, 0.012)   (BOB_HYST_RATIO)
 *   postureSlopePerM = 560 / standHeightM                  (POSTURE_SLOPE_NUMERATOR)
 *   stamp           = "fit.v1-<capturedAt>"
 * Deterministic by construction (no clock — see validateBodyBaseline).
 */
export function deriveHeadNormalization(
  b: BodyBaseline | null | undefined,
  currentTraineeId: string | null | undefined,
): HeadNormalization {
  const ok = validateBodyBaseline(b ?? null, null);
  if (!ok) return DEFAULT_HEAD_NORMALIZATION;
  if (currentTraineeId && ok.traineeId !== currentTraineeId) {
    return DEFAULT_HEAD_NORMALIZATION;
  }
  let th = BOB_HYST_RATIO * ok.bobAmpM;
  th =
    th < BOB_THRESHOLD_FLOOR_M
      ? BOB_THRESHOLD_FLOOR_M
      : th > BOB_THRESHOLD_CAP_M
        ? BOB_THRESHOLD_CAP_M
        : th;
  return {
    bobThresholdM: th,
    postureSlopePerM: POSTURE_SLOPE_NUMERATOR / ok.standHeightM,
    stamp: `fit.v1-${ok.capturedAt}`,
  };
}

/**
 * The stamp the active baseline WOULD score under —
 * == deriveHeadNormalization(b, traineeId).stamp, exported separately so
 * ShowDirector (deltaVsLast reseed) and the landing trends prefilter can
 * compute the expected stamp without building the whole struct.
 */
export function normalizationStamp(
  b: BodyBaseline | null | undefined,
  traineeId: string | null | undefined,
): string {
  return deriveHeadNormalization(b, traineeId).stamp;
}

// ---------------------------------------------------------------------------
// Persistence — per-trainee under ONE key (the coach-prefs.ts guard pattern).
// ---------------------------------------------------------------------------

/** Binding key (design brief cross-cutting decision). Stored value:
 *  Record<traineeId, BodyBaseline> — per-trainee on a shared device. NOTE:
 *  `globals.fitStatus` belongs to the floor fit-to-room flow (floor-fit.ts);
 *  everything FIT-session-related is namespaced bodyFit... / bodyBaseline. */
export const FIT_STORAGE_KEY = "xrunway.fit.v1";

function readStore(): Record<string, unknown> | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(FIT_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null; // junk / storage unavailable — reads as "no baselines"
  }
}

/** The stored baseline for `traineeId`, fully sanitized — a junk entry, a
 *  junk store, or an entry filed under the wrong id reads as null (defaults,
 *  stamped "default.v1") with no partial states. */
export function loadFitBaseline(traineeId: string): BodyBaseline | null {
  const store = readStore();
  if (!store) return null;
  const b = sanitizeBodyBaseline(store[traineeId]);
  // Tamper guard: the entry must belong to the id it is filed under.
  return b && b.traineeId === traineeId ? b : null;
}

/** ATOMIC save: an unsanitizable candidate is a NO-OP (nothing partial ever
 *  lands). Other trainees' entries in the shared store are preserved; a junk
 *  store is replaced wholesale (it held nothing recoverable).
 *
 *  Returns whether the baseline DURABLY persisted — false from the catch
 *  (storage full / unavailable) and the no-localStorage path, true only
 *  after a read-back verify (the stored entry round-trips with this
 *  capture's timestamp). The caller may keep using the in-memory baseline
 *  either way, but must not tell the trainee a failed persist was saved. */
export function saveFitBaseline(b: BodyBaseline): boolean {
  const clean = sanitizeBodyBaseline(b);
  if (!clean) return false;
  try {
    if (typeof localStorage === "undefined") return false;
    const store = readStore() ?? {};
    store[clean.traineeId] = clean;
    localStorage.setItem(FIT_STORAGE_KEY, JSON.stringify(store));
  } catch {
    return false; // storage full / unavailable — non-fatal
  }
  return loadFitBaseline(clean.traineeId)?.capturedAt === clean.capturedAt;
}

/** Remove one trainee's baseline (the FIT card's own clear affordance —
 *  CLEAR HISTORY deliberately does NOT touch this: the baseline is a body
 *  measurement, not walk history). */
export function clearFitBaseline(traineeId: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    const store = readStore();
    if (!store || !(traineeId in store)) return;
    delete store[traineeId];
    localStorage.setItem(FIT_STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* non-fatal. */
  }
}
