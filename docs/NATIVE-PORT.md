# (X)RUNWAY — Native Port Plan

The shipping product goes **native**: a native Quest app and native iOS, because
native unlocks the **Quest Passthrough Camera API** and **iPhone ARKit/LiDAR/body
tracking** that the WebXR sandbox cannot reach (see `docs/SENSORS.md`). This web
app (IWSDK / WebXR / TypeScript, this repo) stays the **pitch prototype** and the
**source of truth for the logic** being ported. The algorithms and the wire
protocol below must match the web sources **exactly**.

> **Source-of-truth files** (port faithfully — the projection math is unit-tested):
> `src/runway-layout.ts`, `src/show.ts`, `src/metrics.ts`, `src/external-tracker.ts`,
> `src/pose-ingest.ts`, `src/shaders.ts`, `vite.config.ts` (relay), `docs/SENSORS.md`,
> `docs/SPEC-REV2.md`, `docs/SPEC-REV3.md`.

---

## 1. Recommendation

**Build the MAIN app once in Unity 6 + AR Foundation + Meta XR (OpenXR).**
**Build the tripod companion natively in Swift + ARKit. Keep the web app as the pitch prototype.**

| Decision | Choice | Why |
|---|---|---|
| Main app engine | **Unity 6 (6000.4.1f1, already installed) + AR Foundation 6 + URP** | One project → both targets. AR Foundation abstracts plane detection, raycast, session lifecycle across Quest **and** iOS. |
| Quest XR | **Meta XR SDK over OpenXR** (Meta XR Core + Mixed Reality Utility Kit) | Passthrough, plane detection, controller/hand input, **Passthrough Camera API** for on-headset CV later. |
| iOS XR | **ARKit via AR Foundation (ARKitXRPlugin)** | LiDAR plane/mesh, world tracking; body tracking via direct `ARKit` API if needed. |
| Rendering | **URP** | ShaderGraph/HLSL for the live floor; one render path for both platforms; Quest perf knobs. |
| Tripod companion | **Native Swift + ARKit/Vision** (`native/ios-companion/`) | The companion's whole reason to exist is the sensors WebXR can't touch: ARKit world-space body tracking + LiDAR. Tiny app, no engine needed. Streams the shared `PoseFrame`. |
| Pitch prototype | **This web app, unchanged** | Runs in any browser, no install, no signing — best for demos/investors. Remains logic source of truth. |

**Why Unity over fully native-native (Quest OpenXR C++ + Swift/RealityKit twice):**

- **One codebase, two stores.** Native-native means writing the catwalk, floor
  shader, audience, HUD, and show logic **twice** (Android/C++ for Quest, Swift for
  iOS). Unity writes it **once**.
- **The team already has Unity 6 installed** (`/Applications/Unity/Hub/Editor/6000.4.1f1`).
  Zero new toolchain for the main app.
- **Speed to a shippable build.** AR Foundation + Meta XR give passthrough,
  plane detection, and input out of the box; native-native rebuilds all of that.
- **The C# core is engine-agnostic.** The logic ports to plain C# (no `UnityEngine`
  dependency) so it stays unit-testable exactly like the TS originals.

Native-native is the *theoretical* max-performance path (no engine overhead, smallest
binary). It is the wrong trade for a small team chasing a pitch-to-product timeline.
**Revisit only if** Unity passthrough latency or Quest frame budget proves
unacceptable in Phase D profiling.

---

## 2. What native unlocks vs the web sandbox

Tie-back to `docs/SENSORS.md` — the web stack's hard ceilings, and what native removes:

| Capability | Web / WebXR (this repo) | Native (Unity + Swift) |
|---|---|---|
| Quest passthrough **camera frames** (on-headset CV) | ❌ Not exposed to WebXR | ✅ **Passthrough Camera API** (Meta XR, native Android) |
| iPhone **LiDAR / ARKit reconstruction** | ❌ Native iOS only; Safari has no WebXR | ✅ ARKit scene depth + mesh via AR Foundation |
| iPhone **body tracking** (world-space skeleton) | ❌ | ✅ ARKit `ARBodyTrackingConfiguration` (3D joints in meters) |
| Floor / boundary recognition | ✅ WebXR plane detection (already used by auto-map) | ✅ AR Foundation `ARPlaneManager` (same idea, richer) |
| Secure-context / mixed-content limits | ⚠️ `getUserMedia` needs HTTPS; relay needs WSS over LAN | ✅ **None** — native apps aren't browser-sandboxed; **plain `ws://` over LAN is fine** |
| Head / controllers / hands | ✅ WebXR | ✅ Meta XR / OpenXR |

The big three: **(a)** on-headset CV becomes possible; **(b)** the iPhone companion
streams **calibrated world-space meters** instead of normalized image coords (the app
side is unchanged — see §5); **(c)** the LAN relay sheds all the HTTPS/WSS friction
that `docs/SENSORS.md` calls out as the web companion's main deployment pain.

---

## 3. Module-by-module migration map

Status legend: **✅ ported** = a C# file exists in `native/unity/Assets/XRunway/Core`
· **🟡 in progress** = scaffold started · **TODO** = not begun. The C# **Core** is
plain C# (no `UnityEngine`) so it is unit-testable like the TS originals; the Unity
**MonoBehaviour/system** layer adapts it to the engine.

| Web file / system | What it does | Unity equivalent | Layer | Status | Difficulty |
|---|---|---|---|---|---|
| `src/runway-layout.ts` (`RunwayLayout`, `RunwayProjector`, `layoutFromEndpoints`, `sanitizeLayout`, `poseAlong`/`startAlong`, `loadLayout`/`saveLayout`) | Editable runway model + along/lateral projection (**unit-tested**) | `Core/RunwayLayout.cs` + `RunwayProjector` struct; persistence via `PlayerPrefs`/JSON | Core | **TODO** | **Low** — pure scalar math, port 1:1; keep frame convention (yaw 0 → forward −Z, +lateral +X) |
| `src/show.ts` (`ShowDirectorSystem`, phase machine, energy lerp, weights, monotonic clamp) | idle→brief→countdown→walk→summary; publishes walkProgress/walkRemaining/summary | `Core/ShowDirector.cs` (logic) + `Unity/ShowDirectorBehaviour.cs` (drives from head transform) | Core + Unity | 🟡 (`ShowTypes.cs` enums/structs exist) | **Low–Med** — delta-accumulated timers; no `setTimeout`; same constants |
| `src/metrics.ts` (`MetricsSystem`, 7 metrics, `METRIC_PASS=78`, ring buffers, pose + head paths) | Derives M1–M7 from head motion (+ optional pose stream) | `Core/Metrics.cs` (`deriveFromHead`/`deriveFromPose`) + `Unity/MetricsBehaviour.cs` | Core + Unity | **TODO** | **Med** — port EMAs/ring buffers verbatim; preallocate (no GC in `Update`) |
| `src/external-tracker.ts` (`ExternalTracker`, staleness, `PoseFrame`/`PoseKeypoint`) | Ingest seam + freshness | `Core/ExternalTracker.cs` + `Core/PoseFrame.cs` | Core | **TODO** (Swift side `PoseFrame.swift` exists) | **Low** |
| `src/pose-ingest.ts` (`connectPoseRelay`, ws, restamp-to-local-clock, backoff reconnect) | Relay client | `Unity/PoseRelayClient.cs` (`System.Net.WebSockets.ClientWebSocket` or NativeWebSocket) | Unity | **TODO** | **Med** — restamp `frame.t` to local clock; identical reconnect backoff |
| `vite.config.ts` `poseRelay()` (broadcast relay, port 8082) | Dumb broadcast relay (dev) | Standalone relay service (keep Node, or a tiny Go/C# binary) — **not in Unity** | Service | **TODO** | **Low** — protocol is trivial; one service serves web+iOS+Unity |
| `src/shaders.ts` `FLOOR_FRAG` + `createLiveFloorMaterial` + `ShaderTimeSystem` | Live-floor warp-lines; feeds uTime/uEnergy/uProgress/uStepTime/uStepZ | URP **HLSL** `LiveFloor.shader` (or ShaderGraph) + `Unity/ShaderDriver.cs` | Shader + Unity | **TODO** | **Med–High** — GLSL→HLSL port (see §4); preserve uniform contract |
| `src/shaders.ts` `CHASE_*` (edge strips), `FLASH_*` (camera flashes) | Deck edge comet chase; audience paparazzi `Points` | URP HLSL materials; flashes via particle/`Points`-equivalent | Shader + Unity | **TODO** | **Med** |
| `src/stage.ts` (`createStage`, deck, footprints, audience InstancedMesh, truss, spot, `StageMoodSystem`, `FootprintGlowSystem`, `MapPreviewSystem`) | Layout-driven set built in runway-local space; relayout on `runwayLayout` | Unity prefabs + `Unity/StageBuilder.cs` (parametric on length/width) + mood/footprint MonoBehaviours; `GameObject.SetActive` for map preview | Unity | **TODO** | **High** — most art/geometry; rebuild-on-layout-change; GPU instancing for audience |
| `src/mapping.ts` (`MappingSystem`, walk-and-place, reticle ray∩floor, `autoMapFromFloor` via XRPlane) | Map-runway state machine + plane-detection auto-fit | `Core/MappingStateMachine.cs` + `Unity/MappingBehaviour.cs` (AR Foundation `ARRaycastManager` / `ARPlaneManager`) | Core + Unity | **TODO** | **Med–High** — input + AR plane query are engine-specific |
| `src/hud.ts` + `ui/lesson.uikitml` + `lesson.json` | First-person coaching HUD panel, Follower behavior, metric bars/checkboxes, countdown | **UI Toolkit** (`UIDocument` + USS/UXML) on a world-space panel; `Unity/HudController.cs` | Unity UI | **TODO** | **Med** — rebuild layout in UXML; bind to show signals |
| `src/landing.ts` + `index.html` (glass landing, runway editor sliders) | DOM pitch/landing + desktop runway editor | **Stays web** (pitch). In-app equivalent = a Unity UI Toolkit settings panel (sliders → `RunwayLayout`) | Web / optional Unity | **N/A (web stays)** | **Low** (optional Unity editor panel) |
| `src/music.ts` (`MusicSystem`, synth house, look-ahead scheduler) | Fully synthesized 122 BPM bed, phase choreography | Unity audio: either port the WebAudio graph to a DSP/`OnAudioFilterRead` synth, **or** bounce stems and sequence them | Unity | **TODO** | **Med** — easiest win is pre-rendered stems + a C# scheduler |
| `src/theme.ts` (`BRAND`, `STAGE`, `LESSON` constants) | Brand colors + stage dimensions + copy | `Core/Theme.cs` (consts) + a Unity color/material palette | Core | **TODO** | **Low** |
| `src/walker.ts` (`WalkerSystem`, digital mannequin) | **REV2-deprecated** — not registered in `index.ts`; "trainee IS the model" | **Do not port** (drop). Optionally revive only for a 3rd-person spectator mode | — | **DROP** | — |
| `index.ts` (world bootstrap, globals, system registration, AR session config) | App composition root | Unity scene + bootstrap MonoBehaviour + XR Origin / session config | Unity | **TODO** | **Med** |

**Currently on disk** (sibling agents are populating these directories — this doc owns
only itself):
- `native/unity/Assets/XRunway/Core/ShowTypes.cs` — 🟡 `ShowPhase` enum + `MetricSnapshot`/`ShowSummary` structs (engine-agnostic, mirrors `src/show.ts`).
- `native/ios-companion/Sources/PoseFrame.swift` — ✅ wire contract ported 1:1 from `src/external-tracker.ts` (ARKit world-space mode + Vision normalized fallback).

---

## 4. The live-floor shader (GLSL → Unity)

`src/shaders.ts` `FLOOR_FRAG` is the founder's warp-lines reference, moved onto the
**deck top**. Port it to URP — **HLSL `.shader`** is the faithful path (ShaderGraph
can't express the periodic ring loop cleanly); use ShaderGraph only if a designer must
tweak it visually.

**Keep the uniform contract identical** (these names are the integration seam between
the shader and the show logic):

| Uniform | Source (TS) | Meaning | Unity wiring |
|---|---|---|---|
| `uTime` | `ShaderTimeSystem`, wrapped `% 3600` | wrapped seconds | `material.SetFloat("_Time01", t)` (avoid Unity's built-in `_Time`; pass your own **wrapped** value so ripple-age `mod()` stays correct) |
| `uEnergy` | `globals.showEnergy` (lerped) | 0 house → 1 full show | `SetFloat("_Energy", …)` |
| `uProgress` | `globals.walkProgress` | −1 outside walk, else 0..1 round-trip | `SetFloat("_Progress", …)` |
| `uStepTime` | `globals.lastStep.time` wrapped; −1 = none | last footstrike clock | `SetFloat("_StepTime", …)` |
| `uStepZ` | `globals.lastStep.z` = **along fraction 0..1** | strike position deck-local | `SetFloat("_StepZ", …)` |

Porting notes (mechanical, GLSL → HLSL):

- `varying vec2 vUv` → `struct Varyings { float2 uv … }`; `vUv` from the deck plane's
  UVs. **UV contract is load-bearing:** `uv.x` spans deck **width**, `uv.y` runs the
  **walk axis**, 0 = near edge, 1 = far end. A Unity quad rotated `-90°` about X maps
  the same way — verify orientation on import.
- `fract`→`frac`, `mix`→`lerp`, `mod(a,b)`→`fmod` (or `a - b*floor(a/b)` for negatives),
  `gl_FragColor`→`return half4(col,1)`. `clamp`/`smoothstep`/`exp`/`length`/`step` are
  identical.
- Inline the brand palette as `static const float3` (same hexes as `GLSL_BRAND`):
  `C_BG #0a0c10`, `C_NAVY #060f1b`, `C_ACCENT #4b9cd3`, `C_ACCENTSOFT #8ec4e8`,
  `C_ACCENTDEEP #2f7cb3`, `C_WHITE #f2f5f8`.
- Inject `DECK_W`/`DECK_L`/`START_T`/`POSE_T`/`T_WRAP` as **shader properties** (set from
  `RunwayLayout` so the floor re-fits a remapped runway), not string-interpolated consts
  as in TS. `T_WRAP` must equal the driver's wrap modulus (3600).
- The ripple **age** must stay wrap-safe: `age = fmod(uTime - uStepTime + T_WRAP, T_WRAP)`.
- Loop budget unchanged: 3 channels × 5 taps = 15 — fine for the Quest fragment budget.
- **`ShaderDriver.cs`** replaces `ShaderTimeSystem`: each frame peek energy/progress,
  compute wrapped time + step sentinel (TTL 2 s → −1), and push to the floor + chase +
  flash materials. Same `STEP_TTL`/`TIME_WRAP` logic.

Chase strips and camera flashes port the same way (`CHASE_*`, `FLASH_*`); the flash cloud
becomes a particle system or a custom-mesh `Points` equivalent with the per-point `aRand`
attribute preserved.

---

## 5. Data continuity — one protocol across web, iOS, Unity

`PoseFrame` + the relay protocol are **shared verbatim** so the browser companion, the
Swift companion, and Unity all interoperate **during the whole transition** (web demo and
native build can even run side by side off one relay).

**Relay protocol** (from `vite.config.ts` + `src/pose-ingest.ts`):

- Peers connect to the relay: **`ws://<host>:8082`** over LAN. Native apps aren't
  browser-sandboxed, so **plain `ws://` is fine — no HTTPS/WSS needed** (this is one of
  native's wins, §2).
- On connect, send `{"type":"hello","role":"sender"|"receiver","source":"…"}`.
- Senders stream `{"type":"pose","frame":PoseFrame}`. The relay rebroadcasts each message
  to all **other** peers (dumb broadcast).
- Receivers **restamp** `frame.t` to their **local clock** on arrival (cross-device clock
  skew); keep the sender's stamp on `sentT` for latency inspection. Reconnect with
  backoff 1.5 s → 15 s. (Port `connectPoseRelay` semantics 1:1 into `PoseRelayClient.cs`.)

**`PoseFrame`** (from `src/external-tracker.ts`):

```jsonc
{
  "t": 1234567.8,            // ms, capture time in the SENDER's clock
  "source": "iphone-arkit",  // label
  "keypoints": {             // sparse map name -> {x,y,z,score}
    "nose": { "x": …, "y": …, "z": …, "score": 0.9 },
    "leftShoulder": { … }, "rightShoulder": { … },
    "leftHip": { … }, "rightHip": { … },
    "leftKnee": { … }, "rightKnee": { … },
    "leftAnkle": { … }, "rightAnkle": { … }
  }
}
```

Keypoint names are **exactly** these nine. Coordinate spaces (the consumer,
`MetricsSystem.deriveFromPose`, must agree with the producer):

- **Browser companion** → normalized image coords (0..1, y **down**), z = relative depth
  (the existing side-camera derivation).
- **Native ARKit companion** → **world-space meters** (right-handed, +y up) — calibrated;
  `docs/SENSORS.md` calls this "strictly better." The app side is unchanged.
- **Vision 2D fallback** (when ARKit body tracking is unavailable) → normalized image
  coords like the browser, so the side-camera path still works.

> The Unity Core's `ExternalTracker`/`Metrics` must accept **both** spaces, exactly as the
> TS `deriveFromPose` does today (normalized vs world). Staleness window `STALE_AFTER_SEC =
> 0.6` is part of the contract — keep it.

---

## 6. Phased plan

Effort is rough (one experienced Unity dev; the founder validates each gate). The C# Core
ports can proceed **in parallel with, and ahead of, the Unity art** because Core has no
engine dependency and is unit-testable.

### Phase A — Core + first-person rig + live floor  ·  ~1–2 wks
- Port Core: `RunwayLayout`/`RunwayProjector`, `ShowDirector`, `Theme` consts, `PoseFrame`,
  `ExternalTracker`. Unit-test the projector + state machine against the TS expectations.
- Unity: XR Origin (Meta XR + AR Foundation), passthrough on Quest, head-driven
  `ShowDirectorBehaviour`. Port the live-floor HLSL (§4) + `ShaderDriver`.
- **Validate:** put on the Quest, see the live floor on the real floor, energy ramps with
  the phase machine, walkProgress tracks your head down-and-back.

### Phase B — Audience + mapping + plane detection  ·  ~2–3 wks
- Unity: `StageBuilder` (deck/footprints/audience-instanced/truss/spot), parametric on
  layout; relayout on layout change. Chase strips + camera flashes.
- Mapping: `MappingStateMachine` (Core) + AR Foundation raycast reticle + walk-and-place;
  `autoMapFromFloor` via `ARPlaneManager` (Quest **and** iOS).
- **Validate:** walk-and-place a runway on your real floor; whole set re-fits; auto-fit
  snaps to the detected floor plane.

### Phase C — Metrics + relay + companion  ·  ~2–3 wks
- Port `Metrics` Core (head + pose paths, ring buffers, `METRIC_PASS=78`). HUD in UI
  Toolkit bound to the show signals. `PoseRelayClient` in Unity.
- Stand up the relay service (reuse the Node relay or a tiny binary). Finish the **Swift
  ARKit companion** (`native/ios-companion/`): body tracking → world-space `PoseFrame` →
  relay. Vision 2D fallback.
- **Validate:** full M1–M7 scoring during a walk; iPhone-on-tripod streams a skeleton; HUD
  flips to camera-derived metrics when the stream is fresh, falls back when stale.

### Phase D — Polish + store  ·  ~2–4 wks
- Music (stems or DSP synth), map-preview overlay, summary card, perf passes (72–90 fps on
  Quest), iOS LiDAR depth occlusion. Signing, store assets, Meta + App Store submission.
- **Validate:** end-to-end run on real hardware; frame budget held; store builds pass.

---

## 7. Honest constraints

- **The C# Core is logic-validated-by-porting, not yet compiled.** It mirrors the TS
  source structurally; it has **not** been run through the Unity compiler or unit tests in
  this environment. First task in Phase A is to compile + run the ported projector/state-
  machine tests against the TS expected values.
- **Building Quest/iOS requires the Unity Editor + (for iOS) Xcode + device signing** —
  **none of which is doable in this web sandbox.** This sandbox has Unity 6 installed
  (`6000.4.1f1`) but **no Xcode** detected; the iOS build leg needs Xcode + an Apple
  Developer account on the dev machine. Quest builds need the Android module + a developer-
  unlocked headset (or Link).
- **Passthrough Camera API + ARKit body tracking are device-only.** They cannot be
  exercised in-editor without the headset / iPhone; budget device time each phase.
- **The relay is currently a dev-only Vite plugin** (`vite.config.ts`). Production needs a
  standalone relay service (trivial — same protocol). Same-LAN assumption holds for the
  tripod use case; a hosted relay (WSS) is only needed for remote/over-internet sessions.
- **Music is the loosest port.** The WebAudio synth graph (`src/music.ts`) has no direct
  Unity analog; the pragmatic path is pre-rendered stems + a C# look-ahead scheduler that
  mirrors the phase choreography, accepting it won't be sample-identical.
- **`src/walker.ts` is intentionally dropped** (REV2 killed the digital mannequin; not
  registered in `index.ts`). Don't port it unless a spectator mode is added later.

---

### Checklist (start here)

- [ ] Compile + unit-test Core `RunwayProjector` and `ShowDirector` against TS expectations.
- [ ] Stand up the standalone relay (port 8082, plain `ws://`); confirm web ↔ Unity ↔ Swift all interop on one relay.
- [ ] Live-floor HLSL parity check vs `FLOOR_FRAG` (uTime/uEnergy/uProgress/uStepTime/uStepZ; wrapped time; ripple age `fmod`).
- [ ] Head-driven walkProgress matches `show.ts` (down 0→0.5, back 0.5→1, monotonic clamp, finish conditions).
- [ ] Metrics M1–M7 parity vs `metrics.ts` (EMAs, ring buffers, `METRIC_PASS=78`, head + pose paths, both coord spaces).
- [ ] Swift ARKit companion streams world-space `PoseFrame`s; Unity flips to camera-derived + falls back at `STALE_AFTER_SEC=0.6`.
