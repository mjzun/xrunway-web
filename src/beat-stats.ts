/**
 * (X)RUNWAY — M9 BEAT LOCK: entrainment of detected footstrikes to the
 * DELIVERED beat reference (EDGE-ROADMAP Wave 2; spec wave2-spec-m9.md;
 * adjudication §D/§F/§H/§I binding).
 *
 * THE ONE beat implementation: pure accumulator + subdivision chooser +
 * vector-strength estimator + score map + reference-gate bookkeeping + copy
 * builders. The engine (MetricsSystem choke point, BeatHapticsSystem pulse
 * train, ShowDirector stamp) only WIRES this module — the walk-stats.ts /
 * hold-stats.ts pattern. Dependency-free (imports only other pure modules:
 * show-timing.ts, pose-derive.ts, walk-stats.ts constants), no @iwsdk/core,
 * no DOM, no AudioContext — the wiring hands in plain numbers.
 *
 * CLOCK LAW (brief law 6 — two clocks, never assumed identical): strikes are
 * detected on the ECS walk clock; the grid lives on the AudioContext clock,
 * anchored by `globals.goAudioTime` (music.ts armDropAtGo — a bar boundary by
 * construction, so phase 0 is the audible kick on either grid). The bridge is
 * CO-SAMPLING: the wiring reads ctx.currentTime IN the strike's detection
 * frame and stamps `tSinceGoSec = audioNow - go` directly — no affine
 * conversion, no extrapolation, so accumulated rAF-vs-audio skew (O(0.01-
 * 0.1%), up to ~0.12 beats over a 60 s walk if extrapolated) can never reach
 * a phase. This module owns the VALIDATION half of the bridge
 * ({@link goAudioTimeFresh}); the co-sampling itself is wiring.
 *
 * HONESTY CONTRACT (the product laws this module encodes):
 * - The channel measures entrainment to a DELIVERED reference: a strike
 *   counts only if, on its detection frame, music was audible or the walk
 *   pulse was actually firing (haptic, or the disclosed earcon fallback).
 *   Scoring entrainment to an inaudible grid would be a fabricated claim.
 *   Music muted MID-walk TRUNCATES (counting stops; un-mute resumes on the
 *   SAME absolute grid — the grid never moved), never voids honest strikes,
 *   never degrades into counting the inaudible. `refSec` < walk duration
 *   discloses the truncation (the timeInWindowSec pattern, hold-stats.ts).
 * - The primary number is VECTOR STRENGTH (phase consistency), which is
 *   invariant to constant timing offsets — because a "strike" is the head-bob
 *   up-crossing of its EMA baseline and trails the physical heel strike by a
 *   roughly constant ~0.12-0.2 s (plus co-sample quantization and audio
 *   output latency). `meanPhaseBeats` is recorded but is detector phase
 *   INCLUDING that lag: DIRECTIONAL bookkeeping only, never absolute timing,
 *   never converted to ms anywhere.
 * - FIT-LAG CALIBRATION — assessed and DROPPED (the BEAT DRILL idea of
 *   calibrating the lag out during FIT): (1) the FIT walk has no beat
 *   reference (idle-only, no armed goAudioTime) — nothing to measure against,
 *   and adding one changes the golden-locked FIT protocol (founder call);
 *   (2) even with one, separating detector lag from the trainee's true
 *   offset requires ASSUMING the trainee strikes on the beat — laundering a
 *   skill assumption into a per-body constant, the exact fabrication class
 *   the honesty law bans; (3) the drift-based direction copy (§ the
 *   BEAT_DRIFT_MIN_SPM block) delivers the trainable directional claim
 *   lag-immune, without any calibration.
 * - SOURCE HANDOFFS void the strike-phase state ({@link
 *   BeatAccumulator.voidStrikes}, the resetCadence seam): head-bob and
 *   camera-hip crossings carry DIFFERENT constant lags, so phases across a
 *   handoff are not comparable — the surviving homogeneous span scores (the
 *   resetLateral "last window wins" law) and `strikeSource` stamps it.
 * - ROUTE-BLIND: the beat grid has no geometry — U vs out-and-back needs no
 *   suppression (unlike M8 yaw); a mid-turn strike against the grid is still
 *   an honest strike, and a mid-walk runway remap is a no-op here.
 * - WALK-END ORDERING (adjudication §D): ShowDirector (priority 0) finalizes
 *   BEFORE MetricsSystem (priority 12) runs the finishing frame's choke
 *   point, so the final frame's strike — and its addRefTime slice — is NOT
 *   in the stamped summary: at most 1 strike is lost at walk end, matching
 *   the existing walk-stats behavior (no protocol change, no one-frame
 *   latch). finalize() is non-destructive and re-callable, so the exclusion
 *   is pinned by tape (feed-all-but-last -> finalize -> feed last).
 * - MID-WALK DELIVERY-DISARM ORDERING (the symmetric §D artifact): the same
 *   priority split means MetricsSystem reads globals.beatDelivery.walk one
 *   frame stale, so on a mid-walk haptic-DISARM edge (pref off / suspended
 *   ctx) the choke point can credit one final strike + one addRefTime slice
 *   against the just-departed reference. Bounded to <= 1 frame, accepted
 *   under the same no-one-frame-latch policy as the walk-end exclusion; both
 *   priority-boundary effects live here so neither is a surprise.
 *
 * Zero per-frame allocation: addStrike()/addRefTime() are scalar math on
 * plain number/boolean fields; the only allocations are the BeatStats object
 * (and its reference label) finalize() builds per call, at walk end.
 * Number.isFinite gates at every boundary (law 6): non-finite stamps and
 * deltas contribute nothing. ASCII-only copy (the panel sweep).
 */

import { clampScore, SCORE_MAX, SCORE_MIN, STEP_MAX, STEP_MIN } from "./pose-derive.js";
import { beatSecOf, COUNTDOWN_SEC } from "./show-timing.js";
import { STEP_DEBOUNCE_SEC } from "./walk-stats.js";

const TWO_PI = 2 * Math.PI;

// Rounding helpers normalize -0 to +0: a signed zero carries no measured
// information and JSON.stringify(-0) = "0" would round-trip differently
// through the golden vectors than the live computation.
function round1(v: number): number {
  const r = Math.round(v * 10) / 10;
  return r === 0 ? 0 : r;
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}

function round3(v: number): number {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
}

// ---------------------------------------------------------------------------
// Constants (every value shows its derivation — the SOLO_POSTURE_SLOPE rule).
// ---------------------------------------------------------------------------

/**
 * Plausible human step-rate window (spm) for candidate scoring grids: 45 is
 * a very slow deliberate walk (~0.75 steps/s), 160 is past every measured
 * catwalk cadence (~122–130 spm, docs/RESEARCH-runway-pace-bpm.md) and into
 * a jog. Grids outside it cannot be a walker's step grid, so the candidate
 * picker never offers them.
 */
export const BEAT_GRID_SPM_MIN = 45;
export const BEAT_GRID_SPM_MAX = 160;

/** The per-tempo pair of candidate scoring grids + their ratio-fair
 *  boundary ({@link beatGridCandidates}). */
export interface BeatGridCandidates {
  /** Faster candidate grid rate (strikes/min). */
  fastSpm: number;
  /** The faster candidate's subdivision name. */
  fastSub: BeatSubdivision;
  /** Slower candidate grid rate — always exactly fastSpm / 2. */
  slowSpm: number;
  /** The slower candidate's subdivision name. */
  slowSub: BeatSubdivision;
  /** Chooser boundary (spm) — the GEOMETRIC mean of the two grids, not the
   * arithmetic: tempo error is ratio-scaled, and at the geometric boundary
   * both grids are off by the same factor sqrt(2). A boundary walker is
   * honestly unlocked on EITHER grid (each strike advances phase by ~0.3+
   * beats — R ~= chance), so the choice there is score-immaterial; it must
   * only be DETERMINISTIC and STABLE, which is the dead zone's job. */
  boundarySpm: number;
}

/**
 * Candidate step grids at a delivered tempo: the beat itself and its
 * neighbor an octave away — "half-beat" = two steps per beat (2 * bpm),
 * "beat" = one per beat (bpm), "2-beat" = one per two beats (bpm / 2).
 * Exactly TWO adjacent candidates survive the plausible window at every
 * deliverable tempo, and the surviving pair is always 2:1 (the accumulator's
 * halved-angle fold relies on that):
 *
 *   62  -> {124 half-beat, 62 beat}   (the founder's half-time option: music
 *          at half the emerging step rate — the walker strides the half-beat)
 *   100 -> {100 beat, 50 2-beat}
 *   125 -> {125 beat, 62.5 2-beat}
 *   122 -> {122 beat, 61 2-beat}     (the legacy engine tempo — golden tapes)
 *
 * The window is calibrated for this set; tempos in (80, 90) would push the
 * slow candidate under the window floor and are not deliverable.
 */
export function beatGridCandidates(bpm: number): BeatGridCandidates {
  const useHalfBeat = bpm * 2 <= BEAT_GRID_SPM_MAX;
  const fastSpm = useHalfBeat ? bpm * 2 : bpm;
  const slowSpm = fastSpm / 2;
  return {
    fastSpm,
    fastSub: useHalfBeat ? "half-beat" : "beat",
    slowSpm,
    slowSub: useHalfBeat ? "beat" : "2-beat",
    boundarySpm: slowSpm * Math.SQRT2, // = sqrt(fastSpm * slowSpm)
  };
}

/**
 * Chooser dead zone (+- spm around the boundary — cross-walk hysteresis).
 * Within-trainee natural cadence varies ~+-3 spm walk to walk; 4 covers it,
 * so a boundary-straddling trainee gets ONE grid across a session instead of
 * a per-walk coin flip that would shred trend comparability (the M12
 * same-condition hygiene). Inside the zone the FIT natural cadence
 * (BodyBaseline.cadenceSpm — stored-only until now; this chooser is its
 * first consumer) breaks the tie by ITS side of the exact boundary; FIT
 * absent/null or itself inside the zone -> the walk cadence's side decides
 * (deterministic either way). The stamped `subdivision` on every row makes
 * any residual cross-walk flip VISIBLE, never silently mixed.
 */
export const BEAT_SUBDIV_DEADZONE_SPM = 4;

/**
 * Minimum counted strikes before the channel reports (the variance floor the
 * Rayleigh bias correction cannot supply — see the vectorR derivation at
 * finalize()). The Rayleigh false-positive law P(n*R_raw^2 > z | uniform)
 * ~= e^-z means a chance walk shows n*R_raw^2 >= 4.6 only ~1% of the time
 * regardless of n, but the SPREAD of the corrected estimator at chance is
 * ~n^-1/2: at n = 10 the 1%-tail vectorR is sqrt((4.6 - 1) / 9) ~= 0.63; at
 * n = 5 it is 0.95 — a chance walk could print a near-perfect lock. 10
 * strikes fits the walk at every deliverable tempo: a walker actually near
 * a candidate grid (45–160 spm window) lands 10 strikes in ~4–13 s — inside
 * the 20 s walk (modes.ts) with the reference gate eating part of it. Below
 * the floor: finalize() = null, reason "too-few-strikes".
 */
export const BEAT_MIN_STRIKES = 10;

/**
 * Direction-copy Rayleigh gate on n * vectorRRaw^2 (the row's rayleighNR2):
 * the Rayleigh test p ~= e^(-n R^2), so requiring n*R^2 >= ln(100) = 4.605
 * caps the false-direction rate at p ~= 1% — claiming a relationship TO the
 * beat requires demonstrated above-chance entrainment. The floor self-scales
 * with n (n = 10 -> R_raw >= 0.68; n = 50 -> 0.30). Consumed by beatCue()
 * against the ROW's stat (what the row discloses is what the copy claims).
 */
export const BEAT_RAYLEIGH_DIRECTION_MIN = Math.log(100); // 4.605...

/**
 * Direction-copy drift floor (spm) on |cadenceSpm - gridSpm| — noise
 * arithmetic: per-interval gait SD ~0.04 s, so SE(cadence) = 60 * SD /
 * (sqrt(n) * T^2) ~= 60 * 0.04 / (sqrt(10) * 0.98^2) ~= 0.8 spm at the
 * n = 10 floor on a ~60 spm grid; 2 spm = 2.5 SE, and it is also the smallest
 * difference that reads as distinct next to the integer grid numbers in the
 * copy. Sanity note: a very high R mathematically bounds |drift| near 0
 * (phase cannot both drift and stay concentrated), so direction copy
 * naturally fires in the mid-R band where drift IS the walk's story.
 * DRIFT is the lag-immune directional read: a constant detector offset
 * shifts every phase equally, so the phase SLOPE — the tempo residual —
 * survives where the absolute mean phase cannot honestly be cited.
 */
export const BEAT_DRIFT_MIN_SPM = 2;

/**
 * Minimum gated inter-strike intervals before a cadence is reported to the
 * chooser (else null): the FIT cadence law verbatim (body-baseline.ts —
 * cadenceSpm null when fewer than 4 clean step intervals were seen). Under
 * 4 intervals a mean interval is a coin flip.
 */
export const BEAT_CADENCE_MIN_INTERVALS = 4;

/**
 * Strike de-dupe window (s) — a PINNED ALIAS of the stats layer's own
 * debounce (STEP_DEBOUNCE_SEC, walk-stats.ts: crossings closer than this are
 * the same physical strike re-firing). The accumulator de-dupes any crossing
 * re-fire the WalkStatsAccumulator also debounces, so the two streams stay
 * step-for-step. The alias is pinned by test (the POSE_HOLD_SEC precedent).
 */
export const BEAT_STRIKE_DEBOUNCE_SEC = STEP_DEBOUNCE_SEC; // 0.15

/**
 * goAudioTime freshness window, BEHIND side (s): valid iff
 * now - BEAT_GO_STALE_BEFORE_SEC <= go <= now + BEAT_GO_FRESH_AFTER_SEC at
 * the walk-start frame. The countdown->walk flip fires on the first frame
 * with phaseElapsed >= COUNTDOWN_SEC (show.ts), so `go` sits BEHIND `now` by
 * at most: one frame of flip overshoot (~14 ms at 72 Hz) + ECS-vs-audio
 * accumulation over the 3 s countdown (<= ~10 ms at 0.3% worst-case skew)
 * + a dropped-frame burst allowance. 0.25 covers all three with margin; a
 * go older than that is a PREVIOUS run's stale anchor (the sfx.ts
 * scheduleCountdown freshness guard is the shipped precedent — different
 * window, same threat).
 */
export const BEAT_GO_STALE_BEFORE_SEC = 0.25;

/**
 * goAudioTime freshness window, AHEAD side (s): once the walk phase flipped,
 * `go` cannot legitimately be in the future — 0.05 is float/quantization
 * slop only (render-quantum quantization of currentTime is 128/48000 =
 * 2.7 ms; the rest is margin).
 */
export const BEAT_GO_FRESH_AFTER_SEC = 0.05;

/**
 * "Locked" copy band on vectorR: 0.72 ~= the highest mode bar's crossing —
 * the challenge pass bar 82 (modes.ts) maps back through the score line to
 * vectorR = (82 - 40) / 58 = 0.724. Von Mises circular SD at R = 0.72:
 * sigma = sqrt(-2 ln 0.72) = 0.810 rad = 0.129 beats = ~63 ms on the beat
 * grid — tight but human. At or above it the walk has earned the word
 * "locked" in the coach note.
 */
export const BEAT_LOCK_GOOD_R = 0.72;

/**
 * "Wandered" copy band on vectorR: 0.45 maps to score 40 + 60 * 0.45 = 67.0
 * — under every mode's pass bar (75/78/80/82, modes.ts). Circular SD at
 * R = 0.45: sigma = sqrt(-2 ln 0.45) = 1.264 rad = 0.201 beats — a
 * quarter-beat smear: the strikes have no usable relationship to the grid.
 * Between the bands the copy makes no claim (the holdCue law).
 */
export const BEAT_LOCK_FAULT_R = 0.45;

// ---------------------------------------------------------------------------
// Delivery constants + pure pulse-train arithmetic. PARKED HERE, pure, so the
// next-phase BeatHapticsSystem (src/beat-haptics.ts) stays wiring-only and
// the scheduling law is golden-testable (the markTurnFlags precedent —
// pin the wiring seam pure where possible). Nothing below is consumed by the
// scoring path; the reference gate consumes only the DELIVERY FACT the
// system publishes (globals.beatDelivery), never these numbers.
// ---------------------------------------------------------------------------

/**
 * Haptic fire lead (s): pulse() executes IMMEDIATELY on call (WebXR exposes
 * no schedule-ahead haptic API), so an audio-clock-accurate pulse can only
 * come from firing near the tick — per frame, one currentTime read + one
 * compare (nextT - now <= lead -> fire). 0.012 = half a 72 Hz frame
 * (6.9 ms, the mean early-poll error) + ~5 ms ASSUMED LRA onset latency
 * (typical ~170 Hz LRA drive electronics; NOT measurable from JS — stated
 * honestly, ON-DEVICE TUNABLE). Worst-case placement error ~+-20 ms = 4% of
 * the 492 ms beat — imperceptible as displacement, perceived as a steady
 * grid.
 */
export const BEAT_PULSE_LEAD_SEC = 0.012;

/**
 * Haptic pulse length (s): >= ~3 rise cycles of a ~170 Hz LRA (~18 ms) so
 * the tap reaches felt amplitude, and 0.045 / 0.48 = 9% duty even at the
 * fastest deliverable beat (125 BPM) — a discrete tap train, not a buzz.
 */
export const BEAT_PULSE_SEC = 0.045;

/**
 * Haptic pulse intensity (0..1): reads through a moving grip with startle
 * headroom below max. Countdown and walk use the SAME params — the percept
 * being trained must not change at GO.
 */
export const BEAT_PULSE_INTENSITY = 0.8;

/**
 * Earcon schedule-ahead lead (s): the earcon CAN be sample-accurate — nodes
 * are scheduled AT the grid time — so its lead only needs to beat the
 * scheduler-tick class (~25 ms, music.ts); 0.05 = 2x margin.
 */
export const BEAT_EARCON_LEAD_SEC = 0.05;

/**
 * Earcon tick pitch (Hz): 1976 ~= B6 (1975.53). A MAJOR SIXTH above the
 * countdown tick's D6 voice (SFX_VOICES.tick.freq = 1174.66, sfx-timeline.ts;
 * ratio 1976 / 1174.66 = 1.682 ~= 5/3) — far enough that the two reads never
 * blur, consonant enough to sit inside the house bed. (Adjudication §H:
 * the frequency was always right; the interval label is corrected here —
 * B6/D6 is a sixth, not a fifth.)
 */
export const BEAT_EARCON_HZ = 1976;

/** Earcon envelope: linear attack to level (s) — a click-free onset that
 *  still reads as a tick. */
export const BEAT_EARCON_ATTACK_SEC = 0.003;

/** Earcon envelope: exponential decay (s) — shorter than the countdown
 *  tick's 0.08 (sfx-timeline.ts) so a walk full of them stays a texture,
 *  not a melody. */
export const BEAT_EARCON_DECAY_SEC = 0.06;

/**
 * Earcon base level (0..1) BEFORE the music-prefs volume scale
 * (level = BEAT_EARCON_LEVEL * (enabled ? volume : 0) — MUTE MEANS SILENCE:
 * a muted earcon is NOT a delivered reference and the gate closes). 0.12
 * sits under the countdown tick's own event level so the beat never
 * out-shouts the show's structural cues.
 */
export const BEAT_EARCON_LEVEL = 0.12;

/**
 * Countdown flam suppression window (s) AFTER a countdown tick (adjudication
 * §H): two percussive onsets within ~60 ms fuse into a "flam" — a doubled,
 * smeared hit — so a haptic pulse landing inside [tick, tick + 0.06) is
 * SKIPPED and the audible countdown tick stays the authoritative clock. The
 * 3 s countdown has exactly 3 second-boundary ticks (countdownTickTimes,
 * show-timing.ts) and the window is shorter than a beat, so AT MOST THREE
 * pulses are ever suppressed per run by construction; GO is a full 1 s from
 * the nearest tick and stays on-grid. Disclosed in BEAT_SETTING_TIP;
 * flagged ON-DEVICE TUNABLE.
 */
export const BEAT_FLAM_SUPPRESS_SEC = 0.06;

/**
 * First pulse-train tick at-or-after `now + lead`, ON the go-anchored beat
 * grid (ticks are goAudioSec + k * beatSec for INTEGER k — k is negative
 * through the countdown, covering the pre-GO beats, and the k = 0 GO tick
 * is inclusive: the pulse ON the drop reinforces it). `beatSec` is the
 * RUN-LATCHED beat period (the delivered tempo's — REQUIRED, so no call
 * site can silently pulse a frozen default tempo). Pure arithmetic for the
 * BeatHapticsSystem arm points (countdown edge; mid-walk enable from the
 * cached anchor).
 */
export function firstPulseTick(
  nowAudioSec: number,
  goAudioSec: number,
  beatSec: number,
  leadSec: number = BEAT_PULSE_LEAD_SEC,
): number {
  return (
    goAudioSec +
    Math.ceil((nowAudioSec + leadSec - goAudioSec) / beatSec) * beatSec
  );
}

/**
 * Advance a just-fired (or missed) tick past `now + lead` WITHOUT firing the
 * skipped ticks — the music.ts visibilitychange re-anchor law applied to the
 * pulse train: a GC hitch longer than a beat must never burst-fire catchup
 * pulses. Always advances at least one beat (the do-while), so the normal
 * fire path lands exactly one beat later. `beatSec` must be the SAME
 * run-latched period the train was seeded with (firstPulseTick), or the
 * grid shears off the music.
 */
export function advancePulseTick(
  nextTickSec: number,
  nowAudioSec: number,
  beatSec: number,
  leadSec: number = BEAT_PULSE_LEAD_SEC,
): number {
  let t = nextTickSec;
  do {
    t += beatSec;
  } while (t <= nowAudioSec + leadSec);
  return t;
}

/**
 * True when a pulse tick lands inside the flam window after one of the
 * countdown's second-boundary ticks (at goAudioSec - d for whole seconds
 * d = 1..COUNTDOWN_SEC — the countdownTickTimes law, show-timing.ts).
 * Non-finite inputs read false (a junk decision suppresses nothing —
 * delivery-side only, never a measurement input).
 */
export function countdownFlamSuppressed(
  pulseSec: number,
  goAudioSec: number,
  countdownSec: number = COUNTDOWN_SEC,
): boolean {
  const digits = Math.ceil(countdownSec);
  for (let d = 1; d <= digits; d++) {
    const afterTick = pulseSec - (goAudioSec - d);
    if (afterTick >= 0 && afterTick < BEAT_FLAM_SUPPRESS_SEC) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Types + the summary contract.
// ---------------------------------------------------------------------------

/** The honest grid the strikes were scored against, relative to the
 *  DELIVERED tempo: "beat" = one strike per beat (bpm spm), "2-beat" =
 *  every 2nd beat (bpm/2), "half-beat" = two strikes per beat (2*bpm — the
 *  half-time tempo's natural step grid). A SCORING construct only —
 *  delivery (music kick, haptic pulse) is always the delivered tempo's
 *  beat grid. */
export type BeatSubdivision = "beat" | "2-beat" | "half-beat";

/** A delivered beat reference kind: audible music, the controller haptic
 *  pulse, or the disclosed hand-tracking earcon tick. */
export type BeatReferenceKind = "music" | "haptic" | "earcon";

/** Why finalize() returned null (the copy branches on it — the
 *  HoldNullReason pattern):
 *  - "no-clock": goAudioTime was absent/stale or the ctx was not running at
 *    walk start — the grid anchor never existed (internal condition).
 *  - "no-reference": no beat reference was EVER delivered this walk
 *    (zero counted strikes AND zero reference seconds).
 *  - "too-few-strikes": a reference was delivered but fewer than
 *    BEAT_MIN_STRIKES strikes landed while it was live (incl. post-void
 *    remnants of a source handoff). */
export type BeatNullReason = "no-clock" | "no-reference" | "too-few-strikes";

/** Which derive path detected the surviving strikes (the walk-stats source
 *  labels). Homogeneous by construction: the wiring voids on every
 *  camera<->head handoff, so mixed-lag phases never share one resultant. */
export type BeatStrikeSource = "head" | "camera-world" | "camera-image";

/** Measured facts of one walk's beat entrainment. Strikes are head-bob (or
 *  camera hip-bob) detections — never claimed as heel-strike ground truth. */
export interface BeatStats {
  /** Counted strikes (reference-gated, post-void). */
  strikes: number;
  /** Rayleigh-bias-corrected vector strength 0..1 on the chosen grid,
   * round3 — THE PRIMARY NUMBER (invariant to constant timing offsets). */
  vectorR: number;
  /** Uncorrected resultant length, round3 — the correction stays visible on
   * every row, never silent. */
  vectorRRaw: number;
  /** Circular mean strike phase in beats of the chosen grid, wrapped
   * [-0.5, 0.5), round3. Negative = before the tick. DETECTOR phase
   * including the roughly constant head-bob + audio-output lag — never
   * cited as absolute timing, never converted to ms. */
  meanPhaseBeats: number;
  /** n * vectorRRaw^2, round2 — the Rayleigh non-uniformity statistic the
   * direction copy gates on (>= ln(100) ~ 4.61, p ~ 1%). */
  rayleighNR2: number;
  /** The chooser's stamp (per-walk; the cross-walk dead zone keeps it
   * stable for a boundary-straddling trainee). */
  subdivision: BeatSubdivision;
  /** The chosen grid's rate (strikes/min) — a candidate of the walk's
   * latched tempo (beatGridCandidates), e.g. 100|50 at 100 BPM, 124|62 at
   * 62, 125|62.5 at 125, 122|61 at the legacy tape tempo. */
  gridSpm: number;
  /** Cadence from gated inter-strike intervals (the chooser's input),
   * round1; null under BEAT_CADENCE_MIN_INTERVALS intervals. */
  cadenceSpm: number | null;
  /** cadenceSpm - gridSpm, round1 (null with cadence). + = drifting ahead
   * of the beat. The lag-immune directional read (phase SLOPE). */
  driftSpm: number | null;
  /** Walk seconds a beat reference was actually delivered, round1. Less
   * than the walk duration = the channel was truncated (disclosed).
   * Survives voidStrikes() — delivery disclosure is walk-wide. */
  refSec: number;
  /** Which delivered reference(s) the counted strikes were entrained to,
   * fixed order music -> haptic -> earcon, "+"-joined (haptic/earcon are
   * mutually exclusive per pulse but can both occur across one walk). */
  reference: string;
  /** Derive path of the surviving strikes — phases are never mixed across
   * paths (the voidStrikes law). */
  strikeSource: BeatStrikeSource;
  /** 40 + 60 * vectorR, round1 (the carriageScoreOf template). Exists for
   * exports and the Wave 4 drill wrapper; feeds NOTHING this wave —
   * folding it into any composite is a RESERVED FOUNDER CALL. */
  beatScore: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (each golden-pinnable on its own).
// ---------------------------------------------------------------------------

/**
 * The goAudioTime VALIDATION half of the clock bridge (run once at walk
 * start by the wiring; the co-sampling is wiring). `go` is `unknown` because
 * globals.goAudioTime is a durable untyped global armed at every countdown
 * edge (music.ts) — a test/direct-to-walk path or a dead ctx can leave it
 * absent, junk, or stale from a PREVIOUS run. Valid iff a finite number
 * inside [now - BEAT_GO_STALE_BEFORE_SEC, now + BEAT_GO_FRESH_AFTER_SEC]
 * (window arithmetic at the two constants). Invalid -> the wiring arms the
 * accumulator with goValid = false -> channel null, reason "no-clock".
 */
export function goAudioTimeFresh(nowAudioSec: number, go: unknown): boolean {
  return (
    typeof go === "number" &&
    Number.isFinite(go) &&
    go >= nowAudioSec - BEAT_GO_STALE_BEFORE_SEC &&
    go <= nowAudioSec + BEAT_GO_FRESH_AFTER_SEC
  );
}

/**
 * Wrap a phase in beats to [-0.5, +0.5): wrap(x) = x - Math.round(x).
 * Negative = the strike landed BEFORE its grid tick, positive = after.
 * Edge law (golden-pinned): Math.round half-up makes wrap(0.5) = 0.5 - 1 =
 * -0.5 EXACTLY, and wrap(-0.5) = -0.5 - (-0) = -0.5 — the +0.5 edge always
 * folds to the negative side, so the interval is half-open by construction.
 */
export function wrapPhaseBeats(x: number): number {
  return x - Math.round(x);
}

/** Which side of a boundary a cadence sits on (>= boundary = the faster
 *  candidate). Module-level so the chooser allocates nothing. */
function subdivSideOf(
  cadenceSpm: number,
  g: BeatGridCandidates,
): BeatSubdivision {
  return cadenceSpm >= g.boundarySpm ? g.fastSub : g.slowSub;
}

/**
 * The subdivision chooser (per-walk, run ONCE in finalize() — both grids
 * accumulate all walk, so mid-walk flapping is impossible by construction;
 * no live consumer needs the subdivision because DELIVERY is always the
 * delivered tempo's beat grid). The candidate pair + boundary come from the
 * walk's LATCHED tempo ({@link beatGridCandidates}). Rule (see
 * BEAT_SUBDIV_DEADZONE_SPM for the hysteresis rationale):
 *
 *   cad == null           -> fit != null ? side(fit) : the SLOW candidate
 *   |cad - B| > DEADZONE  -> side(cad)
 *   else (dead zone)      -> fit decisive (non-null AND itself outside the
 *                            zone) ? side(fit) : side(cad)
 *
 * Both-null fallback = the slower candidate: with no cadence evidence at
 * all, the conservative product-consistent default (the historical "2-beat"
 * choice at the legacy 122 tempo, preserved verbatim by this rule).
 * Non-finite inputs are treated as null (law-6 gate).
 */
export function chooseSubdivision(
  cadenceSpm: number | null,
  fitCadenceSpm: number | null,
  bpm: number,
): BeatSubdivision {
  const g = beatGridCandidates(bpm);
  const cad =
    cadenceSpm !== null && Number.isFinite(cadenceSpm) ? cadenceSpm : null;
  const fit =
    fitCadenceSpm !== null && Number.isFinite(fitCadenceSpm)
      ? fitCadenceSpm
      : null;
  if (cad === null) {
    return fit !== null ? subdivSideOf(fit, g) : g.slowSub;
  }
  if (Math.abs(cad - g.boundarySpm) > BEAT_SUBDIV_DEADZONE_SPM) {
    return subdivSideOf(cad, g);
  }
  if (fit !== null && Math.abs(fit - g.boundarySpm) > BEAT_SUBDIV_DEADZONE_SPM) {
    return subdivSideOf(fit, g);
  }
  return subdivSideOf(cad, g);
}

/**
 * The beat score map — the carriageScoreOf template (head-carriage.ts):
 *
 *   beatScore = SCORE_MIN + (SCORE_MAX - SCORE_MIN) * vectorR = 40 + 60 * R
 *
 * Anchors: vectorR = 1 -> 98 (the cap every clean channel hits,
 * pose-derive.ts); chance -> 40 floor (the corrected estimator centers on 0
 * at chance). Bar crossings (modes.ts pass bars 75..82): the lowest bar 75
 * needs vectorR = 35/58 = 0.603 — circular SD sqrt(-2 ln 0.603) = 1.006 rad
 * = 0.160 beats = ~79 ms on the beat grid: between genuinely locked casual
 * entrainment (~40-90 ms) and loose coupling (100-200 ms), so pass =
 * actually locked, reachable without metronome-grade training. vectorR is
 * [0, 1] by construction (the corrected estimator's max(0, .) floor and
 * R_raw <= 1 cap), so the map needs no clamp; clampScore guards the
 * boundary anyway (the liveScore precedent).
 */
export function beatScoreOf(vectorR: number): number {
  return clampScore(SCORE_MIN + (SCORE_MAX - SCORE_MIN) * vectorR);
}

// ---------------------------------------------------------------------------
// The accumulator.
// ---------------------------------------------------------------------------

/**
 * Per-walk beat accumulator. The wiring resets it at beginWalkTracking (with
 * the validated go verdict + the run-locked FIT cadence peek — plain
 * number-or-null, the adjudication-§C signal law), feeds one addStrike()
 * per detected strike (co-sample-stamped: tSinceGoSec = audioNow - go on the
 * detection frame) and one addRefTime() per active walk frame, calls
 * voidStrikes() on the resetCadence seam, and finalizes at walk end (the
 * director stamps the result — which, by the priority-0-vs-12 ordering,
 * happens BEFORE the finishing frame's choke point: at most one strike +
 * its addRefTime slice is excluded, disclosed in the module header).
 *
 * Both grids accumulate simultaneously (4 running floats c1/s1/c2/s2) — this
 * is what makes the subdivision chooser commit-free: it runs once at
 * finalize() on the walk's own cadence. Phase folding uses the raw angle
 * theta = 2*pi*t/P directly (cos/sin are periodic — no pre-wrap needed;
 * wrapPhaseBeats serves the REPORTED mean phase and the golden edge pins).
 *
 * Zero allocation on the per-sample paths: addStrike()/addRefTime() are
 * plain scalar math; finalize() allocates its one BeatStats per call.
 */
export class BeatAccumulator {
  /** Was goAudioTime valid at walk start (goAudioTimeFresh + running ctx —
   * the wiring's verdict)? False = every phase stamp would be garbage: the
   * channel finalizes null, reason "no-clock". */
  private goValid = false;

  /** Run-locked FIT natural cadence (spm) or null — the chooser's dead-zone
   * tie-breaker (BodyBaseline.cadenceSpm, peeked by the WIRING at walk
   * start; a mid-run FIT rerun cannot move the chooser under the walk). */
  private fitCadenceSpm: number | null = null;

  /** Run-locked delivered tempo (BPM) — the value the wiring latched at walk
   * start (globals.goBpm, published by music at the countdown edge, else the
   * resolved pref). The grid candidates + both fold periods derive from it;
   * it can never move under a walk (the "grid never moved" law). */
  private bpm = NaN;
  /** The latched tempo's candidate pair (computed once at reset). */
  private grids: BeatGridCandidates = beatGridCandidates(100);
  /** The FAST candidate's period (s) — the fold's base angle; the slow
   * candidate's angle is exactly half (the 2:1 candidate law). */
  private fastPeriodSec = NaN;

  /** Cadence-interval ceiling (s), GRID-AWARE and reset-latched: the slow
   * candidate's own period + 0.2 s of ~3-sigma gait-jitter headroom, floored
   * at the ring law's STEP_MAX. At 122/62/125 BPM the slow periods
   * (0.984/0.968/0.96 s) keep the ceiling exactly STEP_MAX (legacy tapes
   * byte-identical); at 100 BPM the 50 spm candidate's period IS STEP_MAX
   * (1.2 s), so a hard STEP_MAX gate would truncate the long half of a
   * locked walker's interval distribution — biasing cadence past the 2 spm
   * direction floor and coaching "ran ahead" at a locked walker. The
   * ceiling still excludes a missed-strike double interval (2.4 s at the
   * 50 grid). */
  private intMaxSec = STEP_MAX;

  // Circular sums for BOTH candidate grids + the counted-strike count.
  private c1 = 0; // fast candidate (P = fastPeriodSec)
  private s1 = 0;
  private c2 = 0; // slow candidate (P = 2 * fastPeriodSec)
  private s2 = 0;
  private n = 0;

  /** Last accepted strike stamp (audio-clock tSinceGo, s) — the debounce +
   * interval-chain anchor. NaN = no anchor (fresh walk or post-void). */
  private lastStrikeT = NaN;

  // Gated inter-strike interval sums (STEP_MIN..intMaxSec — the ring law,
  // pose-derive.ts, with the grid-aware ceiling): the chooser's cadence input.
  private intSum = 0;
  private intN = 0;

  // Reference kinds live at COUNTED strikes (the row's `reference` label).
  private sawMusic = false;
  private sawHaptic = false;
  private sawEarcon = false;

  /** Walk seconds with a live reference (accumulated per frame, walk-wide —
   * SURVIVES voidStrikes(): delivery disclosure is about the walk, not the
   * surviving strike span). */
  private refSecAcc = 0;

  /** Source of the last counted strike — homogeneous over the surviving
   * span by the voidStrikes-on-handoff law, so last-wins is exact. */
  private source: BeatStrikeSource = "head";

  /**
   * Arm for a new walk. `goValid` is the wiring's goAudioTimeFresh + running-
   * ctx verdict at the walk-start frame; `bpm` is the run-latched delivered
   * tempo (globals.goBpm else the resolved pref — the wiring's latch, never
   * re-read mid-walk); `fitCadenceSpm` is the run-locked
   * BodyBaseline.cadenceSpm peek (plain number-or-null — this module never
   * reads a signal). Non-finite fit is treated as null; a non-finite or
   * non-positive bpm invalidates the run like a dead clock (goValid=false →
   * "no-clock": without a tempo the grid never validly existed) — law-6
   * gates both.
   */
  reset(goValid: boolean, bpm: number, fitCadenceSpm: number | null): void {
    const bpmOk = Number.isFinite(bpm) && bpm > 0;
    this.goValid = goValid && bpmOk;
    this.bpm = bpmOk ? bpm : NaN;
    this.grids = beatGridCandidates(bpmOk ? bpm : 100);
    this.fastPeriodSec = 60 / this.grids.fastSpm;
    this.intMaxSec = Math.max(STEP_MAX, 60 / this.grids.slowSpm + 0.2);
    this.fitCadenceSpm =
      fitCadenceSpm !== null && Number.isFinite(fitCadenceSpm)
        ? fitCadenceSpm
        : null;
    this.c1 = 0;
    this.s1 = 0;
    this.c2 = 0;
    this.s2 = 0;
    this.n = 0;
    this.lastStrikeT = NaN;
    this.intSum = 0;
    this.intN = 0;
    this.sawMusic = false;
    this.sawHaptic = false;
    this.sawEarcon = false;
    this.refSecAcc = 0;
    this.source = "head";
  }

  /**
   * One detected strike, co-sample-stamped by the wiring:
   * - `tSinceGoSec` = audioNow - goAudioTime, read IN the detection frame
   *   (the co-sample law — no cross-clock conversion ever happened).
   * - `musicOn` = musicPrefs.enabled && volume > 0 at this frame (peek).
   * - `hapticKind` = globals.beatDelivery.walk — what the walk pulse train
   *   ACTUALLY emitted this beat ("haptic" | "earcon" | null; countdown
   *   pulses never open the gate).
   * - `source` = the derive path that owns this frame (walk-stats labels).
   *
   * Order of gates:
   * 1. finiteness — a non-finite stamp contributes nothing (law 6);
   * 2. debounce — a stamp closer than BEAT_STRIKE_DEBOUNCE_SEC to the last
   *    accepted one is the same physical strike re-firing: dropped entirely
   *    (the anchor does NOT move — the walk-stats law). Non-monotone stamps
   *    fall in here too (t - last < 0 < debounce);
   * 3. the interval chain folds t - lastStrikeT under the STEP_MIN..
   *    intMaxSec gate and the anchor advances. This happens for EVERY
   *    debounce-passing strike, reference-delivered or not: an inter-strike
   *    interval is a KINEMATIC fact (both crossings were detected) and the
   *    chooser needs the walker's true tempo — only PHASE is an entrainment
   *    claim. It also keeps a mute gap from pairing strikes across itself
   *    into a phantom double-length interval. The ceiling is GRID-AWARE
   *    (latched at reset — see intMaxSec): at 100 BPM the slow candidate's
   *    period is exactly STEP_MAX, and a hard 1.2 s ceiling would silently
   *    drop the long half of a locked 50 spm walker's intervals — biasing
   *    cadence ~+2.5 spm and firing a FALSE "ran ahead" direction cue
   *    against a locked walker (the multi-BPM review's confirmed finding);
   * 4. the REFERENCE GATE — the honesty law: phase folds (both grids, n,
   *    kind flags, source) only when a reference was delivered this frame
   *    (musicOn or a live walk pulse). A gated-out strike stops HERE:
   *    counting is truncated, never faked (see the module header's
   *    truncate-not-void-not-degrade ruling).
   */
  addStrike(
    tSinceGoSec: number,
    musicOn: boolean,
    hapticKind: "haptic" | "earcon" | null,
    source: BeatStrikeSource,
  ): void {
    if (!Number.isFinite(tSinceGoSec)) return;
    if (
      Number.isFinite(this.lastStrikeT) &&
      tSinceGoSec - this.lastStrikeT < BEAT_STRIKE_DEBOUNCE_SEC
    ) {
      return; // crossing re-fire — the same physical strike
    }
    if (Number.isFinite(this.lastStrikeT)) {
      const interval = tSinceGoSec - this.lastStrikeT;
      if (interval >= STEP_MIN && interval <= this.intMaxSec) {
        this.intSum += interval;
        this.intN++;
      }
    }
    this.lastStrikeT = tSinceGoSec;

    if (!musicOn && hapticKind === null) return; // reference gate (truncate)

    // theta on the FAST candidate grid; the slow candidate's angle is
    // exactly half (its period is exactly double — the 2:1 candidate law) —
    // one division saved per strike.
    const theta1 = TWO_PI * (tSinceGoSec / this.fastPeriodSec);
    this.c1 += Math.cos(theta1);
    this.s1 += Math.sin(theta1);
    const theta2 = theta1 / 2;
    this.c2 += Math.cos(theta2);
    this.s2 += Math.sin(theta2);
    this.n++;
    if (musicOn) this.sawMusic = true;
    if (hapticKind === "haptic") this.sawHaptic = true;
    else if (hapticKind === "earcon") this.sawEarcon = true;
    this.source = source;
  }

  /**
   * Per-frame reference-coverage disclosure: `refLive` = a beat reference
   * reached the trainee this frame (musicOn || walk pulse live — computed
   * by the wiring). Walk-wide: survives voidStrikes(). Non-finite or
   * non-positive dt contributes nothing (law 6).
   */
  addRefTime(dtSec: number, refLive: boolean): void {
    if (refLive && Number.isFinite(dtSec) && dtSec > 0) {
      this.refSecAcc += dtSec;
    }
  }

  /**
   * The resetCadence seam (camera<->head source handoff): VOID the
   * strike-phase state — circular sums on BOTH grids, n, the debounce/
   * interval chain and its cadence sums, the reference-kind flags, and the
   * source stamp. The two paths' strike semantics (head bob vs hip crossing,
   * camera relay latency) shift the constant lag, so phases across a handoff
   * are NOT comparable: the surviving homogeneous span scores (the
   * resetLateral "last window wins" law; the BEAT DRILL rep-voiding rule
   * applied to the walk channel). `refSec` SURVIVES — reference delivery is
   * a walk-wide fact, not a span fact. goValid and the FIT cadence survive
   * too (neither changed: the grid anchor and the trainee's body are
   * handoff-invariant).
   */
  voidStrikes(): void {
    this.c1 = 0;
    this.s1 = 0;
    this.c2 = 0;
    this.s2 = 0;
    this.n = 0;
    this.lastStrikeT = NaN;
    this.intSum = 0;
    this.intN = 0;
    this.sawMusic = false;
    this.sawHaptic = false;
    this.sawEarcon = false;
    this.source = "head";
  }

  /**
   * Freeze the walk into a BeatStats; null when the clock was never valid or
   * fewer than BEAT_MIN_STRIKES strikes counted (nullReason() says which).
   * Non-destructive and re-callable (the walk-stats finalize law) — the
   * walk-end tape pins the adjudication-§D exclusion with exactly this
   * property (finalize before the last frame, then after).
   *
   * The vector-strength estimator (THE PICK — both halves, each doing the
   * job the other cannot):
   *
   *   R_raw = sqrt(C^2 + S^2) / n
   *
   * (a) Rayleigh-corrected estimator (fixes the MEAN): under uniform
   * (chance) phases E[R_raw] = sqrt(pi) / (2 * sqrt(n)) — ~0.28 at n = 10:
   * raw R claims phantom lock at small n. But n * R_raw^2 = |sum of n unit
   * vectors|^2 / n has expectation EXACTLY 1 under uniformity (cross terms
   * vanish; cos^2 + sin^2 = 1), and for a true mean resultant rho,
   * E[n * R_raw^2] ~= 1 + (n - 1) * rho^2. Hence the unbiased plug-in:
   *
   *   vectorR = sqrt( max(0, (n * R_raw^2 - 1) / (n - 1)) )     // n >= 2
   *
   * At chance it centers on 0 at ANY n; for a locked walker the correction
   * vanishes as n grows. WORKED EXAMPLE (adjudication §H — the corrected
   * arithmetic): n = 50, R_raw = 0.8 -> vectorR = sqrt((50 * 0.64 - 1) / 49)
   * = sqrt(31 / 49) = 0.795 (NOT 0.797 — the spec prose's arithmetic slip).
   * (b) the BEAT_MIN_STRIKES floor bounds the VARIANCE the correction
   * cannot (derivation at the constant). Both vectorR (primary) and
   * vectorRRaw are recorded — the correction is visible, never silent.
   */
  finalize(): BeatStats | null {
    if (!this.goValid || this.n < BEAT_MIN_STRIKES) return null;

    const cad =
      this.intN >= BEAT_CADENCE_MIN_INTERVALS
        ? 60 / (this.intSum / this.intN)
        : null;
    const sub = chooseSubdivision(cad, this.fitCadenceSpm, this.bpm);
    const fast = sub === this.grids.fastSub;
    const grid = fast ? this.grids.fastSpm : this.grids.slowSpm;
    const c = fast ? this.c1 : this.c2;
    const s = fast ? this.s1 : this.s2;
    const n = this.n;

    const rRaw = Math.hypot(c, s) / n;
    const nR2 = n * rRaw * rRaw;
    const r = Math.sqrt(Math.max(0, (nR2 - 1) / (n - 1)));

    // Fixed-order reference label (music -> haptic -> earcon) — chronology-
    // independent, so the same walk always exports the same string.
    let reference = this.sawMusic ? "music" : "";
    if (this.sawHaptic) reference = reference ? reference + "+haptic" : "haptic";
    if (this.sawEarcon) reference = reference ? reference + "+earcon" : "earcon";

    return {
      strikes: n,
      vectorR: round3(r),
      vectorRRaw: round3(rRaw),
      meanPhaseBeats: round3(wrapPhaseBeats(Math.atan2(s, c) / TWO_PI)),
      rayleighNR2: round2(nR2),
      subdivision: sub,
      gridSpm: grid,
      cadenceSpm: cad === null ? null : round1(cad),
      driftSpm: cad === null ? null : round1(cad - grid),
      refSec: round1(this.refSecAcc),
      reference,
      strikeSource: this.source,
      beatScore: round1(beatScoreOf(r)),
    };
  }

  /**
   * Why finalize() returned null — meaningful ONLY when it did.
   * "no-clock" wins over everything (with no valid anchor, nothing about
   * references or strikes can honestly be claimed); then "no-reference"
   * (nothing was EVER delivered: zero counted strikes AND zero reference
   * seconds); else "too-few-strikes" (a reference was delivered but under
   * BEAT_MIN_STRIKES strikes landed while it was live).
   */
  nullReason(): BeatNullReason {
    if (!this.goValid) return "no-clock";
    if (this.n === 0 && this.refSecAcc === 0) return "no-reference";
    return "too-few-strikes";
  }
}

// ---------------------------------------------------------------------------
// Copy (ASCII punctuation only — every string enters the panel-ascii sweep).
// Parked HERE (not coach.ts) on purpose — the hold-stats.ts §I precedent:
// M9 is not Solo-portable (no beat reference exists in Solo), so keeping its
// strings out of the shared coach tables keeps the Swift string mirrors and
// their golden families untouched. The legacy METRIC_EXPLAIN.rhythm text
// ("how even and consistent your step timing is") stays true — M3 remains
// SELF-consistency; M9 is consistency AGAINST the delivered grid.
// ---------------------------------------------------------------------------

/**
 * Landing tooltip / explainer row. Discloses the reference gate, the sensor
 * + derivation (head bob, constant lag, offset-invariance), and the grid
 * chooser. Numeral-free by design since the grid rates now follow the
 * selected tempo (the walk row's own gridSpm stamp carries the numbers).
 */
export const BEAT_EXPLAIN =
  "Measured only while a beat reference reaches you - music on, or the " +
  "beat pulse in your hand (a soft tick on hand tracking). Beat lock is " +
  "the phase consistency of your detected footstrikes against the music " +
  "grid: 100 means every strike lands at the same point in the beat. " +
  "Strikes come from your head bob, which lags the true footstep by a " +
  "roughly constant offset - the lock ignores any constant offset and " +
  "your average offset is never read as timing accuracy. Grid: every " +
  "beat, every 2nd beat, or every half beat - chosen from your own cadence.";

/**
 * Settings tooltip (landing control title / panel disclosure). Discloses
 * the delivery surface, the hand-tracking fallback + its mute law, the
 * record stamp, AND the countdown flam suppression (adjudication §H).
 */
export const BEAT_SETTING_TIP =
  "The controllers pulse on the music grid - through the countdown, and " +
  "through the walk when set to WALK. Hand tracking has no haptics: a " +
  "soft tick plays instead (muted when music is muted). Pulses landing " +
  "within 60 ms after a countdown tick are skipped so the two never " +
  "double-hit; GO stays on the grid. Walk pulses are stamped on the walk " +
  "record as the delivered beat reference.";

/**
 * Summary stat line (XR panel node "sum-beat" + the landing card). The null
 * branch REQUIRES the reason (the holdStatLine law): an unarmed clock, an
 * undelivered reference and a too-short strike run are different facts and
 * must not share a sentence. `sep` law = walkStatLine (coach.ts): the ASCII
 * " - " default is a PANEL constraint; the DOM landing may pass its own.
 */
export function beatStatLine(
  b: BeatStats | null,
  reason: BeatNullReason,
  sep: string = " - ",
): string {
  if (b === null) {
    if (reason === "no-clock") {
      return "BEAT: NO READ - THE BEAT CLOCK WAS NOT ARMED";
    }
    if (reason === "no-reference") {
      return "BEAT: NO READ - NO BEAT REFERENCE WAS DELIVERED";
    }
    return "BEAT: NO READ - TOO FEW STRIKES WITH THE BEAT ON";
  }
  return (
    `BEAT LOCK ${Math.round(b.vectorR * 100)}%${sep}` +
    `GRID ${b.gridSpm}/MIN${sep}${b.strikes} STRIKES`
  );
}

/**
 * Post-walk coach note; null when nothing qualifies (between bands — the
 * holdCue no-claim law) or when the null reason is not a trainee action
 * ("no-clock" is an internal condition: no note). Every number cited is a
 * measured quantity from the row; short and speakable.
 *
 * Precedence: DIRECTION > locked > wandered — when the direction claim
 * qualifies it is the actionable story (drift is what the trainee can fix
 * next walk); "locked" is praise; "wandered" is the fault floor.
 *
 * THE DIRECTION-FLOOR RULE (all three gates required, evaluated on the
 * ROW's disclosed stats — what the row shows is what the copy claims):
 * 1. row non-null (n >= BEAT_MIN_STRIKES — given here by construction);
 * 2. rayleighNR2 >= BEAT_RAYLEIGH_DIRECTION_MIN (demonstrated above-chance
 *    entrainment, p ~ 1% — no relationship claim without it);
 * 3. |driftSpm| >= BEAT_DRIFT_MIN_SPM (the 2.5-SE noise floor).
 * The direction cited is the phase SLOPE (tempo residual) — lag-immune by
 * construction; the absolute mean phase is never cited (the bob-lag law).
 */
export function beatCue(
  b: BeatStats | null,
  reason: BeatNullReason,
): string | null {
  if (b === null) {
    if (reason === "no-reference") {
      return "No beat reached you this walk - turn on music or the beat pulse and the lock is scored.";
    }
    if (reason === "too-few-strikes") {
      return "Too few steps landed while the beat was on - the lock was not scored.";
    }
    return null; // "no-clock": internal condition, not a trainee action
  }
  const drift = b.driftSpm;
  const cadence = b.cadenceSpm;
  if (
    drift !== null &&
    cadence !== null &&
    b.rayleighNR2 >= BEAT_RAYLEIGH_DIRECTION_MIN &&
    Math.abs(drift) >= BEAT_DRIFT_MIN_SPM
  ) {
    const cad = Math.round(cadence);
    return drift > 0
      ? `You ran ahead of the beat - ${cad} steps a minute against the ${b.gridSpm} grid. Sit back into the count.`
      : `You fell behind the beat - ${cad} steps a minute against the ${b.gridSpm} grid. Push up to the count.`;
  }
  if (b.vectorR >= BEAT_LOCK_GOOD_R) {
    return `Locked to the beat - ${Math.round(b.vectorR * 100)} percent phase-steady on the ${b.gridSpm} a minute grid.`;
  }
  if (b.vectorR < BEAT_LOCK_FAULT_R) {
    // Delivery-neutral: the channel scores strikes against music, the haptic
    // pulse, OR the earcon (the reference gate accepts any of them), so a
    // haptic-only walk (music muted) must not be told to count music that
    // was never playing — matching the null-branch "music or the beat pulse"
    // and the direction cues' generic "the count".
    return "Your strikes wandered off the beat - count the beat down the deck.";
  }
  return null;
}
