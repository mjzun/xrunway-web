// Pure HUD state predicates — extracted so the settings / scrub / snap-turn visibility
// rule (REVIEW-FINDINGS H4, M5, L13) is a single source of truth AND unit-testable
// without a DOM / Three harness. HUDSystem feeds its live state in; the test feeds a
// truth table.

export interface SettingsVisibilityState {
  /** The trainee has opened the settings panel. */
  settingsOpen: boolean;
  /** Mapping mode — "off" means not mapping; anything else means mapping owns the panel. */
  mapMode: string;
  /** Lesson phase — settings only shows in a non-walking phase. */
  phase: string;
  /** HUD panel not hidden by the B-button toggle. */
  hudVisible: boolean;
  /** In an immersive XR session (the panel + scrub are XR-only). */
  inXR: boolean;
}

/** True iff the settings panel is ACTUALLY visible + interactive to the trainee. The
 * thumbstick scrub and the snap-turn pause key off this — NOT raw `settingsOpen` — so
 * the stick can't mutate the runway shape while the panel is hidden by a walk starting,
 * MAP opening, a B-button hide, or XR exit, and snap-turn always resumes when the panel
 * goes away (it can't get stuck stopped). */
export function settingsPanelShown(s: SettingsVisibilityState): boolean {
  return (
    s.settingsOpen &&
    s.mapMode === "off" &&
    (s.phase === "idle" || s.phase === "brief" || s.phase === "summary") &&
    s.hudVisible &&
    s.inXR
  );
}

/**
 * True while virtual WALK locomotion (slide + teleport) must be paused: an
 * XR GRADED WALK is in flight — countdown (the trainee walks out to the
 * start line) or walk (the scored pass). The Quest tester's "throws you off
 * the runway": IWSDK's stick locomotion moves world.player under a PHYSICAL
 * walk — a left-stick brush slides the rig (5 m/s), a right-stick down-flick
 * teleports — sweeping the runway out from under the trainee and corrupting
 * every world-frame metric. XR-only: in the browser the W/A/S/D walk IS
 * slide locomotion, and the Preview Walk manages its own pause.
 *
 * EMULATED sessions are exempt (founder repro 2026-07-10: "can no longer
 * move in the headset - WASD falls out the moment the walk begins"): the
 * IWER-emulated headset (laptop ENTER HEADSET on the shared link, the dev
 * preview) has no physical walk — IWER maps WASD/the DevUI sticks onto the
 * emulated thumbstick, so slide locomotion is the ONLY way a laptop viewer
 * can move down the runway. The pause protects a PHYSICAL walk's metrics;
 * on a real Quest (IWER never installs — the OculusBrowser UA exception)
 * `emulated` is false and the tester's fix applies unchanged.
 */
export function walkLocomotionPaused(
  phase: string,
  inXR: boolean,
  emulated: boolean,
): boolean {
  return (
    inXR && !emulated && (phase === "countdown" || phase === "walk")
  );
}

/**
 * True while SNAP TURN must be paused. Three claims on the same right
 * stick, one writer (the HUD reconciler): (1) everything walk-locomotion
 * pauses (a snap turn pivots the rig about the XR ORIGIN, not the head — at
 * the end of a runway it throws the deck sideways under the trainee, ~2.1 m
 * on a 3 m runway); (2) an in-flight settings size scrub; (3) the mapping
 * ADJUST step, whose width nudge reads the same stick (a full tilt used to
 * BOTH set the width and yank the room 45 degrees). A finished walk
 * (summary, not scrubbing, not mapping) leaves the stick free to look
 * around and find the parked panel.
 */
/**
 * True while the mapping flow OWNS the panel (any non-"off" mode: placing
 * the start/end or the adjust step). Two inputs defer to it (the tester's
 * mid-mapping booby traps, 2026-07-09): the RIGHT-B panel toggle — hiding
 * the panel mid-flow leaves the state machine running headless (invisible
 * prompts, un-clickable CANCEL/CONFIRM) — and the LEFT X/Y fit-to-room arm,
 * whose landed fit force-cancels the in-flight mapping and discards the
 * placed points. CANCEL/CONFIRM remain the only exits while mapping.
 */
export function mapFlowActive(mapMode: string): boolean {
  return mapMode !== "off";
}

export function snapTurnPaused(
  phase: string,
  inXR: boolean,
  scrubbing: boolean,
  mapMode: string,
  emulated: boolean,
): boolean {
  // The scrub + mapping-adjust claims stay EVEN in an emulated session:
  // they are same-stick input conflicts (the right stick scrubs a size /
  // nudges the width), just as real on a laptop as on a Quest. Only the
  // physical-walk pause is emulation-exempt.
  return (
    walkLocomotionPaused(phase, inXR, emulated) ||
    (inXR && scrubbing) ||
    (inXR && mapMode === "adjust")
  );
}
