# (X)RUNWAY — REV3: Live Runway Mapping

**Adds to REV2 (docs/SPEC-REV2.md); both still apply. REV3 wins on conflict.**

## Goal (founder feedback)

"A big part of this project is allowing the floor to be edited and adapt to the
user's real-life runway — live mapping." (X)RUNWAY's licensing tier is "map your
unique runway." So the runway must become **editable and adaptive**: the user
maps it onto their real floor and the whole stage re-fits.

Chosen interaction (founder): **Walk & place ends** (AR) + **straight rectangle**.
Plus a desktop edit path (sliders) for the pitch/emulator, and a **plane-detection
auto-map** assist as the first step toward camera/boundary recognition
(see docs/SENSORS.md).

## Foundation (ALREADY WRITTEN — import, do not redefine)

`src/runway-layout.ts`:
- `interface RunwayLayout { centerX; centerZ; yaw; length; width }`
- `DEFAULT_LAYOUT` (reproduces REV2 exactly), `LAYOUT_LIMITS`, `POSE_INSET=0.6`,
  `START_INSET=0.15`, `poseAlong(layout)`, `startAlong()`, `sanitizeLayout`,
  `layoutsEqual`, `layoutFromEndpoints(sx,sz,ex,ez,width)`,
  `class RunwayProjector { set(layout); along(px,pz); lateral(px,pz); alongFraction(px,pz); length; width }`,
  `loadLayout()`, `saveLayout(layout)`. Frame: yaw 0 = walk toward -Z, +lateral = +X.
  **The projection math is unit-tested — trust it; use RunwayProjector verbatim.**

`src/external-tracker.ts`: `ExternalTracker`, `installExternalTracker(globals)`,
`PoseFrame`. (Phase-2 seam; MetricsSystem may consult it but head-only is the
shipping path.)

## Globals REV3 (integrator owns index.ts)

```ts
g.runwayLayout = signal<RunwayLayout>(loadLayout());  // THE editable model
g.mapMode      = signal<MapMode>("off");              // "off"|"placing-start"|"placing-end"|"adjust"
g.reticle      = null; // plain { x:number; z:number } | null — live floor cursor during mapping
// REV2 globals unchanged (showPhase/showEnergy/walkProgress/walkRemaining/lastStep/metrics/summary/showControls)
```

`ShowControls` REV3 = `{ beginWalk(): void; reset(): void; startMapping(): void;
setLayout(p: Partial<RunwayLayout>): void; commitLayout(): void; autoMapFromFloor(): void }`.
(ShowDirector still owns beginWalk/reset; mapping methods delegate to MappingSystem
via a second registered controls object OR ShowDirector calls into globals — keep
it simple: MappingSystem assigns `g.mapControls` = `{ startMapping, cancelMapping,
placePoint, setWidth, autoMapFromFloor }` and the UI uses both. Final shape is the
agent's call as long as HUD + landing can: start mapping, see prompts, and on
desktop adjust length/width/position/rotation + save.)

## Module reworks (one agent per group, disjoint files)

### Agent STAGE — `src/stage.ts`
Make the set **layout-driven**. Read `globals.runwayLayout`:
- Build all set geometry under the stage root in runway-LOCAL space (runway center
  at local origin, forward = local -Z, so `root.position=(centerX,0,centerZ)` and
  `root.rotation.y = yaw` place it). Deck length/width, footprint spacing+count,
  pose-mark position (local z = +(length/2 - POSE_INSET) ... derive from along via
  `poseAlong`), audience rows, edge strips, shadow catcher all parametric on
  length/width.
- The live-floor plane stays `createLiveFloorMaterial()` + ShaderDriven; its UVs
  are local so they ride the root transform — but its WIDTH/LENGTH scale must match
  the layout (scale the plane / rebuild).
- **Relayout on change:** subscribe to `runwayLayout` (cleanupFuncs). Position+yaw
  are a cheap root-transform update. Length/width change = rebuild the
  layout-dependent children (dispose old, build new) — mapping is a discrete
  action, rebuild cost is fine. Keep marker-component + qualify/replay pattern for
  StageMoodSystem/FootprintGlowSystem so they re-acquire refs after a rebuild.
- StageMoodSystem spotlight still tracks `this.player.head`; that's world-space, no
  change needed. Pose-mark + footprint logic that referenced world DECK_* must now
  go through layout/local space.
- **Map preview:** when `globals.mapMode != "off"`, render a translucent layout
  outline + the two end markers + a floor reticle at `globals.reticle` (if set), so
  the user sees the runway forming as they place points. A light, cheap overlay
  (lines/rings). Hide it when mapMode == "off".
- Carolina Blue throughout. No per-frame alloc. Zero banned tokens.

### Agent WALK — `src/show.ts`, `src/metrics.ts`, `src/shaders.ts`
Project the head into the MAPPED runway frame instead of hard-coded world Z.
- Both ShowDirectorSystem and MetricsSystem hold a `RunwayProjector`, subscribe to
  `globals.runwayLayout` (cleanupFuncs) to call `projector.set(layout)`, and in
  update() compute `along = projector.along(head.x, head.z)` and
  `lateral = projector.lateral(head.x, head.z)`.
- show.ts: replace the Z-based progress with along-based:
  `down = (along - startAlong()) / (poseAlong(layout) - startAlong())` mapped 0..0.5;
  reachedMark when `along >= poseAlong - MARK_RADIUS`; finish when reachedMark and
  `along <= startAlong + FINISH_RADIUS`. Keep monotonic clamp, timers, energy,
  summary exactly as REV2. (Cache poseAlong/startAlong on layout change.)
- metrics.ts: `footPlacement` from `Math.abs(lateral)` (not `head.x`). `pace` can
  stay total horizontal speed. `globals.lastStep.z` must now be the **along
  FRACTION** `projector.alongFraction(head.x, head.z)` (0..1), since the floor
  shader consumes a deck-local fraction.
- shaders.ts: ShaderTimeSystem currently converts `lastStep.z` (world z) to
  deck-local. Change it to treat `lastStep.z` as the already-0..1 fraction
  (drop the world conversion / DECK_NEAR_Z import if now unused). Floor visuals
  unchanged otherwise. (Optional: also let MetricsSystem prefer
  `globals.externalTracker.latest()` when fresh — but head-only must remain correct
  and is the shipping path; only add if cheap and safe.)

### Agent MAPPING — `src/mapping.ts` (NEW)
`export class MappingSystem` (+ any small marker component it needs).
- Owns `globals.mapMode`, `globals.reticle`, and assigns a controls object for the
  UI (e.g. `globals.mapControls = { startMapping, cancelMapping, placePoint(),
  setWidth(w), nudge(dimChanges), autoMapFromFloor, commit, cancel }`). It also
  fulfils the REV3 ShowControls mapping methods OR the integrator wires them — keep
  the API documented in the file header.
- **Walk-and-place flow (AR):** startMapping → "placing-start": a floor reticle
  follows the controller ray hit on the floor (or, lacking a ray, the head's
  ground projection). `placePoint()` (controller trigger / A button) drops the
  start; → "placing-end": reticle continues, second `placePoint()` drops the end →
  build `layoutFromEndpoints(start, end, width)` as a DRAFT and go "adjust";
  width via thumbstick or default. Confirm commits: `runwayLayout.value = draft;
  saveLayout(draft)`. Cancel restores prior.
- **Reticle source:** prefer an XR controller ray vs the floor plane y=0
  (intersect ray with y=0 — simple, robust, no hit-test needed). In browser (no
  controllers) the desktop editor drives layout directly, so the reticle path can
  no-op gracefully when no XR input is present. Zero per-frame alloc (preallocated
  Vector3/Ray scratch).
- **autoMapFromFloor():** query WebXR floor info. Re-enabled features give
  `XRPlane` entities (IWSDK scene understanding) — find the floor plane, and
  fit/center the runway to its extent (clamp to LAYOUT_LIMITS). If no plane data is
  available, log once and leave the layout unchanged (graceful). Verify the XRPlane
  API against @iwsdk/core .d.ts; if plane entities aren't trivially available,
  implement the method to degrade to a sensible default-centered layout and note it.
- Respect CLAUDE.md (cleanupFuncs, no polling where a subscribe fits, etc.).

### Agent HUD-UI — `src/hud.ts`, `ui/lesson.uikitml`, `index.html`, `src/landing.ts`
- HUD (`hud.ts` + `lesson.uikitml`): add a **MAP RUNWAY** button in the footer/brief
  that calls startMapping; while `mapMode != "off"` show a mapping panel state with
  the current prompt ("STAND AT YOUR START — PRESS TRIGGER", "WALK TO THE END —
  PRESS TRIGGER", "WIDTH: RIGHT STICK — LOCK IN: A OR CONFIRM" since the
  2026-07-09 tester fix) driven by `globals.mapMode`. ASCII
  punctuation only. Keep all REV2 HUD hardening + the Follower behavior.
- Landing (`index.html` + `landing.ts`): add a **glass "RUNWAY" editor card**
  (desktop/pitch path, and the only way to test mapping in the emulator since you
  can't physically walk): sliders/handles for LENGTH, WIDTH, ROTATION, and
  POSITION (X/Z), reading+writing `globals.runwayLayout` (debounced, change-gated;
  call `saveLayout` on release), a "MAP RUNWAY (HEADSET)" button (startMapping),
  an "AUTO-FIT TO FLOOR" button (autoMapFromFloor), and a "RESET RUNWAY" (DEFAULT_LAYOUT).
  Live values shown (e.g. "7.0 m x 1.4 m"). Carolina Blue, glassmorphism, all the
  existing landing patterns (defensive lookups, reduced-motion, body.immersed hide).
  Don't break existing BEGIN WALK / summary wiring.

## Integration (integrator owns index.ts)
Create the REV3 globals, `installExternalTracker(g)`, re-enable
`xr.features: { handTracking, layers, planeDetection: true, hitTest: true }` +
`features.sceneUnderstanding: true` (auto-map needs floor planes; accept the Quest
permission prompt — now justified by a consuming feature), register MappingSystem
(priority ~5, before metrics), keep the rest. Build stage AFTER globals exist.

## Law (unchanged)
CLAUDE.md anti-patterns, zero external assets, zero per-frame allocation, draw-call
budget, `npx tsc --noEmit` clean, panel font ASCII-punctuation only, Carolina Blue
(no pink). Verify in the emulator: editing the landing sliders must visibly re-fit
the deck/footprints/audience/pose-mark live, and a walk after remapping must still
score (along/lateral correct).
