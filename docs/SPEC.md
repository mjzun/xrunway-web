# (X)RUNWAY — Build Spec v1 (go-to-market prototype)

**Product:** (X)RUNWAY — an AR runway-training experience (IWSDK / WebXR, Quest + browser).
**Tagline:** TRAINING. CONFIDENCE. ONE HEADSET AT A TIME.
**Pitch headline:** "Train like you're *already on the runway.*"

A Meta Quest & iOS AR experience that overlays a live runway, stage lighting, and a digital
audience on any room. An AI coach analyzes posture, pace, and rhythm in real time — building
confidence one walk at a time.

This build is the **pitchable demo**: a browser landing page (glassmorphism, dark + hot pink)
over the live 3D scene, and the AR experience itself with a full demo show:
brief → countdown → walk (digital model walks the catwalk with music, LED wall, spotlights,
camera flashes, live metric feed) → scored summary.

**This is a REAL product demo, not a toy. Every module must be production-quality.**

---

## Non-negotiable engineering rules

1. Read `CLAUDE.md` at repo root BEFORE writing code. Its anti-pattern list is law:
   - Import Three.js types from `@iwsdk/core`, NEVER from `three`.
   - No allocations in `update()` — preallocate in `init()` as class fields.
   - Use queries, not stored entity arrays. Subscribe (`qualify`/`disqualify`), don't poll.
   - `cleanupFuncs.push(...)` for every subscription.
   - `signal.peek()` in update loops, `.value`/`.subscribe` elsewhere.
   - `world.createTransformEntity(obj, { parent })` — never `scene.add()`.
   - `entity.dispose()` (not `destroy()`) for GPU-resource entities.
2. **Zero external assets.** No downloads, no GLTF, no audio files. Everything is procedural:
   primitive geometry, canvas-generated textures, ShaderMaterial, WebAudio synthesis.
3. **Performance budget (Quest AR, 72fps):** ≤ 45 draw calls total. Audience = 1 InstancedMesh.
   Footprints = 1 InstancedMesh. Camera flashes = 1 Points. Max 2 real dynamic lights
   (1 SpotLight + 1 ambient/hemisphere). Everything else emissive/unlit. No per-frame
   material/geometry creation. Mosaic shaders must be cheap (no heavy loops > ~15 iterations).
4. TypeScript strict; the project must pass `npx tsc --noEmit`. You may run it; IGNORE
   "Cannot find module './<sibling>.js'" errors for modules owned by other agents (parallel
   build), but fix every error inside YOUR files.
5. ESM imports between src files use `.js` extension (e.g. `./theme.js`).
6. `src/theme.ts` already exists (do not modify) — import `BRAND`, `BRAND_CSS`, `STAGE`,
   `DECK_NEAR_Z`, `DECK_FAR_Z`, `DECK_CENTER_Z`, `DECK_TOP_Y`, `WALL_Z`, `LESSON` from it.

---

## Brand & art direction

- Stage-black world (`BRAND.bg` #0a0709), hot-pink accent (`BRAND.pink` #ff2e63), white text.
- Fashion-editorial: think Vogue × Apple Vision. Pink is used SPARINGLY — accents, glows,
  the (X), active states. Most surfaces are near-black, glossy, with silver/white rims.
- Typography (DOM only): italic serif for emotional words ("already on the runway."),
  letterspaced uppercase mono/sans for labels ("LESSON 01 — BEGINNER WALK").
- The e-ink sketch + prior mockup define the layout: lesson header, instruction box with a
  quote, metric checkboxes (M1–M7), runway V with footprints, "digital people."

## Stage layout (from theme.ts — do not re-derive)

- Viewer at origin facing -Z. Deck: 1.4m wide × 7m long × 0.12m tall, near edge at z=-1.1.
- LED wall at z = WALL_Z (≈ -8.55), 4.2m × 2.7m.
- Audience risers both sides at x = ±1.65, 2 rows × 9 seats.
- Spot truss at y = 2.75.

---

## Global state contract (created in src/index.ts BEFORE systems register — already handled)

```ts
import { signal } from "@preact/signals-core";
g = world.globals as Record<string, unknown>;
g.showPhase = signal<ShowPhaseValue>("idle");   // "idle"|"brief"|"countdown"|"walk"|"summary"
g.showEnergy = signal(0);          // 0 house-lights → 1 full show; ShowDirector lerps it
g.walkerProgress = signal(-1);     // -1 no walker, else 0..1 down-and-back progress
g.demoMode = signal(false);        // true when PLAY DEMO (autonomous walker), false = user walk
g.metrics = signal<MetricSnapshot | null>(null);  // live during walk, ~6Hz
g.summary = signal<ShowSummary | null>(null);     // set when phase → summary
g.walkerFocus = null as unknown;   // Object3D | null — set by WalkerSystem each frame (plain ref, not signal)
g.showControls = null;             // ShowControls — set by ShowDirectorSystem.init()
```

Types (declared in `src/show.ts`, imported by others):

```ts
export type ShowPhaseValue = "idle" | "brief" | "countdown" | "walk" | "summary";
export interface ShowControls {
  playDemo(): void;   // autonomous digital model walks; music + lights + simulated metrics
  beginWalk(): void;  // trainee mode: brief → countdown → walk (user walks in XR; demo walker hidden)
  reset(): void;      // back to idle, music fades, energy → 0
}
export interface MetricSnapshot {
  pace: number; posture: number; rhythm: number; presence: number;
  footPlacement: number; confidence: number; presentation: number; // all 0..100
}
export interface ShowSummary {
  scores: MetricSnapshot;
  overall: number;            // 0..100 weighted
  deltaVsLast: number | null; // vs previous run this session, null first time
  durationSec: number;
}
```

`signal` import: `import { signal, type Signal } from "@preact/signals-core";` (dependency exists).

---

## Module contracts (one agent per module — write EXACTLY these exports)

### A. `src/shaders.ts` — shader suite (LED wall, chase strips, camera flashes)

The user supplied a reference fragment shader (concentric "warp" line rings with mosaic
pixelation and RGB channel offsets — see below). **Iterate on it, make it brand-correct and
BETTER**: tint to pink/magenta/white on near-black, add subtle scanlines + vignette so it
reads as a giant LED wall, keep motion hypnotic and fashion-show-worthy. It must look superb
both idle (slow, dim) and at full energy (faster, brighter) via a `uEnergy` uniform.

Reference shader core (adapt; use vUv-based coords, uniform names below):

```glsl
// rings: color[j] += lineWidth*float(i*i) / abs(fract(t - 0.01*float(j)+float(i)*0.01) - length(uv));
// mosaic: uv = floor(uv * cells) / cells;  // LED pixel grid
```

Exports:

```ts
import { ShaderMaterial, type World } from "@iwsdk/core";
export function createLEDWallMaterial(): ShaderMaterial;
// uniforms: { uTime: {value:number}, uEnergy: {value:number} }  (0..1 energy)
export function createChaseStripMaterial(): ShaderMaterial;
// deck edge light strips: animated pink light "chase" running toward the LED wall,
// uniforms: { uTime, uEnergy }; at energy 0 a dim slow breathe, at 1 a fast chase.
export function createCameraFlashMaterial(): ShaderMaterial;
// for THREE.Points over the audience: random per-point blink (use a per-point aRand attribute),
// white flashes, frequency scales with uEnergy (0 → none, 1 → paparazzi storm).
// uniforms: { uTime, uEnergy }. Set transparent, depthWrite false, additive blending.
export const ShaderDriven: Component; // createComponent("ShaderDriven", {})
// Tag component. Add to every entity whose mesh material has uTime/uEnergy uniforms.
export class ShaderTimeSystem extends createSystem({ driven: { required: [ShaderDriven] } }) {}
// update(): for each driven entity, set material.uniforms.uTime.value = time and
// uniforms.uEnergy.value = (globals.showEnergy as Signal<number>).peek(). Zero alloc.
// Works for Mesh AND Points (cast object3D children or the object itself; entity.object3D
// may be a Group — traverse ONCE in a qualify subscription and cache material refs in a
// Map<index, ShaderMaterial[]> field, cleared on disqualify).
```

Quality bar: the LED wall is the visual signature of the whole product. Spend effort.
Energy must visibly transform it. Add a faint (X) motif moment if you can do it tastefully
in pure GLSL (e.g. periodic crossing diagonal beams), but never kitsch.

### B. `src/stage.ts` — the set (deck, strips, wall, truss, audience, flashes, spotlight)

```ts
export function createStage(world: World): Entity; // returns root entity; everything parented under it
export class StageMoodSystem extends createSystem(...) {}
// Tracks globals.showEnergy: house ambiance ↔ show ambiance.
// - Spotlight (1 real SpotLight) intensity/color; aims at globals.walkerFocus (Object3D)
//   when set, else sweeps slowly across the deck. Preallocate Vector3s.
// - Deck material emissive subtle pink pulse at high energy (cheap: emissiveIntensity).
```

Build (all primitives/canvas textures; parent under one root entity; use sub-entities via
`world.createTransformEntity(mesh, { parent: root })` so everything is ECS-managed):

1. **Deck**: glossy near-black box (MeshPhysicalMaterial: roughness .12, metalness .55,
   clearcoat 1, clearcoatRoughness .15) at the STAGE dims. Top surface gets a center guide
   line: thin (0.025m) emissive pink strip mesh slightly above the top, full length —
   the "land each step on the line" coach line.
2. **Edge light strips**: 2 thin boxes (0.06m wide, 0.02 tall) running the FULL deck length
   along both top edges, material = `createChaseStripMaterial()` (ONE shared material
   instance for both). Add `ShaderDriven` to their entities.
3. **Footprint guides**: 1 InstancedMesh, ~14 instances (7 L/R pairs) of a flat rounded
   "sole" shape (use a capsule-ish extruded shape or simple rounded plane), laid alternately
   left/right of the center line down the deck, slight outward toe rotation, emissive pink,
   transparent 0.85. Instance colors: use instanceColor to let FootprintGlowSystem brighten
   the pair nearest `globals.walkerProgress` (peek; map progress→deck z→instance index).
   `export class FootprintGlowSystem` — zero-alloc, updates instanceColor only when index
   changes; needsUpdate flags handled correctly.
4. **LED wall**: plane (STAGE.wallWidth × wallHeight) at z=WALL_Z facing +Z (toward viewer),
   material `createLEDWallMaterial()`, entity tagged `ShaderDriven`. Frame it with a thin
   matte-black border box + a 0.02m pink emissive trim line around the inner edge.
   In front of the wall, floor level: a low backstage platform step (entrance) and TWO thin
   white emissive vertical door-light bars where the model enters (portal glow).
5. **Audience**: 1 InstancedMesh of a simple seated-silhouette geometry (merged: box torso +
   sphere head — build one BufferGeometry via two primitives merged, or a single capsule —
   keep ≤ 300 tris/instance), STAGE.audienceRows × audiencePerRow × 2 sides instances,
   matte very-dark material (color #141016, roughness 1). Place on low riser boxes (2 boxes
   per side). Slight random per-instance Y-rotation jitter so it reads organic.
6. **Camera flashes**: 1 THREE.Points spread over audience head-height volume (~80 points),
   material = `createCameraFlashMaterial()`, entity tagged `ShaderDriven`.
7. **Truss + spots**: dark cylinder truss bars above deck at trussY (2 bars across), 3 small
   cone "fixture" meshes per bar with emissive white lens discs — decorative. ONE real
   SpotLight (white, angle ~0.35, penumbra .4) parented near truss center aimed down-deck;
   StageMoodSystem drives it. Plus ONE dim HemisphereLight for base fill — created here.
8. **House glow**: 2 large ultra-dim emissive planes flanking outside audience? Only if
   draw-call budget allows; optional.

In AR the real room is visible — the set must look intentional floating on the floor plane:
add a thin (0.01m) dark "shadow catcher" plane under the deck extending 0.25m beyond its
footprint with radial fade (canvas alpha texture) to seat it visually.

### C. `src/walker.ts` — Digital People (the model + the walk)

```ts
export function createDigitalModel(world: World): Entity;
// Procedural articulated mannequin, ~1.78m tall, warm-ivory showroom material
// (MeshPhysicalMaterial: color #ded2c6, roughness .34, metalness .04, clearcoat .8,
// sheen .6 / sheenColor #ff7aa2, emissive #17080c). CANONICAL — an earlier obsidian
// palette vanished against the black stage; the model must read clearly under the
// spotlight. Faceless ovoid head. Build hierarchy with named
// Groups stored in mesh.userData.rig = { pelvis, spine, chest, head, lThigh, lShin, lFoot,
// rThigh, rShin, rFoot, lUpperArm, lForearm, rUpperArm, rForearm }.
// Elegant proportions (fashion: long legs ~54% of height). ≤ 16 meshes total.
export const Walker: Component;
// createComponent("Walker", { state: Enum(idle|entering|walking|posing|returning|exiting),
//   progress: Float32 (0..1 over the full down-and-back routine), speed: Float32 })
export class WalkerSystem extends createSystem(...) {}
```

WalkerSystem — the heart of the demo. Runway gait quality bar is HIGH:

- Routine (driven by ShowDirector setting state to `entering` when phase→walk & demoMode):
  enter through the portal (fade/scale in is fine) → walk deck length toward viewer along
  the center line → stop 0.55m before deck near-edge → POSE (weight shift onto back hip,
  hand to hip, 1.6s hold, slight chin lift) → sharp 180° turn (0.5s, fashion pivot) →
  walk back → exit portal → state idle, hide.
- Catwalk gait math (procedural, no animation clips): feet land ON the center line
  (cross-step): lateral foot offset = ±0.02 only; hips counter-sway sin(phase)·0.05 rad;
  shoulder counter-rotation; straight support leg at mid-stance; ~1.9 Hz step frequency at
  speed 0.85 m/s; subtle head steadiness (head counter-rotates to stay level). Arms: relaxed
  long swing, elbows slightly back. Use cheap sin/cos phase math on the rig groups —
  preallocate everything in init().
- Each footstrike: pulse `globals.walkerProgress` (set signal value = routine progress) and
  it is ALSO read continuously — set every frame.
- Set `globals.walkerFocus` = chest Group while visible, null when hidden.
- In trainee mode (`demoMode=false`) the digital model stays hidden (the USER walks) —
  WalkerSystem does nothing but keep walkerFocus = null (spotlight then sweeps; metrics
  come from MetricsSystem's head-tracking path).

### D. `src/show.ts` + `src/metrics.ts` + `src/music.ts` — direction, AI-coach metrics, sound

`src/show.ts`:
```ts
export type ShowPhaseValue = ...; export interface ShowControls {...};
export interface MetricSnapshot {...}; export interface ShowSummary {...};  // as above
export class ShowDirectorSystem extends createSystem(...) {}
```
- init(): builds ShowControls object and assigns `globals.showControls`; subscribes own
  timers. playDemo(): demoMode=true → phase brief (3.2s) → countdown (3s) → walk →
  (walker routine ≈ 22s; when walker exits) → summary. beginWalk(): demoMode=false, same
  flow but walk phase lasts LESSON 60s or until reset. reset(): → idle from any phase.
- Lerps `showEnergy` toward target each update (idle .12, brief .35, countdown .6, walk 1,
  summary .45) — exponential ease, zero alloc.
- On summary: freeze metrics into ShowSummary (overall = weighted mean: posture .2 pace .15
  rhythm .15 footPlacement .2 presence .1 confidence .1 presentation .1), compute deltaVsLast
  from previous summary this session, set `globals.summary`.
- Use timers via accumulating delta in update (no setTimeout — must respect ECS pause).

`src/metrics.ts`:
```ts
export const METRICS: ReadonlyArray<{ key: keyof MetricSnapshot; label: string; short: string }>;
// order: posture POSTURE M1, pace PACE M2, rhythm RHYTHM M3, footPlacement FOOTWORK M4,
//        presence PRESENCE M5, confidence CONFIDENCE M6, presentation PRESENTATION M7
export class MetricsSystem extends createSystem(...) {}
```
- Active only during phase walk; publishes `globals.metrics` at ~6 Hz (accumulate dt).
- Demo mode: plausible "AI coach" simulation — each metric = base 62 + slow drift upward
  (improves over the walk) + smooth per-metric noise (sum of 2 sines w/ irrational freqs),
  pace tied to walker speed (peek Walker comp or globals.walkerProgress slope), clamp 40..98.
- Trainee mode (XR): derive pace from real head velocity (player.head world pos delta),
  rhythm from vertical-bob periodicity (zero-crossing interval regularity), posture from
  head-height stability vs session start, footPlacement from lateral deviation from x=0.
  Others = confidence-style composites of the four. Keep ALL of it zero-alloc (preallocated
  Vector3s + small ring buffers as Float32Array fields).
- Snapshot objects: reuse ONE mutable object + publish a NEW shallow copy only at the 6Hz
  tick (allocation at 6Hz is acceptable; per-frame is not).

`src/music.ts`:
```ts
export class MusicSystem extends createSystem(...) {}
```
- Pure WebAudio (no assets): 122 BPM house — kick (sine pitch-drop), offbeat open hat
  (filtered noise), clap layers on 2&4, two-bar sub bass line (A1/F1), airy detuned-saw pad
  through a slow lowpass, sidechain-style gain dip on kicks (gain automation, cheap).
  Scheduler: look-ahead pattern scheduler (setInterval 25ms lookahead 0.1s) started/stopped
  by phase subscription; master GainNode fade in/out 0.8s. Energy (peek showEnergy) maps to
  lowpass cutoff + hat level so idle→walk feels like the doors opening.
- AudioContext created lazily on first user-initiated phase change (browser autoplay rule).
- Countdown phase: metronome-style soft tick each beat, then the beat drops EXACTLY when
  phase enters walk (schedule the drop on the next bar boundary).
- Clean up nodes on stop; no leaks after repeated runs.

### E. `ui/lesson.uikitml` + `src/hud.ts` — spatial lesson HUD (the in-headset UI)

FIRST: read `ui/welcome.uikitml` (syntax sample) AND inspect
`node_modules/@iwsdk/vite-plugin-uikitml/dist/index.js` (+ any parser it imports) to learn
EXACTLY which CSS-ish properties/units the compiler supports (it compiles to
`public/ui/lesson.json`). Do not use unsupported props. Test by checking the build output
parses (run `npx vite build` if needed, or the dev plugin compiles on save — you may run
`node -e` against the plugin to compile once and verify JSON exists).

Panel = the e-ink sketch realized, glass-dark aesthetic (bg #0a0709 with low-opacity look,
thin #f5f2f4-ish border, radius, pink accents — emulate glassmorphism within supported props):

- Header row: "(X)RUNWAY" wordmark text (pink (X), white RUNWAY), right-aligned small
  "LESSON 01 · BEGINNER WALK" + "LOCATION: AR".
- Brief section (id `brief-section`): greeting "Ready, Matt?" (large), lesson meta line
  "60 SECONDS · 42 FOOTSTEPS", instruction box: LESSON.instruction + italic LESSON.quote,
  buttons row: `begin-button` (pink pill, "BEGIN WALK") and `demo-button` ("PLAY DEMO").
- Live section (id `live-section`, hidden initially): 7 metric rows — label (short) left,
  horizontal bar track (dark) with fill div (id `m1-fill`…`m7-fill`, pink) + value text
  (id `m1-val`…) right. Plus big phase line (id `phase-line`): COUNTDOWN 3·2·1 / WALK.
- Summary section (id `summary-section`, hidden): "SCORED SUMMARY" header, overall score
  huge (id `overall-score`), delta line (id `delta-line`, "+6 VS LAST WALK" pink), compact
  7 rows of final scores (ids `s1-val`…`s7-val`), buttons: `again-button` ("WALK AGAIN"),
  `reset-button` ("DONE").
- Footer: `xr-button` ("ENTER XR" / "EXIT TO BROWSER") — keep the existing pattern.

`src/hud.ts`:
```ts
export class HUDSystem extends createSystem(...) {}
```
- Query PanelUI+PanelDocument where config eq "./ui/lesson.json" (same pattern as the old
  src/panel.ts — read it for the document/getElementById/addEventListener/setProperties API).
- Wire buttons → `globals.showControls`. Toggle section visibility on showPhase changes
  (`setProperties({ display: "none" | "flex" })`). Update fills at the metrics signal rate:
  subscribe to `globals.metrics` (NOT per-frame polling); width as percent string.
- Countdown: subscribe phase; during countdown update `phase-line` text each second
  (accumulate dt in update; it's fine for this system to have a small update()).
- Panel placement: created in index.ts (already handled there) — but HUDSystem manages
  ScreenSpace removal in XR: in browser the panel is HIDDEN ENTIRELY (DOM landing covers 2D);
  on Visible (XR) show it floating left of the deck start: position (-1.15, 1.5, -1.6),
  rotated ~25° toward the center line. Subscribe visibilityState; use entity visibility
  (`object3D.visible` via Visibility component if available — check core exports — else
  position far away; prefer the IWSDK `Visibility` component).
- Also wire `xr-button` like the old panel.ts (launchXR/exitXR + label swap).

### F. `index.html` + `src/landing.ts` — the glassmorphism landing (the pitch surface)

This is what investors see first. Recreate the prior mockup faithfully (dark, editorial),
elevated. The provided glassmorphism CSS template is the base vocabulary (blur, rgba borders,
hover lift) — refine it: tighter blur (14px), darker glass (rgba(10,7,9,.55)), 1px borders
rgba(255,255,255,.14), pink glow shadows only on primary actions. Avoid the template's
purple gradient — our backdrop IS the live 3D scene; add floating blurred pink/white shapes
at very low opacity + a slow CSS spotlight sweep overlay (the "Spotlight" idea from the
user's 3D-card template, done in pure CSS).

`index.html` (keep `<div id="scene-container">` + module script):
- Google Fonts: Playfair Display (italic 600/700), Inter (400/500/600), Space Grotesk or
  JetBrains Mono for labels (pick ONE mono).
- Layout (CSS grid, full-viewport overlay `#landing` with pointer-events:none; children that
  are interactive get pointer-events:auto):
  - Top nav glass pill: left "(X)RUNWAY" ((X) in pink), right mono small "EDU AR PROTOTYPE — v0.2".
  - Left column (max 560px): kicker "THE CONCEPT" (mono, pink, letterspaced), H1
    "Train like you're <em class=serif-italic-pink>already on the runway.</em>", body copy
    (the official paragraph above), 4 pink-dot bullets:
    "Real-time AI posture & pace analysis" / "Immersive digital audience & stage lighting" /
    "Progressive lesson structure with metric tracking" / "Modes: Beginner · High-Fashion ·
    Commercial · Challenge".
  - Right column glass card "USER FLOW — One lesson, end to end." with the 4 numbered steps
    (01 pink chips): "Open app: AR scans the room & places the runway" / "Coach briefs the
    lesson & sets the goal" / "Walk: live AI feedback on pace, posture & rhythm" /
    "Scored summary: progress vs last lesson".
    Below: CONTROLS row — `#play-demo` (pink pill, "▶ PLAY DEMO"), `#reset-btn` (glass,
    "RESET"), `#enter-xr` (glass, "ENTER HEADSET").
  - Bottom-center glass "lesson card" (phone-ish, max 360px): mono caps "LESSON 01 —
    BEGINNER WALK", serif "Ready, Matt?" (Matt? in pink italic), meta "60 SECONDS · 42
    FOOTSTEPS", `#begin-walk` pink pill "BEGIN WALK".
  - A live-metrics strip (`#live-strip`, hidden by default): 7 mini bars with labels,
    glass, appears during walk phase, plus `#phase-chip` ("BRIEF"/"3"/"2"/"1"/"WALK"/"SUMMARY").
  - A summary modal-ish glass card (`#summary-card`, hidden): overall score ring (pure CSS
    conic-gradient), delta line, per-metric rows, "WALK AGAIN" `#again-btn` + "DONE" `#done-btn`.
- Responsive: ≤ 900px stacks columns; the 3D canvas always full-bleed behind.
- `prefers-reduced-motion`: disable sweep/float animations.

`src/landing.ts`:
```ts
export function mountLanding(world: World): void;
```
- Grabs elements, wires buttons → `(world.globals.showControls as ShowControls)`;
  `#enter-xr` → world.launchXR().
- Subscribes: showPhase → phase chip text + strip/summary visibility + button disabled
  states; metrics → bar widths/values (string set only when changed); summary → fill
  summary card (score ring via CSS var `--score`).
- visibilityState: hide `#landing` entirely while in XR, restore after.
- All subscriptions returned-unsubscribers collected; expose nothing else.
- Defensive: if an element is missing, log once and continue (never throw).

---

## Integration (handled AFTER your work — do not write src/index.ts)

index.ts will: World.create (ImmersiveAR, offer always, same features as current), init
globals, createStage, createDigitalModel + Walker component, lesson PanelUI entity,
register systems with priorities:
ShowDirector 0 · Walker 10 · Metrics 12 · StageMood 20 · FootprintGlow 21 · ShaderTime 22 ·
Music 30 · HUD 35; then mountLanding(world).

Old `src/robot.ts`, `src/panel.ts`, `src/runway.ts`, `ui/welcome.uikitml` get deleted at
integration. Do not import them.

## Definition of done (per agent)

- Files compile (modulo missing siblings), zero IWSDK anti-patterns, exports EXACTLY match
  the contract (names + signatures), brand constants from theme.ts (no hardcoded colors
  except inside GLSL where you may inline the brand palette as vec3 consts with a comment),
  and a short report: what you built, any contract deviations (should be none), and anything
  the integrator must know.
