# (X)RUNWAY — REV2: First-Person Training Simulation

**This addendum OVERRIDES docs/SPEC.md wherever they conflict.** Read both; REV2 wins.

## What changed and why (founder feedback — verbatim intent)

The v1 build was a third-person *demo show* (autonomous walking mannequin, LED wall,
"PLAY DEMO"). That is wrong. (X)RUNWAY is a **completely AR, first-person experience**:
**the trainee IS the model.** They physically walk their real floor while AR overlays the
runway, audience, lighting, and a coaching HUD. The hand-drawn sketch is **the HUD the
trainee sees** (lesson header, instruction box with quote, metrics M1–M7 with CHECKBOXES,
NAME/ID#, TITLE, TIME, LOCATION: AR). There is **no demo mode, no digital walker model,
no LED wall** at this stage. This is the go-to-market training simulator.

## Brand REV2

- **Kill ALL pink.** The accent is **Carolina Blue `#4B9CD3`** (UNC's official web hex,
  Pantone 542 C). `src/theme.ts` is already updated: `BRAND.accent / accentSoft /
  accentDeep`, CSS twins in `BRAND_CSS` (the `pink*` keys NO LONGER EXIST — update every
  reference, including inlined GLSL palette vec3s and any CSS variable names like
  `--xr-pink` → `--xr-accent`).
- Stage black is now cool-toned (`#0a0c10`). White `#f2f5f8`, silver `#8a8f96`.

## Scene REV2 (theme.ts layout is updated — import, don't re-derive)

- **Deck = thin floor overlay** (0.02 m), flush with the real floor — the trainee walks ON
  it (their real floor). NOT a raised platform. Top surface at `DECK_TOP_Y`.
- **The deck's top surface IS the live shader** (see Shaders below). The user's words:
  "the effect on the screen is cool, but I need that to instead be reflected on the
  floor. the floor should be live and adaptive."
- **REMOVED ENTIRELY:** LED wall, wall frame + trim, portal door-light bars, backstage
  step. Nothing stands at the far end except a **pose mark** — an elegant (X) floor
  marker at `POSE_MARK_Z` (emissive Carolina Blue, readable from 7 m).
- **Footprint guides: HIGH-FIDELITY SHOE PRINTS, not ovals.** Draw a proper footprint
  silhouette on a canvas alpha texture (heeled-pump sole: separate front sole + heel
  block, soft glow edge) and instance it down the walk path, alternating L/R (mirror X),
  toe-out a few degrees, stride-spaced (~0.62 m), on the center line (cross-step: lateral
  offset ±0.02). They brighten as the trainee approaches/passes (FootprintGlow keyed to
  `walkProgress`).
- **Audience: HIGH-FIDELITY, not bland placeholders.** The reference bar is the Spline
  component aesthetic the founder linked (premium dark 3D). Without external asset
  downloads, this means properly *modeled procedural humans*: build 3–4 distinct seated
  pose variants (e.g. upright attentive · leaning forward elbows-on-knees · legs-crossed
  · phone-raised-filming), each a SINGLE merged BufferGeometry (head with neck, shoulders,
  bent arms with hands, torso with chest/waist shaping, bent seated legs with feet —
  ~600-900 tris per variant). One InstancedMesh PER VARIANT (3-4 draw calls), per-instance
  dark-outfit color variation via instanceColor, deterministic seat jitter. Plus one
  InstancedMesh of small emissive phone screens (cool white-blue) aligned to the
  phone-raised variant's hands. Materials: clothing-like (roughness .8) with subtle
  clearcoat on a few instances. This must read as a real fashion-show crowd in
  silhouette, lit by the floor glow.
- Keep: audience risers, truss + fixtures, ONE SpotLight + ONE HemisphereLight,
  shadow-catcher fade plane (resize to the flat deck), edge light strips (chase shader,
  recolored).
- **Spotlight follows THE TRAINEE** (`this.player.head` world position, preallocated
  vectors, exp-smoothed) during the walk; slow sweep when idle.
- **StageMoodSystem/FootprintGlowSystem must use the marker-component + qualify/replay
  pattern** (like ShaderTimeSystem) — no module-scope refs singleton this time.

## Shaders REV2 (`src/shaders.ts`)

- `createLEDWallMaterial` is GONE. New export: **`createLiveFloorMaterial(): ShaderMaterial`**
  — the founder's warp-lines shader (same reference GLSL as v1: concentric `fract(t…)/
  length(uv)` ring taps, mosaic cell quantization) **adapted to the runway floor**, in
  Carolina Blue family (deep navy floor → blue lines → white-hot cores). Plane UVs map
  the 1.4×7 m deck top; respect the aspect (long axis = walk axis). Uniforms:
  - `uTime`, `uEnergy` (as before),
  - `uProgress` (float — `walkProgress` global: -1 outside a walk, else 0..1 round-trip),
  - `uStepTime` + `uStepZ` (last footstrike: seconds timestamp + deck-local 0..1 along
    length) → an expanding ripple ring radiating from each strike, fading ~1.2 s.
  - "Adaptive": a soft radial glow tracks the trainee's position along the deck during
    the walk (derive from uProgress folding down-and-back), lines energize around them.
  Idle: slow, dim, elegant. Walk: full motion. Must stay cheap (Quest fragment budget;
  ≤ ~15 ring taps as in v1).
- `createChaseStripMaterial`, `createCameraFlashMaterial`: keep, recolor (blue chase,
  cool-white flashes).
- `ShaderTimeSystem`: now ALSO feeds `uProgress` (peek `globals.walkProgress`) and
  `uStepTime`/`uStepZ` (read `globals.lastStep` plain ref `{ time, z } | null`; convert
  z to deck-local 0..1) to materials that declare those uniforms. Same zero-alloc cache
  pattern; only write uniforms that exist on each material.

## Global state REV2 (created in index.ts — integrator handles)

```ts
g.showPhase = signal<ShowPhaseValue>("idle");   // unchanged
g.showEnergy = signal(0);                        // unchanged
g.walkProgress = signal(-1);   // RENAMED from walkerProgress — THE TRAINEE's round-trip
                               // progress (0..0.5 walk down, 0.5..1 walk back), -1 outside walk
g.walkRemaining = signal(-1);  // NEW — seconds left in the walk (60 → 0), -1 outside walk
g.lastStep = null;             // NEW — plain mutable ref { time: number; z: number } | null
                               // (world z of last footstrike; written by MetricsSystem)
g.metrics = signal<MetricSnapshot | null>(null); // unchanged
g.summary = signal<ShowSummary | null>(null);    // unchanged
g.showControls = null;         // ShowControls — REV2 shape (below)
// REMOVED: demoMode, walkerProgress, walkerFocus
```

## Direction REV2 (`src/show.ts`, `src/metrics.ts`, `src/music.ts`)

- `ShowControls` is now `{ beginWalk(): void; reset(): void }` — **playDemo is GONE.**
- `ShowDirectorSystem`: phases idle → brief (3.2 s) → countdown (3 s) → walk → summary.
  The WALK is the trainee's: each update, read `this.player.head` world position;
  - publish `walkProgress`: leg 1 = how far down (start `START_LINE_Z` → `POSE_MARK_Z`)
    mapped 0..0.5; after the trainee has reached the pose mark (within 0.4 m), leg 2 =
    return progress mapped 0.5..1. Clamp monotonically (no jitter backwards > 0.05).
  - publish `walkRemaining` = LESSON.walkSeconds − elapsed (≥ 0).
  - finish on round-trip complete (reached mark AND back within 0.4 m of start line)
    OR at LESSON.walkSeconds. Then freeze summary exactly as v1 (weights unchanged).
  - No walker cue (walker.ts is deleted). Keep energy targets as v1.
- `MetricsSystem`: trainee head-derivation ONLY (delete the demo simulation path).
  Keep pace/rhythm/posture/footPlacement derivations + composites; additionally, on each
  detected bob footstrike, write `globals.lastStep = { time, z }` (reuse ONE mutable
  object — do not allocate per strike) with the head's current world z.
  Export `METRIC_PASS = 78` — the checkbox threshold the HUD/landing use.
- `MusicSystem`: unchanged behavior (it keys off phases/energy; no demo references).

## HUD REV2 (`ui/lesson.uikitml` + `src/hud.ts`) — THE SKETCH, faithfully

Layout per the founder's hand sketch (this is the product's core UI):
- **Header row:** left `MATT — ID 001` (NAME/ID#), center `LESSON 01` + title box
  `BEGINNER WALK` (TITLE), right `TIME` box (id `time-box`): shows `60S` and counts down
  during the walk (subscribe `walkRemaining`, update on integer change only).
- **Instruction box** (brief): LESSON.instruction + quote line (ASCII quotes only —
  the panel font has NO `·`, `—`, `“`, `”` glyphs. Hyphens and straight quotes only).
- **Metrics M1–M7** (live section): each row = `M{n}` chip + label + bar track/fill +
  value + **CHECKBOX** (id `m{n}-check`): a small square that flips from empty (dark,
  thin border) to filled Carolina Blue when the live value ≥ METRIC_PASS. Import
  METRIC_PASS from "./metrics.js" in hud.ts (uikitml gets both states pre-styled;
  hud.ts toggles via setProperties backgroundColor/borderColor — verify supported props).
- **Footer:** `LOCATION: AR` (left) + buttons: `begin-button` (BEGIN WALK, Carolina
  pill), `reset-button`, `xr-button`. **No demo button.**
- Summary section: as v1 (overall, delta, s1–s7 + checks final state), ASCII-safe.
- `HUDSystem` REV2: keep all v1 fixes (cleanupFuncs, replayExisting, Interactable gating,
  null-clear). NEW: in XR the panel **follows the trainee** — add IWSDK's `Follower`
  component (target `world.player.head`, `FollowBehavior.PivotY`, offsetPosition
  ~[0, -0.12, -1.05], maxAngle ~28, speed ~1.2) when entering XR; remove it / restore the
  fixed spatial placement when leaving. Verify the Follower component API against
  @iwsdk/core .d.ts before use. Buttons stay XR-gated. Countdown + TIME both tick.

## Landing REV2 (`index.html` + `src/landing.ts`)

- **Carolina Blue everywhere pink was** (CSS vars renamed `--xr-accent*`; conic score
  ring, chips, bullets, buttons, glow shadows). DOM may keep proper typography (· — “”).
- **PLAY DEMO is GONE** (button, wiring, copy). Primary CTA = **BEGIN WALK** (gated as
  v1: launches XR when NonImmersive; the in-headset HUD takes it from there). Keep RESET,
  ENTER HEADSET. `again-btn` re-runs beginWalk via the same gate.
- Copy reframe: this is a first-person training simulator — e.g. kicker stays
  "THE CONCEPT"; replace any "watch the show / demo" implications: "Walk it yourself.
  The AI coach scores every step." USER FLOW steps stay (they already describe the real
  flow). Lesson card: keep "Ready, Matt?" + meta + BEGIN WALK.
- Live strip: add TIME countdown chip (subscribe `walkRemaining`) + per-metric checkbox
  dots that fill at METRIC_PASS (import it). Summary card unchanged structurally.
- Keep: glassmorphism language, floating shapes + sweep (recolored), reduced-motion,
  `body.immersed` hiding, defensive lookups, change-gated DOM writes.

## Deletions (integrator handles)

- `src/walker.ts` deleted. No module may import it.
- All `demoMode` / `walkerFocus` / `walkerProgress` / `playDemo` references must be gone
  repo-wide.

## Unchanged law

CLAUDE.md anti-patterns, zero external assets, zero per-frame allocation, draw-call
budget (audience ≤ 5 draw calls total incl. phones), `npx tsc --noEmit` clean, panel
font is ASCII-punctuation-only.
