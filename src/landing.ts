/**
 * (X)RUNWAY — DOM landing controller (REV2, first-person trainer).
 *
 * Wires the glassmorphism landing overlay (index.html) to the show's global
 * signal contract: buttons → ShowControls, signals → phase chip / TIME chip /
 * live strip + pass checks / summary card, visibilityState → hide the whole
 * overlay while immersed.
 *
 * BEGIN WALK (and WALK AGAIN): in XR the trainee physically walks; on a laptop
 * it runs the show right here if a camera is streaming (the phone supplies the
 * body data), else enters the headset/emulator, else a desktop preview — it
 * never dead-ends.
 *
 * REV3: a glass RUNWAY editor card lets the desktop/pitch user MAP the runway
 * without a headset (you can't physically walk in the browser). Sliders for
 * LENGTH / WIDTH / ROTATION / POSITION X / POSITION Z are bound two-way to
 * `globals.runwayLayout`: reading the signal updates the sliders + readout;
 * moving a slider writes `sanitizeLayout({ ...current, <field> })` back
 * (change-gated) and `saveLayout`s on release. Buttons: MAP IN HEADSET
 * (`mapControls.startMapping`), AUTO-FIT TO FLOOR (`autoMapFromFloor`),
 * RESET RUNWAY (DEFAULT_LAYOUT). The card hides while immersed (the whole
 * #landing overlay is hidden in XR; the HUD MAP RUNWAY flow is used there).
 *
 * Pure DOM module — no ECS system, no per-frame work. Everything is
 * subscription-driven; strings/classes are only written when they change.
 */

import { VisibilityState, type World } from "@iwsdk/core";
import { signal, type Signal } from "@preact/signals-core";

import {
  beatPrefsLabel,
  cycleBeatPrefs,
  type BeatPrefs,
} from "./beat-prefs.js";
import { BEAT_EXPLAIN, BEAT_SETTING_TIP, beatStatLine } from "./beat-stats.js";
import { normalizationStamp, type BodyBaseline } from "./body-baseline.js";
import {
  buildCoachReport,
  CLEAN_WALK_CUE,
  METRIC_EXPLAIN,
  passBarLabel,
  targetPaceLabel,
  walkStatLine,
} from "./coach.js";
import type { FitFlowState } from "./fit-session.js";
import {
  applyCarriageNotes,
  CARRIAGE_NO_READ_TOOLTIP,
  carriageLine,
  carriageTooltip,
  PRESENCE_EXPLAIN_WITH_CARRIAGE,
  type CarriageStats,
  type CarriageTracker,
} from "./head-carriage.js";
import { HOLD_EXPLAIN, holdStatLine } from "./hold-stats.js";
import {
  buildWalkCardBlob,
  walkCardFilename,
  type WalkCardData,
} from "./walk-card.js";
import { holdNote, turnNote } from "./hold-turn-notes.js";
import { buildSummaryRiders, turnRowStamped } from "./summary-riders.js";
import {
  PRESENTATION_EXPLAIN_WITH_TURN,
  TURN_EXPLAIN,
  turnStatLine,
  type TurnStats,
} from "./turn-stats.js";
import { METRICS, SHIPPED_METRIC_KEYS } from "./metrics.js";
import {
  DEFAULT_MODE,
  getMode,
  MODES,
  saveMode,
  type ModeId,
  type TrainingMode,
} from "./modes.js";
import {
  FIT_BUSY_TOAST,
  FIT_NEEDS_HEADSET_TOAST,
  fitCardStatusLine,
  MEDAL_COLOR,
  MEDAL_LABEL,
  scoreMedal,
} from "./hud-copy.js";
import {
  cyclePaceBand,
  cyclePaceBias,
  paceBandLabel,
  paceBiasLabel,
  type PacePrefs,
} from "./pace-prefs.js";
import {
  cycleMusicBpm,
  DEFAULT_MUSIC,
  musicBpmLabel,
  musicBpmNote,
  resolveMusicBpm,
  type MusicPrefs,
} from "./music-prefs.js";
import {
  cycleWalkSeconds,
  walkSecondsLabel,
  type WalkPrefs,
} from "./walk-prefs.js";
import {
  LEGACY_MODE_BUCKET,
  masteryJustEarned,
  medalRank,
  modeStats,
  progressReport,
  realScoredRows,
  type ModeStats,
  type ProgressMetricKey,
} from "./progress.js";
import {
  CURRICULUM_LEVELS,
  SHIPPED_DRILLS,
  drillById,
  evaluateGate,
  gateCopy,
  latestColdBlock,
  planCopy,
  recommendedLevelIndex,
  weakestChannel,
} from "./curriculum-core.js";
import {
  BENCHMARK_TOOLTIP,
  benchmarkHeadline,
  benchmarkLine,
  REPEAT_DISCLOSURE,
  repeatabilityReport,
  type RepeatRow,
  type RepeatStatsSlice,
} from "./repeatability.js";
import {
  getScene,
  saveScene,
  type SceneId,
  type PassthroughScene,
} from "./scenes.js";
import {
  filterHistoryRows,
  isSyntheticRow,
  recentActivityTitle,
  rowMatchesTrainee,
  rowPassed,
  rowPassThreshold,
  NEW_SCALE_TITLE_SUFFIX,
  scopeRowsToNormalization,
  scopeRowsToScale,
  SINCE_FIT_TITLE_SUFFIX,
} from "./session-grading.js";
import { SCORE_SCALE_STAMP } from "./pose-derive.js";
import { LAYOUT_LIMITS, type RunwayLayout } from "./runway-layout.js";
import {
  anchorStartOnLengthEdit,
  DEFAULT_SHAPE,
  PRESET_RUNWAYS,
  sanitizeShape,
  shapeToActiveLayout,
  straightShapeFromLayout,
  type RunwayShape,
  type SavedRunwaysStore,
} from "./runway-shape.js";
import { DEFAULT_USER, saveUser, type UserPrefs } from "./user-prefs.js";
import { installWebTour } from "./web-tour.js";
import { BRAND_CSS } from "./theme.js";
import {
  beginWalkAction,
  enterHeadsetAction,
  launchWatchdogVerdict,
  type XrLaunchState,
} from "./xr-launch.js";
import type {
  MetricSnapshot,
  ShowControls,
  ShowPhaseValue,
  ShowSummary,
} from "./show.js";

/** Metric order M1–M7 — derived from the single-source METRICS table. */
const METRIC_KEYS: ReadonlyArray<keyof MetricSnapshot> = METRICS.map(
  (m) => m.key,
);

const METRIC_COUNT = METRIC_KEYS.length;
/** The 3rd shipped row DISPLAYS head CARRIAGE, not rhythm (founder call
 * 2026-07-08) — the web live strip + summary card mirror the in-headset panel.
 * We repurpose the rhythm slot: live value = globals.headCarriage.liveScore(),
 * summary value = s.carriage.carriageScore, not the snapshot rhythm score. */
const CARRIAGE_SLOT = METRIC_KEYS.indexOf("rhythm");

// Explainer/coach copy + verdict/notes logic live in the SHARED coach module
// (src/coach.ts) — the in-headset summary consumes the same layer (#9/#16).

/**
 * Controls assigned to `globals.mapControls` by MappingSystem (REV3). Read
 * defensively — may be null until MappingSystem inits. The landing only calls
 * startMapping (MAP IN HEADSET) and autoMapFromFloor (AUTO-FIT TO FLOOR).
 */
interface MapControls {
  startMapping(): void;
  cancelMapping(): void;
  placePoint(): void;
  setWidth(w: number): void;
  commit(): void;
  autoMapFromFloor(): void;
}

export function mountLanding(world: World): void {
  // ---- brand CSS variables: theme.ts is the source of truth -------------
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--xr-bg", BRAND_CSS.bg);
  rootStyle.setProperty("--xr-bg-deep", BRAND_CSS.bgDeep);
  rootStyle.setProperty("--xr-accent", BRAND_CSS.accent);
  rootStyle.setProperty("--xr-accent-soft", BRAND_CSS.accentSoft);
  rootStyle.setProperty("--xr-accent-deep", BRAND_CSS.accentDeep);
  rootStyle.setProperty("--xr-white", BRAND_CSS.white);
  rootStyle.setProperty("--xr-silver", BRAND_CSS.silver);
  rootStyle.setProperty("--xr-gold", BRAND_CSS.gold);

  // ---- defensive element lookup (log once, never throw) -----------------
  const missing: string[] = [];
  const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null => {
    const el = document.getElementById(id) as T | null;
    if (!el) {
      missing.push(id);
    }
    return el;
  };

  const landing = byId("landing");
  const phaseChip = byId("phase-chip");
  const timeChip = byId("time-chip");
  const timeVal = byId("time-val");
  const resetBtn = byId<HTMLButtonElement>("reset-btn");
  const enterXrBtn = byId<HTMLButtonElement>("enter-xr");
  const beginWalkBtn = byId<HTMLButtonElement>("begin-walk");
  const againBtn = byId<HTMLButtonElement>("again-btn");
  const doneBtn = byId<HTMLButtonElement>("done-btn");
  const scoreRing = byId("score-ring");
  const overallScore = byId("overall-score");
  const deltaLine = byId("delta-line");
  const bestChip = byId("best-chip");
  const masteryChip = byId("mastery-chip");
  const sumDuration = byId("sum-duration");
  const sumCarriage = byId("sum-carriage");
  const sumHold = byId("sum-hold");
  const sumBeat = byId("sum-beat");
  const sumTurn = byId("sum-turn");
  // F.27 head-motion observation notes (display-only; hold-turn-notes.ts).
  const sumHoldNote = byId("sum-hold-note");
  const sumTurnNote = byId("sum-turn-note");
  const repeatLine = byId("repeat-line");
  const sumVerdict = byId("sum-verdict");
  const sumMedal = byId("sum-medal");
  const medalNote = byId("medal-note");
  const sumCoach = byId("sum-coach");
  const sumCoachList = byId("sum-coach-list");
  const liveFills: Array<HTMLElement | null> = [];
  const liveVals: Array<HTMLElement | null> = [];
  const liveChecks: Array<HTMLElement | null> = [];
  const sumFills: Array<HTMLElement | null> = [];
  const sumVals: Array<HTMLElement | null> = [];
  for (let i = 1; i <= METRIC_COUNT; i++) {
    liveFills.push(byId(`lm${i}-fill`));
    liveVals.push(byId(`lm${i}-val`));
    liveChecks.push(byId(`lm${i}-check`));
    sumFills.push(byId(`sm${i}-fill`));
    sumVals.push(byId(`sm${i}-val`));
  }
  const sumLabels = Array.from(
    document.querySelectorAll<HTMLElement>("#summary-card .sum-row .sum-label"),
  );

  if (missing.length > 0) {
    console.warn(
      `[landing] missing element(s): ${missing.join(", ")} — continuing without them`,
    );
  }

  // ---- globals (typed views over the shared signal contract) ------------
  const g = world.globals as Record<string, unknown>;
  const phaseSig = g.showPhase as Signal<ShowPhaseValue> | undefined;
  const metricsSig = g.metrics as Signal<MetricSnapshot | null> | undefined;
  const summarySig = g.summary as Signal<ShowSummary | null> | undefined;
  const walkRemainingSig = g.walkRemaining as Signal<number> | undefined;
  // runwayLayout is now a COMPUTED spine (read-only); the editor/mapping write
  // the SHAPE source of truth, and the computed re-fits every reader.
  const runwayLayoutSig = g.runwayLayout as Signal<RunwayLayout> | undefined;
  const runwayShapeSig = g.runwayShape as Signal<RunwayShape> | undefined;
  const userPrefsSig = g.userPrefs as Signal<UserPrefs> | undefined;
  const activeModeSig = g.activeMode as Signal<TrainingMode> | undefined;
  /** Active mode's pass threshold (drives the checkbox fills); falls back to default. */
  const passThreshold = (): number =>
    (activeModeSig?.peek() ?? DEFAULT_MODE).passThreshold;
  const activeSceneSig = g.activeScene as Signal<PassthroughScene> | undefined;
  const controls = (): ShowControls | null =>
    (g.showControls as ShowControls | null) ?? null;
  const mapControls = (): MapControls | null =>
    (g.mapControls as MapControls | null) ?? null;

  const disposers: Array<() => void> = [];

  // The entrance choreography (index.html glass-in) must run ONCE per page
  // load: immersion toggles landing.style.display, and display:none resets
  // CSS animations to zero on re-display — without this stamp every EXIT
  // HEADSET replayed the full stagger (review catch 2026-07-10). 1.7 s
  // clears the longest delay+duration (0.58 s + 0.55 s); the CSS gates the
  // animations on body:not(.settled).
  const settleTimer = window.setTimeout(() => {
    document.body.classList.add("settled");
  }, 1700);
  disposers.push(() => window.clearTimeout(settleTimer));

  // ---- buttons -----------------------------------------------------------
  const wire = (el: HTMLElement | null, handler: () => void): void => {
    el?.addEventListener("click", handler);
  };

  // No demo fallback in REV2 — flash the inline hint instead.

  const cameraLive = (): boolean => {
    const t = g.externalTracker as
      | { status(): { connected: boolean } }
      | undefined;
    return !!t && t.status().connected;
  };

  // Lightweight toast (shared #app-toast) for confirmations + dead-end hints.
  let appToastTimer2: number | null = null;
  const showAppToast = (msg: string): void => {
    const t = byId("app-toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("show");
    if (appToastTimer2 !== null) window.clearTimeout(appToastTimer2);
    appToastTimer2 = window.setTimeout(() => t.classList.remove("show"), 2200);
  };
  const hideAppToast = (): void => {
    const t = byId("app-toast");
    if (!t) return;
    t.classList.remove("show");
    if (appToastTimer2 !== null) {
      window.clearTimeout(appToastTimer2);
      appToastTimer2 = null;
    }
  };

  // ---- WebXR AR preflight + launch watchdog (#1/#7) ----------------------
  // Desktop Chrome exposes navigator.xr with NO AR device, and IWSDK's
  // launchXR() has no rejection handler — so the capability check must happen
  // BEFORE the call. Resolve isSessionSupported('immersive-ar') once at mount
  // and branch on the cached answer (null = still resolving → launch
  // optimistically; the watchdog below covers a session that never arrives).
  let arSupported: boolean | null = null;
  {
    const xr = typeof navigator !== "undefined" ? navigator.xr : undefined;
    const probe = xr?.isSessionSupported?.("immersive-ar");
    if (probe) {
      void probe.then(
        (ok) => {
          arSupported = ok;
        },
        () => {
          arSupported = false;
        },
      );
    } else if (!xr) {
      arSupported = false;
    }
  }
  const xrState = (): XrLaunchState => ({
    immersed: world.visibilityState.peek() !== VisibilityState.NonImmersive,
    cameraLive: cameraLive(),
    xrPresent: typeof navigator !== "undefined" && !!navigator.xr,
    arSupported,
  });

  // Supported-but-rejected (e.g. the Quest AR permission dialog denied):
  // launchXR swallows the requestSession rejection, so watch for a session
  // that never becomes active and say so calmly. The pending watchdog — and a
  // just-shown toast — are cancelled the moment a session DOES start (see the
  // visibilityState subscription below), so a slow permission dialog followed
  // by an accept never strands a stale "declined" message. At fire time the
  // verdict re-checks the (by now resolved) arSupported (xr-launch.ts): the
  // "declined" blame is reserved for machines where AR support is CONFIRMED —
  // an optimistic launch that raced the probe on a headsetless desktop routes
  // to the caller's no-AR fallback instead of a dead end with wrong copy.
  const XR_DECLINE_TOAST_MS = 5000;
  let xrWatchdog: number | null = null;
  const launchXRWatched = (onNoAr: () => void): void => {
    if (xrWatchdog !== null) window.clearTimeout(xrWatchdog);
    xrWatchdog = window.setTimeout(() => {
      xrWatchdog = null;
      const verdict = launchWatchdogVerdict(
        world.visibilityState.peek() === VisibilityState.NonImmersive,
        arSupported,
      );
      if (verdict === "declined-toast") {
        showAppToast("Headset declined the AR session — check permissions.");
      } else if (verdict === "fallback") {
        onNoAr();
      }
    }, XR_DECLINE_TOAST_MS);
    world.launchXR();
  };

  // The three fixed overlays — camera link, run history, runway editor — are
  // mutually exclusive. Hide the two that AREN'T `keep` whenever one opens, so
  // the gating is symmetric (before, opening sessions or expanding the editor
  // left #camera-panel up).
  const closeFixedPanels = (keep: "camera" | "sessions" | "editor"): void => {
    if (keep !== "camera") byId("camera-panel")?.setAttribute("hidden", "");
    if (keep !== "sessions") byId("sessions-panel")?.setAttribute("hidden", "");
    if (keep !== "editor") {
      byId("runway-card")?.classList.remove("expanded");
      const tog = byId<HTMLButtonElement>("rw-toggle");
      if (tog) tog.textContent = "EDIT";
    }
  };

  // BEGIN WALK. In XR the trainee physically walks. On a laptop/desktop:
  //  - if an external camera (the iPhone on a tripod) is streaming the body,
  //    run the show right here — the phone supplies the data, no headset needed
  //    (a real product config AND the reliable pitch path);
  //  - else enter the headset/emulator if immersive-ar is (or may be) supported
  //    — bare navigator.xr truthiness is NOT enough (desktop Chrome has it with
  //    no device, and launchXR swallows the rejection: see xr-launch.ts);
  //  - else still run the show as a desktop preview — never dead-end.
  const startTraineeWalk = (): void => {
    const action = beginWalkAction(xrState());
    if (action === "begin-walk") {
      controls()?.beginWalk();
      return;
    }
    if (action === "launch-xr") {
      // Watchdog fallback: an optimistic launch that never produced a session
      // on a machine WITHOUT confirmed AR support takes the same
      // desktop-preview path the resolved-false branch takes — the click
      // still produces a walk.
      launchXRWatched(() => {
        showAppToast("Desktop preview — no headset or camera detected");
        controls()?.beginWalk();
      });
      return;
    }
    // No headset, no camera — never dead-end, but say what's happening.
    showAppToast("Desktop preview — no headset or camera detected");
    controls()?.beginWalk();
  };

  wire(beginWalkBtn, startTraineeWalk);
  wire(againBtn, startTraineeWalk);
  // Replay Theater (display-only): enter the front-row ghost replay of the
  // walk just scored. The landing overlay steps aside while it plays (the
  // data-replay attribute below); any input exits and the summary returns.
  wire(byId("sum-replay"), () => {
    (g.replayControls as { start(): boolean } | null)?.start();
  });
  // GHOST vs GHOST (F.35): this walk against your best other walk in
  // memory, start-synchronized — the growing gap IS the pace difference.
  wire(byId("sum-compare"), () => {
    const rc = g.replayControls as {
      startCompareFor(id: string): boolean;
    } | null;
    const latest = (
      g.sessionRecorder as { latest(): { id: string } | null } | undefined
    )?.latest();
    if (rc && latest) rc.startCompareFor(latest.id);
  });
  // THE WALK CARD: compose the 1200x630 score-card PNG from the summary just
  // rendered and hand it over — navigator.share (files) where the platform
  // has it, else a straight download. AbortError = the user closed the share
  // sheet: not a failure, no toast.
  const downloadCardBlob = (blob: Blob, name: string): void => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  wire(byId("sum-share"), () => {
    const data = lastWalkCard;
    if (!data) return;
    void (async () => {
      try {
        const blob = await buildWalkCardBlob(data);
        const name = walkCardFilename(data);
        const nav = navigator as Navigator & {
          canShare?: (d: { files: File[] }) => boolean;
        };
        if (typeof nav.share === "function" && typeof nav.canShare === "function") {
          const file = new File([blob], name, { type: "image/png" });
          if (nav.canShare({ files: [file] })) {
            try {
              await nav.share({ files: [file] });
              return;
            } catch (err) {
              if ((err as { name?: string }).name === "AbortError") return;
              // Share sheet unavailable after all — fall through to download.
            }
          }
        }
        downloadCardBlob(blob, name);
        showAppToast("Walk card saved");
      } catch {
        showAppToast("Card failed - try again");
      }
    })();
  });
  // DEV hook for the headless PNG-byte verification (stripped in prod, the
  // __XRUNWAY_WORLD pattern): renders the CURRENT card to a data URL.
  if (import.meta.env.DEV && typeof window !== "undefined") {
    (window as unknown as { __WALK_CARD?: () => Promise<string | null> }).__WALK_CARD =
      async () => {
        if (!lastWalkCard) return null;
        const blob = await buildWalkCardBlob(lastWalkCard);
        return new Promise((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as string);
          r.readAsDataURL(blob);
        });
      };
  }
  {
    const replayActiveSig = g.replayActive as Signal<boolean> | undefined;
    // THE REPLAY PLAYER BAR (founder call 2026-07-23): a proper transport
    // over the ghost — play/pause, restart, half speed, click-to-seek, exit.
    // The bar is a SIBLING of #landing (the landing hides during a replay);
    // browser-only (in XR the DOM is invisible and any input still exits).
    type PlayerControls = {
      pause(): void;
      resume(): void;
      restart(): void;
      setSpeed(r: number): void;
      seek(f: number): void;
      stop(): void;
      state(): {
        t: number;
        duration: number;
        playing: boolean;
        speed: number;
        gapM: number | null;
      } | null;
    };
    const rcOf = (): PlayerControls | null =>
      (g.replayControls as PlayerControls | null) ?? null;
    const bar = byId("replay-bar");
    const rpPlay = byId<HTMLButtonElement>("rp-play");
    const rpRestart = byId<HTMLButtonElement>("rp-restart");
    const rpSpeed = byId<HTMLButtonElement>("rp-speed");
    const rpTrack = byId("rp-track");
    const rpFill = byId("rp-fill");
    const rpTime = byId("rp-time");
    const rpExit = byId<HTMLButtonElement>("rp-exit");
    let rpTimer: number | null = null;
    const rpCue = byId("replay-cue");
    const paintBar = (): void => {
      const s = rcOf()?.state() ?? null;
      if (!s) return;
      // Coached-moment cue (plain ref; null = no cue this instant). Wave 2:
      // the detail line carries the measured value vs the engine's own bar.
      if (rpCue) {
        const cue = g.replayCue as { text: string; detail?: string } | null;
        rpCue.hidden = cue === null;
        if (cue !== null) {
          const lineEl = byId("replay-cue-line");
          const detEl = byId("replay-cue-detail");
          if (lineEl && lineEl.textContent !== cue.text) {
            lineEl.textContent = cue.text;
          }
          if (detEl) {
            const det = cue.detail ?? "";
            detEl.hidden = det === "";
            if (detEl.textContent !== det) detEl.textContent = det;
          }
        }
      }
      // Live comparison gap (wave 2): the SimulCam gap as a number.
      {
        const gapEl = byId("rc-gap");
        if (gapEl) {
          const txt = s.gapM === null || s.gapM === undefined ? "" : ` · GAP ${s.gapM.toFixed(1)} M`;
          if (gapEl.textContent !== txt) gapEl.textContent = txt;
        }
      }
      if (rpFill) {
        rpFill.style.width = `${s.duration > 0 ? Math.min(100, (s.t / s.duration) * 100) : 0}%`;
      }
      if (rpTime) {
        rpTime.textContent = `${s.t.toFixed(1)}S / ${s.duration.toFixed(1)}S`;
      }
      if (rpPlay) rpPlay.textContent = s.playing ? "PAUSE" : "PLAY";
      if (rpSpeed) rpSpeed.textContent = s.speed === 1 ? "1X" : "0.5X";
    };
    const stopBarPoll = (): void => {
      if (rpTimer !== null) {
        window.clearInterval(rpTimer);
        rpTimer = null;
      }
    };
    wire(rpPlay, () => {
      const rc = rcOf();
      const s = rc?.state() ?? null;
      if (!rc || !s) return;
      if (s.playing) rc.pause();
      else rc.resume();
      paintBar();
    });
    wire(rpRestart, () => {
      rcOf()?.restart();
      paintBar();
    });
    wire(rpSpeed, () => {
      const rc = rcOf();
      const s = rc?.state() ?? null;
      if (!rc || !s) return;
      rc.setSpeed(s.speed === 1 ? 0.5 : 1);
      paintBar();
    });
    wire(rpExit, () => rcOf()?.stop());
    if (rpTrack) {
      rpTrack.addEventListener("click", (e) => {
        const rect = rpTrack.getBoundingClientRect();
        if (rect.width <= 0) return;
        rcOf()?.seek((e.clientX - rect.left) / rect.width);
        paintBar();
      });
    }
    if (replayActiveSig && landing) {
      disposers.push(
        replayActiveSig.subscribe((on) => {
          if (on) landing.dataset.replay = "1";
          else delete landing.dataset.replay;
          // The bar rides the replay, browser-only (XR keeps fire-and-watch).
          const inBrowser =
            world.visibilityState.peek() === VisibilityState.NonImmersive;
          if (bar) bar.hidden = !(on && inBrowser);
          if (rpCue && !on) rpCue.hidden = true;
          // VS BEST legend chip: only during a two-ghost replay.
          const cmpChip = byId("replay-compare-chip");
          const cmp = g.replayCompare as
            | { a: number | null; b: number | null }
            | null;
          if (cmpChip) {
            cmpChip.hidden = !(on && inBrowser && cmp !== null);
            if (on && cmp !== null) {
              const aEl = byId("rc-a-score");
              const bEl = byId("rc-b-score");
              if (aEl) {
                aEl.textContent = cmp.a === null ? "" : String(Math.round(cmp.a));
              }
              if (bEl) {
                bEl.textContent = cmp.b === null ? "" : String(Math.round(cmp.b));
              }
            }
          }
          // Moment dots (wave 2): the rings' timestamps on the seek track,
          // kind-colored (the ring palette), click-through - the track owns
          // the seek.
          if (rpTrack) {
            rpTrack.querySelectorAll(".rp-dot").forEach((d) => d.remove());
            const moments = g.replayMoments as
              | Array<{ t: number; kind: string }>
              | null
              | undefined;
            const st = rcOf()?.state() ?? null;
            if (on && inBrowser && Array.isArray(moments) && st && st.duration > 0) {
              for (const m of moments) {
                const d = document.createElement("span");
                d.className = "rp-dot";
                d.style.left = `${Math.min(100, Math.max(0, (m.t / st.duration) * 100))}%`;
                d.style.background =
                  m.kind === "line"
                    ? "#4b9cd3"
                    : m.kind === "pace"
                      ? "#f2f4f8"
                      : "#d9a441";
                rpTrack.appendChild(d);
              }
            }
          }
          // THE NEXT-WALK RECAP (wave 2): when the theater goes dark, its
          // moments become the practice list on the summary card.
          if (!on) {
            const recapEl = byId("sum-recap");
            const recapList = byId("sum-recap-list");
            if (recapEl && recapList) {
              const cues = g.replayRecap as string[] | null | undefined;
              recapList.textContent = "";
              if (Array.isArray(cues) && cues.length > 0) {
                for (const c of cues) {
                  const li = document.createElement("li");
                  li.textContent = c;
                  recapList.appendChild(li);
                }
                recapEl.hidden = false;
              } else {
                recapEl.hidden = true;
              }
            }
          }
          stopBarPoll();
          if (on && inBrowser) {
            paintBar();
            rpTimer = window.setInterval(paintBar, 100);
          }
        }),
      );
      disposers.push(stopBarPoll);
    }
  }
  wire(resetBtn, () => controls()?.reset());
  wire(doneBtn, () => controls()?.reset());
  // Dismiss the scored summary (X) — same as DONE, reachable on any angle.
  wire(byId("summary-close"), () => controls()?.reset());
  wire(enterXrBtn, () => {
    const action = enterHeadsetAction(xrState());
    if (action === "exit-xr") {
      world.exitXR();
      return;
    }
    if (action === "launch-xr") {
      // Watchdog fallback: no session AND no confirmed AR support — the calm
      // no-headset hint, not the "declined" blame (xrPresent is true in this
      // branch, so the AR-incapable variant is the right copy).
      launchXRWatched(() => {
        showAppToast("No AR-capable headset detected — try a Preview Walk.");
      });
      return;
    }
    // navigator.xr present but immersive-ar unsupported (the common desktop
    // Chrome case) vs no WebXR runtime at all — both get a calm hint.
    showAppToast(
      typeof navigator !== "undefined" && navigator.xr
        ? "No AR-capable headset detected — try a Preview Walk."
        : "No headset / WebXR runtime detected — try Preview Walk",
    );
  });

  // ---- MUSIC control (#6): toggle + volume → globals.musicPrefs ----------
  // MusicSystem applies the pref to its master gain; the in-headset settings
  // row writes the same signal, so the two surfaces stay in sync. Persisted
  // by index.ts alongside the other prefs.
  const musicPrefsSig = g.musicPrefs as Signal<MusicPrefs> | undefined;
  const musicBtn = byId<HTMLButtonElement>("music-btn");
  const musicVol = byId<HTMLInputElement>("music-vol");
  if (musicPrefsSig) {
    const renderMusic = (p: MusicPrefs): void => {
      if (musicBtn) {
        musicBtn.textContent = p.enabled ? "MUSIC: ON" : "MUSIC: OFF";
        musicBtn.setAttribute("aria-pressed", p.enabled ? "true" : "false");
      }
      if (musicVol) musicVol.value = String(Math.round(p.volume * 100));
    };
    wire(musicBtn, () => {
      const cur = musicPrefsSig.peek();
      musicPrefsSig.value = { ...cur, enabled: !cur.enabled };
    });
    if (musicVol) {
      const onVol = (): void => {
        const cur = musicPrefsSig.peek();
        const volume = Math.min(1, Math.max(0, Number(musicVol.value) / 100));
        musicPrefsSig.value = { ...cur, volume };
      };
      musicVol.addEventListener("input", onVol);
      musicVol.addEventListener("change", onVol);
    }
    disposers.push(musicPrefsSig.subscribe((p) => renderMusic(p)));
  } else {
    console.warn("[landing] globals.musicPrefs signal missing");
    if (musicBtn) musicBtn.disabled = true;
    if (musicVol) musicVol.disabled = true;
  }

  // ---- MUSIC BPM picker (the multi-BPM founder call): 62 -> 100 -> 125 ---
  // Cycles the tempo on the SAME musicPrefs signal (cycleMusicBpm — shared
  // with the XR pill, the cycleBeatPrefs law). While unset the label shows
  // the active mode's default, so the picker re-renders on BOTH signals.
  // The caption under the row is the founder's own note per option (FINAL
  // copy, integrated verbatim — the no-AI-text law). The delivered tempo is
  // latched per run at the countdown edge and stamped on the walk row.
  const bpmBtn = byId<HTMLButtonElement>("bpm-btn");
  const bpmNote = byId<HTMLElement>("bpm-note");
  if (musicPrefsSig) {
    const renderBpm = (): void => {
      const p = musicPrefsSig.peek();
      const modeId = (activeModeSig?.peek() ?? DEFAULT_MODE).id;
      if (bpmBtn) {
        bpmBtn.textContent = musicBpmLabel(p, modeId, "landing");
        bpmBtn.title = musicBpmNote(resolveMusicBpm(p, modeId));
      }
      if (bpmNote) {
        bpmNote.textContent = musicBpmNote(resolveMusicBpm(p, modeId));
      }
    };
    wire(bpmBtn, () => {
      const modeId = (activeModeSig?.peek() ?? DEFAULT_MODE).id;
      musicPrefsSig.value = cycleMusicBpm(musicPrefsSig.peek(), modeId);
    });
    disposers.push(musicPrefsSig.subscribe(() => renderBpm()));
    if (activeModeSig) {
      disposers.push(activeModeSig.subscribe(() => renderBpm()));
    }
  } else {
    // globals.musicPrefs missing was already warned above (the MUSIC control).
    if (bpmBtn) bpmBtn.disabled = true;
  }

  // ---- WALK DURATION picker (founder ruling: 10-60 s, default 20) --------
  // Cycles globals.walkPrefs via cycleWalkSeconds — the SAME signal + cycle
  // as the in-headset Duration pill, so the two surfaces can never disagree.
  // The label resolves the pref against the ACTIVE mode (walkSecondsLabel),
  // so it re-renders on both signals; ShowDirectorSystem injects the choice
  // ONCE per run at its startRun mode lock (the walk-prefs law — a mid-run
  // cycle takes effect on the NEXT run, never under a scored walk).
  const durationBtn = byId<HTMLButtonElement>("duration-btn");
  const walkPrefsSig = g.walkPrefs as Signal<WalkPrefs> | undefined;
  if (walkPrefsSig) {
    const renderDuration = (): void => {
      if (durationBtn) {
        durationBtn.textContent = walkSecondsLabel(
          walkPrefsSig.peek(),
          activeModeSig?.peek() ?? DEFAULT_MODE,
          "landing",
        );
      }
    };
    wire(durationBtn, () => {
      walkPrefsSig.value = cycleWalkSeconds(
        walkPrefsSig.peek(),
        activeModeSig?.peek() ?? DEFAULT_MODE,
      );
    });
    disposers.push(walkPrefsSig.subscribe(() => renderDuration()));
    if (activeModeSig) {
      disposers.push(activeModeSig.subscribe(() => renderDuration()));
    }
  } else {
    console.warn("[landing] globals.walkPrefs signal missing");
    if (durationBtn) durationBtn.disabled = true;
  }

  // ---- PACE STYLE + the quiet ADVANCED band (founder ask 2026-07-18) ----
  // Which side of the target speed the scoring forgives, + the band width.
  // Latched per run by MetricsSystem - a change applies from the next walk.
  const paceStyleBtn = byId<HTMLButtonElement>("pace-style-btn");
  const paceBandBtn = byId<HTMLButtonElement>("pace-band-btn");
  const pacePrefsSig = g.pacePrefs as Signal<PacePrefs> | undefined;
  if (pacePrefsSig) {
    const renderPace = (): void => {
      const p = pacePrefsSig.peek();
      if (paceStyleBtn) paceStyleBtn.textContent = paceBiasLabel(p).toUpperCase();
      if (paceBandBtn) paceBandBtn.textContent = paceBandLabel(p).toUpperCase();
    };
    renderPace();
    wire(paceStyleBtn, () => {
      pacePrefsSig.value = cyclePaceBias(pacePrefsSig.peek());
    });
    wire(paceBandBtn, () => {
      pacePrefsSig.value = cyclePaceBand(pacePrefsSig.peek());
    });
    disposers.push(pacePrefsSig.subscribe(() => renderPace()));
  } else {
    console.warn("[landing] globals.pacePrefs signal missing");
    if (paceStyleBtn) paceStyleBtn.disabled = true;
    if (paceBandBtn) paceBandBtn.disabled = true;
  }

  // (Coach-voice control removed — founder ruling 2026-07-16: text-only coach.)

  // ---- BEAT PULSE control (M9): three delivery states → globals.beatPrefs.
  // BeatHapticsSystem peeks the prefs per frame; the in-headset settings
  // pill writes the same signal (cycleBeatPrefs — the two surfaces can
  // never cycle differently). Persisted by index.ts. The tooltip is the
  // full delivery disclosure (hand-tracking earcon fallback + its mute law,
  // the countdown flam suppression, the walk-record reference stamp).
  const beatPrefsSig = g.beatPrefs as Signal<BeatPrefs> | undefined;
  const beatBtn = byId<HTMLButtonElement>("beat-btn");
  if (beatPrefsSig) {
    const renderBeat = (p: BeatPrefs): void => {
      if (beatBtn) {
        beatBtn.textContent = beatPrefsLabel(p, "landing");
        beatBtn.setAttribute(
          "aria-pressed",
          p.countdown || p.walk ? "true" : "false",
        );
        beatBtn.title = BEAT_SETTING_TIP;
      }
    };
    wire(beatBtn, () => {
      beatPrefsSig.value = cycleBeatPrefs(beatPrefsSig.peek());
    });
    disposers.push(beatPrefsSig.subscribe((p) => renderBeat(p)));
  } else {
    console.warn("[landing] globals.beatPrefs signal missing");
    if (beatBtn) beatBtn.disabled = true;
  }

  // (The lesson-card coach mention was deleted with #mode-coachline in the
  // honest-card restructure; its render block left with the coach controls.)

  // ---- FIT card (Wave 1): body-baseline status + guided-flow controls ----
  // The flow itself is headset-only (FitSessionSystem, showPhase stays idle);
  // this card renders the per-trainee baseline status (§K: HEAD height,
  // never body height), starts/cancels the flow, and mirrors the guidance
  // line + stage progress while one runs. Status is edge-driven off
  // globals.bodyBaseline; progress polls the plain bodyFitProgress ref (the
  // holdLive pattern) on a light interval ONLY while a flow is live.
  interface FitControls {
    start(): boolean;
    cancel(): void;
  }
  const bodyBaselineSig = g.bodyBaseline as
    | Signal<BodyBaseline | null>
    | undefined;
  const bodyFitFlowSig = g.bodyFitFlow as
    | Signal<FitFlowState | null>
    | undefined;
  const bodyFitControls = (): FitControls | null =>
    (g.bodyFitControls as FitControls | null) ?? null;
  const fitStatusLineEl = byId("fit-status-line");
  const fitGuideEl = byId("fit-guide");
  const fitRunBtn = byId<HTMLButtonElement>("fit-run");
  const fitCancelBtn = byId<HTMLButtonElement>("fit-cancel");

  if (bodyBaselineSig && fitStatusLineEl) {
    disposers.push(
      bodyBaselineSig.subscribe((b) => {
        fitStatusLineEl.textContent = fitCardStatusLine(b, Date.now());
      }),
    );
  }

  wire(fitRunBtn, () => {
    // The guided flow needs the trainee physically at the start mark — a
    // desktop click can only point at the headset path (spec §6 toast).
    if (world.visibilityState.peek() === VisibilityState.NonImmersive) {
      showAppToast(FIT_NEEDS_HEADSET_TOAST);
      return;
    }
    if (bodyFitControls()?.start() !== true) {
      showAppToast(FIT_BUSY_TOAST); // caller-side reason line (spec §4.3)
    }
  });
  wire(fitCancelBtn, () => bodyFitControls()?.cancel());

  if (bodyFitFlowSig) {
    // Progress rides the plain ref, never the flow signal (adjudication §K)
    // — poll it at 4 Hz only while a live stage is measuring.
    let fitPollTimer: number | null = null;
    const stopFitPoll = (): void => {
      if (fitPollTimer !== null) {
        window.clearInterval(fitPollTimer);
        fitPollTimer = null;
      }
    };
    const paintGuide = (): void => {
      if (!fitGuideEl) return;
      const f = bodyFitFlowSig.peek();
      if (!f) return;
      if (f.stage === "stand" || f.stage === "walk") {
        const p =
          (g.bodyFitProgress as { value: number } | undefined)?.value ?? 0;
        const pct = Math.round(Math.min(1, Math.max(0, p)) * 100);
        fitGuideEl.textContent = `${f.line} (${pct}%)`;
      } else {
        fitGuideEl.textContent = f.line;
      }
    };
    disposers.push(
      bodyFitFlowSig.subscribe((f) => {
        if (!fitGuideEl) return;
        if (f === null) {
          fitGuideEl.hidden = true;
          if (fitCancelBtn) fitCancelBtn.hidden = true;
          if (fitRunBtn) fitRunBtn.disabled = false;
          stopFitPoll();
          return;
        }
        const live =
          f.stage === "mark" || f.stage === "stand" || f.stage === "walk";
        fitGuideEl.hidden = false;
        paintGuide();
        if (fitCancelBtn) fitCancelBtn.hidden = !live;
        if (fitRunBtn) fitRunBtn.disabled = live;
        if (live && fitPollTimer === null) {
          fitPollTimer = window.setInterval(paintGuide, 250);
        } else if (!live) {
          stopFitPoll();
        }
      }),
    );
    disposers.push(stopFitPoll);
  }

  // ---- training-mode picker → lesson card + globals.activeMode ----------
  // Four segmented chips select the mode; the lesson card (label / greeting /
  // meta / tagline) reflects it, and the choice is persisted. ShowDirector +
  // MetricsSystem read globals.activeMode for walk length, weights, pace, and
  // pass threshold.
  const lessonLabel = byId("lesson-label");
  const lessonGreeting = byId("lesson-greeting");
  const lessonMeta = byId("lesson-meta");
  const lessonTagline = byId("lesson-tagline");
  const modeChips = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#mode-select .mode-chip"),
  );

  // Render the greeting, substituting the {name} token with the trainee name
  // (styled in the accent color). Re-rendered when the name or mode changes.
  const renderGreeting = (el: HTMLElement, template: string): void => {
    const who = userPrefsSig ? userPrefsSig.peek().name : DEFAULT_USER.name;
    const tok = "{name}";
    el.textContent = "";
    // Substitute EVERY {name} token (the old indexOf handled only the first, so
    // a second token rendered as a literal "{name}").
    let from = 0;
    for (
      let i = template.indexOf(tok);
      i >= 0;
      i = template.indexOf(tok, from)
    ) {
      el.append(document.createTextNode(template.slice(from, i)));
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = who;
      el.append(name);
      from = i + tok.length;
    }
    el.append(document.createTextNode(template.slice(from)));
  };

  const renderMode = (mode: TrainingMode): void => {
    if (lessonLabel) {
      lessonLabel.textContent = `LESSON ${mode.number} — ${mode.label}`;
    }
    if (lessonGreeting) renderGreeting(lessonGreeting, mode.greeting);
    if (lessonMeta) {
      // Honest chips only: the mode's real length, target pace, and pass bar
      // (the fabricated stepsLabel is retired — #22).
      lessonMeta.textContent = `${mode.walkSeconds} SECONDS · ${targetPaceLabel(mode.idealPace)} · ${passBarLabel(mode.passThreshold)}`;
    }
    if (lessonTagline) lessonTagline.textContent = mode.tagline;
    for (const chip of modeChips) {
      const on = chip.dataset.mode === mode.id;
      chip.setAttribute("aria-selected", on ? "true" : "false");
    }
  };

  if (activeModeSig) {
    for (const chip of modeChips) {
      chip.addEventListener("click", () => {
        const id = chip.dataset.mode as ModeId | undefined;
        if (!id) return;
        const mode = getMode(id);
        activeModeSig.value = mode;
        saveMode(mode);
      });
    }
    disposers.push(activeModeSig.subscribe((mode) => renderMode(mode)));
    // Re-render the greeting live when the trainee changes their name.
    if (userPrefsSig) {
      disposers.push(
        userPrefsSig.subscribe(() => {
          if (lessonGreeting) {
            renderGreeting(lessonGreeting, activeModeSig.peek().greeting);
          }
        }),
      );
    }
  } else {
    console.warn("[landing] globals.activeMode signal missing");
  }

  // ---- passthrough backdrop picker → globals.activeScene ----------------
  // Five chips simulate the runway dropped into a real place (AR/none, Studio,
  // Park, Skatepark, Beach). installEnvironment() swaps the DomeTexture backdrop;
  // the choice is persisted. In a real headset the backdrop hides (passthrough).
  const sceneChips = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#scene-select .scene-chip"),
  );
  const renderScene = (scene: PassthroughScene): void => {
    for (const chip of sceneChips) {
      chip.setAttribute(
        "aria-selected",
        chip.dataset.scene === scene.id ? "true" : "false",
      );
    }
  };
  if (activeSceneSig) {
    // The panoramas are 1.5-8 MB and the SDK's DomeTexture load is silent
    // (no completion or error path) — so the picker owns the feedback (#33):
    // prefetch the file first with a loading pulse on the tapped chip, move
    // the selection only once the bytes are actually down (the texture load
    // then re-reads them from the HTTP cache), and on failure stay on the
    // previous backdrop with a calm toast instead of a black void.
    let sceneLoadSeq = 0;
    let sceneAbort: AbortController | null = null;
    /** Night-review #23: a stalled fetch (tunnel/demo-wifi TCP stall) neither
     * resolves nor rejects — without a deadline the chip pulses forever. The
     * timeout aborts the SAME controller, so the existing catch clears the
     * pulse and toasts; a superseding tap bumps seq first and stays silent. */
    const SCENE_FETCH_TIMEOUT_MS = 15000;
    const clearSceneLoading = (): void => {
      for (const c of sceneChips) {
        c.classList.remove("loading");
        c.removeAttribute("aria-busy");
      }
    };
    const applyScene = (scene: PassthroughScene): void => {
      activeSceneSig.value = scene;
      saveScene(scene);
    };
    for (const chip of sceneChips) {
      chip.addEventListener("click", () => {
        const id = chip.dataset.scene as SceneId | undefined;
        if (!id) return;
        const scene = getScene(id);
        const seq = ++sceneLoadSeq;
        sceneAbort?.abort();
        sceneAbort = null;
        clearSceneLoading();
        if (scene.src === null) {
          // AR / NONE needs no fetch — instant, and cancels any pending load.
          applyScene(scene);
          return;
        }
        const abort = new AbortController();
        sceneAbort = abort;
        chip.classList.add("loading");
        chip.setAttribute("aria-busy", "true");
        const deadline = window.setTimeout(
          () => abort.abort(),
          SCENE_FETCH_TIMEOUT_MS,
        );
        void (async () => {
          try {
            const res = await fetch(scene.src as string, {
              signal: abort.signal,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            // fetch resolves on headers — pull the full body so the loading
            // state is honest and the texture load hits a warm cache.
            await res.blob();
            if (seq !== sceneLoadSeq) return; // superseded by a newer tap
            clearSceneLoading();
            applyScene(scene);
          } catch {
            if (seq !== sceneLoadSeq) return; // superseded (incl. our abort)
            clearSceneLoading(); // a timeout abort lands here: pulse + toast
            showAppToast(
              `Couldn't load the ${scene.label} backdrop — staying on ${activeSceneSig.peek().label}.`,
            );
          } finally {
            window.clearTimeout(deadline);
          }
        })();
      });
    }
    disposers.push(activeSceneSig.subscribe((s) => renderScene(s)));
  } else {
    console.warn("[landing] globals.activeScene signal missing");
  }

  // ---- phase → chip text, section visibility, button disabled states ----
  let countdownTimer: number | null = null;
  const clearCountdown = (): void => {
    if (countdownTimer !== null) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
    }
  };

  const setDisabled = (el: HTMLButtonElement | null, on: boolean): void => {
    if (el && el.disabled !== on) {
      el.disabled = on;
    }
  };

  const countdownOverlay = byId("countdown-overlay");
  const countdownNum = byId("countdown-num");
  // Show a big centered number, restarting the pop animation each tick.
  const showCountdown = (n: number): void => {
    if (countdownNum) {
      countdownNum.textContent = String(n);
      countdownNum.style.animation = "none";
      void countdownNum.offsetWidth; // reflow → restart
      countdownNum.style.animation = "";
    }
    countdownOverlay?.removeAttribute("hidden");
  };
  const hideCountdown = (): void => countdownOverlay?.setAttribute("hidden", "");

  if (phaseSig) {
    disposers.push(
      phaseSig.subscribe((phase) => {
        // CSS keys strip/summary/lesson-card visibility off this attribute.
        if (landing) {
          landing.dataset.phase = phase;
        }
        // Quiet the ambient (blur shapes + sweep) during the walk → focus.
        document.body.classList.toggle("walking", phase === "walk");

        // Desktop walk controls hint (#2): the trainee is about to be scored
        // on movement, so the moment a walk starts on a laptop — no headset
        // session, no companion camera, not the auto-pilot preview — say how
        // to move. Without this a first-timer stands still, watches TIME
        // drain, and takes a garbage score as their first lesson.
        if (
          phase === "walk" &&
          world.visibilityState.peek() === VisibilityState.NonImmersive &&
          !cameraLive() &&
          g.demoActive !== true
        ) {
          showAppToast("WASD to walk — drag to look");
        }

        clearCountdown();
        if (phase === "countdown") {
          let n = 3;
          if (phaseChip) phaseChip.textContent = "3";
          showCountdown(3);
          countdownTimer = window.setInterval(() => {
            n -= 1;
            if (n >= 1) {
              if (phaseChip) phaseChip.textContent = String(n);
              showCountdown(n);
            } else {
              clearCountdown();
              hideCountdown();
            }
          }, 1000);
        } else {
          hideCountdown();
          if (phaseChip) phaseChip.textContent = phase.toUpperCase();
        }

        const running =
          phase === "brief" || phase === "countdown" || phase === "walk";
        setDisabled(beginWalkBtn, running);
        setDisabled(resetBtn, phase === "idle");
      }),
    );
  } else {
    console.warn("[landing] globals.showPhase signal missing");
  }

  // ---- TIME countdown chip (walkRemaining, integer-gated writes) ---------
  if (walkRemainingSig) {
    let lastTimeText = "";
    disposers.push(
      walkRemainingSig.subscribe((remaining) => {
        if (!timeChip) {
          return;
        }
        if (remaining < 0) {
          // Outside a walk — hide the chip and reset the gate.
          if (!timeChip.hidden) {
            timeChip.hidden = true;
          }
          lastTimeText = "";
          return;
        }
        const secs = Math.max(0, Math.ceil(remaining));
        const text = `${secs}S`;
        if (text !== lastTimeText) {
          lastTimeText = text;
          if (timeVal) {
            timeVal.textContent = text;
          }
          if (timeChip.hidden) {
            timeChip.hidden = false;
          }
          // Final ~10s redden + pulse for tension.
          timeChip.classList.toggle("urgent", secs <= 10 && secs > 0);
        }
      }),
    );
  } else {
    console.warn("[landing] globals.walkRemaining signal missing");
  }

  // ---- live metrics → bar widths + values + pass checks (change-gated) ---
  const lastWidth: string[] = new Array<string>(METRIC_COUNT).fill("");
  const lastVal: string[] = new Array<string>(METRIC_COUNT).fill("");
  const lastPass: boolean[] = new Array<boolean>(METRIC_COUNT).fill(false);

  if (metricsSig) {
    disposers.push(
      metricsSig.subscribe((m) => {
        if (!m) {
          // Run reset (null published at every startRun): clear the bars so a
          // repeat run's brief/countdown never shows the last walk's finals.
          for (let i = 0; i < METRIC_COUNT; i++) {
            lastWidth[i] = "";
            lastVal[i] = "";
            const fill = liveFills[i];
            if (fill) {
              fill.style.width = "0%";
            }
            const val = liveVals[i];
            if (val) {
              val.textContent = "—";
            }
            if (lastPass[i]) {
              lastPass[i] = false;
              liveChecks[i]?.classList.remove("pass");
            }
          }
          return;
        }
        const liveCarriage = g.headCarriage as CarriageTracker | undefined;
        for (let i = 0; i < METRIC_COUNT; i++) {
          const v =
            i === CARRIAGE_SLOT
              ? Math.round(liveCarriage?.liveScore() ?? 0)
              : Math.round(m[METRIC_KEYS[i]]);
          const width = `${v}%`;
          if (width !== lastWidth[i]) {
            lastWidth[i] = width;
            const fill = liveFills[i];
            if (fill) {
              fill.style.width = width;
            }
          }
          const text = String(v);
          if (text !== lastVal[i]) {
            lastVal[i] = text;
            const val = liveVals[i];
            if (val) {
              val.textContent = text;
            }
          }
          // Checkbox dot — fills Carolina Blue at the active mode's threshold.
          const pass = v >= passThreshold();
          if (pass !== lastPass[i]) {
            lastPass[i] = pass;
            liveChecks[i]?.classList.toggle("pass", pass);
          }
        }
      }),
    );
  } else {
    console.warn("[landing] globals.metrics signal missing");
  }

  // ---- summary → score ring (CSS --score), delta, per-metric rows -------
  let scoreRaf: number | null = null;
  /** The walk card's data, snapshotted per summary render (null = no walk
   * yet — the SHARE CARD button stays hidden). */
  let lastWalkCard: WalkCardData | null = null;
  if (summarySig) {
    disposers.push(
      summarySig.subscribe((s) => {
        if (!s) {
          return;
        }
        // Replay Theater: offer the ghost replay only when the walk just
        // recorded is actually replayable (head-path along/lateral samples
        // exist — camera-owned walks and metrics-less worlds are not).
        {
          const rc = g.replayControls as
            | {
                available(): boolean;
                compareAvailableFor(id: string): boolean;
              }
            | null;
          const canReplay = rc !== null && rc !== undefined && rc.available();
          const replayBtn = byId("sum-replay");
          const replayLegend = byId("replay-legend");
          if (replayBtn) replayBtn.hidden = !canReplay;
          if (replayLegend) replayLegend.hidden = !canReplay;
          // VS BEST needs a SECOND replayable walk in memory.
          const latestRec = (
            g.sessionRecorder as
              | { latest(): { id: string } | null }
              | undefined
          )?.latest();
          const compareBtn = byId("sum-compare");
          if (compareBtn) {
            compareBtn.hidden = !(
              canReplay &&
              rc !== null &&
              latestRec !== null &&
              latestRec !== undefined &&
              rc.compareAvailableFor(latestRec.id)
            );
          }
        }
        const overall = Math.round(s.overall);
        scoreRing?.style.setProperty("--score", String(overall));
        if (overallScore) {
          // Count the number up in sync with the ring reveal.
          if (scoreRaf !== null) cancelAnimationFrame(scoreRaf);
          const start = performance.now();
          const dur = 750;
          const tick = (nowMs: number): void => {
            const p = Math.min(1, (nowMs - start) / dur);
            const eased = 1 - Math.pow(1 - p, 3);
            overallScore.textContent = String(Math.round(overall * eased));
            if (p < 1) scoreRaf = requestAnimationFrame(tick);
            else scoreRaf = null;
          };
          scoreRaf = requestAnimationFrame(tick);
        }
        if (deltaLine) {
          if (s.deltaVsLast === null) {
            deltaLine.textContent = "FIRST WALK — BASELINE SET";
            deltaLine.classList.remove("neg");
          } else {
            const d = Math.round(s.deltaVsLast);
            deltaLine.textContent = `${d >= 0 ? "+" : ""}${d} VS LAST WALK`;
            deltaLine.classList.toggle("neg", d < 0);
          }
        }
        if (sumDuration) {
          // Duration + the REAL step count/cadence measured this walk (#22).
          // Middle-dot separator: the landing's convention (lessonMeta, the
          // history cards) — only the XR panel is ASCII-constrained.
          sumDuration.textContent = walkStatLine(s.durationSec, s.stats, " · ");
        }
        if (sumCarriage) {
          // M8 head-carriage row (head orientation, not gaze) — hidden when
          // the channel never engaged this walk (line === null). Tooltip is
          // SOURCE-AWARE (stamp honesty): the neutral parenthetical names
          // the calibration that scored THIS walk (stand / fit / walk).
          const carriage = carriageLine(s.carriage ?? null, " · ");
          sumCarriage.textContent = carriage ?? "";
          sumCarriage.title = s.carriage
            ? carriageTooltip(s.carriage.neutralSource)
            : "";
          sumCarriage.hidden = carriage === null;
        }
        if (sumHold) {
          // M10 hold row — the core's copy verbatim (holdStatLine, incl. the
          // NO READ reason branches: a null read is a fact worth a sentence).
          // Hidden only when the summary carries no hold stamp at all (built
          // without a director). Tooltip = the full disclosure, incl. the
          // stagecraft reward mapping (HOLD_EXPLAIN). Absent-reason fallback
          // "no-data" makes the weaker claim.
          if (s.hold !== undefined) {
            // Middle-dot separator: the landing's typography (the " - "
            // default is the XR panel's ASCII constraint — hold-stats.ts).
            sumHold.textContent = holdStatLine(
              s.hold,
              s.holdNullReason ?? "no-data",
              " · ",
            );
            sumHold.title = HOLD_EXPLAIN;
            sumHold.hidden = false;
          } else {
            sumHold.textContent = "";
            sumHold.hidden = true;
          }
        }
        if (sumBeat) {
          // M9 beat row — directly AFTER the hold row (§G summary order
          // HOLD -> BEAT), the core's copy verbatim (beatStatLine, incl.
          // the NO READ reason branches: a null read is a fact worth a
          // sentence). Hidden only when the summary carries no beat stamp
          // (built without a director). Tooltip = the full disclosure —
          // reference gate, head-bob lag, grid chooser (BEAT_EXPLAIN).
          // Absent-reason fallback "no-clock" makes the weakest claim.
          if (s.beat !== undefined) {
            // Middle-dot separator: the landing's typography, matching the
            // DURATION / CARRIAGE / HOLD / TURN sibling rows on this card (the
            // " - " default is the XR panel's ASCII constraint — beat-stats.ts).
            sumBeat.textContent = beatStatLine(
              s.beat,
              s.beatNullReason ?? "no-clock",
              " · ",
            );
            sumBeat.title = BEAT_EXPLAIN;
            sumBeat.hidden = false;
          } else {
            sumBeat.textContent = "";
            sumBeat.hidden = true;
          }
        }
        if (sumTurn) {
          // M11 turn row — directly AFTER the beat row (§G summary order
          // HOLD -> BEAT -> TURN), the core's copy verbatim (turnStatLine,
          // incl. the NO READ reason branches: a null read is a fact worth
          // a sentence). Hidden in the BOTH-null stamp case only (no
          // analyzer ran — turnRowStamped, the presence law shared with the
          // XR panel + the rider). Tooltip = the full disclosure
          // (TURN_EXPLAIN: head path not foot pivot, the sweep-back
          // deadband, the walk-baseline dip, the re-acquisition bar).
          // Middle-dot separator: the landing's typography; the reason
          // fallback "tracking-dark" is the weakest sensor claim (inert —
          // a stamped null row always carries its reason).
          if (turnRowStamped(s)) {
            sumTurn.textContent = turnStatLine(
              s.turn ?? null,
              s.turnNullReason ?? "tracking-dark",
              " · ",
            );
            sumTurn.title = TURN_EXPLAIN;
            sumTurn.hidden = false;
          } else {
            sumTurn.textContent = "";
            sumTurn.hidden = true;
          }
        }
        // F.27 head-motion observation notes — the hold DWELL + turn
        // SMOOTHNESS reads answer the trainee's first two post-walk questions
        // ("did I hold long enough / was my turn smooth"). DISPLAY-ONLY
        // (hold-turn-notes.ts): computed from the summary stamps, NOT scored,
        // NOT in any golden vector, NOT recorded — deliberately off the
        // golden-pinned holdCue/turnCue rider path the honest card drops.
        // Gated: a null hold/turn (never marked / one-way / dark) yields no
        // note and the line hides — so a U walk shows one line, a dark walk
        // none. .good tints a clean read.
        if (sumHoldNote) {
          const n = holdNote(s.hold ?? null);
          sumHoldNote.textContent = n ? n.text : "";
          sumHoldNote.classList.toggle("good", n?.good === true);
          sumHoldNote.hidden = n === null;
        }
        if (sumTurnNote) {
          const n = turnNote(s.turn ?? null);
          sumTurnNote.textContent = n ? n.text : "";
          sumTurnNote.classList.toggle("good", n?.good === true);
          sumTurnNote.hidden = n === null;
        }
        // Trainee-scoped history AFTER the recorder finalized this walk (it
        // subscribed to the summary signal FIRST, index.ts), so the list
        // already holds this walk's row. rowMatchesTrainee scopes records on
        // a shared device (session-grading.ts: falsy id = no filtering;
        // unattributed/legacy rows still count). Feeds BEST / NEW BEST (#11)
        // and the MODE MASTERED moment (#38).
        const rec = g.sessionRecorder as
          | {
              list(): Array<
                RepeatRow & { trainee?: { name: string; id: string } | null }
              >;
            }
          | undefined;
        const currentId = userPrefsSig?.peek().id ?? null;
        const traineeRows = (rec ? rec.list() : []).filter((r) =>
          rowMatchesTrainee(r, currentId),
        );
        // Personal-best chip beside the delta (#11) — a strictly-better real
        // walk reads NEW BEST. Synthetic Preview Walk rows never count
        // (progress.ts filters them), so a preview summary can show the
        // trainee's real record but can never set one.
        if (bestChip) {
          const report = progressReport(traineeRows);
          if (report.best !== null && report.walks >= 2) {
            bestChip.textContent = report.newBest
              ? "NEW BEST"
              : `BEST ${report.best.overall}`;
            bestChip.classList.toggle("new", report.newBest);
            bestChip.title = report.newBest
              ? "This walk set your highest overall on record."
              : "Your highest overall on record.";
            bestChip.hidden = false;
          } else {
            // First recorded walk (or no real history) — the delta line
            // already says BASELINE SET; a matching BEST chip would be noise.
            bestChip.hidden = true;
          }
        }
        // Grade the summary with the LOCKED run mode stamped on it
        // (mode-lock): the live picker can have moved during the brief
        // window, and this card must match the persisted row. Live-signal
        // fallback only when the stamp is absent/unknown (safety).
        const mode =
          (s.modeId ? MODES.find((m) => m.id === s.modeId) : undefined) ??
          activeModeSig?.peek() ??
          DEFAULT_MODE;
        // MODE MASTERED moment (#38): only on the walk that EARNED the locked
        // run mode's mastery — at least 3 of the trainee's last 5 walks in
        // that mode passed its own bar. masteryJustEarned is idempotent
        // against the post-walk history (mastered now, not mastered without
        // this walk, nothing recorded after it), so a re-render never
        // re-announces and a Preview Walk can never surface it.
        if (masteryChip) {
          const earned = masteryJustEarned(traineeRows, s.modeId ?? null);
          if (earned) {
            masteryChip.textContent = "MODE MASTERED";
            masteryChip.title = `${mode.label} is mastered — three of your last five walks in this mode cleared its ${mode.passThreshold} bar.`;
          }
          masteryChip.hidden = !earned;
        }
        // M12 consistency verdict (repeatability.ts): spread across the last
        // matched walks (same mode / shape / sensor / normalization stamp).
        // traineeRows already contains THIS walk — the recorder finalizes
        // before this renderer runs (the subscription order documented
        // above) — so the line appears exactly ON the 3rd qualifying walk's
        // card. Tooltip = the fixed disclosure: spread described, never
        // explained.
        if (repeatLine) {
          const rep = repeatabilityReport(traineeRows);
          repeatLine.textContent = rep ? rep.verdictLine : "";
          repeatLine.title = REPEAT_DISCLOSURE;
          repeatLine.hidden = !rep;
        }
        for (let i = 0; i < METRIC_COUNT; i++) {
          // The 3rd row shows head CARRIAGE (s.carriage.carriageScore), not
          // rhythm. Null carriage (short/no-orientation walk) shows 0/no-pass.
          const v =
            i === CARRIAGE_SLOT
              ? Math.round(s.carriage?.carriageScore ?? 0)
              : Math.round(s.scores[METRIC_KEYS[i]]);
          const pass = v >= mode.passThreshold;
          const fill = sumFills[i];
          if (fill) {
            fill.style.width = `${v}%`;
            fill.classList.toggle("low", !pass);
          }
          const val = sumVals[i];
          if (val) {
            val.textContent = String(v);
            val.classList.toggle("pass", pass);
            val.classList.toggle("low", !pass);
          }
        }

        // --- WS4: verdict, score colour, coach's notes, explainers ---------
        // Verdict + note selection live in the SHARED coach module (#9/#16);
        // cues upgrade to directional, quantified copy when the walk's real
        // measurements (s.stats) back the claim (#8/#22). `mode` is the
        // LOCKED run mode resolved above.
        // M8: applyCarriageNotes post-processes the report (identity unless
        // carriage is non-null AND a presence note qualifies) — coach.ts's
        // buildCoachReport stays behaviorally untouched (adjudication §I).
        const report = applyCarriageNotes(
          buildCoachReport({
            scores: s.scores,
            overall: s.overall,
            mode,
            stats: s.stats,
            // Left/right footwork copy is only honest on a one-way route (U) —
            // out-and-back walks flip the lateral sign on the return leg. Use
            // the route SNAPSHOT the director stamped on the summary (the route
            // the lateral data was collected on), never the live shape signal.
            oneWayRoute: s.oneWayRoute,
          }),
          s.carriage ?? null,
        );
        const passed = report.passed;
        if (overallScore) {
          overallScore.classList.toggle("pass", passed);
          overallScore.classList.toggle("low", !passed);
        }
        if (sumVerdict) {
          sumVerdict.textContent = report.verdict;
          sumVerdict.classList.toggle("pass", passed);
          sumVerdict.classList.toggle("low", !passed);
        }
        // MEDAL badge — the web twin of the in-headset pop (hud.ts). RANKING
        // medal (founder ruling 2026-07-10): this walk's POSITION among the
        // trainee's own walks — best = GOLD, 2nd SILVER, 3rd BRONZE, one
        // walk = gold. traineeRows (above) already holds this walk's row, so
        // medalRank ranks it against the rest. Class-toggle restart
        // (remove -> reflow -> add) re-fires the CSS pop per walk.
        if (sumMedal) {
          const medal = scoreMedal(medalRank(s.overall, traineeRows));
          sumMedal.classList.remove("pop");
          if (medal === null) {
            sumMedal.hidden = true;
          } else {
            sumMedal.textContent = MEDAL_LABEL[medal];
            sumMedal.style.background = MEDAL_COLOR[medal];
            sumMedal.hidden = false;
            void sumMedal.offsetWidth; // flush so re-adding .pop restarts it
            sumMedal.classList.add("pop");
          }
          // F.24 caption: the static #medal-note explains the medal is a
          // personal RANK, not the pass bar — so it rides the medal's presence
          // (hidden when no badge shows, the best-chip toggle pattern). Copy is
          // static in index.html, kept identical to the panel's MEDAL_RANK_NOTE.
          if (medalNote) medalNote.hidden = medal === null;
          // THE WALK CARD (share build): snapshot everything the card renders
          // off this exact summary + the same medal read the badge just used —
          // the card can never disagree with the card surface it sits on.
          lastWalkCard = {
            overall: s.overall,
            medal,
            pace: s.scores.pace,
            carriage: s.carriage ? s.carriage.carriageScore : null,
            line: s.scores.footPlacement,
            shapeKind: runwayShapeSig ? runwayShapeSig.peek().kind : "straight",
            runwayLength: runwayLayoutSig
              ? Math.round(runwayLayoutSig.peek().length * 10) / 10
              : null,
            runwayWidth: runwayLayoutSig
              ? Math.round(runwayLayoutSig.peek().width * 10) / 10
              : null,
            dateIso: new Date().toISOString().slice(0, 10),
          };
          const shareBtn = byId<HTMLButtonElement>("sum-share");
          if (shareBtn) shareBtn.hidden = false;
        }
        // Per-metric tooltip: plain-English explainer + this mode's weighting,
        // so the user sees WHY the metrics roll up to this overall. The M5
        // presence explainer branches AT RENDER on the per-walk carriage
        // stamp (adjudication §I): a walk whose blend included measured
        // carriage discloses the blended form; every other walk keeps the
        // legacy table text (which stays true for it). The M7 presentation
        // explainer branches the same way on a MEASURED turn (s.turn
        // non-null — coach.ts NEVER edited, §I additive): its legacy "the
        // turn is not analyzed" text stays true for every walk without a
        // turn read.
        for (let i = 0; i < METRIC_COUNT; i++) {
          const key = METRIC_KEYS[i];
          const wt = Math.round((mode.weights[key] ?? 0) * 100);
          const lab = sumLabels[i];
          if (lab) {
            // The 3rd row DISPLAYS head carriage (CARRIAGE_SLOT — the value
            // loop above), so its tooltip must explain carriage, not the
            // rhythm key that nominally owns the slot. Source-aware, matching
            // the #sum-carriage line row; a null-carriage walk (bar shows 0)
            // gets the honest no-read text. No "Weighted N%" suffix either
            // way — carriage is not a MetricSnapshot weight, and a rhythm
            // weight on this row would misstate how the overall rolls up.
            if (i === CARRIAGE_SLOT) {
              lab.title = s.carriage
                ? carriageTooltip(s.carriage.neutralSource)
                : CARRIAGE_NO_READ_TOOLTIP;
              continue;
            }
            // Key the presentation variant on whether the ANALYZER ran
            // (turnRowStamped — the same presence law the TURN row uses), NOT
            // on whether it produced a MEASURED value: on a NO-READ walk
            // (turn null with a stamped reason) the TURN row still renders its
            // "NO READ - ..." line, so a tooltip claiming "the turn is not
            // analyzed" would contradict the row on the same card. Both-null
            // (no tracker) correctly falls through to the legacy text.
            const explain =
              key === "presence" && s.carriage != null
                ? PRESENCE_EXPLAIN_WITH_CARRIAGE
                : key === "presentation" && turnRowStamped(s)
                  ? PRESENTATION_EXPLAIN_WITH_TURN
                  : (METRIC_EXPLAIN[key] ?? "");
            lab.title = `${explain} Weighted ${wt}% in ${mode.label}.`;
          }
        }
        // Coach's notes: the below-line metrics that cost the most overall
        // (weight x shortfall), most-impactful first, capped at three.
        // Post-walk note riders (adjudication §G, generalized in the M9
        // wiring): the ONE ordered rider list — HOLD > BEAT (> TURN when
        // M11 lands) — appends after the coach's notes; riders replace
        // CLEAN_WALK_CUE when the notes are empty. The DOM list has no
        // 3-slot cap, so no rider is dropped here (the XR panel's slot
        // exhaustion is the only dropper — the shipped M10 asymmetry,
        // kept). Per-channel gating + the absent-reason fallbacks live in
        // buildSummaryRiders (summary-riders.ts, pure + pin-tested).
        if (sumCoach && sumCoachList) {
          sumCoachList.textContent = "";
          // Headset-only honest card: coach only the metrics we SHOW (the
          // head-measured PACE / LINE / RHYTHM). Notes about the hidden
          // POSTURE / composites, and the HOLD / BEAT / TURN riders, are
          // dropped so the notes never reference a channel the trainee can't
          // see on the card. (Revert to full: render report.notes +
          // buildSummaryRiders(s).)
          const shownNotes = report.notes.filter((n) =>
            SHIPPED_METRIC_KEYS.includes(n.key),
          );
          if (shownNotes.length === 0) {
            const li = document.createElement("li");
            li.className = "sum-coach-item good";
            li.textContent = CLEAN_WALK_CUE;
            sumCoachList.appendChild(li);
          } else {
            for (const note of shownNotes) {
              const li = document.createElement("li");
              li.className = "sum-coach-item";
              const b = document.createElement("b");
              const m = METRICS.find((x) => x.key === note.key);
              b.textContent = `${m ? m.label : note.key}:`;
              li.append(b, document.createTextNode(` ${note.cue}`));
              sumCoachList.appendChild(li);
            }
          }
          sumCoach.hidden = false;
        }
      }),
    );
  } else {
    console.warn("[landing] globals.summary signal missing");
  }

  // ---- RUNWAY editor card (REV3) ----------------------------------------
  // Desktop / emulator mapping path: edit globals.runwayLayout with sliders
  // (you can't physically walk-and-place in the browser). Reading the signal
  // updates the sliders + readout; moving a slider writes a sanitized layout
  // back (change-gated) and saves on release. The whole flow is two-way and
  // re-syncs if mapping (or another surface) changes the layout.
  const rwCard = byId("runway-card");
  const rwReadout = byId("runway-readout");
  const lengthInput = byId<HTMLInputElement>("rw-length");
  const widthInput = byId<HTMLInputElement>("rw-width");
  const rotationInput = byId<HTMLInputElement>("rw-rotation");
  const posxInput = byId<HTMLInputElement>("rw-posx");
  const poszInput = byId<HTMLInputElement>("rw-posz");
  const lengthVal = byId("rw-length-val");
  const widthVal = byId("rw-width-val");
  const rotationVal = byId("rw-rotation-val");
  const posxVal = byId("rw-posx-val");
  const poszVal = byId("rw-posz-val");
  const rwMapBtn = byId<HTMLButtonElement>("rw-map");
  const rwAutofitBtn = byId<HTMLButtonElement>("rw-autofit");
  const rwResetBtn = byId<HTMLButtonElement>("rw-reset");
  const rwToggleBtn = byId<HTMLButtonElement>("rw-toggle");
  const rwPreviewBtn = byId<HTMLButtonElement>("rw-preview");

  // PREVIEW WALK — hands-free auto-pilot down the runway and back (no headset).
  const demoControls = (): { start(): void; stop(): void } | null =>
    (g.demoControls as { start(): void; stop(): void } | null) ?? null;
  wire(rwPreviewBtn, () => demoControls()?.start());

  if (runwayLayoutSig) {
    const L = LAYOUT_LIMITS;
    // Bind slider bounds to LAYOUT_LIMITS (rotation is -180..180 deg).
    if (lengthInput) {
      lengthInput.min = String(L.minLength);
      lengthInput.max = String(L.maxLength);
    }
    if (widthInput) {
      widthInput.min = String(L.minWidth);
      widthInput.max = String(L.maxWidth);
    }
    if (rotationInput) {
      rotationInput.min = "-180";
      rotationInput.max = "180";
    }
    for (const offsetInput of [posxInput, poszInput]) {
      if (offsetInput) {
        offsetInput.min = String(-L.maxOffset);
        offsetInput.max = String(L.maxOffset);
      }
    }

    const RAD2DEG = 180 / Math.PI;
    const DEG2RAD = Math.PI / 180;
    // yaw is stored in (-PI, PI] for the slider; sanitizeLayout keeps it
    // wrapped but may hand back >PI, so normalize for display only.
    const yawToDeg = (yaw: number): number => {
      let deg = yaw * RAD2DEG;
      deg = ((deg + 180) % 360) - 180;
      if (deg <= -180) deg += 360;
      return deg;
    };

    // Guard: while we push signal -> sliders, ignore the input events that
    // assigning .value would otherwise (not) fire, and never echo a write
    // back to the signal. Also prevents the subscriber from fighting a drag.
    let syncing = false;

    const fmtM = (m: number): string => `${m.toFixed(1)} m`;

    // Editorial glyphs (×/·/°), matching the landing's own conventions (#49):
    // this readout is the most-quoted line on the page, and "x/-/deg" read as
    // prototype next to the middle-dot copy everywhere else. DESKTOP DOM only —
    // the XR panel (hud.ts) keeps ASCII, its font has no such glyphs.
    const renderReadout = (layout: RunwayLayout): void => {
      const deg = Math.round(yawToDeg(layout.yaw));
      if (rwReadout) {
        rwReadout.textContent = `${layout.length.toFixed(1)} m × ${layout.width.toFixed(1)} m · ${deg}°`;
      }
    };

    // signal -> sliders + value labels + readout (change-gated per control).
    // POS X/Z come from the SHAPE center, not the layout: for a U the active
    // layout is legA (segments[0]), whose center is offset from the shape center
    // by ~armSpan. Echoing legA's center into the slider that WRITES the shape
    // center made every nudge jump ~armSpan and drift. length/width/yaw match
    // the spine, so they read from the layout. (The posx/posz slider range is
    // already the shape-center frame, [-maxOffset, maxOffset].)
    const applyToInputs = (
      layout: RunwayLayout,
      centerX: number,
      centerZ: number,
    ): void => {
      syncing = true;
      try {
        const deg = yawToDeg(layout.yaw);
        if (lengthInput) lengthInput.value = String(layout.length);
        if (widthInput) widthInput.value = String(layout.width);
        if (rotationInput) rotationInput.value = String(Math.round(deg));
        if (posxInput) posxInput.value = String(centerX);
        if (poszInput) poszInput.value = String(centerZ);
        if (lengthVal) lengthVal.textContent = fmtM(layout.length);
        if (widthVal) widthVal.textContent = fmtM(layout.width);
        if (rotationVal) rotationVal.textContent = `${Math.round(deg)}°`;
        if (posxVal) posxVal.textContent = fmtM(centerX);
        if (poszVal) poszVal.textContent = fmtM(centerZ);
        renderReadout(layout);
      } finally {
        syncing = false;
      }
    };

    // slider -> SHAPE. The slider patch is in layout space; map it onto the
    // shape's spine fields (so editing a loaded T keeps its kind). Change-gated
    // against the resulting layout so a clamped drag is a no-op. The shape
    // signal persists itself (index.ts), and runwayLayout recomputes.
    const writeField = (patch: Partial<RunwayLayout>): void => {
      if (syncing || !runwayShapeSig) {
        return;
      }
      const curShape = runwayShapeSig.peek();
      const curLayout = runwayLayoutSig.peek();
      // LENGTH edits anchor the START LINE, not the center (the Quest
      // tester's short-runway fix — anchorStartOnLengthEdit). Applied FIRST
      // so an explicit centerX/centerZ in the same patch (the position
      // sliders) still overrides the anchored center below.
      const base =
        patch.length !== undefined
          ? anchorStartOnLengthEdit(curShape, patch.length)
          : curShape;
      const shapePatch: Partial<RunwayShape> = {};
      if (patch.width !== undefined) shapePatch.spineWidth = patch.width;
      if (patch.yaw !== undefined) shapePatch.yaw = patch.yaw;
      if (patch.centerX !== undefined) shapePatch.centerX = patch.centerX;
      if (patch.centerZ !== undefined) shapePatch.centerZ = patch.centerZ;
      const nextShape = sanitizeShape({ ...base, ...shapePatch });
      const nextLayout = shapeToActiveLayout(nextShape);
      // Update labels/readout immediately from the (sanitized) result. POS X/Z
      // echo the shape center (not the offset legA layout) so a U doesn't drift.
      applyToInputs(nextLayout, nextShape.centerX, nextShape.centerZ);
      const changed =
        Math.abs(nextLayout.centerX - curLayout.centerX) > 1e-4 ||
        Math.abs(nextLayout.centerZ - curLayout.centerZ) > 1e-4 ||
        Math.abs(nextLayout.yaw - curLayout.yaw) > 1e-4 ||
        Math.abs(nextLayout.length - curLayout.length) > 1e-4 ||
        Math.abs(nextLayout.width - curLayout.width) > 1e-4;
      if (changed) {
        runwayShapeSig.value = nextShape;
      }
    };

    const num = (input: HTMLInputElement | null): number =>
      input ? Number(input.value) : 0;

    // Live drag (input) updates the layout; release (change) persists it.
    const bindSlider = (
      input: HTMLInputElement | null,
      toPatch: (raw: number) => Partial<RunwayLayout>,
    ): void => {
      if (!input) {
        return;
      }
      input.addEventListener("input", () => writeField(toPatch(num(input))));
      input.addEventListener("change", () => writeField(toPatch(num(input))));
    };

    bindSlider(lengthInput, (v) => ({ length: v }));
    bindSlider(widthInput, (v) => ({ width: v }));
    bindSlider(rotationInput, (v) => ({ yaw: v * DEG2RAD }));
    bindSlider(posxInput, (v) => ({ centerX: v }));
    bindSlider(poszInput, (v) => ({ centerZ: v }));

    // Collapse/expand: collapsed shows just the summary + EDIT; expanded floats
    // the full editor so all controls fit without crowding the side column.
    wire(rwToggleBtn, () => {
      if (!rwCard) return;
      const expanded = rwCard.classList.toggle("expanded");
      if (rwToggleBtn) rwToggleBtn.textContent = expanded ? "DONE" : "EDIT";
      // Exclusive panels: opening the editor closes the camera + history panels.
      if (expanded) closeFixedPanels("editor");
    });

    // Buttons.
    wire(rwMapBtn, () => mapControls()?.startMapping());
    wire(rwAutofitBtn, () => {
      // Fit to room scans the REAL floor (Quest plane detection) — only possible
      // in the headset. On the desktop there's no room to fit, so explain it
      // rather than snap to fixed numbers (the old, rejected behaviour).
      mapControls()?.autoMapFromFloor();
      showAppToast(
        "Fit to room scans your real floor — use it in the headset (press X).",
      );
    });
    wire(rwResetBtn, () => {
      if (runwayShapeSig) runwayShapeSig.value = { ...DEFAULT_SHAPE };
      // subscriber below mirrors the recomputed layout into the sliders/readout.
    });

    // --- preset + saved-runway picker (WS1) ------------------------------
    // Load a fact-checked preset OR a saved runway: write its compiled spine
    // into runwayLayout (the subscriber refreshes every slider + the readout).
    const presetSelect = byId<HTMLSelectElement>("rw-preset");
    const rwSaveBtn = byId<HTMLButtonElement>("rw-save");
    const savedStore = g.savedRunways as SavedRunwaysStore | undefined;
    const activeIdSig = g.activeRunwayId as Signal<string | null> | undefined;
    let loadingPreset = false;

    // Single shared #app-toast helper + timer (see showAppToast) — separate
    // per-helper timers used to cut each other's messages short.
    const editorToast = showAppToast;

    const populatePresetSelect = (): void => {
      if (!presetSelect) return;
      const keep = presetSelect.value;
      presetSelect.textContent = "";
      const custom = document.createElement("option");
      custom.value = "";
      custom.textContent = "Custom…";
      presetSelect.appendChild(custom);
      const saved = savedStore?.list() ?? [];
      if (saved.length) {
        const og = document.createElement("optgroup");
        og.label = "My runways";
        for (const r of saved) {
          const o = document.createElement("option");
          o.value = `saved:${r.id}`;
          o.textContent = r.name;
          og.appendChild(o);
        }
        presetSelect.appendChild(og);
      }
      const groups: ReadonlyArray<[string, string]> = [
        ["regulation", "Regulation"],
        ["famous", "Famous runways"],
        ["training", "Training"],
      ];
      for (const [cat, label] of groups) {
        const og = document.createElement("optgroup");
        og.label = label;
        for (const p of PRESET_RUNWAYS.filter((x) => x.category === cat)) {
          const o = document.createElement("option");
          o.value = `preset:${p.id}`;
          o.textContent = `${p.name} · ${Math.round(p.shape.spineLength)}m`;
          og.appendChild(o);
        }
        presetSelect.appendChild(og);
      }
      presetSelect.value = keep;
    };

    const applyShape = (shape: RunwayShape, id: string | null): void => {
      if (!runwayShapeSig) return;
      loadingPreset = true;
      // Source of truth is the SHAPE — preserves kind (T/X/U) for the shape
      // phase; the computed runwayLayout mirrors into sliders/readout.
      runwayShapeSig.value = sanitizeShape({ ...shape });
      loadingPreset = false;
      if (activeIdSig) activeIdSig.value = id;
    };

    if (presetSelect) {
      presetSelect.addEventListener("change", () => {
        const v = presetSelect.value;
        if (!v) {
          if (activeIdSig) activeIdSig.value = null;
          return;
        }
        if (v.startsWith("preset:")) {
          const p = PRESET_RUNWAYS.find((x) => `preset:${x.id}` === v);
          if (p) {
            applyShape(p.shape, p.id);
            editorToast(`Loaded ${p.name}`);
          }
        } else if (v.startsWith("saved:") && savedStore) {
          const r = savedStore.get(v.slice("saved:".length));
          if (r) {
            applyShape(r.shape, r.id);
            editorToast(`Loaded ${r.name}`);
          }
        }
      });
    }

    wire(rwSaveBtn, () => {
      if (!savedStore) return;
      const name = window.prompt("Name this runway:", "My runway");
      if (name === null) return;
      const entry = savedStore.save(
        name,
        runwayShapeSig ? { ...runwayShapeSig.peek() } : straightShapeFromLayout(runwayLayoutSig.peek()),
      );
      populatePresetSelect();
      if (presetSelect) presetSelect.value = `saved:${entry.id}`;
      if (activeIdSig) activeIdSig.value = entry.id;
      editorToast(`Saved "${entry.name}"`);
    });

    populatePresetSelect();

    // --- shape picker (straight / T / X / U) + arm controls (shape phase) ---
    const shapeChips = Array.from(
      document.querySelectorAll<HTMLButtonElement>("#rw-shape .rw-shape-chip"),
    );
    const armSpanInput = byId<HTMLInputElement>("rw-armspan");
    const armSpanVal = byId("rw-armspan-val");
    const armSpanRow = byId("rw-armspan-row");
    const crossAtInput = byId<HTMLInputElement>("rw-crossat");
    const crossAtVal = byId("rw-crossat-val");
    const crossAtRow = byId("rw-crossat-row");

    const writeShape = (patch: Partial<RunwayShape>): void => {
      if (!runwayShapeSig) return;
      runwayShapeSig.value = sanitizeShape({
        ...runwayShapeSig.peek(),
        ...patch,
      });
    };

    const renderShapeControls = (shape: RunwayShape): void => {
      for (const c of shapeChips) {
        c.classList.toggle("active", c.dataset.shape === shape.kind);
      }
      // armSpan applies to T/X/U; crossAt only to X (T = far end, U uses span).
      if (armSpanRow) armSpanRow.hidden = shape.kind === "straight";
      if (crossAtRow) crossAtRow.hidden = shape.kind !== "X";
      if (armSpanInput) armSpanInput.value = String(shape.armSpan);
      if (armSpanVal) armSpanVal.textContent = fmtM(shape.armSpan);
      if (crossAtInput) {
        crossAtInput.value = String(Math.round(shape.crossAt * 100));
      }
      if (crossAtVal) crossAtVal.textContent = `${Math.round(shape.crossAt * 100)}%`;
    };

    for (const chip of shapeChips) {
      chip.addEventListener("click", () => {
        const kind = chip.dataset.shape as RunwayShape["kind"] | undefined;
        if (kind) writeShape({ kind });
      });
    }
    if (armSpanInput) {
      const onArm = (): void =>
        writeShape({ armSpan: Number(armSpanInput.value) });
      armSpanInput.addEventListener("input", onArm);
      armSpanInput.addEventListener("change", onArm);
    }
    if (crossAtInput) {
      const onCross = (): void =>
        writeShape({ crossAt: Number(crossAtInput.value) / 100 });
      crossAtInput.addEventListener("input", onCross);
      crossAtInput.addEventListener("change", onCross);
    }
    if (runwayShapeSig) {
      renderShapeControls(runwayShapeSig.peek());
      disposers.push(runwayShapeSig.subscribe(renderShapeControls));
    }

    // signal -> UI (initial + any external change, e.g. mapping commit).
    disposers.push(
      runwayLayoutSig.subscribe((layout) => {
        // POS X/Z come from the shape center (un-offset); fall back to the layout
        // center only if there's no shape signal (straight-only — they're equal).
        const shape = runwayShapeSig?.peek();
        applyToInputs(
          layout,
          shape ? shape.centerX : layout.centerX,
          shape ? shape.centerZ : layout.centerZ,
        );
        // A direct edit (slider / map / reset) means it's no longer a preset.
        if (presetSelect && !loadingPreset) {
          presetSelect.value = "";
          if (activeIdSig) activeIdSig.value = null;
        }
      }),
    );
  } else {
    console.warn("[landing] globals.runwayLayout signal missing");
    if (rwCard) {
      // No model to edit — hide the card rather than show dead sliders.
      rwCard.style.display = "none";
    }
  }

  // ---- XR: hide the DOM overlay entirely while immersed -----------------
  disposers.push(
    world.visibilityState.subscribe((state) => {
      const immersed = state !== VisibilityState.NonImmersive;
      if (immersed) {
        // A session became active: the launch watchdog must not fire, and a
        // "declined" toast that already fired (slow permission dialog, then an
        // accept) must not linger for the return to the browser.
        if (xrWatchdog !== null) {
          window.clearTimeout(xrWatchdog);
          xrWatchdog = null;
        }
        hideAppToast();
      }
      if (landing) {
        landing.style.display = immersed ? "none" : "";
      }
      // The blurred bg shapes + spotlight sweep live OUTSIDE #landing (and
      // above the canvas) — stop compositing them during the session.
      document.body.classList.toggle("immersed", immersed);
      if (enterXrBtn) {
        enterXrBtn.textContent = immersed ? "EXIT HEADSET" : "ENTER HEADSET";
      }
    }),
  );

  // ---- external pose tracker (Phase 2) live indicator -------------------
  // Poll the tracker status once a second; show a pill when a companion camera
  // (iPhone/webcam) is streaming. status() is a plain method (not a signal),
  // so a light interval is the right fit here.
  const trackerPill = byId("tracker-pill");
  const trackerPillText = byId("tracker-pill-text");
  const tracker = g.externalTracker as
    | { status(): { connected: boolean; source: string | null; fps: number } }
    | undefined;
  const trackerToast = byId("tracker-toast");
  if (trackerPill && tracker) {
    let lastShown = "";
    let wasConnected = false;
    let toastTimer: number | null = null;
    const tick = (): void => {
      const s = tracker.status();
      // The kicker moment: toast when a real body-tracking stream first connects.
      if (s.connected && !wasConnected && trackerToast) {
        trackerToast.classList.add("show");
        if (toastTimer !== null) window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(
          () => trackerToast.classList.remove("show"),
          3200,
        );
      }
      // Drop-out: the companion camera went stale mid-session — say so (the
      // metrics fall back to head tracking automatically).
      if (!s.connected && wasConnected) {
        showAppToast("Camera dropped — back to head tracking");
      }
      wasConnected = s.connected;
      const label = s.connected
        ? `CAMERA · ${(s.source ?? "live").toUpperCase()} · ${Math.round(s.fps)} FPS`
        : "";
      if (label !== lastShown) {
        lastShown = label;
        if (s.connected) {
          if (trackerPillText) trackerPillText.textContent = label;
          trackerPill.removeAttribute("hidden");
        } else {
          trackerPill.setAttribute("hidden", "");
        }
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    disposers.push(() => {
      window.clearInterval(id);
      if (toastTimer !== null) window.clearTimeout(toastTimer);
    });
  }

  // ---- connect-a-camera affordance (WS7 companion discoverability) ------
  // The pose-relay pipeline (companion page -> ws relay -> pose-ingest) is wired;
  // this surfaces HOW to connect a phone so it's discoverable, not just a pill
  // that appears after the fact.
  const cameraPanel = byId("camera-panel");
  const cameraUrlEl = byId("camera-url");
  const companionUrl = (): string =>
    typeof location !== "undefined"
      ? `${location.origin}/companion/`
      : "/companion/";
  if (cameraPanel) {
    wire(byId("camera-chip"), () => {
      const open = cameraPanel.hasAttribute("hidden");
      if (!open) {
        cameraPanel.setAttribute("hidden", "");
        return;
      }
      if (cameraUrlEl) cameraUrlEl.textContent = companionUrl();
      cameraPanel.removeAttribute("hidden");
      closeFixedPanels("camera");
    });
    wire(byId("camera-close"), () => cameraPanel.setAttribute("hidden", ""));
    wire(byId("camera-copy"), () => {
      const url = companionUrl();
      try {
        void navigator.clipboard?.writeText(url);
        showAppToast("Companion link copied");
      } catch {
        showAppToast(url);
      }
    });
    wire(byId("camera-open"), () =>
      window.open(companionUrl(), "_blank", "noopener"),
    );
  }

  // ---- run-history gallery + data export (WS2) --------------------------
  // The recorder persists a compact summary row per walk (survives reloads);
  // the full per-walk time-series lives only for this page-load, so per-run
  // CSV/JSON export is only available for walks done since the last reload.
  interface SessionRow {
    id: string;
    startedAt: number;
    lesson: string;
    /** Wave-4 curriculum stamps (additive-optional). */
    tib?: { pace: number | null; line: number | null; carriage: number | null } | null;
    drillId?: string | null;
    drillScore?: number | null;
    /** Scoring context captured at record time (legacy rows: absent). */
    modeId?: string | null;
    passThreshold?: number | null;
    /** Head-path normalization stamp (FIT wave; legacy rows: absent ->
     * rowNormalization "default.v1"). */
    normalization?: string | null;
    /** Ruler stamp (perfect=100 rescale; legacy rows: absent ->
     * rowScoreScale "s98.v1"). */
    scoreScale?: string | null;
    trainee?: { name: string; id: string } | null;
    primarySource: string;
    /** Preview Walk auto-pilot run (legacy rows: absent = real). */
    synthetic?: boolean;
    durationSec: number;
    overall: number | null;
    finalScores: Record<string, number> | null;
    /** REAL measurement scalars the M12 consistency channels vote with
     * (walk-stats; absent on pre-measurement rows). */
    stats?: RepeatStatsSlice | null;
    /** M8 head-carriage stamp (non-null <=> the M5 presence blend ran this
     * walk — adjudication §I; absent on pre-wave rows). The detail card's
     * PRESENCE tooltip + COMPOSITE caption branch on it at render. */
    carriage?: CarriageStats | null;
    /** M11 turn stamp (absent on pre-wave rows; null when no turn was
     * measured). The detail card's PRESENTATION tooltip branches on a
     * MEASURED turn at render (adjudication §I, the carriage precedent). */
    turn?: TurnStats | null;
    /** M12 stamps (absent on pre-wave rows; shapeKind null when unknown or
     * voided by a mid-walk kind change). */
    shapeKind?: string | null;
    benchmark?: boolean;
  }
  const recorder = g.sessionRecorder as
    | {
        count(): number;
        list(): SessionRow[];
        hasFullRecord(id: string): boolean;
        exportSessionCSV(id?: string): boolean;
        exportSessionJSON(id?: string): boolean;
        exportAllCSV(): boolean;
        exportAllXlsx(): Promise<boolean>;
        exportAllJSON(): boolean;
        clearHistory(): void;
      }
    | undefined;
  const exportBtn = byId<HTMLButtonElement>("export-btn");
  const dataChip = byId<HTMLButtonElement>("data-chip");
  const dataChipText = byId("data-chip-text");
  const sessionsPanel = byId("sessions-panel");
  const sessionsList = byId("sessions-list");
  const sessionsEmpty = byId("sessions-empty");
  const spCount = byId("sp-count");

  // Lightweight toast for export confirmations + dead-end feedback.
  // Same shared #app-toast helper + timer as showAppToast/editorToast.
  const showToast = showAppToast;

  if (recorder) {
    // Each row is graded against ITS OWN recorded pass threshold (the mode's
    // bar at walk time), falling back to the legacy 75 for old rows — so a
    // Beginner 76 reads NEEDS WORK here exactly as it did on the summary card
    // (#4/#40; see session-grading.ts).
    // The HONEST shipped card, mirrored into the history detail (founder
    // directive 2026-07-22 — the panel still showed the pre-honest-3 seven):
    // PACE / CARRIAGE / LINE, the exact walk-card reads. Carriage comes off
    // the row's OWN stamp (null = the channel never engaged that walk).
    const HONEST_MINI: ReadonlyArray<{
      lab: string;
      value: (r: SessionRow) => number | null;
      tip: (r: SessionRow) => string;
    }> = [
      {
        lab: "PACE",
        value: (r) => (r.finalScores ? Math.round(r.finalScores.pace) : null),
        tip: () => `PACE — ${METRIC_EXPLAIN.pace}`,
      },
      {
        lab: "CARRIAGE",
        value: (r) =>
          r.carriage != null ? Math.round(r.carriage.carriageScore) : null,
        tip: (r) =>
          r.carriage != null
            ? carriageTooltip(r.carriage.neutralSource)
            : "HEAD CARRIAGE — no read this walk (the channel never engaged).",
      },
      {
        lab: "LINE",
        value: (r) =>
          r.finalScores ? Math.round(r.finalScores.footPlacement) : null,
        tip: () => `LINE — ${METRIC_EXPLAIN.footPlacement}`,
      },
    ];
    let filter: "all" | "pass" | "low" = "all";

    // --- trends strip (#11): progress across the persisted history --------
    // Pure math in progress.ts (synthetic rows excluded there); this only
    // paints. Always fed the FULL history — the pass/low filter narrows the
    // card list below, never the trend.
    const trendsWrap = byId("sp-trends");
    const trendsTitle = byId("sp-trends-title");
    const trendsAvg = byId("sp-trends-avg");
    const trendsBest = byId("sp-trends-best");
    const sparkEl = byId("sp-spark");
    const trendLineEl = byId("sp-trend-line");
    const benchmarkEl = byId("sp-benchmark");
    const renderTrends = (rows: SessionRow[]): void => {
      if (!trendsWrap) return;
      // The strip describes the CURRENT trainee (rowMatchesTrainee:
      // falsy id = no filtering; unattributed/legacy rows count) — the card
      // list below stays the full shared-device history, attributable per row.
      const currentId = userPrefsSig?.peek().id ?? null;
      const traineeRows = rows.filter((r) => rowMatchesTrainee(r, currentId));
      // FIT wave (adversary A): a comparative SERIES never trends across a
      // normalization change — scope the strip to rows scored under the
      // ACTIVE stamp (legacy/absent rows read "default.v1", so pre-FIT
      // history trends unchanged for anyone who never runs FIT). When the
      // prefilter actually excluded rows, the title says why (§E suffix).
      const activeStamp = normalizationStamp(
        bodyBaselineSig?.peek() ?? null,
        currentId,
      );
      // M12 benchmark headline: the ONLY series the product captions as
      // improvement — stamped benchmark rows in the newest row's
      // normalization+sensor group (repeatability.ts). Fed the trainee rows
      // UNscoped AND painted BEFORE the scoped-trends early return: the
      // series does its own normalization grouping (a re-FIT restarts it),
      // so neither its content nor its VISIBILITY may inherit the strip's
      // active-stamp prefilter (a re-FIT empties the scoped rows while the
      // old-stamp benchmark series is still valid). #sp-benchmark is its own
      // sibling strip in index.html for the same reason — trendsWrap.hidden
      // must not suppress it. Hidden only when the headline is null.
      if (benchmarkEl) {
        const bench = benchmarkHeadline(traineeRows);
        benchmarkEl.textContent = bench ? benchmarkLine(bench) : "";
        benchmarkEl.title = BENCHMARK_TOOLTIP;
        benchmarkEl.hidden = !bench;
      }
      const scoped = scopeRowsToNormalization(traineeRows, activeStamp);
      // Perfect=100 rescale: the trends series never blends rulers — scope
      // to current-scale rows on top of the FIT prefilter. PB/mastery inside
      // progressReport carry their own internal scale gates.
      const scaleScoped = scopeRowsToScale(scoped.rows, SCORE_SCALE_STAMP);
      const report = progressReport(scaleScoped.rows);
      // One real walk can't trend — hold the strip until there's a comparison.
      if (report.walks < 2) {
        trendsWrap.hidden = true;
        return;
      }
      trendsWrap.hidden = false;
      if (trendsTitle) {
        // §E composition, M12's half: the BASE is demoted to RECENT ACTIVITY
        // (this strip blends modes/shapes/sensors — only the benchmark line
        // below is ever captioned as improvement); FIT's suffix hook intact.
        trendsTitle.textContent =
          recentActivityTitle(report.series.length) +
          (scoped.excluded ? SINCE_FIT_TITLE_SUFFIX : "") +
          (scaleScoped.excluded ? NEW_SCALE_TITLE_SUFFIX : "");
      }
      if (trendsAvg) {
        trendsAvg.textContent =
          report.rollingAvg === null
            ? ""
            : `AVG ${Math.round(report.rollingAvg)}`;
        trendsAvg.title = `Average overall of your last ${Math.min(5, report.walks)} walks.`;
      }
      if (trendsBest) {
        if (report.best) {
          trendsBest.textContent = `BEST ${report.best.overall}`;
          trendsBest.title = `Personal best, set ${new Date(
            report.best.startedAt,
          ).toLocaleDateString([], {
            month: "short",
            day: "numeric",
          })}.`;
          trendsBest.hidden = false;
        } else {
          trendsBest.hidden = true;
        }
      }
      if (sparkEl) {
        sparkEl.textContent = "";
        for (let i = 0; i < report.series.length; i++) {
          const v = report.series[i];
          const bar = document.createElement("span");
          bar.className =
            "sp-spark-bar" +
            (i === report.series.length - 1 ? " latest" : "");
          bar.style.height = `${Math.max(6, Math.min(100, v))}%`;
          bar.title = `${v} OVERALL`;
          sparkEl.appendChild(bar);
        }
      }
      if (trendLineEl) {
        // One line, ASCII plus-minus, HONEST-card metrics only (the same
        // labels as the per-card mini bars; carriage has no engine trend
        // series, so the line covers the two MetricSnapshot channels). A
        // metric with fewer than 2 recorded walks stays silent rather than
        // showing a fake 0.
        const TREND_MINI: ReadonlyArray<[ProgressMetricKey, string]> = [
          ["pace", "PACE"],
          ["footPlacement", "LINE"],
        ];
        trendLineEl.textContent = "";
        for (const [key, lab] of TREND_MINI) {
          const d = report.metricTrends[key];
          if (d === null) continue;
          const rounded = Math.round(d);
          const span = document.createElement("span");
          span.className = rounded > 0 ? "up" : rounded < 0 ? "down" : "";
          span.textContent = `${lab} ${rounded > 0 ? "+" : ""}${rounded}`;
          const full = METRICS.find((m) => m.key === key);
          span.title = `${full ? full.label : key} — recent walks vs the ones before.`;
          trendLineEl.appendChild(span);
        }
      }
    };

    // --- per-mode records strip (#38): under TRENDS, one chip per mode ----
    // Pure math in progress.ts (modeStats: real walks only, each graded
    // against its own recorded bar); this only paints. Same trainee scoping
    // as TRENDS — the records describe the CURRENT trainee, while the card
    // list below stays the full shared-device history.
    const modesWrap = byId("sp-modes");
    const renderModes = (rows: SessionRow[]): void => {
      if (!modesWrap) return;
      const currentId = userPrefsSig?.peek().id ?? null;
      const stats = modeStats(
        rows.filter((r) => rowMatchesTrainee(r, currentId)),
      );
      if (stats.length === 0) {
        modesWrap.hidden = true;
        return;
      }
      // Lesson order (the MODES table), then the pre-mode legacy bucket,
      // then — defensively — any bucket neither covers.
      const byMode = new Map(stats.map((st) => [st.modeId, st]));
      const ordered = [
        ...MODES.map((m) => byMode.get(m.id)),
        byMode.get(LEGACY_MODE_BUCKET),
      ].filter((st): st is ModeStats => st !== undefined);
      const seen = new Set(ordered.map((st) => st.modeId));
      for (const st of stats) {
        if (!seen.has(st.modeId)) ordered.push(st);
      }
      modesWrap.textContent = "";
      for (const st of ordered) {
        const mode = MODES.find((m) => m.id === st.modeId);
        const chip = document.createElement("div");
        chip.className = "sp-mode-chip";
        const name = document.createElement("span");
        name.textContent = mode
          ? mode.label
          : st.modeId === LEGACY_MODE_BUCKET
            ? "EARLIER WALKS"
            : st.modeId.toUpperCase();
        const best = document.createElement("span");
        best.className = "sp-mode-best";
        best.textContent = `BEST ${st.best}`;
        chip.append(name, best);
        if (st.mastered) {
          const badge = document.createElement("span");
          badge.className = "sp-mode-badge";
          badge.textContent = "MASTERED";
          chip.appendChild(badge);
        }
        const walks = `${st.walks} walk${st.walks === 1 ? "" : "s"}`;
        chip.title =
          st.modeId === LEGACY_MODE_BUCKET
            ? `${walks} recorded before lessons were tracked · ${st.passed} passed · last ${st.last}.`
            : `${walks} · ${st.passed} passed · last ${st.last}. ` +
              (st.mastered
                ? "Mastered — three of your last five walks in this mode cleared its bar."
                : "Mastery: pass three of your last five walks in this mode.");
        modesWrap.appendChild(chip);
      }
      modesWrap.hidden = false;
    };

    // --- M12 consistency strip: spread across the matched-walk window -----
    // Pure math in repeatability.ts (realScoredRows + the group key: mode /
    // shape / sensor / normalization stamp); this only paints. Same trainee
    // scoping as the strips above. Hidden until 3 matched walks exist.
    const repeatWrap = byId("sp-repeat");
    const renderRepeat = (rows: SessionRow[]): void => {
      if (!repeatWrap) return;
      const currentId = userPrefsSig?.peek().id ?? null;
      const rep = repeatabilityReport(
        rows.filter((r) => rowMatchesTrainee(r, currentId)),
      );
      if (!rep) {
        repeatWrap.hidden = true;
        return;
      }
      repeatWrap.textContent = "";
      // `CONSISTENCY — {MODE LABEL} / {SHAPE}` (§6): the matched conditions
      // are named IN the title, never implied (em-dash legal on the web
      // panel; the XR panel gets the ASCII compactLine instead).
      const repMode = MODES.find((m) => m.id === rep.modeId);
      const title = document.createElement("div");
      title.className = "sp-repeat-title";
      title.textContent = `CONSISTENCY — ${
        repMode ? repMode.label : rep.modeId.toUpperCase()
      } / ${rep.shapeKind.toUpperCase()}`;
      const detail = document.createElement("div");
      detail.className = "sp-repeat-detail";
      detail.textContent = rep.detailLine;
      const verdict = document.createElement("div");
      verdict.className = "sp-repeat-verdict";
      verdict.textContent = rep.verdictLine;
      repeatWrap.append(title, detail, verdict);
      repeatWrap.title = REPEAT_DISCLOSURE;
      repeatWrap.hidden = false;
    };

    const refreshChip = (): void => {
      const n = recorder.count();
      if (dataChipText) {
        dataChipText.textContent = `${n} WALK${n === 1 ? "" : "S"}`;
      }
      if (dataChip) {
        if (n > 0) dataChip.removeAttribute("hidden");
        else dataChip.setAttribute("hidden", "");
      }
    };

    const renderCard = (r: SessionRow): HTMLElement => {
      const card = document.createElement("div");
      card.className = "sp-card";

      const top = document.createElement("div");
      top.className = "sp-card-top";
      const meta = document.createElement("div");
      meta.className = "sp-card-meta";
      const when = document.createElement("span");
      when.className = "sp-card-when";
      when.textContent = new Date(r.startedAt).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      // Auto-pilot runs are visibly badged — synthetic data never poses as a
      // trainee walk in the coach's history (#3).
      if (isSyntheticRow(r)) {
        const badge = document.createElement("span");
        badge.className = "sp-badge";
        badge.textContent = "PREVIEW";
        when.appendChild(badge);
      }
      const sub = document.createElement("span");
      sub.className = "sp-card-sub";
      const dur = r.durationSec ? `${Math.round(r.durationSec)}s` : "—";
      sub.append(document.createTextNode(`${r.lesson} · ${dur} · `));
      const srcSpan = document.createElement("span");
      srcSpan.className = "sp-src";
      srcSpan.textContent = r.primarySource;
      sub.appendChild(srcSpan);
      meta.append(when, sub);

      const score = document.createElement("span");
      const thr = rowPassThreshold(r);
      const pass = rowPassed(r);
      score.className =
        "sp-card-score" + (r.overall === null ? "" : pass ? " pass" : " low");
      score.textContent = r.overall === null ? "—" : String(r.overall);
      top.append(meta, score);
      card.appendChild(top);

      if (r.finalScores) {
        // The honest-3 detail (the walk-card reads): PACE / CARRIAGE / LINE.
        // A null channel (no carriage read that walk) shows an empty track —
        // never a fabricated zero-height "score".
        const mini = document.createElement("div");
        mini.className = "sp-mini";
        for (const m of HONEST_MINI) {
          const col = document.createElement("div");
          col.className = "sp-mini-col";
          col.title = m.tip(r);
          const bar = document.createElement("div");
          bar.className = "sp-mini-bar";
          const v = m.value(r);
          if (v !== null) {
            const fill = document.createElement("div");
            const c = Math.max(0, Math.min(100, v));
            fill.className = "sp-mini-fill" + (c < thr ? " low" : "");
            fill.style.height = `${c}%`;
            bar.appendChild(fill);
          }
          const l = document.createElement("div");
          l.className = "sp-mini-lab";
          l.textContent = m.lab;
          const val = document.createElement("div");
          val.className = "sp-mini-val";
          val.textContent = v === null ? "—" : String(v);
          col.append(val, bar, l);
          mini.appendChild(col);
        }
        card.appendChild(mini);
      }

      const actions = document.createElement("div");
      actions.className = "sp-card-actions";
      // LIVE REPLAY (founder directive 2026-07-22): walks whose full
      // trajectory is still in memory replay as the front-row ghost right
      // from history — the panel closes, the ghost walks, any input returns.
      {
        const rc = g.replayControls as
          | {
              availableFor(id: string): boolean;
              startFor(id: string): boolean;
              compareAvailableFor(id: string): boolean;
              startCompareFor(id: string): boolean;
            }
          | null;
        if (rc && rc.availableFor(r.id)) {
          const replay = document.createElement("button");
          replay.className = "btn btn-primary sp-replay";
          replay.type = "button";
          replay.textContent = "REPLAY";
          replay.addEventListener("click", () => {
            if (rc.startFor(r.id)) {
              if (sessionsPanel) sessionsPanel.hidden = true;
            } else {
              showToast(
                "That walk can't replay right now — finish or reset the current run first.",
              );
            }
          });
          actions.appendChild(replay);
          // GHOST vs GHOST (F.35): this walk vs the best OTHER walk still
          // in memory, start-synchronized on one runway.
          if (rc.compareAvailableFor(r.id)) {
            const cmp = document.createElement("button");
            cmp.className = "btn btn-glass sp-compare";
            cmp.type = "button";
            cmp.textContent = "VS BEST";
            cmp.addEventListener("click", () => {
              if (rc.startCompareFor(r.id)) {
                if (sessionsPanel) sessionsPanel.hidden = true;
              } else {
                showToast(
                  "That walk can't replay right now — finish or reset the current run first.",
                );
              }
            });
            actions.appendChild(cmp);
          }
        }
      }
      if (recorder.hasFullRecord(r.id)) {
        // The walk's full time-series is in memory — per-walk exports work.
        // The failure branch below covers the rare eviction between render
        // and click (SESSIONS_CAP), in plain language.
        const csv = document.createElement("button");
        csv.className = "btn btn-glass";
        csv.type = "button";
        csv.textContent = "CSV";
        csv.addEventListener("click", () => {
          showToast(
            recorder.exportSessionCSV(r.id)
              ? "Saved CSV to your Downloads"
              : "That walk's detail is no longer available — the panel exports below cover its summary.",
          );
        });
        const json = document.createElement("button");
        json.className = "btn btn-glass";
        json.type = "button";
        json.textContent = "JSON";
        json.addEventListener("click", () => {
          showToast(
            recorder.exportSessionJSON(r.id)
              ? "Saved JSON to your Downloads"
              : "That walk's detail is no longer available — the panel exports below cover its summary.",
          );
        });
        actions.append(csv, json);
      } else {
        // The walk's full time-series is gone from memory — recorded before
        // this page was opened OR evicted by the in-memory cap after many
        // walks. Be honest (and cause-neutral, like the click-time toasts)
        // instead of offering buttons that can only fail (#41), and promise
        // nothing about the exports below — synthetic rows are excluded from
        // the summary CSV, and the JSON prefers this page-load's full
        // records, so inclusion is not unconditional.
        const tag = document.createElement("span");
        tag.className = "sp-summary-only";
        tag.textContent = "SUMMARY ONLY";
        tag.title =
          "This walk's full time-series is no longer available — only the scored summary was kept.";
        actions.appendChild(tag);
      }
      card.appendChild(actions);
      return card;
    };

    const populatePanel = (): void => {
      const all = recorder.list();
      if (spCount) spCount.textContent = String(all.length);
      renderTrends(all);
      renderModes(all);
      renderRepeat(all);
      if (sessionsEmpty) {
        sessionsEmpty.style.display = all.length === 0 ? "block" : "none";
      }
      if (!sessionsList) return;
      sessionsList.textContent = "";
      // PASSED / NEEDS WORK are training verdicts: synthetic Preview Walk rows
      // are excluded from both (they still show under ALL, badged).
      const rows = filterHistoryRows(all, filter);
      if (all.length > 0 && rows.length === 0) {
        const none = document.createElement("div");
        none.className = "sp-empty";
        none.textContent =
          filter === "pass"
            ? "No passing walks yet — keep training."
            : "No walks below the line. Nice.";
        sessionsList.appendChild(none);
        return;
      }
      for (const r of rows) sessionsList.appendChild(renderCard(r));
    };

    // Filter chips.
    const chips = Array.from(
      document.querySelectorAll<HTMLButtonElement>("#sp-filters .sp-chip"),
    );
    for (const chip of chips) {
      chip.addEventListener("click", () => {
        const f = chip.dataset.filter;
        filter = f === "pass" || f === "low" ? f : "all";
        for (const c of chips) c.classList.toggle("active", c === chip);
        populatePanel();
      });
    }

    // EXPORT DATA (summary card): the just-finished walk, CSV + full JSON.
    wire(exportBtn, () => {
      const ok = recorder.exportSessionCSV();
      recorder.exportSessionJSON();
      showToast(ok ? "Saved this walk to your Downloads" : "No walk to export");
    });
    // Nav chip: open the run-history view.
    wire(dataChip, () => {
      if (!sessionsPanel) {
        recorder.exportAllCSV();
        return;
      }
      const open = sessionsPanel.hasAttribute("hidden");
      if (open) {
        populatePanel();
        sessionsPanel.removeAttribute("hidden");
        // Exclusive panels: opening run history closes the camera + editor.
        closeFixedPanels("sessions");
      } else {
        sessionsPanel.setAttribute("hidden", "");
      }
    });
    wire(byId("sessions-close"), () =>
      sessionsPanel?.setAttribute("hidden", ""),
    );
    // The walks sheet is now the CHARTED Excel file (founder call 2026-07-08:
    // native charts so the data is easy to read + defend) — same ten columns,
    // same synthetic-row exclusion; historyRowCells feeds both formats.
    wire(byId("export-all-csv"), () => {
      void recorder
        .exportAllXlsx()
        .then((ok) => {
          if (ok) {
            showToast("Saved the Excel sheet to your Downloads");
            return;
          }
          // exportAllXlsx filters synthetic rows BEFORE the empty check — with
          // a history of ONLY Preview Walks the panel visibly lists badged
          // rows, so "no walks yet" would be a lie. Say what actually happened.
          showToast(
            recorder.count() > 0
              ? "Only Preview Walks so far — they're excluded from the coach sheet; the JSON export carries them tagged"
              : "No walks to export yet",
          );
        })
        .catch((err) => {
          // Template fetch/fill failure (offline cache miss, moved internals):
          // fall back to the CSV of the SAME ten columns rather than failing
          // the trainee's export outright — and say which format they got.
          console.warn("[landing] Excel export failed:", err);
          showToast(
            recorder.exportAllCSV()
              ? "Excel export failed — saved the CSV instead"
              : "No walks to export yet",
          );
        });
    });
    wire(byId("export-all-json"), () =>
      showToast(
        recorder.exportAllJSON()
          ? "Saved JSON to your Downloads"
          : "No walks to export yet",
      ),
    );
    // CLEAR HISTORY (#26): the missing data-management basic for a product
    // recording body metrics — a coach starting a clean record for the next
    // student, a trainee deleting their own data. Two-tap confirm: the first
    // tap arms ("TAP AGAIN TO ERASE N WALKS", auto-disarm ~4s so an
    // accidental tap can simply be walked away from), the second erases.
    const clearBtn = byId<HTMLButtonElement>("clear-history");
    if (clearBtn) {
      const CLEAR_LABEL = "CLEAR HISTORY";
      const CLEAR_DISARM_MS = 4000;
      let armTimer: number | null = null;
      const disarmClear = (): void => {
        if (armTimer !== null) {
          window.clearTimeout(armTimer);
          armTimer = null;
        }
        clearBtn.classList.remove("armed");
        clearBtn.textContent = CLEAR_LABEL;
      };
      clearBtn.addEventListener("click", () => {
        const n = recorder.count();
        if (n === 0) {
          disarmClear();
          showToast("No walks recorded yet — nothing to clear");
          return;
        }
        if (!clearBtn.classList.contains("armed")) {
          clearBtn.classList.add("armed");
          clearBtn.textContent = `TAP AGAIN TO ERASE ${n} WALK${n === 1 ? "" : "S"}`;
          armTimer = window.setTimeout(disarmClear, CLEAR_DISARM_MS);
          return;
        }
        disarmClear();
        recorder.clearHistory();
        // The panel must not keep promising erased data: chip, count, trends
        // strip, and the card list all re-render empty immediately.
        refreshChip();
        populatePanel();
        showToast(`History cleared — ${n} walk${n === 1 ? "" : "s"} erased`);
      });
      // Reopening the panel never resurfaces a stale armed state.
      wire(dataChip, disarmClear);
      wire(byId("sessions-close"), disarmClear);
    }
    refreshChip();
    if (summarySig) {
      disposers.push(
        summarySig.subscribe(() => {
          refreshChip();
          // A fresh summary means a fresh card - the previous walk's
          // PRACTICE NEXT list never carries over (wave 2).
          const recapEl = byId("sum-recap");
          if (recapEl) recapEl.hidden = true;
          if (sessionsPanel && !sessionsPanel.hasAttribute("hidden")) {
            populatePanel();
          }
        }),
      );
    }
  }

  // ---- first-run onboarding (WS5) ---------------------------------------
  // A short, dismissible welcome the very first time someone opens the app —
  // removes the "lands on idle with no idea what to do" cliff.
  const onboarding = byId("onboarding");
  if (onboarding) {
    const onbKicker = byId("onb-kicker");
    const onbTitle = byId("onb-title");
    const onbBody = byId("onb-body");
    const onbDots = byId("onb-dots");
    const onbNext = byId<HTMLButtonElement>("onb-next");
    const onbName = byId<HTMLInputElement>("onb-name");
    const ONBOARD_KEY = "xrunway.onboarded.v1";
    if (onbName && userPrefsSig) {
      const cur = userPrefsSig.peek().name;
      if (cur && cur !== DEFAULT_USER.name) onbName.value = cur;
      onbName.addEventListener("input", () => {
        const name = onbName.value.trim() || DEFAULT_USER.name;
        userPrefsSig.value = { ...userPrefsSig.peek(), name };
        saveUser(userPrefsSig.peek());
      });
    }
    const steps: ReadonlyArray<{
      kicker: string;
      title: string;
      body: string;
    }> = [
      {
        kicker: "WELCOME",
        title: "Train like you're already on the runway.",
        body: "(X)RUNWAY is a first-person AR runway coach. Map your real floor — or load a famous runway — and walk it for real.",
      },
      {
        kicker: "HOW IT WORKS",
        title: "Set a runway, walk it, get scored.",
        // D22.2 honesty fix (2026-07-09, under the founder's complete-it
        // delegation): the old line promised posture/footwork/presence
        // scoring - the honest card shows PACE / CARRIAGE / LINE.
        body: "1 · Pick a preset runway or map your floor.\n2 · Walk to the mark, hold your pose, walk back.\n3 · An AI coach scores your pace, carriage and line — with notes on what to fix.",
      },
      {
        kicker: "READY",
        title: "Let's see your walk.",
        body: "Try a Preview Walk to watch the runway in action, then walk it yourself — in the headset, or right here with WASD and drag to look. Every run is saved to your history.",
      },
    ];
    let step = 0;
    const renderOnb = (): void => {
      const s = steps[step];
      if (onbKicker) onbKicker.textContent = s.kicker;
      if (onbTitle) onbTitle.textContent = s.title;
      if (onbBody) onbBody.textContent = s.body;
      if (onbNext) {
        onbNext.textContent =
          step === steps.length - 1 ? "Start training" : "Next";
      }
      if (onbName) onbName.hidden = step !== 0; // ask for the name up front
      if (onbDots) {
        onbDots.textContent = "";
        steps.forEach((_, i) => {
          const d = document.createElement("span");
          d.className = "onb-dot" + (i === step ? " active" : "");
          onbDots.appendChild(d);
        });
      }
    };
    const closeOnb = (): void => {
      onboarding.hidden = true;
      try {
        localStorage.setItem(ONBOARD_KEY, "1");
      } catch {
        /* non-fatal */
      }
    };
    wire(byId("onb-skip"), closeOnb);
    wire(onbNext, () => {
      if (step < steps.length - 1) {
        step += 1;
        renderOnb();
      } else {
        closeOnb();
      }
    });
    // Show only on a true first run: never onboarded AND no recorded walks.
    let seen = false;
    try {
      seen = localStorage.getItem(ONBOARD_KEY) === "1";
    } catch {
      seen = false;
    }
    const walkCount =
      (g.sessionRecorder as { count(): number } | undefined)?.count() ?? 0;
    if (!seen && walkCount === 0) {
      step = 0;
      renderOnb();
      onboarding.hidden = false;
    }
  }

  // ---- Wave-4 curriculum card (docs/CURRICULUM-DESIGN.md) ----------------
  // Level status + Mastery-Record line (cold blocks ONLY — the F4 law),
  // today's plan (weakest DISPLAYED channel), and the drill focus chips.
  // Gates are soft recommendations; all strings are curriculum-core F.40
  // drafts. Preview-Walk bots never reach any record (realScoredRows).
  {
    const levelLine = byId("cur-level-line");
    const recordLine = byId("cur-record-line");
    const planLine = byId("cur-plan-line");
    const drillNote = byId("cur-drill-note");
    // The drill focus signal (recorder latches it at walk start).
    if (!g.activeDrill) {
      g.activeDrill = signal<{ id: string } | null>(null);
    }
    const activeDrillSig = g.activeDrill as Signal<{ id: string } | null>;
    const curRows = (): SessionRow[] => {
      const rec = g.sessionRecorder as
        | { list(): SessionRow[] }
        | undefined;
      const currentId = userPrefsSig?.peek().id ?? null;
      return realScoredRows(
        (rec?.list() ?? []).filter((r) => rowMatchesTrainee(r, currentId)),
      );
    };
    const renderCurriculum = (): void => {
      const rows = curRows();
      const block = latestColdBlock(rows);
      const idx = recommendedLevelIndex(block);
      const working =
        CURRICULUM_LEVELS[Math.min(idx + 1, CURRICULUM_LEVELS.length - 1)];
      if (levelLine) {
        levelLine.textContent =
          idx < 0
            ? `Start with ${CURRICULUM_LEVELS[0].name}. Your first cold walks place you.`
            : `Working level: ${working.name}`;
      }
      if (recordLine) {
        recordLine.textContent = gateCopy(
          evaluateGate(working, block),
          working.name,
        );
      }
      if (planLine) planLine.textContent = planCopy(weakestChannel(rows));
      // The last drill rep's verdict (time-in-band on the focus channel).
      if (drillNote) {
        const last = rows.length > 0 ? rows[rows.length - 1] : null;
        const lastDrill = last ? drillById(last.drillId ?? null) : null;
        const focus = activeDrillSig.peek();
        const focusDef = drillById(focus ? focus.id : null);
        const parts: string[] = [];
        if (focusDef) {
          parts.push(
            `FOCUS: ${focusDef.name} - next START runs as a rep (${focusDef.reps} x ${focusDef.repSeconds}S suggested).`,
          );
        }
        if (
          lastDrill &&
          last &&
          typeof last.drillScore === "number" &&
          Number.isFinite(last.drillScore)
        ) {
          parts.push(`LAST REP: ${lastDrill.name} ${last.drillScore}% in band.`);
        }
        drillNote.textContent = parts.join(" ");
        drillNote.hidden = parts.length === 0;
      }
      for (const d of SHIPPED_DRILLS) {
        const chip = byId(`drill-${d.id}`);
        if (chip) {
          chip.classList.toggle(
            "active",
            activeDrillSig.peek()?.id === d.id,
          );
        }
      }
    };
    for (const d of SHIPPED_DRILLS) {
      wire(byId(`drill-${d.id}`), () => {
        const cur = activeDrillSig.peek();
        activeDrillSig.value = cur && cur.id === d.id ? null : { id: d.id };
        renderCurriculum();
      });
    }
    if (summarySig) {
      disposers.push(summarySig.subscribe(() => renderCurriculum()));
    }
    renderCurriculum();
  }

  // ---- first-run guided attention (the web tour) -------------------------
  // The spotlight sequence that walks a brand-new visitor's eye through the
  // landing, ending on START. Gated inside web-tour.ts on the empty-history
  // law + its own dismissal key; it waits for the onboarding modal above and
  // for the entrance choreography to settle before it begins.
  disposers.push(
    installWebTour({
      walkCount: () =>
        (g.sessionRecorder as { count(): number } | undefined)?.count() ?? 0,
      phaseIdle: () => (phaseSig?.peek() ?? "idle") === "idle",
      inBrowser: () =>
        world.visibilityState.peek() === VisibilityState.NonImmersive,
      onboardingOpen: () => {
        const o = byId("onboarding");
        return !!o && !o.hidden;
      },
    }),
  );

  // Disposers are retained for symmetry/debugging; the landing lives for the
  // whole session, so nothing is exposed and nothing is torn down early.
  void disposers;
}
