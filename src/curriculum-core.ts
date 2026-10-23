/**
 * (X)RUNWAY — the CURRICULUM core (Wave 4; pure, vitest-loadable).
 *
 * Implements docs/CURRICULUM-DESIGN.md (the hostile-reviewed build spec on
 * docs/RESEARCH-CURRICULUM.md — 29 verified findings + the settled 11-finding
 * coach record). Every factual assertion here carries the spec's [F#]/[P#]
 * tag or [DESIGN]; every learner-visible string is an F.40 draft (the
 * draft-and-tag law) and must keep its scope qualifiers through rewrite.
 *
 * BINDING DESIGN LAWS ENCODED HERE (spec §0):
 * - Sensing honesty: scored criteria reference HEAD-derived channels only
 *   (PACE/LINE/CARRIAGE now; BEAT/HOLD/TURN surface later). No scored
 *   string may contain eye/gaze/face/body language — the lint test enforces
 *   the DO-NOT-PRINT lists below.
 * - Display-before-gate: v1 gates ONLY on the three displayed channels
 *   (the spec's backstop while the surfacing founder-call is open).
 * - Cold-block evidence: mastery reads the FIRST session at least a
 *   DAY_GAP after the previous walk — one unscored re-entry walk, then the
 *   median of the next three scored walks [F4 + the guidance-hypothesis
 *   lineage F7; the discard/N=3/day-gap are our conventions, DESIGN].
 * - Soft-recommend gates, "Not yet" wording, no seat time, no composites,
 *   nothing career-shaped [F12, F14, P5].
 * - All band values are PROVISIONAL [DESIGN] pending the on-device
 *   noise-floor calibration (spec §6) — single-sourced in LEVEL_BANDS so
 *   the calibration pass lands in one table.
 */

import { LATERAL_CUE_M, PACE_DELTA_CUE_MPS } from "./coach-live.js";
import { M8_PITCH_BAND_DEG } from "./head-carriage.js";
import type { MetricSample } from "./session-recorder.js";

/* ------------------------------------------------------------------------ */
/* Channels + levels                                                         */
/* ------------------------------------------------------------------------ */

/** The displayed, gateable channels (spec backstop — BEAT/HOLD/TURN join
 * only after the founder surfaces them; the display-before-gate law). */
export type CurriculumChannel = "pace" | "line" | "carriage";
export const DISPLAYED_CHANNELS: ReadonlyArray<CurriculumChannel> = [
  "pace",
  "line",
  "carriage",
];

export interface LevelBands {
  /** |lateral| band (m) for LINE time-in-band. */
  lineM: number;
  /** |pace - target| band (m/s) for PACE time-in-band. */
  paceMps: number;
  /** |head pitch| band (deg) for CARRIAGE time-in-band. */
  carriageDeg: number;
  /** Namesake-channel pass bar (time-in-band %). Non-compensable [DESIGN]. */
  passPct: number;
  /** Floor every OTHER displayed channel must clear (floors-first, F12ii;
   * the floor value is DESIGN). */
  floorPct: number;
}

export interface CurriculumLevel {
  id: string;
  /** Founder-approvable draft name (spec §6 call). */
  name: string;
  /** The level's namesake channel — its band is floor AND pass bar
   * (non-compensable; a deliberate tightening of the ABRSM transfer,
   * [DESIGN]). Level 5 inverts to declared bands and has no namesake. */
  namesake: CurriculumChannel | null;
  /** SCORED criteria (F.40 drafts) — head-kinematics-only wording (lint). */
  criteria: ReadonlyArray<string>;
  /** Cue-only coach copy — labeled coached-never-scored [P1, P5]. */
  cueOnly: ReadonlyArray<string>;
  bands: LevelBands;
}

/** PROVISIONAL band tables [DESIGN — pending on-device noise-floor
 * calibration; the engine's own cue gates anchor Level 1 so the curriculum
 * never contradicts the live coach]. */
export const LEVEL_BANDS: ReadonlyArray<LevelBands> = [
  { lineM: LATERAL_CUE_M, paceMps: PACE_DELTA_CUE_MPS, carriageDeg: 9, passPct: 70, floorPct: 55 },
  { lineM: 0.16, paceMps: 0.2, carriageDeg: 8, passPct: 75, floorPct: 62 },
  { lineM: 0.13, paceMps: 0.16, carriageDeg: M8_PITCH_BAND_DEG, passPct: 78, floorPct: 66 },
  { lineM: 0.1, paceMps: 0.13, carriageDeg: 6, passPct: 82, floorPct: 70 },
  // Level 5 floors = the Level-4 pass bands (the anti-gaming floor: declared
  // bands must sit at or tighter than these [DESIGN]).
  { lineM: 0.1, paceMps: 0.13, carriageDeg: 6, passPct: 82, floorPct: 82 },
];

export const CURRICULUM_LEVELS: ReadonlyArray<CurriculumLevel> = [
  {
    id: "L1",
    name: "THE LINE",
    namesake: "line",
    criteria: [
      "Tracks the center of the catwalk - lateral drift stays inside the Level 1 band for most of the walk.",
      "Holds a fixed focal point - head pitch and yaw steady inside the band.",
      "Keeps one felt tempo through the walk zone - speed inside a wide band around your own baseline.",
    ],
    cueOnly: [
      "One foot in front of the other along the invisible line - coached, never scored.",
      "Keep your gaze forward, never down - coached, never scored.",
      "Stand tall, long strides, easy arms - coached, never scored.",
    ],
    bands: LEVEL_BANDS[0],
  },
  {
    id: "L2",
    name: "THE WALK",
    namesake: "pace",
    criteria: [
      "Finds the new tempo quickly when the music changes and holds the band.",
      "Level 1 lines, narrower bands.",
    ],
    cueOnly: [
      "Don't lose the rhythm - coached, never scored.",
      "In heels: smaller steps, no lean, chin level - coached, never scored.",
    ],
    bands: LEVEL_BANDS[1],
  },
  {
    id: "L3",
    name: "THE TURN",
    namesake: "carriage",
    criteria: [
      "Decelerates into the mark and keeps the head still through the pose beat.",
      "The turn is unhurried - the head leaves the front last and settles onto the return walk early.",
    ],
    cueOnly: [
      "The pose's body line, hands and weight are your craft - coached, never scored.",
    ],
    bands: LEVEL_BANDS[2],
  },
  {
    id: "L4",
    name: "THE SHOW",
    namesake: "line",
    criteria: [
      "Holds Level 3 bands on the cold record - a later session, coaching off.",
      "Walk-to-walk spread stays inside the consistency band.",
    ],
    cueOnly: [
      "One terse line before the walk, nothing during - show conditions.",
    ],
    bands: LEVEL_BANDS[3],
  },
  {
    id: "L5",
    name: "THE SIGNATURE",
    namesake: null,
    criteria: [
      "You declare your own bands - at or tighter than Level 4 - and hold them.",
      "The record shows your declared band beside every score.",
    ],
    cueOnly: [
      "The signature itself - tempo character, carriage envelope - is yours to author.",
    ],
    bands: LEVEL_BANDS[4],
  },
];

/* ------------------------------------------------------------------------ */
/* Drills (v1 ships the three displayed-channel starters; the rest are      */
/* defined but wait on channel surfacing — the display-before-gate law)     */
/* ------------------------------------------------------------------------ */

export interface DrillDef {
  id: string;
  name: string;
  channel: CurriculumChannel;
  /** One-line learner blurb (F.40 draft; lineage lives in the docs/lineage
   * page, never in learner copy — the source-prominence law). */
  blurb: string;
  /** Rep length (s) — short blocked reps [F5 blocked-default; F1 structure]. */
  repSeconds: number;
  /** Reps per set [DESIGN inside the corroborated envelope]. */
  reps: number;
  /** False until the channel surfaces (D4-D8 wait on the founder call). */
  shipped: boolean;
}

export const DRILLS: ReadonlyArray<DrillDef> = [
  {
    id: "D1",
    name: "TAPE LINE",
    channel: "line",
    blurb: "Short line walks. Hold the center - the line score is the drill.",
    repSeconds: 15,
    reps: 4,
    shipped: true,
  },
  {
    id: "D2",
    name: "FOCAL POINT",
    channel: "carriage",
    blurb: "Full walks on one fixed point. The head holds it - the eyes are yours.",
    repSeconds: 20,
    reps: 3,
    shipped: true,
  },
  {
    id: "D3",
    name: "OWN TEMPO",
    channel: "pace",
    blurb: "Walk your baseline tempo, then hold a small deliberate offset.",
    repSeconds: 20,
    reps: 3,
    shipped: true,
  },
  { id: "D4", name: "THE MARK", channel: "carriage", blurb: "", repSeconds: 15, reps: 5, shipped: false },
  { id: "D5", name: "LEAVE LAST", channel: "carriage", blurb: "", repSeconds: 15, reps: 6, shipped: false },
  { id: "D6", name: "BEAT LOCK", channel: "pace", blurb: "", repSeconds: 20, reps: 3, shipped: false },
  { id: "D7", name: "THE CORNER", channel: "line", blurb: "", repSeconds: 18, reps: 4, shipped: false },
  { id: "D8", name: "THE INTERVAL", channel: "pace", blurb: "", repSeconds: 20, reps: 3, shipped: false },
];

export const SHIPPED_DRILLS: ReadonlyArray<DrillDef> = DRILLS.filter(
  (d) => d.shipped,
);

export function drillById(id: string | null | undefined): DrillDef | null {
  if (!id) return null;
  return DRILLS.find((d) => d.id === id) ?? null;
}

/* ------------------------------------------------------------------------ */
/* Time-in-band — the curriculum statistic [DESIGN; better teaching stat    */
/* than an EMA-mapped score: it says how much of the rep you held the skill] */
/* ------------------------------------------------------------------------ */

export interface TimeInBand {
  pace: number | null;
  line: number | null;
  carriage: number | null;
}

/**
 * Per-channel time-in-band (0-100 %) over a walk's recorded samples, against
 * one level's bands. A channel with fewer than MIN_TIB_SAMPLES usable
 * samples reads null (never a fabricated 0 or 100). PACE needs the run's
 * ideal pace (the mode target the walk was scored against).
 */
export const MIN_TIB_SAMPLES = 8;

export function timeInBand(
  samples: ReadonlyArray<MetricSample>,
  bands: LevelBands,
  idealPaceMps: number | null,
): TimeInBand {
  let lineIn = 0;
  let lineN = 0;
  let paceIn = 0;
  let paceN = 0;
  let carIn = 0;
  let carN = 0;
  for (const s of samples) {
    if (s.lateralM !== null && s.lateralM !== undefined && Number.isFinite(s.lateralM)) {
      lineN += 1;
      if (Math.abs(s.lateralM) <= bands.lineM) lineIn += 1;
    }
    if (
      idealPaceMps !== null &&
      Number.isFinite(idealPaceMps) &&
      s.paceMps !== null &&
      s.paceMps !== undefined &&
      Number.isFinite(s.paceMps)
    ) {
      paceN += 1;
      if (Math.abs(s.paceMps - idealPaceMps) <= bands.paceMps) paceIn += 1;
    }
    if (
      s.headPitchDeg !== null &&
      s.headPitchDeg !== undefined &&
      Number.isFinite(s.headPitchDeg)
    ) {
      carN += 1;
      if (Math.abs(s.headPitchDeg) <= bands.carriageDeg) carIn += 1;
    }
  }
  const pct = (a: number, n: number): number | null =>
    n >= MIN_TIB_SAMPLES ? Math.round((a / n) * 100) : null;
  return {
    pace: pct(paceIn, paceN),
    line: pct(lineIn, lineN),
    carriage: pct(carIn, carN),
  };
}

/* ------------------------------------------------------------------------ */
/* Cold-block evidence [F4/F7; conventions DESIGN]                           */
/* ------------------------------------------------------------------------ */

/** Rows must expose these to qualify as evidence (the recorder's rows do;
 * synthetic filtering is the CALLER's job via realScoredRows — the guard
 * that keeps Preview-Walk bots out of every record [spec §4]). */
export interface EvidenceRow {
  startedAt: number;
  /** The additive per-walk time-in-band stamp (absent on pre-Wave-4 rows —
   * legacy rows can never anchor a mastery record; honest, not lenient). */
  tib?: TimeInBand | null;
}

/** "A later session, at least a day apart - our convention" [DESIGN;
 * phrased as our rule, never a research threshold — F4 caveat]. */
export const COLD_GAP_MS = 20 * 3600 * 1000;
/** A new session starts after this much quiet [DESIGN]. */
export const SESSION_SPLIT_MS = 2 * 3600 * 1000;
/** One unscored re-entry walk + the median of the next three [DESIGN]. */
export const COLD_BLOCK_DISCARD = 1;
export const COLD_BLOCK_N = 3;

export interface ColdBlock {
  /** Median time-in-band per channel over the block's three scored walks. */
  median: TimeInBand;
  /** Epoch ms of the block's first evidence walk. */
  at: number;
  walks: number;
}

function median3(vals: number[]): number | null {
  if (vals.length < COLD_BLOCK_N) return null;
  const s = [...vals].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * The LATEST complete cold block in a row history (rows must be real-scored
 * and chronological — feed realScoredRows output). A session qualifies when
 * it starts >= COLD_GAP_MS after the previous walk; its first walk is the
 * unscored re-entry [DESIGN], the next three scored walks form the block.
 */
export function latestColdBlock(
  rows: ReadonlyArray<EvidenceRow>,
): ColdBlock | null {
  if (rows.length === 0) return null;
  // Split into sessions.
  const sessions: EvidenceRow[][] = [];
  let cur: EvidenceRow[] = [rows[0]];
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].startedAt - rows[i - 1].startedAt > SESSION_SPLIT_MS) {
      sessions.push(cur);
      cur = [];
    }
    cur.push(rows[i]);
  }
  sessions.push(cur);
  // Scan newest-first for a qualifying complete block.
  for (let si = sessions.length - 1; si >= 0; si -= 1) {
    const sess = sessions[si];
    const prevWalkAt =
      si > 0 ? sessions[si - 1][sessions[si - 1].length - 1].startedAt : null;
    if (prevWalkAt === null) continue; // the very first session is never cold
    if (sess[0].startedAt - prevWalkAt < COLD_GAP_MS) continue;
    const evidence = sess.slice(
      COLD_BLOCK_DISCARD,
      COLD_BLOCK_DISCARD + COLD_BLOCK_N,
    );
    if (evidence.length < COLD_BLOCK_N) continue;
    const chan = (k: CurriculumChannel): number | null =>
      median3(
        evidence
          .map((r) => (r.tib ? r.tib[k] : null))
          .filter((v): v is number => v !== null && Number.isFinite(v)),
      );
    return {
      median: { pace: chan("pace"), line: chan("line"), carriage: chan("carriage") },
      at: evidence[0].startedAt,
      walks: evidence.length,
    };
  }
  return null;
}

/* ------------------------------------------------------------------------ */
/* Gates [F12 mechanics; transfers + tightenings DESIGN]                     */
/* ------------------------------------------------------------------------ */

export interface GateVerdict {
  levelId: string;
  pass: boolean;
  /** Per-channel {value, needed} the copy renders — every gate names its
   * channel, band and evidence [spec §4]. */
  detail: Array<{ channel: CurriculumChannel; value: number | null; needed: number }>;
}

/** Evaluate one level's gate against a cold block. Floors first; the
 * namesake channel is non-compensable (its bar IS the pass bar) [DESIGN].
 * A missing channel value never passes (display-before-gate: no invisible
 * evidence). Level 5 (namesake null) is declared-band territory and always
 * reads not-yet here [DESIGN — declaration UI is its own later pass]. */
export function evaluateGate(
  level: CurriculumLevel,
  block: ColdBlock | null,
): GateVerdict {
  const detail = DISPLAYED_CHANNELS.map((channel) => ({
    channel,
    value: block ? block.median[channel] : null,
    needed:
      channel === level.namesake ? level.bands.passPct : level.bands.floorPct,
  }));
  const pass =
    level.namesake !== null &&
    block !== null &&
    detail.every((d) => d.value !== null && d.value >= d.needed);
  return { levelId: level.id, pass, detail };
}

/** The highest level whose gate passes on the current cold block (soft
 * recommendation — the app never hard-blocks [DESIGN]). Returns the level
 * INDEX the walker has evidence for (-1 = none yet). */
export function recommendedLevelIndex(block: ColdBlock | null): number {
  let idx = -1;
  for (let i = 0; i < CURRICULUM_LEVELS.length; i += 1) {
    if (evaluateGate(CURRICULUM_LEVELS[i], block).pass) idx = i;
    else break;
  }
  return idx;
}

/** "Not yet" gate copy [F.40 draft — never the word the spec bans]. */
export function gateCopy(v: GateVerdict, levelName: string): string {
  if (v.pass) {
    return `${levelName}: held cold - a later session, three walks.`;
  }
  const worst = v.detail
    .filter((d) => d.value === null || d.value < d.needed)
    .map((d) => `${d.channel.toUpperCase()} ${d.value === null ? "-" : d.value} of ${d.needed}`)
    .join(" · ");
  return `Not yet. Your record stands at ${worst || "no cold walks yet"}.`;
}

/* ------------------------------------------------------------------------ */
/* The planner [session shape spec §3]                                       */
/* ------------------------------------------------------------------------ */

export interface PlanRow extends EvidenceRow {
  overall?: number | null;
}

/** Weakest DISPLAYED channel over the last N real walks' time-in-band
 * (never composites, never hidden channels [spec §3/§4]); null until
 * enough stamped rows exist. */
export const PLAN_WINDOW = 5;

export function weakestChannel(
  rows: ReadonlyArray<PlanRow>,
): CurriculumChannel | null {
  const recent = rows.slice(-PLAN_WINDOW);
  let worst: CurriculumChannel | null = null;
  let worstMean = Infinity;
  for (const channel of DISPLAYED_CHANNELS) {
    const vals = recent
      .map((r) => (r.tib ? r.tib[channel] : null))
      .filter((v): v is number => v !== null && Number.isFinite(v));
    if (vals.length < 2) continue;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (mean < worstMean) {
      worstMean = mean;
      worst = channel;
    }
  }
  return worst;
}

/** The drill the plan recommends for a channel (shipped drills only). */
export function drillForChannel(
  channel: CurriculumChannel | null,
): DrillDef | null {
  if (!channel) return null;
  return SHIPPED_DRILLS.find((d) => d.channel === channel) ?? null;
}

/** Today's session line (F.40 draft): warm-up -> weakest drill -> full walk
 * -> review [F4/F5/F6/F7 shapes; wording DESIGN]. */
export function planCopy(channel: CurriculumChannel | null): string {
  const drill = drillForChannel(channel);
  if (!drill) {
    return "Today: one easy opener, a few walks, then review the replay.";
  }
  return `Today: one easy opener - ${drill.reps} reps of ${drill.name} - one full walk - review.`;
}

/* ------------------------------------------------------------------------ */
/* Honesty disclosures (F.40 drafts, spec §5 — verbatim from the reviewed   */
/* design; tags/qualifiers must survive founder rewrite)                    */
/* ------------------------------------------------------------------------ */

export const CURRICULUM_DISCLOSURES: ReadonlyArray<string> = [
  "(X)RUNWAY measures your head's position and orientation - six degrees of freedom - and derives your pace, path, and rhythm from that motion. It does not see your eyes, feet, hips, arms, or face, and it will never score what it cannot see. When a cue mentions those, it is coaching craft, not measurement.",
  "Your Mastery Record comes from cold walks - the first walks of a later session, at least a day apart (our convention), coaching off. Research on motor learning suggests that is a better indicator of what you've kept than your best in-session score. Both numbers are yours; only the cold one advances the record.",
  "This is practice equipment, not career preparation. We make no signing or career claims. No one can guarantee you work; anyone who promises it is showing you a warning sign, not an opportunity.",
  "Tempo targets are relative to your own baseline and delivered as music you feel, not numbers you chase.",
  "Every drill on this syllabus names where it comes from - a named coach practice, a published study, or our own design choice, labeled as exactly that.",
  "A record is practice, not a verdict. A runway walk is judged by human eyes - show it to people, not only to us. A mirror, a video, a coach see the whole body this headset cannot.",
  "Heels raise the stakes. Clear your runway, set your boundary, and finish the flat-shoe level first. No score is worth a fall.",
];

/* ------------------------------------------------------------------------ */
/* Do-not-print lint data (spec §0 lint law — enforced by the test suite)   */
/* ------------------------------------------------------------------------ */

/** Words banned from SCORED criteria strings (head-kinematics-only law).
 * Cue-only strings, proxy statements and the disclosures deliberately name
 * these — the ban is on scoring language only. */
export const BANNED_IN_CRITERIA: ReadonlyArray<string> = [
  "gaze",
  "eye",
  "face",
  "feet",
  "foot",
  "hip",
  "arm",
  "expression",
];

/** Phrases banned from ALL learner-facing curriculum strings. ("Guarantee"
 * is deliberately absent: Disclosure 3 uses it inside the anti-scam WARNING
 * — the ban is on making guarantees, which the fail/certificate/standard
 * items cover.) */
export const BANNED_EVERYWHERE: ReadonlyArray<string> = [
  "objective",
  "industry standard",
  "as taught at",
  "John Casablancas",
  "Wilhelmina",
  "certified",
  "certificate",
  "fail",
];
