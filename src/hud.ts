/**
 * (X)RUNWAY — HUDSystem REV2: drives the first-person lesson panel (ui/lesson.json).
 *
 * The trainee IS the model — the panel is their coaching HUD:
 * - Section toggling (brief / live / summary) on `globals.showPhase`.
 * - Metric bar fills + value texts from the `globals.metrics` signal (subscription, not polling).
 * - M1-M7 checkbox squares fill Carolina Blue when a live value >= the active
 *   mode's passThreshold (change-gated); summary rows show the final check states.
 * - Summary carries the SHARED coach layer (src/coach.ts, #9/#16): a
 *   PASS/NEEDS WORK verdict against the mode's own bar, duration + real
 *   steps/cadence, and up to 3 coach's notes (directional when the walk's
 *   measurements back them). The brief shows the mode's pass bar + target pace.
 * - TIME box counts down from `globals.walkRemaining` (integer changes only, "47S").
 * - Countdown text on `phase-line` (dt accumulated in update()).
 * - In XR the panel FOLLOWS the trainee (IWSDK Follower component, PivotY);
 *   on exit to browser the Follower is removed and the fixed spatial placement
 *   is restored. While NonImmersive the panel is hidden + non-interactive.
 * - Button wiring → `globals.showControls` (beginWalk/reset only — demo mode is
 *   gone), plus `xr-button` exit. All handlers XR-gated.
 *
 * REV3 — live runway mapping:
 * - A MAP RUNWAY footer button starts the walk-and-place flow
 *   (`globals.mapControls.startMapping()`).
 * - While `globals.mapMode != "off"` the brief/live/summary sections are hidden
 *   and a mapping panel (#map-section) shows a prompt + per-step how-to note
 *   driven by the mode (#17), plus CANCEL (`cancelMapping`) and — only in
 *   "adjust", once a draft exists to confirm — CONFIRM (`commit`). A `mapMode`
 *   subscription (cleanupFuncs) toggles the panel + prompt; `globals.mapControls`
 *   is read defensively (MappingSystem may assign it after the HUD inits).
 *   Rejected input (a too-short far end) flashes a notice over the prompt via
 *   `globals.mapNotice`, and the panel lazy-follows the trainee while mapping.
 */
import {
  createSystem,
  eq,
  Follower,
  InputComponent,
  Interactable,
  SlideSystem,
  TeleportSystem,
  TurnSystem,
  PanelDocument,
  PanelUI,
  ScreenSpace,
  UIKit,
  UIKitDocument,
  Vector3,
  Visibility,
  VisibilityState,
  type Entity,
} from "@iwsdk/core";
import type { Signal } from "@preact/signals-core";

import {
  beatPrefsLabel,
  cycleBeatPrefs,
  DEFAULT_BEAT,
  type BeatPrefs,
} from "./beat-prefs.js";
import { beatStatLine } from "./beat-stats.js";
import type { BodyBaseline } from "./body-baseline.js";
import {
  buildCoachReport,
  CLEAN_WALK_CUE,
  passBarLabel,
  targetPaceLabel,
  verdictLine,
  walkStatLine,
} from "./coach.js";
import type { FitFlowState } from "./fit-session.js";
import {
  applyCarriageNotes,
  carriageLine,
  M8_PITCH_BAND_DEG,
  type CarriageTracker,
} from "./head-carriage.js";
import { holdStatLine } from "./hold-stats.js";
import { holdNote, turnNote } from "./hold-turn-notes.js";
import { turnRowStamped } from "./summary-riders.js";
import { turnStatLine } from "./turn-stats.js";
import { medalRank } from "./progress.js";
import { repeatabilityReport, type RepeatRow } from "./repeatability.js";
import { rowMatchesTrainee } from "./session-grading.js";
import { LAYOUT_LIMITS, type RunwayLayout } from "./runway-layout.js";
import {
  anchorStartOnLengthEdit,
  DEFAULT_SHAPE,
  PRESET_RUNWAYS,
  sanitizeShape,
  SHAPE_LIMITS,
  type RunwayShape,
} from "./runway-shape.js";
import { METRICS, SHIPPED_METRIC_KEYS } from "./metrics.js";
import { DEFAULT_MODE, MODES, saveMode, type TrainingMode } from "./modes.js";
import {
  cycleMusicBpm,
  DEFAULT_MUSIC,
  musicBpmLabel,
  type MusicPrefs,
} from "./music-prefs.js";
import {
  cyclePaceBand,
  cyclePaceBias,
  DEFAULT_PACE,
  paceBandLabel,
  paceBiasLabel,
  type PacePrefs,
} from "./pace-prefs.js";
import {
  cycleWalkSeconds,
  DEFAULT_WALK,
  resolveWalkSeconds,
  walkSecondsLabel,
  type WalkPrefs,
} from "./walk-prefs.js";
import type { ExternalTracker } from "./external-tracker.js";
import {
  CAMERA_BACK_CUE,
  CAMERA_DROP_CUE,
  FIT_BUSY_TOAST,
  FIT_STATUS_LINES,
  fitPanelStatusLine,
  MAP_NOTES,
  MAP_PROMPTS,
  MEDAL_COLOR,
  MEDAL_LABEL,
  MEDAL_POP_SEC,
  MEDAL_RANK_NOTE,
  medalPopScale,
  scoreMedal,
  SHARE_CARD_NOTE,
  SHARE_CARD_PILL,
  SHARE_NOTE_SEC,
  trackingSourceLabel,
  TURN_BACK_CUE,
  TUTORIAL_STEPS,
  TUTORIAL_PACE_STEP,
  TUTORIAL_CARRIAGE_STEP,
  TUTORIAL_PREFS_STEP,
  TUTORIAL_NEXT_LABEL,
  TUTORIAL_DONE_LABEL,
  TUT_LEVEL_LABELS,
  type FitStatus,
  type MapNotice,
  type MedalTier,
  type TutLevelState,
} from "./hud-copy.js";
import { REVEAL_DELAY_SEC } from "./sfx-timeline.js";
import {
  mapFlowActive,
  settingsPanelShown,
  snapTurnPaused,
  walkLocomotionPaused,
} from "./hud-state.js";
import { mountPanelSkins } from "./panel-skins.js";
import type {
  MetricSnapshot,
  ShowControls,
  ShowPhaseValue,
  ShowSummary,
} from "./show.js";
import { BRAND_CSS } from "./theme.js";
import { DEFAULT_USER, type UserPrefs } from "./user-prefs.js";

const LESSON_CONFIG = "./ui/lesson.json";

/** Live-mapping mode (mirrors globals.mapMode set by MappingSystem). */
type MapMode = "off" | "placing-start" | "placing-end" | "adjust";

/**
 * Controls object assigned to `globals.mapControls` by MappingSystem. Read
 * defensively (may be null until MappingSystem inits) — the HUD only calls
 * startMapping / commit / cancelMapping.
 */
interface MapControls {
  startMapping(): void;
  cancelMapping(): void;
  placePoint(): void;
  setWidth(w: number): void;
  commit(): void;
  autoMapFromFloor(): void;
}

/** Controls assigned to `globals.bodyFitControls` by FitSessionSystem (Wave 1
 * FIT). Read defensively — may be null until the system inits. start()
 * returns false when refused (idle-only / demo / mapping / already running);
 * the guidance line itself comes through globals.bodyFitFlow. */
interface FitControls {
  start(): boolean;
  cancel(): void;
}

/** Base prompt color — mirrors .map-prompt in ui/lesson.uikitml (restored
 * after a notice flash recolors the prompt). Notice flash uses the landing's
 * .low warning red, same as the fit no-floor hint. */
const MAP_PROMPT_COLOR = "#4b9cd3";
const MAP_NOTICE_COLOR = "#e9818f";
/** Section-swap fade length (web parity pass) — the incoming body section
 * eases opacity 0 -> 1; short enough that rapid ray-clicking through menus
 * never feels laggy. */
const SECTION_FADE_SEC = 0.28;
/** First-run in-headset tutorial (2026-07-11): the localStorage flag, the
 * per-step body fade, and the cadence-pip beat. The tutorial auto-opens on the
 * first XR entry when this key is unset AND no walk is recorded (the DOM
 * onboarding gate, on an independent key so the headset offers its own first
 * run once). */
const TUTORIAL_SEEN_KEY = "xrunway.xr-tutorial.v1";
/** Body cross-fade on a NEXT/BACK step change — feedback the card advanced
 * (paint-only opacity, the medal-pop precedent). */
const TUT_PULSE_SEC = 0.24;
/** Cadence-track beat: one pip lights every this-many seconds on the PACE card.
 * ~0.46 s per step - a runway-cadence FEEL (measured runway cadence is
 * ~122-129 spm; RESEARCH-runway-pace-bpm.md), never a displayed claim. */
const TUT_CADENCE_STEP_SEC = 0.46;
/** Carolina accent + the dim base for the tutorial dots/pips (border-tier law:
 * the lit read comes from color contrast, never a bevel). */
const TUT_ON_COLOR = "#4b9cd3";
const TUT_DOT_OFF_COLOR = "#2b3540";
const TUT_PIP_OFF_COLOR = "#222b35";
/** LEVEL pill labels per mode id (founder ruling 2026-07-15: EMERGING must be
 * reachable in-headset). Only beginner/highfashion are offered by the toggle;
 * the legacy ids are named honestly if a stale pref resurfaces one. */
const LEVEL_LABELS: Record<string, string> = {
  beginner: "Beginner",
  highfashion: "Emerging",
  commercial: "Commercial",
  challenge: "Challenge",
};
/** Dim label color for the live head-level indicator when out of the band
 * (mirrors .tut-level-label in ui/lesson.uikitml). */
const TUT_LEVEL_DIM_COLOR = "#8a8f96";
/** Live head-level indicator geometry (the CARRIAGE card's learn-by-doing
 * beat). Head pitch is mapped to a horizontal marker deflection: full travel
 * (TUT_LEVEL_HALF_UNITS uikit units, matching the .tut-level-track half-width
 * minus the marker) at +-TUT_LEVEL_SPAN_DEG of pitch, clamped. The level
 * BAND itself is M8_PITCH_BAND_DEG (the exact CARRIAGE scoring band) - inside
 * it the marker sits within the centered zone and glows Carolina. TUT_RAD2DEG
 * converts the asin result; TUT_LEVEL_EASE folds the marker toward its target
 * frame-rate-independently (1 - exp(-rate*dt)) so it glides instead of
 * snapping, and TUT_LEVEL_MARKER_STEP quantizes the write so a settled head
 * stops emitting setProperties (the cadence-block on-change discipline). */
const TUT_RAD2DEG = 180 / Math.PI;
const TUT_LEVEL_SPAN_DEG = 20;
const TUT_LEVEL_HALF_UNITS = 14;
const TUT_LEVEL_EASE = 8;
const TUT_LEVEL_MARKER_STEP = 0.1;
/** Base bodyfit-status color — mirrors .bodyfit-status in ui/lesson.uikitml
 * (restored by updateBodyFitStatus after a refusal flash recolors the row). */
const BODYFIT_STATUS_COLOR = "#c7ccd2";
/** How long a flashed mapping notice holds before the prompt is restored. */
const MAP_NOTICE_SEC = 2.5;

/** Panel pose RELATIVE to the runway-start frame (trainee standing at the start,
 * facing down the runway): off to the left, a touch ahead + below eye line, yawed
 * in so it's glanceable. World-placed beside the runway start — NOT head-locked,
 * so the model walks past it instead of dragging it down the runway. */
const HUD_POS_X = -1.15;
const HUD_POS_Y = 1.5;
const HUD_POS_Z = -1.6;
const HUD_YAW_RAD = (25 * Math.PI) / 180;
/** Summary park latch (founder call — a menu that chases the head can't be
 * pointed at): the follow settles within these thresholds -> world-lock. */
const PARK_SETTLE_DIST = 0.06; // m from the follow target
const PARK_SETTLE_YAW_RAD = (4 * Math.PI) / 180;
/** Walk this far from where you parked it and the panel comes to you again. */
const PARK_BREAK_DIST = 1.2; // m
/** How long the "turn around" cue shows (+ the panel visits you) at the far end of
 *  an out-and-back walk. */
const TURN_BACK_SEC = 3;

/** Mirrors ShowDirector's countdown phase length. */
const COUNTDOWN_SECONDS = 3;

/** #15: how long the "Runway fitted to your floor" confirmation stays up.
 * (Searching / no-floor lines persist until the fit resolves or disarms.) */
const FIT_FITTED_SHOW_SEC = 4;

/** #32/#46: footer TRACKING line cadence + colors, and the mid-walk drop/
 * reconnect cue length. Outside a walk the source is re-checked at 1 Hz
 * (mirroring the landing pill); mid-walk it's edge-driven off trackerActive. */
const TRACK_POLL_SEC = 1;
const TRACK_CUE_SEC = 3;
/** Night-review hysteresis: MetricsSystem flips trackerActive per frame off a
 * hard 0.6 s staleness window, so a marginal stream (companion at ~1-2 fps,
 * wifi jitter) flips it at up to ~2x the stream period. A raw edge must HOLD
 * this long before the label/cue accept it, and two phase-line cue publishes
 * must be at least MIN_GAP apart — the iOS companion's framingHoldMs/
 * framingMinGapMs discipline, scaled for the walk surface. */
const TRACK_EDGE_HOLD_SEC = 0.75;
const TRACK_CUE_MIN_GAP_SEC = 4;
const TRACK_CAMERA_COLOR = "#4b9cd3";
const TRACK_HEAD_COLOR = "#8a8f96";

/** The in-headset SIZE adjusters. Each drives one shape field with big −/+ steps
 * + a fill bar (value's position in its range) + thumbstick scrub. `shapes`
 * gates which kinds show the row: all = every shape; arms = T/X/U; tx = T/X. */
interface SizeField {
  key: "spineLength" | "spineWidth" | "armSpan" | "crossAt";
  id: string;
  step: number;
  min: number;
  max: number;
  pct: boolean;
  shapes: "all" | "arms" | "tx";
}
const SIZE_FIELDS: SizeField[] = [
  { key: "spineLength", id: "length", step: 0.5, min: LAYOUT_LIMITS.minLength, max: LAYOUT_LIMITS.maxLength, pct: false, shapes: "all" },
  { key: "spineWidth", id: "width", step: 0.1, min: LAYOUT_LIMITS.minWidth, max: LAYOUT_LIMITS.maxWidth, pct: false, shapes: "all" },
  { key: "armSpan", id: "arm", step: 0.5, min: SHAPE_LIMITS.minArmSpan, max: SHAPE_LIMITS.maxArmSpan, pct: false, shapes: "arms" },
  { key: "crossAt", id: "cross", step: 0.05, min: SHAPE_LIMITS.minCrossAt, max: SHAPE_LIMITS.maxCrossAt, pct: true, shapes: "tx" },
];

/**
 * Checkbox colors. ON = Carolina Blue (BRAND_CSS.accent); OFF mirrors the
 * `.check` base style in ui/lesson.uikitml — keep the two in sync.
 */
const CHECK_ON_BG = BRAND_CSS.accent;
const CHECK_ON_BORDER = BRAND_CSS.accent;
const CHECK_OFF_BG = "#10151b";
const CHECK_OFF_BORDER = "#2f3a47";

/** Metric key order M1..M7 — derived from the single-source METRICS table. */
const METRIC_KEYS: ReadonlyArray<keyof MetricSnapshot> = METRICS.map(
  (m) => m.key,
);
const METRIC_COUNT = METRIC_KEYS.length;

/** The shipped card's 3rd row DISPLAYS head CARRIAGE, not rhythm (founder call
 * 2026-07-08 — carriage is the honest "head stays level" read; rhythm only
 * scores consistency). We REPURPOSE the rhythm element slot (m3/s3): the live
 * value comes from CarriageTracker.liveScore() and the summary from
 * summary.carriage, NOT from snapshot.rhythm / summary.scores.rhythm. Rhythm
 * still scores in the engine (hidden, like posture/composites). */
const CARRIAGE_SLOT = METRIC_KEYS.indexOf("rhythm");

/** Sentinel forcing the first TIME write after (re)attach. */
const TIME_UNSET = Number.MIN_SAFE_INTEGER;

export class HUDSystem extends createSystem({
  lessonPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, "config", LESSON_CONFIG)],
  },
}) {
  private doc: UIKitDocument | null = null;
  private panelEntity: Entity | null = null;

  private briefSection: UIKit.Container | null = null;
  private liveSection: UIKit.Container | null = null;
  private summarySection: UIKit.Container | null = null;
  private mapSection: UIKit.Container | null = null;
  private mapPrompt: UIKit.Text | null = null;
  /** #17: per-mode how-to note + the CONFIRM button (gated to "adjust"). */
  private mapNote: UIKit.Text | null = null;
  private mapConfirmBtn: UIKit.Container | null = null;
  private phaseLine: UIKit.Text | null = null;
  private timeBox: UIKit.Text | null = null;
  private overallScore: UIKit.Text | null = null;
  private deltaLine: UIKit.Text | null = null;
  /** Coach layer (#9/#16): verdict, duration+steps line, up to 3 note rows,
   * and the brief's pass-bar/target-pace line. */
  private sumVerdict: UIKit.Text | null = null;
  /** F.24 ranking-medal caption: the medal is a personal rank, the verdict is
   * the absolute bar — revealed only when a medal shows (the sumCarriage
   * display-toggle pattern). */
  private medalNote: UIKit.Text | null = null;
  private sumStat: UIKit.Text | null = null;
  /** M8 head-carriage summary row (display-none until a walk produced a
   * carriage read — the noteEls pattern). */
  private sumCarriage: UIKit.Text | null = null;
  /** M10 hold summary row (display-none until a director-built summary
   * carries the hold stamp — a NULL stamp still renders: NO READ is a fact). */
  private sumHold: UIKit.Text | null = null;
  /** M9 beat summary row (the sum-hold pattern; §G row order HOLD -> BEAT). */
  private sumBeat: UIKit.Text | null = null;
  /** M11 turn summary row (§G row order HOLD -> BEAT -> TURN; hidden in the
   * both-null stamp case — no analyzer ran; turnRowStamped is the shared
   * presence law, summary-riders.ts). */
  private sumTurn: UIKit.Text | null = null;
  /** M12 consistency row (display-none until 3 matched walks exist for the
   * current trainee — repeatability compactLine, ASCII by construction). */
  private sumRepeat: UIKit.Text | null = null;
  /** F.27 head-motion observation notes (hold dwell + turn smoothness) —
   * display-only reads (hold-turn-notes.ts), NOT scored/golden/recorded.
   * Each hides when its channel produced no measured read (holdNote/turnNote
   * return null). */
  private sumHoldNote: UIKit.Text | null = null;
  private sumTurnNote: UIKit.Text | null = null;
  private noteEls: Array<UIKit.Text | null> = [null, null, null];
  private briefBar: UIKit.Text | null = null;
  private xrButton: UIKit.Text | null = null;
  /** #15: fit-to-room status line above the footer (event-driven). */
  private fitStatusEl: UIKit.Text | null = null;
  /** Wave 1 FIT: guidance line in the brief section (flow edges paint it)
   * and the settings-row baseline status. */
  private bodyfitLine: UIKit.Text | null = null;
  private bodyfitStatus: UIKit.Text | null = null;
  private bodyFitFlowSig: Signal<FitFlowState | null> | null = null;
  private bodyBaselineSig: Signal<BodyBaseline | null> | null = null;
  /** #32/#46: footer TRACKING source value (change-gated writes). */
  private trackSrcEl: UIKit.Text | null = null;
  private fillEls: Array<UIKit.Container | null> = new Array(METRIC_COUNT).fill(null);
  private valEls: Array<UIKit.Text | null> = new Array(METRIC_COUNT).fill(null);
  private checkEls: Array<UIKit.Container | null> = new Array(METRIC_COUNT).fill(null);
  private sumEls: Array<UIKit.Text | null> = new Array(METRIC_COUNT).fill(null);
  private sumCheckEls: Array<UIKit.Container | null> = new Array(METRIC_COUNT).fill(null);

  private phaseSig: Signal<ShowPhaseValue> | null = null;
  private metricsSig: Signal<MetricSnapshot | null> | null = null;
  private summarySig: Signal<ShowSummary | null> | null = null;
  private walkRemainingSig: Signal<number> | null = null;
  private mapModeSig: Signal<MapMode> | null = null;
  private modeSig: Signal<TrainingMode> | null = null;
  /** #15: fit-to-room status (MappingSystem writes the edges). */
  private fitStatusSig: Signal<FitStatus> | null = null;
  /** Seconds left on the auto-hiding "fitted" confirmation (0 = not running). */
  private fitStatusRemaining = 0;
  /** #17: one-shot mapping notices (MappingSystem posts on rejected input). */
  private mapNoticeSig: Signal<MapNotice | null> | null = null;
  /** Seconds left on a flashed mapping notice before the prompt is restored. */
  private mapNoticeRemaining = 0;
  /** #32/#46: the external pose tracker (staleness window + source label). */
  private tracker: ExternalTracker | null = null;
  /** Last TRACKING label written (change gate for the footer line). */
  private lastTrackLabel = "";
  /** 1 Hz re-check accumulator for the TRACKING line outside a walk. */
  private trackPollAcc = 0;
  /** Mid-walk camera-scoring state last frame (null = seed on walk entry) —
   * the ACCEPTED state; raw trackerActive edges must hold (hysteresis). */
  private camActivePrev: boolean | null = null;
  /** Seconds the raw trackerActive value has continuously differed from the
   * accepted state (night-review hysteresis; scalar timer, zero-alloc). */
  private camEdgeHold = 0;
  /** Seconds since the last camera phase-line cue publish (min-gap). */
  private camCueGap = TRACK_CUE_MIN_GAP_SEC;
  /** Seconds left on a camera drop/reconnect phase-line cue. */
  private trackCueRemaining = 0;
  /** Panel show/hide toggle (g.hudVisible) + the runway spine the panel mounts
   * beside (reposition the side-mount when the runway is remapped / fit). */
  private hudVisibleSig: Signal<boolean> | null = null;
  private runwayLayoutSig: Signal<RunwayLayout> | null = null;
  // In-headset SETTINGS section (mirrors the web editor; writes the SAME globals).
  private shapeSig: Signal<RunwayShape> | null = null;
  private crowdSig: Signal<boolean> | null = null;
  /** Floor-glow toggle (the "blue circles" warp rings on/off). */
  private floorFxSig: Signal<boolean> | null = null;
  private floorFxBtn: UIKit.Text | null = null;
  /** LEVEL toggle pill (Beginner <-> Emerging; writes the SAME mode signal). */
  private levelBtn: UIKit.Text | null = null;
  private musicSig: Signal<MusicPrefs> | null = null;
  private settingsOpen = false;
  /** The DETAILS reference subsection (modes + music tempo) — meaningful only
   * while settings is open: it swaps the settings body and Done returns.
   * Reset whenever settings opens/closes so a stale view can never greet the
   * next open. */
  private detailsOpen = false;
  /** The SCORING education subsection (the landing UNDERSTANDING THE SCORE
   * twin) — same swap contract as detailsOpen, and mutually exclusive with it
   * (the setters clear each other; settings edges reset both). */
  private scoringOpen = false;
  /** The first-run in-headset TUTORIAL (2026-07-11) — a body section like
   * settings, mutually exclusive with settings/details/scoring (opening one
   * closes the others). Auto-opens once on the first XR entry; re-openable from
   * Settings -> Guide. tutorialStep is the 0-based card index into
   * TUTORIAL_STEPS. */
  private tutorialOpen = false;
  private tutorialStep = 0;
  /** Rising-edge guard so the auto-open fires at most once per session (a
   * visibility blur/focus toggle must not re-open it). */
  private enteredXrOnce = false;
  private presetIdx = -1;
  private settingsSection: UIKit.Container | null = null;
  private detailsSection: UIKit.Container | null = null;
  private scoringSection: UIKit.Container | null = null;
  private tutorialSection: UIKit.Container | null = null;
  private tutKicker: UIKit.Text | null = null;
  private tutTitle: UIKit.Text | null = null;
  private tutBody: UIKit.Text | null = null;
  private tutCad: UIKit.Container | null = null;
  private tutBackBtn: UIKit.Container | null = null;
  private tutNextBtn: UIKit.Text | null = null;
  /** MAKE IT YOURS card: the preference-pill wrapper + five label pills. */
  private tutPrefs: UIKit.Container | null = null;
  private tutMusicBtn: UIKit.Text | null = null;
  private tutModeBtn: UIKit.Text | null = null;
  private tutBpmBtn: UIKit.Text | null = null;
  private tutBeatBtn: UIKit.Text | null = null;
  private tutDurationBtn: UIKit.Text | null = null;
  private tutDots: Array<UIKit.Container | null> = [];
  private tutPips: Array<UIKit.Container | null> = [];
  /** Per-step body cross-fade timer (-1 = idle) — feedback the card advanced. */
  private tutPulseElapsed = -1;
  /** Cadence-track beat (PACE card only): accumulates while that card is the
   * visible tutorial card; cadenceIndex is the currently-lit pip (-1 = none). */
  private cadenceElapsed = 0;
  private cadenceIndex = -1;
  /** Live head-level indicator (CARRIAGE card only): the elements + the paint
   * state. tutLevelMarkerPos is the eased marker offset (uikit units);
   * tutLevelMarkerWritten is the last quantized value actually written (so a
   * settled head stops writing); tutLevelState is the last label state written
   * (null forces the first write on show). The direction scratch is
   * preallocated - NO per-frame allocation (CLAUDE.md). */
  private tutLevel: UIKit.Container | null = null;
  private tutLevelMarker: UIKit.Container | null = null;
  private tutLevelZone: UIKit.Container | null = null;
  private tutLevelLabel: UIKit.Text | null = null;
  private readonly tutLevelDir = new Vector3();
  private tutLevelMarkerPos = 0;
  private tutLevelMarkerWritten = Number.NaN;
  private tutLevelState: TutLevelState | null = null;
  private shapeChips: Array<UIKit.Container | null> = [];
  private modeChips: Array<UIKit.Container | null> = [];
  private sizeValEls: Record<string, UIKit.Text | null> = {};
  private sizeFillEls: Record<string, UIKit.Container | null> = {};
  private sizeRowEls: Record<string, UIKit.Container | null> = {};
  private crowdBtn: UIKit.Text | null = null;
  private musicBtn: UIKit.Text | null = null;
  /** M9 beat-pulse pill (cycles the three delivery states). */
  private beatBtn: UIKit.Text | null = null;
  private bpmBtn: UIKit.Text | null = null;
  private paceStyleBtn: UIKit.Text | null = null;
  private paceBandBtn: UIKit.Text | null = null;
  private paceSig: Signal<PacePrefs> | null = null;
  /** Walk-duration pill (founder call 2026-07-09: 10-60 s, default 20). */
  private durationBtn: UIKit.Text | null = null;
  private beatSig: Signal<BeatPrefs> | null = null;
  private walkPrefsSig: Signal<WalkPrefs> | null = null;
  /** Which SIZE field the thumbstick scrubs (set by tapping its −/+ or value). */
  private focusedField: string | null = null;
  /** Live thumbstick scrub: preview the value text/bar each frame (cheap), then
   * commit the runwayShape (one stage rebuild) on release — NOT per frame. */
  private scrubbing = false;
  private scrubValue = 0;
  /** Last frame's "settings panel actually shown" state — edge-detected in update()
   * to flush the scrub + drop focus the moment it hides. */
  private settingsShownPrev = false;
  /** Last frame's "actively scrubbing a focused field" state — edge-detected to
   * pause/resume snap-turn ONLY for the scrub window (so a finished walk + an
   * unfocused settings panel both leave the right stick free to turn). */
  private turnPausedPrev = false;
  private walkLocoPausedPrev = false;
  /** True when this session's WebXR runtime is the IWER emulator (laptop
   * ENTER HEADSET / dev preview) — window.IWER_DEVICE is set at emulator
   * install, before World.create; a real Quest never installs it (the
   * OculusBrowser UA exception). The walk locomotion pause is exempted for
   * emulated sessions: stick/WASD slide is the only way a laptop viewer
   * moves (founder repro 2026-07-10). Cached once — cannot change mid-run. */
  private emulatedXR = false;
  /** True while the panel is lazy-following the trainee at summary (so we re-mount
   * it beside the runway once, when summary ends). */
  private followActive = false;
  /** Summary park latch: true once the follow settled in front of the trainee —
   * the panel is world-locked (pointable) until they walk PARK_BREAK_DIST away. */
  private summaryParked = false;
  /** DEV: ?panelfront in the URL pins the panel dead-ahead every frame (any
   * phase) so the emulator renders it face-on for layout screenshots. */
  private readonly devPanelFront =
    typeof location !== "undefined" && /[?&]panelfront\b/.test(location.search);
  /** Head position at the moment the panel parked (the walk-away reference). */
  private readonly parkAnchor = new Vector3();
  /** MEDAL moment (founder call 2026-07-09): armed by onSummary, revealed by
   * update() at the graded sting's +REVEAL_DELAY_SEC anchor, popped over
   * MEDAL_POP_SEC with paint-only opacity/scale writes. -1 = not popping. */
  private medalBadge: UIKit.Container | null = null;
  private medalText: UIKit.Text | null = null;
  private pendingMedal: MedalTier | null = null;
  private medalDelayRemaining = 0;
  private medalPopElapsed = -1;
  /** WALK CARD pill note (honest headset copy): seconds until the label
   * reverts to SHARE_CARD_PILL. 0 = resting. Paint-only text swap. */
  private shareNoteRemaining = 0;
  /** Section-swap fade (web parity pass 2026-07-10): the body section that
   * just became visible eases opacity 0 -> 1, the spatial twin of the web
   * landing's per-card reveals. Paint-only writes in update() (the medal-pop
   * precedent); -1 = not fading. */
  private sectionFadeEl: UIKit.Container | null = null;
  private sectionFadeElapsed = -1;
  private visibleSectionPrev = "";
  /** Seconds left on the far-end "turn around" cue (out-and-back walks). While >0
   * the panel visits the trainee with the prompt. */
  private turnBackRemaining = 0;
  /** Prev frame's poseBurst (reached-the-mark) flag, for rising-edge detection. */
  private poseBurstPrev = false;
  /** Scratch for the summary lazy-follow (allocate once — update() is per-frame). */
  private readonly headPos = new Vector3();
  private readonly headFwd = new Vector3();
  private readonly followTarget = new Vector3();

  // Lesson-copy text elements (driven by the active mode).
  private lessonNo: UIKit.Text | null = null;
  private titleText: UIKit.Text | null = null;
  private instruction: UIKit.Text | null = null;
  private identName: UIKit.Text | null = null;
  private identId: UIKit.Text | null = null;
  /** Active mode — its copy fills the brief, its passThreshold gates the checkboxes. */
  private mode: TrainingMode = DEFAULT_MODE;

  private phase: ShowPhaseValue = "idle";
  /** Latest mapping mode — when != "off" the mapping panel overrides sections. */
  private mapMode: MapMode = "off";
  private countdownRemaining = 0;
  private lastCountdownInt = -1;
  private lastPhaseText = "";
  private lastTimeShown = TIME_UNSET;
  private lastVals!: Int32Array;
  private lastChecks!: Int8Array;

  init(): void {
    this.lastVals = new Int32Array(METRIC_COUNT).fill(-1);
    this.lastChecks = new Int8Array(METRIC_COUNT).fill(-1);
    this.emulatedXR =
      typeof window !== "undefined" &&
      (window as unknown as { IWER_DEVICE?: unknown }).IWER_DEVICE !==
        undefined;

    const g = this.world.globals as Record<string, unknown>;
    this.tracker = (g.externalTracker as ExternalTracker | undefined) ?? null;
    this.phaseSig = (g.showPhase as Signal<ShowPhaseValue> | undefined) ?? null;
    this.metricsSig =
      (g.metrics as Signal<MetricSnapshot | null> | undefined) ?? null;
    this.summarySig =
      (g.summary as Signal<ShowSummary | null> | undefined) ?? null;
    this.walkRemainingSig =
      (g.walkRemaining as Signal<number> | undefined) ?? null;
    this.mapModeSig = (g.mapMode as Signal<MapMode> | undefined) ?? null;
    this.modeSig = (g.activeMode as Signal<TrainingMode> | undefined) ?? null;
    if (this.modeSig) this.mode = this.modeSig.peek();
    if (
      !this.phaseSig ||
      !this.metricsSig ||
      !this.summarySig ||
      !this.walkRemainingSig
    ) {
      console.warn(
        "[HUDSystem] show globals missing (showPhase/metrics/summary/walkRemaining) — HUD will stay static.",
      );
    }
    if (!this.mapModeSig) {
      console.warn(
        "[HUDSystem] globals.mapMode signal missing — mapping panel will stay hidden.",
      );
    }

    this.cleanupFuncs.push(
      this.queries.lessonPanel.subscribe(
        "qualify",
        (entity) => {
          this.attachPanel(entity);
        },
        true,
      ),
      this.queries.lessonPanel.subscribe("disqualify", () => {
        this.detachPanel();
      }),
    );

    if (this.phaseSig) {
      this.cleanupFuncs.push(
        this.phaseSig.subscribe((p) => {
          this.onPhase(p);
        }),
      );
    }
    if (this.metricsSig) {
      this.cleanupFuncs.push(
        this.metricsSig.subscribe((m) => {
          this.onMetrics(m);
        }),
      );
    }
    if (this.summarySig) {
      this.cleanupFuncs.push(
        this.summarySig.subscribe((s) => {
          this.onSummary(s);
        }),
      );
    }
    if (this.walkRemainingSig) {
      this.cleanupFuncs.push(
        this.walkRemainingSig.subscribe((v) => {
          this.onWalkRemaining(v);
        }),
      );
    }
    if (this.mapModeSig) {
      this.cleanupFuncs.push(
        this.mapModeSig.subscribe((m) => {
          this.onMapMode(m);
        }),
      );
    }
    this.fitStatusSig = (g.fitStatus as Signal<FitStatus> | undefined) ?? null;
    if (this.fitStatusSig) {
      this.cleanupFuncs.push(
        this.fitStatusSig.subscribe((s) => {
          this.onFitStatus(s);
        }),
      );
    }
    this.mapNoticeSig =
      (g.mapNotice as Signal<MapNotice | null> | undefined) ?? null;
    if (this.mapNoticeSig) {
      this.cleanupFuncs.push(
        this.mapNoticeSig.subscribe((n) => {
          this.onMapNotice(n);
        }),
      );
    }
    // Wave 1 FIT: guidance edges + baseline status (both edge-driven — the
    // per-frame progress ref is deliberately NOT rendered on the panel; the
    // spoken lines + the stage line are the honest in-headset surface).
    this.bodyFitFlowSig =
      (g.bodyFitFlow as Signal<FitFlowState | null> | undefined) ?? null;
    if (this.bodyFitFlowSig) {
      this.cleanupFuncs.push(
        this.bodyFitFlowSig.subscribe((f) => {
          this.onBodyFitFlow(f);
        }),
      );
    }
    this.bodyBaselineSig =
      (g.bodyBaseline as Signal<BodyBaseline | null> | undefined) ?? null;
    if (this.bodyBaselineSig) {
      this.cleanupFuncs.push(
        this.bodyBaselineSig.subscribe(() => {
          this.updateBodyFitStatus();
        }),
      );
    }
    if (this.modeSig) {
      this.cleanupFuncs.push(
        this.modeSig.subscribe((m) => {
          this.mode = m;
          this.applyModeCopy();
          this.updateModeUI();
          this.updateBpmUI(); // an unset tempo pref shows the mode default
        }),
      );
    }
    this.hudVisibleSig = (g.hudVisible as Signal<boolean> | undefined) ?? null;
    this.runwayLayoutSig =
      (g.runwayLayout as Signal<RunwayLayout> | undefined) ?? null;
    if (this.hudVisibleSig) {
      this.cleanupFuncs.push(
        this.hudVisibleSig.subscribe(() => {
          this.onVisibility(this.world.visibilityState.peek());
        }),
      );
    }
    if (this.runwayLayoutSig) {
      // Reposition the side-mounted panel when the runway is remapped / fit.
      this.cleanupFuncs.push(
        this.runwayLayoutSig.subscribe(() => {
          if (this.inXR()) this.applyWorldPlacement();
        }),
      );
    }
    // Settings live-sync: the in-headset panel writes the SAME globals the web
    // editor does, so reflect external changes (web / mapping / auto-fit) back
    // into the panel's chips + value readouts.
    this.shapeSig = (g.runwayShape as Signal<RunwayShape> | undefined) ?? null;
    this.crowdSig = (g.crowdVisible as Signal<boolean> | undefined) ?? null;
    this.floorFxSig =
      (g.floorRingsVisible as Signal<boolean> | undefined) ?? null;
    this.musicSig = (g.musicPrefs as Signal<MusicPrefs> | undefined) ?? null;
    this.paceSig = (g.pacePrefs as Signal<PacePrefs> | undefined) ?? null;
    if (this.paceSig) {
      this.cleanupFuncs.push(this.paceSig.subscribe(() => this.updatePaceUI()));
    }
    this.beatSig = (g.beatPrefs as Signal<BeatPrefs> | undefined) ?? null;
    this.walkPrefsSig = (g.walkPrefs as Signal<WalkPrefs> | undefined) ?? null;
    if (this.shapeSig) {
      this.cleanupFuncs.push(this.shapeSig.subscribe(() => this.updateShapeUI()));
    }
    if (this.crowdSig) {
      this.cleanupFuncs.push(this.crowdSig.subscribe(() => this.updateCrowdUI()));
    }
    if (this.floorFxSig) {
      this.cleanupFuncs.push(
        this.floorFxSig.subscribe(() => this.updateFloorFxUI()),
      );
    }
    if (this.musicSig) {
      this.cleanupFuncs.push(this.musicSig.subscribe(() => this.updateMusicUI()));
    }
    if (this.beatSig) {
      this.cleanupFuncs.push(this.beatSig.subscribe(() => this.updateBeatUI()));
    }
    if (this.walkPrefsSig) {
      this.cleanupFuncs.push(
        this.walkPrefsSig.subscribe(() => this.updateDurationUI()),
      );
    }
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((vs) => {
        this.onVisibility(vs);
      }),
    );
  }

  /** Countdown ticker + the in-XR panel show/hide gesture. */
  update(delta: number): void {
    // Show/hide the lesson panel: RIGHT controller's upper face button (B).
    // getButtonDown is the rising edge, so it toggles once per press. Works in
    // any phase (you can dismiss the panel mid-walk) EXCEPT while mapping owns
    // the panel — a mid-flow hide left the state machine running headless
    // (invisible prompts, un-clickable CANCEL/CONFIRM); mapFlowActive is the
    // unit-tested truth table.
    const rightPad = this.input.xr.gamepads.right;
    if (
      rightPad !== undefined &&
      this.hudVisibleSig !== null &&
      !mapFlowActive(this.mapMode) &&
      rightPad.getButtonDown(InputComponent.B_Button)
    ) {
      this.hudVisibleSig.value = !this.hudVisibleSig.peek();
    }

    // First-run tutorial: the RIGHT A button advances the card (comfortable —
    // no aiming at the NEXT pill), gated on the card actually being the visible
    // body. A on the last card closes + stamps seen (tutorialAdvance). Right A
    // is dead on the main surface by design (mapping owns it only mid-flow, and
    // the tutorial can't be open while mapping), so this never collides.
    if (
      rightPad !== undefined &&
      this.tutorialShown() &&
      rightPad.getButtonDown(InputComponent.A_Button)
    ) {
      this.tutorialAdvance();
    }

    // Panel-hidden teardown: the moment the settings panel stops being shown — a
    // walk starting, MAP opening, the B-button hide, XR exit — commit any in-flight
    // scrub (never silently drop it) and drop focus. Edge-driven so it fires once.
    const shown = this.settingsShown();
    if (shown !== this.settingsShownPrev) {
      this.settingsShownPrev = shown;
      if (!shown) {
        this.flushScrub();
        this.clearFocus();
      }
    }

    // Locomotion integrity (the Quest tester's "the smaller you make it, once
    // you get to the end it throws you off the runway"): virtual locomotion
    // must never move the rig under a PHYSICAL graded walk. IWSDK's snap turn
    // pivots the rig about the XR ORIGIN, not the head — a right-stick flick
    // at distance D from origin sweeps the runway ~0.77*D sideways under the
    // trainee (0.6 m at the end of the 7 m default, 2.1 m on a 3 m runway) —
    // and left-stick slide (5 m/s) + right-stick-down teleport relocate the
    // rig outright, corrupting every world-frame metric mid-walk. ONE
    // reconciler here = one writer per system, so the walk pause, the scrub
    // pause and the mapping-adjust pause can never fight; edge-tracked so
    // stop()/play() fire once; XR-only (in the browser W/A/S/D IS slide
    // locomotion, and the Preview Walk manages its own pause). The pure
    // predicates (hud-state.ts) are the unit-tested truth table.
    const scrubbing = shown && this.focusedField !== null;
    const turnPause = snapTurnPaused(
      this.phase,
      this.inXR(),
      scrubbing,
      this.mapMode,
      this.emulatedXR,
    );
    if (turnPause !== this.turnPausedPrev) {
      this.turnPausedPrev = turnPause;
      const turn = this.world.getSystem(TurnSystem);
      if (turnPause) turn?.stop();
      else turn?.play();
    }
    const walkPause = walkLocomotionPaused(
      this.phase,
      this.inXR(),
      this.emulatedXR,
    );
    if (walkPause !== this.walkLocoPausedPrev) {
      this.walkLocoPausedPrev = walkPause;
      const slide = this.world.getSystem(SlideSystem);
      const teleport = this.world.getSystem(TeleportSystem);
      if (walkPause) {
        slide?.stop();
        teleport?.stop();
      } else {
        slide?.play();
        teleport?.play();
      }
    }

    // Thumbstick scrub: while the panel is SHOWN and a SIZE field is focused
    // (tapped its −/+ or value), the right thumbstick smoothly scrubs it. Preview
    // live (text + bar only — cheap), then commit the runwayShape ONCE on release
    // so the stage rebuilds a single time, not every frame.
    if (shown && this.focusedField !== null && rightPad !== undefined) {
      const f = SIZE_FIELDS.find((x) => x.id === this.focusedField);
      const axes = rightPad.getAxesValues(InputComponent.Thumbstick);
      const x = axes?.x ?? 0;
      if (f !== undefined && Math.abs(x) > 0.15) {
        const lo = this.effectiveMin(f); // armSpan floors to armWidth, not 0
        if (!this.scrubbing) {
          this.scrubbing = true;
          this.scrubValue =
            (this.shapeSig?.peek()[f.key] as number | undefined) ?? lo;
        }
        const rate = (f.max - lo) / 2.5; // full range in ~2.5s at full tilt
        this.scrubValue = Math.max(
          lo,
          Math.min(f.max, this.scrubValue + x * rate * delta),
        );
        this.renderFieldValue(f, this.scrubValue);
      } else if (this.scrubbing && f !== undefined) {
        this.scrubbing = false;
        this.setField(f, this.scrubValue);
      }
    }

    // Turn-back cue: when the trainee reaches the far-end pose mark on an OUT-AND-BACK
    // route (straight/T/X — the one-way U finishes there, no turn), briefly bring the
    // panel to them with a "turn around" prompt so they know to walk back (the panel
    // is otherwise world-mounted behind them at the start). poseBurst is the show
    // director's "reached the mark" flag; we fire on its rising edge.
    const poseBurst =
      (this.world.globals as Record<string, unknown>).poseBurst === true;
    if (
      poseBurst &&
      !this.poseBurstPrev &&
      this.phase === "walk" &&
      this.shapeSig?.peek().kind !== "U"
    ) {
      this.turnBackRemaining = TURN_BACK_SEC;
      this.setPhaseText(TURN_BACK_CUE);
    }
    this.poseBurstPrev = poseBurst;
    if (this.turnBackRemaining > 0) {
      this.turnBackRemaining = Math.max(0, this.turnBackRemaining - delta);
      if (
        this.turnBackRemaining === 0 &&
        this.phase === "walk" &&
        this.trackCueRemaining <= 0 // don't clobber an active camera cue
      ) {
        this.setPhaseText("WALK"); // restore the live label once the cue ends
      }
    }

    // #32/#46 — tracking-source transparency. Mid-walk, MetricsSystem flips
    // globals.trackerActive as it hot-swaps camera<->head derivation; we
    // edge-detect that plain boolean (cheap, zero-alloc read) to repaint the
    // footer TRACKING line and flash a brief phase-line cue on a drop or
    // reconnect. Outside a walk trackerActive is stale (metrics only runs
    // while walking), so a 1 Hz timer re-checks the tracker's own staleness
    // window instead — latest() returns the cached frame or null, no alloc.
    if (this.phase === "walk") {
      const cam =
        (this.world.globals as Record<string, unknown>).trackerActive === true;
      this.camCueGap += delta;
      if (this.camActivePrev === null) {
        this.camActivePrev = cam; // walk just started — seed without a cue
        this.camEdgeHold = 0;
        this.camCueGap = TRACK_CUE_MIN_GAP_SEC; // a real first edge may cue
        this.refreshTrackLabel();
      } else if (cam !== this.camActivePrev) {
        // Night-review hysteresis: accept the edge only after it HOLDS —
        // a marginal stream at the staleness boundary flips trackerActive
        // every stream period and used to thrash the flagship phase line
        // (~2.5 cue publishes/s, never restoring WALK) for the whole walk.
        this.camEdgeHold += delta;
        if (this.camEdgeHold >= TRACK_EDGE_HOLD_SEC) {
          this.camActivePrev = cam;
          this.camEdgeHold = 0;
          this.refreshTrackLabel(); // the footer always tracks accepted state
          if (
            this.camCueGap >= TRACK_CUE_MIN_GAP_SEC &&
            this.turnBackRemaining <= 0 // fire-time arbitration: the turn-back
            // prompt owns the line (matches the expiry guards above/below)
          ) {
            this.camCueGap = 0;
            this.trackCueRemaining = TRACK_CUE_SEC;
            this.setPhaseText(cam ? CAMERA_BACK_CUE : CAMERA_DROP_CUE);
          } else if (this.trackCueRemaining > 0) {
            // Can't publish (min-gap / turn cue owns the line) but the
            // accepted state moved — retire the now-stale camera cue rather
            // than letting it assert the old state for its full window.
            this.trackCueRemaining = 0;
            if (this.turnBackRemaining <= 0) {
              this.setPhaseText("WALK");
            }
          }
        }
      } else {
        this.camEdgeHold = 0; // the flicker receded before the hold matured
      }
    } else {
      this.camActivePrev = null;
      this.camEdgeHold = 0;
      this.trackPollAcc += delta;
      if (this.trackPollAcc >= TRACK_POLL_SEC) {
        this.trackPollAcc = 0;
        this.refreshTrackLabel();
      }
    }
    if (this.trackCueRemaining > 0) {
      this.trackCueRemaining = Math.max(0, this.trackCueRemaining - delta);
      if (
        this.trackCueRemaining === 0 &&
        this.phase === "walk" &&
        this.turnBackRemaining <= 0 // the turn-back cue owns the line right now
      ) {
        this.setPhaseText("WALK");
      }
    }

    // #15: the "Runway fitted to your floor" confirmation reads for a few
    // seconds, then hides itself. Scalar timer; one element write at expiry.
    if (this.fitStatusRemaining > 0) {
      this.fitStatusRemaining = Math.max(0, this.fitStatusRemaining - delta);
      if (this.fitStatusRemaining === 0) {
        this.fitStatusEl?.setProperties({ display: "none" });
      }
    }

    // #17: a flashed mapping notice holds briefly, then the mode prompt is
    // restored. Scalar timer; one element write at expiry.
    if (this.mapNoticeRemaining > 0) {
      this.mapNoticeRemaining = Math.max(0, this.mapNoticeRemaining - delta);
      if (this.mapNoticeRemaining === 0 && this.mapMode !== "off") {
        this.mapPrompt?.setProperties({
          text: MAP_PROMPTS[this.mapMode],
          color: MAP_PROMPT_COLOR,
        });
      }
    }

    // Lazy-follow the panel to the trainee — at SUMMARY (read your result without
    // walking back), during the turn-back cue (so the prompt is in view), AND
    // while MAPPING (#17: placing the far end walks you 8-20 m from the panel's
    // world mount — the instructions must come along or they're unreadable).
    // SUMMARY PARKS: at summary the panel eases in front ONCE and then stays
    // WORLD-LOCKED (founder call — the continuous head-yaw follow made the menu
    // a moving target: turning to aim the controller moved the panel with you,
    // so the ray could never settle on a button). It re-follows only if the
    // trainee walks away (> PARK_BREAK_DIST from where they parked it). The
    // turn-back cue + mapping keep the continuous follow — those guide active
    // movement and are not pointer targets mid-motion.
    // DEV ONLY (?panelfront in the URL): pin the panel dead-ahead every frame in
    // ANY phase, so the emulator can be screenshotted face-on for layout work
    // (the IWER controller overlays otherwise cover the world-mounted panel, and
    // IWER exposes no way to pose the headset at it). Never true in a normal run.
    const devFront =
      (this.devPanelFront ||
        (typeof window !== "undefined" &&
          (window as unknown as { __PANEL_FRONT?: boolean }).__PANEL_FRONT ===
            true)) &&
      this.inXR();
    const followNow =
      devFront ||
      (this.inXR() &&
        (this.phase === "summary" ||
          this.turnBackRemaining > 0 ||
          this.mapMode !== "off"));
    if (followNow) {
      const wantPark =
        !devFront &&
        this.phase === "summary" &&
        this.turnBackRemaining <= 0 &&
        this.mapMode === "off";
      if (wantPark && this.summaryParked) {
        // World-locked. Re-arm the follow only if the trainee left the spot.
        this.player.head.getWorldPosition(this.headPos);
        if (this.headPos.distanceTo(this.parkAnchor) > PARK_BREAK_DIST) {
          this.summaryParked = false;
        }
      } else {
        const settled = this.lazyFollowPanel();
        if (wantPark && settled) {
          this.summaryParked = true;
          this.player.head.getWorldPosition(this.parkAnchor);
        }
      }
      this.followActive = true;
    } else if (this.followActive) {
      this.followActive = false;
      this.summaryParked = false;
      this.applyWorldPlacement();
    }

    // WALK CARD pill note: revert the honest label after its window (a
    // paint-only text write on the timer edge — never per-frame).
    if (this.shareNoteRemaining > 0) {
      this.shareNoteRemaining -= delta;
      if (this.shareNoteRemaining <= 0) {
        this.shareNoteRemaining = 0;
        this.el<UIKit.Text>("share-button")?.setProperties({
          text: SHARE_CARD_PILL,
        });
      }
    }

    // MEDAL reveal: delay to the graded sting's anchor, then a bounded
    // ~MEDAL_POP_SEC pop. Paint-only writes (opacity/transformScale — no
    // yoga relayout) during a sub-second window; the scrub-preview
    // bounded-window precedent. Scalar timers, zero allocation.
    if (this.medalDelayRemaining > 0) {
      this.medalDelayRemaining -= delta;
      if (this.medalDelayRemaining <= 0 && this.pendingMedal !== null) {
        this.medalPopElapsed = 0;
        this.medalBadge?.setProperties({
          display: "flex",
          opacity: 0,
          transformScaleX: 0.6,
          transformScaleY: 0.6,
        });
      }
    }
    if (this.medalPopElapsed >= 0) {
      this.medalPopElapsed += delta;
      const t = this.medalPopElapsed / MEDAL_POP_SEC;
      if (t >= 1) {
        this.medalBadge?.setProperties({
          opacity: 1,
          transformScaleX: 1,
          transformScaleY: 1,
        });
        this.medalPopElapsed = -1;
      } else {
        const s = medalPopScale(t);
        this.medalBadge?.setProperties({
          opacity: Math.min(1, t * 2.5),
          transformScaleX: s,
          transformScaleY: s,
        });
      }
    }

    // Section-swap fade: the incoming body section eases opacity 0 -> 1
    // (armed by applySections on the visibility edge). Paint-only writes in
    // a bounded sub-second window - the medal-pop precedent; scalar timer,
    // zero allocation beyond the bounded setProperties literals.
    if (this.sectionFadeElapsed >= 0 && this.sectionFadeEl) {
      this.sectionFadeElapsed += delta;
      const ft = this.sectionFadeElapsed / SECTION_FADE_SEC;
      if (ft >= 1) {
        this.sectionFadeEl.setProperties({ opacity: 1 });
        this.sectionFadeElapsed = -1;
        this.sectionFadeEl = null;
      } else {
        // ease-out quad - the web glass-in's settle feel.
        this.sectionFadeEl.setProperties({ opacity: 1 - (1 - ft) * (1 - ft) });
      }
    }

    // Tutorial body cross-fade on a step change (armed by renderTutorialStep):
    // opacity 0 -> 1 over TUT_PULSE_SEC. Paint-only, bounded, the medal-pop
    // precedent; the card only shows in idle/brief/summary so it lives above
    // the countdown early-return.
    if (this.tutPulseElapsed >= 0 && this.tutBody) {
      this.tutPulseElapsed += delta;
      const pt = this.tutPulseElapsed / TUT_PULSE_SEC;
      if (pt >= 1) {
        this.tutBody.setProperties({ opacity: 1 });
        this.tutPulseElapsed = -1;
      } else {
        this.tutBody.setProperties({ opacity: pt });
      }
    }

    // Cadence track (PACE card only): one lit pip steps left-to-right on the
    // beat so the trainee FEELS the runway rhythm before they walk it. Only
    // ticks while that card is the visible tutorial body (frame-budget guard),
    // and only writes on a beat change (edge, not per frame).
    if (
      this.tutorialShown() &&
      this.tutorialStep === TUTORIAL_PACE_STEP &&
      this.tutPips.length > 0
    ) {
      this.cadenceElapsed += delta;
      if (this.cadenceElapsed >= TUT_CADENCE_STEP_SEC || this.cadenceIndex < 0) {
        this.cadenceElapsed = 0;
        const prev = this.cadenceIndex;
        this.cadenceIndex = (this.cadenceIndex + 1) % this.tutPips.length;
        if (prev >= 0) {
          this.tutPips[prev]?.setProperties({
            backgroundColor: TUT_PIP_OFF_COLOR,
          });
        }
        this.tutPips[this.cadenceIndex]?.setProperties({
          backgroundColor: TUT_ON_COLOR,
        });
      }
    }

    // Live head-level indicator (CARRIAGE card only): read the LIVE head pitch
    // off player.head each frame and slide the marker so the trainee proves the
    // headset sees their head BEFORE any score is at stake (the learn-by-doing
    // beat). Marker + zone glow Carolina when the head is level. Only runs while
    // that card is the visible tutorial body (frame-budget guard, the cadence
    // precedent); paint-only + quantized so a settled head stops writing.
    if (
      this.tutorialShown() &&
      this.tutorialStep === TUTORIAL_CARRIAGE_STEP &&
      this.tutLevelMarker
    ) {
      // getWorldDirection = the head's local +Z (BEHIND the head); the look
      // direction is its negative, so look-dir.y = -dir.y and pitch =
      // asin(look-dir.y) (+ = chin up). The head-orient.ts convention - head
      // CARRIAGE, not gaze (the eyes are not tracked).
      this.player.head.getWorldDirection(this.tutLevelDir);
      const lookY = -this.tutLevelDir.y;
      const pitchDeg =
        Math.asin(lookY < -1 ? -1 : lookY > 1 ? 1 : lookY) * TUT_RAD2DEG;
      // Marker offset: map pitch to a horizontal deflection (clamped to the
      // track), then ease toward it frame-rate-independently so it glides.
      const clamped =
        pitchDeg < -TUT_LEVEL_SPAN_DEG
          ? -TUT_LEVEL_SPAN_DEG
          : pitchDeg > TUT_LEVEL_SPAN_DEG
            ? TUT_LEVEL_SPAN_DEG
            : pitchDeg;
      const target = (clamped / TUT_LEVEL_SPAN_DEG) * TUT_LEVEL_HALF_UNITS;
      this.tutLevelMarkerPos +=
        (target - this.tutLevelMarkerPos) *
        (1 - Math.exp(-TUT_LEVEL_EASE * delta));
      // Quantize + write only on a meaningful change - a settled head stops
      // emitting setProperties (the cadence on-change discipline).
      const q =
        Math.round(this.tutLevelMarkerPos / TUT_LEVEL_MARKER_STEP) *
        TUT_LEVEL_MARKER_STEP;
      if (q !== this.tutLevelMarkerWritten) {
        this.tutLevelMarkerWritten = q;
        this.tutLevelMarker.setProperties({ transformTranslateX: q });
      }
      // Level state off the RAW pitch vs the CARRIAGE band (M8_PITCH_BAND_DEG,
      // the exact scoring band): inside -> glow + "HEAD LEVEL"; below -> "LIFT
      // YOUR CHIN"; above -> "EASE YOUR CHIN DOWN". Written on state change only.
      const state: TutLevelState =
        pitchDeg >= -M8_PITCH_BAND_DEG && pitchDeg <= M8_PITCH_BAND_DEG
          ? "level"
          : pitchDeg < 0
            ? "low"
            : "high";
      if (state !== this.tutLevelState) {
        this.tutLevelState = state;
        const on = state === "level";
        this.tutLevelMarker.setProperties({
          backgroundColor: on ? TUT_ON_COLOR : TUT_DOT_OFF_COLOR,
        });
        this.tutLevelZone?.setProperties({
          borderColor: on ? TUT_ON_COLOR : TUT_DOT_OFF_COLOR,
        });
        this.tutLevelLabel?.setProperties({
          text: TUT_LEVEL_LABELS[state],
          color: on ? TUT_ON_COLOR : TUT_LEVEL_DIM_COLOR,
        });
      }
    }

    if (this.phase !== "countdown" || this.doc === null) {
      return;
    }
    this.countdownRemaining = Math.max(0, this.countdownRemaining - delta);
    const seconds = Math.max(1, Math.ceil(this.countdownRemaining));
    if (seconds !== this.lastCountdownInt) {
      this.lastCountdownInt = seconds;
      this.setPhaseText(String(seconds));
    }
  }

  private attachPanel(entity: Entity): void {
    const doc = PanelDocument.data.document[entity.index] as
      | UIKitDocument
      | undefined;
    if (!doc) {
      console.warn("[HUDSystem] lesson panel qualified without a document.");
      return;
    }
    this.panelEntity = entity;
    this.doc = doc;

    // DEV ONLY: expose the uikit document + namespace so capability probes
    // (the web-engine-skin research, 2026-07-10) can inject experimental
    // elements from the page console / playwright. Stripped from prod builds
    // by the DEV gate, like window.__XRUNWAY_WORLD.
    if (import.meta.env.DEV && typeof window !== "undefined") {
      (window as unknown as { __PANEL_DOC?: unknown }).__PANEL_DOC = doc;
      (window as unknown as { __UIKIT?: unknown }).__UIKIT = UIKit;
      // Dev hook: jump the tutorial to a card so each can be screenshotted
      // face-on (with __PANEL_SECTION="tutorial" + ?panelfront). Stripped in
      // prod, like __PANEL_DOC.
      (window as unknown as { __TUT_STEP?: (n: number) => void }).__TUT_STEP = (
        n: number,
      ) => {
        this.tutorialStep = n;
        this.renderTutorialStep();
      };
    }

    // Web-engine skins: mount the Chromium-baked alpha washes behind the
    // panel surfaces (once per document load - see src/panel-skins.ts).
    mountPanelSkins(doc);

    // The lesson HUD is a spatial XR panel only — never screen space. The DOM
    // landing covers 2D. Reclaim the document in case ScreenSpaceUISystem
    // already re-parented it under the camera.
    if (entity.hasComponent(ScreenSpace)) {
      entity.removeComponent(ScreenSpace);
    }
    const obj = entity.object3D;
    if (obj && doc.parent !== obj) {
      obj.add(doc);
      doc.position.set(0, 0, 0);
    }
    this.applyWorldPlacement();
    if (!entity.hasComponent(Visibility)) {
      entity.addComponent(Visibility, { isVisible: false });
    }

    // Cache elements.
    this.briefSection = this.el<UIKit.Container>("brief-section");
    this.liveSection = this.el<UIKit.Container>("live-section");
    this.summarySection = this.el<UIKit.Container>("summary-section");
    this.mapSection = this.el<UIKit.Container>("map-section");
    this.mapPrompt = this.el<UIKit.Text>("map-prompt");
    this.mapNote = this.el<UIKit.Text>("map-note");
    this.mapConfirmBtn = this.el<UIKit.Container>("map-confirm");
    this.phaseLine = this.el<UIKit.Text>("phase-line");
    this.timeBox = this.el<UIKit.Text>("time-box");
    this.overallScore = this.el<UIKit.Text>("overall-score");
    this.medalBadge = this.el<UIKit.Container>("medal-badge");
    this.medalText = this.el<UIKit.Text>("medal-text");
    this.deltaLine = this.el<UIKit.Text>("delta-line");
    this.sumVerdict = this.el<UIKit.Text>("sum-verdict");
    this.medalNote = this.el<UIKit.Text>("medal-note");
    this.sumStat = this.el<UIKit.Text>("sum-stat");
    this.sumCarriage = this.el<UIKit.Text>("sum-carriage");
    this.sumHold = this.el<UIKit.Text>("sum-hold");
    this.sumBeat = this.el<UIKit.Text>("sum-beat");
    this.sumTurn = this.el<UIKit.Text>("sum-turn");
    this.sumRepeat = this.el<UIKit.Text>("sum-repeat");
    this.sumHoldNote = this.el<UIKit.Text>("sum-hold-note");
    this.sumTurnNote = this.el<UIKit.Text>("sum-turn-note");
    for (let i = 0; i < this.noteEls.length; i++) {
      this.noteEls[i] = this.el<UIKit.Text>(`sum-note-${i + 1}`);
    }
    this.briefBar = this.el<UIKit.Text>("brief-bar");
    this.xrButton = this.el<UIKit.Text>("xr-button");
    this.fitStatusEl = this.el<UIKit.Text>("fit-status");
    this.bodyfitLine = this.el<UIKit.Text>("bodyfit-line");
    this.bodyfitStatus = this.el<UIKit.Text>("set-bodyfit-status");
    this.trackSrcEl = this.el<UIKit.Text>("track-src");
    this.lastTrackLabel = ""; // force the first TRACKING write after (re)attach
    this.lessonNo = this.el<UIKit.Text>("lesson-no");
    this.titleText = this.el<UIKit.Text>("title-text");
    this.instruction = this.el<UIKit.Text>("instruction");
    this.identName = this.el<UIKit.Text>("ident-name");
    this.identId = this.el<UIKit.Text>("ident-id");
    // Drive the HUD ident from the trainee UserPrefs (replaces hardcoded MATT).
    const userPrefsSig = this.globals.userPrefs as
      | Signal<UserPrefs>
      | undefined;
    const applyIdent = (): void => {
      const u = userPrefsSig ? userPrefsSig.peek() : DEFAULT_USER;
      this.identName?.setProperties({ text: u.name.toUpperCase() });
      // "ID 001" (no leading " - "): the ident is now stacked name-over-id.
      this.identId?.setProperties({ text: `ID ${u.id}` });
    };
    applyIdent();
    if (userPrefsSig) {
      this.cleanupFuncs.push(userPrefsSig.subscribe(applyIdent));
    }
    for (let i = 0; i < METRIC_COUNT; i++) {
      this.fillEls[i] = this.el<UIKit.Container>(`m${i + 1}-fill`);
      this.valEls[i] = this.el<UIKit.Text>(`m${i + 1}-val`);
      this.checkEls[i] = this.el<UIKit.Container>(`m${i + 1}-check`);
      this.sumEls[i] = this.el<UIKit.Text>(`s${i + 1}-val`);
      this.sumCheckEls[i] = this.el<UIKit.Container>(`s${i + 1}-check`);
    }
    this.lastVals.fill(-1);
    this.lastChecks.fill(-1);
    this.lastPhaseText = "";
    this.lastTimeShown = TIME_UNSET;

    // Wire buttons → ShowControls (resolved lazily — ShowDirector assigns it
    // in init()). Every handler is gated on an active XR session: in the 2D
    // browser the panel is hidden but its geometry would otherwise remain an
    // invisible ray target for clicks passing through the DOM landing.
    // Demo mode no longer exists — again-button just re-runs beginWalk.
    this.onClick("begin-button", () => {
      if (this.inXR()) this.controls()?.beginWalk();
    });
    this.onClick("again-button", () => {
      if (this.inXR()) this.controls()?.beginWalk();
    });
    // Replay Theater: play the ghost of the walk just scored on the runway.
    // The rig is never moved in XR — the trainee watches from where they
    // stand; any controller input exits (ReplayTheaterSystem owns all of it).
    this.onClick("replay-button", () => {
      if (this.inXR()) {
        (
          this.globals.replayControls as { start(): boolean } | null
        )?.start();
      }
    });
    // THE WALK CARD's honest pill: the headset browser cannot save/share a
    // composed image file, so tapping this only SAYS where the card lives —
    // a paint-only label swap, reverted by update() after SHARE_NOTE_SEC.
    this.onClick("share-button", () => {
      if (this.inXR()) {
        this.shareNoteRemaining = SHARE_NOTE_SEC;
        this.el<UIKit.Text>("share-button")?.setProperties({
          text: SHARE_CARD_NOTE,
        });
      }
    });
    this.onClick("reset-button", () => {
      if (this.inXR()) this.controls()?.reset();
    });
    this.onClick("xr-button", () => {
      if (this.inXR()) this.world.exitXR();
    });

    // Mapping (REV3) — start the walk-and-place flow / confirm / cancel. XR-
    // gated like the rest: the in-headset flow is walk-and-place; the desktop
    // emulator maps via the landing RUNWAY editor card. mapControls is read
    // defensively (MappingSystem may assign it after the HUD attaches).
    this.onClick("map-button", () => {
      if (this.inXR()) this.mapControls()?.startMapping();
    });
    this.onClick("map-confirm", () => {
      if (this.inXR()) this.mapControls()?.commit();
    });
    this.onClick("map-cancel", () => {
      if (this.inXR()) this.mapControls()?.cancelMapping();
    });

    // --- Settings section: the in-headset runway + mode editor. Writes the SAME
    // globals as the web editor (g.runwayShape / g.activeMode / g.crowdVisible),
    // so the two views stay in sync + persist for free. NOT XR-gated — the panel
    // is only interactable in XR anyway, and these are pure state changes.
    this.settingsSection = this.el<UIKit.Container>("settings-section");
    this.detailsSection = this.el<UIKit.Container>("details-section");
    this.scoringSection = this.el<UIKit.Container>("scoring-section");
    // Tutorial (first-run guide): cache the fixed elements the step renderer
    // writes into, plus the six progress dots + five cadence pips.
    this.tutorialSection = this.el<UIKit.Container>("tutorial-section");
    this.tutKicker = this.el<UIKit.Text>("tut-kicker");
    this.tutTitle = this.el<UIKit.Text>("tut-title");
    this.tutBody = this.el<UIKit.Text>("tut-body");
    this.tutCad = this.el<UIKit.Container>("tut-cad");
    // Live head-level indicator (CARRIAGE card only): the wrapper + the marker,
    // the centered zone, and the label the update() loop paints from head pitch.
    this.tutLevel = this.el<UIKit.Container>("tut-level");
    this.tutLevelMarker = this.el<UIKit.Container>("tut-level-marker");
    this.tutLevelZone = this.el<UIKit.Container>("tut-level-zone");
    this.tutLevelLabel = this.el<UIKit.Text>("tut-level-label");
    this.tutBackBtn = this.el<UIKit.Container>("tut-back");
    this.tutNextBtn = this.el<UIKit.Text>("tut-next");
    // Preference pills (MAKE IT YOURS card, founder call 2026-07-16): the
    // wrapper + the five pills whose labels the settings update fns stamp.
    this.tutPrefs = this.el<UIKit.Container>("tut-prefs");
    this.tutMusicBtn = this.el<UIKit.Text>("tut-music");
    this.tutModeBtn = this.el<UIKit.Text>("tut-mode");
    this.tutBpmBtn = this.el<UIKit.Text>("tut-bpm");
    this.tutBeatBtn = this.el<UIKit.Text>("tut-beat");
    this.tutDurationBtn = this.el<UIKit.Text>("tut-duration");
    this.tutDots = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
      this.el<UIKit.Container>(`tut-dot-${i}`),
    );
    this.tutPips = [0, 1, 2, 3, 4].map((i) =>
      this.el<UIKit.Container>(`tut-pip-${i}`),
    );
    this.shapeChips = ["straight", "t", "x", "u"].map((k) =>
      this.el<UIKit.Container>(`set-shape-${k}`),
    );
    this.modeChips = [0, 1, 2, 3].map((i) =>
      this.el<UIKit.Container>(`set-mode-${i}`),
    );
    this.crowdBtn = this.el<UIKit.Text>("set-crowd");
    this.floorFxBtn = this.el<UIKit.Text>("set-floorfx");
    this.levelBtn = this.el<UIKit.Text>("set-level");
    this.musicBtn = this.el<UIKit.Text>("set-music");
    this.beatBtn = this.el<UIKit.Text>("set-beat");
    this.bpmBtn = this.el<UIKit.Text>("set-bpm");
    this.paceStyleBtn = this.el<UIKit.Text>("set-pace-style");
    this.paceBandBtn = this.el<UIKit.Text>("set-pace-band");
    this.durationBtn = this.el<UIKit.Text>("set-duration");

    this.onClick("settings-button", () =>
      this.setSettingsOpen(!this.settingsOpen),
    );
    // GUIDE promoted to the footer (founder call 2026-07-13: "bring the guide up
    // to the same selection of buttons") - one tap replays the tutorial from any
    // idle/brief/summary state, not just Settings -> Guide.
    this.onClick("guide-button", () => this.setTutorialOpen(true));
    this.onClick("set-done", () => this.setSettingsOpen(false));
    this.onClick("set-shape-straight", () => this.setShapeKind("straight"));
    this.onClick("set-shape-t", () => this.setShapeKind("T"));
    this.onClick("set-shape-x", () => this.setShapeKind("X"));
    this.onClick("set-shape-u", () => this.setShapeKind("U"));

    // Size adjusters: cache the value + fill + row per field, wire −/+ (each also
    // FOCUSES the field so the thumbstick can scrub it), tapping the value just
    // focuses without stepping.
    for (const f of SIZE_FIELDS) {
      this.sizeValEls[f.id] = this.el<UIKit.Text>(`set-${f.id}-val`);
      this.sizeFillEls[f.id] = this.el<UIKit.Container>(`set-${f.id}-fill`);
      this.sizeRowEls[f.id] = this.el<UIKit.Container>(`row-${f.id}`);
      this.onClick(`set-${f.id}-dec`, () => {
        this.focusField(f.id);
        this.nudgeShape(f.key, -f.step);
      });
      this.onClick(`set-${f.id}-inc`, () => {
        this.focusField(f.id);
        this.nudgeShape(f.key, f.step);
      });
      this.onClick(`set-${f.id}-val`, () => this.focusField(f.id));
    }

    this.onClick("set-mode-0", () => this.setMode(0));
    this.onClick("set-mode-1", () => this.setMode(1));
    this.onClick("set-mode-2", () => this.setMode(2));
    this.onClick("set-mode-3", () => this.setMode(3));
    this.onClick("set-fit", () => this.mapControls()?.autoMapFromFloor());
    this.onClick("set-crowd", () => {
      if (this.crowdSig) this.crowdSig.value = !this.crowdSig.peek();
    });
    // Floor-glow toggle (founder call 2026-07-13) — flips globals.floorRingsVisible
    // (persisted in index.ts); ShaderTimeSystem reads it into uRingsOn so the
    // blue warp rings gate off. The per-step ripples are untouched.
    this.onClick("set-floorfx", () => {
      if (this.floorFxSig) this.floorFxSig.value = !this.floorFxSig.peek();
    });
    // LEVEL toggle (founder ruling 2026-07-15): Beginner <-> Emerging via the
    // SAME setMode path the retired chips used (writes g.activeMode + persists).
    // From a stale legacy mode (commercial/challenge) the first tap lands on
    // Beginner - a safe normalization, never a surprise tier.
    this.onClick("set-level", () => {
      const cur = this.modeSig?.peek() ?? DEFAULT_MODE;
      this.setMode(cur.id === "beginner" ? 1 : 0);
    });
    // Music on/off (#6) — writes the SAME globals.musicPrefs the landing
    // control does (volume stays whatever the landing set; persisted).
    this.onClick("set-music", () => {
      if (this.musicSig) {
        const cur = this.musicSig.peek();
        this.musicSig.value = { ...cur, enabled: !cur.enabled };
      }
    });
    // (Coach-voice pill removed — founder ruling 2026-07-16: text-only coach.)
    // Beat pulse (M9) — cycles the SAME three delivery states the landing
    // BEAT PULSE control does (cycleBeatPrefs; persisted via index.ts;
    // BeatHapticsSystem peeks the prefs per frame).
    this.onClick("set-beat", () => {
      if (this.beatSig) {
        this.beatSig.value = cycleBeatPrefs(this.beatSig.peek());
      }
    });
    // Music tempo (the multi-BPM founder call) — cycles the SAME 62/100/125
    // ring the landing MUSIC BPM picker does (cycleMusicBpm; persisted via
    // index.ts; the delivered tempo is latched per run at the countdown edge).
    this.onClick("set-bpm", () => {
      if (this.musicSig) {
        this.musicSig.value = cycleMusicBpm(this.musicSig.peek(), this.mode.id);
      }
    });
    // Pace style + the quiet ADVANCED band (founder ask 2026-07-18): which
    // side of the target the scoring forgives, and the band half-width.
    // Latched per run by MetricsSystem — a mid-walk tap applies next run.
    this.onClick("set-pace-style", () => {
      if (this.paceSig) this.paceSig.value = cyclePaceBias(this.paceSig.peek());
    });
    this.onClick("set-pace-band", () => {
      if (this.paceSig) this.paceSig.value = cyclePaceBand(this.paceSig.peek());
    });
    // Walk duration (founder call 2026-07-09) — cycles the 10-60 s options;
    // ShowDirectorSystem resolves the pref ONCE per run at its startRun mode
    // lock, so a mid-run cycle takes effect on the NEXT run (the tempo law).
    this.onClick("set-duration", () => {
      if (this.walkPrefsSig) {
        this.walkPrefsSig.value = cycleWalkSeconds(
          this.walkPrefsSig.peek(),
          this.mode,
        );
      }
    });
    // MAKE IT YOURS pills (tutorial card 1, founder call 2026-07-16): each
    // writes the SAME shared signal as its settings twin above, so a novice's
    // first-run choices ARE the settings — nothing to re-enter later.
    this.onClick("tut-music", () => {
      if (this.musicSig) {
        const cur = this.musicSig.peek();
        this.musicSig.value = { ...cur, enabled: !cur.enabled };
      }
    });
    this.onClick("tut-mode", () => {
      const cur = this.modeSig?.peek() ?? DEFAULT_MODE;
      this.setMode(cur.id === "beginner" ? 1 : 0);
    });
    this.onClick("tut-bpm", () => {
      if (this.musicSig) {
        this.musicSig.value = cycleMusicBpm(this.musicSig.peek(), this.mode.id);
      }
    });
    this.onClick("tut-beat", () => {
      if (this.beatSig) {
        this.beatSig.value = cycleBeatPrefs(this.beatSig.peek());
      }
    });
    this.onClick("tut-duration", () => {
      if (this.walkPrefsSig) {
        this.walkPrefsSig.value = cycleWalkSeconds(
          this.walkPrefsSig.peek(),
          this.mode,
        );
      }
    });
    // DETAILS (founder call 2026-07-08): the mode + music-tempo reference
    // subsection swaps the settings body; Done returns to settings.
    this.onClick("set-details", () => this.setDetailsOpen(true));
    this.onClick("det-done", () => this.setDetailsOpen(false));
    // SCORING (queue #5): the UNDERSTANDING THE SCORE education subsection —
    // the same swap contract as DETAILS.
    this.onClick("set-scoring", () => this.setScoringOpen(true));
    this.onClick("scoring-done", () => this.setScoringOpen(false));
    // TUTORIAL (first-run guide): the nav pills (also A-advanceable in update),
    // plus the Settings -> Guide replay entry. Next on the last card closes +
    // stamps the seen key; Skip closes + stamps from any card; Back steps back.
    this.onClick("tut-next", () => this.tutorialAdvance());
    this.onClick("tut-back", () => this.tutorialBack());
    this.onClick("tut-skip", () => this.closeTutorial());
    this.onClick("set-guide", () => this.setTutorialOpen(true));
    // Wave 1 FIT: arm the guided flow FIRST and close settings only on
    // success (the begin-button pattern below) — start() returning false is
    // a caller-side refusal (idle-only / demo / mapping / already running)
    // that publishes NO flow edge, so the guidance line never appears. The
    // XR caller must surface the reason itself (spec §4.3, the landing's
    // FIT_BUSY_TOAST law): keep the panel open and flash the reason into
    // the bodyfit status row; the next updateBodyFitStatus restores it.
    this.onClick("set-bodyfit-run", () => {
      const ok = this.fitControls()?.start() === true;
      if (ok) {
        this.setSettingsOpen(false);
        return;
      }
      this.bodyfitStatus?.setProperties({
        text: FIT_BUSY_TOAST,
        color: MAP_NOTICE_COLOR,
      });
    });
    this.onClick("set-preset-prev", () => this.cyclePreset(-1));
    this.onClick("set-preset-next", () => this.cyclePreset(1));
    this.onClick("set-reset", () => {
      if (this.shapeSig) this.shapeSig.value = { ...DEFAULT_SHAPE };
    });
    // Beginning a walk closes settings so the live HUD shows cleanly, and
    // dismisses the first-run tutorial (they chose to go — stamp it seen so it
    // does not re-open next entry).
    this.onClick("begin-button", () => {
      this.setSettingsOpen(false);
      if (this.tutorialOpen) this.closeTutorial();
    });

    // Apply current state immediately (replay existing signal values).
    this.applyModeCopy();
    this.renderTutorialStep();
    this.updateShapeUI();
    this.updateModeUI();
    this.updateCrowdUI();
    this.updateFloorFxUI();
    this.updateMusicUI();
    this.updateBeatUI();
    this.updateBpmUI();
    this.updatePaceUI();
    this.onPhase(this.phaseSig ? this.phaseSig.peek() : "idle");
    this.onMetrics(this.metricsSig ? this.metricsSig.peek() : null);
    this.onSummary(this.summarySig ? this.summarySig.peek() : null);
    this.onWalkRemaining(
      this.walkRemainingSig ? this.walkRemainingSig.peek() : -1,
    );
    this.onMapMode(this.mapModeSig ? this.mapModeSig.peek() : "off");
    this.onFitStatus(this.fitStatusSig ? this.fitStatusSig.peek() : "idle");
    this.onBodyFitFlow(this.bodyFitFlowSig ? this.bodyFitFlowSig.peek() : null);
    this.updateBodyFitStatus();
    this.refreshTrackLabel();
    this.onVisibility(this.world.visibilityState.peek());
  }

  private detachPanel(): void {
    this.doc = null;
    this.panelEntity = null;
    this.briefSection = null;
    this.liveSection = null;
    this.summarySection = null;
    this.mapSection = null;
    this.mapPrompt = null;
    this.mapNote = null;
    this.mapConfirmBtn = null;
    this.phaseLine = null;
    this.timeBox = null;
    this.overallScore = null;
    this.medalBadge = null;
    this.medalText = null;
    this.pendingMedal = null;
    this.medalDelayRemaining = 0;
    this.medalPopElapsed = -1;
    this.deltaLine = null;
    this.sumVerdict = null;
    this.medalNote = null;
    this.sumStat = null;
    this.sumCarriage = null;
    this.sumHold = null;
    this.sumBeat = null;
    this.sumTurn = null;
    this.sumRepeat = null;
    this.sumHoldNote = null;
    this.sumTurnNote = null;
    this.noteEls.fill(null);
    this.briefBar = null;
    this.xrButton = null;
    this.fitStatusEl = null;
    this.bodyfitLine = null;
    this.bodyfitStatus = null;
    this.trackSrcEl = null;
    this.lessonNo = null;
    this.titleText = null;
    this.instruction = null;
    this.fillEls.fill(null);
    this.valEls.fill(null);
    this.checkEls.fill(null);
    this.sumEls.fill(null);
    this.sumCheckEls.fill(null);
    // Settings refs too — a live-sync subscription must not setProperties on a
    // disposed UIKit element between detach and re-attach.
    this.settingsSection = null;
    this.detailsSection = null;
    this.scoringSection = null;
    this.tutorialSection = null;
    this.tutKicker = null;
    this.tutTitle = null;
    this.tutBody = null;
    this.tutCad = null;
    this.tutLevel = null;
    this.tutLevelMarker = null;
    this.tutLevelZone = null;
    this.tutLevelLabel = null;
    this.tutBackBtn = null;
    this.tutNextBtn = null;
    this.tutPrefs = null;
    this.tutMusicBtn = null;
    this.tutModeBtn = null;
    this.tutBpmBtn = null;
    this.tutBeatBtn = null;
    this.tutDurationBtn = null;
    this.tutDots = [];
    this.tutPips = [];
    this.shapeChips = [];
    this.modeChips = [];
    this.sizeValEls = {};
    this.sizeFillEls = {};
    this.sizeRowEls = {};
    this.crowdBtn = null;
    this.floorFxBtn = null;
    this.levelBtn = null;
    this.musicBtn = null;
    this.beatBtn = null;
    this.bpmBtn = null;
    this.paceStyleBtn = null;
    this.paceBandBtn = null;
    this.durationBtn = null;
    this.focusedField = null;
  }

  private onPhase(phase: ShowPhaseValue): void {
    this.phase = phase;
    if (phase === "countdown") {
      this.countdownRemaining = COUNTDOWN_SECONDS;
      this.lastCountdownInt = COUNTDOWN_SECONDS;
    }
    // MEDAL: start the reveal clock at the summary flip (onSummary already
    // armed pendingMedal — the director publishes the summary BEFORE the
    // phase). Any other phase kills a mid-flight reveal (B-hide/reset safe).
    if (phase === "summary" && this.pendingMedal !== null) {
      this.medalDelayRemaining = REVEAL_DELAY_SEC;
    } else if (phase !== "summary") {
      this.medalDelayRemaining = 0;
      this.medalPopElapsed = -1;
    }
    if (!this.doc) {
      return;
    }
    this.applySections();
    if (phase === "countdown") {
      this.setPhaseText(String(COUNTDOWN_SECONDS));
    } else if (phase === "walk") {
      this.setPhaseText("WALK");
    }
  }

  /** #15 — fit-to-room status line above the footer. Event-driven (MappingSystem
   * writes the edges: searching / no-floor / fitted / idle). "fitted" is a
   * confirmation, so it auto-hides after a short read window (update() timer);
   * searching/no-floor persist until the fit lands or is disarmed. */
  private onFitStatus(status: FitStatus): void {
    if (!this.doc || !this.fitStatusEl) {
      return;
    }
    if (status === "idle") {
      this.fitStatusRemaining = 0;
      this.fitStatusEl.setProperties({ display: "none" });
      return;
    }
    const line = FIT_STATUS_LINES[status];
    this.fitStatusEl.setProperties({
      display: "flex",
      text: line.text,
      color: line.color,
    });
    this.fitStatusRemaining = status === "fitted" ? FIT_FITTED_SHOW_SEC : 0;
  }

  /** #32/#46 — repaint the footer TRACKING line (change-gated). Mid-walk the
   * authoritative source is globals.trackerActive — what MetricsSystem is
   * actually scoring with THIS frame; otherwise the tracker's own staleness
   * window (latest(): the cached frame or null — no allocation). The frame's
   * space distinguishes the ARKit world stream from the browser image stream. */
  private refreshTrackLabel(): void {
    if (!this.trackSrcEl) {
      return;
    }
    const frame = this.tracker ? this.tracker.latest() : null;
    const cam =
      this.phase === "walk"
        ? (this.world.globals as Record<string, unknown>).trackerActive === true
        : frame !== null;
    const label = trackingSourceLabel(cam, frame ? frame.space : null);
    if (label === this.lastTrackLabel) {
      return;
    }
    this.lastTrackLabel = label;
    this.trackSrcEl.setProperties({
      text: label,
      color: cam ? TRACK_CAMERA_COLOR : TRACK_HEAD_COLOR,
    });
  }

  /** Wave 1 FIT — the guided flow's guidance line (brief section; showPhase
   * stays "idle" for the whole flow, so the brief is on screen). Edge-driven:
   * one write per stage transition / line change, hidden when no flow is
   * live. Verbatim ASCII from FIT_LINES (fit-session.ts). */
  private onBodyFitFlow(f: FitFlowState | null): void {
    if (!this.doc || !this.bodyfitLine) {
      return;
    }
    if (f === null) {
      this.bodyfitLine.setProperties({ display: "none" });
      return;
    }
    this.bodyfitLine.setProperties({ display: "flex", text: f.line });
  }

  /** Wave 1 FIT — settings-row baseline status ("Fit: not set" / "Fit: set
   * 3d ago"). Edge-driven off globals.bodyBaseline (save / trainee switch).
   * Also restores the row's base color: a refused "Run fit" press flashes
   * FIT_BUSY_TOAST into this row in the warning color, and the next status
   * update is the documented restore point. */
  private updateBodyFitStatus(): void {
    if (!this.doc || !this.bodyfitStatus) {
      return;
    }
    const b = this.bodyBaselineSig?.peek() ?? null;
    this.bodyfitStatus.setProperties({
      text: fitPanelStatusLine(b ? b.capturedAt : null, Date.now()),
      color: BODYFIT_STATUS_COLOR,
    });
  }

  /** Mapping mode → mapping panel + prompt + how-to note (#17); while mapping,
   * the normal brief/live/summary sections are hidden (mapping owns the panel). */
  private onMapMode(mode: MapMode): void {
    this.mapMode = mode;
    // Belt-and-braces for the B-toggle gate: mapping must never START against
    // a B-hidden panel (a desktop/landing-initiated start, or a same-frame
    // race, would otherwise run the flow headless). Entry-edge write only.
    if (mode !== "off" && this.hudVisibleSig?.peek() === false) {
      this.hudVisibleSig.value = true;
    }
    // A mode change supersedes any flashed notice (the fresh prompt below
    // already restores text + color).
    this.mapNoticeRemaining = 0;
    if (!this.doc) {
      return;
    }
    if (mode !== "off") {
      this.mapPrompt?.setProperties({
        text: MAP_PROMPTS[mode],
        color: MAP_PROMPT_COLOR,
      });
      this.mapNote?.setProperties({ text: MAP_NOTES[mode] });
      // #17: CONFIRM only once there is something to confirm (a formed draft in
      // "adjust") — pressing it earlier silently cancelled the whole flow, the
      // opposite of what the label promises.
      this.setDisplay(this.mapConfirmBtn, mode === "adjust");
    }
    this.applySections();
  }

  /** #17 — one-shot mapping notice (e.g. the far end rejected as too short):
   * flash it over the prompt in the warning color; update()'s timer restores
   * the mode prompt. Event-driven — MappingSystem posts one per trigger press. */
  private onMapNotice(notice: MapNotice | null): void {
    if (!notice || !this.doc || this.mapMode === "off") {
      return;
    }
    this.mapPrompt?.setProperties({
      text: notice.text,
      color: MAP_NOTICE_COLOR,
    });
    this.mapNoticeRemaining = MAP_NOTICE_SEC;
  }

  /**
   * Single source of section visibility. When mapping is active the mapping
   * panel takes over and every show section is hidden; otherwise the normal
   * phase-driven brief/live/summary toggle applies.
   */
  private applySections(): void {
    const mapping = this.mapMode !== "off";
    const phase = this.phase;
    // Settings takes over the body while open + not mapping + not mid-walk;
    // the DETAILS / SCORING subsections swap the settings body while open
    // (mutually exclusive — the setters clear each other).
    // The first-run tutorial takes over the body like settings (idle/brief/
    // summary, not mid-walk, not mapping) — mutually exclusive with settings
    // (the setters clear each other; the extra !tutorialOpen guard on the
    // settings gate is belt-and-braces so a stray state can't show both).
    const tutorialGate =
      this.tutorialOpen &&
      !mapping &&
      // Belt AND braces: the tutorial is an in-headset first-run guide - the
      // display gate itself enforces "never in the flat browser" (not only the
      // panel-level onVisibility). devPanelFront is the ?panelfront dev path.
      (this.inXR() || this.devPanelFront) &&
      (phase === "idle" || phase === "brief" || phase === "summary");
    let tutorial = tutorialGate;
    const settingsGate =
      this.settingsOpen &&
      !mapping &&
      !this.tutorialOpen &&
      (phase === "idle" || phase === "brief" || phase === "summary");
    let settings = settingsGate && !this.detailsOpen && !this.scoringOpen;
    let details = settingsGate && this.detailsOpen;
    let scoring = settingsGate && this.scoringOpen;
    const show = !mapping && !settingsGate && !tutorial;
    let briefVisible = show && (phase === "idle" || phase === "brief");
    let liveVisible = show && (phase === "countdown" || phase === "walk");
    let summaryVisible = show && phase === "summary";
    // DEV ONLY (window.__PANEL_SECTION = "settings"|"details"|"scoring"|
    // "tutorial", set BEFORE the world mounts, with ?panelfront for a face-on
    // screenshot): force one section visible for layout work — these sit behind
    // XR ray clicks the emulator can't drive headless (the __PANEL_FRONT
    // recipe's sibling). Never set in a normal run.
    const forced =
      typeof window !== "undefined"
        ? (window as unknown as { __PANEL_SECTION?: string }).__PANEL_SECTION
        : undefined;
    if (
      forced === "settings" ||
      forced === "details" ||
      forced === "scoring" ||
      forced === "tutorial"
    ) {
      briefVisible = liveVisible = summaryVisible = false;
      settings = forced === "settings";
      details = forced === "details";
      scoring = forced === "scoring";
      tutorial = forced === "tutorial";
    }
    this.setDisplay(this.briefSection, briefVisible);
    this.setDisplay(this.liveSection, liveVisible);
    this.setDisplay(this.summarySection, summaryVisible);
    this.setDisplay(this.mapSection, mapping);
    this.setDisplay(this.settingsSection, settings);
    this.setDisplay(this.detailsSection, details);
    this.setDisplay(this.scoringSection, scoring);
    this.setDisplay(this.tutorialSection, tutorial);
    // Section-swap fade: when the visible BODY section changes, ease the
    // incomer's opacity 0 -> 1 (update() drives it; SECTION_FADE_SEC). Edge-
    // triggered here only — never per-frame. Mapping keys off mapSection so
    // the placing->adjust prompt swap inside it does not re-fade.
    const visibleKey = mapping
      ? "map"
      : tutorial
        ? "tutorial"
        : settings
          ? "settings"
          : details
            ? "details"
            : scoring
              ? "scoring"
              : briefVisible
                ? "brief"
                : liveVisible
                  ? "live"
                  : summaryVisible
                    ? "summary"
                    : "";
    if (visibleKey !== this.visibleSectionPrev) {
      this.visibleSectionPrev = visibleKey;
      const el =
        visibleKey === "map"
          ? this.mapSection
          : visibleKey === "tutorial"
            ? this.tutorialSection
            : visibleKey === "settings"
              ? this.settingsSection
              : visibleKey === "details"
                ? this.detailsSection
                : visibleKey === "scoring"
                  ? this.scoringSection
                  : visibleKey === "brief"
                    ? this.briefSection
                    : visibleKey === "live"
                      ? this.liveSection
                      : visibleKey === "summary"
                        ? this.summarySection
                        : null;
      // Restore anything mid-fade before handing the slot over.
      if (this.sectionFadeEl && this.sectionFadeEl !== el) {
        this.sectionFadeEl.setProperties({ opacity: 1 });
      }
      if (el) {
        el.setProperties({ opacity: 0 });
        this.sectionFadeEl = el;
        this.sectionFadeElapsed = 0;
      } else {
        this.sectionFadeEl = null;
        this.sectionFadeElapsed = -1;
      }
    }
    // NB: snap-turn pause is NOT driven here — it's reconciled in update() off
    // settingsShown() (which also accounts for hudVisible + inXR), so a B-button
    // hide / XR exit can't leave TurnSystem stuck, and the browser demo's own
    // TurnSystem pause is never fought (applySections runs in the browser too).
  }

  /** Reusable scratch for settingsShown() — settingsShown runs EVERY frame in
   * update(), so it must not allocate (CLAUDE.md: no per-frame heap garbage). We
   * mutate this object and hand it to the pure predicate instead of building a new
   * one each call. */
  private readonly settingsState = {
    settingsOpen: false,
    mapMode: "",
    phase: "",
    hudVisible: true,
    inXR: false,
  };

  /** True iff the settings panel is actually visible + interactive to the trainee.
   * The scrub + snap-turn pause key off THIS, not raw settingsOpen — see
   * settingsPanelShown (pure + unit-tested). */
  private settingsShown(): boolean {
    // Cheap common-case short-circuit: settings is closed every frame of a walk /
    // in the browser, so return before touching the signal or the scratch.
    if (!this.settingsOpen) return false;
    const s = this.settingsState;
    s.settingsOpen = true;
    s.mapMode = this.mapMode;
    s.phase = this.phase;
    s.hudVisible = this.hudVisibleSig?.peek() ?? true;
    s.inXR = this.inXR();
    return settingsPanelShown(s);
  }

  /** Commit an in-flight thumbstick scrub (preview-only until release) before
   * focus or the panel changes, so the scrubbed value is never silently dropped. */
  private flushScrub(): void {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    const f = SIZE_FIELDS.find((x) => x.id === this.focusedField);
    if (f !== undefined) this.setField(f, this.scrubValue);
  }

  /** Drop focus + clear every size-row highlight (nothing is being scrubbed). */
  private clearFocus(): void {
    this.focusedField = null;
    this.scrubbing = false;
    for (const f of SIZE_FIELDS) {
      this.sizeRowEls[f.id]?.setProperties({ borderColor: "#1d2530" });
    }
  }

  /** Open/close the settings panel (single entry point so section visibility +
   * scrub/focus teardown stay in sync however settings is toggled). */
  private setSettingsOpen(open: boolean): void {
    this.settingsOpen = open;
    // Either edge resets the subsections: closing must not leave a stale
    // view for the next open, and opening always lands on settings.
    this.detailsOpen = false;
    this.scoringOpen = false;
    // Opening settings dismisses the first-run tutorial overlay (they are
    // mutually exclusive body takeovers) — NOT stamped seen, so it can still be
    // replayed from Settings -> Guide.
    if (open) this.tutorialOpen = false;
    if (!open) {
      this.flushScrub(); // commit a half-finished scrub instead of discarding it
      this.clearFocus();
    }
    this.applySections();
  }

  /** Swap between the settings body and the DETAILS reference subsection
   * (modes + music tempo). Entering commits/clears any in-flight size scrub
   * exactly like closing settings does — the size rows are hidden while
   * details shows, and a hidden scrub must never be silently dropped. */
  private setDetailsOpen(open: boolean): void {
    this.detailsOpen = open;
    if (open) {
      this.scoringOpen = false; // the subsections are mutually exclusive
      this.flushScrub();
      this.clearFocus();
    }
    this.applySections();
  }

  /** Swap between the settings body and the SCORING education subsection
   * (the landing UNDERSTANDING THE SCORE twin) — the exact setDetailsOpen
   * contract: entering commits/clears any in-flight size scrub, and the two
   * subsections clear each other. */
  private setScoringOpen(open: boolean): void {
    this.scoringOpen = open;
    if (open) {
      this.detailsOpen = false;
      this.flushScrub();
      this.clearFocus();
    }
    this.applySections();
  }

  // -- first-run in-headset tutorial -------------------------------------------

  /** Open/close the tutorial overlay. Opening lands on card 0, closes every
   * mutually-exclusive body takeover (settings/details/scoring), and repaints
   * the step; closing (via replay toggle) just re-applies sections. Stamping
   * the "seen" flag is closeTutorial()'s job, NOT this — a Settings -> Guide
   * replay must not depend on the key state. */
  private setTutorialOpen(open: boolean): void {
    this.tutorialOpen = open;
    if (open) {
      this.settingsOpen = false;
      this.detailsOpen = false;
      this.scoringOpen = false;
      this.flushScrub();
      this.clearFocus();
      this.tutorialStep = 0;
      this.renderTutorialStep();
    }
    this.applySections();
  }

  /** NEXT: advance a card, or close + stamp seen on the last one. */
  private tutorialAdvance(): void {
    if (this.tutorialStep >= TUTORIAL_STEPS.length - 1) {
      this.closeTutorial();
      return;
    }
    this.tutorialStep += 1;
    this.renderTutorialStep();
  }

  /** BACK: step to the previous card (no-op on the first). */
  private tutorialBack(): void {
    if (this.tutorialStep <= 0) return;
    this.tutorialStep -= 1;
    this.renderTutorialStep();
  }

  /** Close the tutorial and remember it was seen so it never auto-opens again. */
  private closeTutorial(): void {
    this.tutorialOpen = false;
    this.markTutorialSeen();
    this.applySections();
  }

  private markTutorialSeen(): void {
    try {
      localStorage.setItem(TUTORIAL_SEEN_KEY, "1");
    } catch {
      /* private-mode / storage-disabled: non-fatal, the tutorial just re-offers */
    }
  }

  /** First-run gate: auto-open only when the trainee has never seen the headset
   * tutorial AND has zero recorded walks (the DOM-onboarding gate, own key). */
  private shouldAutoOpenTutorial(): boolean {
    // Founder ruling 2026-07-22: auto-open whenever the walk HISTORY is
    // empty — no walks on record means a new trainee (or a fresh device /
    // cleared history), and the guide should greet them even if the
    // seen-key was stamped in some earlier life. The key still exists
    // (Skip/Done stamp it) but no longer gates the auto-open: history is
    // the single source of "has actually trained here". First XR entry of
    // the session only (the enteredXrOnce rising edge at the call site).
    const recorder = (this.world.globals as Record<string, unknown>)
      .sessionRecorder as { count?: () => number } | undefined;
    const walkCount = recorder?.count?.() ?? 0;
    return walkCount === 0;
  }

  /** True while the tutorial card is actually the visible, interactive body —
   * gates the A-button advance + the cadence beat in update() (the settingsShown
   * precedent: tutorialOpen alone is not enough — mapping / mid-walk / a
   * B-hidden panel must all suppress it). */
  private tutorialShown(): boolean {
    if (!this.tutorialOpen) return false;
    if (mapFlowActive(this.mapMode)) return false;
    const phase = this.phase;
    if (phase !== "idle" && phase !== "brief" && phase !== "summary") {
      return false;
    }
    if (!(this.hudVisibleSig?.peek() ?? true)) return false;
    return this.inXR() || this.devPanelFront;
  }

  /** Paint the current card into the fixed tutorial elements: kicker/title/body,
   * the Back visibility + Next label, the progress dots, the PACE-only cadence
   * track, and the CARRIAGE-only live head-level indicator. Arms a short body
   * cross-fade for step-change feedback. All
   * paint-only writes (no relayout beyond display toggles), null-guarded so an
   * early call (before attachPanel caches) is a safe no-op. */
  private renderTutorialStep(): void {
    const last = TUTORIAL_STEPS.length - 1;
    if (this.tutorialStep < 0) this.tutorialStep = 0;
    if (this.tutorialStep > last) this.tutorialStep = last;
    const step = this.tutorialStep;
    const s = TUTORIAL_STEPS[step];
    this.tutKicker?.setProperties({ text: s.kicker });
    this.tutTitle?.setProperties({ text: s.title });
    this.tutBody?.setProperties({ text: s.body });
    // Back hidden on the first card; Next reads "Done" on the last.
    this.setDisplay(this.tutBackBtn, step > 0);
    this.tutNextBtn?.setProperties({
      text: step === last ? TUTORIAL_DONE_LABEL : TUTORIAL_NEXT_LABEL,
    });
    // Progress dots: the active one fills Carolina + pops scale.
    for (let i = 0; i < this.tutDots.length; i += 1) {
      const on = i === step;
      this.tutDots[i]?.setProperties({
        backgroundColor: on ? TUT_ON_COLOR : TUT_DOT_OFF_COLOR,
        transformScaleX: on ? 1.35 : 1,
        transformScaleY: on ? 1.35 : 1,
      });
    }
    // The preference pills live on the MAKE IT YOURS card only; refresh their
    // labels each time it (re)appears so first-open shows the live prefs.
    const showPrefs = step === TUTORIAL_PREFS_STEP;
    this.setDisplay(this.tutPrefs, showPrefs);
    if (showPrefs) {
      this.updateMusicUI();
      this.updateModeUI();
      this.updateBeatUI();
      this.updateDurationUI();
    }
    // The cadence track lives on the PACE card only; reset the beat each time
    // it (re)appears so the pips light from the first one, and dim every pip
    // when it is hidden so a stale lit pip never lingers on another card.
    const showCad = step === TUTORIAL_PACE_STEP;
    this.setDisplay(this.tutCad, showCad);
    this.cadenceElapsed = 0;
    this.cadenceIndex = -1;
    if (!showCad) {
      for (const pip of this.tutPips) {
        pip?.setProperties({ backgroundColor: TUT_PIP_OFF_COLOR });
      }
    }
    // The live head-level indicator lives on the CARRIAGE card only; re-arm the
    // paint state each time it (re)appears so update() re-seeds from head pitch,
    // and recenter + dim it when hidden so a stale glow/offset never lingers on
    // another card (the cadence-reset precedent).
    const showLevel = step === TUTORIAL_CARRIAGE_STEP;
    this.setDisplay(this.tutLevel, showLevel);
    this.tutLevelMarkerPos = 0;
    this.tutLevelMarkerWritten = Number.NaN;
    this.tutLevelState = null;
    if (!showLevel) {
      this.tutLevelMarker?.setProperties({
        transformTranslateX: 0,
        backgroundColor: TUT_DOT_OFF_COLOR,
      });
      this.tutLevelZone?.setProperties({ borderColor: TUT_DOT_OFF_COLOR });
      this.tutLevelLabel?.setProperties({
        text: TUT_LEVEL_LABELS.level,
        color: TUT_LEVEL_DIM_COLOR,
      });
    }
    // Body cross-fade: feedback the card changed (paint-only opacity in update).
    this.tutBody?.setProperties({ opacity: 0 });
    this.tutPulseElapsed = 0;
  }

  // -- in-headset settings: write the SAME globals the web editor writes --------

  private setShapeKind(kind: RunwayShape["kind"]): void {
    if (!this.shapeSig) return;
    this.shapeSig.value = sanitizeShape({ ...this.shapeSig.peek(), kind });
  }

  /** Nudge one numeric shape field; sanitizeShape clamps to the limits. */
  private nudgeShape(key: keyof RunwayShape, delta: number): void {
    if (!this.shapeSig) return;
    const cur = this.shapeSig.peek();
    // LENGTH edits anchor the START LINE, not the center (the Quest tester's
    // short-runway fix — anchorStartOnLengthEdit): shrinking about the center
    // pulled the start line away from the trainee standing on it.
    if (key === "spineLength") {
      this.shapeSig.value = anchorStartOnLengthEdit(cur, cur.spineLength + delta);
      return;
    }
    this.shapeSig.value = sanitizeShape({
      ...cur,
      [key]: (cur[key] as number) + delta,
    });
  }

  private setMode(i: number): void {
    const m = MODES[i];
    if (!m || !this.modeSig) return;
    this.modeSig.value = m;
    saveMode(m);
  }

  private cyclePreset(dir: number): void {
    if (!this.shapeSig || PRESET_RUNWAYS.length === 0) return;
    const n = PRESET_RUNWAYS.length;
    this.presetIdx = (this.presetIdx + dir + n) % n;
    const preset = PRESET_RUNWAYS[this.presetIdx];
    if (!preset) return;
    this.shapeSig.value = sanitizeShape(preset.shape);
    const idSig = this.world.globals.activeRunwayId as
      | Signal<string | null>
      | undefined;
    if (idSig) idSig.value = preset.id;
  }

  private setChipActive(el: UIKit.Container | null, active: boolean): void {
    // Values mirror ui/lesson.uikitml .seg base (the two must move together);
    // the active chip carries a light accent rim (#8ec4e8) over its fill.
    // The stamped `hover` section is REQUIRED: uikit's class :hover layer
    // outranks element-stamped BASE props, so without it, pointing the ray
    // at the SELECTED chip let .seg:hover repaint the rim #4b9cd3 - the
    // fill color - erasing it exactly at the moment of interaction (review
    // catch 2026-07-10). Element-stamped hover outranks the class hover.
    // Event-edge writes only (clicks), so the literals respect the
    // zero-per-frame-alloc law.
    el?.setProperties(
      active
        ? {
            backgroundColor: "#4b9cd3",
            color: "#05070a",
            borderColor: "#8ec4e8",
            hover: { borderColor: "#8ec4e8", color: "#05070a" },
          }
        : {
            backgroundColor: "#0d1218",
            color: "#c7ccd2",
            borderColor: "#232a33",
            hover: { borderColor: "#4b9cd3", color: "#8ec4e8" },
          },
    );
  }

  /** Focus a SIZE field for thumbstick scrubbing + highlight its row. Commits any
   * in-flight scrub on the PREVIOUS field first, so switching fields (or tapping
   * the same field's −/+) mid-scrub doesn't discard the scrubbed value. */
  private focusField(id: string): void {
    this.flushScrub();
    this.focusedField = id;
    this.scrubbing = false;
    for (const f of SIZE_FIELDS) {
      const on = f.id === id;
      this.sizeRowEls[f.id]?.setProperties({
        borderColor: on ? "#4b9cd3" : "#1d2530",
      });
    }
  }

  /** The reachable floor for a field. armSpan is special: sanitizeShape floors it
   * to the current armWidth, so its true minimum is dynamic — using the static 0
   * would leave the bar ~6% full when "−" has already bottomed out. */
  private effectiveMin(f: SizeField): number {
    if (f.key === "armSpan" && this.shapeSig) {
      return Math.max(f.min, this.shapeSig.peek().armWidth);
    }
    return f.min;
  }

  /** Paint one field's value text + fill bar. Used by both the signal-driven
   * refresh and the live thumbstick scrub (which must NOT rebuild the stage). */
  private renderFieldValue(f: SizeField, v: number): void {
    this.sizeValEls[f.id]?.setProperties({
      text: f.pct ? `${Math.round(v * 100)}%` : `${v.toFixed(1)} m`,
    });
    const lo = this.effectiveMin(f);
    const frac = Math.max(0, Math.min(1, (v - lo) / (f.max - lo || 1)));
    this.sizeFillEls[f.id]?.setProperties({
      width: `${Math.round(frac * 100)}%` as `${number}%`,
    });
  }

  /** Set one field to an absolute value (commits + rebuilds the stage once).
   * LENGTH commits anchor the START LINE (nudgeShape's law — the scrub path
   * lands here on release). */
  private setField(f: SizeField, v: number): void {
    if (!this.shapeSig) return;
    if (f.key === "spineLength") {
      this.shapeSig.value = anchorStartOnLengthEdit(this.shapeSig.peek(), v);
      return;
    }
    this.shapeSig.value = sanitizeShape({ ...this.shapeSig.peek(), [f.key]: v });
  }

  private updateShapeUI(): void {
    if (!this.shapeSig) return;
    const s = this.shapeSig.peek();
    const kinds: Array<RunwayShape["kind"]> = ["straight", "T", "X", "U"];
    for (let i = 0; i < 4; i++) {
      this.setChipActive(this.shapeChips[i] ?? null, s.kind === kinds[i]);
    }
    const hasArms = s.kind !== "straight";
    const hasCross = s.kind === "T" || s.kind === "X";
    for (const f of SIZE_FIELDS) {
      // Contextual rows: arm span only for T/X/U, cross point only for T/X.
      const visible =
        f.shapes === "all" ||
        (f.shapes === "arms" && hasArms) ||
        (f.shapes === "tx" && hasCross);
      this.setDisplay(this.sizeRowEls[f.id] ?? null, visible);
      // If the focused field's row just got hidden by a kind change, drop focus
      // (no commit — the value applies to a shape that's no longer selected) so the
      // thumbstick can't scrub an invisible control.
      if (!visible && this.focusedField === f.id) {
        this.scrubbing = false;
        this.focusedField = null;
        this.sizeRowEls[f.id]?.setProperties({ borderColor: "#1d2530" });
      }
      this.renderFieldValue(f, s[f.key] as number);
    }
  }

  private updateModeUI(): void {
    const cur = this.modeSig?.peek() ?? DEFAULT_MODE;
    for (let i = 0; i < 4; i++) {
      const m = MODES[i];
      this.setChipActive(this.modeChips[i] ?? null, !!m && m.id === cur.id);
    }
    // LEVEL pill (founder ruling 2026-07-15): names the ACTIVE tier honestly -
    // including a legacy mode resurfaced via a stale xrunway.mode.v1 pref
    // (tapping normalizes back into the Beginner/Emerging pair).
    this.levelBtn?.setProperties({ text: `Level: ${LEVEL_LABELS[cur.id]}` });
    this.tutModeBtn?.setProperties({ text: `Level: ${LEVEL_LABELS[cur.id]}` });
  }

  private updateCrowdUI(): void {
    const on = this.crowdSig?.peek() ?? true;
    this.crowdBtn?.setProperties({ text: `Crowd: ${on ? "on" : "off"}` });
  }

  private updateFloorFxUI(): void {
    const on = this.floorFxSig?.peek() ?? true;
    this.floorFxBtn?.setProperties({ text: `Floor glow: ${on ? "on" : "off"}` });
  }

  private updateMusicUI(): void {
    const on = this.musicSig?.peek().enabled ?? true;
    this.musicBtn?.setProperties({ text: `Music: ${on ? "on" : "off"}` });
    this.tutMusicBtn?.setProperties({ text: `Music: ${on ? "on" : "off"}` });
    this.updateBpmUI(); // the tempo rides the same musicPrefs signal
  }

  /** M9 beat-pulse pill label (the set-music/set-coach pattern; ASCII —
   * beatPrefsLabel's XR surface, pinned in beat-prefs.test.ts). */
  private updateBeatUI(): void {
    const p = this.beatSig?.peek() ?? DEFAULT_BEAT;
    this.beatBtn?.setProperties({ text: beatPrefsLabel(p, "xr") });
    this.tutBeatBtn?.setProperties({ text: beatPrefsLabel(p, "xr") });
  }

  /** Music tempo pill label (the set-beat pattern; ASCII — musicBpmLabel's
   * XR surface, pinned in music-prefs.test.ts). Resolves against the active
   * mode while the pref is unset. */
  private updateBpmUI(): void {
    const p = this.musicSig?.peek() ?? DEFAULT_MUSIC;
    this.bpmBtn?.setProperties({
      text: musicBpmLabel(p, this.mode.id, "xr"),
    });
    this.tutBpmBtn?.setProperties({
      text: musicBpmLabel(p, this.mode.id, "xr"),
    });
  }

  private updatePaceUI(): void {
    const p = this.paceSig?.peek() ?? DEFAULT_PACE;
    this.paceStyleBtn?.setProperties({ text: paceBiasLabel(p) });
    this.paceBandBtn?.setProperties({ text: paceBandLabel(p) });
  }

  /** Walk-duration pill label (the set-bpm pattern; ASCII — walkSecondsLabel's
   * XR surface, pinned in walk-prefs.test.ts). Resolves against the active
   * mode while the pref is unset, and re-stamps the idle TIME box so the
   * header never shows a length the next run won't honor. */
  private updateDurationUI(): void {
    const p = this.walkPrefsSig?.peek() ?? DEFAULT_WALK;
    this.durationBtn?.setProperties({
      text: walkSecondsLabel(p, this.mode, "xr"),
    });
    this.tutDurationBtn?.setProperties({
      text: walkSecondsLabel(p, this.mode, "xr"),
    });
    if (this.phase === "idle" || this.phase === "summary") {
      this.lastTimeShown = TIME_UNSET;
      this.onWalkRemaining(-1);
    }
  }

  private onMetrics(snapshot: MetricSnapshot | null): void {
    if (!this.doc) {
      return;
    }
    if (!snapshot) {
      // Run reset (ShowDirector publishes null at every startRun) — clear the
      // bars + checkboxes so a repeat run's countdown doesn't show the
      // previous walk's finals.
      this.lastVals.fill(-1);
      this.lastChecks.fill(0);
      for (let i = 0; i < METRIC_COUNT; i++) {
        this.fillEls[i]?.setProperties({ width: "0%" });
        this.valEls[i]?.setProperties({ text: "-" });
        this.setCheck(this.checkEls[i], false);
      }
      // A stale medal must never greet the next summary (same law).
      this.pendingMedal = null;
      this.medalDelayRemaining = 0;
      this.medalPopElapsed = -1;
      this.medalBadge?.setProperties({ display: "none" });
      return;
    }
    // The carriage tracker's running score (shared via globals.headCarriage) —
    // the 3rd row shows it live instead of rhythm (see CARRIAGE_SLOT).
    const carriage = this.world.globals.headCarriage as
      | CarriageTracker
      | undefined;
    for (let i = 0; i < METRIC_COUNT; i++) {
      const value =
        i === CARRIAGE_SLOT
          ? Math.round(carriage?.liveScore() ?? 0)
          : Math.round(snapshot[METRIC_KEYS[i]!]!);
      if (value !== this.lastVals[i]) {
        this.lastVals[i] = value;
        this.fillEls[i]?.setProperties({ width: `${value}%` as `${number}%` });
        this.valEls[i]?.setProperties({ text: String(value) });
      }
      // Checkbox fills Carolina Blue at the active mode's pass threshold.
      const passed = value >= this.mode.passThreshold ? 1 : 0;
      if (passed !== this.lastChecks[i]) {
        this.lastChecks[i] = passed;
        this.setCheck(this.checkEls[i], passed === 1);
      }
    }
  }

  private onSummary(summary: ShowSummary | null): void {
    if (!summary || !this.doc) {
      return;
    }
    // Grade with the LOCKED run mode stamped on the summary (mode-lock): the
    // live this.mode can have moved during the brief window, and this panel
    // must agree with the persisted row. Live-mode fallback only when the
    // stamp is absent/unknown (safety — e.g. a summary built without the
    // director).
    const mode =
      (summary.modeId
        ? MODES.find((m) => m.id === summary.modeId)
        : undefined) ?? this.mode;
    this.overallScore?.setProperties({
      text: String(Math.round(summary.overall)),
    });
    // Replay Theater pill: only when the walk just recorded is replayable
    // (head-path trajectory samples exist). Looked up on demand — a summary
    // flip, not a per-frame path.
    {
      const rc = this.globals.replayControls as
        | { available(): boolean }
        | null
        | undefined;
      this.setDisplay(
        this.el("replay-button"),
        rc !== null && rc !== undefined && rc.available(),
      );
    }
    // Trainee history INCLUDING this walk (the recorder finalizes before
    // this renderer — installSessionRecorder subscribes first, index.ts);
    // used for the RANKING medal below and reused by the M12 row later.
    const medalRec = this.globals.sessionRecorder as
      | { list(): Array<RepeatRow & { trainee?: { id?: unknown } | null }> }
      | undefined;
    const medalUserSig = this.globals.userPrefs as
      | Signal<UserPrefs>
      | undefined;
    const traineeHistory = medalRec
      ? medalRec
          .list()
          .filter((r) => rowMatchesTrainee(r, medalUserSig?.peek().id ?? null))
      : [];
    // MEDAL: the RANKING badge (founder ruling 2026-07-10) — this walk's
    // POSITION among the trainee's walks, best = gold, 2nd silver, 3rd
    // bronze, one walk = gold. medalRank ranks summary.overall against the
    // history above. Armed here, revealed by update() at the
    // +REVEAL_DELAY_SEC graded-sting anchor once the phase flips to summary
    // — hidden until then so the pop is a single moment, not a flicker.
    const medal = scoreMedal(medalRank(summary.overall, traineeHistory));
    this.pendingMedal = medal;
    this.medalDelayRemaining = 0;
    this.medalPopElapsed = -1;
    if (medal === null) {
      this.medalBadge?.setProperties({ display: "none" });
      // No medal (4th-or-worse walk) — the caption has nothing to explain.
      this.medalNote?.setProperties({ display: "none" });
    } else {
      this.medalText?.setProperties({ text: MEDAL_LABEL[medal] });
      this.medalBadge?.setProperties({
        display: "none",
        backgroundColor: MEDAL_COLOR[medal],
      });
      // F.24: the caption is written at render time (the sumVerdict/sumStat
      // pattern), NOT during the badge pop — the pop stays a paint-only window
      // (opacity/scale, no yoga relayout). The badge lands ~0.9s later onto a
      // caption already explaining that the medal is a personal rank, not the
      // pass bar (so a gold beside NEEDS WORK reads as intended).
      this.medalNote?.setProperties({ display: "flex", text: MEDAL_RANK_NOTE });
    }
    const delta = summary.deltaVsLast;
    this.deltaLine?.setProperties({
      text:
        delta === null
          ? "FIRST WALK - BASELINE SET"
          : `${delta >= 0 ? "+" : ""}${Math.round(delta)} VS LAST WALK`,
    });
    for (let i = 0; i < METRIC_COUNT; i++) {
      // The 3rd row shows head CARRIAGE (summary.carriage.carriageScore), not
      // rhythm. A null carriage (short walk / no orientation stream) shows "-".
      const isCarriage = i === CARRIAGE_SLOT;
      const raw = isCarriage
        ? (summary.carriage?.carriageScore ?? null)
        : summary.scores[METRIC_KEYS[i]!]!;
      const text = raw === null ? "-" : String(Math.round(raw));
      this.sumEls[i]?.setProperties({ text });
      this.setCheck(
        this.sumCheckEls[i],
        raw !== null && Math.round(raw) >= mode.passThreshold,
      );
    }
    // Coach layer (#9/#16): verdict vs the mode's own bar, duration + real
    // steps/cadence (#22), and up to 3 corrective notes — directional when the
    // walk's measurements back the claim (#8). Event-driven (one summary per
    // walk), so the report allocation is fine. ASCII-only strings throughout.
    // M8: applyCarriageNotes post-processes the report (identity unless
    // carriage is non-null AND a presence note qualifies) — buildCoachReport
    // itself stays behaviorally untouched (adjudication §I).
    const report = applyCarriageNotes(
      buildCoachReport({
        scores: summary.scores,
        overall: summary.overall,
        mode,
        stats: summary.stats,
        // Left/right footwork copy is only honest on a one-way route (U) — the
        // lateral sign flips on the return leg of an out-and-back walk. Use the
        // route SNAPSHOT the director stamped on the summary (the route the
        // lateral data was collected on), never the live shape at render time.
        oneWayRoute: summary.oneWayRoute,
      }),
      summary.carriage ?? null,
    );
    this.sumVerdict?.setProperties({
      text: verdictLine(report),
      color: report.passed ? "#4b9cd3" : "#e9818f", // accent / landing's .low
    });
    this.sumStat?.setProperties({
      text: walkStatLine(summary.durationSec, summary.stats),
    });
    // M8 head-carriage row — ASCII default separator (XR panel law); hidden
    // when the channel never engaged this walk (the noteEls pattern).
    const carriage = carriageLine(summary.carriage ?? null);
    this.sumCarriage?.setProperties(
      carriage !== null
        ? { display: "flex", text: carriage }
        : { display: "none" },
    );
    // M10 hold row — the core's copy verbatim (holdStatLine; ASCII by
    // construction). A NULL hold still renders (NO READ, branched on the
    // reason enum — different facts, different sentence); only a summary
    // built WITHOUT a director (absent stamp: legacy fixture / partial
    // world) hides the row. Absent-reason fallback "no-data" makes the
    // weaker claim (window unmeasured, not "the walk ended early").
    this.sumHold?.setProperties(
      summary.hold !== undefined
        ? {
            display: "flex",
            text: holdStatLine(
              summary.hold,
              summary.holdNullReason ?? "no-data",
            ),
          }
        : { display: "none" },
    );
    // M9 beat row — the core's copy verbatim (beatStatLine; ASCII by
    // construction), directly AFTER the hold row (§G order HOLD -> BEAT).
    // A NULL beat still renders (NO READ, branched on the reason enum);
    // only a summary built WITHOUT a director (absent stamp) hides the
    // row. Absent-reason fallback "no-clock" makes the weakest (internal)
    // claim — the grid anchor was never armed in a metrics-less world.
    this.sumBeat?.setProperties(
      summary.beat !== undefined
        ? {
            display: "flex",
            text: beatStatLine(
              summary.beat,
              summary.beatNullReason ?? "no-clock",
            ),
          }
        : { display: "none" },
    );
    // M11 turn row — the core's copy verbatim (turnStatLine; ASCII default
    // separator, the panel law), directly AFTER the beat row (§G order
    // HOLD -> BEAT -> TURN). A NULL turn still renders (NO READ, branched
    // on the 7-reason taxonomy — a null read is a fact worth a sentence) —
    // EXCEPT the both-null stamp case (no analyzer ran: metrics-less world
    // / legacy fixture), which hides the row entirely. The presence rule is
    // the pure turnRowStamped (summary-riders.ts), shared with the landing
    // + the rider so the surfaces can never disagree; the reason fallback
    // "tracking-dark" is the weakest sensor claim (inert in practice — a
    // stamped null row always carries its reason).
    this.sumTurn?.setProperties(
      turnRowStamped(summary)
        ? {
            display: "flex",
            text: turnStatLine(
              summary.turn ?? null,
              summary.turnNullReason ?? "tracking-dark",
            ),
          }
        : { display: "none" },
    );
    // M12 consistency row — the recorder already finalized THIS walk (it
    // subscribed to the summary signal first: installSessionRecorder runs
    // before any system registers, index.ts), so the window the compact line
    // describes includes the walk on this card. Trainee-scoped like every
    // records surface; event-time compute (one summary per walk), ASCII by
    // construction (compactLine). Hidden below 3 matched walks or when the
    // recorder is unwired (partial world / fixture).
    const rec = this.globals.sessionRecorder as
      | { list(): Array<RepeatRow & { trainee?: { id?: unknown } | null }> }
      | undefined;
    const repUserSig = this.globals.userPrefs as Signal<UserPrefs> | undefined;
    const rep = rec
      ? repeatabilityReport(
          rec
            .list()
            .filter((r) =>
              rowMatchesTrainee(r, repUserSig?.peek().id ?? null),
            ),
        )
      : null;
    this.sumRepeat?.setProperties(
      rep ? { display: "flex", text: rep.compactLine } : { display: "none" },
    );
    // F.27 head-motion observation notes — the hold DWELL + turn SMOOTHNESS
    // reads answer the trainee's first two post-walk questions ("did I hold
    // long enough / was my turn smooth"). DISPLAY-ONLY (hold-turn-notes.ts):
    // computed here from the summary stamps, NOT scored, NOT in any golden
    // vector, NOT recorded — deliberately off the golden-pinned holdCue/turnCue
    // rider path the honest card drops. Gated: a null hold/turn (never marked /
    // one-way / dark) yields no note and the line hides (holdNote/turnNote
    // return null) — so a U walk shows one line, a dark walk none.
    const hNote = holdNote(summary.hold ?? null);
    this.sumHoldNote?.setProperties(
      hNote !== null
        ? { display: "flex", text: hNote.text }
        : { display: "none" },
    );
    const tNote = turnNote(summary.turn ?? null);
    this.sumTurnNote?.setProperties(
      tNote !== null
        ? { display: "flex", text: tNote.text }
        : { display: "none" },
    );
    // Headset-only honest card (the landing's filter, mirrored): coach only
    // the metrics the card SHOWS. Notes about the hidden POSTURE / RHYTHM /
    // composites, and the HOLD / BEAT / TURN riders, are dropped so a note
    // never references a channel the trainee can't see on the panel.
    // (Revert to full: render report.notes + buildSummaryRiders(summary).)
    const shownNotes = report.notes.filter((n) =>
      SHIPPED_METRIC_KEYS.includes(n.key),
    );
    for (let i = 0; i < this.noteEls.length; i++) {
      const el = this.noteEls[i];
      if (!el) continue;
      const note = shownNotes[i];
      if (note) {
        const m = METRICS.find((x) => x.key === note.key);
        el.setProperties({
          display: "flex",
          text: `${m ? m.label : note.key}: ${note.cue}`,
        });
      } else if (i === 0 && shownNotes.length === 0) {
        // Every metric cleared the line — say so instead of an empty block.
        el.setProperties({ display: "flex", text: CLEAN_WALK_CUE });
      } else {
        el.setProperties({ display: "none" });
      }
    }
  }

  /** Push the active mode's lesson copy into the brief (no-op until panel attached). */
  private applyModeCopy(): void {
    if (!this.doc) {
      return;
    }
    this.lessonNo?.setProperties({ text: `LESSON ${this.mode.number}` });
    this.titleText?.setProperties({ text: this.mode.label });
    this.instruction?.setProperties({ text: this.mode.instruction });
    // The mode's own pass bar + honest target pace on the brief (#9/#22).
    this.briefBar?.setProperties({
      text: `${passBarLabel(this.mode.passThreshold)} - ${targetPaceLabel(this.mode.idealPace)}`,
    });
    // Re-stamp the idle TIME box to the resolved length when not mid-walk,
    // and refresh the duration pill (a null pref follows the mode default).
    this.updateDurationUI();
    if (this.phase === "idle" || this.phase === "summary") {
      this.lastTimeShown = TIME_UNSET;
      this.onWalkRemaining(-1);
    }
  }

  /** TIME box — integer changes only (e.g. "47S"); -1 = outside a walk.
   * The idle stamp resolves the duration PREF (not raw mode.walkSeconds) so
   * the header shows the length the next run will actually lock. */
  private onWalkRemaining(remaining: number): void {
    if (!this.timeBox) {
      return;
    }
    const seconds =
      remaining < 0
        ? resolveWalkSeconds(this.walkPrefsSig?.peek() ?? DEFAULT_WALK, this.mode)
        : Math.max(0, Math.ceil(remaining));
    if (seconds === this.lastTimeShown) {
      return;
    }
    this.lastTimeShown = seconds;
    this.timeBox.setProperties({ text: `${seconds}S` });
  }

  private onVisibility(state: VisibilityState): void {
    const inXR = state !== VisibilityState.NonImmersive;
    // The panel is XR-only AND honours the user's show/hide toggle (g.hudVisible).
    // Dev-only: `window.__hudForceShow = true` renders the (XR-only) panel in the
    // browser so its layout can be inspected/screenshotted. Stripped in prod.
    const forceShow =
      import.meta.env.DEV &&
      (this.world.globals as Record<string, unknown>).__hudForceShow === true;
    const visible =
      (inXR || forceShow) && (this.hudVisibleSig?.peek() ?? true);
    const panel = this.panelEntity;
    if (panel?.hasComponent(Visibility)) {
      panel.setValue(Visibility, "isVisible", visible);
    }
    if (panel) {
      // Hidden must also mean non-interactive: an invisible panel would still be
      // a ray target (canvas pointer raycasts in the browser, controller rays in
      // XR while toggled off).
      if (visible && !panel.hasComponent(Interactable)) {
        panel.addComponent(Interactable);
      } else if (!visible && panel.hasComponent(Interactable)) {
        panel.removeComponent(Interactable);
      }
      // No more head-lock: drop any stale Follower (e.g. from a hot reload) and
      // WORLD-mount the panel beside the runway start, so the model walks PAST it
      // rather than dragging it down the runway.
      if (panel.hasComponent(Follower)) {
        panel.removeComponent(Follower);
      }
      this.applyWorldPlacement();
    }
    this.xrButton?.setProperties({
      // "EXIT" (not "EXIT TO BROWSER") in XR: the long label wrapped to two
      // lines and blew out the footer pill (founder's in-headset photo).
      text: inXR ? "EXIT" : "ENTER XR",
    });
    // First-run in-headset tutorial: the moment the trainee first enters XR
    // (the rising edge — a blur/focus toggle must not re-trigger), auto-open the
    // guide if they have never seen it and have no recorded walks. Never fires
    // in the flat browser (this whole product's teaching used to be desktop-only
    // — the exact gap this closes). setTutorialOpen lands card 0 + repaints.
    if (inXR && !this.enteredXrOnce) {
      this.enteredXrOnce = true;
      if (this.shouldAutoOpenTutorial()) this.setTutorialOpen(true);
    }
  }

  /** Ease the panel to a head-relative spot DIRECTLY IN FRONT of the trainee,
   * square-on, so a FINISHED walk's result is always in view AND reachable by the
   * controller ray — no walking back to the runway start. (Founder call: the old
   * follow reused the beside-the-runway lateral offset + 25 deg angle, which left
   * the panel locked off to the side and un-pointable.) Keeps the forward distance
   * (HUD_POS_Z) but DROPS the lateral offset + yaw angle, anchored to the live head
   * yaw, and EASES position + yaw toward it — a gentle lazy-follow, not a rigid,
   * nauseating head-lock.
   *
   * Returns true once the panel has SETTLED on the target (position + yaw within
   * the park thresholds) — the summary park latch keys off this, freezing the
   * panel world-locked so it stops chasing the head while the trainee points. */
  private lazyFollowPanel(): boolean {
    const obj = this.panelEntity?.object3D;
    if (!obj) return false;
    this.player.head.getWorldPosition(this.headPos);
    // getWorldDirection = local +Z (behind the head); the look dir is its negative,
    // so the head's horizontal facing in the runway-yaw convention (forward =
    // (-sin,-cos)) is atan2(+Z.x, +Z.z) — keeps HUD_POS_Z reading right.
    this.player.head.getWorldDirection(this.headFwd);
    const headYaw = Math.atan2(this.headFwd.x, this.headFwd.z);
    const c = Math.cos(headYaw);
    const s = Math.sin(headYaw);
    // Centered ahead of the head: Ry(headYaw) * (0, _, fz) — no lateral term.
    // fz is HUD_POS_Z, unless the dev ?panelfront override pulls it closer for
    // a crisp layout screenshot (window.__PANEL_FRONT_Z, dev-only).
    const fz =
      typeof window !== "undefined" &&
      typeof (window as unknown as { __PANEL_FRONT_Z?: number }).__PANEL_FRONT_Z ===
        "number"
        ? (window as unknown as { __PANEL_FRONT_Z: number }).__PANEL_FRONT_Z
        : HUD_POS_Z;
    const wx = s * fz;
    const wz = c * fz;
    this.followTarget.set(
      this.headPos.x + wx,
      this.headPos.y - 0.15, // a touch below eye level — comfortable to read
      this.headPos.z + wz,
    );
    obj.position.lerp(this.followTarget, 0.1); // lazy ease, not a snap
    // Face the trainee square-on (panel front +Z points back at the head): yaw =
    // headYaw, with NO HUD_YAW_RAD side angle — the panel is dead ahead now.
    const targetYaw = headYaw;
    let dy = targetYaw - obj.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy)); // shortest-angle wrap
    obj.rotation.set(0, obj.rotation.y + dy * 0.12, 0);
    return (
      obj.position.distanceToSquared(this.followTarget) <
        PARK_SETTLE_DIST * PARK_SETTLE_DIST && Math.abs(dy) < PARK_SETTLE_YAW_RAD
    );
  }

  /** World-mount the panel beside the runway START (off to the left, glanceable),
   * framed to the runway so it lands correctly wherever the runway is placed /
   * fit. The proven local offset (HUD_POS_*) is expressed in the runway-start
   * frame: position = start + Ry(yaw)*offset, yaw = runwayYaw + HUD_YAW_RAD. */
  private applyWorldPlacement(): void {
    const obj = this.panelEntity?.object3D;
    if (!obj) return;
    const layout = this.runwayLayoutSig?.peek();
    const cx = layout?.centerX ?? 0;
    const cz = layout?.centerZ ?? 0;
    const yaw = layout?.yaw ?? 0;
    const length = layout?.length ?? 0;
    // Walk-forward (near->far) = (-sin, -cos); the START (near end) is opposite.
    const startX = cx + Math.sin(yaw) * (length / 2);
    const startZ = cz + Math.cos(yaw) * (length / 2);
    // Ry(yaw) * (HUD_POS_X, _, HUD_POS_Z): wx = c*lx + s*lz; wz = -s*lx + c*lz.
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const wx = c * HUD_POS_X + s * HUD_POS_Z;
    const wz = -s * HUD_POS_X + c * HUD_POS_Z;
    obj.position.set(startX + wx, HUD_POS_Y, startZ + wz);
    obj.rotation.set(0, yaw + HUD_YAW_RAD, 0);
  }

  private inXR(): boolean {
    return this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
  }

  private controls(): ShowControls | null {
    const g = this.world.globals as Record<string, unknown>;
    return (g.showControls as ShowControls | undefined) ?? null;
  }

  /** MappingSystem assigns globals.mapControls — may be null early. */
  private mapControls(): MapControls | null {
    const g = this.world.globals as Record<string, unknown>;
    return (g.mapControls as MapControls | undefined) ?? null;
  }

  /** FitSessionSystem assigns globals.bodyFitControls — may be null early. */
  private fitControls(): FitControls | null {
    const g = this.world.globals as Record<string, unknown>;
    return (g.bodyFitControls as FitControls | undefined) ?? null;
  }

  private el<T extends UIKit.Component>(id: string): T | null {
    const element = this.doc?.getElementById(id) as T | null;
    if (!element) {
      console.warn(`[HUDSystem] missing element #${id} in lesson panel.`);
    }
    return element;
  }

  private onClick(id: string, handler: () => void): void {
    const element = this.el<UIKit.Container>(id);
    element?.addEventListener("click", handler);
  }

  private setCheck(element: UIKit.Container | null, on: boolean): void {
    element?.setProperties({
      backgroundColor: on ? CHECK_ON_BG : CHECK_OFF_BG,
      borderColor: on ? CHECK_ON_BORDER : CHECK_OFF_BORDER,
    });
  }

  private setDisplay(element: UIKit.Container | null, visible: boolean): void {
    element?.setProperties({ display: visible ? "flex" : "none" });
  }

  private setPhaseText(text: string): void {
    if (text === this.lastPhaseText) {
      return;
    }
    this.lastPhaseText = text;
    this.phaseLine?.setProperties({ text });
  }
}
