# SOLO MODE — phone-only (X)RUNWAY

*Design + port map, authored 2026-07-02. Every load-bearing claim is receipted in Appendix A
(generated from a 5-surveyor code audit of this tree) and the narrative was adversarially
fact-checked against the code twice; the appendix, not this narrative, is the authority when
they disagree.*

## 1. What Solo mode is

A trainee with **only an iPhone** props it at the end of a self-chosen straight walking line,
taps START, and walks. The phone captures their body with ARKit, **scores the walk on-device**
(pace, posture, rhythm, footwork + the composite reads), **coaches them by voice mid-walk**
(they can't see the screen — same insight that drove the headset's audio coaching), and shows a
summary with the verdict, directional coach notes, and steps/cadence. Progress over time
(deltas, personal bests, MASTERED) arrives with the Phase B history store.
No Mac, no headset, no network — the wire and the relay disappear entirely.

Product ladder: **phone = the accessible trainer** (every modeling student has one),
**Quest = the premium immersive runway** (the show, the audience, the mapped floor).
NOTE this framing is gated on the §7 distribution decision — today the app is a free-team dev
install; "every student has one" requires TestFlight/App Store.
The web app remains the source of truth for all scoring logic; Solo mode is a *port with
executable proof of equivalence* (§5), not a fork.

What Solo mode is NOT (v1): no 3D runway render, no show/finale, no audience, no runway mapping,
**no video recording** (an obvious adjacent ask — explicitly a non-goal for v1; Phase C candidate
next to the AR-line replay). The trainee walks a real floor; the phone is the camera and the coach.

## 2. What a Solo walk IS (the walk protocol)

Every headline feature depends on this definition, so it comes first.

- **The line**: during setup the trainee defines their walking line by **walking it once** — the
  phone measures traveled distance from the hip track (frame-invariant; no manual tape measure).
  Manual entry is the fallback. Lines **under ~6 m get a warning**: with the coach's settle
  window (5 s), hysteresis (2.5 s), per-lap turn suppression (4 s) and final guard, a very short
  line leaves little room for mid-walk cues — the summary still scores fully.
- **The walk**: **timer-capped multi-lap out-and-back** — the mode's `walkSeconds` is the clock,
  exactly like the web. The trainee laps the line until time. Turn detection must therefore fire
  **repeatedly** (travel-heading reversal, re-armed per lap) — a distance-from-start-peak
  heuristic only works for lap 1 and is ruled out. **Decision (landed in the walk-replay
  vectors): EVERY reversal marks — far end AND near end.** Both are travel-heading reversals,
  and the over-trigger bias (§5) makes the extra near-end mark benign (clears fault clocks 4 s)
  while a missed one fabricates cues. Progress for the final guard =
  `elapsed / walkSeconds` (clock-based; the positional fast-finisher guard is a web nicety that
  doesn't map to laps).
- **Getting into position**: the trainee taps START *at the phone*, then walks out. The state
  machine holds in `positioning` until the framing gate reads good (whole body visible), then
  runs an **audible countdown** (ticks + voice — the trainee can't see the screen), then the walk
  clock starts. Countdown tick + sting earcons are Phase A assets.
- **Interruptions**: a call/ARSession interruption mid-walk **discards the walk** with a plain
  message (v1 decision — no partial records, no synthetic ghosts; revisit if it stings on-device).
- **Someone else walks through frame**: ARKit tracks one body and can re-anchor onto a passer-by.
  Mitigation: an anchor-continuity check (position jump beyond plausible stride) treats the
  discontinuity as a **tracking gap** (next bullet) rather than scoring a stranger.
- **Tracking gaps** (occlusion, walker leaves frame, anchor steal): any inter-frame gap
  `dt > 0.6 s` — or any interval where framing is not good — contributes **zero stats weight**
  and re-seeds the hip anchor, bob baseline, and pose timestamps on resume (this replaces the
  web's `resetCadence` source-handoff protection, which Solo's single-source loop otherwise
  loses; the appendix documents the outage-differencing bug it prevents). A gap-tape golden
  vector locks the behavior.

## 3. The honest metric set (the frame-invariance rule)

The iPhone's ARKit world frame is **unregistered** — its origin is wherever the session started,
so absolute runway position is meaningless. The pose-relay hardening review established which
quantities remain honest without registration:

| Channel | Phone-honest? | How |
|---|---|---|
| Pace (M2) | ✅ as-is | speed **magnitude** from horizontal world-space hip displacement — frame-invariant |
| Rhythm (M3) | ✅ as-is | step intervals from vertical hip oscillation — gravity-aligned, frame-invariant |
| Footwork (M4) | ✅ **redefined** | deviation from the walker's **own travel line** (the existing `deriveFromPoseWorld` heading-EMA + ankle-offset pattern — score input stays the abs ankle offset, which includes stance width) |
| Posture (M1) | ✅ **redefined — decision made** | **hip-height stability vs the walk-start baseline** for the M1 score, the live cue channel, AND `postureDriftM` — ONE quantity so the score and the spoken copy ("You rode N cm above your start height") can never disagree. The head-path formula shape mirrors onto the hip; its constant is re-derived (§4). Torso tilt (today's *streamed*-walk score input) is deliberately NOT used in v1 — splitting score and cue across two physical quantities was rejected as incoherent. Revisit as a refinement, not a v1 blend. |
| M5–M7 composites | ✅ as-is | derived re-weightings of M1–M4 (already honestly labeled COMPOSITE) |

**The signed lateral quantity, precisely**: `meanLateralM` (Solo) = the time-weighted mean of the
**signed perpendicular offset of the hip path from the travel line** (+ = walker's right relative
to travel direction), with turn windows excluded (the heading EMA is garbage for ~1.5 s mid-turn
and would pollute the mean). The M4 *score* keeps the abs ankle-offset input exactly as the
camera-world path computes it today. Note the travel-anchored sign does NOT flip meaning at the
turn — that is precisely why the Phase C one-way drill can legitimately re-enable left/right
cues later. In v1 the coach still never names a side: the ported `coach.ts` gate requires
`oneWayRoute`, and the turn-window exclusions make the signed mean conservative.

> **LANDED (A1): the §3 producer exists in TS** — `soloDeriveWorld` (src/pose-derive.ts), an
> additive variant sharing `PoseDeriveState` with the web `deriveWorld` (which is byte-unchanged),
> locked by the `solo-derive` golden family (frame-invariance twins included). Two honesty
> mechanisms proved NECESSARY during implementation and are part of the definition:
> **(a) heading-stability gate** — the lateral offset integrates only while the heading EMA's
> magnitude ≥ `SOLO_HEADING_STABLE_MIN` (0.9; the EMA of unit directions is its own confidence:
> warm-up and mid-turn flips pull it toward 0). Without it, the first ~1.5 s of heading
> convergence integrated a permanent phantom offset of about one sway amplitude, which let a
> CLEAN walk name a side at full |mean|/absMean consistency.
> **(b) lateral baseline** — the reported offset is the raw integral minus its own running mean
> over its first `SOLO_LATERAL_BASELINE_SEC` (1.0 s ≈ one sway period), re-centering the
> reference on the sway MEAN instead of the arbitrary sway phase at measurement start (the
> posture walk-start-baseline law mirrored). With both, the emitted normal-walk vectors land at
> the pure-sway analytic (absLat 0.018 ≈ 2A/π, signed mean ~0.004). During a turn window
> (caller's `turnExcluded` flag, or the stability gate tripping on its own) the offset FREEZES,
> no sample lands, and the live tap reads null. Posture (M1) landed exactly as specified above:
> signed hip-height drift vs a 0.5 s walk-start baseline (the head path's law on the hip), one
> quantity feeding `livePostureM`/`postureDriftM` AND the M1 score
> `96 − |dev|EMA × SOLO_POSTURE_SLOPE`.

Schema-honesty consequences (Appendix A1/A5 risks):
- Solo records ship under a **new schema id** (`xrunway.walk.solo.v1`) whose units map tells the
  truth: lateral = "signed offset from the walker's travel line", posture = "hip-height drift vs
  walk-start baseline", plus a **comparability note** — Solo M1/M4 are redefined channels, so a
  Solo PASS is not numerically interchangeable with a headset PASS.
- `SessionRecord.layout` (world-frame runway placement) cannot be honestly populated — the Solo
  schema stamps only the measured line length. **Never emit fake world coordinates.**
- Vision-fallback devices (no ARKit body tracking) get an explicit "Solo needs 3D body tracking"
  block screen (mirroring the CameraBlock pattern) — image-space pose must never silently score.

## 4. Architecture

```
ARBodyTracker (existing, 60 Hz world-space PoseFrame)
     │  via a new `PoseFrameSink` protocol at publish()   ← relay conforms unchanged
     ▼
XRunwayCore (new, pure Swift module — no UIKit/ARKit imports, XCTest-drivable)
  WalkStats accumulator ── scoring (deriveFromPoseWorld port) ── LiveCoachPolicy ── CoachReport
     ▼                                                              ▼
SoloSessionEngine (new: setup → positioning → countdown → walking → summary)
     ▼                                                              ▼
Solo UI (new files under Sources/Solo/) ······ CoachVoice (AVSpeechSynthesizer + earcons)
```

Key seams (Appendix A3):
- **Attach, don't rewrite**: the tracker gains a `PoseFrameSink` protocol; `PoseRelayClient`
  already satisfies the signature (declare the requirement `async` — the relay is an actor and
  the existing call site already awaits it). The relay path keeps the **same call sites and the
  same one-Task-per-frame scheduling** ("byte-identical" in spirit; the property type changes to
  the protocol), and the proven streaming pipeline is re-verified on-device after the refactor.
- **Timing**: `PoseFrame.t` is **wall-clock** milliseconds and can step backward (NTP/user clock
  change) — the codebase already documents this and uses monotonic time for its own timing. The
  sink payload therefore carries the **monotonic ARKit anchor timestamp** (seconds — one unit
  conversion, done once); `frame.t` stays payload-only and never feeds `poseDt`.
- **Framing gate reused wholesale**: `FramingStatus == .good` gates positioning AND scoring;
  `.unknown` = suspend, not error. Critical: in AR mode streamed joints report score 1.0 even
  when limbs are estimated — visibility must come from the framing machinery, never keypoint
  presence.
- **Mode switch**: `enum AppMode { solo, stream }` via `@AppStorage`, a glass segmented pill on
  the camera screen. ContentView (653 lines) hosts only the switch + capture chrome; all Solo
  screens are new files. `Brand` moves from ContentView.swift to `Sources/Theme/` (mechanical
  extraction) so Solo files compose from the Liquid Glass tokens without importing the capture
  screen.

## 5. Module-by-module port map

| Web module | Ports how | Phone-only delta |
|---|---|---|
| `src/walk-stats.ts` | 1:1 Swift class (pure scalar math, zero-alloc) | source enum collapses; lateral/posture channels carry the §3 redefinitions |
| `src/metrics.ts` `deriveFromPoseWorld` + constants | Extract to the pure core; keep every constant, the `1−exp(−k·dt)` EMA forms (frame-rate independent), `clampScore` **before** compositing, ring-buffer MAD rhythm, fresh-frame gating per anchor update | drop head path + source-handoff machinery but **carry its protection as the §2 gap rule**; keep single-hip fallback (ARKit occlusion is real); M1 becomes the hip-height mapping (§3) with a re-derived constant |
| `src/modes.ts` | data table, emitted into the golden file | per-mode idealPace/passThreshold/weights must ride along or coach copy becomes false |
| `src/coach.ts` | pure function port; stable sort needs an explicit index tiebreak (Swift sort isn't stable); `toFixed(2)` → `String(format:)` and the render-identical guard compares **formatted strings** | lateral cue magnitude-only in v1 (the gate requires `oneWayRoute`; turn-window heading noise is the other reason — NOT a sign flip, see §3); one SwiftUI summary replaces two web surfaces; **Solo copy variants** (a small table, part of the golden spec): footwork note + M4 explainer say "your line of travel" not "centerline", live cue "Find the centerline." → "Find your line." |
| `src/coach-live.ts` | pure policy port: settle/final windows, 2.5 s hysteresis, 9 s cooldown, per-kind caps, priority, `isFinite` channel honesty, gate-clears-faults; turn suppression re-fires **per lap** | **NEW logic (not a port): repeated turn detection** via travel-heading reversal (distance-peak ruled out by multi-lap, §2); bias toward over-triggering (a false turn wrongly clears clocks for 4 s = benign; a missed turn = false cues = not benign). **Threshold re-derivation is a Phase A task, not an option**: PACE 0.25 m/s carries; LATERAL 0.20 m was tuned against ~5 cm head sway but Solo's channel bakes in 0.10–0.15 m of stance width (it would chronically over-fire) and POSTURE 0.06 m was derived from the head-path curve Solo drops — both must be re-derived against the §3 channel definitions |
| `src/coach-voice.ts` | AVSpeechSynthesizer + AVSpeechUtterance; **rate scale differs** (web 1.05 is a multiplier; AVSpeech rate is 0..1 with ~0.5 = normal — "slightly brisk" is a small bump, not 1.05); generation-token + watchdog patterns MUST survive (delegate callbacks are async and calls/Siri can kill an utterance without a clean callback); earcons contour-equivalent per the recipes (bit-exactness is NOT required — the contour language is the contract) | v1 ducking = **other apps' audio only** via the audio session (`.playback` + `.duckOthers`) — there is no music engine on the phone; the web's counted-hold ×0.65 own-music law is specified in Appendix A2 and applies **when/if per-mode music lands** (open founder call) |
| `src/music-prefs.ts` / `src/coach-prefs.ts` law | UserDefaults with the same sanitize-on-load; "mute means silence, coach included" ports verbatim (v1: the coach toggle + one master volume) | iOS must additionally define the law against the **hardware silent switch** (`.playback` ignores it, `.ambient` obeys it) — open decision §8 |
| `src/session-grading.ts` | ~90 lines, wholesale port (mind `>=` vs `>`) | `rowMatchesTrainee` ported for compatibility, not exercised in v1 (single-user) |
| `src/progress.ts` | pure port: trends, best, rolling, MASTERED (3-of-last-5 vs per-row bar) | carries `session-grading` with it (runtime import); Phase B |
| `src/session-recorder.ts` schemas + envelope | Codable structs, all post-v1 fields Optional (legacy tolerance pattern); share-sheet JSON export with the envelope shape verbatim; CSV (metadata-block + injection escaping contract) defers | new schema id + comparability note per §3; `synthetic` kept (default false) for cross-app compatibility; history = a new `WalkHistoryStore` (JSON in Application Support / SwiftData) — **there is no existing store to extend on the phone** |

Numeric ground rules (Appendix A4): Swift uses **Double everywhere** (the C# port's float choice
is why it can't be bit-exact); one `jsRound()` helper reproduces JS `Math.round` half-up semantics
at every rounding site (Swift's default rounds −2.5 → −3, JS → −2 — the divergence would surface
exactly in the signed channels that feed spoken copy). **Port from the current TS, never from the
C# core** — the C# is existence proof but has drifted behind three fixes Solo depends on
(fresh-frame gating, measured-motion heading, per-mode idealPace).

> **LANDED (A1): the re-derived thresholds + the copy variants exist in TS.**
> `SOLO_POSTURE_SLOPE = 280` (head slope 350 × head/hip clean-walk bob ratio 0.010/0.0127 →
> 275.6, rounded to 280; clean walk scores 92.4 vs head 92.5 — the emitted vectors land there),
> `SOLO_POSTURE_CUE_M = 0.075 = 21/280` (the same score-crosses-the-lowest-pass-bar rule that
> produced the head gate 0.06 = 21/350), `SOLO_LATERAL_CUE_M = 0.15` (the hip-path channel
> carries NO stance width — that lives only in the ankle-offset M4 score input — and its noise
> is ~3 cm hip sway: 0.15 is 5× noise, effective sustained trip ~0.18 m, matching the web gate's
> ~0.25 m effective trip on its wider head channel), `PACE_DELTA_CUE_MPS = 0.25` carries
> unchanged. All derivations documented at the constants (src/coach-live.ts, src/pose-derive.ts)
> and locked by the `coach-tables` golden family's `solo-cue-thresholds` case. The §5 Solo copy
> variants are single-sourced in src/coach-copy.ts and emitted as the `copy-variants` family
> (web column built from the real tables/builders with `{cm}`/`{side}` placeholders); the five
> copy/earcon tables are emitted whole as `coach-tables` (the A4 disposition, now real).

## 6. Golden vectors — the drift lock

The single biggest risk of a second implementation is silent divergence. The lock:

1. **Generator** `scripts/gen-golden-vectors.mjs` imports the *real* TS modules and reuses the
   vitest suites' own case helpers, so tests and vectors are provably the same truth. Pipeline
   rule: **vitest green → emit vectors (stamped with git SHA) → Swift XCTest consumes.** Never
   hand-copy expected values.
2. **Prerequisite refactor, protected**: `deriveFromPoseWorld` is today a private method on the
   @iwsdk-coupled MetricsSystem reading ~14 instance fields plus shared reset machinery, and **no
   vitest covers it** — so the extraction is unprotected until vectors exist, and vectors need the
   extraction. The escape: a **characterization step** — run the pre- and post-refactor builds
   against the same synthetic frame tape (git worktree A/B) and require identical output before
   the extraction lands. Budget it as real work (§7).
3. **Format**: one JSON per module under `test/golden/` —
   `{ schema: "xrunway-golden/1", module, generatedBy: {script, gitSha, date}, cases: [{name, input, expect}] }`,
   `{"$num":"nan"}` sentinel for non-finite. Case shapes per module as specified in Appendix A4.
4. **The walk-replay vector** (highest value): one synthetic walk in → expected 6 Hz snapshots +
   2 Hz cue timeline + final WalkStats + CoachReport out — **emitted at both 30 Hz and 60 Hz**
   (Solo consumes full-rate frames at publish(); the web path never exceeds 30 Hz — the 60 Hz
   vector mechanically proves the rate-independence the EMA forms promise). Plus the **gap-tape
   vector** (§2's dropout rule) and the **frame-invariance pair** (every pose-derive walk emitted
   raw and rigidly transformed ~37°/translated with identical expected outputs).
5. Tolerances — **the shipped rule (test/golden-format.ts)**: exact for strings/ints/bools/
   nulls/rounded fields; raw doubles within **1e-9 absolute + 1e-6 relative**. The relative term
   is NOT slack in the math: pose-derive targets pass through a `Float32Array`
   (src/pose-derive.ts), so the emitted expects are float32-quantized and a Double-throughout
   Swift port (mandated above) lands within ~half an f32 ulp (~6e-8 relative) of them — a
   1e-9-relative comparator would fail on quantization noise, not divergence. (Measured
   rigid-twin rotation noise is ≤ ~3e-15 relative — it is NOT the driver of the 1e-6 term.
   If tighter comparison is ever wanted, mirror the quantization in Swift with a
   `Float(x)` round-trip on target fields.) Vectors include the first frames of every walk
   (EMA warm-up sensitivity). Analytic-ground-truth anchors ride along **in the generator
   itself** (assert-then-emit: gap-tape/walk-replay pace + cadence vs simulation truth,
   solo-derive clean-line/slouch closed forms, the nan-junk == normal-walk dt/anchor
   invariant), because TS-generated vectors pin "matches the web", not "is physically
   correct".
6. **String exactness is a v1 invariant**: Solo is en-only; golden vectors assert exact strings,
   including the small Solo copy-variant table (§5). Localization, if it ever comes, moves string
   comparison behind a copy-table indirection — a deliberate future breaking change to the
   vectors, not a bug.
7. A **Swift unit-test target** is added to project.yml (the 385-test web culture currently has
   no Swift counterpart).

> **LANDED (A1): the drift lock is now self-checking.** Eleven families ship under test/golden/
> (walk-stats, coach, coach-live, progress, pose-derive-world, **solo-derive**, gap-tape,
> walk-replay, modes, **coach-tables**, **copy-variants**). Web-side staleness nets:
> `test/golden-replay.test.ts` re-executes every behavioral family's checked-in inputs through
> the real modules on each vitest run (runners shared with the generator via
> `test/golden-replay.ts`), the table families are deep-compared against their live exports in
> `test/golden-freshness.test.ts`, and `npm test` = `vitest run && node
> scripts/gen-golden-vectors.mjs --check` (rebuild-in-memory vs disk, generatedBy ignored,
> nonzero exit on any divergence). Provenance rule: **emission refuses a dirty src/scripts/test
> tree** — the stamped sha must reproduce the bytes; the honest flow is commit code → regen at
> the clean HEAD → commit vectors. Bail dt semantics: the hip anchor owns its timestamp
> (`posePendingDt` — see the §5 receipts), so the Swift port implements the
> accumulated-interval span deliberately. The walk-replay vector runs the §2 per-lap turn model
> (marks at BOTH ends, 5 reversals on a 9 m line — 9 m, not 6, because per-lap suppression on a
> 6 m line suppresses every cue, exactly what the §2 short-line warning predicts) and the
> walk-stats ops schema carries `setLive`/`readLive` for the live-tap surface.

## 7. Phased plan (honest sizing)

**Phase A — the training loop (~2 to 2.5 weeks, in three sub-phases)**
- **A1, web-side (~3 days)**: characterization harness → `deriveFromPoseWorld` extraction to a
  pure module (the one genuinely risky refactor; §6.2) → golden generator → per-module vector
  families incl. gap-tape and frame-invariance pairs. **DONE — and extended past the original
  scope so A2's exit is satisfiable**: the §3 producer landed in TS (`soloDeriveWorld` + the
  `solo-derive` family — previously the derive vectors pinned torso-tilt M1 and dark
  lateral/posture channels, making "§3 mapping + all vectors green" contradictory), the
  re-derived thresholds/copy variants/tables are emitted (`coach-tables`, `copy-variants`),
  the dt/anchor bail semantics are fixed and pinned, and the drift lock is self-checking
  (replay net + `--check` + dirty-tree provenance guard; §6 LANDED note).
- **A2, Swift core (~3–4 days)**: XRunwayCore ports (walk-stats, pose-derive incl.
  `soloDeriveWorld` — the §3 M1 mapping + re-derived thresholds now locked by the solo-derive
  and coach-tables families, coach + the copy-variant substitution, coach-live with repeated
  turn detection v0 per the §2 both-ends decision), XCTest target, all vectors green.
- **A3, delivery + UI + device (~4–5 days)**: PoseFrameSink seam (+ on-device streaming
  re-verification), SoloSessionEngine (§2 protocol incl. positioning + audible countdown),
  CoachVoice (AVSpeech + audio session + interruption handling + earcons), mode switch, setup
  screen (line capture by walking it, mode pick, tips), countdown + summary screens (verdict,
  coach notes, steps/cadence — **no delta/BEST/MASTERED yet**), turn-detection tuning on real walks.
- Exit: a full solo walk on a real phone with voice coaching and a verdict; all vectors green;
  streaming pipeline re-verified.

**Phase B — memory (~3–4 days)**
WalkHistoryStore, trends/best/MASTERED parity, delta-vs-last on the summary, share-sheet JSON
export under the Solo schema with the comparability note, per-mode records screen. Exit:
history/trends/export vectors green; a coach can read a Solo JSON next to a web JSON without
confusion.

**Phase C — optional (scope on demand)**
Phone-rendered AR line for setup/replay; the one-way "walk toward the phone" drill (legitimately
re-enables left/right cues — travel-anchored sign, §3); CSV export with the metadata-block
contract; video recording, if ever, lands here with its privacy story.

## 8. Risks and open decisions

- **TS/Swift drift** — mitigated by §6; the golden pipeline is *the* deliverable, not an add-on.
- **Distribution — FOUNDER CALL, gates §1's product framing**: today's build is a free-team dev
  install (7-day provisioning). The accessible-trainer story requires TestFlight/App Store: paid
  developer account, App Store review of a camera-based body-analysis app, a privacy nutrition
  label + policy, and the iOS 26-only floor. Decide before Phase A is scheduled.
- **Turn detection** is genuinely new logic with no web receipt; ships flagged, biased to
  over-trigger, tuned on-device, with its own vectors once the heuristic is fixed.
- **Threshold re-derivation** (lateral + posture) is mandatory Phase A work, not tuning polish (§5).
- **"Mute means silence" on iOS** needs a definition against the hardware silent switch and
  system volume (recommend: `.playback` — the ring switch does not silence a coach the trainee
  explicitly enabled; the in-app toggle is the mute). FOUNDER CALL.
- **Interrupted cues** (calls/Siri): a spoken-but-unheard cue stays spent (web semantics;
  re-firing risks nagging). Interrupted *walks* are discarded in v1 (§2). FOUNDER CALL if either
  feels wrong on-device.
- **Accessibility**: mid-walk coaching is audio-only by design and haptics don't reach a propped
  phone — for deaf/HoH trainees the **post-walk summary is the accessible surface** (commit to
  VoiceOver + Dynamic Type on setup/summary screens; the tracked monospaced glass style needs a
  Dynamic Type stance). Watch-mirrored haptic cues are honest future work, not v1.
- **Battery/thermal**: camera + Neural Engine body tracking + screen forced on, across multi-walk
  sessions, will heat and drain. `ProcessInfo.thermalState` gates a plain warning; capture-FPS
  degradation under throttling is tolerated by the dt-based EMA math (say so in the UI copy, not
  just here). Decide idle-timer behavior *between* walks.
- **Per-mode music** on the phone remains an open founder call; the own-music ducking law is
  specified and waits for it.
- **`NSCameraUsageDescription`** currently says "stream a pose skeleton to the headset app" —
  reword in project.yml (never the generated plist) to cover on-device training.
- **ContentView scope creep** (653 lines): all Solo UI in new files; extraction of shared private
  helpers is mechanical-only.

---

*Appendix A follows — the generated evidence map with file:line receipts. Where this narrative
and the appendix disagree, the appendix (and the code it cites) wins; §2–§3's walk protocol and
redefinition decisions are narrative-level design on top of those facts.*
# SOLO-MODE.md — Appendix A: evidence map (generated from the design survey)

Every fact below carries a file:line receipt from the tree at the time of authorship.

## A1. Scoring core

### WalkStats contract — per-walk real-measurement accumulator (src/walk-stats.ts)

- WalkStats fields: meanPaceMps, idealPaceMps, paceDeltaMps, meanLateralM, meanAbsLateralM, postureDriftM, steps, cadenceSpm, source — all nullable except idealPaceMps, steps, source.  
  `src/walk-stats.ts:50-60`
- WalkStatsSource is "head" | "camera-world" | "camera-image".  
  `src/walk-stats.ts:21`
- Sign convention lateral: meanLateralM/meanAbsLateralM are time-weighted means of the SIGNED centerline offset in the mapped runway frame; POSITIVE = trainee's RIGHT walking outbound; near-zero mean beside large abs-mean = weaving that averaged out.  
  `src/walk-stats.ts:27-33`
- Sign convention posture: postureDriftM is the time-weighted mean SIGNED head-height deviation from the walk-start baseline; POSITIVE = above baseline (rose/on-toes), NEGATIVE = below (slouch).  
  `src/walk-stats.ts:34-36`
- paceDeltaMps = meanPaceMps - idealPaceMps (POSITIVE = faster than mode ideal); cadenceSpm = steps / (durationSec / 60), null when no steps or non-positive duration.  
  `src/walk-stats.ts:37-41, 224-236`
- Step debounce: STEP_DEBOUNCE_SEC = 0.15 s between COUNTED footstrikes (mirrors metrics.ts STEP_MIN); no upper bound — a strike after a long pause still counts.  
  `src/walk-stats.ts:69, 184-190`
- All channels are duration-weighted: addPace/addLateral/addPosture accumulate value*dtSec and dtSec separately, so mixed cadences (head at app frames vs camera at true inter-pose interval) average correctly; samples with dtSec<=0 or non-finite values are dropped.  
  `src/walk-stats.ts:79-84, 157-177`
- addLateral also accumulates |lateral|*dt for meanAbsLateralM alongside the signed sum.  
  `src/walk-stats.ts:165-170`
- Live raw tap fields for the 6 Hz recorder / 2 Hz coach: livePaceMps (the speed EMA), liveLateralM (latest SIGNED centerline offset), livePostureM (latest SIGNED head-height deviation); each goes null while the active source doesn't measure that channel.  
  `src/walk-stats.ts:86-100`
- reset(idealPaceMps) rearms everything per walk and locks the mode's ideal pace; resetLateral() clears ONLY the lateral channel on a mid-walk runway remap (pace/posture/steps/source time survive).  
  `src/walk-stats.ts:117-147`
- finalize(durationSec) returns null only if NO channel ever produced a sample; source = dominant derivation path by accumulated time, ties resolving head > camera-image > camera-world (head checked first, then camera-image, then camera-world must strictly exceed).  
  `src/walk-stats.ts:197-218`
- Rounding: pace/lateral/posture values round to 3 decimals (round3), cadenceSpm to 1 decimal (round1).  
  `src/walk-stats.ts:71-77, 220-236`
- The class is dependency-free (no @iwsdk/core, no DOM) and zero-allocation per ingest by design — trivially portable.  
  `src/walk-stats.ts:13-17`

**Porting:** Ports 1:1 to a Swift struct+class; it is pure scalar math with no engine dependency. For solo mode the source enum collapses (only one derivation path — call it camera-world or a new "phone" source), but keep the debounce and duration weighting exactly. The lateral and posture channels need phone-only redefinitions (see classification section) or stay null.

**Risks:** meanLateralM/meanAbsLateralM are DEFINED against the mapped runway centerline (runway-layout RIGHT axis) — a phone-only port that feeds travel-heading lateral into this field silently changes its meaning; the design doc must either rename the field or document the redefinition. postureDriftM is likewise defined as head-height drift, which no phone path produces today.

### Shared scoring pipeline — constants, smoothing, publish (src/metrics.ts)

- Seven metrics in canonical order: posture (M1), pace (M2), rhythm (M3), footPlacement (M4), presence (M5), confidence (M6), presentation (M7); target[] indices 0-6 follow this order.  
  `src/metrics.ts:57-69, 869-875`
- Tuning constants: PUBLISH_INTERVAL = 1/6 (~6 Hz), SCORE_MIN = 40, SCORE_MAX = 98, NEUTRAL = 62, default IDEAL_PACE = 0.85 m/s (overridden per run by the mode), BOB_THRESHOLD = 0.004 m (head bob hysteresis), STEP_MIN = 0.15 s, STEP_MAX = 1.2 s, RING_SIZE = 8.  
  `src/metrics.ts:78-90`
- clampScore clamps raw scores to [40, 98] before compositing.  
  `src/metrics.ts:92-94`
- Display smoothing runs every app frame: rampIn = walkTime*0.5 for the first 2 s (bars ramp from NEUTTRAL=62), blend = 1 - exp(-3*delta); goal = NEUTRAL + (clampScore(target) - NEUTRAL) * rampIn; smooth += (goal - smooth) * blend.  
  `src/metrics.ts:297-306`
- A rounded snapshot copy publishes at ~6 Hz (publishAcc accumulates delta, modulo PUBLISH_INTERVAL).  
  `src/metrics.ts:308-322`
- Per-walk reset (beginWalkTracking): idealPace locked from the active mode's signal (default DEFAULT_MODE), stats.reset(idealPace), smooth/target filled with NEUTRAL, all EMAs zeroed, pose heading zeroed and marked invalid, globals.lastStep cleared.  
  `src/metrics.ts:327-374`
- Rhythm score (identical formula in all three paths): needs >= 3 intervals in the ring buffer; cv = MAD/mean of up-to-8 step intervals; rhythm = 100 - cv*220; default 58 (world/head) or 60 (image) until 3 intervals exist.  
  `src/metrics.ts:684-696, 835-847, 513-525`
- Composites (identical in all three paths): sessionRamp = min(walkTime/45, 1); presence = 0.4*posture + 0.3*rhythm + 0.3*pace; confidence = 0.25*pace + 0.25*posture + 0.25*rhythm + 0.15*foot + sessionRamp*10; presentation = 0.25*posture + 0.25*rhythm + 0.2*foot + 0.15*pace + 0.15*presence — all from CLAMPED inputs (presence into presentation is the unclamped-composite value computed from clamped parts).  
  `src/metrics.ts:707-720, 857-865, 535-548`
- Keypoint acceptance gate: kpOk requires detector confidence score >= 0.3 **AND finite x/y/z
  coordinates**; a non-finite coordinate is treated exactly like a low score — absent — so the
  single-hip/sparse fallbacks own the frame (pre-gate, a NaN-coordinate hip with a healthy score
  poisoned the speed/upright/bob EMAs PERMANENTLY — the nan-junk vector family locks the fix).
  The same law applies to the caller-supplied delta: a non-finite/non-positive dt is sanitized
  to 0 (a dark frame; every EMA holds), mirroring walk-stats' `!(dtSec > 0)` convention — the
  port's input-validation obligation, pinned by the delta-junk family.  
  `src/pose-derive.ts (kpOk + the deriveWorld delta sanitize)`
- Pose frames are derived ONLY when frame.t changes (stream <= 30 Hz vs 72-90 Hz app loop); poseDt = (frame.t - poseLastT)/1000 — frame.t is a performance-clock timestamp in MILLISECONDS.  
  `src/metrics.ts:269-282; src/external-tracker.ts:47-48`
- resetCadence on every camera<->head source switch clears the interval ring, bob signs, poseLastT and poseHavePrev, so the first resumed frame carries zero stats weight and re-seeds the hip anchor instead of differencing across a dropout gap.  
  `src/metrics.ts:376-403`
- Mid-walk runway remap (compiledPath signal fires) calls stats.resetLateral() and zeroes latEma so old-centerline lateral samples never blend into the persisted means.  
  `src/metrics.ts:217-236`

**Porting:** All constants, the ramp/blend smoothing, the ring-buffer MAD rhythm, and the composites port verbatim. The Swift solo loop has ONE source, so resetCadence/source-handoff machinery disappears — but keep the fresh-frame gating (derive per ARKit anchor update, not per render frame) and keep STEP_DEBOUNCE_SEC. The delta-dependent EMA form alpha = 1 - exp(-k*dt) is frame-rate independent and should be kept exactly (k values: 2 speed, 1.5 heading/lateral/posture, 1.2 bob baseline, 3 display blend).

**Risks:** The composites feed clamped [40,98] inputs, so composite floors are ~40+ even for terrible walks — a port that skips clampScore before compositing produces different numbers. sessionRamp*10 means confidence structurally rises over the first 45 s regardless of performance; a fact-checker should know this is by design.

### deriveFromPoseWorld — the phone-native path, quantity by quantity

> **A1 errata (locations):** the world derivation was extracted VERBATIM out of MetricsSystem
> into the pure module **src/pose-derive.ts** (`deriveWorld` + `PoseDeriveState` + `kpOk` +
> the shared tuning constants; `soloDeriveWorld` is the §3 Solo variant); metrics.ts keeps only
> a thin `deriveFromPoseWorld` wrapper feeding poseDt/walkTime/idealPace/state/stats/target,
> plus the head/image paths and the system wiring (whose NEUTRAL/PUBLISH_INTERVAL/ramp/blend
> now live in **src/metrics-wiring.ts**, and COACH_SAMPLE_SEC in pure src/coach-live.ts).
> `src/metrics.ts:...` line references in the receipts below describe the pre-extraction tree
> they were surveyed from; the behavior statements remain accurate except where a LANDED/errata
> note says otherwise.

- Input: PoseFrame with space "world" — keypoints in METERS in the sender's ARKit world frame, Y up, gravity aligned; keypoint names follow BlazePose/COCO; sparse map allowed.  
  `src/metrics.ts:561-566; src/external-tracker.ts:45-61`
- Hip anchor: midpoint of leftHip/rightHip when both pass the acceptance gate; single-hip fallback; bail (hold previous targets) when neither hip is usable. **Bail holds the previous targets, the hip anchor AND the anchor's timestamp** (`PoseDeriveState.posePendingDt` banks the dark frame's dt): the recovery frame measures displacement AND time back to the anchor frame (`span = delta + posePendingDt`), so N dark frames can never produce an (N+1)x pace sample. A REAL outage (resetCadence / the §2 gap rule) still re-seeds with zero weight — the accumulated-interval math applies only WITHIN a walk's tolerated bails. The Swift port must implement this deliberately: speed = displacement / (now − anchorT), every EMA folds over that same span.  
  `src/pose-derive.ts:211-235`
- Pace: speed = hypot(hip dx, hip dz)/poseDt in world XZ, hard-clamped to 4 m/s (tracking-jump clamp); raw speed feeds stats.addPace (true m/s, pre-score); poseSpeedEma alpha = 1 - exp(-2*delta); livePaceMps = poseSpeedEma.  
  `src/metrics.ts:593-603`
- Travel heading: unit hip-displacement direction EMA'd with alpha = 1 - exp(-1.5*delta), updated only when displacement mag > 1e-4 m; poseHeadingValid becomes true on first real motion.  
  `src/metrics.ts:605-612`
- Heading is deliberately NOT seeded from the runway layoutYaw because the iPhone ARKit frame is unregistered to the runway frame; it starts (0,0)/invalid and footwork is unmeasured until real travel is integrated.  
  `src/metrics.ts:359-364, 159-161`
- Footwork lateral: for each visible ankle, lat = |(ax-hx)*(-hzn) + (az-hz)*hxn| — the perpendicular distance from the ankle to the travel line through the hip; averaged over available ankles; poseLatEma alpha = 1 - exp(-1.5*delta); only computed while poseHeadingValid.  
  `src/metrics.ts:614-636`
- Posture: torso uprightness = |vy| / ||shoulder-mid - hip-mid|| (full 3D length); 1.0 = perfectly vertical; poseUprightEma alpha = 1 - exp(-1.5*delta), initialized to 0.92 per walk; requires BOTH shoulders.  
  `src/metrics.ts:642-651, 357`
- Rhythm/footstrikes: hip-Y bob vs an EMA baseline (alpha = 1 - exp(-1.2*delta), seeded to first hip y); threshold TH = 0.008 m; an UP-crossing (dev > TH while sign <= 0) IS a footstrike -> stats.addStep(walkTime); the interval joins the 8-slot ring only if within [0.15, 1.2] s.  
  `src/metrics.ts:653-676`
- Score mappings (true-metric): pace = 44 if poseSpeedEma < 0.05 else 100 - |poseSpeedEma - idealPace| * 70; posture = 40 + ((poseUprightEma - 0.9)/0.09) * 58; footPlacement = 100 - poseLatEma * 240; rhythm = 100 - cv*220 (default 58).  
  `src/metrics.ts:678-700`
- Pace scoring uses this.idealPace — the MODE's ideal pace locked at walk start — so mode differentiation works on this path.  
  `src/metrics.ts:682, 331-332`
- Stats channels on this path: noteSource("camera-world"), addPace (true m/s), addStep — YES; liveLateralM = null (no registered centerline) and livePostureM = null (torso tilt is a different quantity than head-height drift, honest-dark), so finalize() yields null meanLateralM/meanAbsLateralM/postureDriftM for a camera-world-only walk.  
  `src/metrics.ts:567-576; src/walk-stats.ts:90-97`

**Porting:** This IS the solo-mode scoring core: every quantity here is frame-invariant (speed magnitude, gravity-aligned hip bob, torso tilt vs gravity, lateral from travel direction) and matches the pose-relay review's honesty ruling for an unregistered ARKit frame. A Swift port reproduces this function verbatim, swapping PoseFrame for ARKit body-anchor joint transforms (hip = root/hipJoint, shoulders, ankles in world space) and poseDt for the anchor timestamp delta in seconds (drop the /1000 ms conversion or keep frame.t in ms consistently).

**Risks:** The heading EMA never re-invalidates: on an out-and-back walk the ~1.5 s heading flip at the turn transiently inflates ankle lateral (heading mid-rotation is not the true travel line). Ankle-from-HIP perpendicular distance also includes natural stance width (~0.1-0.15 m), so footPlacement = 100 - lat*240 bakes stance width into the score — fine as the shipped tuning, but the doc should not describe it as pure centerline deviation. Posture requires both shoulders (single-shoulder frames freeze the upright EMA).

### deriveFromHead — headset path (what solo mode replaces) (src/metrics.ts:733-877)

- Source of truth is player.head world position (the Quest HMD) — no skeleton.  
  `src/metrics.ts:736`
- Posture baseline: head height averaged over the FIRST 0.5 s of the walk (running average); a re-seed guard sets baselineY to the current head y if the head path first runs after the 0.5 s window with zero baseline samples.  
  `src/metrics.ts:741-770`
- Pace: horizontal head velocity hypot(dx,dz)/delta, clamped to 4 m/s, fed raw to stats.addPace, EMA alpha = 1 - exp(-2*delta) — same shape as the world-pose path.  
  `src/metrics.ts:772-779`
- Rhythm: head-Y bob vs EMA baseline (alpha = 1 - exp(-1.2*delta)); BOB_THRESHOLD = 0.004 m (half the world path's 0.008 hip threshold); up-crossing = footstrike; same ring/interval window.  
  `src/metrics.ts:781-802, 86-89`
- Posture quantity: heightDevSigned = headY - baselineY feeds stats.addPosture and livePostureM (SIGNED, + = above baseline); the score uses heightDevEma of |dev| (alpha 1 - exp(-1.5*delta)): posture = 100 - heightDevEma * 350.  
  `src/metrics.ts:804-812, 849`
- Footwork quantity: latSigned = projector.projectRoute(headX, headZ).lateral — SIGNED perpendicular offset from the mapped runway's active walk segment (U-route aware); feeds stats.addLateral and liveLateralM; score uses latEma of |lat|: footPlacement = 100 - latEma * 240.  
  `src/metrics.ts:814-825, 850`
- projectRoute returns cumulative route-along plus signed lateral against the compiled segmented path (spine for straight/T/X, legA->base->legB for U).  
  `src/runway-shape.ts:683-724`
- Pace score identical to world path: 44 if speedEma < 0.05 else 100 - |speedEma - idealPace| * 70; composites identical.  
  `src/metrics.ts:829-865`

**Porting:** Drops entirely for phone solo mode — there is no headset and no mapped runway. The port keeps its two score formulas that differ from the world path only as reference: posture 100 - heightDevEma*350 (head-height) and the 0.004 bob threshold are head-specific tunings, NOT to be copied onto hip data. Its posture and lateral formulas are exactly the two channels the world path leaves honest-dark.

**Risks:** None for the port itself; the risk is documentation drift — any Solo-mode claim that postureDriftM or meanLateralM 'work like the headset version' is false, because both are defined by this path's baseline/centerline, which don't exist on the phone.

### deriveFromPose — camera-image proxy path (src/metrics.ts:422-557)

- Input is a normalized-image-coordinate skeleton (0..1, y-down, side-camera assumption: trainee walks ACROSS the frame); explicitly documented as camera-relative and uncalibrated.  
  `src/metrics.ts:416-421, 448-451`
- It measures NO true-unit stats channels: only noteSource("camera-image") and footstrikes feed WalkStats; all three live taps are set null.  
  `src/metrics.ts:423-430`
- Its tunings are image-unit-specific: pace = 52 if ema < 0.01 else 100 - |ema - 0.18|*180; bob threshold 0.012 (normalized units, strike on DOWN-crossing since a foot lift decreases image y); posture = 40 + ((upright - 0.82)/0.17)*58; footPlacement = 100 - latEma*260.  
  `src/metrics.ts:452-457, 478-505, 508-528`
- Footwork here is ankle lateral spread from the hip x in image coords (not a travel line).  
  `src/metrics.ts:471-476`

**Porting:** Drop for solo mode. On-device ARKit body tracking always yields world-space joints, so the browser-MediaPipe image proxy has no role on the phone. Do not port its constants (0.18, 180, 0.012, 0.82/0.17, 260) — they are normalized-image tunings that would be wrong on metric data.

**Risks:** Only that a port might accidentally borrow this path's constants or its down-crossing step semantics; the world path uses up-crossings and different thresholds.

### Training modes — all four modes' scoring constants (src/modes.ts)

- TrainingMode carries walkSeconds (walk countdown length), idealPace (m/s the pace metric scores against), passThreshold (checkbox/verdict gate), weights (7 metric weights that MUST sum to 1), plus copy and intensity.  
  `src/modes.ts:17-37`
- beginner (01): walkSeconds 60, idealPace 0.85, passThreshold 78, weights posture .2, pace .15, rhythm .15, footPlacement .2, presence .1, confidence .1, presentation .1, intensity 0.35.  
  `src/modes.ts:40-61`
- highfashion (02): walkSeconds 75, idealPace 0.72, passThreshold 80, weights posture .2, presence .2, presentation .2, rhythm .15, pace .1, footPlacement .1, confidence .05, intensity 0.85.  
  `src/modes.ts:62-83`
- commercial (03): walkSeconds 45, idealPace 0.95, passThreshold 75, weights confidence .2, presentation .2, pace .15, posture .15, presence .1, footPlacement .1, rhythm .1, intensity 0.55.  
  `src/modes.ts:84-105`
- challenge (04): walkSeconds 40, idealPace 1.05, passThreshold 82, weights pace .2, rhythm .2, footPlacement .2, posture .15, presentation .1, confidence .1, presence .05, intensity 1.0.  
  `src/modes.ts:106-127`
- DEFAULT_MODE = beginner (MODES[0]); getMode falls back to it on an unknown id; the selection persists under localStorage key "xrunway.mode.v1".  
  `src/modes.ts:130-158`
- There is NO global pass constant — verdicts gate on the ACTIVE mode's passThreshold (75-82).  
  `src/metrics.ts:71-73`
- Mode consumers: ShowDirector reads walk length + weights, MetricsSystem reads ideal pace (+ pass threshold via consumers); mode is locked per run at walk start so a mid-run picker change can't retune it.  
  `src/modes.ts:8-10; src/metrics.ts:331-334; src/show.ts:413`
- Overall score rollup: fixed 7-key order (OVERALL_WEIGHTS list, values = Beginner defaults/fallback), weighted by the locked run-mode's weights, then clamped 0-100 and rounded; FALLBACK_SCORE 62 if a run ends before any metric tick.  
  `src/show.ts:136-152, 487-495`

**Porting:** The MODES table is a pure data structure — ports to a Swift array of structs verbatim, localStorage key becoming a UserDefaults key. All four modes work unmodified in solo mode: idealPace feeds the world-path pace score directly (metrics.ts:682), weights/passThreshold feed the summary rollup, walkSeconds drives the solo walk timer (which the phone must own itself, since walk phase/countdown lives in show.ts on the web side).

**Risks:** Weights must sum to 1 per mode (interface doc says MUST); a port adding/renaming metrics breaks this invariant silently. The rollup consumes the SMOOTHED/clamped live snapshot (effective range 40-98 pre-round), so 'overall 0-100' clamping at show.ts:495 is defensive, not the real range.

### Port classification — (a) as-is, (b) substitute, (c) drop

- (a) AS-IS from camera world pose alone: the entire deriveFromPoseWorld path — true-m/s pace + 4 m/s clamp, travel-heading EMA + validity gate, ankle-from-travel-line footwork, torso-tilt posture, hip-bob rhythm/footstrikes, all its score mappings, mode idealPace hookup — plus the shared machinery (clampScore 40-98, NEUTRAL 62 ramp/blend, 8-slot MAD ring, composites w/ sessionRamp, 6 Hz publish) and WalkStats' pace/steps/cadence/source channels and debounce.  
  `src/metrics.ts:567-729, 78-94, 297-322; src/walk-stats.ts:69, 157-162, 184-190`
- (a) AS-IS: the MODES table, the mode-weighted overall rollup, and the per-run mode lock.  
  `src/modes.ts:39-128; src/show.ts:487-495; src/metrics.ts:331-334`
- (b) SUBSTITUTE — WalkStats lateral channel (meanLateralM/meanAbsLateralM/liveLateralM): today head-path-only via projectRoute against the mapped runway; phone substitute = SIGNED travel-heading lateral (hip-to-ankle perpendicular offset against the smoothed heading, i.e. the signed version of the quantity metrics.ts:625/629 takes |abs| of). Must be renamed/re-documented (it is deviation from the walker's own travel line, not a runway centerline) and its sign anchored to the heading frame (e.g. + = right of travel direction).  
  `src/walk-stats.ts:27-33; src/metrics.ts:571-573, 618-636`
- (b) SUBSTITUTE — WalkStats posture channel (postureDriftM/livePostureM): today head-height-vs-0.5s-baseline, head-path-only; the world path deliberately leaves it dark because torso tilt is a different quantity. Phone substitute options with existing receipts: (1) torso-tilt-based posture (already the world path's score input, poseUprightEma) persisted as a NEW field (e.g. meanUpright or tilt degrees), or (2) hip-height-vs-walk-start-baseline drift mirroring the head formula on the hip joint (gravity-aligned Y is frame-invariant, so it is honest). Either way the WalkStats field needs renaming or redefinition.  
  `src/walk-stats.ts:34-36; src/metrics.ts:574-576, 642-651; src/metrics.ts:765-770`
- (b) SUBSTITUTE — walk lifecycle: phase/walk-start/finalize are owned by show.ts's ShowDirector and the headset walkProgress today (metrics.ts only reacts to the showPhase signal); solo mode needs its own phase machine driving beginWalkTracking-equivalent reset and finalize(durationSec) off the mode's walkSeconds countdown.  
  `src/metrics.ts:241-249, 327-334; src/modes.ts:28`
- (c) DROP — deriveFromHead entirely (player.head is the Quest HMD), including its head-specific tunings: BOB_THRESHOLD 0.004, posture = 100 - heightDevEma*350, and the 0.5 s head-height baseline.  
  `src/metrics.ts:733-877, 86`
- (c) DROP — RunwayPathProjector/compiledPath subscription, the resetLateral-on-remap handler, and projectRoute footwork: all require the user-MAPPED runway, which does not exist in an unregistered phone frame.  
  `src/metrics.ts:217-239, 818-821; src/runway-shape.ts:683-724`
- (c) DROP — deriveFromPose (camera-image normalized proxy) and all its image-unit constants; ARKit on-device always provides world joints.  
  `src/metrics.ts:422-557`
- (c) DROP (simplify) — the camera<->head source-handoff machinery: resetCadence, lastUsedExternal, trackerActive, the havePrev force-reseed, and WalkStats source dominance (single source on phone); KEEP the step debounce and fresh-frame dt gating those mechanisms protect.  
  `src/metrics.ts:258-295, 376-403; src/walk-stats.ts:149-155, 207-218`

**Porting:** Net Swift port surface: one WalkStatsAccumulator struct-class (verbatim), one MODES data table (verbatim), one derive function (deriveFromPoseWorld verbatim, fed by ARKit body-anchor joints per anchor update with true dt), the shared smoothing/ring/composite/publish block, and the show.ts weighted rollup + mode passThreshold gate. New code is confined to: a phone walk-lifecycle state machine (walkSeconds timer), a SIGNED travel-heading lateral, and a chosen posture-drift substitute. This matches the prior honesty ruling: everything kept is frame-invariant (speed magnitude, gravity-aligned bob/height, tilt vs gravity, lateral from travel direction); everything requiring absolute runway position is dropped.

**Risks:** Three naming traps for the fact-checker: (1) 'footPlacement' on the phone measures ankle offset from the SELF-derived travel line (includes stance width), never the runway centerline; (2) 'postureDriftM' as shipped is a head-height quantity no phone path produces — any solo-mode summary showing it must use the substitute's new definition; (3) WalkStats.source semantics change (single-source). Also numerical: ARKit joint timestamps are in seconds while PoseFrame.t is ms (metrics.ts:275 divides by 1000) — a port must not double-convert; and per-anchor cadence (~30-60 Hz) changes EMA effective smoothing only through dt, which the 1-exp(-k*dt) form already handles correctly.

## A2. Coach layers

### coach.ts — post-walk verdict rule and weighted-shortfall note selection

- Metric order M1..M7 is posture, pace, rhythm, footPlacement, presence, confidence, presentation; this order is the tiebreak when two below-line metrics cost the same, and it must mirror metrics.ts METRICS (kept in sync by comment, not import — metrics.ts pulls @iwsdk/core).  
  `src/coach.ts:44-57`
- Verdict rule: overall is Math.round(ctx.overall); passed = overall >= mode.passThreshold; verdict string is "PASS" or "NEEDS WORK".  
  `src/coach.ts:233-236,249-255`
- Note selection: each metric's score is rounded, below = roundedScore < passThreshold, impact = (mode.weights[key] ?? 0) * max(0, thr - roundedScore); below-line metrics are sorted by impact descending (stable sort keeps M1..M7 order on ties) and capped at 3 notes.  
  `src/coach.ts:237-248`
- CoachContext takes scores, unrounded overall, mode ({passThreshold, weights}), stats: WalkStats | null, and oneWayRoute: boolean (true only for the one-way U route; out-and-back straight/T/X must pass false).  
  `src/coach.ts:132-148`
- Mode pass bars and ideal paces the verdict/pace copy run against: beginner 78 @ 0.85 m/s (60 s), highfashion 80 @ 0.72 (75 s), commercial 75 @ 0.95 (45 s), challenge 82 @ 1.05 (40 s).  
  `src/modes.ts:41-116`
- Both summary surfaces call the same buildCoachReport with summary.oneWayRoute — hud.ts (XR panel) and landing.ts (desktop card); oneWayRoute is stamped on the ShowSummary from runOneWay, which is path.kind === "U".  
  `src/hud.ts:1350-1359; src/landing.ts:917-926; src/show.ts:283,523`
- Shared label helpers: verdictLine = "{verdict} - BAR {thr}"; passBarLabel = "PASS AT {thr}"; targetPaceLabel = "TARGET {idealPace.toFixed(2)} M/S"; walkStatLine = "{round(sec)}S ON THE RUNWAY[ - N STEPS[ - M/MIN]]" with sep defaulting to ASCII " - " (XR font has no middle-dot; landing passes " · ").  
  `src/coach.ts:262-296`
- Module-wide law: every string is ASCII-punctuation only because the copy reaches the XR panel whose font lacks em-dash/middle-dot/curly-quote/arrow glyphs; module is dependency-free (type-only imports) so it runs in vitest.  
  `src/coach.ts:32-36`

**Porting:** buildCoachReport is pure scalar math over {scores, overall, mode, stats, oneWayRoute} — ports 1:1 to a Swift struct + function (Foundation only). Keep the exact rounding-before-compare and stable-sort-with-M1..M7-tiebreak semantics (Swift's sort is NOT stable by default — use sorted with an explicit index tiebreak). The ASCII-only constraint is a Quest-panel font limitation; SwiftUI has no such constraint, so iOS may use typographic separators (the sep parameter already anticipates per-surface separators). A single SwiftUI summary screen replaces the two web surfaces and calls the one ported function.

**Risks:** METRIC_ORDER sync with metrics.ts is enforced only by comment (coach.ts:45-48) — a solo-mode Swift scoring pipeline must define one canonical order or the tiebreak silently diverges. If solo scoring re-derives M5-M7 composites differently, the copy inventory below becomes dishonest (it states specific derivations).

### coach.ts — full copy inventory: METRIC_EXPLAIN, METRIC_COACH, directional cue formats, lateral honesty gate

- METRIC_EXPLAIN (tooltip copy, verbatim): posture "How square and lifted your frame stays through the walk."; pace "How close your speed is to this mode's ideal catwalk tempo."; rhythm "How even and consistent your step timing is."; footPlacement "How well each step tracks the runway centerline."; presence/confidence/presentation each start "Composite read:" and say outright "It is not separately measured" (presence adds "eyeline is not tracked", confidence describes the 45-second settle-in credit, presentation adds "the turn is not analyzed").  
  `src/coach.ts:63-74`
- METRIC_COACH (generic band-fallback cues, verbatim): posture "Lift through the crown - shoulders back, chin level, ribs over hips."; pace "Settle into one tempo - don't rush the start or drift at the mark."; rhythm "Lock a steady cadence - equal time on each step, like a metronome."; footPlacement "Track the centerline - land each foot in front of the other."; the three composite cues point only at the measured channels (e.g. presence: "...lift the frame and steady the tempo and it follows.").  
  `src/coach.ts:83-94`
- CLEAN_WALK_CUE = "Clean walk - every metric cleared the line. Step up a mode." (shown when zero notes qualify).  
  `src/coach.ts:96-98`
- Directional pace cue: needs paceDeltaMps and meanPaceMps non-null and delta nonzero; format "You averaged {mean} m/s against a {ideal} m/s target - slow every stride down." (delta>0) / "...pick every stride up." (delta<0), both numbers via toFixed(2); if the two toFixed(2) strings RENDER identically (sub-0.005 m/s delta) it falls back to the generic cue so the copy never contradicts its own citation.  
  `src/coach.ts:155-168`
- Directional posture cue: from the SIGN of postureDriftM, cm = round(|drift|*100), guarded cm >= 1; "+" gives "You rode {cm} cm above your start height - settle down, no bounce.", "-" gives "You sank {cm} cm below your start height - lift through the crown."  
  `src/coach.ts:170-177`
- Footwork lateral honesty gate: left/right is named ONLY when oneWayRoute AND meanAbsLateralM > 0 AND |meanLateralM| / meanAbsLateralM >= LATERAL_SIDE_CONSISTENCY (0.6); then "You drifted {cm} cm {right|left} of the centerline - pull it back to center." (meanLateralM > 0 = right). Otherwise magnitude-only: "You averaged {cm} cm off the centerline - tighten your line." cm = round(meanAbsLateralM*100), guarded cm >= 1. Rationale: the lateral sign flips on the return leg of an out-and-back walk, so a signed mean can cancel or lie.  
  `src/coach.ts:100-105,179-197 (+ sign convention: src/walk-stats.ts:27-33)`
- Rhythm cue cites real measurements only: needs cadenceSpm non-null and steps > 0; "{steps} steps at {round(cadence)} per minute - keep the interval even."  
  `src/coach.ts:199-202`
- Dispatcher cueFor: directional builders exist ONLY for pace/posture/footPlacement/rhythm; presence/confidence/presentation always take the generic band cue (nothing measures them directly); any null builder result falls back to METRIC_COACH[key] with directional=false.  
  `src/coach.ts:204-221`
- WalkStats fields the cues consume: meanPaceMps, idealPaceMps, paceDeltaMps (= meanPaceMps - idealPaceMps, positive = too fast), meanLateralM/meanAbsLateralM (time-weighted signed/abs centerline offsets), postureDriftM (signed head-height deviation from walk-start baseline), steps, cadenceSpm.  
  `src/walk-stats.ts:27-58`

**Porting:** All copy is plain English constants — port verbatim as a Swift dictionary keyed by an enum. toFixed(2) becomes String(format: "%.2f", x) and the render-identical guard must compare the FORMATTED strings (not raw doubles), exactly as the TS does. PHONE-ONLY CONSEQUENCE OF THE LATERAL GATE: a solo walk is a trainee-defined straight line walked out-and-back (phone propped at one end), i.e. oneWayRoute = false — the footwork cue is therefore permanently magnitude-only on the phone; the left/right branch ports but never fires unless solo mode later defines a genuine one-way route with a travel-direction-consistent sign convention. This also matches the registration honesty fact: lateral-from-travel-direction is frame-invariant, absolute runway position is not.

**Risks:** The composite explainers assert specific derivations ("posture counting most", the 45 s confidence credit, "posture and rhythm weighted heaviest") verified against metrics.ts — if the Swift scorer changes any blend, this copy must be re-verified or it becomes a false claim. The pace explainer says "this mode's ideal catwalk tempo" — solo mode must still carry per-mode idealPace for the copy to be true.

### coach-live.ts — the complete live-cue rule table (windows, hysteresis, cooldowns, caps, thresholds, priority, channel honesty)

- Rule constants: SETTLE_SEC = 5 (no fault accumulation before it — timers actively cleared, so earliest possible cue is SETTLE_SEC + FAULT_HOLD_SEC = 7.5 s in); FINAL_GUARD_SEC = 4 (no cue in the last 4 s of the walk clock); FINAL_GUARD_PROGRESS = 0.9 (no cue past 90% route progress — out-and-back walks finish POSITIONALLY via show.ts FINISH_RADIUS, often with 20+ s on the clock, so a clock-only guard was inert for fast finishers); FAULT_HOLD_SEC = 2.5; CUE_COOLDOWN_SEC = 9 (between ANY two cues); MAX_PER_KIND = 2 per walk; TURN_SUPPRESS_SEC = 4 after the pose mark.  
  `src/coach-live.ts:144-163 (guard rationale 21-35,148-152; FINISH_RADIUS = 0.4: src/show.ts:119)`
- Thresholds with documented derivations against metrics.ts score maps: PACE_DELTA_CUE_MPS = 0.25 (pace score is 100 - |delta|*70, so 0.25 maps to ~77.5, at/below every pass bar 75-82); LATERAL_CUE_M = 0.20, ADJUSTED DOWN from a pinned 0.35 (footwork is 100 - |lat|*240, floor 40 at ~0.23 m — a 0.35 gate could only fire after the metric had been floor-pinned; 0.20 maps to ~48 and is ~4x natural ~5 cm head sway); POSTURE_CUE_M = 0.06 (posture is 100 - dev*350, so 0.06 maps to ~75, at the lowest bar; head-bob ~1-2 cm sits well under).  
  `src/coach-live.ts:56-71,165-171`
- Phase gate: cues fire only while input.walking (show phase "walk"); settle window CLEARS fault timers (not just mutes) so ramp-in artifacts can never pre-age a fault.  
  `src/coach-live.ts:250-260`
- Turn-back window: once markAtSec is non-null, fault timers are CLEARED and no cue fires while (oneWayRoute) OR (nowSec - markAtSec < TURN_SUPPRESS_SEC) — i.e. on a one-way route suppression holds from the mark to the walk's end (the walk ends at the mark after POSE_HOLD_SEC = 1.6 s); on out-and-back it covers the pose beat + physical turn (the HUD's Turn-around prompt holds 3 s).  
  `src/coach-live.ts:262-269,159-163 (POSE_HOLD_SEC: src/show.ts:126)`
- Hysteresis: a fault must hold continuously >= FAULT_HOLD_SEC beyond threshold before cueing; a clean sample resets the timer, and for the SIGNED channels (pace, posture) a sign flip restarts the clock (paceSign/postSign tracked; lateral is unsigned so only threshold crossings reset).  
  `src/coach-live.ts:274-303,336-338`
- Channel honesty: a null channel never cues, and NON-FINITE values (NaN/Infinity from a poisoned upstream EMA) route through the SAME clear/reset path as null via Number.isFinite gates — without the gate NaN would fail every clean-sample test, mature through the hold, and speak a fabricated correction (always the slow/lift flavor since NaN > 0 is false).  
  `src/coach-live.ts:43-54,271-303`
- Ordering of gates: fault-persistence tracking runs BEFORE the final-guard/cooldown gates, so faults keep aging through guarded/cooling periods; then final guard (walkRemainingSec <= 4 OR walkProgress01 >= 0.9) returns null, then cooldown (nowSec - lastCueAt < 9) returns null.  
  `src/coach-live.ts:305-314`
- Selection priority when several faults are simultaneously held: pace > center > posture ("pace is the most coachable mid-stride; posture the least"); eligibility per kind = counts[kind] < MAX_PER_KIND AND kind !== lastKind (never the same kind twice in a row); fire() increments the count, sets lastKind/lastCueAt.  
  `src/coach-live.ts:41-42,316-349`
- Five cue kinds with verbatim spoken copy (~2 s at rate 1.05, ASCII only): pace-fast "Slow it down - long, even strides."; pace-slow "Pick up the pace - stretch every stride."; center-up "Find the centerline."; posture-drop "Settle your height - smooth, no bounce."; posture-lift "Lift through the crown - chin level." center-up DELIBERATELY never says left/right — the live lateral input is ABS-only because the sign is route-relative and flips on the return leg.  
  `src/coach-live.ts:77-109,192-193`
- reset() re-arms everything for a new walk (counters, cooldown, fault timers, lastKind); clearFaults() clears ONLY the fault-persistence timers (counters/cooldown survive) and is the mid-walk-remap hook — the centerline moved under the live walk so in-flight fault clocks were measured against stale geometry.  
  `src/coach-live.ts:222-244`
- Every rule is unit-tested in test/coach-live.test.ts (stated in header) and the module is dependency-free (no @iwsdk/core, no DOM) so it loads in vitest.  
  `src/coach-live.ts:10-14`

**Porting:** LiveCoachPolicy is a pure state machine over scalars — ports directly to a Swift class fed from the ARKit session at ~2 Hz. PHONE-ONLY CHANGES: (1) There is no show-director pose mark — for an out-and-back solo walk the app must synthesize markAtSec itself (e.g. detect the turn as a travel-heading reversal or the distance-from-phone peak) and apply TURN_SUPPRESS_SEC around it, or the turn's legitimate pace collapse + lateral swing WILL mature into false pace-slow/center-up cues (2.5 s hold < a typical turn). (2) oneWayRoute is effectively always false on the phone (out-and-back or a single defined line); the oneWay suppress-to-end branch ports but stays dormant. (3) FINAL_GUARD_PROGRESS needs a route-progress estimate — a trainee-defined runway length gives distance-based progress (frame-invariant: distance from start along travel direction is honest); if solo mode has no positional finish, the clock guard alone suffices but loses the fast-finisher protection the comment documents. (4) The three live channels are exactly the registration-honest set: speed magnitude (pace), lateral-from-travel-direction ABS (center), gravity-aligned height vs walk-start baseline (posture) — ARKit's gravity-aligned world frame supplies all three without registration.

**Risks:** LATERAL_CUE_M deviates from a pinned spec value (0.35 → 0.20) with the rationale in the header — a fact-checker diffing against older pinned docs will flag it; the code comment at coach-live.ts:61-66 is the authority. All three thresholds are DERIVED from metrics.ts's specific score mappings (95-|d|*70, 96-|lat|*240, 96-dev*350) — if the Swift scorer changes any mapping, the thresholds must be re-derived, not copied. The 2 Hz sample rate assumption is baked into the design ("plenty against 2.5 s hysteresis"); sampling much slower would mis-age holds.

### coach-live.ts — earcon vocabulary (the audio-fallback cue language)

- Earcons are contour-coded per kind so an earcon-only device still coaches learnably: pace = two blips (falling pair = slow down, rising = speed up), center = same-pitch double tap, posture = one gliding swoop (falling = settle, rising = lift).  
  `src/coach-live.ts:111-116`
- COACH_EARCONS recipes (notes Hz, span s, decay s, glide): pace-fast [1318.51, 987.77] span 0.11 decay 0.09; pace-slow [987.77, 1318.51] same; center-up [1174.66, 1174.66] span 0.09 decay 0.07; posture-drop [1046.5, 783.99] span 0.18 decay 0.3 glide; posture-lift [783.99, 1046.5] glide.  
  `src/coach-live.ts:118-138`
- COACH_EARCON_LEVEL = 0.16, a peak relative to the sfxLevel() pref-law master, deliberately positioned between the countdown tick (0.14) and the pose sting (0.18).  
  `src/coach-live.ts:128-130`
- Synthesis (coach-voice.ts playEarcon): sine oscillators; glide = one osc with linearRamp between notes over span, gain 0.0001 → peak in 12 ms → exponential decay; blip pair = two oscs `span` apart, 4 ms attack each; final peak = COACH_EARCON_LEVEL * sfxLevel(prefs); nodes are event-scoped, connected straight to ctx.destination.  
  `src/coach-voice.ts:148-188`

**Porting:** On iOS, synthesize the same recipes with AVAudioEngine (AVAudioSourceNode or a small AVAudioUnitSampler) or pre-render the five earcons to short PCM assets from these exact specs — the recipes are pure data, so a one-time offline render preserves the contour language bit-for-bit. Keep the earcon as the guaranteed channel: on iOS the analog of "no TTS voices" is a voice not downloaded / synthesizer failure, and the earcon-only fallback path (coach-voice.ts:225-227) should survive the port.

**Risks:** The 0.16 level is relative to the web SFX bus (SFX_MASTER_LEVEL 0.5); an iOS mixer with different bus gains must re-anchor the earcon between its own countdown-tick and pose-sting equivalents, not copy 0.16 blindly.

### coach-live-system.ts — the wiring: 2 Hz sampling, gate law, pose-mark latch, remap handling

- Pipeline: walk-stats live taps (livePaceMps/liveLateralM/livePostureM on globals.walkStats) → sampled at 2 Hz (COACH_SAMPLE_SEC = 0.5) → coach-live.ts decideLiveCue → coach-voice.ts speakCue; a dedicated system because MetricsSystem must stay delivery-free and SfxSystem voices show beats, not trainee faults.  
  `src/coach-live-system.ts:6-15,66-67 (taps: src/walk-stats.ts:98-100)`
- The run mode's idealPace is LOCKED at the walk edge (phase flip to "walk") so a mid-run mode-picker change cannot move the pace target under the policy; the walk edge also zeroes walkTime/sampleAcc, clears markAt/posePrev, and policy.reset()s.  
  `src/coach-live-system.ts:26-28,138-146`
- Gate law at the 2 Hz sample: coachOn = globals.coachPrefs.enabled (peeked live) AND sfxLevel(musicPrefs) > 0 — volume dragged to 0 behaves EXACTLY like enabled=false (the old !music.enabled gate let volume-0 walks keep sampling, silently burning the per-kind budget/cooldown/no-repeat latch). Every closed gate CLEARS the policy fault clocks: a suppression window, never a mute-only window that ages a fault unobserved; re-enabling mid-walk needs a fresh FAULT_HOLD_SEC.  
  `src/coach-live-system.ts:33-39,185-198`
- A null globals.walkStats accumulator clears fault clocks and returns ("no measurement layer, nothing honest to say"); the taps also re-apply Number.isFinite as defense-in-depth before building the input (paceDeltaMps = livePaceMps - lockedIdealPace; absLateralM = |liveLateralM|; postureM signed).  
  `src/coach-live-system.ts:200-228`
- Pose-mark detection: globals.poseBurst is a shared durable flag; this system edge-detects the rising edge with a PRIVATE posePrev latch and never writes the flag; markAt = walkTime at the edge.  
  `src/coach-live-system.ts:23-26,171-176`
- Mid-walk remap (globals.compiledPath fires while walking): markAt = null, posePrev = false (the latch must re-arm WITH markAt or a stale latch would swallow the re-latched rising edge, losing the turn-suppress window), policy.clearFaults(); oneWay is refreshed as p.kind === "U".  
  `src/coach-live-system.ts:116-135`
- Demo honesty: the Preview Walk auto-pilot (globals.demoActive) is never coached — the smoothstep leg kinematics trip the pace gates on most runway lengths (a night-review reversal of an earlier call).  
  `src/coach-live-system.ts:40-44,163-168`
- Any phase exit from "walk" (finish/reset) calls cancelCoachVoice() immediately so the summary or house never carries a stale mid-utterance correction; system cleanup also cancels.  
  `src/coach-live-system.ts:147-156`
- On a fire, the MusicSystem duck handle is read lazily/defensively from globals.musicDuck and passed to speakCue with the live musicPrefs snapshot; the coachPrefs on/off gate is THIS system's job, the volume/mute law is coach-voice's.  
  `src/coach-live-system.ts:230-238 (division of duty: src/coach-voice.ts:190-195)`
- Zero per-frame allocation: ONE preallocated mutable LiveCueInput reused every sample, signals peek()ed never .value; the only allocations are the fired LiveCue and speech/earcon nodes.  
  `src/coach-live-system.ts:16-21,90-91,104-114`

**Porting:** In Swift this becomes a Timer/ARSession-delegate-driven sampler over the on-device stats accumulator: keep the exact layering (measurement -> pure policy -> delivery) and the gate-clears-faults law (a Settings toggle or mute must clear fault clocks, not just silence output). walkTime must be a walk-scoped monotonic clock paused on scenePhase background (the web analog is the rAF-frozen ECS clock). Phone-only deletions: demoActive (no auto-pilot), compiledPath remap (no fit-to-room mid-walk remap — though if solo mode lets the trainee redefine the line mid-walk, reproduce clearFaults + mark re-arm), and poseBurst (replace with the app's own turn-detection event as the markAt source). The mode-lock-at-walk-edge rule ports as-is: snapshot idealPace when the countdown ends.

**Risks:** The gate law couples coaching audibility to MUSIC prefs (sfxLevel(musicPrefs)) — on a phone with per-mode music still an open founder call, the design must decide whether one master audio pref keeps gating the voice or the coach gets its own volume; changing this changes the documented "mute means silence, coach included" law (coach-prefs.ts:10-13).

### coach-voice.ts — delivery: earcon lead-in, speech, ducking semantics, generation tokens, watchdog

- Delivery shape: on speakCue, cancel anything in flight (NEVER QUEUE — the 9 s policy cooldown makes overlap near-impossible, this makes it impossible), play the earcon immediately, hold the music duck, then speak the line EARCON_LEAD_MS = 150 ms later at SPEECH_RATE = 1.05 ("slightly brisk").  
  `src/coach-voice.ts:16-18,53-56,196-272`
- MUTE MEANS SILENCE law: earcon level = COACH_EARCON_LEVEL * sfxLevel(prefs); if sfxLevel(prefs) <= 0 the function returns before ANYTHING — no earcon, no speech, no duck; utterance volume applies the same musicPrefs law directly: min(1, max(0, prefs.enabled ? prefs.volume : 0)).  
  `src/coach-voice.ts:11-15,204-207,236-237`
- AudioContext discipline: peekAudioContext() only — this module never creates/resumes the shared context; if absent or not running the earcon is skipped and speech still goes out (speechSynthesis is independent of WebAudio).  
  `src/coach-voice.ts:19-22,149-153 (peekAudioContext: src/audio-core.ts:45)`
- Ducking semantics: while a cue is in flight the music master dips to 65% via MusicSystem's counted duck handle (globals.musicDuck hold()/release()); release is scheduled utterance-end + DUCK_TAIL_MS = 300 ms; earcon-only devices duck for EARCON_ONLY_DUCK_MS = 1200 ms; speech-construction failure winds down after 1200 - 150 ms; hold/release are balanced by construction on every path.  
  `src/coach-voice.ts:23-28,57-62,211-218,225-227,248-253,268-271`
- MusicSystem side of the duck: VOICE_DUCK_LEVEL = 0.65 is applied INSIDE masterLevel() — base = enabled ? MASTER_LEVEL(0.7) * volume : 0, then * 0.65 while voiceDuckHolds > 0 — so every master ramp (fade-in, mid-fade rescue, pref retarget) respects the duck for free; holds are COUNTED, not boolean, so a counter can never under-release; release() floors at 0.  
  `src/music.ts:72-76,136-138,202-213,288-295`
- STALE EVENTS ARE DEAD EVENTS: engines fire a cancelled utterance's onend/onerror asynchronously AFTER cancel() returns, by which time the next cue may hold ITS duck — every async handler (onend/onerror/watchdog) captures a generation token; cancelCoachVoice() bumps the generation, so a dead utterance's late events can never release the successor's duck or kill its watchdog.  
  `src/coach-voice.ts:29-35,64-68,112-114,202,248-253,256-260`
- Watchdog: SPEECH_WATCHDOG_MS = 10000 hard-stops TTS engines that never fire end/error (cancels the synth and releases the duck) so the music can never duck forever; generation-gated like the other handlers.  
  `src/coach-voice.ts:61-62,255-267`
- Voice pick: filter getVoices() to lang starting "en", prefer default, then localService, then first; cached once found; an empty list (async voice loading on some platforms) just retries at the next cue; no voice → u.lang = "en-US".  
  `src/coach-voice.ts:125-146,238-244`
- cancelCoachVoice() (called on any phase exit and at the top of every delivery): bump generation, clear the pending-speak timer, speechSynthesis.cancel() (guarded), release the duck now.  
  `src/coach-voice.ts:107-123`

**Porting:** The iOS replacements, mechanism by mechanism: speechSynthesis → AVSpeechSynthesizer with AVSpeechUtterance; NOTE the rate scale differs — web rate 1.05 is a multiplier of the platform default, AVSpeechUtterance.rate is a 0..1 value where AVSpeechUtteranceDefaultSpeechRate (~0.5) is normal, so "slightly brisk" ≈ a small bump above the default constant, NOT 1.05 (1.0 is maximum). utterance.volume (0..1) exists and takes the same prefs law. onend/onerror → AVSpeechSynthesizerDelegate didFinish/didCancel — still asynchronous, so the generation-token pattern MUST survive the port; the watchdog is cheap insurance and should too. cancel → stopSpeaking(at: .immediate). Ducking splits in two on iOS: (a) OTHER apps' audio (trainee's own music) is ducked by the SYSTEM if the audio session is configured with .playback + .duckOthers (or the speech-specific .interruptSpokenAudioAndMixWithOthers) — this REPLACES nothing in the web app (the web can't duck Spotify) and is a new design decision; (b) the app's OWN music (if solo mode ships per-mode music) needs the direct port: a counted hold multiplying the music mixer node's gain by 0.65, applied inside the single master-level function exactly like music.ts:291-295 so all ramps compose. peekAudioContext discipline maps to "never activate the AVAudioSession outside the user-initiated start flow". Voice availability: iOS always has at least a compact en voice, but keep the earcon-lead-in + earcon-only fallback — it also covers the synthesizer being interrupted by a call/Siri.

**Risks:** AVAudioSession adds failure modes the web never had: interruptions (calls, Siri) and route changes (headphones unplugged) can kill an utterance without a clean delegate callback — the watchdog + generation pattern covers the duck, but the design should decide whether an interrupted cue is re-fired (the policy's counts already consumed it; the web treats a spoken-but-unheard cue as spent). The hardware silent switch: category .playback ignores it, .ambient obeys it — "mute means silence" needs an explicit iOS definition.

### The musicPrefs / coachPrefs / sfxLevel law (the pref plumbing every audio layer obeys)

- MusicPrefs = { enabled: boolean, volume: 0..1 }, default { enabled: true, volume: 0.7 }, persisted at localStorage key "xrunway.music.v1"; sanitizer coerces any old/garbage schema, clamping volume to 0..1 and rejecting non-finite.  
  `src/music-prefs.ts:14-35`
- CoachPrefs = { enabled: boolean }, default ON, persisted at "xrunway.coach.v1"; off silences cues WITHOUT touching scoring or post-walk coach notes; documented mute law: coachPrefs is NOT the only silencer — musicPrefs.enabled === false (the product-wide mute) ALSO silences coaching.  
  `src/coach-prefs.ts:10-26`
- sfxLevel(prefs) = prefs.enabled ? SFX_MASTER_LEVEL(0.5) * prefs.volume : 0 — declared to be "the SAME law MusicSystem.masterLevel() applies" (music: enabled ? 0.7 * volume : 0); it is the single mute predicate: sfxLevel <= 0 gates both the CoachLiveSystem sampler and the speakCue delivery.  
  `src/sfx-timeline.ts:67-77 (music mirror: src/music.ts:291-295; gates: src/coach-live-system.ts:195; src/coach-voice.ts:204-207)`
- Prefs are signals on globals (musicPrefs, coachPrefs) written by both the landing controls and the in-headset settings row; CoachLiveSystem peeks them at every 2 Hz sample so toggles apply mid-walk.  
  `src/music-prefs.ts:5-8; src/coach-prefs.ts:6-9; src/coach-live-system.ts:185-193`
- The spoken-voice loudness has NO pref of its own: utterance volume = the musicPrefs law (enabled ? volume : 0) and the earcon = 0.16 * sfxLevel(musicPrefs) — one volume slider governs music, SFX, earcons and speech.  
  `src/coach-voice.ts:203-209,236-237`

**Porting:** localStorage → UserDefaults with the same sanitize-on-load discipline (the sanitizers are pure and port as-is; keep versioned keys). The law itself ports verbatim: one master audio pref {enabled, volume} + one coach on/off boolean; mute predicate = enabled && volume > 0; coach speaks only when BOTH coach.enabled AND the master predicate hold; toggles must be read live at the sample gate so mid-walk changes apply. iOS ADDITION the web never had: decide how the hardware silent switch and system volume compose with the in-app law (system volume multiplies everything downstream of the app; the in-app law still owns relative levels and the hard-zero mute).

**Risks:** The design doc must not invent a separate "voice volume" — the current product deliberately has none (one slider, #6 "mute means silence"). If solo mode adds per-mode music (open founder call), the duck and the shared-volume law must be specified against that music engine before the copy about ducking can be honest.

### Phone-only rule changes — what a solo out-and-back walk keeps, drops, and must replace

- oneWayRoute is a route-topology fact (compiledPath.kind === "U") consumed in exactly two places: the post-walk footwork side-naming gate and the live turn-suppress-to-end branch; every other route (straight/T/X) is out-and-back and passes false.  
  `src/show.ts:283,523; src/coach.ts:186-196; src/coach-live.ts:264-269`
- The lateral sign convention that forbids left/right on out-and-back walks: meanLateralM/meanAbsLateralM are time-weighted means of the SIGNED centerline offset where the sign flips meaning on the return leg — near-zero signed mean next to a large abs mean means weaving that averaged out.  
  `src/walk-stats.ts:27-33; src/coach.ts:25-28`
- The turn-back mark on the web is the show director's poseBurst flag raised at the far-end pose mark; the walk then either turns back (out-and-back) or ends after POSE_HOLD_SEC = 1.6 s at the mark (one-way); out-and-back walks finish positionally within FINISH_RADIUS = 0.4 m of the start line.  
  `src/coach-live-system.ts:171-176; src/show.ts:119,126,365-379`
- The final guard's positional half exists precisely because out-and-back walks routinely end with 20+ s on the clock — a clock-only guard is inert exactly where fast finishers cross the line, and a cue fired on the last sample gets chopped mid-word by the summary flip's cancelCoachVoice.  
  `src/coach-live.ts:21-26,148-152`
- The live channels the policy consumes are exactly the registration-honest set: pace = speed magnitude vs the mode ideal, center = ABS lateral offset (sign discarded at the tap), posture = signed gravity-aligned height vs the walk-start baseline — no absolute runway coordinates enter the coach layers anywhere.  
  `src/coach-live-system.ts:221-228; src/coach-live.ts:178-196`

**Porting:** Reasoning from what a phone-only walk is (a trainee-defined straight line or out-and-back with the phone propped at one end): (1) oneWayRoute = false always → the footwork left/right branch and the one-way suppress-to-end branch port but never fire; the design doc can either carry them dormant or state the U-route features as headset-only. If solo mode ever adds a one-way "walk toward the phone" drill, side-naming could be legitimately re-enabled because the lateral sign stays travel-direction-consistent for the whole walk — but that requires defining the sign against the trainee's travel direction, not a registered runway. (2) The pose mark must be REPLACED, not dropped: without a markAtSec source, TURN_SUPPRESS never engages and the physical U-turn (pace → ~0, lateral swinging) will mature into false pace-slow/center-up cues within the 2.5 s hold. Candidate phone-native mark: heading reversal or the distance-from-start maximum, both frame-invariant. (3) FINAL_GUARD_PROGRESS: derive route progress from the trainee-defined line length (distance walked / (2 × line length) for out-and-back); if no length is defined, fall back to the clock guard and accept the fast-finisher gap the web comment documents. (4) Everything else — settle window, hysteresis, cooldown, caps, no-repeat, priority, thresholds, channel honesty via isFinite, gate-clears-faults — is phone-agnostic and ports unchanged.

**Risks:** The turn-detection replacement is the one genuinely NEW mechanism with no web receipt — the design doc must flag it as new logic, not a port, and its false-positive behavior (a mid-walk pause read as a turn would wrongly clear fault clocks for 4 s — benign; a MISSED turn produces false cues — not benign) should bias detection toward over-triggering. Threshold receipts (0.25 m/s, 0.20 m, 0.06 m) are tied to metrics.ts score curves; if the solo scorer is rebuilt in Swift these constants need re-derivation against the new curves, and the design doc should cite them as derived values, not free parameters.

## A3. iOS companion architecture

### ARBodyTracker capture path — what a Solo engine can consume

- PoseFrame carries { t: Double (ms, this device's wall clock), source: String, space: String ('world' for ARKit meters or 'image' for Vision normalized), keypoints: [String: PoseKeypoint] } where PoseKeypoint is x/y/z Double + score Double.  
  `native/ios-companion/Sources/PoseFrame.swift:41-62`
- Exactly 9 canonical keypoints are emitted: nose, leftShoulder, rightShoulder, leftHip, rightHip, leftKnee, rightKnee, leftAnkle, rightAnkle (Keypoint.all), plus a bones list for skeleton drawing.  
  `native/ios-companion/Sources/PoseFrame.swift:66-96`
- ARKit mode produces WORLD-SPACE meters: frameFromBodyAnchor composes anchor.transform (hips->world) with each joint's modelTransform and emits space:"world", score 1.0; hips map from left/right_upLeg_joint with .root center fallback, ankles from left/right_foot_joint.  
  `native/ios-companion/Sources/ARBodyTracker.swift:377-418`
- The single fan-out point for every captured frame is publish(_:bodyVisible:): it writes state.keypoints/state.bodyVisible for the UI then hands the frame to the relay via `Task { await relay.send(frame: frame) }`. This is THE Solo hook point.  
  `native/ios-companion/Sources/ARBodyTracker.swift:361-367`
- ARBodyTracker is HARD-coupled to the concrete relay: `private let relay: PoseRelayClient` and `init(relay: PoseRelayClient, state: TrackingState)` — there is no protocol seam today.  
  `native/ios-companion/Sources/ARBodyTracker.swift:78,109-114`
- publish() runs at capture rate (AR anchor updates, up to 60 Hz); the <=30/s throttle lives inside PoseRelayClient.send, NOT in the tracker — so a Solo consumer attached at publish() gets full-rate frames.  
  `native/ios-companion/Sources/PoseRelayClient.swift:50-52,336-343`
- Anchors with isTracked == false are dropped (ARKit keeps delivering FROZEN joint transforms after the body leaves frame); bodyVisible is set false and NO frame is published — a Solo engine sees gaps, not stale frames.  
  `native/ios-companion/Sources/ARBodyTracker.swift:166-191`
- Device capability gate exists: `static var bodyTrackingSupported: Bool { ARBodyTrackingConfiguration.isSupported }`; unsupported devices fall back to Vision 2D normalized image coords (0..1, y down, z=0, confidence gate 0.3).  
  `native/ios-companion/Sources/ARBodyTracker.swift:117-119,422-483`
- frame.t uses the wall clock (Date().timeIntervalSince1970*1000, nowMs) which 'can step backward (NTP / user clock change)'; the relay deliberately uses a separate monotonic clock (ProcessInfo systemUptime, monoMs) for all rate/timing math.  
  `native/ios-companion/Sources/ARBodyTracker.swift:486-491 and native/ios-companion/Sources/PoseRelayClient.swift:68-70`
- Session failure and system interruption (call, Split View) both clear keypoints/FPS/framing and set an explicit error or 'Camera paused by the system.' note; sessionError is a dedicated channel so relay status can never mask a dead camera.  
  `native/ios-companion/Sources/ARBodyTracker.swift:200-256`

**Porting:** Solo mode does not port anything — it attaches. Cleanest hook: introduce a small `protocol PoseFrameSink { func send(frame: PoseFrame) async }` (PoseRelayClient already satisfies the signature at PoseRelayClient.swift:336), change ARBodyTracker's stored relay to that protocol (or an array of sinks), and register a new SoloSessionEngine as a second consumer at publish(). The Solo scoring engine receives the exact same world-space PoseFrame the headset gets, at full 60 Hz instead of the throttled 30/s. Use monoMs-style monotonic time for all Solo cadence/duration math, keeping frame.t only as a payload stamp — the codebase already documents why.

**Risks:** The Vision fallback path emits normalized image coords (space:"image") which are NOT frame-invariant metric quantities — Solo scoring must be gated on ARBodyTracker.bodyTrackingSupported (or on frame.space == "world") or it will produce dishonest numbers on non-body-tracking devices. Also: in AR mode the streamed skeleton is model-complete with score 1.0 even when limbs are cropped/estimated (documented at ARBodyTracker.swift:97-101 and 282-288), so Solo scoring cannot use keypoint presence or score as a visibility signal — it must consult the framing machinery.

### Framing-status machinery — reusable as Solo's setup gate

- FramingStatus enum: unknown / noBody / feetOut / headOut / partial / good — derived from what the camera actually sees, built as the tripod-placement feedback loop (POLISH-AUDIT #13).  
  `native/ios-companion/Sources/ARBodyTracker.swift:41-48`
- In ARKit mode framing truth comes from ARSkeleton.isJointTracked(_:) per-joint flags (framingFromBodyAnchor), NOT from streamed keypoints, because ARKit extrapolates cropped joints; verdict ladder: no ankle -> feetOut, no head -> headOut, no hip -> partial, else good.  
  `native/ios-companion/Sources/ARBodyTracker.swift:309-334`
- Published verdicts pass hysteresis: a raw verdict must hold 500 ms (framingHoldMs) and publishes are spaced >=300 ms (framingMinGapMs), on the monotonic clock — so the UI tip never flickers at frame rate.  
  `native/ios-companion/Sources/ARBodyTracker.swift:88-96,338-351`
- TrackingState is the @MainActor ObservableObject mirror the SwiftUI layer watches: keypoints, mode, captureFps, bodyVisible, framing, note, sessionError.  
  `native/ios-companion/Sources/ARBodyTracker.swift:51-69`
- ContentView already renders the debounced verdict as a glass framingChip with human copy ('Move back — feet out of frame', 'Framing good — whole body visible') and shows it only while running.  
  `native/ios-companion/Sources/ContentView.swift:79-82,239-264`
- A static SetupTipsCard sheet (side-on placement, 3–5 m back, waist height portrait, whole body in frame) already exists, reached from the SETUP pill.  
  `native/ios-companion/Sources/ContentView.swift:503-558`

**Porting:** Solo mode reuses this wholesale: FramingStatus == .good is the natural 'ready to walk' precondition before Solo starts scoring, and framing transitions during a walk are the honest 'walker left frame' signal for pausing scoring or voicing a correction. The hysteresis constants (500/300 ms) are already tuned for spoken-pace feedback. Nothing here needs modification; a Solo engine just reads trackingState.framing (or gets arFraming plumbed into its sink callback if it needs it off-main-actor).

**Risks:** framing lives on the @MainActor TrackingState; a Solo engine doing its math off the main actor must either subscribe on main and forward, or have the verdict added to its sink payload. Also framing goes .unknown on stop/failure/interruption (resetFraming, ARBodyTracker.swift:353-359) — Solo must treat .unknown as 'suspend scoring', not as an error.

### ContentView flow — where the SOLO vs STREAM switch lives

- ContentView owns the whole session lifecycle as a single boolean `running` plus lazily-created `relay`/`tracker` (@State) and two @StateObject mirrors (RelayStatus, TrackingState).  
  `native/ios-companion/Sources/ContentView.swift:39-50`
- ensureClients() constructs the pair in fixed order — `PoseRelayClient(status:)` then `ARBodyTracker(relay: r, state:)` — so today a tracker cannot exist without a relay.  
  `native/ios-companion/Sources/ContentView.swift:428-441`
- beginRunning() is the exact seam where streaming starts: `tracker.start(source:)` then `Task { await relay.start(host:source:secure:) }` — a Solo mode simply doesn't make the relay.start call and starts its engine instead.  
  `native/ios-companion/Sources/ContentView.swift:489-495`
- toggle() (the START/STOP button) already routes through a camera-permission preflight (startAfterCameraPreflight, with CameraBlock .denied/.restricted states and an OPEN SETTINGS deep link) plus a re-entrancy guard and Haptics.tap() — all mode-agnostic and reusable by Solo.  
  `native/ios-companion/Sources/ContentView.swift:51-63,443-500`
- The layout is a VStack of glass chrome (topBar; badge row CAMERA fps / SENDING /s / NAME; framingChip+modeChip when running; bottomPanel with status line, host/source fields, SECURE toggle, START button, 'Sending to ws://host:8082' line) over a full-screen cameraLayer + SkeletonOverlay background.  
  `native/ios-companion/Sources/ContentView.swift:65-102,310-364`
- statusLine gives camera problems priority over relay phases and falls to relay-phase copy ('Connecting…', 'Streaming — N/s', 'Receiver not reachable — retrying…') — the SENDING badge, connectionPill, host field, SECURE toggle, and dialTarget line are the stream-only UI a Solo mode must hide.  
  `native/ios-companion/Sources/ContentView.swift:197-214,293-308,326-358,393-424`
- SkeletonOverlay draws world-meter keypoints via a self-normalizing orthographic projection (bounding-box fit, y flipped) — pure function of keypoints+mode, reusable unchanged in a Solo capture screen.  
  `native/ios-companion/Sources/ContentView.swift:584-653`
- ARViewContainer displays but does not drive the ARSession ('ARBodyTracker owns it; we only display it') — Solo reuses it as-is.  
  `native/ios-companion/Sources/ContentView.swift:560-576`
- A debug env-var auto-start already branches inside ensureClients (XR_AUTOSTREAM=1 starts relay only, for Simulator) — precedent for mode-conditional startup.  
  `native/ios-companion/Sources/ContentView.swift:434-440`

**Porting:** The natural design: an `enum AppMode: String { case solo, stream }` persisted via @AppStorage (matching the existing xr.* key pattern), surfaced as a glass segmented pill in/above the bottomPanel. beginRunning() branches: stream -> current behavior; solo -> tracker.start + SoloSessionEngine.start, no relay. The badge row swaps SENDING for a solo metric (e.g. elapsed/steps), bottomPanel swaps host/SECURE/dialTarget for walk controls, and everything else (topBar, camera preflight, framingChip, modeChip, SkeletonOverlay, SetupTipsCard, idle/blocked placeholders) is shared verbatim. ensureClients must learn to construct the tracker with a sink that isn't the relay (see the PoseFrameSink seam in the tracker section).

**Risks:** ContentView is already 653 lines; putting Solo's summary/history UI inline will make it unmaintainable — new screens should be new files, with ContentView only hosting the mode switch and capture chrome. Also `running` is a single bool shared by both concerns today (tracker + relay); Solo adds a third lifecycle (the walk/session state machine: setup -> walking -> summary) which should not be crammed into that bool.

### App entry and onboarding flow (Enter orb -> camera)

- XRunwayCompanionApp switches between EnterScreen and ContentView via `entered`/`transitioning` @State; the 4.4 s cinematic (grow/settle/crumble/bounce/drop) is pure elapsed-time math in an overlay, and XR_START_CAMERA=1 skips the Enter screen.  
  `native/ios-companion/Sources/XRunwayCompanionApp.swift:23-104`
- The idle timer is disabled app-wide on appear (`UIApplication.shared.isIdleTimerDisabled = true`) — the screen never sleeps while the app runs.  
  `native/ios-companion/Sources/XRunwayCompanionApp.swift:88`
- EnterScreen's hold-to-charge orb calls onEnter(point) after a 0.35 s charge with Haptics.tap(), and has a reduce-motion tap fallback; OrbView (refraction lens + lava + rim) is a reusable parameterized component.  
  `native/ios-companion/Sources/Onboarding/EnterScreen.swift:14-227`

**Porting:** Solo mode lands AFTER this flow — no changes needed to XRunwayCompanionApp or Onboarding/ for a minimal Solo. If Solo gets its own landing choice (Solo vs Stream picked at entry), the hook is the `entered` branch at XRunwayCompanionApp.swift:43-49, but a simpler v1 keeps the single cinematic and puts the mode toggle on the camera screen. The always-on idle timer is exactly what a propped-phone solo walk needs — already done.

**Risks:** None for the streaming path — leaving these files untouched is the safe default. If the design adds a mode-select page mid-cinematic, the phase timing math (phase(at:) lines 112-144) is delicate and was tuned on-device.

### Prefs / persistence patterns

- All persisted prefs are @AppStorage in ContentView with an `xr.` key prefix: xr.relayHost (default "192.168.1.42"), xr.relaySource ("iphone-arkit"), xr.relaySecure (false).  
  `native/ios-companion/Sources/ContentView.swift:47-49`
- These three @AppStorage properties are the ONLY persistence in the entire app — grep for AppStorage/UserDefaults across Sources finds nothing else; there is no file store, no Codable-to-disk, no history of any kind.  
  `native/ios-companion/Sources/ContentView.swift:47-49 (exhaustive grep of Sources/)`

**Porting:** Solo's mode flag and small settings (coach voice on/off, units) fit the existing pattern: @AppStorage("xr.mode"), @AppStorage("xr.coachVoice") etc. But Solo's history/trends/exports need a NEW persistence layer with no precedent in this codebase — a WalkRecord Codable store writing JSON to Application Support (or SwiftData) is a new file (e.g. Sources/Solo/WalkHistoryStore.swift). Exports can use UIActivityViewController/ShareLink (no Info.plist key required); if 'visible in Files app' is wanted, add UIFileSharingEnabled + LSSupportsOpeningDocumentsInPlace to project.yml's info block.

**Risks:** UserDefaults is the wrong home for per-walk time-series or growing history (size + no migration story). Every design claim about 'history/trends' must be marked as net-new code, not an extension of an existing store — there is nothing to extend.

### Liquid Glass design language — tokens/components reusable for a Solo summary screen

- The dark-screen palette is the `Brand` enum: bg #0a0c10, accent Carolina blue #4b9cd3 (+deep/soft variants), white #f2f5f8, silver #8a8f96, and ok/warn/bad status colors — used by every chip and panel.  
  `native/ios-companion/Sources/ContentView.swift:24-35`
- The glass vocabulary is `.glassEffect(.regular, in: Capsule())` for pills/badges (5 sites) and `.glassEffect(.regular, in: ConcentricRectangle())` + white-0.12 stroke for the bottom panel — iOS 26 native Liquid Glass, layered over live full-screen content.  
  `native/ios-companion/Sources/ContentView.swift:193,223,232,250,277,362-363`
- Reusable composition patterns: badge(label,value) monospaced pill; connectionPill (dot + colored text in tinted capsule); framing/mode chips (icon + monospaced text); the START button style (heavy monospaced, tracking 3, accent->accentDeep gradient, radius-14 rounded rect); SetupTipsCard's icon-circle + title/body tip rows in a .medium detent sheet on Brand.bg.  
  `native/ios-companion/Sources/ContentView.swift:197-281,334-351,511-557`
- Light-screen tokens live in EnterTokens (off-white #EFEFEF background, Impact wordmark sizing/slant, lava palette, motion springs); BrandWordmark(size:color:) is explicitly 'reusable elsewhere in the app at a different size/color'.  
  `native/ios-companion/Sources/Theme/EnterScreenTokens.swift:17-114 and native/ios-companion/Sources/Onboarding/BrandWordmark.swift:5-33`
- Typography convention throughout the camera UI: monospaced SF with wide tracking for labels/headings (e.g. tracking(3) 13pt semibold headers), 12pt regular white-0.7 body text.  
  `native/ios-companion/Sources/ContentView.swift:124-134,514-528`

**Porting:** A Solo summary screen composes directly from these: Brand palette + glass capsules/ConcentricRectangle cards for score tiles, the badge/chip pattern for per-metric readouts, the START-button gradient style for 'WALK AGAIN', SetupTipsCard's tip-row layout for coaching notes, and BrandWordmark for the header. Recommended refactor while touching this: Brand currently lives inside ContentView.swift — moving it to Sources/Theme/ (alongside EnterScreenTokens) lets new Solo files import it without depending on the capture screen file. Note glassEffect over a static (non-camera) summary background is fine but the file's own comment says glass is 'chrome over live content' — a summary over Brand.bg/bgDeep gradient keeps that spirit.

**Risks:** The private helper views (badge, framingChip, etc.) are `private` members of ContentView — reusing them in new Solo files requires extracting them, which touches the streaming screen; extraction must be purely mechanical to keep the relay-path UI pixel-identical. ConcentricRectangle and .glassEffect are iOS-26-only APIs — safe here (deployment target 26.0) but any claim of broader device support would be false.

### Haptics and TTS precedent

- Haptics is a single @MainActor enum with one method: Haptics.tap() = UIImpactFeedbackGenerator(style: .light), used at exactly the app's commitment moments (orb charge complete, START/STOP tap).  
  `native/ios-companion/Sources/Haptics.swift:14-21`
- There is NO TTS, NO audio playback, and NO AVAudioSession code anywhere in the companion: case-insensitive grep for AVSpeech/speech/tts/utterance/AVAudio/audio across Sources/, project.yml, and Resources/Info.plist returns zero hits (ContentView imports AVFoundation solely for AVCaptureDevice permission preflight).  
  `native/ios-companion/Sources/ContentView.swift:20,466-474 (grep receipt: no matches in Sources/, project.yml, Info.plist)`

**Porting:** Mid-walk voice coaching is entirely NEW code. Add a Sources/Solo/CoachVoice.swift built on AVSpeechSynthesizer + AVSpeechUtterance; it needs an AVAudioSession configured (.playback category, likely .duckOthers) and activated before speaking — no Info.plist key is required for speech output (microphone is not used). ARKit camera capture and AVSpeechSynthesizer coexist, but the session category choice should be verified on-device with the ARSession running. Haptics extends naturally: add e.g. Haptics.milestone()/Haptics.warning() using heavier impact or UINotificationFeedbackGenerator, keeping the one-seam pattern the file header describes. Note the web app already has mid-walk coach-voice copy (per the polish-audit memory) — the phrase set can be ported, but the Swift speech plumbing has no precedent here.

**Risks:** Any design claim that the companion 'already has audio/voice infrastructure' is FALSE and would fail fact-checking. Silent-mode behavior (utterances muted by the ring switch unless the audio session uses .playback) and speaking-over-the-walk timing are new on-device verification items.

### Relay/streaming path — must keep working untouched

- PoseRelayClient is a self-contained actor: dials ws(s)://<host>:8082 (relayPort matching vite.config.ts), sends hello on open, streams pose messages throttled <=30/s, auto-reconnects with 1s->15s backoff, 6 s connect watchdog, 5 s stability gate before backoff reset.  
  `native/ios-companion/Sources/PoseRelayClient.swift:46-70,109-215`
- Its only inbound API surface is start(host:source:secure:), updateSource(_:), stop(), and send(frame:); UI coupling is via the @MainActor RelayStatus mirror (phase/sendFps/lastError/lastHint/target).  
  `native/ios-companion/Sources/PoseRelayClient.swift:31-43,109-147,336-354`
- send(frame:) silently no-ops unless running && connected — so a tracker wired to a relay that was never started is already harmless (frames are dropped at the guard).  
  `native/ios-companion/Sources/PoseRelayClient.swift:336-337`
- Failure diagnostics (hint(for:)) map URLError codes to plain-language fixes including the Local Network permission pointer; RelayTrustDelegate accepts the dev relay's self-signed TLS for wss.  
  `native/ios-companion/Sources/PoseRelayClient.swift:279-304,375-386`
- The wire contract structs (HelloMessage, PoseMessage) live in PoseFrame.swift and are ported 1:1 from src/external-tracker.ts / public/companion/index.html; the headset re-stamps frame.t on arrival (src/pose-ingest.ts).  
  `native/ios-companion/Sources/PoseFrame.swift:1-33,99-124`

**Porting:** Solo mode should not modify a single line of PoseRelayClient.swift. The fact that send() no-ops when not running means the minimal-diff Solo implementation could even keep constructing the relay and simply never call relay.start() in solo mode — zero risk to the streaming path. The cleaner version (PoseFrameSink protocol on ARBodyTracker) touches only the tracker's stored-property type and init signature; PoseRelayClient conforms without body changes.

**Risks:** The one shared mutation risk is ARBodyTracker's init/publish refactor: if the sink indirection changes send scheduling (currently one detached Task per frame at ARBodyTracker.swift:366), stream throughput could regress — keep the relay's call path byte-identical and add the Solo consumer alongside, then re-verify the live iPhone->relay pipeline that the pose-relay review confirmed working.

### project.yml / build configuration facts

- XcodeGen project, single app target XRunwayCompanion, deployment target iOS 26.0, sources = Sources/ + Resources/Assets.xcassets, bundle id com.mjzun.xrunway.companion, TARGETED_DEVICE_FAMILY 1,2, dependencies: [] ('ARKit / RealityKit / Vision / SwiftUI ship with the SDK').  
  `native/ios-companion/project.yml:10-75`
- Resources/Info.plist is a GENERATED artifact — 'XcodeGen GENERATES it reproducibly on every xcodegen generate… do not hand-edit that file, edit these properties instead' — so any new key must go into project.yml's info.properties block.  
  `native/ios-companion/project.yml:37-41`
- Declared permissions today: NSCameraUsageDescription and NSLocalNetworkUsageDescription only, plus ATS NSAllowsArbitraryLoads/NSAllowsLocalNetworking for plain ws; supported orientations are portrait + both landscapes.  
  `native/ios-companion/project.yml:52-65 (generated mirror: native/ios-companion/Resources/Info.plist:25-50)`
- There is no test target in project.yml — the project has zero unit-test infrastructure for Swift code.  
  `native/ios-companion/project.yml:26-75 (targets: contains only XRunwayCompanion)`
- New Swift files need no project.yml edits — sources are declared as the whole Sources/ directory, so added files are picked up on regenerate.  
  `native/ios-companion/project.yml:31-33`

**Porting:** Solo mode's build-config delta is small: TTS output needs NO new Info.plist key; a share-sheet export needs none; only Files-app-visible exports would add UIFileSharingEnabled/LSSupportsOpeningDocumentsInPlace to project.yml (then `xcodegen generate`). Strongly consider adding a unit-test target in project.yml for the Solo scoring math (pure functions over PoseFrame sequences are ideal test subjects, and the web app's 385-test culture has no Swift counterpart yet). NSCameraUsageDescription's current copy says 'stream a pose skeleton to the headset app' — Solo makes that description inaccurate for the no-network mode; reword it in project.yml to cover on-device training too.

**Risks:** Anyone editing Resources/Info.plist directly will have their change silently reverted on the next xcodegen run — the design doc should state the project.yml-only rule. iOS 26.0 minimum is unusually high; that's a deliberate existing choice (Liquid Glass), not something Solo introduces.

### File-by-file change map for Solo mode

- CHANGED — ContentView.swift: add the SOLO/STREAM mode state (@AppStorage), branch beginRunning()/toggle() so solo skips relay.start, hide stream-only UI (connectionPill, SENDING badge, host field, SECURE toggle, dialTarget line) in solo, host the solo walk controls/summary navigation; extract Brand + shared chips for reuse.  
  `native/ios-companion/Sources/ContentView.swift:39-50,197-214,293-364,428-495`
- CHANGED — ARBodyTracker.swift: replace the concrete `private let relay: PoseRelayClient` + init(relay:state:) with a sink protocol (or sink list) so a SoloSessionEngine can consume publish()'s frames; publish() body otherwise unchanged.  
  `native/ios-companion/Sources/ARBodyTracker.swift:78,109-114,361-367`
- CHANGED (likely) — Haptics.swift: add coaching-feedback patterns beside tap(); project.yml: reword NSCameraUsageDescription, optionally add export/file-sharing keys and a test target.  
  `native/ios-companion/Sources/Haptics.swift:14-21 and native/ios-companion/project.yml:39-65`
- NEW — no existing counterparts anywhere in Sources/: SoloSessionEngine (walk state machine + frame-invariant metric derivation from world-space PoseFrames), CoachVoice (AVSpeechSynthesizer + AVAudioSession), SoloSummaryView, WalkHistoryStore + trends/export views. Suggested home: Sources/Solo/.  
  `native/ios-companion/Sources (current tree contains only XRunwayCompanionApp/PoseFrame/ARBodyTracker/PoseRelayClient/Haptics/ContentView + Onboarding/ + Theme/ + Shaders/)`
- UNTOUCHED — PoseRelayClient.swift (entire streaming transport), PoseFrame.swift (wire contract structs; Solo consumes the same struct), XRunwayCompanionApp.swift (enter cinematic), all of Onboarding/ (EnterScreen, WelcomePage, BrandWordmark, GlassBubbleView, LavaColorView, SwipeHintView), Theme/EnterScreenTokens.swift, Shaders/SphereLens.metal.  
  `native/ios-companion/Sources/PoseRelayClient.swift:1-407 and native/ios-companion/Sources/PoseFrame.swift:1-124`

**Porting:** The honest-metrics constraint carries over exactly: the Solo engine's derivations must stay frame-invariant (speed magnitude from world-space displacement, gravity-aligned tilt/bob since ARKit world frame is +y-up/gravity-aligned, lateral deviation measured from the walker's own travel direction) — absolute runway position remains invalid because the ARKit world origin is wherever the session started. ARBodyTracker's world-space frames (space:"world") are sufficient input for all of these; no runway registration code exists or is needed on the phone.

**Risks:** Biggest port risk is scope creep into ContentView (already the largest file at 653 lines) and the tracker-relay decoupling — both are the only two files where a Solo bug could break the proven streaming path, so the design should mandate: relay call path byte-identical, stream-mode UI pixel-identical, and an on-device re-check of the live iPhone->relay pipeline after the refactor. Secondary: Vision-fallback devices must get an explicit 'Solo needs 3D body tracking' block (mirror the CameraBlock pattern) rather than silently scoring image-space garbage.

## A4. Prior art + golden vectors

### C# Core port inventory — what already translates (native/unity/Assets/XRunway/Core)

- The port is 5 engine-agnostic C# files with zero UnityEngine dependency: Metrics.cs (780 lines), PoseFrame.cs (181), RunwayLayout.cs (347), ShowDirector.cs (315), ShowTypes.cs (94); the README declares Core 'a faithful, engine-agnostic C# port of the validated (X)RUNWAY logic' with a file-by-file TS-source table.  
  `native/unity/Assets/XRunway/README.md:9-25`
- Metrics.cs ports ALL THREE derivation paths as separate methods: DeriveFromPose (normalized image coords, side camera), DeriveFromPoseWorld (world-space meters, 'e.g. native ARKit landmarks'), and DeriveFromHead — dispatch is on frame.Space == "world".  
  `native/unity/Assets/XRunway/Core/Metrics.cs:277-301 (dispatch), 339 (DeriveFromPose), 485 (DeriveFromPoseWorld), 648 (DeriveFromHead)`
- DeriveFromPoseWorld carries the full world-pose math the Solo phone needs: hip-speed clamp at 4 m/s with exp(-2*dt) EMA; travel-heading EMA exp(-1.5*dt); per-ankle |lateral| against the perpendicular of the heading; hip-bob cadence with 0.008 m hysteresis, step window 0.15-1.2 s, ring of 8, MAD/CV rhythm 100 - cv*220; score maps pace 95-|ema-ideal|*70, posture 40+((upright-0.9)/0.09)*58, footwork 96-latEma*240; composites presence/confidence/presentation as fixed re-weightings plus a 45 s sessionRamp*10 confidence credit.  
  `native/unity/Assets/XRunway/Core/Metrics.cs:512-643 (cf. src/metrics.ts:593-728 — formulas identical)`
- PoseFrame.cs ports the relay contract: PoseKeypoint/PoseFrame with space "image"|"world", the nine canonical keypoint names, and ExternalTracker with the 0.6 s staleness gate (StaleAfterSec) and injected clock — Latest() returns null when stale so consumers fall back.  
  `native/unity/Assets/XRunway/Core/PoseFrame.cs:47-104, 115-158`
- RunwayLayout.cs ports the runway frame math verbatim: RunwayProjector.Along/Lateral/AlongFraction (pure scalar, zero-alloc), FromEndpoints yaw solve yaw = atan2(-dx,-dz), Sanitize clamps, LayoutLimits, plus the persistence seam keyed 'xrunway.runwayLayout.v1' in the exact TS JSON shape.  
  `native/unity/Assets/XRunway/Core/RunwayLayout.cs:190-245 (projector), 156-181 (FromEndpoints), 135-145 (Sanitize), 273 (storage key)`
- ShowDirector.cs ports the phase machine idle->brief->countdown->walk->summary with delta-accumulated timers, the round-trip progress mapping (0..0.5 out, 0.5..1 back), monotonic clamp JitterBack=0.05, MarkRadius/FinishRadius=0.4, weighted overall, DeltaVsLast, and preserves the TS event ordering (summary published BEFORE the phase flips).  
  `native/unity/Assets/XRunway/Core/ShowDirector.cs:54-67, 207-257, 288-313`
- The M1..M7 metric table (row order posture, pace, rhythm, footPlacement, presence, confidence, presentation) and the checkbox threshold MetricPass = 78 are ported as static data.  
  `native/unity/Assets/XRunway/Core/Metrics.cs:50-79`
- The README already prescribes golden checks as the fidelity method: 'drop Core/*.cs into a netstandard2.1 test project... port the web app's runway-layout unit tests verbatim — the RunwayProjector numbers must match the TS exactly', listing projector/FromEndpoints/Sanitize/weighted-overall goldens.  
  `native/unity/Assets/XRunway/README.md:398-416`

**Porting:** This is the existence proof that the scoring logic survives a language move: every EMA, ring buffer, score map, and state machine already lives in a second language with no engine dependency. For Swift, mirror the same architecture — a pure 'XRunwayCore' Swift module with injected head/pose providers and clocks, no UIKit/ARKit imports — so XCTest can drive it exactly as the README proposes driving .NET. DeriveFromPoseWorld is the Solo-mode centerpiece; DeriveFromHead becomes irrelevant on phone-only (no headset), and RunwayProjector/ShowDirector's along-axis progress needs rethinking because Solo mode has no registered runway frame.

**Risks:** The C# port is evidence, not source of truth — it has drifted behind the TS (see the drift section). Any golden vectors must be generated from the TS, and the design doc must not cite Metrics.cs formulas as 'current' where they diverge (idealPace, heading seed, hip fallback, frame gating).

### JS-rounding and numeric-semantics notes — the portability landmines the C# port already documented

- CoreMath.JsRound(x) = Math.Floor(x + 0.5), documented as 'JS-faithful round: half rounds toward +Infinity (JavaScript Math.round), NOT .NET's banker's rounding. Used everywhere the TS calls Math.round so the published metric/overall/fps values match the web prototype exactly.'  
  `native/unity/Assets/XRunway/Core/ShowTypes.cs:15-23`
- JsRound is applied at every publish boundary: the 6 Hz rounded MetricSnapshot copy, the walk duration (round to 1 dp) and the clamped weighted overall in FinishWalk, and the tracker FPS ('JS half-toward-+Infinity, not .NET banker's rounding').  
  `native/unity/Assets/XRunway/Core/Metrics.cs:319-328; ShowDirector.cs:290-297; PoseFrame.cs:168-173`
- Sanitize documents that C# '%' keeps the dividend's sign exactly like JS '% (Math.PI*2)' — negative yaws stay negative — so modulo semantics were checked, not assumed.  
  `native/unity/Assets/XRunway/Core/RunwayLayout.cs:129-144`
- Layout JSON serialization uses InvariantCulture and round-trip 'R' formatting to stay byte-compatible with the web app's localStorage shape.  
  `native/unity/Assets/XRunway/Core/RunwayLayout.cs:276-290`
- The TS rounds real measurements before persisting: WalkStats uses round3 (Math.round(v*1000)/1000) for pace/lateral/posture means and round1 for cadence — these fields can be NEGATIVE (signed lateral/posture means), so Math.round's negative-half behavior is reachable.  
  `src/walk-stats.ts:71-77, 220-238`

**Porting:** Swift has the identical trap: Double.rounded() defaults to .toNearestOrAwayFromZero, so (-2.5).rounded() == -3 while JS Math.round(-2.5) == -2. The Swift port needs one jsRound(_ x: Double) -> Double { (x + 0.5).rounded(.down) } used at every Math.round site (snapshot publish, overall, duration, round3/round1 in WalkStats, cm rounding in coach cues). Second landmine: JS numbers are 64-bit doubles; the C# port chose 32-bit float and therefore CANNOT be bit-exact with the TS — Swift should use Double throughout so golden vectors can assert tight (1e-9) or exact equality on the same operation order.

**Risks:** If Swift copies the C# float choice, EMA chains (dozens of multiplies per second over a 60 s walk) accumulate visible divergence and golden tolerances must loosen to ~1e-3, weakening the vectors. Negative-half rounding differences would surface exactly in the signed channels (postureDriftM, meanLateralM) that feed spoken coach copy — an off-by-1-cm cue string is a user-visible fact-check failure.

### Port drift — where the C# Core lags the current TS (proves vectors must be TS-generated)

- Fresh-frame gating: the TS derives pose ONLY when frame.t changes, using the TRUE inter-pose interval ('Re-deriving a repeated frame divides a zero hip displacement by the app delta and decays the pace EMA toward zero'); Metrics.cs still calls DeriveFromPoseWorld(frame, delta) with the app-frame delta every Update — the C# port (files dated Jun 22-23) predates the 2026-06-30 fix.  
  `src/metrics.ts:264-282 vs native/unity/Assets/XRunway/Core/Metrics.cs:267-301`
- Ideal pace: the TS locks the ACTIVE MODE's idealPace at walk start (0.85/0.72/0.95/1.05 across beginner/highfashion/commercial/challenge); Metrics.cs hard-codes const IdealPace = 0.85f.  
  `src/metrics.ts:332, src/modes.ts:39-127 vs native/unity/Assets/XRunway/Core/Metrics.cs:96`
- Single-hip fallback: the TS accepts one hip ('defensive; ARKit normally backfills both from .root'); the C# returns early unless BOTH hips pass the 0.3 score gate.  
  `src/metrics.ts:583-587 vs native/unity/Assets/XRunway/Core/Metrics.cs:498-502`
- Heading honesty: the TS computes footwork lateral only after poseHeadingValid — heading 'must come from measured motion, never a seed, or we'd project against a meaningless direction'; the C# still seeds the heading from the mapped runway's yaw at walk start.  
  `src/metrics.ts:605-618 vs native/unity/Assets/XRunway/Core/Metrics.cs:229-233`
- The whole WalkStats measurement layer is absent from C#: the TS camera-world path credits noteSource('camera-world'), feeds true m/s via stats.addPace, counts strikes via stats.addStep, and deliberately nulls the lateral and posture live taps (ARKit frame unregistered; torso tilt is a different quantity than head-height drift); no walk-stats, coach, coach-live, or progress .cs exists (Core is exactly 5 files).  
  `src/metrics.ts:567-576, 601-603, 664 (taps); ls of native/unity/Assets/XRunway/Core/ = Metrics.cs, PoseFrame.cs, RunwayLayout.cs, ShowDirector.cs, ShowTypes.cs only`
- Show machine drift: show.ts uses the run mode's walkSeconds and per-mode weights for the overall, and supports one-way (U) routes that finish at the mark; ShowDirector.cs hard-codes WalkSec=60, fixed beginner weights (0.2/0.15/0.15/0.2/0.1/0.1/0.1), and only out-and-back finish.  
  `src/show.ts:283, 365-379, 390, 487-495 vs native/unity/Assets/XRunway/Core/ShowDirector.cs:57-58, 83-90, 247`
- The README's fidelity paragraph ('EMA rates and score mappings... match the TypeScript line-for-line') was accurate at port time and is now stale in the specific points above — the web app is explicitly 'the source of truth for the LOGIC'.  
  `native/unity/Assets/XRunway/README.md:6-7, 27-34`

**Porting:** For Swift, port from the CURRENT TS, not from C#. The three TS-side changes the C# missed are precisely the ones Solo mode depends on: (1) fresh-frame gating with true inter-pose dt is mandatory when ARKit body anchors update slower than the render/timer loop; (2) measured-motion heading (poseHeadingValid) is the only valid option on a phone with no mapped runway to seed from; (3) per-mode idealPace feeds both scoring and the live coach's paceDelta. The single-hip fallback also matters: ARKit occlusion drops joints mid-walk.

**Risks:** A design doc that copies Metrics.cs verbatim re-introduces the pace-EMA-decay bug the 2026-06-30 fix removed and hardwires a runway-yaw dependency Solo mode cannot satisfy. Also the drift shows the cost of replica-style porting with no executable cross-check — exactly the failure mode golden vectors exist to close.

### test/pose-derive-demo.mjs — the synthetic world-pose harness (generator prior art)

- A 94-line, dependency-free node script ('node test/pose-derive-demo.mjs') that 'faithfully replicates the WORLD-POSE speed/footwork/rhythm math from src/metrics.ts (deriveFromPoseWorld) and drives it with a simulated walk' to validate the 2026-06-30 fix offline — 'a faithful REPLICA of the formulas (same constants, same EMA), so it validates the ALGORITHM'.  
  `test/pose-derive-demo.mjs:1-18`
- It simulates an app loop at 90 Hz consuming a pose stream capped at 30 Hz for a 12 s walk, modeling latest() as 'most recent pose frame at or before tApp' — i.e. the same repeated-frame semantics as ExternalTracker.  
  `test/pose-derive-demo.mjs:20-22, 41-47`
- It runs BOTH policies side by side — OLD (derive every app frame with the app delta on the repeated frame) vs NEW (derive only on a fresh frame with the true inter-pose delta) — with the metrics.ts speed clamp (4 m/s) and pace-score formula, and reports converged EMA mean, score, and SD over the last 2 s per true speed in {0.8, 1.1, 1.3, 1.6, 2.0, 2.6} m/s.  
  `test/pose-derive-demo.mjs:26-79, 84`
- Verified by running today: the NEW gated policy lands 0% error with ±0.00 SD at every speed; the OLD policy underestimates by 17%/33%/49% at 1.6/2.0/2.6 m/s (its per-app-frame spikes hit the 4 m/s clamp, converging the EMA to ~1.33 regardless of true speed).  
  `test/pose-derive-demo.mjs:62-71 (old policy), 55-57 (clamp) — output reproduced 2026-07-02`
- It is a demo, not a test: it prints a table and asserts nothing programmatically, is not wired into 'npm test' (package.json test = 'vitest run'), and uses a representative IDEAL_PACE of 1.3 m/s that matches NO shipped mode (modes ship 0.72-1.05; the metrics fallback const is 0.85).  
  `test/pose-derive-demo.mjs:23; package.json:15; src/modes.ts:39-127`

**Porting:** This script is the template for the golden-vector GENERATOR: it proves a synthetic world-pose walk with analytically known ground truth can drive the derivation deterministically. Extend it into the generator by (a) building full 9-keypoint frames (hips + shoulders + ankles) with a sinusoidal hip bob (amplitude > 0.008 m, period ~0.55 s) so cadence/steps/rhythm and footwork channels light up, not just pace; (b) pinning expected outputs to JSON instead of printing a table; (c) using the real mode idealPace values.

**Risks:** Replica drift: the demo re-implements the formula rather than importing it, so a future metrics.ts change silently invalidates it (its own header concedes the on-device smoke test is the full-fidelity check). The golden generator must import the real derivation — which required extracting deriveFromPoseWorld from the @iwsdk/core-coupled MetricsSystem class into a pure module first (**satisfied in A1: src/pose-derive.ts `deriveWorld`; the generator and vitest import the real code**, and the demo's analytic-truth idea landed as the generator's assert-then-emit anchors).

### Vitest suites as platform-independent behavioral contracts — 140 cases, all green (verified 2026-07-02)

- Running 'npx vitest run' on the four assigned suites: 4 files passed, 140 tests passed (walk-stats 19, coach 30, coach-live 39, progress 52). All four source modules are dependency-free by design ('no @iwsdk/core, no DOM... loads in vitest'), with type-only imports where they touch show.ts/modes.ts.  
  `src/walk-stats.ts:13-17; src/coach.ts:33-41; src/progress.ts:12-19; package.json:15`
- walk-stats.test.ts pins the WalkStats contract: finalize()->null only when nothing ran; per-channel independent nulls; duration-weighted means; mm/s rounding; NaN/Infinity/non-positive-dt sample rejection; signed lateral mean vs abs-mean weave detection; step debounce at STEP_DEBOUNCE_SEC=0.15 with no upper bound; cadence spm; source dominance by accumulated time; resetLateral() clearing ONLY the centerline channel on mid-walk remap; full reset() rearm including the debounce clock.  
  `test/walk-stats.test.ts:14-52, 54-84, 87-104, 122-146, 148-166, 168-194, 196-224; src/walk-stats.ts:69`
- coach.test.ts pins the post-walk report: pass exactly at the mode bar with UI-style rounding (77.5 passes, 77.49 fails); per-mode bars; below-line notes ranked weight-x-shortfall, capped at 3, ties in M1..M7 order; EXACT directional cue strings for pace/posture/footwork/rhythm; the sub-display-resolution honesty guard (identical rendered numbers -> generic cue); the one-way-route + LATERAL_SIDE_CONSISTENCY (0.6) gate before naming left/right; composites (M5-M7) never claiming measurement; every emittable string ASCII-only for the XR panel font.  
  `test/coach.test.ts:85-108, 111-144, 146-197, 224-289, 304-367, 402-436; src/coach.ts:105, 155-168, 233-256`
- coach-live.test.ts pins the 2 Hz mid-walk voice policy: earliest cue at SETTLE_SEC+FAULT_HOLD_SEC=7.5 s; clean/NaN/null samples RESTART fault clocks (clear, never mute); strict > thresholds (0.25 m/s, 0.20 m, 0.06 m); dual final guard (4 s clock AND 0.9 route progress); turn suppression (4 s out-and-back, to-walk-end one-way); 9 s cooldown, per-kind cap 2, no back-to-back repeats, pace > center > posture priority; NaN/Infinity route through the null path on every channel; the closed-gate clearFaults law; the markAt latch preventing fabricated 'pace-slow' during the physical turn.  
  `test/coach-live.test.ts:55, 78-122, 124-168, 170-227, 229-264, 266-318, 396-435, 438-461, 463-482; src/coach-live.ts:144-171`
- progress.test.ts pins the history/trends layer: the qualifying set (synthetic and non-finite rows out, chronological sort of newest-first input); personalBest with earliest-walk tie keep; rollingAverage over last 5; the documented trendDelta window rule (w = min(5, floor(n/2)), last w vs previous w); SERIES_MAX=20 cap; per-metric trends where finalScores-less rows don't vote; latestIsPersonalBest strictness (ties and newer synthetic rows say false); per-mode modeStats judged against each row's OWN stored bar (legacy fallback 75, legacy bucket never mastered); mastery = 3 passes in the last 5 of that mode; masteryJustEarned announce-once semantics including loss and re-earning.  
  `test/progress.test.ts:38-66, 68-88, 90-133, 141-147, 150-178, 180-210, 223-354, 356-412; src/progress.ts:55-57, 213-221`
- Every case in all four suites is pure data-in/data-out (constructed inputs -> asserted values/strings/timings); none touches DOM, WebXR, ECS, timers, or network — the run() driver in coach-live.test.ts even samples on the same 2 Hz grid the real system uses.  
  `test/coach-live.test.ts:23-53`

**Porting:** These 140 cases ARE the Solo-mode behavioral spec for everything downstream of pose derivation: WalkStatsAccumulator, buildCoachReport (+ all spoken/displayed strings), LiveCoachPolicy (the mid-walk audio coach), and the progress/mastery layer — all four modules port to Swift nearly line-for-line since they are already dependency-free scalar/data code. Phone-only deltas: LiveCueInput.walkProgress01 and markAtSec come from show.ts route geometry today; Solo mode must synthesize them from its own walk model (elapsed/duration and a detected turn or distance mark), and the lateral channel only exists if Solo derives lateral-from-travel-direction (metrics.ts:614-636 pattern) since there is no centerline.

**Risks:** The tests encode exact strings and exact cue timings on a 0.5 s grid — a Swift port that samples on a different grid or localizes copy will fail vectors for reasons that are design decisions, not bugs; the design doc should state whether string-exactness is required cross-platform. progress.ts imports session-grading.js at runtime (isSyntheticRow/rowPassed, progress.ts:21) — the Swift port must carry that tiny module too or inline its two rules.

### Golden-vector proposal — file format, generator, Swift consumption

- Feasibility receipts: the four behavior modules load standalone in vitest today (their stated design goal), so a TS emitter script can import them directly and serialize real outputs; the C# README already validated the 'port tests verbatim, numbers must match exactly' method; the pose-derive demo already validated synthetic pose-walk driving.  
  `src/walk-stats.ts:13-17; native/unity/Assets/XRunway/README.md:406-416; test/pose-derive-demo.mjs:1-18`
- The one blocker for derivation vectors: deriveFromPoseWorld is a private method of MetricsSystem, an @iwsdk/core createSystem class — it must be extracted into a pure module (the walk-stats.ts pattern) before the generator can import the real code instead of replicating it.  
  `src/metrics.ts:100, 567-729`
- JSON cannot represent NaN/Infinity, and the coach-live suite explicitly requires NaN and ±Infinity inputs to behave as unmeasured — the vector format therefore needs a sentinel encoding for non-finite numbers.  
  `test/coach-live.test.ts:396-435`
- Expected outputs are dominated by already-quantized values — Math.round-published snapshot ints, round3/round1 WalkStats fields, cm-rounded cue strings, integer overall/verdicts — which admit EXACT cross-language comparison, with raw-double EMAs the only tolerance-needing values.  
  `src/metrics.ts:313-321; src/walk-stats.ts:71-77; src/coach.ts:172-201`

**Porting:** PROPOSED FORMAT — one JSON file per module under test/golden/, envelope: { schema: 'xrunway-golden/1', module: 'walk-stats'|'coach'|'coach-live'|'progress'|'pose-derive-world'|'walk-replay', generatedBy: { script, gitSha, date }, cases: [{ name, input, expect }] }. Non-finite sentinel: {'$num':'nan'|'+inf'|'-inf'} anywhere a number is allowed. Per-module case shapes: (1) walk-stats: input = ops tape [{op:'reset',idealPace}|{op:'addPace',v,dt}|{op:'addLateral',v,dt}|{op:'addPosture',v,dt}|{op:'addStep',at}|{op:'noteSource',source,dt}|{op:'resetLateral'}|{op:'finalize',durationSec}], expect = WalkStats-or-null per finalize op. (2) coach: input = CoachContext verbatim (scores, overall, mode{passThreshold,weights}, stats, oneWayRoute), expect = full CoachReport including exact cue strings and directional flags. (3) coach-live: input = { grid: 0.5, samples: [{t, in: LiveCueInput}], ops: [{t, op:'reset'|'clearFaults'}] }, expect = [{t, kind, text}]. (4) progress: input = rows: ProgressRow[] + queries [{fn:'modeStats'|'masteryJustEarned'|'progressReport'|..., args}], expect per query. (5) pose-derive-world: input = { idealPace, frames: [{t_ms, keypoints:{leftHip:{x,y,z,score},...}}] }, expect = { targetsAt: [{t, posture, pace, rhythm, footPlacement, presence, confidence, presentation}] (raw doubles, tol), publishedAt: [{t, snapshot-of-ints}] (exact), stats: WalkStats (exact) }. (6) walk-replay (highest value): one 30 Hz synthetic walk in, expected 6 Hz rounded snapshots + 2 Hz cue timeline + final WalkStats + CoachReport out — the whole Solo loop in one vector. GENERATOR (as landed): scripts/gen-golden-vectors.mjs run via plain `node` (native type-stripping + a resolve hook), importing src modules directly; the git SHA is embedded AND enforced — emission refuses a dirty tree so the stamp reproduces the bytes, and `--check` (wired into npm test) rebuilds in memory and diffs against disk so a stale vector goes red web-side, not just in Swift. SWIFT SIDE: Codable structs mirroring each case shape, one XCTestCase per module enumerating bundle JSONs; comparison = THE SHIPPED RULE (test/golden-format.ts): exact for strings/ints/bools/nulls/rounded fields, raw doubles within 1e-9 absolute + 1e-6 relative. (The earlier "1e-9 relative achievable with Double + TS operation order" claim was wrong in one respect: pose-derive targets are float32-quantized by the publishing Float32Array, so an unquantized Double port sits ~half an f32 ulp (~6e-8 rel) from the emitted expects — the 1e-6 term absorbs exactly that; measured rigid-twin rotation noise is ≤ ~3e-15 and is not a factor.) FRAME-INVARIANCE VECTORS: emit each pose-derive walk twice — raw, and rigidly transformed (world frame rotated ~37° + translated) — with identical expected outputs, mechanically encoding the no-registration honesty rule (speed magnitude, gravity-aligned bob, lateral-from-travel-direction are the only valid channels; metrics.ts:568-576 documents the unregistered-frame position).

**Risks:** Two honesty caveats for the design doc: (a) vectors generated FROM the TS pin 'matches the web app', not 'is physically correct' — the demo's analytic-truth approach should be kept for a handful of cases where ground truth is known independently; (b) EMA warm-up makes early-walk raw targets sensitive to the very first frame's handling (havePrev seeding) — vectors must include the first frames explicitly, not start mid-walk, or ports can pass while diverging at walk start.

### Which existing tests convert to golden vectors (case-by-case disposition)

- walk-stats.test.ts: 18 of 19 convert directly as pure ops-tapes (reset/add*/noteSource/finalize) with a concrete expected WalkStats, including the tricky ones (finalize non-destructive, resetLateral survivorship, debounce-clock rearm). The 19th (live-tap rearm) needs — and AS LANDED has — the `setLive`/`readLive` ops extension: setLive assigns the three live-tap fields directly (what MetricsSystem/pose-derive do), readLive snapshots them into an `expect.lives` array (present only when a readLive op exists), and the reset-nulls-the-live-taps case pins passthrough (incl. a NaN tap — honesty gating lives at the consumers) plus reset() nulling all three.  
  `test/walk-stats.test.ts:14-224; scripts/gen-golden-vectors.mjs + test/golden-replay.ts (the ops runner)`
- coach.test.ts: 26 of 30 convert as context->report vectors (verdict/rounding, per-mode bars using the real MODES table, ranking/cap/tie-break, every directional-copy and fallback case, label/line formatting); the 4 remaining are copy-TABLE property tests (composite-honesty wording x3, ASCII x1) that assert over METRIC_EXPLAIN/METRIC_COACH as a whole, not per-case I/O.  
  `test/coach.test.ts:85-399 (convertible), 304-367 + 402-436 (table properties)`
- coach-live.test.ts: 36 of 39 convert as timed sample-tape->cue-list vectors, including the NaN/Infinity channel-honesty cases (via the non-finite sentinel), the closed-gate clearFaults law, and the mark-latch case; the 3 remaining are cue-TABLE tests (copy length/ASCII, earcon distinctness, earcon contour) over LIVE_CUE_TEXT/COACH_EARCONS.  
  `test/coach-live.test.ts:57-482 (convertible), 484-524 (table properties)`
- progress.test.ts: all 52 convert directly — rows arrays are already plain JSON-able data and every expectation is a scalar/struct (modeStats, masteryJustEarned, progressReport, trendDelta, etc.).  
  `test/progress.test.ts:38-442`
- Net: ~133 of 140 cases become data vectors; the 7 table-property tests are better served by EMITTING the string/earcon tables themselves into the golden file (LIVE_CUE_TEXT, COACH_EARCONS, METRIC_COACH, METRIC_EXPLAIN, CLEAN_WALK_CUE are pure exported data) and re-running the property assertions in Swift over the emitted tables — which also guarantees the Swift copy tables cannot drift from TS. **LANDED: test/golden/coach-tables.json emits all five tables + COACH_EARCON_LEVEL + the solo cue thresholds, and test/golden/copy-variants.json carries the §5 Solo copy table; both are deep-compared against the live exports on every vitest run. The Swift harness must byte-compare its tables against coach-tables.json and re-run the 7 property assertions over the emitted tables.**  
  `src/coach-live.ts; src/coach.ts; src/coach-copy.ts; test/golden-freshness.test.ts`
- Coverage gap the vectors should close: NO vitest suite exercises deriveFromPoseWorld end-to-end today — only the assertion-less .mjs demo covers it, and only its pace channel — so the pose-derive-world and walk-replay vector families are new coverage, not conversions.  
  `test/pose-derive-demo.mjs:26-31 (pace-only replica); test/ listing (no metrics/pose-derive vitest suite)`

**Porting:** Conversion is mechanical because the suites' own helpers (sample()/run() in coach-live, stats()/report()/noteFor() in coach, row()/scored()/modeRow() in progress) already define the canonical input shapes — the generator can literally reuse those helpers to build each vector case, keeping the vitest suite and the golden files provably in sync (run the vitest suite, then emit; a red suite blocks emission). Mode data (passThreshold/idealPace/weights/walkSeconds from src/modes.ts:39-127) should be emitted into the golden file as a table too, since Swift needs it and coach.test.ts iterates the real MODES.

**Risks:** Do not convert by hand-copying expected values into JSON — that forks the truth. The only safe pipeline is: vitest green -> generator imports the same modules and helpers -> vectors emitted with git SHA -> Swift XCTest consumes. Also, tests that assert TIMING on the 2 Hz grid (coach-live) implicitly pin the sampling rate as part of the contract; if Solo mode samples the policy at a different rate, those vectors need regenerating with the new grid rather than being 'fixed' on the Swift side.

## A5. Product surface parity

### Core record schemas (the Swift Codable targets)

- MetricSnapshot is exactly 7 numeric fields, all 0..100: pace, posture, rhythm, presence, footPlacement, confidence, presentation.  
  `src/show.ts:68-76`
- Canonical metric order (CSV columns, note tiebreaks, trend line) is posture, pace, rhythm, footPlacement, presence, confidence, presentation — pinned identically in three modules that deliberately do not import each other.  
  `src/session-recorder.ts:142-150 (METRIC_COLS), src/progress.ts:26-34 (PROGRESS_METRIC_KEYS), src/coach.ts:49-57 (METRIC_ORDER)`
- SessionRecord fields: id, startedAt (epoch ms), lesson, modeId (string|null), passThreshold (number|null, captured AT RECORD TIME so history grades against it, not a global constant), trainee (TraineeRef|null), primarySource ("head" | external camera label | "preview"), synthetic (bool), layout (RunwayLayout), durationSec, overall (number|null), deltaVsLast (number|null), finalScores (MetricSnapshot|null), stats (WalkStats|null), samples (MetricSample[]).  
  `src/session-recorder.ts:67-95`
- Record id format is `S-${startedAt}` (epoch-ms based).  
  `src/session-recorder.ts:213`
- TraineeRef = { name: string, id: string }, captured from UserPrefs at walk start for shared-device attribution.  
  `src/session-recorder.ts:59-64`
- MetricSample = { t (s into walk, stored at 0.1 s resolution), 7 rounded-integer scores, paceMps (m/s, null when unmeasured, 0.01 resolution), lateralM (signed m, null when unmeasured, 0.001 resolution), source: "head"|"camera" }.  
  `src/session-recorder.ts:37-57 (shape) and 238-258 (rounding)`
- SessionSummaryRow is the persisted compact row (no samples): id, startedAt, lesson, modeId?, passThreshold?, trainee?, primarySource, synthetic?, durationSec, overall, deltaVsLast?, finalScores, stats?. Post-v1 fields are OPTIONAL: absent synthetic = real walk; absent passThreshold = graded at legacy 75.  
  `src/session-recorder.ts:107-130`
- WalkStats = { meanPaceMps: num|null, idealPaceMps: num, paceDeltaMps: num|null, meanLateralM: num|null, meanAbsLateralM: num|null, postureDriftM: num|null, steps: num, cadenceSpm: num|null }.  
  `src/walk-stats.ts:50-58`
- Persistence constants: localStorage key "xrunway.sessions.v1", persisted-history cap 200 rows, in-memory full-record cap 50, nominal sample rate SAMPLE_RATE_HZ = 6.  
  `src/session-recorder.ts:136-141`
- Full sample arrays live only in memory for the current page-load; hasFullRecord(id) gates per-walk export UI honestly. Only summary rows survive reload.  
  `src/session-recorder.ts:385-390 and 349-354`
- finalize() prefers the LOCKED run mode stamped on the summary (modeId/passThreshold) over the walk-start capture, so the persisted row grades exactly as the summary card did; stamp-less summaries keep the walk-start capture.  
  `src/session-recorder.ts:262-280`
- clearHistory() erases BOTH the persisted rows and the in-memory full records so a post-clear export can never resurrect an erased walk.  
  `src/session-recorder.ts:375-383`
- History load filters out non-object rows at the single ingestion point (schema-drift guard) so downstream rules never see junk elements.  
  `src/session-recorder.ts:810-831`

**Porting:** Swift Codable core = SessionSummaryRow-equivalent struct (all post-v1 fields Optional to mirror the web's legacy tolerance), plus MetricSnapshot, TraineeRef, WalkStats structs. SessionRecord (with samples) can be a superset struct kept in memory only, matching web behavior — persist only summary rows (cap 200) in a file/UserDefaults/SwiftData store. Keep the `synthetic` flag in the schema even though the phone has no Preview Walk auto-pilot (default false): grading and progress rules branch on it, and cross-app export compatibility needs it. Solo mode is single-user, so `trainee` may be nil — every consumer already tolerates that (rowMatchesTrainee: unattributed rows always match). id/rounding conventions (S-epoch, 0.1 s t, integer scores, 0.01 m/s, 0.001 m) should be copied verbatim for export parity.

**Risks:** SessionRecord.layout (RunwayLayout with world-frame centerX/centerZ/yaw) is a REQUIRED field of the walk record — the phone has no registered runway frame, so a Swift port cannot populate it honestly. The design must decide: omit layout under a new schema id, or stamp only the honest subset (walk length). Do not emit fake world-frame coordinates under the existing schema.

### Export envelope + CSV metadata contract

- Every JSON export is wrapped in a self-describing envelope: schema id, appVersion (from package.json), exportedAt (ISO), sampleRateHz, units (EXPORT_UNITS dotted-path map shipped INSIDE each file), device { source?, userAgent }.  
  `src/session-recorder.ts:514-630`
- Single-walk envelope schema id is "xrunway.walk.v2" (WalkExport); multi-walk is "xrunway.history.v2" (HistoryExport) with detail: "full" (in-memory records with samples) | "summary" (persisted rows only).  
  `src/session-recorder.ts:564-585`
- EXPORT_UNITS pins the sign conventions in the file itself, e.g. lateralM "meters, signed centerline offset (+ = trainee's right on the outbound leg)", postureDriftM "signed head-height drift vs the walk-start baseline (+ = above)", paceDelta "+ = faster than the mode's ideal".  
  `src/session-recorder.ts:529-555`
- The history CSV EXCLUDES synthetic rows entirely (auto-pilot data must never sit unmarked in a coach's spreadsheet); the full JSON export still carries them, tagged.  
  `src/session-recorder.ts:338-347`
- Per-walk CSV opens with a pinned '#'-prefixed metadata block — a parser contract of exactly these keys in this order: schema, id, startedAt (ISO 8601 UTC), lesson, mode, passThreshold, trainee ("name (id)"), source, synthetic ("true"/"false"), durationSec, sampleRateHz, appVersion, units — then the column header t_sec,pace,posture,rhythm,footPlacement,presence,confidence,presentation,pace_mps,lateral_m,source, then one row per sample.  
  `src/session-recorder.ts:679-742`
- History CSV columns: id, startedAt_ms, startedAt_iso, trainee_name, trainee_id, lesson, mode, passThreshold, source, durationSec, overall, deltaVsLast, then the 7 metric columns (rounded).  
  `src/session-recorder.ts:752-792`
- Every CSV cell is anti-injection escaped: leading =,+,-,@,tab/CR gets a leading apostrophe; comma/quote/newline forces double-quoting; numbers emit raw (so negative measurements aren't mangled); metadata lines additionally collapse CR/LF and commas to spaces.  
  `src/session-recorder.ts:636-677`

**Porting:** First Solo release: share-sheet JSON only, using the envelope shape verbatim (it is pure data — walkExport/historyExport are DOM-free builders, trivially Codable). device.userAgent maps to a device-model/os string. CSV export can DEFER, but when it lands the metadata-block key order and the anti-injection escaping are the contract — files from the phone will land in the same coach spreadsheets as web exports. The exclusion rule (synthetic rows out of CSV, tagged into JSON) must port with it.

**Risks:** Schema-id honesty: if Solo walks carry travel-direction-relative lateral (not runway-centerline lateral — the phone's ARKit frame is unregistered), reusing "xrunway.walk.v2" with its units string "signed centerline offset" would be a false claim inside the file. Either mint a new schema id (or a Solo variant) with corrected units text, or keep v2 and null the lateral channels. The units map is shipped in-file precisely so a renamed file self-describes — it must not lie.

### Grading rules (session-grading.ts — port wholesale)

- LEGACY_PASS_THRESHOLD = 75: rows persisted before per-run thresholds (or carrying junk) grade against 75.  
  `src/session-grading.ts:26-43`
- isSyntheticRow: synthetic === true only; absent flag = real walk.  
  `src/session-grading.ts:30-34`
- rowPassed: overall !== null AND overall >= the row's OWN stored threshold (fallback 75) — so a Beginner 76 reads NEEDS WORK in history exactly as on the summary card.  
  `src/session-grading.ts:45-50`
- rowMatchesTrainee (pinned): falsy current-trainee id filters NOTHING; a row matches when its trainee.id equals the current id OR when the row has no usable attribution (missing/null trainee, non-string id) — legacy single-user history never vanishes.  
  `src/session-grading.ts:52-71`
- History filters: "all" keeps everything (synthetic rows render with a PREVIEW badge); "pass"/"low" are training verdicts, so synthetic rows are excluded from BOTH, each real row graded against its own threshold.  
  `src/session-grading.ts:73-91`
- The module is deliberately dependency-free (no framework, no DOM) so the rules unit-test in node — a direct port target.  
  `src/session-grading.ts:9-12`

**Porting:** This whole file is ~90 lines of pure functions over an optional-field row — a 1:1 Swift port (protocol or struct with optionals). Solo is single-user so rowMatchesTrainee will usually be a no-op (nil id filters nothing), but port it anyway: it costs nothing and keeps a future multi-profile phone feature and imported web histories correct.

**Risks:** None beyond fidelity: the >= (not >) pass comparison and the null-overall-never-passes rule are the kind of off-by-one a port silently breaks; both are test-enforced on the web side.

### Progress/trends/best/mastery rules (progress.ts — port wholesale)

- The single qualifying set for EVERY progress rule: real (non-synthetic) rows with a finite overall, stable-sorted chronologically by startedAt (junk startedAt sorts as 0, never throws).  
  `src/progress.ts:59-80`
- Constants: TREND_WINDOW = 5, SERIES_MAX = 20 (sparkline cap).  
  `src/progress.ts:54-57`
- personalBest: strict > across all real scored walks; ties keep the EARLIEST walk (matching a record is not a new best); returns { overall, startedAt }.  
  `src/progress.ts:82-101`
- rollingAverage: mean of the last min(window, n) values; null when empty.  
  `src/progress.ts:103-117`
- trendDelta (pinned rule): w = min(window, floor(n/2)); mean of last w minus mean of the w before those; both windows shrink together (4 walks → 2v2, 2-3 walks → 1v1); null when n < 2.  
  `src/progress.ts:119-143`
- metricTrends: per-metric trendDelta counting only walks where that metric has a finite recorded value — a legacy row without finalScores doesn't vote; null under 2 recorded walks.  
  `src/progress.ts:158-178`
- latestIsPersonalBest (drives NEW BEST): latest real walk beat every earlier real walk STRICTLY, at least one earlier real walk exists (first walk = baseline, not best), and NO newer row of ANY kind was recorded after it (a Preview run must never re-announce).  
  `src/progress.ts:180-202`
- LEGACY_MODE_BUCKET = "legacy" for pre-mode rows: they get per-mode stats but NEVER a mastery flag (mastery is a claim about a specific lesson's bar).  
  `src/progress.ts:208-213`
- THE MASTERY RULE (pinned, test-enforced): a mode is mastered when >= MASTERY_PASS_COUNT (3) of the last MASTERY_WINDOW (5) real walks in that mode passed, each judged against ITS OWN recorded threshold. Recency is the point — three early passes buried under recent failures are not mastery.  
  `src/progress.ts:215-254`
- ModeStats per bucket: { modeId, walks (all-time real scored), best, last, passed (all-time, each vs its own bar), mastered }; buckets keep first-walked order and the caller reorders for display.  
  `src/progress.ts:223-289`
- masteryJustEarned (the MODE MASTERED moment): mastered NOW and NOT mastered without the newest in-mode walk; no newer row of any kind after it; never for legacy bucket or absent mode id; needs >= 3 in-mode walks. Idempotent against the post-walk history so a re-render never re-announces and lost-then-re-earned mastery announces again.  
  `src/progress.ts:291-315`
- progressReport bundles walks count, series (last <= 20, chronological), best, rollingAvg, overallTrend, metricTrends, newBest in one pass — the exact input to the trends strip and summary chips.  
  `src/progress.ts:317-347`
- Dependency-free by design (no framework, no DOM) — the module's stated pattern for testability.  
  `src/progress.ts:12-19`

**Porting:** Port progress.ts as one small pure Swift file operating on the summary-row struct — Solo's summary chips (NEW BEST, MODE MASTERED) and the history screen (sparkline, AVG, BEST, per-mode chips) all come out of progressReport + modeStats + masteryJustEarned, so none of it can defer. The "no newer row of ANY kind" checks scan the UNFILTERED row set (including synthetic) — keep that distinction even on a phone with no synthetic rows today.

**Risks:** Ordering fidelity: personalBest ties keep the earliest walk and modeStats keeps first-walked bucket order — a naive Swift sort/Dictionary port breaks both (Dictionary is unordered; use an ordered accumulation). Also note the deliberate asymmetry: mastered pass counts use the recency window, but ModeStats.passed is all-time.

### Summary card composition (what the Solo summary screen must show)

- ShowSummary (the summary screen's input): scores (MetricSnapshot), overall (0-100 weighted), deltaVsLast (null first time), durationSec, stats (WalkStats|null), oneWayRoute (route snapshot at walk START), plus the LOCKED run mode stamp: modeId, passThreshold.  
  `src/show.ts:78-102 and 517-528`
- Overall = clamp(0, 100, round(sum of score x locked-mode weight over the 7 keys)); the weights come from the mode locked at run start, not the live picker.  
  `src/show.ts:487-495`
- deltaVsLast = overall - lastOverall (null when no baseline); the baseline is RESEEDED at every walk start from the recorder's lastRealOverall(traineeId) so clear-history/trainee-switch take effect next walk; a synthetic run never updates the in-session fallback baseline.  
  `src/show.ts:425-437, 444-445, 497-506`
- lastRealOverall scans newest-first for a non-synthetic, trainee-matching row with a finite overall — a Preview row or score-less row never becomes a baseline.  
  `src/session-recorder.ts:184-201`
- Delta line copy: null → "FIRST WALK — BASELINE SET"; else rounded "+d VS LAST WALK" (negative styled).  
  `src/landing.ts:820-829`
- Duration line = walkStatLine(durationSec, stats, " · "): "58S ON THE RUNWAY · 58 STEPS · 96/MIN"; steps/cadence omitted when stats null or steps <= 0; the separator is a parameter because the XR panel needs ASCII " - ".  
  `src/coach.ts:279-296 and src/landing.ts:830-835`
- BEST chip: rendered from progressReport over trainee-scoped rows AFTER the recorder finalized this walk; shown only when best exists AND walks >= 2; text "NEW BEST" when report.newBest else "BEST {n}"; hidden on a first walk because the delta line already says BASELINE SET.  
  `src/landing.ts:836-873`
- The card grades with the LOCKED mode: resolve s.modeId against the MODES table, falling back to the live signal then DEFAULT_MODE only when the stamp is absent.  
  `src/landing.ts:874-881`
- MODE MASTERED chip: masteryJustEarned(traineeRows, s.modeId) — shown only on the walk that EARNED it, with tooltip "three of your last five walks in this mode cleared its {bar} bar".  
  `src/landing.ts:882-895`
- Per-metric rows: value = round(score), pass coloring = value >= mode.passThreshold (the same bar for all 7 metrics).  
  `src/landing.ts:896-910`
- Verdict + notes come from the shared buildCoachReport({scores, overall, mode, stats, oneWayRoute: s.oneWayRoute}) — oneWayRoute is the summary's route SNAPSHOT, never the live shape signal.  
  `src/landing.ts:912-937`
- CoachReport: overall rounded, verdict "PASS"/"NEEDS WORK" from rounded-overall >= mode bar; notes = below-line metrics (rounded score < bar) ranked by weight x shortfall (impact = weight x max(0, thr - v)), stable ties keep M1..M7 order, capped at 3; empty notes → CLEAN_WALK_CUE.  
  `src/coach.ts:116-129 and 227-256, CLEAN_WALK_CUE at 96-98`
- Per-metric tooltip = plain-English explainer + "Weighted {n}% in {mode.label}" so the user sees why metrics roll up to this overall.  
  `src/landing.ts:938-947`
- History screen (parity targets): trends strip hidden under 2 real walks; title "TRENDS — LAST {n} WALKS"; AVG chip from rollingAvg; BEST chip with set-date tooltip; sparkline of the series with the latest bar highlighted; per-metric trend line using two-letter codes (PO/PA/RH/FW/PR/CO/PE), null trends stay silent rather than showing a fake 0.  
  `src/landing.ts:1512-1601`
- Per-mode records strip: one chip per mode in MODES-table order then the legacy bucket (labeled "EARLIER WALKS"), showing BEST {n} plus a MASTERED badge; tooltip states walks/passed/last and the mastery rule.  
  `src/landing.ts:1604-1663`
- History card: local date/time, PREVIEW badge on synthetic rows, "{lesson} · {dur}s · {source}" subline, overall colored by rowPassed against rowPassThreshold, 7 mini bars marked low when below that row's own bar.  
  `src/landing.ts:1676-1739`

**Porting:** The Solo summary screen is a direct SwiftUI translation of this composition — the load-bearing part is ORDER OF OPERATIONS: finalize the record into history FIRST, then compute chips from the post-walk history (the web relies on the recorder subscribing to the summary signal before the card renders; landing.ts:836-841). All chip logic is already pure (progress.ts/coach.ts), so the screen is just layout. The score-ring count-up animation (landing.ts:804-819) is cosmetic and optional. For the phone, walkStatLine's separator parameter means either " · " or " - " is fine — no font constraint applies.

**Risks:** Two graded-against-different-bars subtleties to not conflate: (1) the summary card colors ALL 7 metric rows against the single mode passThreshold — there are no per-metric bars; (2) history rows grade against their OWN stored threshold, not the current mode's. Also the BEST chip and MODE MASTERED must be computed from trainee-scoped rows INCLUDING the just-finished walk, or NEW BEST/mastery moments will be off by one walk.

### M5-M7 composite honesty constraints (the phone must present composites the same way)

- Pinned honesty rule: presence/confidence/presentation are COMPOSITE reads — pure re-weightings of the four measured channels; nothing observes eyeline, hesitation, or the turn, so their explainers say "composite" outright and their cues point at the measured channels.  
  `src/coach.ts:14-20`
- The actual derivations (identical in all three source paths in metrics.ts): presence = posture*0.4 + rhythm*0.3 + pace*0.3; confidence = pace*0.25 + posture*0.25 + rhythm*0.25 + footPlacement*0.15 + sessionRamp*10 where sessionRamp = min(walkTime/45, 1) (the settle-in credit tops out 45 s in); presentation = posture*0.25 + rhythm*0.25 + footPlacement*0.2 + pace*0.15 + presence*0.15.  
  `src/metrics.ts:535-548 (also 707-720 and 858-865)`
- METRIC_EXPLAIN for M5-M7 states the true derivation and adds "It is not separately measured" (presence: "eyeline is not tracked"; presentation: "the turn is not analyzed"; confidence names the 45-second settle-in credit).  
  `src/coach.ts:59-74`
- M5-M7 corrective cues never coach unobserved qualities — they redirect to the measured channels (e.g. "Presence is scored from your posture, rhythm and pace - lift the frame and steady the tempo and it follows.").  
  `src/coach.ts:76-94`
- In cue selection, composites ALWAYS take the generic band cue — directional builders exist only for pace/posture/footPlacement/rhythm.  
  `src/coach.ts:204-221`
- Directional-cue honesty guards a port must keep: paceCue requires non-null delta AND falls back when mean/ideal render identically at 2 decimals (no "0.85 vs 0.85 - slow down"); postureCue requires >= 1 cm drift; footworkCue names left/right ONLY when oneWayRoute AND |meanLateralM|/meanAbsLateralM >= LATERAL_SIDE_CONSISTENCY (0.6), otherwise magnitude-only "tighten your line"; rhythmCue requires steps > 0 and non-null cadence.  
  `src/coach.ts:100-105 and 150-202`
- The history screen repeats the honesty marker: a "COMPOSITE" caption spans the PR/CO/PE mini-bar columns with a tooltip "composite reads derived from the four measured channels — not separately measured".  
  `src/landing.ts:1740-1748`
- coach.ts is dependency-free with type-only imports (loads in vitest) and every string is ASCII-only — a self-contained port target.  
  `src/coach.ts:32-36`

**Porting:** Port coach.ts nearly verbatim (strings included) — the explainer/cue copy IS the honesty contract, and the design doc can cite it as already-adjudicated. On the phone, oneWayRoute is whatever the Solo walk protocol defines (a single-direction walk qualifies; an out-and-back drill must pass false or the left/right claim lies on the return leg — same physics as the web rule). The 45 s confidence settle-in credit means short Solo drills (< 45 s) never earn the full +10 — keep that, and keep the explainer sentence that discloses it.

**Risks:** The lateral channel's MEANING changes on the phone: per the established registration honesty rule, unregistered ARKit gives lateral-from-travel-direction, not runway-centerline offset. The footwork cue copy says "of the centerline" — Solo copy must say what was actually measured (drift from your line of travel) or re-derive an honest equivalent. Do not soften the composite disclosures: two independent reviews pinned them, and any Solo marketing/summary copy implying measured "confidence" would regress an adjudicated finding.

### Modes table (constants the port needs verbatim)

- ModeId = "beginner" | "highfashion" | "commercial" | "challenge"; TrainingMode carries number/label/tagline/greeting/instruction, walkSeconds, idealPace (m/s), passThreshold, weights (MUST sum to 1), intensity.  
  `src/modes.ts:15-37`
- beginner ("01 BEGINNER WALK"): 60 s, idealPace 0.85, bar 78; weights posture .2, pace .15, rhythm .15, footPlacement .2, presence .1, confidence .1, presentation .1.  
  `src/modes.ts:40-61`
- highfashion ("02 HIGH-FASHION RUNWAY"): 75 s, idealPace 0.72, bar 80; weights posture .2, presence .2, presentation .2, rhythm .15, pace .1, footPlacement .1, confidence .05.  
  `src/modes.ts:62-83`
- commercial ("03 COMMERCIAL MODELING"): 45 s, idealPace 0.95, bar 75; weights confidence .2, presentation .2, pace .15, posture .15, presence .1, footPlacement .1, rhythm .1.  
  `src/modes.ts:84-105`
- challenge ("04 PERFORMANCE CHALLENGE"): 40 s, idealPace 1.05, bar 82; weights pace .2, rhythm .2, footPlacement .2, posture .15, presentation .1, confidence .1, presence .05.  
  `src/modes.ts:106-127`
- DEFAULT_MODE = beginner (MODES[0]); getMode falls back to it for unknown ids.  
  `src/modes.ts:130-133`
- Recorded lesson label format is "{mode.number} {mode.label}" (e.g. "02 HIGH-FASHION RUNWAY").  
  `src/session-recorder.ts:501-508`
- Pre-walk chips the phone can reuse: passBarLabel "PASS AT {n}" and targetPaceLabel "TARGET {x.xx} M/S" (the latter deliberately replaced a retired fabricated steps label).  
  `src/coach.ts:267-276`

**Porting:** The four mode structs port as a static Swift table — ids, walkSeconds, idealPace, passThreshold, and weights must match EXACTLY or phone-recorded rows will grade differently from web rows when histories are ever merged/exported. idealPace is honest phone-side (speed magnitude is frame-invariant). walkSeconds drives the countdown and the cadence denominator.

**Risks:** Mode ids are the join key across records, progress buckets, and mastery — a Swift enum must serialize to the exact lowercase strings. If Solo adds phone-only modes, they need new ids (never reuse) and their rows will bucket cleanly on web via the existing unknown-mode tolerance.

### Minimal port vs defer list (synthesis for the design author)

- The three rule modules the phone needs are already dependency-free pure logic designed for out-of-framework reuse: session-grading.ts, progress.ts, coach.ts — plus the pure export builders (walkExport/historyExport/sessionToCsv/historyToCsv are DOM-free and unit-tested).  
  `src/session-grading.ts:9-12, src/progress.ts:12-19, src/coach.ts:32-36, src/session-recorder.ts:514-516 and 632-634`
- The web itself only persists compact summary rows; full 6 Hz sample series are page-session-only — so a Solo v1 that persists only summary rows is already at parity, not below it.  
  `src/session-recorder.ts:9-13 and 152-156`
- WalkStats is tiny and persisted WITH each summary row — Solo must compute and store it per walk because the directional coach cues, the steps/cadence summary line, and the export units all hang off it.  
  `src/session-recorder.ts:127-129`
- deltaVsLast is persisted on the row exactly as the summary card showed it, so history/exports replay the card verbatim — Solo must stamp it at finalize time, not recompute later.  
  `src/session-recorder.ts:122-125 and 288-302`

**Porting:** MUST-PORT for Solo v1 (summary + history parity): summary-row Codable schema (with optionals), WalkStats, the modes table, session-grading rules, progress.ts wholesale (chips depend on it), buildCoachReport + cue builders + M5-M7 copy, the finalize pipeline (lock mode at walk start, stamp deltaVsLast/stats/threshold at finish, append row, cap 200), and lastRealOverall baseline reseed. CAN DEFER: CSV export (share-sheet JSON with the v2-style envelope first; CSV later must honor the pinned metadata contract + escaping), persisting full sample arrays (keep in-memory per app-session like the web; per-walk JSON export available only for walks this session, gated like hasFullRecord), the pass/low history filter UI, PREVIEW badging (no auto-pilot on phone yet — keep the schema flag), and multi-trainee UI (keep rowMatchesTrainee logic, default nil id).

**Risks:** Biggest fact-check hazards for the design doc: (1) layout is a required SessionRecord field the phone can't honestly fill — needs an explicit schema decision; (2) lateral semantics differ without registration — units text and footwork copy must be re-worded, likely under a new/derived schema id; (3) parity claims must cite the rounding chain (round scores → compare to bar; round overall → verdict; clamp 0-100) or phone and web will disagree on edge scores like 77.5 in beginner.


---

*AMENDMENT (2026-07-09, the perfect=100 rescale): every score anchor in this spec moved 95/96 -> 100 (SCORE_MAX 98 -> 100, web posture x58 -> x60, carriage/beat 40+58 -> 40+60, the confidence ramp spans the LOCKED walk duration instead of a hard 45 s). Slopes, SCORE_MIN=40, sentinels and pass bars unchanged. Formulas above are shown post-rescale where inline-edited; derivations referencing the old bar-crossing arithmetic are historical.*
