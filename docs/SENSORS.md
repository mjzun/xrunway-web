# (X)RUNWAY — Sensor & data-source reality (web stack)

Honest capability map for collecting real-world data, so the roadmap is grounded.
The app is **web/WebXR** (Quest Browser + desktop). That dictates what's reachable.

## Available NOW (in this stack)

- **WebXR plane detection / mesh detection** — the floor plane and the user's
  Quest space/room boundaries are queryable in the browser. This is how the
  headset "recognizes the runway/boundaries." Used by the **auto-map** assist
  (`mapping.ts`) to fit/center the runway to the detected floor.
- **Head + controllers + hands** (WebXR) — drives the first-person walk and the
  head-derived metrics today.

## NOT reachable from WebXR (need a native companion)

- **Quest passthrough cameras** — Meta's Passthrough Camera API is **native-only**
  (Unity/native Android). WebXR does not expose raw passthrough frames, so we
  cannot run computer vision on the headset's own cameras in the browser.
- **iPhone LiDAR / ARKit scene reconstruction** — **native iOS only**, and Safari
  ships no WebXR. An iPhone cannot feed LiDAR/ARKit data to a web page directly.

## The right architecture for "data from outside the headset" (Phase 2)

An **external pose tracker**: a phone/webcam (an iPhone on a tripod, a laptop cam,
multiple cameras) runs a pose model and **streams a skeleton** into the experience.

- On-device CV options: browser **MediaPipe / TensorFlow.js (BlazePose, MoveNet)**
  on the phone's camera in a normal browser tab — no native app required for a v1;
  or a small native app if we later want ARKit body tracking / LiDAR depth.
- Transport: WebSocket / WebRTC / BroadcastChannel from the companion to the
  headset session. Multiple cameras → multi-view fusion for occlusion-robust pace
  and posture.
- Integration point already in the codebase: **`src/external-tracker.ts`**
  (`ExternalTracker`, installed on `world.globals.externalTracker` +
  `window.xrunwayTracker`). A companion calls `tracker.push(poseFrame)`;
  `MetricsSystem` prefers fresh external data and falls back to head-only when
  absent. Building the companion capture page is the Phase-2 task.

## Summary

| Want | Path |
|---|---|
| Headset knows the floor/boundaries | ✅ WebXR plane detection (now) |
| CV on Quest cameras | ❌ native-only; use plane detection instead |
| iPhone LiDAR into the app | ❌ native iOS app required |
| iPhone/webcam pose for pace/posture | ✅ external pose tracker → `ExternalTracker` (Phase 2) |

## Phase 2 pipeline — BUILT (companion pose tracker)

The external-tracker pipeline is implemented and verified end-to-end (synthetic):

```
 companion camera page            pose relay            headset/app
 public/companion/index.html  ──►  ws://host:8082  ──►  src/pose-ingest.ts
 (MediaPipe BlazePose,            (vite plugin in       → ExternalTracker
  image-space landmarks,          vite.config.ts,         → MetricsSystem
  PoseFrame @ ~20-30 Hz)          dumb broadcast)          (pace/posture/rhythm/
                                                            footwork; falls back
                                                            to head-only when stale)
```

- **Relay**: `poseRelay()` in `vite.config.ts`, port **8082**, runs inside `npm run dev`.
- **App ingest**: `connectPoseRelay()` (`src/pose-ingest.ts`) — restamps frames to the
  local clock (cross-device skew), pushes to `ExternalTracker`. Auto-reconnects;
  non-fatal when no companion is present.
- **Metrics**: `MetricsSystem.deriveFromPose()` uses normalized image-space landmarks
  (side-camera setup — the body translates across frame). Sets `globals.trackerActive`.
  A "CAMERA — <source> — <fps>" pill shows on the landing while a stream is live.

### Enabling HTTPS (for real Quest + phone browser)

HTTPS is **opt-in** so the everyday `npm run dev` never trips the mkcert CA-install sudo
prompt (and the preview tooling stays happy). Enable it with:

```bash
XRUNWAY_HTTPS=1 npm run dev      # first run: enter your macOS password ONCE (trusted CA)
```

- **Real Quest walk-through:** with HTTPS on, open `https://<your-mac-LAN-ip>:8081/` in the
  Quest Browser and Enter XR. (Quest needs a secure context for WebXR over LAN.) This is the
  fastest way to walk the current web build on-device before the native port lands.
- **Browser companion on a phone:** the phone's camera (`getUserMedia`) needs a secure context
  AND the relay must be `wss` (no mixed content). The clean path is a **tunnel**
  (cloudflared/ngrok) that gives a trusted cert and forwards both the page and the relay —
  mkcert's CA isn't trusted on an arbitrary phone. (The **native** iOS companion avoids all of
  this: native apps aren't browser-sandboxed, so it uses plain `ws://<lan-ip>:8082` directly —
  see `native/ios-companion/` and `docs/NATIVE-PORT.md`.)

### Run the browser companion

1. `XRUNWAY_HTTPS=1 npm run dev` (app on `:8081`, relay on `:8082`).
2. On the phone, open **`https://<mac-LAN-ip>:8081/companion/`** (or the tunnel URL) → START CAMERA.
3. Stand so the camera sees you from the side; walk. The app shows the live CAMERA pill and the
   metrics switch to camera-derived.

### Native upgrade (the real product, per founder direction)

This browser companion proves the pipeline and runs today. Going native unlocks the
sensors the web sandbox can't reach — and it plugs into the **same** `ExternalTracker`
protocol (`PoseFrame` over the relay), so the app side does not change:

- **iOS app (ARKit)**: body tracking + LiDAR depth → world-space skeleton (precise,
  calibrated pace/stride). Replaces the browser companion as a `PoseFrame` source.
- **Quest native app (Passthrough Camera API)**: on-headset CV, if ever desired.
- Multiple cameras (the tripod idea) → multi-view fusion, same protocol, more accuracy.

The current pose-derived scores are **camera-relative and uncalibrated** (single side
camera, normalized coords) — directionally correct and responsive, but absolute accuracy
needs the camera's pose relative to the mapped runway, which native world-space tracking
provides for free.
