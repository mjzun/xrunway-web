# (X)RUNWAY iOS Companion — Build Walkthrough (zero → running on your iPhone)

A precise, beginner-safe guide to building the native ARKit tripod companion and
getting it streaming a body skeleton into the (X)RUNWAY app. No prior iOS/Xcode
experience assumed. Follow the numbered steps top to bottom; tick the checklists.

> What you're building: a tiny iPhone app that points at a runway, tracks a
> walker's body in **world-space meters** (ARKit), and streams it over your Wi-Fi
> to the (X)RUNWAY headset/web app. It plugs into the **same** `PoseFrame` relay
> the browser companion used — see `README.md` and `../../docs/SENSORS.md`.

> **Xcode version note:** these steps were written against **Xcode 26** (the
> app's deployment target is iOS 26, so older Xcodes cannot build it). Menus
> move slightly between versions; wherever wording may differ, you'll see a
> **[Xcode wording may differ]** flag. The *meaning* stays the same — find the
> equivalent label.

---

## 0. Prerequisites checklist

Do not start until every box is true.

- [ ] **A Mac** with macOS recent enough for **Xcode 26** (check the Xcode
      listing's requirements in the Mac App Store).
- [ ] **Full Xcode 26** installed **from the Mac App Store** — NOT just the
      Command Line Tools. Search "Xcode" in the App Store, install (it's multi-GB;
      give it time). The standalone "Command Line Tools" package **cannot build or
      sign an iOS app** — you need the full IDE. To confirm you have the real
      thing: `/Applications/Xcode.app` exists.
- [ ] iPhone (or iPad) on **iOS 26 or newer** — the app's deployment target
      (`project.yml` sets `26.0`; the Enter screen uses iOS 26's Liquid Glass
      APIs, so the target cannot simply be lowered). Check on the phone:
      **Settings > General > About > Software Version**. Any device that can run
      iOS 26 has the A12+ chip that ARKit body tracking
      (`ARBodyTrackingConfiguration`) needs, so body tracking is supported on
      every phone that can install the app. The **Simulator does not support
      ARKit at all** — you must use a real device.
- [ ] **The Mac and the iPhone are on the SAME Wi-Fi network** (same SSID, not a
      guest network, not one on cellular). The pose relay is plain `ws://` over the
      LAN; both devices must reach each other.
- [ ] A **USB-to-Lightning** (or USB-C) cable to plug the phone into the Mac for
      the first install.
- [ ] **An Apple ID.** A **free** personal Apple ID works for development signing
      (no paid Apple Developer Program needed for installing on your own device).

---

## 1. Point the command line at the full Xcode

If you previously only had Command Line Tools, the `xcode-select` path may point at
the wrong place. Set it to the full Xcode and accept the license.

```bash
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept      # accept the Xcode license once
xcode-select -p                       # should print: /Applications/Xcode.app/Contents/Developer
```

- [ ] `xcode-select -p` prints a path **inside `Xcode.app`** (not
      `/Library/Developer/CommandLineTools`).

Also **launch Xcode once from the Applications folder** the first time — it installs
additional components on first run. Wait for "Installing components…" to finish.

---

## 2. Install XcodeGen and generate the project

This repo ships an **XcodeGen spec** (`project.yml`) instead of a checked-in
`.xcodeproj`, so the project is generated reproducibly.

```bash
brew install xcodegen                 # one-time; needs Homebrew (brew.sh)
cd native/ios-companion               # run from the repo root
xcodegen generate                     # reads project.yml → XRunwayCompanion.xcodeproj
open XRunwayCompanion.xcodeproj        # opens it in Xcode
```

- [ ] No errors from `xcodegen generate`.
- [ ] `XRunwayCompanion.xcodeproj` now exists in `native/ios-companion/` and opens
      in Xcode.

> No Homebrew (or don't want it)? Download a prebuilt release zip from
> https://github.com/yonaskolb/XcodeGen/releases, unzip it anywhere, and run its
> `bin/xcodegen` directly: `<unzip-dir>/bin/xcodegen generate` from
> `native/ios-companion/`. Same result, no package manager.
> The generated `.xcodeproj` is a build artifact — you can delete and regenerate it
> any time; don't hand-edit it. The same goes for `Resources/Info.plist`: XcodeGen
> regenerates it from `project.yml`, so edit the spec, never the plist.

---

## 3. Set your Signing Team

Xcode must sign the app with **your** Apple ID before it can install on a phone.

1. In Xcode's left sidebar (Project navigator), click the **blue
   `XRunwayCompanion`** project icon at the top.
2. Select the **`XRunwayCompanion` target** (under TARGETS), then the
   **Signing & Capabilities** tab. **[Xcode wording may differ]**
3. Tick **Automatically manage signing** (should already be on).
4. In **Team**, pick your Apple ID. If none is listed: click **Add an Account…**
   (or Xcode menu **Settings… > Accounts > +**), sign in with your Apple ID, then
   come back and select the resulting **"(Personal Team)"**.
5. If you see a red error like **"Failed to register bundle identifier"** or
   **"…is not available"**, the bundle id `com.mjzun.xrunway.companion` (set in
   `project.yml`) collided with something already on Apple's side. Change
   **Bundle Identifier** to something unique, e.g.
   `com.<yourname>.xrunway.companion`.

- [ ] **Signing Certificate** shows something like "Apple Development: your@email"
      with **no red errors** in Signing & Capabilities.

> A free personal team is fine for installing on devices you own. The only catches:
> the app's provisioning expires after ~7 days (just re-run from Xcode to refresh),
> and you can have a limited number of free-signed apps at once.

---

## 4. Plug in the phone, pick it as the destination, Run

1. Connect the iPhone to the Mac with the cable.
2. On the phone, if asked **"Trust This Computer?"**, tap **Trust** and enter your
   passcode.
3. In Xcode's **top toolbar**, click the **destination/scheme selector** (the
   device dropdown next to the Run ▶︎ button) and choose **your iPhone by name**.
   - First connection over Wi-Fi/USB may show **"Preparing <device>…"** — wait
     until it finishes before running.
4. Press **Run** (the ▶︎ button, or **⌘R**). Xcode builds, installs, and tries to
   launch the app.

- [ ] The build succeeds (no red build errors) and Xcode installs the app on the
      phone.

> First run usually **stops with a "Could not launch — Untrusted Developer" /
> security error.** That's expected — do Step 5, then Run again.

---

## 5. Trust the developer certificate on the phone

iOS won't run a self-signed dev app until you explicitly trust your certificate.

1. On the **iPhone**, open **Settings > General > VPN & Device Management**.
   **[on older iOS this is Settings > General > Device Management or > Profiles]**
2. Under **DEVELOPER APP**, tap your Apple ID / developer entry.
3. Tap **Trust "Apple Development: your@email"**, then **Trust** again to confirm.

- [ ] Your developer entry now shows as **Verified / Trusted**.

Back in Xcode, press **Run (⌘R)** again. The app should now launch on the phone.

---

## 6. Grant Camera + Local Network permissions

The first time you tap **Start Camera** the app requests two permissions. **Both
are required.**

1. **"…would like to access the Camera"** → tap **OK / Allow**. (Needed for ARKit /
   Vision capture.) If you tap **Don't Allow**, the app shows a **"CAMERA ACCESS
   OFF"** screen with an **OPEN SETTINGS** button — the camera never starts until
   you fix it there.
2. **"…would like to find and connect to devices on your local network"** → tap
   **Allow**. (Needed to reach the relay over Wi-Fi — without it the socket can't
   connect; the app's connection hint calls this permission out.)

If you tapped the wrong thing, fix it later in:
- **Settings > Privacy & Security > Camera > (X)RUNWAY Cam** → ON
- **Settings > Privacy & Security > Local Network > (X)RUNWAY Cam** → ON

(The app shows in Settings as **"(X)RUNWAY Cam"**.)

- [ ] Camera allowed.
- [ ] Local Network allowed.

---

## 7. Start the relay on the Mac

The relay is built into the dev server. On the **Mac**, from the repo root:

```bash
npm run dev
```

This serves the app on **:8081** and runs the **pose relay on :8082**
(`poseRelay()` in `vite.config.ts`). You do **not** need `XRUNWAY_HTTPS=1` for the
native companion — plain `ws://` is what it uses by default (that's the native win
over the browser companion, which needed HTTPS/tunnels). If you DO run the dev
server with `XRUNWAY_HTTPS=1` (mkcert TLS), that's fine too — you'll just flip the
app's **SECURE CONNECTION** toggle on in Step 9 so it dials `wss://` to match.

- [ ] `npm run dev` is running and the terminal prints the literal line
      `➜  pose relay: ws://<lan-ip>:8082`. (`<lan-ip>` is a **placeholder** the
      relay prints verbatim — it does not resolve your IP for you; that's what
      Step 8 is for.)

---

## 8. Find your Mac's LAN IP

You need the Mac's IP address on the Wi-Fi network so the phone can reach it.

Fastest (Terminal):

```bash
ipconfig getifaddr en0      # Wi-Fi is usually en0; prints e.g. 192.168.1.42
```

If that prints nothing, your Wi-Fi may be on a different interface — try `en1`, or
use the GUI: **System Settings > Network > Wi-Fi > Details… > TCP/IP** and read the
**IP Address** (e.g. `192.168.1.42`). **[on older macOS: System Preferences >
Network]**

- [ ] You have the Mac's LAN IP, e.g. `192.168.1.42`. (It must be a private LAN
      address — typically `192.168.x.x` or `10.x.x.x`.)

---

## 9. Configure and START the app

On the **iPhone**: launch the app, hold the glass orb over the **(X)RUNWAY**
title until it charges (the Enter screen), and you land on the camera screen.
Then:

1. **Receiver address (Wi-Fi IP):** type just the **Mac's IP** — no `ws://`, no
   port. The app builds `ws://<host>:8082` for you. (Field starts pre-filled with
   the placeholder `192.168.1.42` — replace it with your real IP.)
2. **Camera name:** leave as **`iphone-arkit`**, or set any label you like — it's
   what shows in the headset pill (e.g. `tripod-cam`).
3. **SECURE CONNECTION:** leave **off** for a normal `npm run dev` relay. Turn it
   on **only** if the relay runs TLS (`XRUNWAY_HTTPS=1` in Step 7) — it switches
   the app to `wss://` and must match the relay. In `wss` mode the app trusts the
   relay's self-signed/mkcert certificate automatically (a deliberate dev-endpoint
   allowance — a shipping build would pin the certificate instead). The toggle
   locks while streaming; set it before START.
4. Tap **Start Camera** (a light haptic tap confirms it).

What you should see in the app:
- The connection pill (top-right) goes **Connecting… → Connected** (green).
- The **CAMERA** and **SENDING** badges climb (sending is throttled to ≤30/s).
- A chip near the bottom reads either **"3D tracking — walker locked"** or
  **"2D tracking (simplified) — walker found"** (see Troubleshooting).
- Above it, the live framing tip: green **"Framing good — whole body visible"**
  when the shot is right, or an instruction like **"Move back — feet out of
  frame"** / **"Point the camera at the walker"**. The **SETUP** pill (top right
  of the badges) has the tripod-placement tips: side-on, 3–5 m back, waist
  height, phone upright.
- Point the phone at a person → a blue stick-figure overlay appears.

- [ ] App pill shows **Connected** and SENDING > 0/s.

---

## 10. Verify it's working end-to-end (on the Mac)

With `npm run dev` running, open the (X)RUNWAY app/landing on the Mac (or in the
Quest browser) and confirm the stream arrives:

1. A pill appears on the landing reading **`CAMERA · IPHONE-ARKIT · <n> FPS`**
   (your source label, uppercased). This is rendered by `src/landing.ts` from the
   tracker status.
2. The metrics switch from head-only to **camera-derived** while frames are fresh.
   They fall back automatically if the stream goes stale (older than
   `STALE_AFTER_SEC = 0.6` s in `src/external-tracker.ts`).
3. Move the tracked person → the live metrics react.

- [ ] The **CAMERA · <SOURCE>** pill is visible on the Mac and metrics are
      camera-derived. **Done.** 🎉

> Both peers must stay on the same Wi-Fi. You can run the web demo and the native
> companion side by side off the one relay — the protocol is shared verbatim
> (`docs/NATIVE-PORT.md` §5).

---

## Troubleshooting

### "Untrusted Developer" / app won't launch
You skipped or need to redo **Step 5**. On the phone: **Settings > General > VPN &
Device Management > [your dev entry] > Trust**. With a *free* team the trust/
provisioning expires after ~7 days — just **Run from Xcode again** to refresh it.
**[older iOS: this screen is "Device Management" or "Profiles & Device Management".]**

### "Device not eligible" / "is not eligible for this build" / device greyed out
- The phone's **iOS is below the deployment target (iOS 26)** — update the phone.
  (Lowering the target in **General > Minimum Deployments** will NOT work here:
  the Enter screen calls iOS 26-only Liquid Glass APIs.)
- The device is **still preparing** — Xcode shows "Preparing <device>"; wait for it
  to finish, then reselect it in the destination dropdown.
- **Developer Mode is off** (iOS 16+): on the phone, **Settings > Privacy &
  Security > Developer Mode > ON**, then restart the phone and confirm.
- You picked the **Simulator** by mistake — ARKit needs a **real device**; the
  Simulator is never eligible for this app.

### Can't connect to the relay (pill stuck on Connecting… / Offline)
Almost always one of: **wrong IP, not same network, or a firewall.**
- **Same Wi-Fi?** Phone and Mac on the *same* SSID — not guest Wi-Fi, not cellular,
  not a VPN that isolates clients. Toggle the phone off cellular to be sure.
- **Right IP?** Re-check with `ipconfig getifaddr en0`. Don't type `ws://` or the
  port into the Host field — just the bare IP. Confirm the relay printed
  `ws://<lan-ip>:8082` when `npm run dev` started.
- **macOS firewall** may be blocking inbound connections to node. **System Settings
  > Network > Firewall**: either turn it off briefly to test, or allow incoming
  connections for the Node process when macOS prompts.
- **Local Network permission** denied on the phone (Step 6) — the app's connection
  hint under the status line calls this out. Re-enable:
  **Settings > Privacy & Security > Local Network > (X)RUNWAY Cam > ON.** iOS only
  prompts once; if you tapped Don't Allow, you must fix it here.
- **Relay not actually running** — make sure `npm run dev` is up on the Mac
  (the relay is a Vite plugin; it only runs with the dev server).

### Mode chip says "2D tracking (simplified)"
On any device where `ARBodyTrackingConfiguration.isSupported` is false, the app
automatically uses the **Vision** body-pose request and streams **normalized 2D
image coords** (0..1, y down) — the same space the browser companion used, so the
app's side-camera metrics path still works. In practice every iOS 26 device
supports ARKit body tracking, so on a real phone you should see **"3D tracking"**;
the 2D path is the safety net (and what the ARKit-less Simulator would use). You
only lose the calibrated world-space meters that ARKit provides.

### Camera view is black / no skeleton
- Camera permission denied — you can't actually reach a silent black view for
  this anymore: START checks the permission first and shows a **"CAMERA ACCESS
  OFF"** screen with an **OPEN SETTINGS** button. Tap it (or go to **Settings >
  Privacy & Security > Camera > (X)RUNWAY Cam > ON**), then press START again.
- If the AR session itself fails mid-run, the status line at the bottom shows
  the **"AR session failed: …"** reason (in every relay state, connected or not).
- Make sure a **whole person** is in frame — the app now tells you this live:
  the framing chip reads **"Point the camera at the walker"** / **"Move back —
  feet out of frame"** until the shot is right, and the **SETUP** pill has the
  placement tips (side-on, 3–5 m back, waist height, phone upright). Both ARKit
  and the Vision fallback track a **single** primary body.

### SECURE CONNECTION toggle mismatch (wss/TLS)
The toggle must match the relay. If the relay is plain `ws://` (default
`npm run dev`) and SECURE is **on**, the TLS handshake fails — the hint says
"Secure connection failed — flip SECURE CONNECTION to match the receiver." If the
relay runs TLS (`XRUNWAY_HTTPS=1`) and SECURE is **off**, the connection drops or
times out — same fix, other direction. When SECURE is on, the app accepts the
relay's self-signed/mkcert certificate without system verification
(`RelayTrustDelegate`) — fine for a LAN dev relay you dial by IP; a production
build would pin the certificate.

### Build fails: "No account / Signing requires a development team"
Redo **Step 3** — add your Apple ID under Team. If "Failed to register bundle
identifier", change the **Bundle Identifier** to something unique.

### Wi-Fi run keeps disconnecting
For the first install, keep the **cable plugged in**. Wireless debugging
(**Window > Devices and Simulators > [device] > Connect via network**) is optional
and can be flaky on busy networks.

---

## Quick reference

| Item | Value |
|------|-------|
| Relay URL the app dials | `ws://<mac-LAN-ip>:8082` — `wss://` with SECURE on (app adds scheme + port) |
| Default camera name | `iphone-arkit` |
| Find Mac IP | `ipconfig getifaddr en0` |
| Start relay + app | `npm run dev` (no HTTPS needed; SECURE stays off) |
| SECURE CONNECTION toggle | Match the relay: on only for `XRUNWAY_HTTPS=1` (wss/TLS, self-signed cert auto-trusted) |
| Headset pill on success | `CAMERA · <SOURCE> · <n> FPS` |
| Staleness fallback window | 0.6 s (`STALE_AFTER_SEC`) |
| Min device | any iPhone/iPad that runs iOS 26 (all have A12+ → ARKit body tracking) |
| Min iOS | 26.0 (`project.yml` deploymentTarget) |
| Bundle id | `com.mjzun.xrunway.companion` |
| App name in Settings | (X)RUNWAY Cam |

See also: `README.md` (architecture + keypoint mapping), `../../docs/SENSORS.md`
(why native), `../../docs/NATIVE-PORT.md` (shared protocol §5).
