/**
 * FIRST-RUN GUIDED ATTENTION — the DOM driver.
 *
 * A dim overlay with a spotlight cutout (the box-shadow trick: the cutout div
 * casts a 200vmax shadow that IS the dim) glides between the beats declared
 * in web-tour-core.ts, one caption pill at a time, ending on START. Click
 * anywhere advances, SKIP is always visible, timers advance on their own.
 *
 * Lifecycle laws (the brief):
 * - starts only AFTER the landing's entrance choreography (TOUR_SETTLE_DELAY),
 *   never while the first-run onboarding modal is open (it waits for it),
 *   never during a walk, never in XR, never when arriving mid-flow (a
 *   non-idle phase before the start cancels the whole load).
 * - dismissal (skip / finish / killed by a walk or XR entry) stamps
 *   WEB_TOUR_KEY; with the key set — or any walk in history — it never shows.
 *
 * Pure DOM module — no ECS system, no per-frame work while inactive.
 */

import {
  SCENE_SPOT_FRAC,
  shouldShowWebTour,
  TOUR_BEATS,
  TOUR_SETTLE_DELAY_MS,
  TOUR_START_WINDOW_MS,
  WEB_TOUR_KEY,
} from "./web-tour-core.js";

/** Landing-owned reads the tour needs; kept as thunks so the tour never
 * imports the show/world modules. */
export interface WebTourHooks {
  walkCount(): number;
  /** showPhase === "idle" (no countdown/walk/summary in flight). */
  phaseIdle(): boolean;
  /** visibilityState === NonImmersive (flat browser, not a headset). */
  inBrowser(): boolean;
  /** The #onboarding modal is open (first-run welcome — tour waits its turn). */
  onboardingOpen(): boolean;
}

const POLL_MS = 350;
const SPOT_PAD_PX = 12;
const CAPTION_GAP_PX = 18;
/** Caption crossfade: text swaps at the fade-out midpoint of the glide. */
const CAPTION_SWAP_MS = 260;

function readDismissed(): boolean {
  try {
    return localStorage.getItem(WEB_TOUR_KEY) === "1";
  } catch {
    return false;
  }
}

function stampDismissed(): void {
  try {
    localStorage.setItem(WEB_TOUR_KEY, "1");
  } catch {
    /* non-fatal — the session still won't replay (installed once per load) */
  }
}

/** Install the first-run tour. Returns a disposer (symmetry with landing's
 * disposers list; the landing lives for the whole session). */
export function installWebTour(hooks: WebTourHooks): () => void {
  const overlay = document.getElementById("web-tour");
  const spot = document.getElementById("tour-spot");
  const caption = document.getElementById("tour-caption");
  const skip = document.getElementById("tour-skip");
  if (!overlay || !spot || !caption || !skip) return () => undefined;

  if (!shouldShowWebTour(hooks.walkCount(), readDismissed())) {
    return () => undefined;
  }

  let beat = -1;
  let active = false;
  let cancelled = false;
  let holdTimer: number | null = null;
  let swapTimer: number | null = null;
  const mountedAt = Date.now();

  const clearTimers = (): void => {
    if (holdTimer !== null) window.clearTimeout(holdTimer);
    if (swapTimer !== null) window.clearTimeout(swapTimer);
    holdTimer = null;
    swapTimer = null;
  };

  const placeSpot = (
    left: number,
    top: number,
    width: number,
    height: number,
    radius: number,
  ): void => {
    spot.style.left = `${Math.round(left)}px`;
    spot.style.top = `${Math.round(top)}px`;
    spot.style.width = `${Math.round(width)}px`;
    spot.style.height = `${Math.round(height)}px`;
    spot.style.borderRadius = `${radius}px`;
    // Caption rides under the cutout when there's room, above it otherwise;
    // horizontally centered on the spot, clamped to the viewport.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = caption.offsetWidth || 280;
    const ch = caption.offsetHeight || 48;
    const cx = Math.min(Math.max(left + width / 2 - cw / 2, 14), vw - cw - 14);
    const below = top + height + CAPTION_GAP_PX;
    const cy = below + ch < vh - 14 ? below : top - CAPTION_GAP_PX - ch;
    caption.style.left = `${Math.round(cx)}px`;
    caption.style.top = `${Math.round(cy)}px`;
  };

  const renderBeat = (i: number, firstPaint: boolean): void => {
    const b = TOUR_BEATS[i];
    overlay.setAttribute("data-beat", b.target);
    const applyGeometry = (): void => {
      if (b.target === "scene") {
        const [fx, fy, fw, fh] = SCENE_SPOT_FRAC;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        placeSpot(fx * vw, fy * vh, fw * vw, fh * vh, 38);
      } else {
        const el = document.getElementById(b.target);
        if (!el) {
          advance(); // target missing (layout drift) — never strand the dim
          return;
        }
        const r = el.getBoundingClientRect();
        placeSpot(
          r.left - SPOT_PAD_PX,
          r.top - SPOT_PAD_PX,
          r.width + SPOT_PAD_PX * 2,
          r.height + SPOT_PAD_PX * 2,
          b.target === "begin-walk" ? 999 : 22,
        );
      }
    };
    if (firstPaint) {
      caption.textContent = b.caption;
      caption.style.opacity = "1";
      applyGeometry();
    } else {
      // Crossfade the caption while the cutout glides.
      caption.style.opacity = "0";
      applyGeometry();
      swapTimer = window.setTimeout(() => {
        caption.textContent = b.caption;
        caption.style.opacity = "1";
        // Re-clamp now that the pill has its real width.
        applyGeometry();
      }, CAPTION_SWAP_MS);
    }
  };

  const teardown = (stamp: boolean): void => {
    if (!active && cancelled) return;
    active = false;
    cancelled = true;
    clearTimers();
    window.clearInterval(watchdog);
    window.removeEventListener("resize", onResize);
    overlay.removeEventListener("click", onOverlayClick);
    skip.removeEventListener("click", onSkip);
    overlay.setAttribute("hidden", "");
    overlay.removeAttribute("data-beat");
    if (stamp) stampDismissed();
  };

  const advance = (): void => {
    clearTimers();
    beat += 1;
    if (beat >= TOUR_BEATS.length) {
      teardown(true);
      return;
    }
    renderBeat(beat, beat === 0);
    holdTimer = window.setTimeout(advance, TOUR_BEATS[beat].holdMs);
  };

  const onOverlayClick = (ev: MouseEvent): void => {
    // SKIP has its own handler; anywhere else advances.
    if (ev.target === skip) return;
    advance();
  };
  const onSkip = (ev: MouseEvent): void => {
    ev.stopPropagation();
    teardown(true);
  };
  const onResize = (): void => {
    if (active && beat >= 0 && beat < TOUR_BEATS.length) {
      renderBeat(beat, true);
    }
  };

  const begin = (): void => {
    active = true;
    overlay.removeAttribute("hidden");
    overlay.addEventListener("click", onOverlayClick);
    skip.addEventListener("click", onSkip);
    window.addEventListener("resize", onResize);
    advance();
  };

  // ONE poller drives both phases of the lifecycle: waiting for a clean
  // start, then (while active) killing the tour the moment a walk begins or
  // the visitor enters XR.
  const watchdog = window.setInterval(() => {
    if (cancelled) return;
    if (active) {
      if (!hooks.phaseIdle() || !hooks.inBrowser()) {
        // A walk started (or XR entered) mid-sequence — kill cleanly; the
        // stamp keeps the never-replays law even if the walk is abandoned.
        teardown(true);
      }
      return;
    }
    // Not started yet.
    if (readDismissed() || hooks.walkCount() > 0) {
      teardown(false);
      return;
    }
    const elapsed = Date.now() - mountedAt;
    if (elapsed > TOUR_START_WINDOW_MS) {
      teardown(false); // too late to be "arriving" — no stamp, next load retries
      return;
    }
    if (!hooks.inBrowser()) return; // headset first — the XR guide owns that path
    if (!hooks.phaseIdle()) {
      // Mid-flow before we ever started (a walk is already running) —
      // don't interrupt this load at all.
      teardown(false);
      return;
    }
    if (hooks.onboardingOpen()) return; // wait for the welcome modal
    if (elapsed < TOUR_SETTLE_DELAY_MS) return; // let the entrance land
    begin();
  }, POLL_MS);

  return () => teardown(false);
}
