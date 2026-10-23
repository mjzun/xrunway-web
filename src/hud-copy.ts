/**
 * (X)RUNWAY — XR lesson-panel copy (pure strings + line-selection helpers).
 *
 * Every dynamic string HUDSystem / MappingSystem pushes onto the XR panel
 * lives here (or in the shared coach.ts / modes.ts / metrics.ts copy) so the
 * panel font's hard constraint is enforceable by test: the uikit MSDF font
 * ships NO middle-dot, em-dash or curly-quote glyphs — they render as tofu
 * boxes at the exact teaching moments (POLISH-AUDIT #31). ui/lesson.uikitml
 * states the same rule in its header; test/panel-ascii.test.ts walks this
 * module's exports AND the markup file and fails on any non-ASCII character.
 *
 * Pure data + functions only (no @iwsdk/core import) so vitest loads it —
 * the hud-state.ts pattern.
 */

/** Mid-walk far-end cue on an out-and-back route (#31: ASCII only).
 * Founder C9.1 (2026-07-09, verbatim). */
export const TURN_BACK_CUE = "Pose... then walk back";

// ---------------------------------------------------------------------------
// #17 — walk-and-place mapping guidance. The flow used to leave the trainee
// unguided: the adjust controls (right-stick width, A commit) were documented
// nowhere, and a rejected too-short far end was silently swallowed.
// ---------------------------------------------------------------------------

/** Live-mapping mode while mapping is ACTIVE (mirrors globals.mapMode minus "off"). */
export type PanelMapMode = "placing-start" | "placing-end" | "adjust";

/** Big prompt per mapping mode — WHAT to do now. The adjust prompt names its
 * INPUTS in the big type (the Quest tester's catch: two prompts teach PRESS
 * TRIGGER, then the input vocabulary changed exactly where the big type
 * stopped naming buttons — width/A lived only in the small grey note).
 * Control tokens only, no prose (the no-AI-text law's mechanical-label
 * class); the founder rewrite rides the copy worksheet (C10.3). */
export const MAP_PROMPTS: Record<PanelMapMode, string> = {
  "placing-start": "STAND AT YOUR START - PRESS TRIGGER",
  "placing-end": "WALK TO THE END - PRESS TRIGGER",
  adjust: "WIDTH: RIGHT STICK - LOCK IN: A OR CONFIRM",
};

/** How-to note under the prompt — HOW to do it (and what just happened).
 * The adjust step is where the undocumented controls live: right-stick width
 * nudge + A-button commit (mapping.ts implements both). */
export const MAP_NOTES: Record<PanelMapMode, string> = {
  "placing-start":
    "Point at the floor with your right controller - the trigger drops your start point. CANCEL exits.",
  "placing-end":
    "Start placed. Walk to the far end and drop it with the trigger - at least 0.4 m from the start.",
  adjust:
    "Right stick left/right sets the width. Press A or CONFIRM to lock it in, CANCEL to discard.",
};

/** Flashed over the prompt when a placed far end lands too close to the start
 * (mapping.ts rejects anything under 0.4 m) — what went wrong, what to do. */
export const MAP_TOO_SHORT_NOTICE = "TOO SHORT - KEEP WALKING";

/** Flashed over the prompt when the LEFT X/Y fit-to-room arm fires mid-
 * mapping (mapping.ts refuses it — a landed fit would force-cancel the flow
 * and discard the placed points). House rule #17: the press DID fire, so say
 * why nothing happened. PROVISIONAL wording — carries a COPY-WORKSHEET row
 * (F.22) for founder sign-off, the MAP_* / C10.3 precedent. */
export const MAP_FIT_BLOCKED_NOTICE = "MAPPING ACTIVE - CONFIRM OR CANCEL FIRST";

/** One-shot mapping notice published as globals.mapNotice. A FRESH object per
 * event (seq bumps) so an identical rejection still re-fires subscribers. */
export interface MapNotice {
  text: string;
  seq: number;
}

// ---------------------------------------------------------------------------
// #32/#46 — tracking-source transparency. The metrics hot-swap between the
// external camera skeleton and head-only derivation mid-walk; the trainee
// being scored could never see which source their numbers came from (the
// desktop landing's pill + drop toast are invisible from inside the headset).
// ---------------------------------------------------------------------------

/** Footer TRACKING line: which body-tracking source is scoring right now.
 * `cameraActive` is globals.trackerActive mid-walk (MetricsSystem's
 * authoritative per-frame flag) or the tracker's staleness window otherwise;
 * `space` distinguishes the native ARKit world stream (true meters) from the
 * browser image stream (camera-relative proxy). */
export function trackingSourceLabel(
  cameraActive: boolean,
  space: "image" | "world" | null | undefined,
): string {
  if (!cameraActive) return "HEAD ONLY";
  return space === "world" ? "CAMERA (ARKIT)" : "CAMERA";
}

/** Brief phase-line cues on a mid-walk camera drop / reconnect (edge-driven;
 * the footer line flips to the detail at the same moment). */
export const CAMERA_DROP_CUE = "CAMERA DROPPED - HEAD ONLY";
export const CAMERA_BACK_CUE = "CAMERA BACK";

// ---------------------------------------------------------------------------
// First-run in-headset TUTORIAL (2026-07-11). The audit confirmed EVERY piece
// of teaching (metric meaning, the head-only honesty, where the mark is, the
// controls) lived only on the desktop landing and showed at most once — a
// headset-first trainee was dropped onto the brief with nothing. These six
// cards are the in-headset first-run guide, driven by HUDSystem into the fixed
// #tutorial-section elements (the MAP_PROMPTS pattern — copy lives here so the
// panel-ascii sweep + a drift test can pin it, the markup stays static).
//
// Order = a runway coach's real first lesson (welcome -> map -> carriage ->
// line -> pace -> ready); each card teaches ONE concept and frames its metric
// as the HEAD-MOTION PROXY it honestly is (never feet, spine, face or arms —
// the methodology.html cardinal law). DRAFTED-BY-CLAUDE, tagged for founder
// VETO/REWRITE in docs/COPY-WORKSHEET.md (F.23); the honest spine is cited
// there (Campbell focal point, Backstage "invisible line", ~125 spm, the
// countdown-stand carriage baseline in head-carriage.ts).
// ---------------------------------------------------------------------------

export interface TutorialStep {
  /** Carolina accent kicker (the web .kicker voice) — the concept's metric or beat. */
  readonly kicker: string;
  /** Hero line — the coaching cue in plain words. */
  readonly title: string;
  /** One short paragraph: the cue + the HONEST head-only read. uikit wraps it. */
  readonly body: string;
}

/** The eight first-run cards. Index 1 (MAKE IT YOURS) carries the live
 * preference pills (founder call 2026-07-16: the web-to-headset jump is harsh
 * for VR novices - welcome them and let them set their toggles FIRST, inside
 * the same single guided flow, before any walk). Index 5 (PACE) carries the
 * animated cadence track. THE TURN card (6) was added on the runway coach's
 * P0 review call: the pose + turn + return is half a runway pass and was
 * previously only eight words on the PACE card. */
export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    kicker: "WELCOME",
    title: "You are the model.",
    body: "This is your runway, on your real floor. Point your right controller and pull the trigger to pick a button, or press A to move on. This first walk is just practice - it is for learning, not passing. Already walk? Tap Skip.",
  },
  {
    kicker: "MAKE IT YOURS",
    title: "Set the show up your way.",
    body: "Point and pull the trigger to change any of these - music, tempo, the felt beat pulse, your walk length, your level. The defaults are ready to go, and everything here can be changed later under SETTINGS.",
  },
  {
    kicker: "YOUR RUNWAY",
    title: "Walk your own floor.",
    body: "Press MAP to place the runway on your real floor, or Left X or Y to fit it to your room. No setup needed - a default runway is ready when you are.",
  },
  {
    kicker: "CARRIAGE",
    title: "Stand tall, eyes up.",
    body: "Lift through the top of your head and keep your chin level. Fix your eyes on the mark at the far end, never on your feet. The headset scores how level your head stays.",
  },
  {
    kicker: "LINE",
    title: "Walk one straight line.",
    body: "Put one foot in front of the other, straight down the center, as if along a thin invisible line. The headset scores how closely your head tracks that line.",
  },
  {
    kicker: "PACE",
    title: "Find a steady beat.",
    body: "Take long strides and hold a steady rhythm - do not rush. Long, controlled strides read as confidence. The headset scores your head speed against the target.",
  },
  {
    kicker: "THE TURN",
    title: "Hit your mark, then turn.",
    body: "At the mark, plant and hold your pose for a count of three - that is where the cameras fire. Then turn smoothly, letting your head come around last, and walk it home at the same pace.",
  },
  {
    kicker: "READY",
    title: "Take the first step.",
    body: "During the countdown, stand tall and still - that sets your baseline. We score PACE, CARRIAGE and LINE from head motion only, nothing else. Now own it - press START and take the next step.",
  },
];

/** The MAKE IT YOURS card (index 1) — the one screen with the live preference
 * pills (music / tempo / beat pulse / duration / level), wired in hud.ts to
 * the SAME shared signals the settings pills write. */
export const TUTORIAL_PREFS_STEP = 1;

/** The PACE card (index 5) — the one screen with the animated cadence track. */
export const TUTORIAL_PACE_STEP = 5;

/** The CARRIAGE card (index 3) — the one screen with the LIVE head-level
 * indicator (the learn-by-doing beat: the trainee lifts/drops their chin and a
 * marker responds in real time, proving the headset sees their head before any
 * score is at stake). See TUT_LEVEL_LABELS + the hud.ts update() head-pitch
 * read. */
export const TUTORIAL_CARRIAGE_STEP = 3;

/** Live head-level indicator labels (the CARRIAGE card's learn-by-doing beat).
 * Three states off the LIVE head pitch (read from player.head each frame) vs
 * the +-M8_PITCH_BAND_DEG level band: "level" when the head is within the band,
 * else a directional correction. HEAD CARRIAGE, never gaze — "chin" names head
 * orientation (the eyes are not tracked). ASCII (panel-swept by
 * panel-ascii.test.ts). DRAFTED-BY-CLAUDE, founder VETO/REWRITE via
 * docs/COPY-WORKSHEET.md F.26. */
export const TUT_LEVEL_LABELS = {
  /** Head pitch within the band — the marker + zone glow Carolina. */
  level: "HEAD LEVEL",
  /** Chin dropped below the band (head pitched down toward the deck). */
  low: "LIFT YOUR CHIN",
  /** Chin raised above the band (head pitched up off the far wall). */
  high: "EASE YOUR CHIN DOWN",
} as const;

/** The live-level state key (shared by hud.ts + the drift test). */
export type TutLevelState = keyof typeof TUT_LEVEL_LABELS;

/** Advance-pill label: "Next" on every card except the last, which closes. */
export const TUTORIAL_NEXT_LABEL = "Next";
export const TUTORIAL_DONE_LABEL = "Done";

// ---------------------------------------------------------------------------
// #15 — fit-to-room status. The most likely first-run failure (no saved Quest
// Space / denied spatial-data permission) used to produce ONE console.info the
// trainee can never see; these lines surface the fit lifecycle on the panel.
// ---------------------------------------------------------------------------

/** Fit-to-room lifecycle, published as globals.fitStatus. MappingSystem writes
 * the edges (arm / timeout / fit landed / manual-map override); the HUD renders
 * the line. "idle" = no line shown. */
export type FitStatus = "idle" | "searching" | "no-floor" | "fitted";

// ---------------------------------------------------------------------------
// #20/#48 + night-review — the brief's coach-voice mention must tell the
// truth about the CURRENT audio state: the walk is silent when COACH VOICE is
// toggled off, and equally silent when the music mute law (#6) covers it.
// Both brief surfaces (XR panel #brief-coach + landing #mode-coachline)
// render one of these from the live coachPrefs + musicPrefs signals.
// ---------------------------------------------------------------------------

/** Coach on + music audible: the promise holds. */
export const COACH_LINE_ON =
  "Your coach speaks during the walk - toggle in settings.";
/** Coach toggled off: state the fact and where to change it. */
export const COACH_LINE_OFF = "Coach voice is off - toggle in settings.";
/** Coach on, but the music mute law silences it (music off OR volume 0). */
export const COACH_LINE_MUTED = "Coach voice muted with music.";

/** Select the honest brief line for the current prefs. "Audible" mirrors the
 * sfxLevel() law exactly: enabled AND volume > 0 — volume 0 IS mute (#6). */
export function coachPromiseLine(
  coachEnabled: boolean,
  music: { enabled: boolean; volume: number },
): string {
  if (!coachEnabled) {
    return COACH_LINE_OFF;
  }
  return music.enabled && music.volume > 0 ? COACH_LINE_ON : COACH_LINE_MUTED;
}

// ---------------------------------------------------------------------------
// Wave 1 FIT SESSION — body-baseline status lines (XR settings row + landing
// card). NOTE: `FitStatus` above belongs to the floor fit-to-room flow; the
// body-fit surface is namespaced bodyFit*/fitBaseline* (the collision the
// spec warns about). HONESTY LAW (§K): standHeightM is standing HEAD height
// (headset above the registered floor) — the copy says "HEAD HEIGHT", never
// body height.
// ---------------------------------------------------------------------------

/** Whole days since the capture (0 = under 24 h). Non-finite/future-junk
 * clamps to 0 — the record was already sanitized, this is display-only. */
export function fitAgeDays(capturedAtMs: number, nowMs: number): number {
  const d = Math.floor((nowMs - capturedAtMs) / 86_400_000);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/** XR settings-row status: "Fit: not set" | "Fit: set today" |
 * "Fit: set <n>d ago" (spec §6 — short, panel-width friendly). */
export function fitPanelStatusLine(
  capturedAtMs: number | null,
  nowMs: number,
): string {
  if (capturedAtMs === null) return "Fit: not set";
  const days = fitAgeDays(capturedAtMs, nowMs);
  return days === 0 ? "Fit: set today" : `Fit: set ${days}d ago`;
}

/** The measured fields the landing status line renders (a BodyBaseline
 * subset — kept structural so this module stays import-light). */
export interface FitStatusFields {
  capturedAt: number;
  standHeightM: number;
  bobAmpM: number;
  paceMps: number;
}

/** Landing FIT-card status line (spec §6 + §K label correction): the
 * no-baseline fact, or the capture age + the three headline measurements —
 * "HEAD HEIGHT 1.72 M, BOB 12 MM, PACE 0.94 M/S." ASCII only. */
export function fitCardStatusLine(
  b: FitStatusFields | null,
  nowMs: number,
): string {
  if (b === null) {
    return "FIT: NOT SET - scores use the standard body baseline.";
  }
  const days = fitAgeDays(b.capturedAt, nowMs);
  const when =
    days === 0 ? "TODAY" : days === 1 ? "1 DAY AGO" : `${days} DAYS AGO`;
  const height = b.standHeightM.toFixed(2);
  const bobMm = Math.round(b.bobAmpM * 1000);
  const pace = b.paceMps.toFixed(2);
  return `FIT: SET ${when} - HEAD HEIGHT ${height} M, BOB ${bobMm} MM, PACE ${pace} M/S.`;
}

/** Landing toast when RUN FIT is clicked outside an XR session. */
export const FIT_NEEDS_HEADSET_TOAST =
  "Fit needs the headset - enter XR, then run FIT from the panel.";
/** Landing toast when the flow refuses to start (phase busy / mapping / demo /
 * already running) — the caller-side reason line (spec §4.3). */
export const FIT_BUSY_TOAST = "Finish the current run first - then run FIT.";

/** Panel line + color per ACTIVE fit status. Colors mirror the panel palette:
 * silver body copy, the landing's .low red for the actionable failure hint,
 * Carolina Blue for the success confirmation (which the HUD auto-hides after a
 * short read window; searching/no-floor persist until resolved). */
export const FIT_STATUS_LINES: Record<
  Exclude<FitStatus, "idle">,
  { text: string; color: string }
> = {
  searching: { text: "Looking for your floor...", color: "#8a8f96" },
  "no-floor": {
    text: "No floor found - save a Space in Quest settings and allow spatial data",
    color: "#e9818f",
  },
  fitted: { text: "Runway fitted to your floor", color: "#4b9cd3" },
};

// ---------------------------------------------------------------------------
// The post-walk MEDAL moment (founder call 2026-07-09: "some sort of bronze
// silver gold animation ... so they know at once how they performed").
// Display-only: a pure read; no golden-input module is touched, no record
// is written.
//
// RANKING MEDAL (founder ruling 2026-07-10, correcting the earlier absolute
// cuts): the badge is the score's POSITION among the trainee's own walks,
// NOT a fixed quality bar. Your best walk on record is 1st = GOLD, 2nd =
// SILVER, 3rd = BRONZE; a 4th-or-worse walk earns no badge. One score is
// always 1st, so a first walk always golds. Consequence the founder chose:
// the medal is decoupled from PASS / NEEDS WORK — a first (or best) walk
// can show GOLD beside a NEEDS WORK verdict. The RANK is computed by
// progress.medalRank over the trainee's history (this walk included).
// ---------------------------------------------------------------------------

export type MedalTier = "bronze" | "silver" | "gold";

/**
 * The medal for a walk's 1-based RANK among the trainee's walks
 * (progress.medalRank): 1 -> gold, 2 -> silver, 3 -> bronze. 4th-or-worse,
 * or a null / non-finite rank (junk input), earns no badge.
 */
export function scoreMedal(rank: number | null): MedalTier | null {
  if (rank === null || !Number.isFinite(rank)) return null;
  if (rank <= 1) return "gold";
  if (rank === 2) return "silver";
  if (rank === 3) return "bronze";
  return null;
}

/** ASCII badge labels (structural — worksheet F.19 KEEP-or-reword). */
export const MEDAL_LABEL: Readonly<Record<MedalTier, string>> = {
  bronze: "BRONZE",
  silver: "SILVER",
  gold: "GOLD",
};

/** Badge fill per tier. Gold + silver are the BRAND_CSS metals (theme.ts
 * gold #d9b78a / silver #8a8f96); bronze extends the same warm-neutral
 * family. The label sits dark on all three (the metal is the light surface —
 * mirrored in ui/lesson.uikitml .medal-text). */
export const MEDAL_COLOR: Readonly<Record<MedalTier, string>> = {
  bronze: "#b08154",
  silver: "#8a8f96",
  gold: "#d9b78a",
};

/** One-line caption tying the RANKING medal to the PASS / NEEDS WORK verdict.
 * The medal is a PERSONAL RANK (best walk = gold), the verdict is the mode's
 * ABSOLUTE bar — decoupled by design, so a first/best walk can gold beside a
 * NEEDS WORK verdict with no contradiction. This says so in one short line.
 * Shown on BOTH surfaces (XR panel #medal-note + landing #medal-note), gated
 * on a medal being present. ASCII (panel-swept by test/panel-ascii.test.ts).
 * DRAFTED-BY-CLAUDE; founder VETO/REWRITE via docs/COPY-WORKSHEET.md F.24. */
/** THE WALK CARD's honest headset pill (ASCII, panel-swept): the Quest
 * browser cannot meaningfully share/save a composed image file, so the pill
 * never pretends to — tapping it says WHERE the card lives. Label reverts
 * after SHARE_NOTE_SEC (paint-only text swap in HUDSystem.update).
 * DRAFTED-BY-CLAUDE; founder VETO/REWRITE via COPY-WORKSHEET.md F.33. */
export const SHARE_CARD_PILL = "SHARE CARD";
export const SHARE_CARD_NOTE = "CARD IS ON THE WEB SUMMARY";
export const SHARE_NOTE_SEC = 4;

export const MEDAL_RANK_NOTE =
  "The medal ranks your own walks - your best walk is gold, not a pass mark.";

/** The badge pop length (seconds) — the reveal starts REVEAL_DELAY_SEC after
 * the summary flip (sfx-timeline.ts: the graded sting's anchor) so the pop
 * lands ON the musical statement instead of competing with it. */
export const MEDAL_POP_SEC = 0.45;

/** Pure pop envelope: scale over t01. 0 -> 0.6, ease-out to an 1.08
 * overshoot by t=0.7, linear settle to 1.0. Clamped + junk-guarded so a
 * NaN delta can never wedge the badge at a weird scale (t>=1 reads 1). */
export function medalPopScale(t01: number): number {
  const t = Number.isFinite(t01) ? Math.min(1, Math.max(0, t01)) : 1;
  if (t < 0.7) {
    const u = t / 0.7;
    const eased = 1 - (1 - u) * (1 - u); // ease-out quad
    return 0.6 + (1.08 - 0.6) * eased;
  }
  const u = (t - 0.7) / 0.3;
  return 1.08 + (1.0 - 1.08) * u;
}
