# (X)RUNWAY — Native iOS Companion (ARKit)

The **tripod secondary camera** for (X)RUNWAY, gone native. Stand an iPhone on a
tripod, point it at the runway, and it streams a **world-space body skeleton** in
**meters** into the (X)RUNWAY headset app over the pose relay.

This is the native upgrade of the browser companion (`public/companion/index.html`).
The browser companion runs MediaPipe BlazePose and could only produce **2D
normalized image coordinates**. Native ARKit gives **3D world-space joints in
meters** — calibrated and metric — which is what `docs/SENSORS.md` calls
"strictly better." It plugs into the **same** `ExternalTracker` / `PoseFrame`
protocol, so **the app side does not change**.

```
 iPhone (this app)                 pose relay              headset / (X)RUNWAY app
 ARKit body skeleton  ──►  ws://<mac-LAN-ip>:8082  ──►  src/pose-ingest.ts
 → PoseFrame (world m)        (vite.config.ts,           → ExternalTracker
   @ ≤30 Hz                    dumb broadcast)             → MetricsSystem
```

## What it does

- **ARKit body tracking** (`ARBodyTrackingConfiguration`) on A12+ devices: maps
  `ARSkeleton` joints to the contract keypoint names in **world-space meters**,
  `score = 1.0` for tracked joints.
- **Vision fallback** (`VNDetectHumanBodyPoseRequest`) when body tracking is
  unsupported: 2D **normalized** image coords (0..1, y down) — the same space the
  browser companion used, so the app's side-camera derivation still works. The UI
  says explicitly which mode is live.
- **WebSocket streaming** (`URLSessionWebSocketTask`): connects to a configurable
  `ws://<host>:8082`, sends `hello` on open, streams `{type:"pose",frame:…}`
  throttled to **≤30/s**, and **auto-reconnects with backoff** (1s → 15s).
- **SwiftUI UI**: the Liquid Glass Enter screen (hold the orb over the title,
  then a cinematic transition into the camera), a live AR camera view with
  START/STOP, receiver-address + camera-name fields, connection and capture/
  send-rate pills, an on-screen skeleton overlay, live tripod-framing feedback
  ("Move back — feet out of frame") with a setup-tips card, light haptics on
  the enter/START/STOP moments, and a **SECURE** toggle for TLS relays (see
  Pairing below).

## Keypoint mapping (matches the contract exactly)

The wire contract is `PoseFrame = { t, source, keypoints: { name → {x,y,z,score} } }`
(see `src/external-tracker.ts`). Names and ARKit/Vision sources:

| PoseFrame name | ARKit `ARSkeleton.JointName` / model joint | Vision joint |
|----------------|--------------------------------------------|--------------|
| `nose`         | `.head`                                    | `.nose` |
| `leftShoulder` | `.leftShoulder`                            | `.leftShoulder` |
| `rightShoulder`| `.rightShoulder`                           | `.rightShoulder` |
| `leftHip`      | `left_upLeg_joint` (→ `.root` fallback)    | `.leftHip` |
| `rightHip`     | `right_upLeg_joint` (→ `.root` fallback)   | `.rightHip` |
| `leftKnee`     | `left_leg_joint`                           | `.leftKnee` |
| `rightKnee`    | `right_leg_joint`                          | `.rightKnee` |
| `leftAnkle`    | `left_foot_joint`                          | `.leftAnkle` |
| `rightAnkle`   | `right_foot_joint`                         | `.rightAnkle` |

> Coordinate spaces: ARKit mode streams **world meters** (right-handed, +y up).
> Vision mode streams **normalized image coords** (0..1, y down) like the browser.
> The headset re-stamps `frame.t` to its own clock on arrival
> (`src/pose-ingest.ts`), so absolute timestamps don't need to be synchronized.

## Build (XcodeGen — recommended)

Requirements: **macOS with full Xcode 26** (not just Command Line Tools), a
real iPhone/iPad **running iOS 26** (any device that can run iOS 26 has the
A12+ chip ARKit body tracking needs), and an Apple ID for free signing.

```bash
brew install xcodegen          # if needed — or grab a prebuilt release zip
                               # from github.com/yonaskolb/XcodeGen/releases
                               # and run its bin/xcodegen directly (no Homebrew)
cd native/ios-companion
xcodegen generate              # produces XRunwayCompanion.xcodeproj
open XRunwayCompanion.xcodeproj
```

In Xcode:

1. Select the **XRunwayCompanion** target → **Signing & Capabilities**.
2. Pick your **Team** (a free personal team works) and let it auto-manage signing.
   The bundle id is `com.mjzun.xrunway.companion` — change it if it collides.
3. Plug in your iPhone, select it as the run destination.
4. **Run** (⌘R). On first launch, approve the **Camera** and **Local Network**
   prompts.

Target is **iOS 26** (`project.yml` sets `deploymentTarget: 26.0`; the Enter
screen uses iOS 26's native Liquid Glass APIs). ARKit / Vision / SwiftUI ship
with the SDK — there are no third-party dependencies.

### Building without XcodeGen

Create a new **iOS App** (SwiftUI) project in Xcode, delete its generated
`ContentView.swift` / `App.swift`, and drag in **everything under `Sources/`
recursively** — 13 Swift files across `Sources/`, `Sources/Onboarding/`,
`Sources/Theme/`, **plus `Sources/Shaders/SphereLens.metal`** (the Enter
screen's lens shader — the app won't render the orb without it) — and
`Resources/Assets.xcassets` (app icon + launch color). Set the target's
**Info.plist** to `Resources/Info.plist` (or copy its keys — especially
`NSCameraUsageDescription`, `NSLocalNetworkUsageDescription`, and the
`NSAppTransportSecurity` block that permits plain `ws://`), set the deployment
target to iOS 26, and run.

## Pairing with the relay

1. On your Mac, start (X)RUNWAY: `npm run dev`. This serves the app on `:8081`
   **and** runs the pose relay on `:8082` (`poseRelay()` in `vite.config.ts`).
2. Find your Mac's **LAN IP** (System Settings → Network, e.g. `192.168.1.42`).
3. In this app, set **Receiver address (Wi-Fi IP)** to that IP (no `ws://`, no
   port — just the IP; the app adds `ws://…:8082`). Optionally edit **Camera
   name** (default `iphone-arkit`) — it's the label the headset pill shows.
4. Tap **START CAMERA**. The connection pill goes **Connecting… → Connected**.
5. In the headset/app, a `CAMERA · <SOURCE> · <n> FPS` pill appears on the landing
   and the metrics switch to camera-derived while frames are fresh
   (`STALE_AFTER_SEC = 0.6` in `src/external-tracker.ts`).

Both peers must be on the **same LAN**. Native apps aren't browser-sandboxed, so
**plain `ws://` is the default — no HTTPS/TLS needed** (this is the native win
over the browser companion, which required mkcert/HTTPS for camera access).

### The SECURE toggle (wss/TLS)

If the relay serves TLS (the dev server started with `XRUNWAY_HTTPS=1`, i.e. an
mkcert setup), plain `ws://` won't connect. Flip **SECURE CONNECTION** on
(before START — it locks while streaming) and the app dials `wss://<host>:8082`
instead. The toggle must **match the relay**: the connection hints call out a
mismatch in both directions.

TLS trust behavior: in `wss` mode the app **accepts the relay's certificate
without system verification** (`RelayTrustDelegate` in `PoseRelayClient.swift`),
because the dev relay uses a self-signed / mkcert certificate that iOS would
otherwise reject. That is intentionally permissive for a LAN dev endpoint you
dial by IP; a shipping product would pin the relay's certificate instead. Plain
`ws://` never triggers the delegate (no TLS handshake).

## Files

| File | Purpose |
|------|---------|
| `Sources/XRunwayCompanionApp.swift` | `@main` app entry + the Enter→Camera cinematic transition. |
| `Sources/ContentView.swift`         | Capture UI: AR view, START/STOP, fields, status pills, skeleton overlay, framing tip + setup-tips card. |
| `Sources/ARBodyTracker.swift`       | ARKit body tracking + Vision fallback → `PoseFrame`; live framing verdict. |
| `Sources/PoseRelayClient.swift`     | `URLSessionWebSocketTask` client: hello, ≤30/s throttle, backoff reconnect, TLS trust for `wss`. |
| `Sources/PoseFrame.swift`           | `Codable` wire contract (ported 1:1 from `src/external-tracker.ts`). |
| `Sources/Haptics.swift`             | Light-impact haptic helper (enter orb, START/STOP). |
| `Sources/Onboarding/*` (6 files)    | Liquid Glass Enter screen: welcome page, orb, wordmark, lava rim, hint. |
| `Sources/Theme/EnterScreenTokens.swift` | Design tokens for the Enter screen. |
| `Sources/Shaders/SphereLens.metal`  | The orb's refraction-lens shader (required by the Enter screen). |
| `Resources/Assets.xcassets`         | App icon (generated — see `scripts/`) + launch background color. |
| `Resources/Info.plist`              | GENERATED by `xcodegen` from `project.yml` — edit the spec, not this file. |
| `project.yml`                       | XcodeGen spec → `.xcodeproj` (deployment target, bundle id, Info.plist keys). |
| `scripts/generate-app-icon.swift`   | Regenerates the app icon PNG from code (`swift scripts/generate-app-icon.swift`). |

## Caveats

- **A12+ for world-space tracking** — in practice every device that can install
  iOS 26 qualifies. `ARBodyTrackingConfiguration.isSupported` is still checked at
  runtime; where it's false (notably the **Simulator**) the app falls back to
  Vision 2D and labels the mode. Only ARKit mode yields the metric, calibrated
  coordinates the product wants.
- **Front-view skeleton overlay in ARKit mode** is an auto-fit orthographic
  projection of the world joints (for a recognizable stick figure), not a
  perspective re-projection onto the exact camera pixels. The **streamed**
  coordinates are full world meters regardless.
- **Runway-frame calibration is not done here.** The app streams world-space
  meters in ARKit's own session frame; aligning that to the headset's mapped
  runway (so absolute pace/stride is exact) is the integration step
  `docs/SENSORS.md` describes. The browser companion's scores were
  camera-relative; ARKit removes the normalization ambiguity but a shared-origin
  calibration (or multi-view fusion) is the next accuracy step.
- **One body.** Both ARKit body tracking and the Vision request here track a
  single primary person — matches the browser companion (`numPoses: 1`).
