# (X)RUNWAY — Side-camera ⇄ runway calibration

How to align the iPhone tripod companion (`native/ios-companion/`, ARKit world-space
body tracking) to the mapped runway so its body data maps cleanly to the experience.

> **TL;DR / recommended MVP path:** For the 14-day pitch you do **not** need
> cross-device alignment. The four gait metrics (pace / posture / footwork /
> rhythm) are **viewpoint-relative** and already correct from the raw stream.
> Ship the **"face-down-the-runway" setup convention** (§3a) — zero code — plus
> the **optional one-tap CALIBRATE** (§3b) only if you want the camera's body
> position drawn onto the runway or footwork measured against the runway's *actual*
> printed centerline. Exact shared-origin alignment (§4) is a post-pitch upgrade.

---

## 1. The problem

The iPhone companion streams a body skeleton in **ARKit world meters**
(`PoseFrame.space = "world"`, right-handed, +Y up — see `src/external-tracker.ts`
and `native/ios-companion/Sources/PoseFrame.swift`). The headset/app maps the
virtual runway onto the *headset's* world via `RunwayLayout`
(`src/runway-layout.ts`).

These are **two independent world frames**:

- ARKit's origin is wherever the **iPhone's** session started (typically the phone's
  initial pose), with an arbitrary yaw. Its axes are gravity-aligned but its **origin
  and heading are not shared** with the headset.
- The headset's runway frame has its own origin (the AR session origin) and a
  `yaw` chosen when the trainee mapped the deck.

Nothing ties them together. The relay (`poseRelay()` in `vite.config.ts`, port 8082)
is a **dumb broadcast** — it does not transform coordinates. So a hip at
`(0.3, 0.9, -2.1)` in the phone's frame is **not** at `(0.3, 0.9, -2.1)` on the
runway. Naively dropping the camera's world coordinates onto the runway puts the body
in the wrong place, pointing the wrong way.

This is exactly the open item the iOS README already flags
(`native/ios-companion/README.md`, "Caveats → Runway-frame calibration is not done
here").

---

## 2. The key insight — most of what we score needs NO alignment

**The current metrics are viewpoint-relative.** Read `deriveFromPoseWorld()` in
`src/metrics.ts`: every score is computed from **differences and angles within a
single frame's own skeleton**, never from an absolute world position. Concretely:

| Metric | How it's derived (world path) | Needs a shared frame? |
|---|---|---|
| **pace** | magnitude of the hip-translation vector / Δt → m/s | **No** — speed is frame-invariant under any rigid transform. |
| **posture** | \|vertical component\| / length of the shoulder→hip vector (torso tilt vs gravity) | **No** — both frames are gravity-aligned (+Y up); tilt is absolute. |
| **footwork** | ankle distance *perpendicular to the trainee's own smoothed heading* | **No** — heading is **self-derived from the body's travel**, lateral is relative to *that*, not to the runway. |
| **rhythm** | hip vertical-bob cadence regularity (intervals between up-crossings) | **No** — purely temporal; coordinates don't enter. |

Why this works: a rigid transform (rotation + translation, which is all that separates
the two world frames — both share the gravity/up axis) **preserves distances, speeds,
relative angles, and time**. The metrics are functions of exactly those invariants.
The composites (presence / confidence / presentation) are weighted sums of the four,
so they inherit the property.

**Therefore, for scoring, the uncalibrated world-space stream is already correct** —
not "directionally correct," genuinely correct in real metric units. This is a
stronger statement than `docs/SENSORS.md`'s note about the *browser* companion: that
stream was *normalized image coords* (a non-rigid, perspective-warped 2D projection),
so it was a camera-relative *proxy*. The **native world-space** stream is rigid-metric,
so the gait scores are invariant.

### When you DO need alignment

Alignment buys you only the things that reference the runway's **own** geometry:

1. **Drawing the camera's body onto the runway** — a spectator/replay avatar, or any
   visual that places the streamed joints at the right spot on the virtual deck.
2. **Footwork vs the runway's _actual_ centerline** — today footwork is measured
   against the trainee's *self-heading* (a great proxy: "are you walking a straight
   line?"). If a customer wants "deviation from the *painted* centerline of the mapped
   deck" (a different, stricter question — "are you on *the* line?"), that needs the
   camera body expressed in runway-along/lateral, i.e. the `RunwayProjector`
   (`along`/`lateral`/`alongFraction`) fed with *aligned* coordinates.
3. **The floor ripple from camera footstrikes** — `globals.lastStep.z` is a deck-local
   along-fraction (`projector.alongFraction`). Today only the head path emits it; if
   the camera should drive the ripple, its strike position must be in runway-along,
   which needs alignment.

For the MVP, none of these three is on the critical path. Scores light up correctly
without any of it.

---

## 3. Lightweight calibration for the MVP

Two tiers. Do (a) for free; add (b) only if you want §2's "alignment-only" features.

### (a) "Face-down-the-runway" setup convention — **zero code, do this**

A purely physical convention, documented in the companion UI and the pitch script:

> **Place the iPhone at the *near* (start) end of the runway, on its tripod, aimed
> straight down the walk axis toward the pose mark.**

Because the trainee then walks **away from the phone, down ARKit's −Z-ish forward**,
the body's self-derived heading already runs (approximately) parallel to the runway
axis. Combined with §2, this gives:

- Correct pace/posture/rhythm immediately (they never needed it anyway).
- Footwork that is *already* "deviation from the line you're walking," which — with
  the phone aimed down the lane — is visually the runway line. Good enough to coach.
- A clean, repeatable demo: "set the phone here, point it down the runway, walk."

This is the **recommended pitch configuration**. It costs nothing and removes the only
real failure mode (a wildly off-axis camera making the "down the runway" story
confusing to a viewer).

> Note: the *side* camera (phone perpendicular to the walk, body translating across
> frame) is the **Vision-2D / browser** setup (`deriveFromPose`, image space). The
> **native ARKit** companion does not need to be side-on — world-space metrics work
> from any angle. "Face down the runway" is chosen for demo legibility, not for
> metric correctness.

### (b) Optional one-tap CALIBRATE — snap the camera's origin to the start mark

For the alignment-only features (§2.1–2.3), capture a single correspondence:

1. The trainee stands on the **start mark**, facing down the runway, in view of the
   phone.
2. They tap **CALIBRATE** (on the companion, or trigger it from the app HUD).
3. The system records the camera's **current mid-hip position** as the runway
   **origin**, and uses the **heading of the first few steps** (the same smoothed
   travel direction the metrics already compute, `poseHeadingX/poseHeadingZ` in
   `deriveFromPoseWorld`) as the runway **forward**.

That yields a 2D rigid transform (a yaw + a translation on the floor plane; the up
axis is shared) mapping **camera-world → runway-along/lateral**:

- `forward_cam` = unit smoothed-heading from the first ~3–5 steps.
- `origin_cam`  = mid-hip XZ at the moment of the tap (≈ the start line).
- For any camera joint `p`: `along = dot(p − origin_cam, forward_cam)`,
  `lateral = dot(p − origin_cam, right_cam)` where `right_cam` is `forward_cam`
  rotated −90° about +Y. This mirrors `RunwayProjector.along`/`lateral` exactly
  (same `f`/`r` basis, `src/runway-layout.ts`), just with a camera-derived basis
  instead of the headset layout's.

This is **one tap, one frame of correspondence, two derived vectors** — no marker, no
ARWorldMap, no clock sync. Accuracy is roughly "where the trainee stood and which way
they set off," which is plenty for placing an avatar or scoring against the deck line.
It does **not** make pace/posture/rhythm any more correct — they were already correct.

> Honest limit: drift. ARKit world tracking can drift over a long session, so a
> calibration captured once may slowly stale. For a < 2-minute walk it's negligible;
> if it matters, re-tap CALIBRATE between walks (cheap) or move to §4.

### Which tier for the pitch?

Ship **(a) always**. Add **(b)** only if a demo beat needs the camera body drawn on
the runway or "on the painted line" footwork. Default pitch = **(a) only**.

---

## 4. How this becomes *exact* later (post-MVP)

§3b is a good-enough single-point snap. The exact, drift-free versions, in increasing
order of effort:

- **Printed floor marker (fiducial).** Put an ARKit-detectable image/AprilTag at the
  runway start, at a known runway pose. Both the iPhone (ARKit image anchor) and the
  headset (if it can see it, or by construction since the marker *defines* the start)
  get the marker's pose in their own frame → the camera→runway transform is exact and
  needs no trainee action. This is the cleanest production calibration.
- **Shared `ARWorldMap` / co-localization.** Relocalize the iPhone against a world map
  the headset also knows (or a cloud anchor), giving a common origin directly. Heavier
  to set up; removes drift; supports multiple cameras in one shared frame
  (the multi-view fusion path in `docs/SENSORS.md` / `docs/NATIVE-PORT.md`).
- **Multi-camera extension.** Once any one camera is aligned to the runway, additional
  tripods calibrate to the *same* runway frame the same way, and their skeletons fuse
  for occlusion-robust scoring — same `PoseFrame` protocol, no app change.

All three produce the same thing §3b approximates: a rigid camera-world→runway
transform. They just make it exact and persistent.

---

## 5. The code seam (for the integrator — not written here)

Keep calibration **app-side / companion-side**; the relay stays a dumb broadcast
(`vite.config.ts`) and must not learn about runways. The smallest seam:

- **`globals.calibrationPose`** — a nullable rigid transform on `world.globals`,
  alongside `externalTracker` / `runwayLayout` / `trackerActive`. Shape: an origin
  `{x, z}` and a forward unit `{x, z}` on the floor (up is shared), i.e. the
  camera→runway basis from §3b. `null` = uncalibrated (the default; metrics run
  exactly as today).
- A **`CALIBRATE` affordance** — a HUD button (or a companion-side tap that sends a
  `{type:"calibrate"}` envelope the app turns into the pose). On activation: read the
  freshest world-space frame's mid-hip as `origin`, latch the metrics' already-smoothed
  heading after a few steps as `forward`, write `globals.calibrationPose`.
- **Consumption is opt-in and additive.** `MetricsSystem` keeps scoring exactly as now
  (the four invariants need nothing). Only the **alignment-only** features read
  `calibrationPose`: a future spectator-avatar system transforms camera joints through
  it before placing them; a stricter "centerline" footwork mode would project the
  aligned hip/ankles with the existing `RunwayProjector`. If `calibrationPose` is
  `null`, every one of these cleanly degrades to today's behavior.
- **Persistence (optional):** stash `calibrationPose` next to the layout
  (`xrunway.runwayLayout.v1` pattern in `src/runway-layout.ts`) so a re-open keeps it —
  though re-tapping is cheap and drift-robust, so persistence is not required for the
  MVP.

No change to `PoseFrame`, the relay, or the existing metric math. Calibration is a
**transform applied downstream of the stream**, not a change to the stream.

---

## 6. What needs the real phone to validate

Everything in §2 can be reasoned about on paper, but these need an **A12+ iPhone
running the ARKit companion** against the headset on the same LAN:

- **Confirm the scores are truly transform-invariant in practice** — stream a real walk
  and check pace (m/s), posture (tilt), rhythm (cadence) read sanely *regardless of how
  the tripod is yawed/positioned*. This is the core claim of §2; only real ARKit
  world-space frames prove it (the Simulator falls back to Vision 2D and won't).
- **ARKit drift over a session** — measure how far a §3b calibration stales across a
  1–2 min walk, to confirm "re-tap between walks" is enough and §4 isn't needed for the
  pitch.
- **The "face-down-the-runway" ergonomics** — tripod height/distance so the whole body
  (head→ankles) stays in frame for the full walk; ARKit body tracking needs the person
  reasonably framed.
- **One-tap CALIBRATE feel** — that latching heading after ~3–5 real steps yields a
  stable forward (vs. jitter at walk start).

Until then, the synthetic/relay path verifies the *plumbing* (`docs/SENSORS.md` "Phase
2 pipeline — BUILT"), but the calibration claims above are validated only on device.
