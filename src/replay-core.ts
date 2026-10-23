/**
 * (X)RUNWAY — Replay Theater, the pure core (Build: REPLAY THEATER).
 *
 * Turns one recorded walk (session-recorder.ts MetricSample series) into a
 * playable ghost track plus the coaching markers for the moments the walk
 * lost points. DISPLAY-ONLY by construction: nothing here feeds scoring —
 * it reads the engine's own moment-level thresholds (imported, never
 * re-derived) and the samples the recorder already persisted.
 *
 * Dependency-free of @iwsdk/core and the DOM (the walk-stats.ts pattern) so
 * it loads in vitest; the ECS/render side lives in replay-theater.ts.
 *
 * Threshold provenance (the brief's law — read, never re-derive):
 * - LINE marker: |lateralM| > LATERAL_CUE_M (coach-live.ts — the same gate
 *   the live coach's "center up" cue used).
 * - PACE marker: |paceMps - idealPaceMps| > PACE_DELTA_CUE_MPS
 *   (coach-live.ts — derived there from the pace score slope).
 * - HEAD marker: headPitchDeg <= M8_GLANCE_PITCH_DEG (head-carriage.ts —
 *   the M8 head-drop line; one marker per dip, like the glance counter).
 * - PACE/LINE markers honor the live coach's OWN suppression windows
 *   (coach-live.ts): the SETTLE window (faults never even accumulate before
 *   SETTLE_SEC), the FINAL guard (nothing cues in the last FINAL_GUARD_SEC),
 *   and the turn/pose beat (cues are CLEARED for TURN_SUPPRESS_SEC after the
 *   mark — the hold + turn's pace~0 / swinging lateral is choreography, not
 *   a fault). The mark time is read from the record's OWN turn stamp
 *   (turn.startAtSec, which opens at most HOLD_WINDOW_SEC after arrival —
 *   both engine constants). HEAD keeps the whole walk: M8 counts glances
 *   from t=0 (its own semantics).
 */

import {
  FINAL_GUARD_SEC,
  LATERAL_CUE_M,
  PACE_DELTA_CUE_MPS,
  SETTLE_SEC,
  TURN_SUPPRESS_SEC,
} from "./coach-live.js";
import { M8_GLANCE_PITCH_DEG } from "./head-carriage.js";
import { HOLD_WINDOW_SEC } from "./hold-stats.js";
import { METRIC_COACH } from "./coach.js";
import type { MetricSample } from "./session-recorder.js";

/** One playable ghost point (a recorded sample that carried the runway-frame
 * position channels). Times are seconds since walk start. */
export interface ReplayPoint {
  t: number;
  /** Route-along distance (m) — the same globalAlong projectRoute reported. */
  along: number;
  /** SIGNED centerline offset (m), projectRoute sign convention. */
  lateral: number;
  /** M8 live head-pitch deviation (deg, + = above neutral), or null. */
  pitchDeg: number | null;
  /** Smoothed true speed (m/s), or null. */
  paceMps: number | null;
}

export interface ReplayTrack {
  points: ReplayPoint[];
  /** Playback length (s) — the last point's time. */
  duration: number;
}

/** The interpolated ghost state at one playback time. */
export interface ReplayPose {
  along: number;
  lateral: number;
  pitchDeg: number;
  /** Interpolated speed (m/s, >= 0) — drives the gait bob. */
  speed: number;
  /** Along direction of travel: +1 outbound, -1 returning (last non-zero). */
  dir: number;
}

export type ReplayMarkerKind = "line" | "pace" | "head";

/** One coaching marker: a moment the walk lost points, placed where it
 * happened. `t` / `along` / `lateral` are the PEAK-deviation sample of one
 * contiguous violation event (consecutive violating samples cluster into a
 * single marker — a 2 s drift is one ring, not twelve). */
export interface ReplayMarker {
  kind: ReplayMarkerKind;
  t: number;
  along: number;
  lateral: number;
  /** How far past the gate the peak sample was (same unit as the gate). */
  severity: number;
}

/** Markers kept per kind (most severe win) — a replay is a coaching beat,
 * not a scatter plot. */
export const REPLAY_MAX_MARKERS_PER_KIND = 4;

// -- Coached moments (research finding 5: novices need what-to-look-for
//    scaffolding on top of raw replay). As the ghost NEARS a ring the tape
//    auto-ramps to half speed and one line of the engine's own coach copy
//    names what to watch; the user's explicit speed choice always wins.
/** Seconds before a ring's moment the coach ramp engages. */
export const REPLAY_COACH_LEAD_SEC = 1.2;
/** Seconds after the moment before the tape returns to the user's speed. */
export const REPLAY_COACH_HOLD_SEC = 0.8;
/** The one-line what-to-watch cue per marker kind. PACE/LINE are the
 * engine's own METRIC_COACH lines verbatim (coach.ts); the HEAD line is
 * drafted (F.36 — the M8 head-drop moment has no summary-note twin). */
export const REPLAY_CUE_TEXT: Readonly<Record<ReplayMarkerKind, string>> = {
  pace: METRIC_COACH.pace,
  line: METRIC_COACH.footPlacement,
  head: "Chin level - eyes on the far wall, never the floor.",
};

// -- THE WALK TRACE (slate 2026-07-27, wave 1: the LINE score made
//    geometric). The recorded head path is drawn on the deck beside the
//    centerline rail; segments past the engine's own LATERAL_CUE_M gate
//    grade amber. Pace ticks at fixed TAPE intervals make rhythm visible:
//    bunched ticks = slow stretch, stretched ticks = rushing.

/** Tape seconds between pace ticks on the floor trace. */
export const TRACE_TICK_SEC = 1.0;

/** One trace vertex-sample: a recorded point + its over-the-cue-line flag. */
export interface TracePoint {
  t: number;
  along: number;
  lateral: number;
  /** True where |lateral| crossed the SAME gate the LINE markers use. */
  warn: boolean;
}

/** The floor-trace samples for one track (1:1 with track points). */
export function traceFromTrack(track: ReplayTrack): TracePoint[] {
  return track.points.map((p) => ({
    t: p.t,
    along: p.along,
    lateral: p.lateral,
    warn: Math.abs(p.lateral) > LATERAL_CUE_M,
  }));
}

export interface TraceTick {
  t: number;
  along: number;
  lateral: number;
}

/** Pace ticks: the interpolated pose at every whole TRACE_TICK_SEC of tape.
 * Equal TIME spacing means the ALONG spacing encodes speed. */
export function traceTicks(track: ReplayTrack): TraceTick[] {
  const out: TraceTick[] = [];
  const cur = { i: 0 };
  const pose: ReplayPose = {
    along: 0,
    lateral: 0,
    pitchDeg: 0,
    speed: 0,
    dir: 1,
  };
  for (let t = TRACE_TICK_SEC; t < track.duration; t += TRACE_TICK_SEC) {
    trackPoseAt(track, t, cur, pose);
    out.push({ t, along: pose.along, lateral: pose.lateral });
  }
  return out;
}

// -- COACHED-MOMENT DETAIL + THE NEXT-WALK RECAP (slate wave 2) -----------
// The rings already slow the tape and say WHAT to watch; the detail line
// adds the measured value against the engine's own bar — teaching the
// STANDARD, not just the miss. Copy F.39 (draft-and-tag).

/** The second line under a coached-moment cue: the peak measured value vs
 * the engine's own gate (marker.severity is how far PAST the gate the peak
 * was — same unit as the gate, see replayMarkers). */
export function markerDetail(m: ReplayMarker): string {
  if (m.kind === "line") {
    const v = LATERAL_CUE_M + m.severity;
    return `${v.toFixed(2)} M OFF CENTER - THE CUE LINE IS ${LATERAL_CUE_M.toFixed(2)}`;
  }
  if (m.kind === "pace") {
    const v = PACE_DELTA_CUE_MPS + m.severity;
    return `${v.toFixed(2)} M/S OFF TEMPO - THE CUE LINE IS ${PACE_DELTA_CUE_MPS.toFixed(2)}`;
  }
  const pitch = M8_GLANCE_PITCH_DEG - m.severity;
  return `CHIN ${Math.abs(Math.round(pitch))} DEG DOWN - THE GLANCE LINE IS ${Math.abs(M8_GLANCE_PITCH_DEG)}`;
}

/** Heading over the post-replay recap block (F.39). */
export const RECAP_HEADING = "PRACTICE NEXT";

/** The next-walk recap: each marker KIND's what-to-watch cue, once, in
 * first-moment order — replay only teaches when it ends in an action list
 * (research finding 5). */
export function recapCues(markers: ReadonlyArray<ReplayMarker>): string[] {
  const seen = new Set<ReplayMarkerKind>();
  const out: string[] = [];
  for (const m of [...markers].sort((a, b) => a.t - b.t)) {
    if (seen.has(m.kind)) continue;
    seen.add(m.kind);
    out.push(REPLAY_CUE_TEXT[m.kind]);
  }
  return out;
}

/**
 * Build the playable track from a walk's recorded samples. Returns null when
 * the walk is not replayable: fewer than 2 samples carried the runway-frame
 * along/lateral channels (camera-owned walks record them null, and legacy
 * records predate alongM entirely) — the surfaces hide the REPLAY control.
 */
export function buildReplayTrack(
  samples: ReadonlyArray<MetricSample>,
): ReplayTrack | null {
  const points: ReplayPoint[] = [];
  for (const s of samples) {
    const along = s.alongM;
    const lateral = s.lateralM;
    if (
      along === null ||
      along === undefined ||
      lateral === null ||
      !Number.isFinite(along) ||
      !Number.isFinite(lateral) ||
      !Number.isFinite(s.t)
    ) {
      continue;
    }
    // Times must be non-decreasing for the interpolator; the recorder stamps
    // a monotonic clock, so an out-of-order time is a corrupt record — drop it.
    if (points.length > 0 && s.t < points[points.length - 1].t) continue;
    points.push({
      t: s.t,
      along,
      lateral,
      pitchDeg:
        s.headPitchDeg !== null && Number.isFinite(s.headPitchDeg)
          ? s.headPitchDeg
          : null,
      paceMps:
        s.paceMps !== null && Number.isFinite(s.paceMps) ? s.paceMps : null,
    });
  }
  if (points.length < 2) return null;
  return { points, duration: points[points.length - 1].t };
}

/**
 * Interpolated ghost state at playback time `t` (clamped to the track).
 * Writes into `out` (zero-allocation update loops); returns `out`.
 * `cursorRef.i` is a monotonic segment cursor the caller keeps across frames
 * (reset to 0 when seeking backwards / restarting).
 */
export function trackPoseAt(
  track: ReplayTrack,
  t: number,
  cursorRef: { i: number },
  out: ReplayPose,
): ReplayPose {
  const pts = track.points;
  const n = pts.length;
  if (cursorRef.i < 0 || cursorRef.i >= n - 1) cursorRef.i = 0;
  // Advance the cursor to the segment containing t (samples are ~6 Hz, so
  // this is a couple of steps per frame at most).
  while (cursorRef.i < n - 2 && pts[cursorRef.i + 1].t <= t) cursorRef.i++;
  const a = pts[cursorRef.i];
  const b = pts[cursorRef.i + 1];
  const span = b.t - a.t;
  const u = span > 1e-6 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0;
  out.along = a.along + (b.along - a.along) * u;
  out.lateral = a.lateral + (b.lateral - a.lateral) * u;
  const ap = a.pitchDeg ?? 0;
  const bp = b.pitchDeg ?? ap;
  out.pitchDeg = ap + (bp - ap) * u;
  const av = a.paceMps ?? 0;
  const bv = b.paceMps ?? av;
  out.speed = Math.max(0, av + (bv - av) * u);
  const dAlong = b.along - a.along;
  if (Math.abs(dAlong) > 1e-4) out.dir = dAlong > 0 ? 1 : -1;
  else if (out.dir !== -1 && out.dir !== 1) out.dir = 1;
  return out;
}

/**
 * The coaching markers for one walk: cluster each kind's contiguous
 * violation runs into single events (marker at the run's peak deviation),
 * then keep the REPLAY_MAX_MARKERS_PER_KIND most severe per kind, returned
 * in time order. `idealPaceMps` comes from the walk's own stats
 * (WalkStats.idealPaceMps — the mode target locked at walk start); null
 * disables the pace kind (nothing to be outside of).
 */
export function replayMarkers(
  samples: ReadonlyArray<MetricSample>,
  idealPaceMps: number | null,
  turnStartAtSec: number | null = null,
): ReplayMarker[] {
  const out: ReplayMarker[] = [];
  const duration = samples.length > 0 ? samples[samples.length - 1].t : 0;
  // The coach's cueable window (header): settle → final guard, minus the
  // pose/turn beat when the record measured one. turn.startAtSec opens at
  // most HOLD_WINDOW_SEC after the mark arrival, so the excluded band
  // [start - HOLD_WINDOW_SEC, start + TURN_SUPPRESS_SEC] covers the
  // coach's own [mark, mark + TURN_SUPPRESS_SEC] clear.
  const cueable = (t: number): boolean => {
    if (t < SETTLE_SEC) return false;
    if (t > duration - FINAL_GUARD_SEC) return false;
    if (
      turnStartAtSec !== null &&
      Number.isFinite(turnStartAtSec) &&
      t >= turnStartAtSec - HOLD_WINDOW_SEC &&
      t <= turnStartAtSec + TURN_SUPPRESS_SEC
    ) {
      return false;
    }
    return true;
  };
  collectKind(
    samples,
    "line",
    (s) =>
      cueable(s.t) &&
      s.lateralM !== null &&
      Number.isFinite(s.lateralM) &&
      Math.abs(s.lateralM) > LATERAL_CUE_M
        ? Math.abs(s.lateralM) - LATERAL_CUE_M
        : null,
    out,
  );
  if (idealPaceMps !== null && Number.isFinite(idealPaceMps)) {
    collectKind(
      samples,
      "pace",
      (s) =>
        cueable(s.t) &&
        s.paceMps !== null &&
        Number.isFinite(s.paceMps) &&
        Math.abs(s.paceMps - idealPaceMps) > PACE_DELTA_CUE_MPS
          ? Math.abs(s.paceMps - idealPaceMps) - PACE_DELTA_CUE_MPS
          : null,
      out,
    );
  }
  collectKind(
    samples,
    "head",
    (s) =>
      s.headPitchDeg !== null &&
      Number.isFinite(s.headPitchDeg) &&
      s.headPitchDeg <= M8_GLANCE_PITCH_DEG
        ? M8_GLANCE_PITCH_DEG - s.headPitchDeg
        : null,
    out,
  );
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Cluster one kind's contiguous violating samples into peak-deviation
 * events and append the capped, most-severe set to `out`. A marker needs a
 * position: samples without along/lateral never mark (they can't be placed
 * on the runway — the camera-image path). */
function collectKind(
  samples: ReadonlyArray<MetricSample>,
  kind: ReplayMarkerKind,
  severityOf: (s: MetricSample) => number | null,
  out: ReplayMarker[],
): void {
  const events: ReplayMarker[] = [];
  let open: ReplayMarker | null = null;
  for (const s of samples) {
    const along = s.alongM;
    const lateral = s.lateralM;
    const placeable =
      along !== null &&
      along !== undefined &&
      lateral !== null &&
      Number.isFinite(along) &&
      Number.isFinite(lateral);
    const sev = placeable ? severityOf(s) : null;
    if (sev === null) {
      if (open !== null) {
        events.push(open);
        open = null;
      }
      continue;
    }
    if (open === null) {
      open = { kind, t: s.t, along: along!, lateral: lateral!, severity: sev };
    } else if (sev > open.severity) {
      open.severity = sev;
      open.t = s.t;
      open.along = along!;
      open.lateral = lateral!;
    }
  }
  if (open !== null) events.push(open);
  events.sort((a, b) => b.severity - a.severity);
  for (
    let i = 0;
    i < events.length && i < REPLAY_MAX_MARKERS_PER_KIND;
    i++
  ) {
    out.push(events[i]);
  }
}
