/**
 * (X)RUNWAY — Pure XR-launch decision logic for the landing CTAs.
 *
 * Desktop Chrome/Edge expose `navigator.xr` with NO AR device attached, and
 * IWSDK's `launchXR()` ends in `requestSession(...).then(onSessionStart)` with
 * no `.catch` — so gating BEGIN WALK / ENTER HEADSET on bare `navigator.xr`
 * truthiness made the hero buttons silent no-ops exactly where most first
 * contact happens (a laptop click on a production build). These predicates
 * branch on the RESOLVED capability (`isSessionSupported('immersive-ar')`,
 * cached at mount) instead; landing.ts feeds live state in, the tests feed a
 * truth table.
 *
 * Dependency-free on purpose (the stage-budget.ts / hud-state.ts pattern):
 * importing @iwsdk/core touches `document` and cannot load in node/vitest.
 */

export interface XrLaunchState {
  /** An immersive session is already active. */
  immersed: boolean;
  /** An external companion camera is streaming a body right now. */
  cameraLive: boolean;
  /** `navigator.xr` exists at all. */
  xrPresent: boolean;
  /**
   * Cached `isSessionSupported('immersive-ar')` result: true/false once it
   * resolves, or null while still resolving / unqueryable. null launches
   * optimistically — the launch watchdog covers a session that never arrives.
   */
  arSupported: boolean | null;
}

export type BeginWalkAction = "begin-walk" | "launch-xr" | "desktop-preview";

/**
 * BEGIN WALK / WALK AGAIN — never dead-end:
 *  - immersed, or a companion camera is streaming the body → run the show here;
 *  - a WebXR runtime that can (or may yet) do immersive-ar → enter the headset;
 *  - anything else → the branded desktop preview (toast + beginWalk).
 */
export function beginWalkAction(s: XrLaunchState): BeginWalkAction {
  if (s.immersed || s.cameraLive) {
    return "begin-walk";
  }
  if (s.xrPresent && s.arSupported !== false) {
    return "launch-xr";
  }
  return "desktop-preview";
}

export type LaunchWatchdogVerdict = "silent" | "declined-toast" | "fallback";

/**
 * What the launch watchdog should do when it fires, ~5 s after an optimistic
 * launchXR() call (IWSDK's launchXR swallows the requestSession rejection, so
 * a session that never arrives is otherwise indistinguishable from a slow
 * permission dialog):
 * - a session became active (no longer NonImmersive) → "silent" — the launch
 *   worked (the visibilityState subscription normally cancels the timer; this
 *   covers the race);
 * - still outside XR AND arSupported === true → the headset really declined
 *   the session → "declined-toast" (check permissions);
 * - still outside XR with arSupported false OR null → by fire time the mount
 *   probe has (almost certainly) resolved, and it did NOT say yes: this
 *   machine most likely has no AR device, so blaming a "declined" headset
 *   would be wrong — "fallback" routes to the caller's no-AR path (BEGIN
 *   WALK → the desktop-preview toast + beginWalk; ENTER HEADSET → the
 *   no-headset hint), so the click never dead-ends.
 */
export function launchWatchdogVerdict(
  stillNonImmersive: boolean,
  arSupported: boolean | null,
): LaunchWatchdogVerdict {
  if (!stillNonImmersive) return "silent";
  return arSupported === true ? "declined-toast" : "fallback";
}

export type EnterHeadsetAction = "exit-xr" | "launch-xr" | "unsupported-hint";

/** ENTER HEADSET — exit when immersed, launch when AR is plausible, otherwise
 * say calmly that no AR-capable headset was detected (instead of a dead click). */
export function enterHeadsetAction(s: XrLaunchState): EnterHeadsetAction {
  if (s.immersed) {
    return "exit-xr";
  }
  if (s.xrPresent && s.arSupported !== false) {
    return "launch-xr";
  }
  return "unsupported-hint";
}
