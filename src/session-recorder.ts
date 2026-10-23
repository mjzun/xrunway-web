/**
 * (X)RUNWAY — Session recorder + data export.
 *
 * Data collection is a non-negotiable product requirement: every walk is
 * recorded as a time-series of the AI-coach metrics plus a scored summary, and
 * the data is exportable (CSV for spreadsheets / analysis, JSON for the full
 * record). This is what a modeling class or agency takes away from a session.
 *
 * It self-wires from the shared signals (showPhase / metrics / summary /
 * runwayLayout / trackerActive) — no ECS system needed. Full per-walk samples
 * are kept in memory for the current page session; a compact summary log is
 * persisted to localStorage so walk history + the "vs last walk" delta survive
 * reloads.
 */

import type { Signal } from "@preact/signals-core";

// The single source of truth for the exported app version (#25) — vite (and
// vitest) inline just this field from package.json, not the whole file.
import { version as APP_VERSION } from "../package.json";

import type { BeatStats } from "./beat-stats.js";
import { drillById, LEVEL_BANDS, timeInBand } from "./curriculum-core.js";
import type { ExternalTracker } from "./external-tracker.js";
import type { CarriageStats } from "./head-carriage.js";
import type { HoldStats } from "./hold-stats.js";
import {
  benchmarkAtFinalize,
  benchmarkConfigAtWalkStart,
} from "./repeatability.js";
import type { RunwayLayout } from "./runway-layout.js";
import { DEFAULT_LAYOUT } from "./runway-layout.js";
import type { RunwayShape } from "./runway-shape.js";
import { SCORE_SCALE_STAMP } from "./pose-derive.js";
import {
  isSyntheticRow,
  rowMatchesTrainee,
  rowNormalization,
  rowScoreScale,
} from "./session-grading.js";
import { LESSON } from "./theme.js";
import type {
  MetricSnapshot,
  ShowPhaseValue,
  ShowSummary,
} from "./show.js";
import type { TrainingMode } from "./modes.js";
import type { TurnStats } from "./turn-stats.js";
import type { UserPrefs } from "./user-prefs.js";
import type { WalkStats, WalkStatsAccumulator } from "./walk-stats.js";

/** One 6 Hz sample of the live metrics during a walk. */
export interface MetricSample {
  /** Seconds into the walk. */
  t: number;
  pace: number;
  posture: number;
  rhythm: number;
  footPlacement: number;
  presence: number;
  confidence: number;
  presentation: number;
  /** Measured horizontal speed (m/s) at this sample — the smoothed value the
   * pace score maps from. Null when the active source doesn't measure true
   * speed (the camera-image path works in normalized units) (#12). */
  paceMps: number | null;
  /** SIGNED centerline offset (m) at this sample: + = the trainee's right on
   * the outbound leg (see walk-stats.ts). Head-path only — null while an
   * external camera owns scoring (#8/#12). */
  lateralM: number | null;
  /** M8 live head-pitch deviation vs the calibrated neutral (deg, signed,
   * + = above; EMA-smoothed at M8_EMA_RATE, round1). Null when the carriage
   * channel is unmeasured/dark (head orientation, not gaze). */
  headPitchDeg: number | null;
  /** M8 live head-yaw error vs the walk direction (deg, signed, + = the
   * trainee's right; EMA-smoothed, round1). Null while the yaw channel is
   * dark (the turn window, a gated near-vertical frame, unmeasured). */
  headYawDeg: number | null;
  /** Which derivation produced this sample. */
  source: "head" | "camera";
  /** Route-along distance (m) of the head's runway projection at this sample
   * (projectRoute().globalAlong — the same projection the LINE channel uses).
   * ADDITIVE-OPTIONAL (Replay Theater): absent on legacy records, null while
   * an external camera owns scoring (no runway-frame projection). Together
   * with lateralM this replays the walk trajectory; display-only. */
  alongM?: number | null;
}

/** Who walked — captured from UserPrefs at walk start so a shared-device
 * (kiosk/classroom) history stays attributable per row. */
export interface TraineeRef {
  name: string;
  id: string;
}

/** A complete recorded walk. */
export interface SessionRecord {
  id: string;
  /** Epoch ms at walk start. */
  startedAt: number;
  lesson: string;
  /** Training-mode id the walk was scored with ("beginner".."challenge"),
   * or null when unknown. */
  modeId: string | null;
  /** The mode's pass threshold AT RECORD TIME — history grades against this,
   * not a global constant, so verdicts match the summary card (#4/#40). */
  passThreshold: number | null;
  /** The HEAD-path normalization stamp this walk was SCORED under
   * ("default.v1" | "fit.v1-<ms>"), copied from the summary at finalize
   * (the modeId stamp pattern — FIT wave). Optional/null: legacy rows and
   * metrics-less worlds read "default.v1" via rowNormalization. */
  normalization?: string | null;
  /** The scoring RULER this row was scored on (the perfect=100 rescale) —
   * minted at walk start from pose-derive's SCORE_SCALE_STAMP. Absent on
   * pre-rescale rows -> rowScoreScale "s98.v1"; old-ruler rows never seed
   * deltaVsLast or compete for PB on the new ruler. ADDITIVE-OPTIONAL. */
  scoreScale?: string | null;
  /** The delivered music/haptic/scoring tempo (BPM) the walk ran at, copied
   * from the summary at finalize (the normalization stamp pattern — the
   * multi-BPM wave). ADDITIVE-OPTIONAL: absent on legacy records, null when
   * the summary carried no stamp (metrics-less worlds / legacy fixtures).
   * A per-row measurement-condition stamp: walks at different tempos are
   * never silently trended as one beat series. */
  musicBpm?: number | null;
  /** CONFIGURED walk length (s), copied from the summary at finalize (the
   * musicBpm stamp pattern — the duration wave). ADDITIVE-OPTIONAL: absent
   * on legacy records, null when the summary carried no stamp. Distinct
   * from durationSec (measured). */
  walkSecondsSet?: number | null;
  /** The trainee who walked (kiosk/classroom attribution), or null. */
  trainee: TraineeRef | null;
  /** "head", the external camera's source label, or "preview" (auto-pilot). */
  primarySource: string;
  /** True when the Preview Walk auto-pilot drove the rig — NOT a trainee walk.
   * Tagged rows are badged in history and excluded from the pass/low filters,
   * the deltaVsLast baseline, and the summary CSV (#3). */
  synthetic: boolean;
  layout: RunwayLayout;
  /** Runway shape KIND at walk start ("straight"|"T"|"X"|"U"), or null when
   * the shape signal was unwired OR the kind CHANGED mid-walk (a walk that
   * straddles two shapes can prove neither — invalidateShape voids it; a
   * same-kind fit-to-room remap keeps it). ADDITIVE: absent on old rows (M12). */
  shapeKind?: string | null;
  /** True when recorded under the locked benchmark configuration
   * (benchmarkConfigAtWalkStart: real walk + BENCHMARK_MODE_ID +
   * BENCHMARK_SHAPE_KIND). Stamped at walk start, voided with shapeKind on a
   * mid-walk kind change, and RE-DERIVED at finalize after the summary-stamp
   * modeId override (benchmarkAtFinalize, adjudication §G) so a brief-window
   * mode switch can never leave benchmark=true on a non-beginner-scored row. */
  benchmark?: boolean;
  durationSec: number;
  overall: number | null;
  deltaVsLast: number | null;
  finalScores: MetricSnapshot | null;
  /** REAL physical measurements for the walk (true units, signed — see
   * walk-stats.ts), or null when the walk never produced a sample (#12). */
  stats: WalkStats | null;
  /** M8 head-carriage read (head orientation, not gaze), copied from the
   * summary at finalize. ADDITIVE-OPTIONAL: null when the channel never
   * engaged; absent on legacy records. Non-null doubles as the "presence
   * included measured carriage" stamp. */
  carriage?: CarriageStats | null;
  /** M10 hold read (head sensor: stillness + mark accuracy in the fixed
   * post-mark window, hold-stats.ts), copied from the summary at finalize.
   * ADDITIVE-OPTIONAL: null when the window measured nothing; absent on
   * legacy records. heightSource + headHeightM inside it are the per-row
   * normalization stamp (adversary A's rule). */
  hold?: HoldStats | null;
  /** M9 beat-lock read (entrainment of detected footstrikes to the
   * DELIVERED beat reference, beat-stats.ts), copied from the summary at
   * finalize. ADDITIVE-OPTIONAL: null when the channel measured nothing;
   * absent on legacy records. reference/refSec/subdivision/strikeSource
   * inside it are the per-row measurement-condition stamps (walks under
   * different delivered references are never silently trended as one). */
  beat?: BeatStats | null;
  /** M11 turn read (the head PATH through the out-and-back 180,
   * turn-stats.ts — feet are not tracked), copied from the summary at
   * finalize. ADDITIVE-OPTIONAL: null when no turn was measured; absent on
   * legacy records. durBandLo/HiSec + heightSource + entryClipped inside it
   * are the per-row measurement-condition stamps (the row grades itself). */
  turn?: TurnStats | null;
  /** Wave-4: the drill this walk is a rep of (latched at beginWalk). */
  drillId?: string | null;
  samples: MetricSample[];
}

/** Extra facts captured at walk start (all optional — beginWalk callers that
 * predate them, incl. the tests, stay valid). */
export interface WalkMeta {
  /** Preview Walk auto-pilot run (see SessionRecord.synthetic). */
  synthetic?: boolean;
  modeId?: string | null;
  passThreshold?: number | null;
  trainee?: TraineeRef | null;
  /** M12 stamps (see SessionRecord.shapeKind / .benchmark) — optional so
   * pre-M12 beginWalk callers (incl. the tests) stay valid. */
  shapeKind?: string | null;
  benchmark?: boolean;
  /** Wave-4 curriculum: the drill this walk is a rep of (latched at walk
   * start from globals.activeDrill — a pref change mid-walk never re-labels
   * a running rep). Absent/null = a plain walk. */
  drillId?: string | null;
}

/** Compact, persisted summary (no samples) for cross-reload history. Fields
 * beyond the v1 shape are optional: rows persisted by older builds lack them
 * (absent `synthetic` = a real walk; absent `passThreshold` = graded at the
 * legacy 75). */
export interface SessionSummaryRow {
  id: string;
  startedAt: number;
  lesson: string;
  modeId?: string | null;
  passThreshold?: number | null;
  /** Normalization stamp the walk was scored under (FIT wave, additive-
   * optional). Absent on pre-wave rows -> rowNormalization "default.v1". */
  normalization?: string | null;
  /** Ruler stamp (perfect=100 rescale) — additive-optional; absent reads
   * "s98.v1" via rowScoreScale. */
  scoreScale?: string | null;
  /** Delivered tempo stamp (BPM) — additive-optional; absent on rows
   * persisted before tempo selection, null when the summary carried none. */
  musicBpm?: number | null;
  /** CONFIGURED walk length (s) the run was locked to (the duration pref) —
   * additive-optional; absent on rows persisted before duration selection,
   * null when the summary carried no stamp. Distinct from durationSec, the
   * MEASURED elapsed time. The group-key/export reader treats absent as the
   * legacy 20 (the LEGACY_MUSIC_BPM read-law pattern; caveat: pre-4ac430a
   * rows walked 40-75 s modes — see the duration wave notes). */
  walkSecondsSet?: number | null;
  trainee?: TraineeRef | null;
  primarySource: string;
  synthetic?: boolean;
  durationSec: number;
  overall: number | null;
  /** Overall delta vs the previous real walk, exactly as the summary card
   * showed it (null on a baseline walk). Absent on rows persisted before it
   * was carried (#21/#25). */
  deltaVsLast?: number | null;
  finalScores: MetricSnapshot | null;
  /** REAL physical measurements (walk-stats.ts) — tiny, so persisted with the
   * row. Absent on rows recorded before the measurement layer landed (#12). */
  stats?: WalkStats | null;
  /** M8 head-carriage read — tiny, persisted with the row (additive-optional;
   * absent on pre-M8 rows, null when the channel never engaged). */
  carriage?: CarriageStats | null;
  /** M10 hold read — tiny, persisted with the row (additive-optional; absent
   * on pre-M10 rows, null when the window measured nothing). */
  hold?: HoldStats | null;
  /** M9 beat-lock read — tiny, persisted with the row (additive-optional;
   * absent on pre-M9 rows, null when the channel measured nothing). */
  beat?: BeatStats | null;
  /** M11 turn read — tiny, persisted with the row (additive-optional;
   * absent on pre-M11 rows, null when no turn was measured). */
  turn?: TurnStats | null;
  /** M12 stamps (additive-optional; absent on pre-M12 rows): the walk-start
   * shape kind (null when unknown/voided) + the benchmark flag as finalize
   * re-derived it (§G). Repeatability windows and the benchmark series read
   * these — an un-stamped row can never anchor or join either. */
  shapeKind?: string | null;
  benchmark?: boolean;
  /** Runway dimensions (meters) the walk was performed on — stamped from the
   * record's layout at finalize so the simplified CSV can report them (they
   * live on the full SessionRecord.layout, not here, historically). Additive-
   * optional: absent on rows persisted before this landed. */
  runwayLength?: number | null;
  runwayWidth?: number | null;
  /** Wave-4 curriculum (additive-optional; absent on pre-wave rows — legacy
   * rows can never anchor a mastery record, honestly): per-channel
   * time-in-band % vs the Level-1 bands, computed from this walk's own
   * samples at finalize. */
  tib?: { pace: number | null; line: number | null; carriage: number | null } | null;
  /** The drill this walk was a rep of + its focus-channel time-in-band
   * (additive-optional; absent = a plain walk). */
  drillId?: string | null;
  drillScore?: number | null;
}

export { APP_VERSION };

/** Nominal metric sampling rate during a walk (MetricsSystem's tick). Stated
 * in every export envelope + CSV metadata block (#25) — it was comment-only. */
export const SAMPLE_RATE_HZ = 6;

const STORAGE_KEY = "xrunway.sessions.v1";
const HISTORY_CAP = 200;
/** Cap on in-memory FULL records (with sample arrays) to bound heap on a kiosk. */
const SESSIONS_CAP = 50;
const METRIC_COLS: ReadonlyArray<keyof MetricSnapshot> = [
  "posture",
  "pace",
  "rhythm",
  "footPlacement",
  "presence",
  "confidence",
  "presentation",
];

export class SessionRecorder {
  /** Full records captured this page-load (with samples). */
  readonly sessions: SessionRecord[] = [];
  /** Persisted compact history (survives reloads). */
  private history: SessionSummaryRow[] = loadHistory();

  private current: SessionRecord | null = null;
  private walkStart = 0;
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** Total recorded walks (persisted history + any not yet flushed). */
  count(): number {
    return this.history.length;
  }

  latest(): SessionRecord | null {
    return this.sessions.length > 0
      ? this.sessions[this.sessions.length - 1]
      : null;
  }

  /** Recorded-walk summaries, most-recent first (the persisted history). */
  list(): SessionSummaryRow[] {
    return [...this.history].reverse();
  }

  /** The most recent REAL persisted walk's overall, or null. Seeds
   * ShowDirector's deltaVsLast baseline across reloads (#21) — a synthetic
   * Preview Walk row or a score-less row never becomes a trainee's baseline.
   * Pass the CURRENT trainee's id so a shared-device (kiosk/classroom)
   * baseline stays per-trainee: rows are matched by rowMatchesTrainee
   * (session-grading.ts — falsy id = no filtering; unattributed/legacy rows
   * always match), so student B's first walk is never graded against
   * student A's score. */
  lastRealOverall(
    traineeId?: string | null,
    normalizationStamp?: string | null,
  ): number | null {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const row = this.history[i];
      if (isSyntheticRow(row)) continue;
      if (!rowMatchesTrainee(row, traineeId)) continue;
      // FIT wave (adversary A): when a stamp is given, only rows scored
      // under the SAME normalization may seed the baseline. Absent/legacy
      // rows read "default.v1" (rowNormalization), so pre-wave history still
      // seeds default-scored walks; no stamp arg = today's exact behavior.
      if (
        normalizationStamp !== undefined &&
        normalizationStamp !== null &&
        rowNormalization(row) !== normalizationStamp
      ) {
        continue;
      }
      // Perfect=100 rescale: deltaVsLast must never compare across rulers —
      // an old-scale row cannot seed the baseline for a new-scale walk (the
      // first post-rescale walk honestly reads FIRST WALK - BASELINE SET).
      if (rowScoreScale(row) !== SCORE_SCALE_STAMP) {
        continue;
      }
      const overall = row.overall;
      if (typeof overall === "number" && Number.isFinite(overall)) {
        return overall;
      }
    }
    return null;
  }

  // -- recording lifecycle (driven by installSessionRecorder) ---------------

  beginWalk(
    layout: RunwayLayout,
    primarySource: string,
    lesson: string = `${LESSON.number} ${LESSON.title}`,
    meta: WalkMeta = {},
  ): void {
    this.walkStart = this.now();
    this.current = {
      id: `S-${this.walkStart}`,
      startedAt: this.walkStart,
      lesson,
      modeId: meta.modeId ?? null,
      passThreshold: meta.passThreshold ?? null,
      normalization: null, // stamped from the summary at finalize (FIT wave)
      // The ruler stamp is minted at WALK START from the engine constant —
      // the stamp and the anchors that score this walk are the same build
      // by construction (the split-lag tripwire pins them together).
      scoreScale: SCORE_SCALE_STAMP,
      trainee: meta.trainee ? { ...meta.trainee } : null,
      primarySource,
      synthetic: meta.synthetic === true,
      drillId: meta.drillId ?? null,
      layout: { ...layout },
      // M12 stamps — the existing ?? null / === true meta discipline.
      shapeKind: meta.shapeKind ?? null,
      benchmark: meta.benchmark === true,
      durationSec: 0,
      overall: null,
      deltaVsLast: null,
      finalScores: null,
      stats: null,
      carriage: null, // stamped from the summary at finalize (M8)
      hold: null, // stamped from the summary at finalize (M10)
      beat: null, // stamped from the summary at finalize (M9)
      turn: null, // stamped from the summary at finalize (M11)
      samples: [],
    };
  }

  sample(
    m: MetricSnapshot,
    source: "head" | "camera",
    paceMps: number | null = null,
    lateralM: number | null = null,
    headPitchDeg: number | null = null,
    headYawDeg: number | null = null,
    alongM: number | null = null,
  ): void {
    if (!this.current) return;
    this.current.samples.push({
      t: Math.round(((this.now() - this.walkStart) / 1000) * 10) / 10,
      pace: Math.round(m.pace),
      posture: Math.round(m.posture),
      rhythm: Math.round(m.rhythm),
      footPlacement: Math.round(m.footPlacement),
      presence: Math.round(m.presence),
      confidence: Math.round(m.confidence),
      presentation: Math.round(m.presentation),
      // Raw channels in true units (#12): cm/s / mm resolution is plenty for
      // a coach's spreadsheet and keeps the JSON export compact.
      paceMps:
        paceMps === null || !Number.isFinite(paceMps)
          ? null
          : Math.round(paceMps * 100) / 100,
      lateralM:
        lateralM === null || !Number.isFinite(lateralM)
          ? null
          : Math.round(lateralM * 1000) / 1000,
      // M8 live head-carriage taps: the tracker exposes RAW EMA values;
      // 0.1 deg resolution is rounded HERE, at the recorder boundary.
      headPitchDeg:
        headPitchDeg === null || !Number.isFinite(headPitchDeg)
          ? null
          : Math.round(headPitchDeg * 10) / 10,
      headYawDeg:
        headYawDeg === null || !Number.isFinite(headYawDeg)
          ? null
          : Math.round(headYawDeg * 10) / 10,
      source,
      // Replay channel (mm resolution, like lateralM) — additive-optional.
      alongM:
        alongM === null || !Number.isFinite(alongM)
          ? null
          : Math.round(alongM * 1000) / 1000,
    });
  }

  /** Finalize the current walk with its summary; persist + keep. */
  finalize(summary: ShowSummary): void {
    if (!this.current) return;
    // Prefer the LOCKED run mode stamped on the summary (ShowDirector locks
    // it at beginWalk and stamps it at finishWalk) over the phase->walk
    // capture: a mode switch during the brief window would otherwise desync
    // the persisted row from the mode that actually scored the walk — the row
    // must grade exactly the way the summary card did. A stamp-less summary
    // (legacy caller / test fixture) keeps the walk-start capture.
    if (summary.modeId !== undefined && summary.modeId !== null) {
      this.current.modeId = summary.modeId;
    }
    if (summary.passThreshold !== undefined && summary.passThreshold !== null) {
      this.current.passThreshold = summary.passThreshold;
    }
    // M12 benchmark re-derivation (adjudication §G) — AFTER the mode override
    // above so it judges the SUMMARY-LOCKED mode: a mode switched between the
    // beginWalk meta capture and the summary stamp must never leave
    // benchmark=true on a row whose locked mode is not the benchmark mode.
    // One-directional by construction (stamped && still-beginner): finalize
    // can revoke a stale stamp, never mint one — shapeKind keeps its
    // walk-start / invalidateShape() value (the shape guard owns that channel).
    this.current.benchmark = benchmarkAtFinalize(
      this.current.benchmark,
      this.current.modeId,
    );
    // Normalization stamp (FIT wave): the summary carries what MetricsSystem
    // locked at walk start (the same override pattern as the mode stamp
    // above). A stamp-less summary (legacy caller / test fixture) keeps the
    // walk-start null — rowNormalization reads it as "default.v1".
    if (summary.normalization !== undefined) {
      this.current.normalization = summary.normalization;
    }
    // Delivered tempo stamp (the normalization pattern): what the walk
    // actually ran at, per the summary's walk-time latch. Null for
    // stamp-less legacy summaries/fixtures (the field is additive-optional).
    this.current.musicBpm = summary.musicBpm ?? null;
    // Configured-duration stamp (the same law): the walk length the run was
    // locked to at startRun. Null for stamp-less legacy summaries/fixtures.
    this.current.walkSecondsSet = summary.walkSecondsSet ?? null;
    this.current.durationSec = summary.durationSec;
    this.current.overall = summary.overall;
    this.current.deltaVsLast = summary.deltaVsLast;
    this.current.finalScores = summary.scores;
    this.current.stats = summary.stats ?? null;
    // M8 carriage stamp: null when the channel never engaged (and for
    // stamp-less legacy summaries/fixtures — the field is additive-optional).
    this.current.carriage = summary.carriage ?? null;
    // M10 hold stamp — same law (null for stamp-less fixtures; the reason
    // enum is a summary-surface concern, not persisted: the row's null +
    // timeInWindowSec already carry the honest facts).
    this.current.hold = summary.hold ?? null;
    // M9 beat stamp — same law again (the reason enum stays summary-side:
    // the row's null + refSec carry the honest facts).
    this.current.beat = summary.beat ?? null;
    // M11 turn stamp — same law (the reason enum stays summary-side: the
    // row's null + the shape column already carry the honest facts).
    this.current.turn = summary.turn ?? null;
    this.sessions.push(this.current);
    // Bound the in-memory full-record heap (each holds a ~360-sample series);
    // the compact `history` below preserves the long-term walk log.
    if (this.sessions.length > SESSIONS_CAP) {
      this.sessions.splice(0, this.sessions.length - SESSIONS_CAP);
    }

    // Wave-4 curriculum stamps: per-channel time-in-band vs the Level-1
    // bands, from this walk's OWN samples (display/curriculum-only — the
    // scored engine is untouched); the drill focus channel's value doubles
    // as the rep's drill score.
    const tib = timeInBand(
      this.current.samples,
      LEVEL_BANDS[0],
      this.current.stats ? this.current.stats.idealPaceMps : null,
    );
    const drill = drillById(this.current.drillId);
    const drillScore = drill ? tib[drill.channel] : null;

    this.history.push({
      id: this.current.id,
      startedAt: this.current.startedAt,
      lesson: this.current.lesson,
      modeId: this.current.modeId,
      passThreshold: this.current.passThreshold,
      normalization: this.current.normalization,
      scoreScale: this.current.scoreScale,
      musicBpm: this.current.musicBpm,
      walkSecondsSet: this.current.walkSecondsSet,
      trainee: this.current.trainee,
      primarySource: this.current.primarySource,
      synthetic: this.current.synthetic,
      durationSec: this.current.durationSec,
      overall: this.current.overall,
      deltaVsLast: this.current.deltaVsLast,
      finalScores: this.current.finalScores,
      stats: this.current.stats,
      carriage: this.current.carriage,
      hold: this.current.hold,
      beat: this.current.beat,
      turn: this.current.turn,
      shapeKind: this.current.shapeKind,
      benchmark: this.current.benchmark,
      runwayLength: this.current.layout.length,
      runwayWidth: this.current.layout.width,
      tib,
      drillId: this.current.drillId ?? null,
      drillScore,
    });
    if (this.history.length > HISTORY_CAP) {
      this.history.splice(0, this.history.length - HISTORY_CAP);
    }
    saveHistory(this.history);
    this.current = null;
  }

  /** Drop an in-progress walk (reset before summary). */
  discard(): void {
    this.current = null;
  }

  /** A mid-walk shape-KIND change makes the walk unattributable to one
   * shape: void both M12 stamps on the in-progress record — the row must
   * not claim a shape it only half-walked, and without a provable shape it
   * can't be a benchmark walk either. Idempotent; no-op outside a walk.
   * (A same-kind fit-to-room remap never calls this — pace/cadence, the
   * consistency channels, are centerline-independent and survive a remap.) */
  invalidateShape(): void {
    if (!this.current) return;
    this.current.shapeKind = null;
    this.current.benchmark = false;
  }

  // -- exports --------------------------------------------------------------

  /** Per-walk metric time-series CSV (defaults to the latest walk). */
  exportSessionCSV(id?: string): boolean {
    const s = this.find(id);
    if (!s) return false;
    download(`xrunway-${s.id}.csv`, sessionToCsv(s), "text/csv");
    return true;
  }

  /** Full per-walk record as JSON (samples + summary + metadata), wrapped in
   * the self-describing export envelope (#25). */
  exportSessionJSON(id?: string): boolean {
    const s = this.find(id);
    if (!s) return false;
    download(
      `xrunway-${s.id}.json`,
      JSON.stringify(walkExport(s), null, 2),
      "application/json",
    );
    return true;
  }

  /** One row per recorded walk (the persisted history) — coach/agency view.
   * Synthetic Preview Walk rows are EXCLUDED: auto-pilot samples must never
   * sit unmarked in a coach's training spreadsheet (#3). The full-JSON export
   * below still carries them, tagged. */
  exportAllCSV(): boolean {
    const real = this.history.filter((r) => !isSyntheticRow(r));
    if (real.length === 0) return false;
    download("xrunway-sessions.csv", historyToCsv(real), "text/csv");
    return true;
  }

  /** The same walk-history sheet as a CHARTED Excel file (founder call
   * 2026-07-08: native charts so the data is easy to read + defend): the
   * committed template's native line chart over the SAME ten columns —
   * historyRowCells feeds both, so CSV and Excel can never disagree.
   * Same synthetic-row exclusion as the CSV. Resolves false when there is
   * nothing to export; REJECTS on a failed template fetch/fill (the caller
   * owns the user-facing failure toast). */
  async exportAllXlsx(): Promise<boolean> {
    const real = this.history.filter((r) => !isSyntheticRow(r));
    if (real.length === 0) return false;
    const { buildWalksXlsx, XLSX_MIME } = await import("./export-xlsx.js");
    const bytes = await buildWalksXlsx(real.map(historyRowCells));
    // Re-seat on a fresh ArrayBuffer: the DOM lib's BlobPart rejects
    // fflate's Uint8Array<ArrayBufferLike> (it could wrap a shared buffer).
    const seated = new Uint8Array(bytes.length);
    seated.set(bytes);
    download("xrunway-sessions.xlsx", seated, XLSX_MIME);
    return true;
  }

  /**
   * Full records captured this page-load, as one JSON (time-series included).
   * After a reload (no in-memory sessions yet) the per-walk samples are not
   * persisted, so fall back to exporting the persisted summary history rather
   * than silently downloading nothing.
   */
  exportAllJSON(): boolean {
    if (this.sessions.length > 0) {
      download(
        "xrunway-sessions-full.json",
        JSON.stringify(historyExport(this.sessions, "full"), null, 2),
        "application/json",
      );
      return true;
    }
    if (this.history.length > 0) {
      download(
        "xrunway-sessions-summary.json",
        JSON.stringify(historyExport(this.history, "summary"), null, 2),
        "application/json",
      );
      return true;
    }
    return false;
  }

  /** Erase the recorded walk history: the persisted summary rows AND this
   * page-load's in-memory full records, so a post-clear export can never
   * resurrect an "erased" walk — a product recording body metrics has to mean
   * it (#26). A walk in progress is untouched; it finalizes normally. */
  clearHistory(): void {
    this.history = [];
    this.sessions.length = 0;
    saveHistory(this.history);
  }

  /** True while a walk's FULL record (with the sample time-series) is still
   * in memory. Samples only live for the page-load they were recorded in, so
   * the history UI uses this to offer per-walk exports honestly (#41). */
  hasFullRecord(id: string): boolean {
    return this.sessions.some((s) => s.id === id);
  }

  private find(id?: string): SessionRecord | null {
    if (!id) return this.latest();
    return this.sessions.find((s) => s.id === id) ?? null;
  }
}

/**
 * Self-wire the recorder to the shared signals and return it (also on
 * `world.globals.sessionRecorder` + `window.xrunwaySessions`).
 */
export function installSessionRecorder(
  globals: Record<string, unknown>,
): SessionRecorder {
  const recorder = new SessionRecorder();
  globals.sessionRecorder = recorder;
  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).xrunwaySessions = recorder;
  }

  const phaseSig = globals.showPhase as Signal<ShowPhaseValue> | undefined;
  const metricsSig = globals.metrics as
    | Signal<MetricSnapshot | null>
    | undefined;
  const summarySig = globals.summary as Signal<ShowSummary | null> | undefined;
  const layoutSig = globals.runwayLayout as Signal<RunwayLayout> | undefined;
  const shapeSig = globals.runwayShape as Signal<RunwayShape> | undefined;

  let phase: ShowPhaseValue = "idle";
  /** The shape KIND stamped on the walk in progress (M12) — the mid-walk
   * guard below compares against the WALK-START kind, so a kind that changes
   * and later changes back stays voided (the walk still straddled shapes). */
  let stampedKind: string | null = null;

  // Register our signal subscriptions in the shared disposer bucket so a teardown
  // / HMR drain (index.ts) unsubscribes them instead of leaking double-subscribes.
  const cf = Array.isArray(globals.cleanupFuncs)
    ? (globals.cleanupFuncs as Array<() => void>)
    : null;
  const reg = (d: (() => void) | undefined): void => {
    if (d && cf) cf.push(d);
  };

  reg(
    phaseSig?.subscribe((p) => {
      const prev = phase;
      phase = p;
      if (p === "walk" && prev !== "walk") {
        const layout = layoutSig ? layoutSig.peek() : DEFAULT_LAYOUT;
        // The Preview Walk auto-pilot (DemoWalkSystem) drives the rig — record
        // the run, but tagged synthetic with source "preview" so it can never
        // pass for a trainee walk in history, baselines, or exports (#3).
        const synthetic = globals.demoActive === true;
        const src = synthetic ? "preview" : sourceLabel(globals);
        // Capture the scoring context AT WALK START (#4): the mode + its pass
        // threshold (so history grades this row the way the summary card did)
        // and the trainee identity (kiosk/classroom attribution).
        const mode = activeMode(globals);
        const user = (globals.userPrefs as Signal<UserPrefs> | undefined)?.peek();
        // M12: the shape KIND the walk starts on (null when the signal is
        // unwired — partial worlds/tests keep working).
        const shapeKind = shapeSig ? shapeSig.peek().kind : null;
        stampedKind = shapeKind;
        recorder.beginWalk(layout, src, lessonLabel(globals), {
          synthetic,
          modeId: mode ? mode.id : null,
          passThreshold: mode ? mode.passThreshold : null,
          trainee: user ? { name: user.name, id: user.id } : null,
          shapeKind,
          // AUTO-DETECTED, never armed: the benchmark configuration is fully
          // determined by facts already stamped at walk start, so an arming
          // step would add nothing measurable and a forgotten arm would
          // silently drop honest data. Synthetic rows are stamped false
          // outright (belt + braces on top of realScoredRows).
          // Wave-4: the drill focus, latched at walk start (plain signal on
          // globals; null = a plain walk). Synthetic bot reps still stamp —
          // realScoredRows keeps them out of every record.
          drillId:
            (
              globals.activeDrill as
                | { peek(): { id: string } | null }
                | undefined
            )?.peek()?.id ?? null,
          benchmark: benchmarkConfigAtWalkStart(
            synthetic,
            mode ? mode.id : null,
            shapeKind,
          ),
        });
      } else if (p === "idle" && prev !== "summary") {
        // Reset mid-run (not via summary) — drop the partial walk.
        recorder.discard();
      }
    }),
  );

  reg(
    metricsSig?.subscribe((m) => {
      if (m && phase === "walk") {
        // Tap the live raw channels (true units, #12) off the measurement
        // accumulator MetricsSystem keeps on globals — null when the active
        // source doesn't measure the channel. The M8 carriage taps
        // (globals.headCarriage) are RAW EMA degrees; sample() rounds them.
        const acc = globals.walkStats as
          | WalkStatsAccumulator
          | null
          | undefined;
        const carr = globals.headCarriage as
          | { livePitchDevDeg: number | null; liveYawDevDeg: number | null }
          | null
          | undefined;
        recorder.sample(
          m,
          globals.trackerActive ? "camera" : "head",
          acc ? acc.livePaceMps : null,
          acc ? acc.liveLateralM : null,
          carr ? carr.livePitchDevDeg : null,
          carr ? carr.liveYawDevDeg : null,
          acc ? acc.liveAlongM : null,
        );
      }
    }),
  );

  reg(
    summarySig?.subscribe((s) => {
      if (s) recorder.finalize(s);
    }),
  );

  reg(
    shapeSig?.subscribe((s) => {
      // M12 mid-walk shape-KIND guard: a fit-to-room remap of the SAME kind
      // keeps the stamps (the lateral channel already resets on remap,
      // walk-stats.ts — pace/cadence survive); a KIND change mid-walk voids
      // them via invalidateShape(). Low frequency by construction: the shape
      // signal is only written by the editors (landing/HUD), never per frame.
      // (@preact subscribe also fires immediately on registration — outside a
      // walk the phase guard makes that a no-op.)
      if (phase === "walk" && s.kind !== stampedKind) {
        recorder.invalidateShape();
      }
    }),
  );

  return recorder;
}

function sourceLabel(globals: Record<string, unknown>): string {
  // Derive from the tracker directly, NOT globals.trackerActive — that flag is
  // only written inside MetricsSystem.update(), which hasn't run for this walk
  // at the instant the phase->walk subscriber fires (it would lag by one walk).
  const tracker = globals.externalTracker as ExternalTracker | undefined;
  const status = tracker?.status();
  return status?.connected ? (status.source ?? "camera") : "head";
}

/** The active training mode (globals.activeMode signal), if wired. */
function activeMode(globals: Record<string, unknown>): TrainingMode | undefined {
  return (globals.activeMode as Signal<TrainingMode> | undefined)?.peek();
}

/** The active training mode's lesson label ("02 EMERGING RUNWAY"), so a
 * recorded walk reflects the chosen mode instead of the hardcoded LESSON. */
function lessonLabel(globals: Record<string, unknown>): string {
  const mode = activeMode(globals);
  return mode
    ? `${mode.number} ${mode.label}`
    : `${LESSON.number} ${LESSON.title}`;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Export envelope (#25) — pure builders (DOM-free, unit-tested).
//
// A downloaded file outlives the app that wrote it: once renamed and archived
// it must explain itself to a coach, a researcher, or a future build. Every
// JSON export is therefore wrapped in a self-describing envelope — schema id,
// app version, export timestamp, units for every numeric field, the nominal
// sampling rate, and device context.
// ---------------------------------------------------------------------------

/**
 * Units for every numeric field in the exported records, shipped INSIDE each
 * JSON envelope. Keys are dotted paths into `record(s)`; `[]` marks an array
 * element, `*` any metric key. Sign conventions match walk-stats.ts.
 */
export const EXPORT_UNITS = {
  startedAt: "epoch milliseconds, UTC",
  durationSec: "seconds",
  passThreshold: "score, 0-100",
  overall: "score, 0-100 (mode-weighted roll-up)",
  deltaVsLast:
    "score points vs the previous real walk (null on a baseline walk)",
  normalization:
    "head-path score normalization stamp: default.v1 = factory constants; fit.v1-<ms> = per-body FIT baseline captured at <ms> epoch",
  musicBpm:
    "beats per minute - the delivered music/haptic/scoring tempo the walk ran at (62/100/125); null when unstamped, absent on rows before tempo selection",
  shapeKind:
    "runway shape the walk started on (straight/T/X/U); null when unknown or when the shape changed mid-walk; absent on rows before shapes were stamped",
  benchmark:
    "true when recorded under the locked benchmark configuration (beginner mode on the straight shape, real walk); absent on rows before the stamp existed",
  "finalScores.*": "score, 0-100 per metric",
  "layout.length / layout.width": "meters",
  "layout.centerX / layout.centerZ": "meters, world frame",
  "layout.yaw": "radians",
  "samples[].t": "seconds since walk start",
  "samples[].pace / posture / rhythm / footPlacement / presence / confidence / presentation":
    "score, 0-100",
  "samples[].paceMps":
    "meters per second, true horizontal speed (null when the active source does not measure it)",
  "samples[].lateralM":
    "meters, signed centerline offset (+ = trainee's right on the outbound leg; null when unmeasured)",
  "samples[].headPitchDeg":
    "degrees, signed head pitch vs the calibrated neutral (+ = above; head orientation, not gaze; null when unmeasured)",
  "samples[].headYawDeg":
    "degrees, signed head yaw vs the walk direction (+ = trainee's right; null during the turn window or when unmeasured)",
  "samples[].alongM":
    "meters, route-along distance of the head's runway projection (the replay trajectory channel; null when an external camera owned scoring; absent on records before Replay Theater)",
  "carriage.pitchInBandFrac / carriage.yawInBandFrac":
    "fraction 0-1 of measured walk time inside the head-carriage band (yaw null when under 1 s measurable)",
  "carriage.meanPitchDevDeg":
    "degrees, time-weighted signed mean head pitch vs neutral (+ = above)",
  "carriage.glanceCount":
    "count of head drops below -15 deg pitch, one per dip",
  "carriage.firstGlanceAtSec":
    "seconds since walk start of the first head drop (null when none)",
  "carriage.neutralPitchDeg":
    "degrees, the calibrated neutral head pitch (stand, FIT baseline or first-0.5s-walk fallback; see carriage.neutralSource)",
  "carriage.measuredSec":
    "seconds of walk time the head-orientation channel measured",
  "carriage.carriageScore":
    "score, 40-100, mapped 40 + 60 * (0.6*pitchFrac + 0.4*yawFrac) - head carriage, not gaze",
  "hold.timeInWindowSec":
    "seconds of measured pose data inside the 1.6 s post-mark hold window (less than 1.6 = truncated: walk ended, clock expired, or tracking froze)",
  "hold.stillnessRmsCm":
    "centimeters, RMS horizontal head drift about the window-mean position (head sensor only)",
  "hold.stillnessNormRmsCm":
    "centimeters, stillness RMS scaled to the 1.60 m reference head height (raw x 1.60 / headHeightM)",
  "hold.headHeightM": "meters, standing head height used for the normalization",
  "hold.heightSource":
    "fit = FIT baseline, walk = first-0.5 s walk baseline, ref = reference fallback (normalization is identity)",
  "hold.orientRmsDeg":
    "degrees, head pitch+yaw RMS about their window means (direction-vector form; roll unobserved; null when no orientation sample)",
  "hold.markErrCm":
    "centimeters, window-mean head position vs the pose mark (hypot of along + lateral errors)",
  "hold.markAlongCm": "centimeters, signed along error (+ = settled past the mark)",
  "hold.markLatCm":
    "centimeters, signed lateral error (+ = trainee's right on the outbound leg)",
  "beat.strikes":
    "count of detected footstrikes scored against the beat grid (reference-gated; source handoffs restart the count)",
  "beat.vectorR / beat.vectorRRaw":
    "vector strength 0-1 of strike phase on the beat grid (vectorR is Rayleigh-bias-corrected: sqrt(max(0,(n*R^2-1)/(n-1))); invariant to constant timing offsets)",
  "beat.meanPhaseBeats":
    "beats, wrapped -0.5..0.5 - detector phase vs the grid; includes a roughly constant head-bob detection + audio-output lag, so it is never read as absolute timing; comparable only within one walk's subdivision and strike source",
  "beat.rayleighNR2":
    "n * vectorRRaw^2 - the Rayleigh non-uniformity statistic (direction copy requires >= ln(100) ~ 4.61, p ~ 1%)",
  "beat.subdivision / beat.gridSpm":
    "the honest grid the strikes were scored against, derived from the walk's musicBpm: beat = one strike per beat, 2-beat = every 2nd beat, half-beat = two per beat; gridSpm is that grid's rate in strikes/min, chosen from the walk's own cadence (FIT natural cadence breaks boundary ties)",
  "beat.cadenceSpm":
    "steps per minute from gated inter-strike intervals (the chooser's input; null under 4 intervals)",
  "beat.driftSpm":
    "cadence minus grid rate, steps per minute (+ = drifting ahead of the beat; constant-lag-immune)",
  "beat.refSec":
    "walk seconds a beat reference was actually delivered (music audible or walk pulse firing); less than durationSec = the channel was truncated",
  "beat.reference":
    "which delivered reference(s) the counted strikes were entrained to: music / haptic / earcon (earcon = the disclosed hand-tracking fallback tick)",
  "beat.strikeSource":
    "derivation path of the counted strikes (head bob / camera hip bob) - phases are never mixed across paths",
  "beat.beatScore": "score, 40-100, 40 + 60 * vectorR - not folded into any composite",
  "turn.startAtSec":
    "seconds since walk start of the turn entry (head yaw leaving the outbound facing band; head path, not foot pivot)",
  "turn.durationSec": "seconds, turn entry to exit on the head path",
  "turn.durBandLoSec / turn.durBandHiSec":
    "seconds, the mode-scaled duration band this walk was judged against",
  "turn.entryClipped":
    "true when the sweep provably began inside the hold window - the measured span is the remainder from the hold release and the duration verdict is suppressed",
  "turn.sweepDeg":
    "degrees, net unwrapped head-yaw sweep between the 20 deg entry and 160 deg exit gates",
  "turn.reversalCount":
    "count of head-yaw sweep reversals larger than 5 deg during the turn",
  "turn.sweepMonotoneFrac":
    "fraction 0-1, net sweep / total swept path (1 = one motion; time-independent)",
  "turn.dipCm":
    "centimeters, deepest head-height dip below the first-0.5-s walk baseline during the turn (null when the baseline never sampled)",
  "turn.dipFrac":
    "fraction of the normalizing standing head height (see turn.heightSource)",
  "turn.heightM": "meters, standing head height used to normalize the dip",
  "turn.heightSource":
    "fit = FIT baseline, walk = first-0.5 s walk baseline, ref = reference fallback (identity)",
  "turn.pitchInBandFrac":
    "fraction 0-1 of measured turn time head pitch stayed within 7 deg of the calibrated neutral (head orientation, not gaze)",
  "turn.measuredSec": "seconds of accepted head-yaw data inside the turn",
  "turn.reacquireSec":
    "seconds from turn exit until the centerline offset held under 0.20 m for 0.5 s on the return leg; when turn.reacquireCapped is true this is the full measured return-leg span (never re-centered); null when the return leg measured under 1 s",
  "turn.reacquireCapped":
    "true when the centerline was never re-acquired before the finish",
  "stats.meanPaceMps / stats.idealPaceMps / stats.paceDeltaMps":
    "meters per second (paceDelta + = faster than the mode's ideal)",
  "stats.meanLateralM / stats.meanAbsLateralM":
    "meters (meanLateralM signed, + = trainee's right on the outbound leg)",
  "stats.postureDriftM":
    "meters, signed head-height drift vs the walk-start baseline (+ = above)",
  "stats.steps": "count of detected footstrikes",
  "stats.cadenceSpm": "steps per minute over the timed walk",
} as const;

/** Device context stamped on each envelope. `source` is only meaningful for
 * a single walk; the multi-walk export carries it per record instead. */
export interface ExportDevice {
  source?: string;
  userAgent: string | null;
}

export interface WalkExport {
  schema: "xrunway.walk.v2";
  appVersion: string;
  exportedAt: string;
  sampleRateHz: number;
  units: typeof EXPORT_UNITS;
  device: ExportDevice;
  record: SessionRecord;
}

export interface HistoryExport {
  schema: "xrunway.history.v2";
  appVersion: string;
  exportedAt: string;
  sampleRateHz: number;
  units: typeof EXPORT_UNITS;
  device: ExportDevice;
  /** What the records carry: "full" = in-memory records with the sample
   * time-series; "summary" = persisted history rows only (post-reload). */
  detail: "full" | "summary";
  records: ReadonlyArray<SessionRecord> | ReadonlyArray<SessionSummaryRow>;
}

function deviceContext(source?: string): ExportDevice {
  return {
    ...(source !== undefined ? { source } : {}),
    userAgent:
      typeof navigator !== "undefined" && navigator.userAgent
        ? navigator.userAgent
        : null,
  };
}

/** Wrap one full walk record in the self-describing envelope (#25). */
export function walkExport(
  record: SessionRecord,
  exportedAt: string = new Date().toISOString(),
): WalkExport {
  return {
    schema: "xrunway.walk.v2",
    appVersion: APP_VERSION,
    exportedAt,
    sampleRateHz: SAMPLE_RATE_HZ,
    units: EXPORT_UNITS,
    device: deviceContext(record.primarySource),
    record,
  };
}

/** Wrap a multi-walk export (full in-memory records OR summary rows). Each
 * record's own primarySource is its device source. */
export function historyExport(
  records: ReadonlyArray<SessionRecord> | ReadonlyArray<SessionSummaryRow>,
  detail: "full" | "summary",
  exportedAt: string = new Date().toISOString(),
): HistoryExport {
  return {
    schema: "xrunway.history.v2",
    appVersion: APP_VERSION,
    exportedAt,
    sampleRateHz: SAMPLE_RATE_HZ,
    units: EXPORT_UNITS,
    device: deviceContext(),
    detail,
    records,
  };
}

// ---------------------------------------------------------------------------
// Pure CSV builders (DOM-free, unit-tested).
// ---------------------------------------------------------------------------

/** CSV-escape one cell. Untrusted text (relay-sourced `primarySource`, the
 * lesson label) flows into the coach's CSV, so every cell is escaped: a leading
 * formula trigger (=,+,-,@ or a control char) gets a `'` prefix so spreadsheets
 * treat it as text (anti-injection), and any comma/quote/newline forces double
 * quoting (internal quotes doubled) so the value can't break the column layout
 * or inject extra rows/columns. */
function csvCell(value: string | number | null | undefined): string {
  // Numbers can't carry formula injection or delimiters — emit them as-is.
  // (Without this, a legitimately NEGATIVE measurement such as lateral_m
  // -0.12 would trip the leading-`-` formula guard below and export as the
  // text cell `'-0.12`.) Non-finite numbers become an empty cell.
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** One `# key: value` metadata line for the per-walk CSV (#25). The `#`
 * prefix marks non-data lines for import tooling, but spreadsheets have no
 * comment syntax — on import they still split every line on commas. An
 * untrusted value (the user-typed trainee name) is therefore neutralized the
 * same way csvCell guards data cells: CR/LF AND commas collapse to a space
 * (no fabricated rows OR cells — mid-cell quoting can't help here, quotes are
 * literal inside an unquoted cell), and a value that would still lead with a
 * formula trigger (=, +, -, @, tab) gets the same `'` text prefix. Numbers
 * are emitted as-is (they can't carry injection; non-finite becomes empty).
 * Null/undefined values emit an empty string — the line itself is stable. */
function metaLine(
  key: string,
  value: string | number | null | undefined,
): string {
  if (typeof value === "number") {
    return `# ${key}: ${Number.isFinite(value) ? String(value) : ""}`;
  }
  let s = value === null || value === undefined ? "" : String(value);
  s = s.replace(/[\r\n,]+/g, " ");
  if (/^[=+\-@\t]/.test(s)) s = `'${s}`;
  return `# ${key}: ${s}`;
}

/** A single walk's 6 Hz metric time-series as CSV text.
 *
 * The file opens with a STABLE '#'-prefixed metadata block (#25), so a
 * downloaded (and renamed) file stays self-describing — two students' files
 * from different modes are distinguishable without the filename. The block is
 * a parser contract: exactly these 16 keys, in this order, one per line —
 *   schema, id, startedAt (ISO 8601 UTC), lesson, mode, shape (the M12 walk-
 *   start shape kind; empty when unknown or voided by a mid-walk kind
 *   change — §F: inserted after mode), passThreshold, trainee ("name (id)"),
 *   source (primarySource; "preview" = auto-pilot), synthetic ("true"/
 *   "false" — a Preview Walk auto-pilot run must never sit unmarked in a
 *   coach's spreadsheet, #3), benchmark ("true"/"false" — the M12 locked-
 *   configuration flag; §F: inserted after synthetic), durationSec,
 *   sampleRateHz, appVersion, normalization (the head-path scoring stamp;
 *   "default.v1" when unstamped — FIT wave), units
 * — followed by the column header, then one row per sample.
 *
 * The raw measured channels (#12) ride along unit-suffixed: pace_mps (true
 * m/s) and lateral_m (SIGNED centerline offset, + = trainee's right
 * outbound); empty cells when the active source didn't measure the channel.
 * M8 appends head_pitch_deg/head_yaw_deg (signed degrees vs neutral / the
 * walk direction — head orientation, not gaze); empty when unmeasured. */
export function sessionToCsv(s: SessionRecord): string {
  const startedMs = Number(s.startedAt);
  const meta = [
    metaLine("schema", "xrunway.walk.v2"),
    metaLine("id", s.id),
    metaLine(
      "startedAt",
      Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : "",
    ),
    metaLine("lesson", s.lesson),
    metaLine("mode", s.modeId ?? ""),
    // M12 shape stamp (§F: inserted after mode) — empty when the shape was
    // unknown at walk start or voided by a mid-walk kind change.
    metaLine("shape", s.shapeKind ?? ""),
    metaLine("passThreshold", s.passThreshold ?? ""),
    metaLine("trainee", s.trainee ? `${s.trainee.name} (${s.trainee.id})` : ""),
    // Provenance (#3): the per-sample source column reads "head" even for an
    // auto-pilot Preview Walk (the recorder tap keys off trackerActive), so
    // the FILE must say who drove the rig — a synthetic walk attributed to a
    // named trainee must never pass for a real one once downloaded/renamed.
    metaLine("source", s.primarySource),
    metaLine("synthetic", s.synthetic ? "true" : "false"),
    // M12 benchmark flag (§F: inserted after synthetic) — the finalize-side
    // re-derived value (§G), never recomputed from mode+shape at export time.
    metaLine("benchmark", s.benchmark ? "true" : "false"),
    metaLine("durationSec", s.durationSec),
    metaLine("sampleRateHz", SAMPLE_RATE_HZ),
    metaLine("appVersion", APP_VERSION),
    // The scoring stamp (FIT wave). rowNormalization applies the same
    // absent/null -> "default.v1" law the row readers use, so a downloaded
    // legacy record says explicitly which constants scored it.
    metaLine("normalization", rowNormalization(s)),
    // NB: metaLine collapses commas — keep this value comma-free.
    metaLine(
      "units",
      "scores 0-100; t_sec seconds; pace_mps meters/second; lateral_m meters signed (+ = trainee's right outbound); head_pitch_deg/head_yaw_deg degrees signed (pitch + = above neutral; yaw + = trainee's right; empty when unmeasured)",
    ),
  ];
  // M8 columns APPEND after `source` so every existing column keeps its
  // position (adjudication §F: append-in-build-order, no "last column" pins).
  const head =
    "t_sec,pace,posture,rhythm,footPlacement,presence,confidence,presentation,pace_mps,lateral_m,source,head_pitch_deg,head_yaw_deg";
  const rows = s.samples.map((x) =>
    [
      x.t,
      x.pace,
      x.posture,
      x.rhythm,
      x.footPlacement,
      x.presence,
      x.confidence,
      x.presentation,
      x.paceMps,
      x.lateralM,
      x.source,
      // Signed degrees ride the csvCell number fast-path (a negative value
      // never trips the leading-`-` formula guard); null/absent -> empty.
      x.headPitchDeg ?? null,
      x.headYawDeg ?? null,
    ]
      .map(csvCell)
      .join(","),
  );
  return [...meta, head, ...rows].join("\n");
}

/** One row per recorded walk (the history) as CSV text. Trainee / mode /
 * threshold columns (#4) make a shared-device export attributable and let a
 * spreadsheet re-derive each row's own verdict; empty cells for legacy rows.
 * startedAt ships twice (#25): epoch ms (startedAt_ms, sortable/computable in
 * a spreadsheet) AND ISO 8601 UTC (startedAt_iso, human-readable), plus the
 * deltaVsLast the summary card showed (#21). Every cell — including the
 * user-typed trainee name — goes through csvCell (formula-injection prefix +
 * quoting). */
/**
 * The walk-history spreadsheet — ULTRA-SIMPLIFIED (founder call 2026-07-08):
 * only the data a trainee needs to read + defend their progress. Exactly ten
 * columns: when (date + time), which lesson, the runway they walked, the
 * overall score, and the three shipped head-metrics PACE / CARRIAGE / LINE.
 *
 * Deliberately DROPPED from the old 40-column sheet: the internal id, ms epoch,
 * trainee name/id, mode id, pass threshold, source, the vs-last delta, the
 * hidden composites (posture/presence/confidence/presentation), RHYTHM
 * (carriage replaces it on the card), and every moment-read (beat / hold /
 * turn) + the FIT normalization stamp. The engine still computes them; the
 * JSON envelope (walkExport / historyExport) still carries the full detail
 * for anyone who wants it — this CSV is the honest headline. DURATION was
 * dropped while every walk was a static 20 s; it RETURNED as duration_s
 * (the founder's ruling, 2026-07-09) once the walk length became user-set —
 * the CONFIGURED length (walkSecondsSet), empty on rows recorded before the
 * duration wave (the runway-dims legacy convention).
 *
 * Date + time are the UTC parts of startedAt (deterministic — no local-TZ drift
 * in tests). Carriage is the head-carriage SCORE (matches the panel row);
 * empty when the channel never engaged. Runway dims are the meters the walk was
 * performed on (empty on legacy rows recorded before the stamp).
 */
/** The founder-locked eleven column names — the ONE header list for the CSV
 * AND the charted Excel sheet (scripts/gen-export-template.py bakes the same
 * list into public/export-template.xlsx row 1; test/export-xlsx.test.ts
 * drift-pins template ↔ code). duration_s sits at the founder's original A3
 * slot (between runway_shape and overall; ruled back IN 2026-07-09 with the
 * user-set walk duration). */
export const HISTORY_EXPORT_HEADERS: ReadonlyArray<string> = [
  "date",
  "time",
  "lesson",
  "runway_length_m",
  "runway_width_m",
  "runway_shape",
  "duration_s",
  "overall",
  "pace",
  "carriage",
  "line",
];

/** One walk row's eleven headline cells — the ONE extraction the CSV and the
 * charted Excel export both consume, so the two sheets can never drift.
 * "" = an empty cell (legacy rows / channel never engaged). */
export function historyRowCells(h: SessionSummaryRow): Array<string | number> {
  const fs = h.finalScores;
  // A corrupt/old-schema row with a bad startedAt would throw RangeError and
  // abort the WHOLE export, not just the bad row — coerce + guard.
  const ms = Number(h.startedAt);
  const iso = Number.isFinite(ms) ? new Date(ms).toISOString() : "";
  return [
    iso.slice(0, 10), // YYYY-MM-DD (UTC)
    iso.slice(11, 16), // HH:MM (UTC)
    h.lesson,
    h.runwayLength == null ? "" : Math.round(h.runwayLength * 10) / 10,
    h.runwayWidth == null ? "" : Math.round(h.runwayWidth * 10) / 10,
    h.shapeKind ?? "",
    // duration_s = the CONFIGURED walk length (the lesson parameter), NOT
    // the measured elapsed time (a positional finish ends early). Empty on
    // rows recorded before the duration wave — never a guessed 20 (the
    // runway-dims legacy convention; pre-wave modes walked other lengths).
    h.walkSecondsSet == null ? "" : h.walkSecondsSet,
    h.overall == null ? "" : Math.round(h.overall),
    fs ? Math.round(fs.pace) : "",
    // CARRIAGE (head-carriage score) — the 3rd shipped metric, replacing
    // rhythm; empty when the channel never engaged on this walk.
    h.carriage ? Math.round(h.carriage.carriageScore) : "",
    fs ? Math.round(fs.footPlacement) : "", // LINE (head-over-centerline)
  ];
}

export function historyToCsv(rows: ReadonlyArray<SessionSummaryRow>): string {
  const head = HISTORY_EXPORT_HEADERS.join(",");
  const body = rows.map((h) => historyRowCells(h).map(csvCell).join(","));
  return [head, ...body].join("\n");
}

function download(filename: string, data: BlobPart, mime: string): void {
  try {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    console.warn("[session-recorder] export failed:", err);
  }
}

function loadHistory(): SessionSummaryRow[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Guard against valid-JSON-but-wrong-shape storage (schema drift, manual
    // edit) — a non-array would later crash `[...this.history]` / `.push`,
    // and a non-object ELEMENT (null / number / string / nested array —
    // JSON.stringify of a sparse array yields nulls) would throw in every row
    // consumer (isSyntheticRow / lastRealOverall / progressReport), which #21
    // made load-bearing at BOOT (ShowDirector.init). Filter at this single
    // ingestion point so every consumer only ever sees object rows.
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is SessionSummaryRow =>
        typeof r === "object" && r !== null && !Array.isArray(r),
    );
  } catch {
    return [];
  }
}

function saveHistory(rows: SessionSummaryRow[]): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
    }
  } catch {
    /* storage full / unavailable — non-fatal. */
  }
}
