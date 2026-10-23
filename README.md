# (X)RUNWAY

> Public copy of the (X)RUNWAY web prototype, published for Matthew Jay Zuniga's portfolio (mjzun.github.io). Product, business, and testing documents and the full commit history are kept private.

**Training. Confidence. One headset at a time.**

**Live demo:** https://startling-moxie-143212.netlify.app

Source is shared for viewing. See LICENSE: all rights reserved.

A first-person AR **runway-walk training simulator**. The trainee physically walks
their own floor while AR overlays a runway, stage lighting, and a digital audience,
and an AI coach scores posture, pace, rhythm, and footwork in real time — building
confidence one walk at a time.

This repository is the **web prototype** (Meta Immersive Web SDK / WebXR / three.js /
TypeScript / Vite), built for UNC course EDUC 761 — the runs-anywhere build and the source
of truth for the product logic. The **native** path
(Unity for Quest + iOS, plus a native iPhone ARKit camera companion) is scaffolded and
planned in [`docs/NATIVE-PORT.md`](docs/NATIVE-PORT.md).

---

## What it does

- **Map your runway** — set length, width, rotation, and position with on-screen sliders,
  or walk-and-place it in the headset (mark your start, walk, mark the end). The whole set —
  deck, live floor, footprints, audience, lighting — re-fits live. Persists across reloads.
- **Walk it, first person** — brief → 3-2-1 countdown → walk → scored summary. A live
  AI-coach HUD shows seven metrics (M1–M7) with pass checkboxes and a TIME countdown.
- **Real scoring** — pace, posture, rhythm, and footwork are derived from real motion
  (headset head-tracking, or a connected camera). Composites roll up into an overall score
  with a "vs last walk" delta.
- **Capture the data** — every walk is recorded as a 6 Hz metric time-series + summary,
  exportable as **CSV / JSON** (the coaching/agency value). Walk history persists.
- **Preview Walk** — a one-click hands-free auto-pilot that walks the runway and back so you
  can demo the whole experience with no headset.
- **External body tracking (Phase 2)** — an iPhone on a tripod (native ARKit, world-space)
  or a browser webcam (MediaPipe, 2D) streams a skeleton over a relay for higher-fidelity
  pace/posture/stride. The headset/laptop shows a live **CAMERA** indicator.

## Run it

```bash
npm ci
npm run dev            # app on http://localhost:8081  (+ pose relay on :8082)
```

- **HTTPS (for a real Quest over LAN, or a phone browser):**
  `XRUNWAY_HTTPS=1 npm run dev` (accept the one-time macOS CA prompt). HTTPS is opt-in so the
  default dev flow never trips it. See [`docs/SENSORS.md`](docs/SENSORS.md).
- **Camera companion (browser):** open `/companion/` on a phone (needs HTTPS / a tunnel).
- **Camera companion (native iOS, best):** [`native/ios-companion/BUILD-WALKTHROUGH.md`](native/ios-companion/BUILD-WALKTHROUGH.md).

```bash
npm test               # vitest — unit tests for the core logic, then the golden-vector drift check
                       # (the drift check reads `git rev-parse HEAD`, so run it inside a git checkout)
npm run build          # production build
```

## Architecture (web)

ECS systems on IWSDK (elics) + reactive signals (`@preact/signals-core`), state shared on
`world.globals`. One concern per file:

| Module | Role |
|---|---|
| `src/theme.ts` | Brand (Carolina Blue) + stage layout constants |
| `src/runway-layout.ts` | `RunwayLayout` model + `RunwayProjector` (world↔runway-local math, unit-tested) + persistence |
| `src/shaders.ts` | Live-floor warp shader, edge chase, camera-flash points, `ShaderTimeSystem` |
| `src/stage.ts` | The set: deck, footprints, pose mark, audience, truss/spot, `StageMood`/`FootprintGlow` |
| `src/show.ts` | `ShowDirector` state machine (idle→brief→countdown→walk→summary), energy, scoring |
| `src/metrics.ts` | AI-coach metrics from head motion + camera pose (image / world) |
| `src/mapping.ts` | Walk-and-place + plane-detection auto-map + floor reticle |
| `src/demo-walk.ts` | `DemoWalkSystem` — the hands-free Preview Walk |
| `src/modes.ts` | The four training modes (copy, pacing, weighting) |
| `src/session-recorder.ts` | Walk capture + CSV/JSON export + history |
| `src/external-tracker.ts` + `src/pose-ingest.ts` | Pose relay client + `ExternalTracker` |
| `src/music.ts` | Synthesized 122 BPM track (WebAudio, no assets) |
| `src/hud.ts` + `ui/lesson.uikitml` | In-headset lesson HUD |
| `src/landing.ts` + `index.html` | The glassmorphism landing / pitch surface |
| `vite.config.ts` | Dev server + the pose relay (port 8082) |

**Design constraints:** zero external 3D/audio assets (all procedural), zero per-frame
allocation in update loops, Quest 72fps draw-call budget, `npx tsc --noEmit` clean.

## Docs

- [`docs/SENSORS.md`](docs/SENSORS.md) — what's reachable from WebXR vs native; the Phase-2 pipeline + how to run the companion.
- [`docs/NATIVE-PORT.md`](docs/NATIVE-PORT.md) — the Unity (Quest + iOS) migration plan + module map.
- [`docs/CALIBRATION.md`](docs/CALIBRATION.md) — phone↔runway alignment design.
- [`docs/SOLO-MODE.md`](docs/SOLO-MODE.md) — the phone-only Solo Mode design and TS→Swift port spec.
- [`docs/CURRICULUM-DESIGN.md`](docs/CURRICULUM-DESIGN.md) and [`docs/EDGE-ROADMAP.md`](docs/EDGE-ROADMAP.md) — the training curriculum and the metrics/feature roadmap.
- Research summaries: [`RESEARCH-runway-pace-bpm.md`](docs/RESEARCH-runway-pace-bpm.md), [`RESEARCH-runway-instruction.md`](docs/RESEARCH-runway-instruction.md), [`RESEARCH-replay-ghost.md`](docs/RESEARCH-replay-ghost.md), [`RESEARCH-ghost-visual.md`](docs/RESEARCH-ghost-visual.md), [`RESEARCH-webxr-panel-rendering.md`](docs/RESEARCH-webxr-panel-rendering.md).
- [`docs/SPEC.md`](docs/SPEC.md), [`SPEC-REV2.md`](docs/SPEC-REV2.md), [`SPEC-REV3.md`](docs/SPEC-REV3.md) — build specs.
- [`public/methodology.html`](public/methodology.html) — the in-app scoring methodology page.
- `native/` — the iOS ARKit companion (Swift) and the engine-agnostic Unity C# core.

*EDUC 761 · Matthew Jay Zuniga*
