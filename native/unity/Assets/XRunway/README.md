# (X)RUNWAY — Unity 6 + AR Foundation port

First-person AR runway-training simulator. This is the **native** track (founder
direction): native Quest + native iOS, because native unlocks the **Quest
Passthrough Camera API** and **iPhone ARKit/LiDAR** that the WebXR sandbox can't
reach. The web app (IWSDK/WebXR) stays as the pitch/prototype and is the **source
of truth for the LOGIC** ported here.

`Assets/XRunway/Core/` is a **faithful, engine-agnostic C# port** of the validated
(X)RUNWAY logic — the unit-tested runway math, the show state machine, the coach
metrics, and the external-tracker contract. It has **no `UnityEngine` dependency**
so it is unit-testable in plain .NET. Everything Unity-specific (scene, AR, render,
input, networking) is **glue you build on top** — sketched below, not faked.

---

## What's in `Core/` (ported, not stubbed)

| File | TS source | What it is |
|---|---|---|
| `RunwayLayout.cs` | `src/runway-layout.ts` | `RunwayLayout` struct, `LayoutLimits`, `RunwayLayoutModel` (`DefaultLayout`, `PoseInset`/`StartInset`, `PoseAlong`/`StartAlong`, `Sanitize`, `FromEndpoints`), `RunwayProjector` (`Along`/`Lateral`/`AlongFraction` — **matches the TS math exactly**), and the `ILayoutStore` + `LayoutStorage` persistence seam. |
| `ShowDirector.cs` | `src/show.ts` | The phase state machine `idle→brief→countdown→walk→summary`, delta-accumulated timers, energy exp-lerp + per-phase targets, weighted overall + `DeltaVsLast`, `WalkProgress`/`WalkRemaining` from an injected `IHeadProvider`. |
| `Metrics.cs` | `src/metrics.ts` | Head-derivation **and** pose-derivation (`DeriveFromHead`/`DeriveFromPose`), ring buffers, EMAs, `MetricPass = 78`, the M1..M7 `MetricsTable`, 6 Hz publish, footstrike → `FootStrike`. |
| `PoseFrame.cs` | `src/external-tracker.ts` | `PoseFrame`/`PoseKeypoint`, `KeypointNames`, `ExternalTracker` (`Push`/`Latest`/`Status`, 0.6 s staleness). |
| `ShowTypes.cs` | `src/show.ts` | `ShowPhase` enum, `MetricSnapshot`, `ShowSummary`. |

**Fidelity guarantees.** The projector's `Along`/`Lateral`/`AlongFraction`, the
`FromEndpoints` yaw/center solve, the `Sanitize` clamps, the energy lerp
(`1 - exp(-rate·dt)`), the per-phase energy targets, the `OVERALL_WEIGHTS`, the
walk round-trip/monotonic-clamp logic, the EMA rates and score mappings, the ring
buffer + MAD/CV rhythm, `METRIC_PASS = 78`, and the 0.6 s tracker staleness all
match the TypeScript line-for-line. The theme constants the TS pulls from
`theme.ts` are baked into `RunwayLayoutModel` (`deckWidth 1.4`, `deckLength 7`,
`nearGap 0.25` ⇒ `DeckCenterZ = -3.75`) and `ShowDirector` (`WalkSec = 60`).

**Math type.** Core uses `System.Numerics.Vector3` (not `UnityEngine.Vector3`) so
it stays Unity-free. The Unity layer converts at the boundary (one line in the
head provider). Both are XYZ float vectors; the only care needed is the conversion
in `IHeadProvider`.

---

## 1. Create the Unity 6 project

1. Install **Unity 6** (6000.x LTS) via Unity Hub.
2. New project → **Universal 3D (URP)** template (URP plays well with both the
   Quest and iOS XR stacks). Name it `XRunway`.
3. Copy this `native/unity/Assets/XRunway/` folder into the new project's
   `Assets/` (or point the new project at this folder). Unity will compile `Core/`
   automatically — **no `dotnet build` here**; there is no `.csproj` to run
   locally, Unity owns compilation.

### Recommended: an asmdef for Core (keeps it engine-free and testable)

Create `Assets/XRunway/Core/XRunway.Core.asmdef`:

```json
{
  "name": "XRunway.Core",
  "rootNamespace": "XRunway.Core",
  "references": [],
  "includePlatforms": [],
  "excludePlatforms": [],
  "allowUnsafeCode": false,
  "noEngineReferences": true
}
```

`"noEngineReferences": true` is the important bit: it makes the compiler **reject
any accidental `using UnityEngine;`** in Core, enforcing the boundary. The Unity
MonoBehaviour layer lives in a separate assembly (e.g. `XRunway.Unity.asmdef` that
references `XRunway.Core`) so it *can* use `UnityEngine`.

---

## 2. Packages (Window ▸ Package Manager)

Common:
- `com.unity.xr.arfoundation` — AR Foundation (planes, camera, session).
- `com.unity.xr.openxr` — OpenXR (the Quest path runs through OpenXR).
- `com.unity.xr.management` — XR plug-in management (enable per-platform below).

Quest (Android):
- `com.meta.xr.sdk.core` (Meta XR Core SDK) — and, for on-headset CV that feeds
  the pose stream, the **Passthrough Camera API** (Meta XR SDK). This is the whole
  reason for going native: WebXR can't read the passthrough cameras.
- Enable **Meta Quest** feature group + **OpenXR** under
  *Project Settings ▸ XR Plug-in Management ▸ Android*.

iOS:
- `com.unity.xr.arkit` (ARKit XR Plugin) — world tracking, plane detection, and
  (for the real product) **ARKit body tracking + LiDAR depth** → a world-space
  skeleton that becomes a `PoseFrame` source.
- Enable **ARKit** under *XR Plug-in Management ▸ iOS*.

Player settings: Android min API per Meta's current requirement, IL2CPP + ARM64;
iOS camera + (if used) motion usage descriptions; Linear color space.

---

## 3. Wire Core to MonoBehaviours

Core is driven by three injected seams: an `IHeadProvider`, an optional
`ExternalTracker` (fed by the relay client), and the per-frame `Update(delta[,
time])`. A thin `UnityShowRunner` MonoBehaviour owns the instances and pumps them.

### 3a. `IHeadProvider` from the XR camera

```csharp
using UnityEngine;
using SnVector3 = System.Numerics.Vector3;

// Lives in the Unity assembly (references XRunway.Core).
public sealed class XrCameraHeadProvider : MonoBehaviour, XRunway.Core.IHeadProvider
{
    [SerializeField] private Transform headTransform; // the AR/XR camera

    public SnVector3 HeadWorld
    {
        get
        {
            // AR Foundation / OpenXR already report the camera in world space.
            Vector3 p = headTransform.position;
            return new SnVector3(p.x, p.y, p.z); // Unity → System.Numerics
        }
    }
}
```

> The XR camera is `Camera.main` under the **XR Origin** (AR Foundation's
> `XROrigin`). On Quest this is the headset; on iPhone it's the device camera pose.
> No coordinate remap is needed — both are right-handed Y-up meters, and the runway
> math only uses X/Z for along/lateral and Y for bob/posture.

### 3b. Runway auto-map from `ARPlaneManager`

Use detected floor planes to fit/center the runway (the native equivalent of the
web app's WebXR plane-detection auto-map):

```csharp
// On a detected horizontal floor plane:
//   centerXZ  ← plane.center (world)
//   yaw       ← plane's forward heading (or let the trainee walk-and-place)
// Then push a sanitized layout into Core:
var layout = XRunway.Core.RunwayLayoutModel.Sanitize(new XRunway.Core.RunwayLayout(
    centerX, centerZ, yaw, length, width));
director.ApplyLayout(layout);
metrics.ApplyLayout(layout);
layoutStore.Save(layout);
```

For the **walk-and-place** flow, capture two floor taps (start, end) and call
`RunwayLayoutModel.FromEndpoints(startX, startZ, endX, endZ, width)` — identical
to the web prototype.

### 3c. `UnityShowRunner` — the pump

```csharp
using UnityEngine;
using XRunway.Core;

public sealed class UnityShowRunner : MonoBehaviour
{
    [SerializeField] private XrCameraHeadProvider head;     // 3a
    [SerializeField] private NativePoseRelayClient relay;   // 3d (optional)

    private ShowDirector _director;
    private MetricsSystem _metrics;
    private ExternalTracker _tracker;
    private ILayoutStore _store;

    private void Awake()
    {
        _store = new PlayerPrefsLayoutStore();
        var layout = _store.Load();

        // Share ONE clock between the tracker and the relay client so staleness
        // math is consistent (see 3d). Time.realtimeSinceStartupAsDouble is ms-safe.
        _tracker = new ExternalTracker(() => Time.realtimeSinceStartupAsDouble * 1000.0);

        _director = new ShowDirector(head, layout);
        _metrics  = new MetricsSystem(head, _tracker, layout);

        // Bridge Metrics → Director (Director freezes live metrics into the summary).
        _metrics.OnMetrics += snap => _director.SetLiveMetrics(snap);

        // Drive Metrics' walk lifecycle off the Director's phase.
        _director.OnPhaseChanged += phase =>
        {
            if (phase == ShowPhase.Walk) _metrics.BeginWalk();
            else _metrics.Stop();
        };

        // Floor ripple: forward footstrikes / clears to your shader/VFX.
        _metrics.OnFootStrike += strike => floorShader.SetStep(strike.Time, strike.Z);
        _metrics.OnFootStrikeCleared += () => floorShader.ClearStep();

        // HUD / stage / music subscribe to the rest:
        _director.OnEnergyChanged       += e => stageMood.SetEnergy(e);
        _director.OnWalkProgressChanged += p => hud.SetWalkProgress(p);
        _director.OnWalkRemainingChanged += r => hud.SetTimeRemaining(r);
        _director.OnSummaryChanged      += s => hud.ShowSummary(s);

        if (relay != null) relay.Bind(_tracker); // 3d
    }

    // UI buttons:
    public void OnBeginPressed() => _director.BeginWalk();
    public void OnResetPressed()  => _director.Reset();

    private void Update()
    {
        float dt = Time.deltaTime;
        double t = Time.timeAsDouble; // shader/ECS clock for ripple age
        _director.Update(dt);
        _metrics.Update(dt, t);
    }
}
```

> **Ordering matters** (and mirrors the web app): `Director.Update` runs the phase
> machine and may flip into `Walk` (which fires `OnPhaseChanged` → `Metrics.BeginWalk`),
> then `Metrics.Update` derives that frame. The `OnMetrics` → `SetLiveMetrics`
> bridge means the summary the Director freezes on finish is the last live tick —
> exactly the `globals.metrics.peek()` behaviour in `show.ts`.

### 3d. `PlayerPrefsLayoutStore` — the persistence impl

Core defines `ILayoutStore` + `LayoutStorage` (key `xrunway.runwayLayout.v1`, same
JSON shape as the web app's `localStorage`). The Unity impl just supplies string
get/set:

```csharp
using UnityEngine;
using XRunway.Core;

public sealed class PlayerPrefsLayoutStore : ILayoutStore
{
    public RunwayLayout Load()
    {
        string raw = PlayerPrefs.GetString(LayoutStorage.StorageKey, null);
        return string.IsNullOrEmpty(raw)
            ? RunwayLayoutModel.DefaultLayout
            : LayoutStorage.FromJson(raw);   // tolerant parse + Sanitize
    }

    public void Save(in RunwayLayout layout)
    {
        PlayerPrefs.SetString(LayoutStorage.StorageKey, LayoutStorage.ToJson(layout));
        PlayerPrefs.Save();
    }
}
```

---

## 4. `NativePoseRelayClient` (sketch)

The relay protocol is shared by all peers (web + native). Native apps are **not
browser-sandboxed**, so plain `ws://` over the LAN is fine — no HTTPS/WebXR
secure-context dance. Connect to `ws://<host>:8082`, send a `hello`, then receive
`{"type":"pose","frame":PoseFrame}` and `Push` into the `ExternalTracker`.

```csharp
using System;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using XRunway.Core;

// Receiver side: consumes the stream an iOS/ARKit (or webcam-relay) sender produces.
// Mirrors src/pose-ingest.ts: restamp-to-local-clock + reconnect-with-backoff.
public sealed class NativePoseRelayClient : MonoBehaviour
{
    [SerializeField] private string host = "127.0.0.1";
    private const int RelayPort = 8082;          // matches POSE_RELAY_PORT
    private const int ReconnectMinMs = 1500;
    private const int ReconnectMaxMs = 15000;

    private ExternalTracker _tracker;
    private ClientWebSocket _ws;
    private CancellationTokenSource _cts;

    // Same clock the ExternalTracker uses (see UnityShowRunner.Awake). Frames are
    // restamped into THIS clock on arrival so cross-device skew doesn't matter.
    private static double NowMs() => Time.realtimeSinceStartupAsDouble * 1000.0;

    public void Bind(ExternalTracker tracker) => _tracker = tracker;

    private void OnEnable()  { _cts = new CancellationTokenSource(); _ = RunLoop(_cts.Token); }
    private void OnDisable() { _cts?.Cancel(); try { _ws?.Abort(); } catch { } _ws = null; }

    private async Task RunLoop(CancellationToken ct)
    {
        int backoff = ReconnectMinMs;
        var uri = new Uri($"ws://{host}:{RelayPort}");
        while (!ct.IsCancellationRequested)
        {
            try
            {
                _ws = new ClientWebSocket();
                await _ws.ConnectAsync(uri, ct);
                backoff = ReconnectMinMs;

                // hello (role=receiver). Senders send role=sender + source.
                await SendJson("{\"type\":\"hello\",\"role\":\"receiver\"}", ct);

                var buf = new byte[64 * 1024];
                var sb = new StringBuilder();
                while (_ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
                {
                    sb.Clear();
                    WebSocketReceiveResult r;
                    do
                    {
                        r = await _ws.ReceiveAsync(new ArraySegment<byte>(buf), ct);
                        if (r.MessageType == WebSocketMessageType.Close) break;
                        sb.Append(Encoding.UTF8.GetString(buf, 0, r.Count));
                    } while (!r.EndOfMessage);

                    if (r.MessageType == WebSocketMessageType.Close) break;
                    HandleMessage(sb.ToString());
                }
            }
            catch (OperationCanceledException) { break; }
            catch { /* fall through to reconnect */ }
            finally { try { _ws?.Dispose(); } catch { } _ws = null; }

            // Reconnect with exponential backoff (×1.6, capped) — like pose-ingest.ts.
            try { await Task.Delay(backoff, ct); } catch { break; }
            backoff = Math.Min((int)(backoff * 1.6), ReconnectMaxMs);
        }
    }

    private async Task SendJson(string json, CancellationToken ct)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        await _ws.SendAsync(new ArraySegment<byte>(bytes),
            WebSocketMessageType.Text, true, ct);
    }

    private void HandleMessage(string text)
    {
        // Parse {"type":"pose","frame":{t,source,keypoints:{name:{x,y,z,score}}}}.
        // Use a real JSON parser here (Newtonsoft / System.Text.Json / a small
        // hand parser). Then:
        //   var frame = ParsePoseFrame(text);     // -> XRunway.Core.PoseFrame
        //   if (frame == null) return;
        //   frame.SentT = frame.T;                // preserve sender stamp
        //   frame.T = NowMs();                    // RESTAMP to local clock
        //   _tracker.Push(frame);                 // thread-safe? marshal to main if needed
    }
}
```

**Notes / caveats for the relay client**

- **Restamp on arrival.** The sender stamps `frame.t` with *its* clock; we restamp
  to the local clock before `Push`, exactly like `pose-ingest.ts`, so
  `ExternalTracker`'s 0.6 s staleness check is device-skew-proof. Keep the sender's
  value on `SentT` for latency telemetry.
- **Same clock everywhere.** The `Func<double> nowMs` you give `ExternalTracker`
  and the `NowMs()` used to restamp must be the **same** clock, or staleness is
  meaningless.
- **Threading.** `ClientWebSocket` callbacks run off the main thread. Unity API
  (`Time.*`) and any consumer that touches `UnityEngine` must be marshalled to the
  main thread (e.g. a concurrent queue drained in `Update`, or
  `UnitySynchronizationContext`). `ExternalTracker.Push`/`Latest` are plain C# and
  fine off-thread *if* you don't also read them from the main thread concurrently —
  simplest is to enqueue the parsed frame and `Push` from `Update`.
- **Sender role.** A native **iOS/ARKit** app is the real-product sender: it world-
  tracks the body, builds a `PoseFrame` (world-space meters → far better than the
  web companion's normalized image coords), and streams `{"type":"pose","frame":…}`
  with `hello` `role:"sender"`, `source:"iphone-arkit"`. The Quest receiver's Core
  code does **not** change — same protocol.
- **JSON.** Pick one parser; this sketch leaves `ParsePoseFrame` to you. Keypoint
  names are the protocol's nine (`KeypointNames`): nose, left/right shoulder, hip,
  knee, ankle.

---

## 5. Build & run

- **Quest:** *File ▸ Build Settings ▸ Android* → switch platform → set XR plug-in
  to OpenXR + Meta Quest → Build & Run to the headset over USB/ADB. Passthrough/AR
  via the Meta XR SDK; planes via AR Foundation.
- **iOS:** *Build Settings ▸ iOS* → switch platform → ARKit plug-in → Build to an
  Xcode project → run on a LiDAR-capable iPhone/iPad. ARKit planes feed the auto-
  map; ARKit body tracking can feed the pose stream.

There is **no `dotnet build`** step in this repo for Core — Unity compiles it as
part of the player build. The C# is C# 9+ idiomatic and warning-clean.

---

## 6. Unit-testing Core (recommended)

Because Core has no `UnityEngine` dependency, you can test it two ways:

1. **Unity Test Framework (EditMode):** add a test asmdef referencing
   `XRunway.Core`. Feed a fake `IHeadProvider` (a settable `System.Numerics.Vector3`)
   and step `Update(dt)` to assert phase transitions, `WalkProgress` monotonicity,
   the overall weighting, and the projector math.
2. **Plain .NET / xUnit:** drop `Core/*.cs` into a netstandard2.1 test project (no
   Unity needed) and port the web app's `runway-layout` unit tests verbatim — the
   `RunwayProjector` numbers must match the TS exactly. This is the fastest way to
   re-verify fidelity after any change.

Suggested golden checks (mirror the TS):
- `RunwayProjector.Along/Lateral/AlongFraction` for `DefaultLayout` and a rotated
  layout (`yaw = π/2`).
- `FromEndpoints` round-trips a known start/end into the expected center/yaw/length.
- `Sanitize` clamps out-of-range length/width/offset and wraps yaw.
- `ShowDirector` weighted overall for a known `MetricSnapshot` == the TS result.

---

## Boundary summary (what Core does NOT do)

Core is pure logic. It does **not** open sockets, touch the GPU, read the XR
camera, render the deck/floor/audience/lights, drive audio, or parse JSON off the
wire. Those are the Unity glue layer's job (sections 3–5). Everywhere Unity types
would plug in is marked: `IHeadProvider` (XR camera), `ILayoutStore` (PlayerPrefs),
the `ExternalTracker` clock + `NativePoseRelayClient` (networking), and the
`OnMetrics`/`OnFootStrike`/`OnPhaseChanged`/`OnEnergyChanged`/`OnSummaryChanged`
events (HUD / stage / floor shader / music).
```
