# EDGE ROADMAP — taking (X)RUNWAY from polished to pinnacle

*Produced 2026-07-03 by a 6-agent design panel (four vision lenses — coaching
science, AR-native interaction, environment/presence, curriculum — each
grounded in this repo's sensors, modules and laws, then two adversarial
passes over the combined list for honesty, sensor reality, perf and
training-transfer). Every idea below carries its sensor, derivation,
per-body normalization and cost as proposed; the verdicts record what the
adversaries kept, killed, or reshaped. The synthesis and wave plan were
adjudicated from those verdicts.*

## The diagnosis

The measurement set has been frozen since v1: four measured channels
(posture, pace, rhythm, footwork), everything since polishing their
delivery. Meanwhile the product never reads head ORIENTATION, never uses
the tracked hands/controllers, never crosses its own beat clock with its
own footstrikes, and scores only one of the walk's three phases (the walk —
never the turn, never the hold). The edge is not more spectacle: it is that
nobody else can honestly measure a runway walk, and neither do we — yet.

## The edge thesis — three moves that compound

1. **Measure the whole walk (Metrics v2)** — new honest channels on
   hardware already tracked: head carriage (chin/eyeline), the turn, the
   hold, beat lock, repeatability; camera-side lines when the iPhone is
   rigged. Every channel: derived thresholds, per-body normalization via
   the FIT session, golden-locked, Solo-portable where head/camera-honest.
2. **Coach forward, not backward (the AR-native layer)** — feed-forward
   guidance only AR can do: the pace ghost you walk WITH, the horizon
   beacon at eye height, the haptic beat in the hand, and the trace-walk
   spatial replay you physically walk back along.
3. **Train, don't just grade (the curriculum spine)** — FIT calibration,
   one-channel drills with per-rep spoken verdicts, a mastery-gated skill
   ladder, a weakest-channel session planner, a fixed benchmark walk, and
   the pressure ladder that makes the environment a recorded training
   variable.

## The wave plan (adjudicated build order)

- **WAVE 1 — the instrument upgrade** (head-sensor only, S/M costs, no GPU
  risk): FIT SESSION, M8 HEAD CARRIAGE, M10 THE HOLD (with the merged
  find-your-light/time-in-light stagecraft as its presentation), M12
  REPEATABILITY + BENCHMARK RE-TEST.
- **WAVE 2 — tempo + the turn**: M9 BEAT LOCK (with Beat-in-the-Hand as its
  eyes-free delivery and BEAT DRILL as its drill wrapper), M11 THE TURN
  (absorbing TURN DRILL's line-re-acquisition measure + drill wrapper).
- **WAVE 3 — the AR coaching layer**: ~~PACE GHOST~~ **(VETOED — founder
  ruling 2026-07-23: "no pace ghost in front, that is distracting." The
  ghost lives in REPLAY only — the post-walk Replay Theater + its player
  menu — never ahead of a live walk)**, HORIZON BEACON, DRIFT RAIL
  (fixed: peripheral edge strips, never floor-ahead — a floor rail
  trains the glance-down fault M8 penalizes), TRACE-WALK replay.
- **WAVE 4 — the curriculum spine**: DRILL KERNEL + starters, SKILL LADDER,
  SESSION PLANNER.
- **WAVE 5 — the room**: PRESSURE LADDER (with flash choreography as its
  stressor knob — NOT a performance reward — plus audience gaze dynamics
  and reactive crowd audio as its level ingredients), VENUE PRESETS, the
  merged BACKSTAGE ritual (mark + PA call + lowpass snap + cue-latency
  stat).
- **CAMERA-DEPENDENT (when the iPhone is rigged)**: M13 LINES, M14 LINE
  WALK — re-derived in the TRAVEL frame (the camera is unregistered to the
  runway; same §3 honesty ruling Solo adjudicated).
- **KILLED**: M15 clutch walk (a Touch controller is not a clutch; trains
  the wrong thing), passthrough light spill (polish-shaped, not edge).

---

# The full panel output (ideas + adversary verdicts)


## Lens 1 — coaching science (what real coaches train, honestly measurable)

### M8 HEAD CARRIAGE — chin & eyeline discipline (the unused orientation channel)  `[cost S / lens-rank 1]`

**What:** The single biggest untapped signal in the product: player.head world ORIENTATION is never read (metrics.ts only calls getWorldPosition). Coaches' #1 beginner correction is 'chin level, eyes on the back wall, never look at your feet.' Derive head pitch vs horizontal and head yaw vs the active route segment's walk heading (runway-shape.ts already exposes per-segment yaw, and the projector already tracks the active segment). Score = time-in-band (|pitch − neutral| < ~7°, |yaw − routeHeading| < ~12°) with an explicit glance-down event counter (pitch dipping below ~−15° = looked at feet), fed through the same EMA + WalkStatsAccumulator pattern so the coach can say 'you checked your feet 4 times, around the 6 s mark.'

**Why it trains:** It is the top correction real coaches give, it is currently invisible to the product, and it composes into the turn and pose-hold modules below. It also finally gives M5 'presence' a real measured ingredient instead of being a pure re-weighting — eyeline discipline is the closest honest proxy for stage presence available from any sensor in the rig.

**Needs:** EXISTS: head quaternion (WebXR 6DoF), RunwayPathProjector + segment heading, WalkStats/coach copy machinery, zero-alloc pattern. NEW: ~1 derivation block in metrics.ts + pose-derive-style pure module for tests, neutral-pitch calibration sampled during the pre-walk countdown stand (people's neutral head pitch differs — same trick as the 0.5 s posture baseline). No environment cost, no GPU cost.

**Honesty:** Sensor: head 6DoF orientation. This measures HEAD CARRIAGE, not gaze — no eye tracking exists. Label it 'head carriage / chin line', never 'eye contact'. Per-body normalization: angles are body-invariant; the only calibration is the per-run neutral-pitch baseline. On out-and-back routes the yaw target flips with the leg — the projector's route phase already disambiguates. Coach copy must follow the coach.ts law: cite degrees and glance-down counts actually measured.

**Adversary A — KEEP:** Verified: metrics.ts reads only getWorldPosition, so the head quaternion really is an unused free channel; per-segment yaw exists in runway-shape.ts, the 'carriage not gaze' labeling is exactly right (no eye tracking exists), and it's the cheapest real new channel on the whole list.

**Adversary B — KEEP:** Verified: metrics.ts never reads head orientation, so this is a free, honest, S-cost channel measuring the #1 real coaching correction — the strongest idea on the list, provided it ships labeled 'head carriage' never 'eye contact'.


### M9 BEAT LOCK — walking ON the music  `[cost M / lens-rank 2]`

**What:** Coaches count models down the runway; the product already has a 122 BPM synthesized track with ONE authoritative beat clock (music.ts #44, globals.goAudioTime publishes the GO downbeat on the AudioContext clock) and already detects every footstrike (bob up-crossings feed WalkStats.addStep). Cross them: for each strike, compute phase error against the beat grid, scored via circular statistics (vector strength = how concentrated strikes are around a beat phase; mean phase = rushing vs dragging). Score against the nearest honest subdivision — a strike on every beat (122 spm) OR every other beat (61 spm) both count as locked, so tall slow-cadence walkers aren't punished for physics.

**Why it trains:** Rhythm-to-external-beat is a genuinely different skill from self-consistent rhythm (M3 measures only internal regularity). Walking to a count is a literal staple of runway classes, and entrainment to a beat is one of the best-documented motor-learning accelerators in gait science. It also converts the music from ambiance into a training instrument, which is exactly the 'standard-setter' posture.

**Needs:** EXISTS: footstrike stream (all three derivation paths), the beat clock, WalkStats, coach copy. NEW: a clock bridge — strikes are stamped on the ECS walk clock, beats live on the AudioContext clock; goAudioTime anchors the two, but the skew/drift mapping needs care and tests (the restamping logic in pose-ingest.ts is the precedent). Plus a small 'ON THE BEAT' drill mode where the mode's idealPace is derived from beat × target stride, not set independently.

**Honesty:** Sensor: existing bob-derived footstrikes + the app's own beat clock. Derivation: circular mean/variance of strike phase in beat units — fully honest, both inputs are self-generated. Caveat to disclose: strike TIMING from head bob lags true heel-strike by a roughly constant offset, so score CONSISTENCY of phase (vector strength) as the primary number and treat mean phase as directional-only ('you drift ahead of the beat'), never as absolute ms accuracy. Per-body: phase is unitless; the subdivision rule is the normalization.

**Adversary A — KEEP:** Both inputs are self-generated and verified (goAudioTime beat clock in music.ts:440, bob-strike stream via addStep), and scoring vector-strength as primary with mean phase directional-only honestly absorbs the bob-lag caveat — but this must be THE single beat implementation that Beat-in-the-Hand and BEAT DRILL wrap, not one of three.

**Adversary B — KEEP:** goAudioTime (music.ts:440) and the strike stream both exist, entrainment-to-beat is a genuinely different skill than M3's self-consistency, and the phase-consistency-primary framing correctly dodges the bob-lag honesty trap — this is the CANONICAL beat channel; BEAT DRILL and Beat-in-the-Hand must consume it, not rebuild it.


### M10 THE HOLD — pose-mark stillness score  `[cost S / lens-rank 3]`

**What:** The show already has a pose mark, a FINISH_RADIUS, and a POSE_HOLD_SEC dwell (show.ts) — but nothing is measured during it. Coaches drill 'hit your mark, set, FREEZE, count, then break.' During the hold window, accumulate head position RMS drift (mm), head orientation RMS (deg), and whether the trainee actually stopped ON the mark (along-coordinate error vs poseRouteAlong). Feed the existing camera-flash system so flashes visibly intensify while stillness is high — the environment already rewards the behavior being trained, at zero new GPU budget.

**Why it trains:** The pose is half the job on a real runway (it's where the photographers shoot), it is a discrete, learnable, tightly measurable skill, and it turns dead time the show already contains into scored training. Stillness under spotlights is also trainable fast — visible session-over-session improvement, which drives retention.

**Needs:** EXISTS: pose-mark detection + hold phase, poseRouteAlong cache, head 6DoF, flash system, mastery records. NEW: a hold-window accumulator (scalar, zero-alloc), extending POSE_HOLD_SEC to a scoreable ~3 s on non-U routes too (out-and-back currently 'gets this beat naturally during the turn' — make it explicit), summary line + coach copy.

**Honesty:** Sensor: head 6DoF only (or shoulders/hips too when the camera is live — then the shoulder-line stillness is scoreable and should be labeled separately). Derivation: RMS drift over the window, mark-hit error in cm. Per-body: normalize positional sway by standing head height (sway amplitude scales with height — a 1.9 m trainee sways more at equal skill); orientation and mark error need no normalization. Never call it 'poise' — call it stillness and mark accuracy, which is what was measured.

**Adversary A — KEEP:** POSE_HOLD_SEC/FINISH_RADIUS/poseRouteAlong all verified in show.ts, head-6DoF stillness in cm with height-normalized sway is honest ('stillness', never 'poise'), and it converts existing dead time into scored training — canonical hold measurement into which the env and AR hold siblings must merge.

**Adversary B — KEEP:** FINISH_RADIUS/POSE_HOLD_SEC/poseRouteAlong all exist in show.ts and nothing measures the window today — keep as the ONE canonical hold measurement into which 'The Hold' (ar) and 'Find your light' (env) merge their stagecraft, because shipping three stillness derivations of the same 1.6s window would be absurd.


### M11 THE TURN — pivot mechanics at the end of the runway  `[cost M / lens-rank 4]`

**What:** On out-and-back routes the trainee already performs a turn at the pose mark every single walk, and the product is blind to it. Gate a turn analyzer on proximity to poseRouteAlong: measure (a) yaw sweep smoothness — one clean monotonic ~180° rotation vs stuttered multi-impulse turning (count yaw-velocity sign reversals), (b) turn duration vs a band, (c) head-height dip through the turn (collapsing into the turn is THE classic fault — measured vs the walk baseline already maintained), and (d) head carriage through the turn (M8's pitch channel, held level while rotating). When the side camera is live and world-space, add hip-azimuth lead (hips initiate, shoulders follow) — the actual pivot mechanic coaches teach.

**Why it trains:** Turns are the most-coached, least-self-teachable runway skill — nobody can watch their own turn, which is precisely what a simulator with 6DoF tracking CAN watch. This is the feature a real catwalk coach would point at and say 'okay, this is serious.' It also naturally becomes its own drill mode (short deck, turn every 8 s, ten reps), multiplying reps on the weakest skill.

**Needs:** EXISTS: 6DoF head pose+orientation, along-coordinate gating, walk-phase machine (0.5 route-phase = the turn), baselineY, camera hip/shoulder keypoints for the lead channel, coach voice for the mid-walk cue ('smoother — one motion'). NEW: turn segmentation state machine (entry/exit detection with hysteresis), the drill mode entry in modes.ts, golden vectors for the segmentation (it must also survive the Solo-Mode Swift port, so build it pure in the pose-derive.ts style).

**Honesty:** Sensor: head yaw/pitch/height for (a)-(d) — disclose that this is HEAD path through the turn, not foot pivot; feet are unobserved head-only (the classic 'step-pivot vs spin' distinction needs the camera's ankles, so gate that sub-score on camera-world freshness like everything else). Per-body: height dip as a fraction of baseline head height; sweep angle and reversal counts are invariant. Duration band per mode, not universal.

**Adversary A — KEEP:** coach.ts:73 literally ships 'the turn is not analyzed', so this fills the product's own confessed gap with honestly-labeled head-only proxies and a camera-gated pivot sub-score — merge curriculum's TURN DRILL into this one implementation rather than shipping two competing turn channels.

**Adversary B — KEEP:** Head-only turn analysis is honest (labeled head-path), the turn happens every out-and-back walk unobserved, and coach.ts literally confesses the gap — keep as the canonical turn analyzer, absorbing TURN DRILL's re-acquisition-time sub-measure and drill wrapper.


### M12 REPEATABILITY — lap-to-lap and session-over-session consistency  `[cost S / lens-rank 5]`

**What:** Coaches don't want one good walk, they want the SAME walk ten times. The session recorder already persists per-walk WalkStats and 6 Hz raw channels, and mastery records exist per mode. Add a consistency score computed across the last N walks of a session: CV of cadence, CV of mean pace, dispersion of the lateral profile (correlate this walk's lateral-vs-along trace against the session's running mean trace), and hold-stillness variance once M10 lands. Surface it as a session-level verdict ('walks 1-4 agreed within 4%; walk 5 drifted 12% slow — fatigue?') rather than a live bar.

**Why it trains:** Repeatability is the honest, measurable definition of mastery — it converts data the product already stores into the single construct that distinguishes a trained walker from a lucky walk. It also creates the session arc ('do it again, identically') that drives deliberate practice, and it costs almost nothing because every input channel already exists and is already persisted.

**Needs:** EXISTS: session-recorder.ts raw channels, walk-stats per walk, progress.ts/mastery records, coach summary surfaces. NEW: a pure cross-walk aggregator (vitest-friendly, no engine deps) + summary/coach copy. No sensors, no per-frame cost at all — it runs at walk end.

**Honesty:** Derivation: statistics over already-measured, already-disclosed channels — nothing new is claimed. Per-body: CVs are self-normalizing (each trainee is compared to THEMSELVES, which sidesteps every cross-body calibration problem — this is the metric that can never lie across bodies). One rule: require ≥3 walks under the SAME mode and runway shape before showing it; comparing a U walk to a straight walk would be dishonest aggregation.

**Adversary A — KEEP:** Self-vs-self CVs over already-persisted 6 Hz data are the one metric class that can never lie across bodies, the same-mode/same-shape ≥3-walk guard blocks dishonest aggregation, and it runs at walk end with zero sensor or GPU risk.

**Adversary B — KEEP:** Self-normalizing CVs over already-persisted channels can never lie across bodies, run at walk-end with zero frame cost, and the same-mode/same-shape gating rule is exactly right — cheapest honest mastery construct available.


### M13 LINES — shoulder level, hip level, and counter-rotation (camera-world channel)  `[cost M / lens-rank 6]`

**What:** The live iPhone ARKit stream carries world-space shoulders and hips — enough for the three 'line' qualities coaches shout about: shoulder-line tilt (Δheight between L/R shoulders, in degrees), hip-line tilt, and the shoulder-vs-hip azimuth separation over the step cycle (counter-rotation — the controlled oscillation that reads as 'sway'; too little = stiff, too much = theatrical). All three are angle-based and derivable per frame with confidence gating on the far-side joints.

**Why it trains:** Level shoulders and hip-shoulder separation are core catwalk aesthetics that head-only sensing can never touch — this is exactly what the pose relay was built to unlock, and it's currently only sharpening scores the head could already approximate. It turns the camera from 'better versions of M1-M4' into channels that don't exist without it, which is the honest pitch for setting up the tripod at all.

**Needs:** EXISTS: pose relay LIVE with world-space frames, deriveWorld in pose-derive.ts (pure, golden-vectored — the natural home), kpOk confidence gating, WalkStats, coach copy. NEW: three derivations + score bands, golden vectors, AND the Swift XRunwayCore mirror (Solo-Mode freshness enforcement means every new world-path metric must land in both — budget for it). Counter-rotation needs the step cycle, which the shared strike ring already provides.

**Honesty:** Sensor: camera-world keypoints ONLY — these metrics must go dark (not freeze, not fall back to head fakes) when the stream is stale, with the summary saying 'camera channels: N/A'. Derivation: tilt = atan2(Δy, horizontal separation) — degrees, body-invariant, no leg/height normalization needed. Counter-rotation amplitude in degrees, but score the BAND (target ~5-15°), and disclose that single-camera azimuth of a partially occluded far shoulder is the noisiest number in the product — apply a confidence-weighted EMA and refuse to emit copy below a sample-quality floor.

**Adversary A — KEEP:** Within-skeleton angles are rigid-transform invariant (CALIBRATION.md §2 makes this the sanctioned pattern), so no runway registration is needed; dark-when-stale plus the far-shoulder quality floor are stated correctly, and the Swift-mirror cost is honestly budgeted — this is the honest pitch for the tripod.

**Adversary B — KEEP:** Survives the registration problem that kills runway-frame camera ideas because tilt and counter-rotation are gravity-aligned and body-relative quantities (ARKit world is gravity-aligned, no runway registration needed), and it's the first camera channel head sensing cannot approximate — but budget the Swift golden-vector mirror honestly, it's the real cost.


### M14 THE LINE WALK — single-track ankle placement + normalized stride length  `[cost L / lens-rank 7]`

**What:** The defining runway mechanic: each foot lands on (or slightly across) the centerline, one in front of the other, with a long confident stride. From camera-world ankles: detect strike instants (the ankle-bob machinery exists in pose-derive), capture the STRIKE POSITION, project it into the runway frame (projector exists), and score (a) crossover index — the leading ankle's signed lateral vs the pelvis midline, normalized by hip width, target ≈ 0 with penalties both for straddling and over-crossing, and (b) stride length = along-distance between consecutive strikes, normalized by leg length measured from the skeleton itself (hip-to-ankle distance), scored against the mode's target in leg-lengths.

**Why it trains:** M4 today scores the HEAD staying near the centerline — a trainee can pass it while walking a wide two-track. Ankle-level placement is the actual skill, and stride-in-leg-lengths is the first metric here that transfers as a real coaching number ('your stride is 0.78 leg-lengths; high fashion wants ~0.9'). This is the deepest gait-science idea on the list and the strongest 'standard-setter' claim — but it is honestly the most fragile, which is why it ranks below cheaper wins despite the highest ceiling.

**Needs:** EXISTS: world ankles + knees + hips in the PoseFrame, strike detection scaffolding, RunwayPathProjector, per-mode targets. NEW: strike-position capture with occlusion handling (the far ankle vanishes regularly in side view — accept single-leg strike chains and say so), camera-to-runway registration quality gating (SENSORS.md: absolute accuracy depends on the camera's pose vs the mapped runway — world frames give it, but validate on-device before trusting centimeters), leg-length estimator with outlier rejection, golden vectors + Swift mirror. Realistically needs a device-validation pass before the score ships.

**Honesty:** Sensor: camera-world ankles/hips only; dark when stale. Per-body normalization is NON-OPTIONAL here: raw stride length lies across bodies — divide by measured leg length; crossover divides by hip width (both from the same skeleton, so errors partially cancel, which is the right kind of luck). Disclose single-camera occlusion: on walks where <60% of strikes had a confident ankle, suppress the score entirely rather than emit a half-measured number. Never claim heel-vs-toe strike — 9 keypoints end at the ankle.

**Adversary A — FIX:** The runway-frame projection is a sensor-reality violation — camera-to-runway registration does not exist (CALIBRATION.md §1: two independent world frames with nothing tying them; metrics.ts:393: 'camera-relative and uncalibrated') — so measure crossover against the pelvis midline and stride against the self-derived travel line (both frame-invariant, already the deriveWorld pattern) and defer anything centerline-absolute to the calibration founder-call.

**Adversary B — FIX:** The stated form is impossible — pose-derive.ts:356 says in the code that the iPhone's ARKit frame is UNREGISTERED to the mapped runway, so 'project the strike into the runway frame (projector exists)' is false; the fix is to re-derive everything in the travel-line frame deriveWorld already maintains (crossover vs pelvis midline against poseHeading, stride = inter-strike distance in leg-lengths — all registration-free) and never claim placement relative to the mapped centerline.


### M15 THE CLUTCH WALK — hand-path steadiness via tracked controllers (weakest — ship last or kill)  `[cost M / lens-rank 8]`

**What:** Controllers are tracked and unused. The honest objection kills the obvious version: holding controllers CHANGES arm swing, so 'natural arm swing' measured through them is training the wrong thing, and hand tracking loses hands at the thighs/behind the hips — exactly where runway arms live. The salvage is to make the prop the point: a commercial-mode 'clutch walk' drill (one controller held like a clutch/product), scoring hand-path steadiness (vertical bounce of the held hand relative to the torso line) and the free arm's swing symmetry when hand tracking has it. That IS a real commercial-modeling skill (walking with a bag/product without it bouncing).

**Why it trains:** It's the only idea that gives the second tracked input a job, and prop-carriage is genuinely coached in commercial modeling. But it serves one mode, the free-hand channel is tracking-coverage-dependent, and every rank above it trains a more central skill for less caveat. I'd cut this first; it exists in the list so the controller channel's honest ceiling is on the record.

**Needs:** EXISTS: gripSpaces 6DoF, torso proxy from head (or camera hips when live), WalkStats, commercial mode. NEW: hand-path derivation + tracking-loss gating (freeze-and-dark on lost tracking, never interpolate), drill copy. No environment cost.

**Honesty:** Sensor: controller 6DoF (IMU-fused — brief camera-FOV exits are okay, sustained ones drift; gate on tracking state). Label it HAND PATH / prop carriage, never 'arm swing' — the elbow and shoulder are unobserved from a wrist-point. Per-body: normalize bounce amplitude by standing head height. Do not score the hand-tracking variant's behind-the-body phase at all — the sensor cannot see it, so the metric must not pretend to.

**Adversary A — KILL:** The author's own defense is 'so the ceiling is on the record' — one mode, a Touch controller that is not shaped or weighted like a clutch, and tracking-coverage caveats on the free hand; every hour here is stolen from the turn and the lines, so take the offered kill.

**Adversary B — KILL:** The author's own confession is correct: one mode, heavy tracking caveats, and a prop drill that trains around the sensor's distortion rather than through it — every rank above it buys more training for less asterisk, so take the offered kill.



## Lens 2 — AR-native interaction (feed-forward coaching only AR can do)

### Pace Ghost — edge-chase pacer you walk WITH  `[cost S / lens-rank 1]`

**What:** Repurpose the existing deck-edge chase strips + floor trainee-glow into a moving pace presence: a light puddle/comet that travels the compiled route at a chosen pace. Two selectable sources, always labeled: TARGET (the active mode's idealPace constant) or GHOST (the along-route progress curve of YOUR best recorded walk in this mode). Mid-walk it lives in the floor ahead/beside you — the one place the walker can actually see — so pacing becomes feed-forward ('stay with the light') instead of a post-hoc M2 score or a spoken 'too slow'.

**Why it trains:** Pace is the most coachable metric mid-stride (coach-live.ts already ranks it first) and entrainment to a moving pacer is how tracks train pace (Wavelight). It converts the product's best-instrumented metric from judgment into guidance, and it makes mastery records (already shipped) trainable: you literally race your own record.

**Needs:** EXISTS: edge chase strips + live-floor glow (shaders.ts uProgress plumbing), RunwayPathProjector for route-parameterized position, per-mode idealPace, mastery records. NEW: one uGhostProgress uniform + a second glow lobe in the floor/edge shaders; record the 6 Hz along-route progress array per walk in session-recorder.ts (samples already exist — add one float per sample) and persist the best-walk curve per mode (~400 floats in localStorage). Zero new geometry; zero per-frame allocation (preallocated Float32Array, index walk).

**Honesty:** A ghost is ONLY your recorded progress curve, labeled 'YOUR BEST — <date>'; the target pacer is labeled as the mode's ideal, never as a measurement. No claim changes: M2 stays exactly what it is. Perf: uniforms only, survives the budget caps trivially.

**Adversary A — KEEP:** Uniforms-only on existing capped geometry, the ghost is honestly labeled as your own recorded progress curve, and it converts the best-instrumented channel from post-hoc verdict into feed-forward entrainment — just make it fadeable across reps so trainees don't become pacer-dependent.

**Adversary B — KEEP:** Converts the best-instrumented metric from post-hoc judgment into feed-forward guidance using only shader uniforms and a per-mode progress curve, with honest labeling (mode ideal vs YOUR BEST) — the Wavelight mechanic is proven pacing pedagogy and it makes mastery records trainable.


### Drift Rail — the centerline that leans back at you  `[cost S / lens-rank 2]`

**What:** The floor shader already draws warp lines on the deck; add a rendered centerline rail 1–3 m AHEAD of the trainee whose lateral offset/tint encodes the live SIGNED centerline deviation (walk-stats lateralM, the #8 signed channel). Walking centered, it is a calm thin line; drift right and the segment ahead warms on your right side and the line visually 'pulls' left. It sits exactly in the natural downward-forward gaze cone of a runway walker.

**Why it trains:** M4 footwork currently gets one spoken 'find your line' cue per fault window; a continuous, silent, peripheral channel lets the trainee micro-correct every stride — feed-forward, not verdict. This is the canonical only-in-AR mechanic: a coaching overlay painted on the physical floor the user mapped.

**Needs:** EXISTS: signed lateralM at 6 Hz (metrics.ts → walk-stats.ts), uProgress trainee tracking, the floor ShaderMaterial + ShaderTimeSystem uniform plumbing. NEW: two uniforms (uLateral, uLateralValid) and ~20 lines of GLSL in the live-floor fragment. Nothing else.

**Honesty:** lateralM is head-path-only and null while the external camera owns scoring — the rail MUST drop to neutral (uLateralValid=0) rather than freeze or fake, mirroring the coach-live null-channel law. It shows head-over-line, not foot-over-line; label it CENTER, not FOOT. Perf: pure fragment math on existing capped grid.

**Adversary A — FIX:** The measurement and null-channel handling are honest, but a correction cue painted on the floor 1–3 m ahead trains exactly the glance-down fault M8 penalizes and every coach corrects — move the drift signal to the peripheral edge strips or eye height for mode walks, and confine the floor rail to LINE drills with fading.

**Adversary B — FIX:** The core (continuous silent lateral feedback from the signed lateralM channel, correctly darked when camera owns scoring) is right, but a rail painted on the floor 1-3m ahead trains a ~25-30° downward gaze — the exact fault M8 and every real coach corrects — so move the lateral encoding into the peripheral deck-edge strips or the Horizon Beacon's tint, never onto a floor line the trainee must look down at.


### Horizon Beacon — an eye-line to hold  `[cost S / lens-rank 3]`

**What:** At walk start, place a single thin light bar at the runway's far end at the trainee's CALIBRATED head height (the same baseline M1 already forms). It is the classic coaching instruction 'eyes on the horizon, chin level' made physical: a fixed gaze anchor to keep level with. When measured head-height drift exceeds the M1 threshold for the coach-live hold window, the bar tints (down-drift = amber below-glow) — the trainee feels themselves sinking relative to a fixed reference.

**Why it trains:** Posture is the LEAST coachable channel by voice (coach-live.ts ranks it last) because 'lift your chin' arrives after the fault. A spatial anchor trains the habit proactively — you can't watch a fixed eye-height bar and slump. It also solves gaze discipline (looking down at the floor rail too long) by giving the eyes a home.

**Needs:** EXISTS: posture baseline + signed head-height drift (walk-stats), compiledPath far-end anchor (show-choreo floor anchors), emissive-bar material patterns in stage.ts. NEW: one small static mesh (2 tris) positioned once per walk + a tint uniform driven by the existing 2 Hz coach-live sample. Trivially inside budget.

**Honesty:** The bar height is your own start-of-walk baseline — disclosed as such ('YOUR LINE'). The tint fires only on the measured M1 drift channel with the same hysteresis as the voice cue; it never claims 'confidence' or 'presence'. On a U-route the anchor re-targets per segment via the existing segment-aware projector.

**Adversary A — KEEP:** It physicalizes the trainee's own measured M1 baseline at eye height (verified: metrics.ts's 0.5 s baseline exists), costs 2 triangles plus a tint uniform, and it complements M8's chin-line channel instead of fighting it the way the floor rail does.

**Adversary B — KEEP:** A fixed gaze anchor at calibrated head height is the feed-forward trainer for exactly what M8 measures (the measure/train pair this product should be built from), it's 2 triangles plus a tint uniform, and it gives the eyes a home that keeps them OFF the floor.


### Beat-in-the-Hand — haptic metronome + measured beat lock  `[cost S / lens-rank 4]`

**What:** The show already has one authoritative 122 BPM clock (GO-on-the-drop). Pulse the controller haptic actuators on that beat grid during countdown and (optionally, per prefs) through the walk — rhythm delivered through the body, eyes-free, unmissable mid-walk. Because footstrike times are already detected, also derive a NEW honest sub-readout: footstrike-to-beat phase offset (ms), shown post-walk.

**Why it trains:** M3 rhythm is currently judged (bob-interval MAD) but never TRAINED — there is no entrainment channel. A haptic beat is the strongest feed-forward rhythm trainer that exists, it works when the HUD is behind you and the music is quiet, and it costs nearly nothing. The beat-phase readout turns 'rhythm 82' into 'you strike 40 ms behind the beat', which is actionable.

**Needs:** EXISTS: unified beat clock (music.ts/show-timing), footstrike stream (metrics ring buffer → walk-stats), XR gamepad access, coach prefs. NEW: a tiny HapticSystem calling gamepad.hapticActuators pulse() on beat ticks (Quest Browser supports this), plus ~30 lines of phase-offset math in walk-stats. Zero draw calls, zero allocation.

**Honesty:** Beat lock is a real derivation (footstrike timestamps vs the known beat grid) — state sensor (head bob upcrossing), derivation (circular mean phase), and the caveat that a footstrike is a bob event, not a heel contact. It does NOT feed M3 unless the founder blesses a metric change. Hand-tracking users have no actuators — fall back to the existing earcon tick, disclosed in settings.

**Adversary A — FIX:** The haptic pulse is the right trainer (Quest Browser exposes gamepad.hapticActuators; the hand-tracking earcon fallback is honestly disclosed), but its phase-offset readout is M9 — ship it as M9's eyes-free delivery channel, not a second parallel implementation of the same math.

**Adversary B — KEEP:** Haptic beat delivery is the only rhythm channel that works when the HUD is behind you and the eyes are on the horizon, Quest Browser exposes hapticActuators, and the hand-tracking earcon fallback is disclosed — but its phase-offset readout must be M9's derivation, not a second implementation of the same clock bridge.


### Trace-Walk — post-walk spatial replay on the runway  `[cost M / lens-rank 5]`

**What:** After the summary phase, paint the walk ONTO the mapped runway: the head path as a capped ribbon of instanced dots colored by the live per-sample scores, footstrike markers at their runway coordinates, and flags where coach-live cues fired. The trainee physically walks BACK along their own trace — 'here is where you drifted, stand here and feel it' — before the panel summary ever matters.

**Why it trains:** This is what a human coach does on a real runway: walks you back to the spot. Corrections anchored to a physical place transfer better than a scoreboard, and it makes the recorded 6 Hz data (POLISH #12's hard-won real measurements) legible in space. It is also the standard-setter demo moment nothing 2D can copy.

**Needs:** EXISTS: full 6 Hz per-walk samples with lateralM + scores (session-recorder), footstrike events (walk-stats), cue log (coach-live), runway frame via projector. NEW: add along-route + headY to each MetricSample (2 floats), and one instanced-points entity capped at ~600 instances (60 s × 6 Hz + strikes) with preallocated buffers, torn down on next walk. One draw call, fixed budget — write the cap into stage-budget.ts so the tests enforce it.

**Honesty:** The ribbon is head path, drawn at deck height for legibility — label it HEAD LINE, and footstrike dots as bob-derived strikes, not measured foot contacts (lateral of a strike is head-lateral at strike time). Post-hoc by design; ranked below the feed-forward ideas for exactly that reason.

**Adversary A — KEEP:** Spatially-anchored review over real recorded 6 Hz data with honest labels (HEAD LINE, bob-derived strikes) and a fixed ~600-instance cap written into stage-budget.ts tests — the GPU-budget law followed to the letter, and the walk-back-to-the-spot mechanic is what human coaches actually do.

**Adversary B — KEEP:** Walking a trainee back to the physical spot where the fault happened is what real coaches do and nothing 2D can copy, the ~600-instance cap written into stage-budget.ts keeps it out of the GPU-crash class, and the HEAD LINE / bob-strike labeling is honest — correctly self-ranked below the feed-forward ideas.


### The Hold — pose mark you can feel completing  `[cost S / lens-rank 6]`

**What:** Make the far-end pose mark a physical target with a completion channel that doesn't require looking down (looking down would tank M1): an approach ring on the floor that tightens as you close on the mark, then during POSE_HOLD_SEC the existing hero spotlight cone visibly NARROWS onto you and a low haptic/earcon tick marks each held second, releasing with the paparazzi burst. Breaking the hold early relaxes the cone — you see it in the light pooled around your own feet.

**Why it trains:** The pose hold is the one beat of the walk with no trainable feedback today — trainees either rush it or overstay, and duration is unfeelable inside a headset. Encoding time-in-light around your body is diegetic, glanceable without head drop, and rehearses the exact skill (hitting a mark, owning a still moment) the turn-back cue currently only announces.

**Needs:** EXISTS: pose-mark anchor + burst (show-choreo/shaders uAnchorPose), hero spotlight (stage.ts — animate its angle/penumbra, already per-frame driven), POSE_HOLD_SEC clock (show.ts), sfx earcons, haptics from idea 4. NEW: a ring decal in the floor shader (one uniform: uHoldT) + spotlight cone tween. No new entities.

**Honesty:** Purely feed-forward stagecraft on a real clock — no metric claims. If a 'hold quality' number is ever wanted, the honest one is measurable today: head-position variance inside the hold window; disclose it as stillness, never 'presence'.

**Adversary A — FIX:** The diegetic completion channel (spotlight narrowing, per-second tick) is good stagecraft on a real clock, but it's the third hold proposal — fold this staging into M10's single hold-window feature so there is one accumulator, one flash/spotlight hook, and one summary row.

**Adversary B — FIX:** The diegetic time-in-light presentation (spotlight narrows, haptic second-ticks, no head-drop required) is the best FORM of the three duplicate hold ideas, but it must ship as M10's presentation layer consuming M10's accumulator — not a third parallel hold feature with its own 'if a number is ever wanted' hedge.


### Backstage Mark — a 4-bar composure ritual that also fixes the baseline  `[cost S / lens-rank 7]`

**What:** Behind the start line, a small floor circle that breathes with the music's bar structure for the 4 bars before GO. The trainee stands on it, matches the swell (in-2-3-4, out-2-3-4), and during that stillness the app captures a DELIBERATE posture baseline instead of the current opportunistic first-0.5 s-of-walking one. GO-on-the-drop then launches from composed stillness — the real backstage ritual models are taught.

**Why it trains:** Dual payoff: it trains the pre-walk reset (a genuine skill), and it upgrades M1's honesty — a baseline taken standing still on a mark is a better 'your height' reference than one sampled mid-first-stride, reducing false posture faults for the whole walk. Cheapest idea here per unit of measurement-quality gained.

**Needs:** EXISTS: countdown phase + bar-accurate music clock, start anchor (uAnchorStart), head-height stream, floor shader. NEW: a breathing-radius term on the start decal (uniform-driven) + a ~2 s standing-window baseline capture in metrics.ts/pose-derive.ts with fallback to the current method when the trainee skips the mark. Guard: baseline source is recorded in walk stats.

**Honesty:** Must disclose which baseline was used (marked-standing vs walk-start) in the export envelope, since it changes M1's reference. No new claims — same metric, better-grounded reference. KILLED alternatives from this lens, for the record: a live stick-figure 'mirror' at the runway end (iPhone world-space keypoints are proven, but rendering them in the runway frame needs a camera-to-runway calibration that doesn't exist yet — propose only after that founder-level calibration step) and scrolling floor pace-bands (cognitively muddy; strictly dominated by the Pace Ghost).

**Adversary A — KEEP:** Verified: today's M1 baseline really is the first-0.5 s-of-walking average (metrics.ts:603), so a marked standing capture genuinely improves the reference, and recording which baseline source scored the walk is exactly the disclosure the honesty law demands — cheapest measurement-quality gain on the list.

**Adversary B — KEEP:** Cheapest measurement-quality gain on the list — a standing-still baseline is strictly more honest than the current first-0.5s-of-stride sample, the baseline-source disclosure in the walk record is exactly right, and it becomes the natural home for Backstage call's PA cue rather than a second pre-GO phase.



## Lens 3 — environment & presence (pressure as a training variable)

### Flash-line choreography (the paparazzi read you)  `[cost S / lens-rank 1]`

**What:** The camera-flash Points cloud already exists (stage.ts flash anchors + createCameraFlashMaterial) but fires statistically. Make it respond to the walker: flashes cluster on the seats AHEAD of the trainee's along-coordinate (photographers shoot the approach), density surges during the pose hold, and a synchronized 'wall of flashes' beat fires only while measured pace (M2) and centerline (M4) are inside the pass band. Zero new geometry — two shader uniforms (trainee-along in the floor's uv frame via the existing floorAnchorUv machinery, plus an intensity scalar) and a small pure event-mapping module in the sfx-timeline pattern.

**Why it trains:** Two real training outcomes. (1) Flash tolerance is a genuine runway skill — models must hold gaze, chin, and stride under strobing; today the flashes are ambient wallpaper, so nothing is being trained. (2) It is a mid-walk NONVERBAL feedback channel: the HUD is behind the walker (the solved problem that forced voice coaching), but flash density is visible in the peripheral field — 'the photographers are firing' = you're in the pocket. That is exactly how the real thing communicates.

**Needs:** EXISTS: flash cloud + anchors, camera-flash shader, RunwayPathProjector along-coordinate, 6 Hz metric snapshot, show energy. NEW: uniform plumbing (trainee uv + intensity), a pure tested mapping (metric bands -> flash rate), coach-copy disclosure line. No budget impact — same points, same draw call.

**Honesty:** Flash density is a REWARD MAPPING from measured M2/M4 bands, disclosed in the brief/coach copy ('the flash wall fires when your pace and line are in band'). It never claims the crowd perceives presence or confidence. Sensor: head 6DoF via the existing projector; derivation: the already-published band checks; no new per-body normalization needed.

**Adversary A — KEEP:** A disclosed reward mapping from measured M2/M4 bands driven through two uniforms on the existing flash Points cloud (verified same-draw-call in stage.ts), and it supplies the mid-walk nonverbal feedback channel the behind-you HUD physically cannot — spectacle WITH a training mechanism.

**Adversary B — FIX:** Two-uniform cost and the peripheral nonverbal channel are real, but as stated it fights the Pressure Ladder for the same knob (ladder sets flash rate as a stressor, this sets it as a reward) and a reward that strobes hardest when you're performing best inverts the flash-tolerance training claim — fix by defining one owner: pressure level sets the base flash regime, in-band performance modulates within it, and the mapping is disclosed.


### Reactive positional crowd audio (the room hears you)  `[cost M / lens-rank 2]`

**What:** A fully synthesized crowd bed on the shared AudioContext (audio-core.ts, same bus/retirement discipline as sfx.ts): filtered-noise murmur, applause grains, a gasp swell. Spatialized with a hard cap of 6-8 equalpower panner voices placed at audience cluster centroids from the existing seat/flash anchor build, listener driven by head pose (zero-alloc per-frame pan update). It reacts to real events: a clean footstrike streak swells the murmur, arrival at the pose mark triggers a hush-then-applause, the finish ovation scales with the measured overall score the summary already computes.

**Why it trains:** Audio is the proven mid-walk presence channel in this product (coach voice exists because the HUD can't). A crowd that audibly sits BEHIND and BESIDE you, and audibly responds to what you actually did, is the single strongest pressure stimulus available without any new sensor — and pressure exposure is a legitimate training variable: walking under a live room differs measurably from walking alone. It also anchors the audience in AR passthrough where visual density is limited by the triangle budget: sound is presence-per-triangle at ratio infinity.

**Needs:** EXISTS: shared AudioContext + bus retirement laws, show energy, seat anchors, walk-stats streaks, ShowSummary.overall, lastStep edge. NEW: crowd voice synthesis recipes (pure, sfx-timeline-tested), 6-8 capped panner voices, event mapping. Respects the zero-alloc rule (nodes per event, pans via preallocated vectors).

**Honesty:** Applause/hush intensity maps ONLY from disclosed measured quantities (footstrike streaks, band checks, the final overall). Copy says 'the house responds to your measured line' — never 'the crowd feels your confidence'. No new metric is derived from it.

**Adversary A — KEEP:** Hard-capped 6–8 panner voices mapping only from already-measured events on the shared AudioContext respect both the honesty law and the perf law, and audio is this product's proven presence channel — but its training value is realized through the pressure ladder, so build them together.

**Adversary B — KEEP:** Audio is this product's proven mid-walk channel, 6-8 capped panner voices respect the perf law, pressure exposure is a legitimate training variable, and the honesty discipline (intensity maps only from disclosed measured quantities) is airtight — the strongest presence-per-triangle buy available.


### Audience gaze dynamics (heads turn as you pass)  `[cost M / lens-rank 3]`

**What:** The instanced contour audience is frozen. Add per-instance vertex-shader animation — no skeletons, no per-frame matrix uploads: at geometry build time bake a head-region weight attribute and a seat-along attribute into the merged humanoid geometry; a per-frame uniform (trainee along + lateral) lets the shader rotate heads/upper torsos a few degrees to track the walker, with per-seat phase jitter so it reads organic, plus a phones-up lean during the pose beat. Procedural figures only (the optional GLB audience path documented as static).

**Why it trains:** Being WATCHED is the pressure. A static mannequin crowd reads as fake within seconds and quietly tells the trainee's nervous system 'this is a game' — which is precisely the transfer-killer for a pressure simulator. Eyes tracking you as you pass is the core social-pressure stimulus, and it directly potentiates the crowd-audio and pressure-ladder ideas. CPU cost is one uniform write per frame; GPU cost is a few shader instructions on triangles already being drawn.

**Needs:** EXISTS: buildShapeAudience with per-seat data at build time, InstancedMesh crowd, budget caps (AUDIENCE_MAX_COL untouched). NEW: baked head-weight + seat-along attributes, onBeforeCompile/custom material for the figures, one uniform update in the existing shader-time system. Verify the merged-humanoid geometry exposes a clean head region; if not, split head into its own instanced submesh at build.

**Honesty:** Pure stimulus, no metric claims. Head-turn targeting uses the same projector coordinate the metrics use.

**Adversary A — FIX:** The vertex-shader mechanics respect the budget caps, but standalone it's a pressure stimulus with no protocol — ship it as a pressure-ladder level ingredient so its presence is a stamped, comparable condition, and verify the merged humanoid geometry actually exposes a clean head region before committing (the idea itself flags this unknown).

**Adversary B — KEEP:** Being watched is the pressure stimulus the ladder needs and the bake-attributes-plus-one-uniform design stays out of the crash class — but the keep is conditional on the stated verification that the merged humanoid geometry exposes a head region without adding a second instanced draw call per audience block.


### Pressure ladder + honest composure delta  `[cost S / lens-rank 4]`

**What:** Make crowd pressure an explicit, selectable, RECORDED training variable: levels 0-3 (empty studio -> sparse quiet crowd -> full house + murmur -> full house + flash walls + reactive audio), each a parameter set over systems that exist or are proposed above (audience column density scalar under the existing cap, flash rate, crowd-audio level). The pressure level is stamped into the walk record (the mode/threshold stamping pattern from audit #4/#38), and history gains one view: M1-M4 at pressure N vs pressure 0.

**Why it trains:** This is what converts environment spectacle into a TRAINING OUTCOME with a number on it. Graduated exposure is how pressure skills are actually built (walk clean alone, then keep it clean under a full house), and the delta view answers the trainee's real question: 'does my technique survive an audience?' It also gives the four training modes a second curriculum axis for free. Without this, ideas 1-3 are vibes; with it, they're a protocol.

**Needs:** EXISTS: modes/prefs plumbing, walk records with condition stamping precedent, history/progress views, audienceColumnCount (density is just a perimeter scalar, cap intact). NEW: a pressure field in prefs + record schema, preset table, one history comparison view, coach copy. Cheapest if built after ideas 1-2, still shippable before them at level 0-1.

**Honesty:** THE key honesty case: 'composure' is presented ONLY as the disclosed delta of the same measured M1-M4 across recorded pressure conditions — same sensors (head 6DoF / iPhone keypoints), same per-body normalization inherited from the base metrics, derivation shown ('footwork at full house: 81 vs 88 alone'). It is never labeled a measurement of stress, nerves, or confidence.

**Adversary A — KEEP:** This is the idea that converts the entire environment lens from vibes into protocol: graduated exposure as a recorded condition with same-metric deltas ('footwork at full house: 81 vs 88 alone'), never labeled stress or confidence — the honesty case handled exactly right, and it should land BEFORE its stimulus siblings.

**Adversary B — KEEP:** This is the keystone that converts every environment idea from vibes into a protocol — graduated exposure with condition-stamped records and the delta framing ('footwork at full house: 81 vs 88 alone') is the ONLY honest way this product can ever talk about composure, and it's S-cost plumbing over existing caps.


### Venue identity presets (Studio / Tent / Grand Hall) with matched acoustics  `[cost M / lens-rank 5]`

**What:** Three procedural venues as parameter sets over existing systems — no new scenery meshes: STUDIO (flat white light, 20 seats close, dry acoustics, stripped percussion-light music arrangement), FASHION-WEEK TENT (the current look, formalized), GRAND HALL (warm keys, triple-tier density at the cap, long synthesized reverb, fuller arrangement). Acoustics are the identity carrier: one synthesized impulse-response ConvolverNode per venue as a send on the existing sfx/music buses — your own heel taps (the footstrike SFX that already fires per strike) click dry in the studio and bloom in the hall. I folded a separate 'footstep acoustics' idea into this — alone it's a toy; as the venue signature it's the cheapest 90% of venue presence.

**Why it trains:** Skill transfer is context-dependent: models walk castings in dead-quiet studios and shows in reverberant halls, and pacing/nerves differ in each. Venues give the pressure ladder qualitative texture (intimate scrutiny vs grand scale are different pressures, not just more pressure), and hearing YOUR OWN footsteps in venue acoustics is simultaneously a presence anchor and a free rhythm-feedback channel — you can hear your own cadence unevenness. Also cleanly resolves the standing founder-call 'per-mode music' as per-venue arrangements.

**Needs:** EXISTS: stage mood/lighting params, audience density math (capped), music engine (arrangement flags are new params on existing voices), sfx buses, theme, per-walk stamping precedent. NEW: preset table, synthesized IR generation (noise-burst shaping, no assets), a send bus, venue picker row (landing + headset settings), venue tag in records. Budget: same geometry, density only moves BELOW existing caps; one ConvolverNode is fixed cost, created per venue not per frame.

**Honesty:** Venue is a recorded condition tag like pressure level; any cross-venue comparison uses the same disclosed M1-M4 deltas. Music/reverb make no metric claims.

**Adversary A — KEEP:** Pure parameter sets under existing caps with condition tags, one fixed-cost ConvolverNode, and hearing your own footstrike SFX in venue acoustics is a genuine self-feedback channel — plus it retires the standing per-mode-music founder call as per-venue arrangements.

**Adversary B — KEEP:** Context-varied practice is real motor-learning science (not spectacle), parameter-sets-over-existing-systems plus one fixed ConvolverNode respects the budget, and it retires the standing per-mode-music founder call — but sequence it AFTER the pressure ladder proves condition-stamping, since venue is just a second condition tag on the same machinery.


### Find your light (pose-mark hold discipline)  `[cost S / lens-rank 6]`

**What:** Make the pose mark a LIGHT, not a decal: as the trainee approaches, the hero spotlight tightens into a pool exactly on the mark, house lights dim a stop, and the crowd hushes (idea-2 hook). The hold beat is scored: a hold-window detector measures head sway (position variance in the runway frame over the ~2 s hold) and mark accuracy (along/lateral offset of the settled head position from the mark). 'Walk into the pool and be still in it' — the real skill is literally called finding your light.

**Why it trains:** The pose at the end of the runway is the money shot of a real walk and today it's the least-trained beat — the pose burst fires visually but nothing measures whether the trainee actually hit the mark and held still. Stillness under a hot spotlight with the room hushed is a distinct, nameable skill with an unambiguous physical measurement, and the environment (pool tightens, house dims) is what CREATES the training pressure rather than decorating it.

**Needs:** EXISTS: pose mark + its along-coordinate, hero spotlight + mood system, RunwayPathProjector, WalkStatsAccumulator, pose-burst edge, show phases. NEW: pure hold-window detector + sway accumulator (vitest golden-vector style), two mood parameters (pool radius, house dim), a summary row + coach line. Works on head-only sensing; the iPhone hip/ankle keypoints refine it when present.

**Honesty:** New measured quantity, fully compliant: sensor = head 6DoF (refined by iPhone world-space hips when fresh); derivation = positional variance + mark offset during the detected hold window, published as centimeters before any 0-100 mapping (the walk-stats signed-quantity pattern). Per-body normalization: sway threshold scales with calibrated standing head height (taller bodies show more head excursion for the same base sway). Reported as HOLD STABILITY — never as 'poise' or 'presence'.

**Adversary A — FIX:** The measurement spec (cm-first, height-normalized sway, 'HOLD STABILITY' never 'poise') is fully compliant, but it's a duplicate of M10 — merge the pool-tighten/house-dim pressure staging and the mark-accuracy sub-score into M10's single implementation instead of a second sway accumulator.

**Adversary B — FIX:** The pool-tightens/house-dims stagecraft is the best pressure framing of the hold beat, but this is the THIRD proposal of the same stillness measurement — fix by contributing the lighting choreography and the hush hook to the merged M10 feature and deleting its duplicate sway accumulator.


### Backstage call (the show starts before the runway)  `[cost M / lens-rank 7]`

**What:** One new show beat ahead of brief: BACKSTAGE. The music plays muffled (a lowpass on the existing music bus that snaps open at GO — the through-the-wall cliche, nearly free), the stage sits dark behind a curtain-of-light plane at the start line, and the coach-voice PA runs the real call: 'First looks, standing by... {name}, you're up in three.' GO becomes a caller's cue, not a self-start, and the light curtain douses as the drop hits. Adds one honest stat: cue latency — seconds from GO to the head crossing the start line.

**Why it trains:** Real runway failure modes include the start: models blow walks by launching flat-footed off a rushed cue. Cue discipline — composing yourself during the standby, then starting crisply on the caller — is trainable and currently absent because the trainee self-starts. The muffled-music-then-doors-open transition is also the highest emotional-presence-per-line-of-code moment available: it manufactures the adrenaline spike the simulator exists to inoculate against.

**Needs:** EXISTS: show state machine (delta-accumulated phases), coach-voice, ONE-CLOCK GO plumbing (goAudioTime), music bus (add one BiquadFilter), start line along-coordinate, stage mood. NEW: one phase + timing entry, PA copy, a light-curtain plane (one quad, additive shader), the cue-latency stat in walk-stats. Skippable via a pref for drill repetition.

**Honesty:** Cue latency is a pure time: head along-coordinate crossing startAlong minus the GO instant, both already published. Body-neutral (no normalization needed); disclosed as REACTION TO CUE, not 'readiness'.

**Adversary A — KEEP:** Cue latency is a pure time between two already-published events (GO instant, start-line crossing) and cue discipline is a real, currently-untrained failure mode — keep the skip pref for drill reps and drop the '{name}' PA line since no trainee-name field exists anywhere in the product.

**Adversary B — FIX:** Cue latency is a genuinely honest new stat and the muffled-music snap is nearly free, but two separate pre-GO rituals (this plus Backstage Mark) would bloat every single walk — fix by merging the PA call, the lowpass, and the cue-latency stat INTO the Backstage Mark stand as one skippable pre-GO phase.


### Passthrough light spill + contact grounding (kept, ranked honestly low)  `[cost S / lens-rank 8]`

**What:** Extend the existing live-floor shader with an additive SPILL SKIRT just beyond the runway edges: the spotlight pool, flash glints, and finale swell bleed onto the passthrough floor around the deck, and soft shadow blobs sit under the audience risers. Implementation is a shader-only skirt band on the existing capped heave grid (budget test updated) or one cheap additive plane — no new lighting, no new draw-call class. I nearly killed this (it is the most 'polish-shaped' idea here), and I DID kill its sibling — ghost NPC walkers ahead of you in the walk order — as pure spectacle with real GPU risk; this one survives because anchoring is a presence mechanism, not a garnish.

**Why it trains:** In the headset the runway floats on the real room with a hard luminance edge; virtual light that stops dead at the deck boundary is the tell that keeps the brain in 'game' mode. Light crossing the virtual/real boundary is the classic AR grounding cue, and it directly amplifies every pressure idea above — pressure only trains if the room is believed. But its training value is entirely indirect, hence last place despite the small cost.

**Needs:** EXISTS: unified floor shader + uniforms (spot position, flash intensity, finale envelope all live there already), stage-budget caps + tests, shadow catcher precedent. NEW: skirt geometry/shader branch, riser shadow blobs (instanced circles), a BUDGET.md row + regression test proving the vertex budget stays bounded.

**Honesty:** No metric contact.

**Adversary A — KILL:** The founder asked for the next level, not more polish — this is finding #50 of the polish audit wearing a presence argument, its training value is admitted to be entirely indirect, and the author nearly killed it himself; revisit only if on-device pressure-ladder testing shows the deck edge actually breaks believability.

**Adversary B — KILL:** The author's own words convict it — 'training value is entirely indirect' and 'the most polish-shaped idea here' — and with a 49-finding polish audit already fully executed, the founder asked for the next level, not row 50; park it in the polish backlog.



## Lens 4 — curriculum (what turns a scoreboard into a coach)

### FIT SESSION — a real baseline/calibration walk (per-body normalization for everything)  `[cost M / lens-rank 1]`

**What:** A one-time, re-runnable ~60s guided session: (1) stand still 5s at the runway start — locks a TRUE head-height baseline and idle-noise floor (replacing the first-0.5s-of-walk average in metrics.ts deriveFromHead); (2) walk the deck at YOUR comfortable pace, no scoring — records natural pace (m/s), natural cadence (spm), and natural bob amplitude; (3) with the iPhone stream live, also captures leg length (hip→ankle) and shoulder width from the 9 world-space keypoints. Persists a BodyBaseline in user-prefs; every metric mapping then normalizes against the trainee's own body: bob hysteresis scaled to their amplitude (BOB_THRESHOLD is a fixed 0.004m today — tall walkers bob more), posture drift scored in % of head height (the 96 - dev*350 constant is one-size), and drill bars set relative to their natural cadence/pace.

**Why it trains:** This is the cheapest idea with the widest blast radius: it makes every EXISTING metric more honest and more sensitive per body, it gives the coach a defensible 'improved vs YOUR baseline' claim (the current trends compare across modes with different ideal paces), and it is the explicit prerequisite the founder's honesty law names ('every metric must state its per-body normalization' — today the normalization is a hardcoded constant). It also creates the natural Day-0 session every curriculum needs before drills mean anything.

**Needs:** EXISTS: head 6DoF, RunwayProjector, walk-stats accumulator, user-prefs persistence, show phase machine (add a 'fit' variant of the brief→walk flow), iPhone keypoints (optional upgrade). NEW: BodyBaseline type + storage, a still-stand variance gate ('hold still' detector = head position variance under threshold for 5s), plumb baseline constants into the score mappings in metrics.ts/pose-derive.ts, re-generate golden vectors for the Solo mirror (the drift lock means the Swift port must move in step — this is the real cost).

**Honesty:** Nothing new is claimed — the same four channels, but each score's normalization becomes a measured per-body quantity instead of a tuned constant, and the coach can now say 'vs your calibrated baseline' truthfully. The still-stand baseline must disclose it is HEAD height, not spine posture. Golden-vector mirror freshness (SOLO-MODE) must be re-enforced after the constant plumbing.

**Adversary A — KEEP:** Verified: BOB_THRESHOLD is a hardcoded 0.004 m and posture maps through a one-size 96 − dev·350, so per-body normalization today is a tuned constant — this is the prerequisite the honesty law names, with one addition: stamp a normalization-version on walk records so pre-FIT and post-FIT scores are never trended as one series.

**Adversary B — KEEP:** The honesty law literally demands per-body normalization and today it's hardcoded constants (BOB_THRESHOLD, the one-size posture mapping) — widest blast radius per unit cost on the list, and the only stated cost that matters (regenerating the Solo golden-vector mirror) is correctly identified rather than hidden.


### DRILL KERNEL + four starter drills (Line / Tempo / Level / Hold)  `[cost M / lens-rank 2]`

**What:** A Drill type built on the modes.ts pattern but structurally different: ONE scored channel, short reps (15-25s), 3 reps per set, per-rep verdict spoken immediately (coach-voice exists), no composites on the card. Starters, each mapped to an existing channel: LINE DRILL (M4) — walk a visually narrowed lane (a lane-width uniform on the live floor shader: the trainee-glow lane shrinks from 60cm to 25cm; zero new geometry, respects stage-budget), pass = meanAbsLateralM under the lane bar; TEMPO DRILL (M2) — hold the mode's ideal pace, scored as time-in-band % (new small accumulator on WalkStatsAccumulator: seconds where |pace-ideal| < band); LEVEL DRILL (M1) — walk with head-height drift held inside ±N% of calibrated height, scored as time-in-band %; HOLD DRILL — the pose dwell the U-route already times: 3s at the mark with head position variance + head-yaw stability under threshold (head orientation is tracked today and used by NOTHING — a free new honest signal).

**Why it trains:** Isolation is the single biggest pedagogy gap: today every walk grades seven numbers at once, so a trainee who fails footwork gets a note but no way to PRACTICE footwork without also being graded on everything else. Motor-learning basics — blocked practice on one variable with immediate feedback — is what turns the scoreboard into a coach. Time-in-band % is also a better teaching statistic than an EMA-mapped 0-100: it tells the trainee exactly how much of the rep they held the skill.

**Needs:** EXISTS: all four channels (metrics.ts), signed real measurements (walk-stats.ts), floor shader lane glow (shaders.ts — one new uniform), show phase machine (reps = short walk phases), coach-voice for per-rep verdicts, per-mode records pattern for per-drill records. NEW: Drill definition module (drills.ts, sibling of modes.ts), band-time accumulators in walk-stats, HOLD's head-stillness derivation (position variance + yaw MAD over the dwell window — new but trivial, head pose is already sampled), drill picker UI on landing + XR panel, session-recorder rows gain a drillId.

**Honesty:** Each drill claims ONLY its channel: LINE = 'lateral head deviation from the mapped centerline', not foot placement (unless the iPhone stream is live, when it upgrades to ankle-derived — the drill card states which source scored the rep, the trackerActive flag already exists). HOLD measures head stillness and head aim, NOT pose quality or styling — the card must say so. Time-in-band bars derive from the FIT baseline where per-body (Level), from the mode constant where universal (Tempo).

**Adversary A — KEEP:** Blocked single-channel practice with time-in-band and per-rep source labeling is the biggest pedagogy gap in the product, every channel verifiably exists, and the lane is one shader uniform — just make the HOLD drill consume M10's accumulator rather than growing its own head-stillness derivation.

**Adversary B — KEEP:** Blocked single-variable practice with immediate verdicts is the biggest pedagogy gap in a product that currently grades seven numbers per walk, time-in-band beats EMA-mapped scores as a teaching statistic, and the lane shrink is one shader uniform — the HOLD drill must consume the merged M10 channel rather than growing its own.


### BEAT DRILL — footstrike-to-music entrainment (a genuinely new measured channel)  `[cost M / lens-rank 3]`

**What:** The music is 122 BPM with a unified GO-on-the-drop, and every footstrike is already timestamped (stats.addStep in all three derivation paths). The beat grid is therefore KNOWN relative to the walk clock. New channel: BEAT — the circular phase offset of each strike against the beat grid (target: strike-per-beat at 122, or per-2-beats for the slower modes), scored as mean |phase| + phase consistency. The drill: 20s walk where the floor pulses on the grid (the shader already has beat-reactive energy) and the trainee lands ON it; per-rep card shows a strike-vs-grid strip chart.

**Why it trains:** Today's rhythm metric (M3) is SELF-consistency — MAD of your own intervals. It cannot distinguish 'perfectly even at the wrong tempo' from 'locked to the show'. Entrainment to an external beat is the actual runway skill (shows are walked to music), it is a different trainable ability from evenness, and it is the highest-value NEW channel available without any new sensor. It also finally makes the music load-bearing for training rather than atmosphere.

**Needs:** EXISTS: strike timestamps (walk-stats), the BPM + GO-sync (music.ts/show-timing.ts — must expose the grid's t0 to the metrics layer), beat-reactive floor (shaders.ts). NEW: phase-offset accumulator (scalar math, zero-alloc), the BEAT drill definition, the strip-chart on the summary card. One real caveat to engineer around: the bob-derived strike lags the true heel strike by a roughly constant offset — solve by scoring phase CONSISTENCY primarily and calibrating the constant lag out during the FIT session's natural walk.

**Honesty:** Derivation stated plainly: 'strike' = the head-bob up-crossing (or hip-bob/ankle event when the camera owns the walk), so the channel is 'your detected strike timing vs the music grid', with the constant detection lag disclosed and calibrated out — never claim millisecond-true heel-strike timing. Source handoffs mid-rep (camera↔head) must void the rep, reusing the existing resetCadence seam, because the two paths' strike semantics differ.

**Adversary A — FIX:** Same channel as M9 proposed independently — build this as the drill wrapper (floor pulse, strip chart, rep-voiding on source handoff, and the genuinely good FIT-calibrated lag removal) over M9's single implementation, not a third copy of the circular-phase math.

**Adversary B — FIX:** The drill form (pulsing floor, strip chart, source-handoff voiding the rep) is the right training vehicle, but it independently re-specifies M9's entire channel including the same clock bridge and lag caveat — fix by building the derivation once as M9 and shipping this as its drill wrapper, with the FIT-session lag calibration shared.


### SKILL LADDER — a progression tree gated by the existing mastery rule, measured channels only  `[cost S / lens-rank 4]`

**What:** A small curriculum graph over drills and modes: LINE → TEMPO → LEVEL → BEAT → HOLD → TURN → the four mode walks (Beginner always open; High-Fashion/Commercial/Challenge each gated on named drill masteries, e.g. Challenge needs BEAT + LINE mastered). The gate is progress.ts's shipped 3-of-last-5 rule generalized to per-drill records; unlock state persists beside per-mode records. Locked nodes stay VISIBLE with exact earn-copy ('Master LINE: 3 of your last 5 reps under 8cm'). Ships with a founder toggle for hard-lock vs soft-recommend (soft default — adults hate hard locks in a training tool).

**Why it trains:** Progression is what makes practice self-directing: the trainee always knows the next thing to earn, and passing a gate is a REAL achievement because the gate is a measured mastery, not playtime. It also converts the existing mastery-records feature from a retrospective stat into forward-pulling structure — near-zero new measurement for a large motivational and pedagogical return.

**Needs:** EXISTS: mastery math (progress.ts), per-mode records, session rows, landing + XR mode picker to extend into a tree view. NEW: the graph data (one static module), per-drill record aggregation (same code path as per-mode), unlock persistence, earn-copy strings. Depends on ideas 2/3 existing; standalone cost is genuinely small.

**Honesty:** Gates may ONLY reference measured channels — never composites (a 'presence gate' would launder M5 into a credential, violating the law). Earn-copy always states the measured criterion verbatim. Gate evaluation reuses realScoredRows so synthetic preview walks can never unlock anything.

**Adversary A — KEEP:** Gates reference only measured channels through the shipped realScoredRows/MASTERY_PASS_COUNT machinery (verified in progress.ts), earn-copy states the criterion verbatim, and the soft-lock default plus the 'no composite gates' rule keeps M5–M7 from being laundered into credentials.

**Adversary B — KEEP:** Measured-channels-only gates with verbatim earn-copy and the realScoredRows guard make progression honest instead of gamified, the soft-recommend default is the right call for adult trainees, and it converts shipped mastery records into forward pull at S cost.


### SESSION PLANNER — weakest-channel daily plans (warm-up → drill → walk → review)  `[cost M / lens-rank 5]`

**What:** A SessionPlan runner that chains show-phase segments into one coached session, headlined by the 'Daily 10': a 1-rep FIT-check (30s, re-verifies baseline still holds), 2 reps of the trainee's WEAKEST drill — auto-picked from progress.ts trend deltas over the last 5 real walks, measured channels only — then 1 full mode walk, then a review card that pairs the drilled channel's drill score with its in-walk score ('LINE drill 91 → in-walk footwork 84, transfer is happening'). The coach voice narrates transitions so the whole session flows without touching a menu.

**Why it trains:** This is periodized practice in miniature and it answers the question every returning trainee has: 'what should I do today?' Auto-targeting the weakest measured channel closes the loop the product already half-built (trends identify the weakness; nothing today acts on it), and the drill→walk transfer readout is the most honest 'is training working' evidence the sensor set can produce.

**Needs:** EXISTS: trend deltas per metric (progress.ts), show phase machine, coach-voice, mode/drill definitions, session-recorder. NEW: plan definition + runner (a phase-sequence coordinator above ShowDirector), plan-aware summary card, a sessionId grouping rows so the recorder can bind a plan's segments together. No new sensing at all.

**Honesty:** The weakest-channel picker draws from M1-M4 (+BEAT/TURN when they exist), never M5-M7 — a composite can only be weak because a measured channel is. The transfer readout compares like-for-like (same channel, same source path) and says 'drill score vs in-walk score', not 'skill transferred'.

**Adversary A — KEEP:** The weakest-channel picker draws only from measured channels and closes the loop trends already half-built, all with zero new sensing — but police its own example copy: 'transfer is happening' is a claim the sensors don't license, and the honesty section's 'drill score vs in-walk score' phrasing is the only legal form.

**Adversary B — KEEP:** Closes the loop the product half-built (trends identify the weakness, nothing acts on it), and the drill-score-vs-in-walk-score pairing is the most honest transfer evidence this sensor set can produce — the M1-M4-only picker rule correctly blocks composite laundering.


### TURN DRILL + M8 TURN — measure the thing the coach currently confesses it can't  `[cost M / lens-rank 6]`

**What:** coach.ts ships the line 'the turn is not analyzed' — this fills the product's own confessed gap. On out-and-back routes the turn window is already detectable (walkProgress ~0.5 at the pose mark). New head-derived TURN channel with three sub-measures: turn footprint (max excursion of the head's XZ path inside the turn window — a tight pivot vs a wandering arc), turn duration, and line re-acquisition time (seconds until |lateral| is back under the drill bar on the return leg). The TURN DRILL is a short out-and-back rep scored on this channel alone; with the iPhone stream live, footprint upgrades from head path to ankle-derived pivot travel.

**Why it trains:** The turn is the hardest, most-failed moment of a runway walk and the one skill the current product cannot coach at all — every mode's instruction says 'hit the mark, hold, bring it home' yet zero points ride on how. A measurable turn also completes the progression ladder's spine (line → pace → posture → beat → TURN → full walk).

**Needs:** EXISTS: walkProgress + pose-mark timing (show.ts caches poseAlong and the mark-reached time), RunwayProjector lateral, head 6DoF, iPhone ankles for the upgrade path, coach-live's TURN_SUPPRESS_SEC seam (the live coach already knows to shut up during the turn — the window logic half-exists). NEW: turn-window state machine + the three accumulators in walk-stats, drill definition, summary sub-card, golden vectors for the Solo mirror.

**Honesty:** Head-derived turn footprint is a PROXY — it measures where the head traveled during the pivot, not foot mechanics; the card must label it 'turn travel (head)' vs 'turn travel (ankles)' by source, exactly like the footwork source split. Duration and re-acquisition are direct and unqualified. Never score turn 'style' — no metric observes it. This ranks below the planner only because the derivation needs the most tuning care of the set; it is the highest-risk/highest-payoff item here.

**Adversary A — FIX:** It's an honest duplicate of M11 (whose head-yaw mechanics are the stronger derivation) and its 'M8' name even collides with head carriage — merge its genuinely good line re-acquisition-time measure and the drill wrapper into M11's single turn channel with one segmentation state machine and one golden-vector set.

**Adversary B — FIX:** Duplicate of M11 down to the same head-path proxy disclosure, plus a naming collision (M8 is already head carriage) — fix by merging into M11's analyzer, keeping this proposal's genuinely additive pieces (line re-acquisition time and the short out-and-back drill form) and renumbering.


### BENCHMARK RE-TEST — a fixed ruler so trends stop comparing apples to oranges  `[cost S / lens-rank 7]`

**What:** A locked benchmark configuration — Beginner weights, straight shape, 0.85 m/s, fixed length — offered by the session planner every Nth session (and after any re-FIT), with rows flagged benchmark=true in the recorder. The trends/sparkline surface gains a benchmark-only series: same mode, same shape, same bar, every time. Cheap addition: the mastery/records panel headlines benchmark deltas ('benchmark 71 → 79 → 84 over 3 weeks') instead of the mixed-mode series.

**Why it trains:** Today's trend math pools walks across four modes with different ideal paces, pass bars, and shapes — a trainee who switches Beginner→Challenge can look like they regressed while actually improving. A periodic fixed-condition re-test is the standard fix from real training science and it makes every longitudinal claim the product wants to make ('you are improving') methodologically defensible. Killed a sibling idea here: cosmetic unlocks / XP streaks for showing up — engagement without measurement, fails the founder's bar.

**Needs:** EXISTS: everything — modes, shapes, recorder, progress math, the planner cadence hook (idea 5). NEW: a benchmark flag on rows, a filtered series in progress.ts, scheduling copy. Almost pure plumbing.

**Honesty:** Strengthens honesty rather than taxing it: benchmark deltas are the ONLY series the product should ever headline as 'improvement', and the copy should say why ('same mode, same runway, same bar'). Mixed-mode trends stay available but demoted to 'recent activity'.

**Adversary A — KEEP:** Verified that today's trend math pools walks across modes with different ideal paces and bars, so a locked-condition periodic re-test is the standard methodological fix — and headlining ONLY benchmark deltas as 'improvement' makes it an honesty upgrade that costs almost pure plumbing.

**Adversary B — KEEP:** Today's trend math pools walks across modes with different bars — a methodological lie waiting to be noticed — and a locked-condition periodic re-test is the standard fix from actual training science at near-pure-plumbing cost; the rule that ONLY benchmark deltas may be headlined as improvement should become product law.

