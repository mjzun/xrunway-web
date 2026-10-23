# Elevating the Replay Ghost — verified research (2026-07-23)

102-agent deep-research pass: 5 search angles, 20 sources fetched, 89 claims
extracted, top 25 adversarially verified (3-vote panels). **18 confirmed,
7 refuted, 0 unverified.** Every finding below survived 3-0 unless noted.
Refuted claims are listed at the bottom — they constrain what we may claim.

House context: the ghost replays the trainee's RECORDED head trajectory
(6 Hz along/lateral + head pitch/yaw + speed) — all genuinely measured.
Founder ruling 2026-07-23: the ghost lives in REPLAY only, never ahead of a
live walk.

## What the evidence supports (confirmed, high confidence)

1. **Self-replay is validated.** Watching your OWN avatar perform improved
   performance vs trial-and-error in a between-participants N=60 VR study
   (CHI 2026 "Show Me How to Play", Best Paper HM) — the front-row
   self-replay concept is exactly this "self-modeling" pattern.
   [dl.acm.org/doi/full/10.1145/3772318.3790333]

2. **Review-only is the RIGHT design; never make the ghost a live crutch.**
   Constant ghost guidance "can induce overreliance and erode memorization
   and skill transfer"; an adaptive/fading ghost held retention (99.6% vs
   87.8% pitch accuracy after guidance removal, N=30) where the always-on
   ghost decayed ~9-11% (CHI 2026 "Skill-Adaptive Ghost Instructors", VR
   piano). This independently corroborates the founder's pace-ghost veto.
   [dl.acm.org/doi/10.1145/3772318.3791437, arxiv.org/abs/2603.06253]

3. **The strongest comparison pattern is a SYNCHRONIZED OVERLAY of two
   attempts on one stage — not side-by-side.** Dartfish SimulCam (the
   Emmy-winning broadcast/coaching technique): superimpose two performances
   of the same course, synchronized, so "even the smallest differences
   become visible." Note: vendor pattern-evidence, not an efficacy study.
   [dartfish.com/features/simulcam]

4. **Competing against your own past attempt roughly doubled effort gains**
   (~16% vs ~8% power output over 4 weeks, CHI 2020 "Race Yourselves",
   n=23) and ghost opponents should be ability-matched — your own past
   walks inherently are. CAVEAT: the studied form is LIVE racing, which the
   founder has vetoed for walks; the surviving application here is
   replay-side attempt-vs-attempt comparison + framing ("beat this line"),
   not an in-walk ghost. [dl.acm.org/doi/abs/10.1145/3313831.3376256]

5. **Novices need scaffolding to extract value from replay.** Video replay
   beats verbal-only feedback (systematic review, 11 studies), BUT
   less-experienced learners benefit LESS from raw visual feedback — the
   replay needs what-to-look-for cueing (the floor rings are the right
   instinct; add attention direction at the moments that matter).
   [link.springer.com/article/10.1007/s12662-021-00782-y]

6. **Camera angles are an experience choice, not the learning lever**
   (medium confidence, single N=28 study): perspective mainly moved focus/
   embodiment; the representation technique moved execution. Two sibling
   claims from this paper were REFUTED — treat as suggestive only.
   [dl.acm.org/doi/full/10.1145/3756884.3766021]

7. **Rendering budget is OVERDRAW, not draw calls** (Meta official Quest
   guidance, current Jan 2026): alpha blending costs per-pixel work for
   every overlapping transparent pixel on the tile-based GPU; "excessive
   transparency causes bottlenecks." The current ghost stacks 4-5
   translucent layers (body + shell + head + head-shell + glow disc) —
   a single-pass fresnel/rim hologram shader is the premium AND cheaper
   direction; avoid large-area transparent trails.
   [developers.meta.com/horizon/design/design-graphic-rendering-pipeline]

8. **The honesty boundary for a fake body is now cited, not just felt.**
   State-of-the-art sparse-input body synthesis (AvatarPoser, ECCV 2022)
   needs head PLUS TWO HANDS for 4.18 cm joint error and calls the problem
   "vastly underdetermined"; no verified source demonstrates convincing
   body reconstruction from head pose alone (Meta's own CTO: leg tracking
   from a headset is "basically not workable... from a physics
   standpoint"). The ghost may honestly render trajectory, speed, and head
   pitch/yaw (measured); ANY articulated limbs/gait would be inference
   dressed as measurement. The stylized capsule is the honest ceiling —
   cite this in methodology.html if ever challenged.
   [arxiv.org/pdf/2207.13784 + 2112.12466 + 2402.09211]

## Refuted in verification (do NOT build on these)

- The ViSTAR basketball AR study (ghost overlay improves form accuracy /
  error recognition) — 3 claims failed verification. There is NO surviving
  direct evidence that a ghost overlay improves form accuracy; the case
  rests on the adjacent evidence above.
- "Multi-ghost beats single-ghost" — refuted; only self-competition-vs-
  alone survives.
- "Third-person view worsens rotation accuracy" + "all views equal" (both
  VReflect sub-claims) — camera-perspective guidance is thin.
- "Self-modeling + expert modeling beats expert modeling alone" — refuted;
  no license to claim an expert-reference ghost is proven better.

## Caveats (the honest frame)

No surviving study is about runway walking or head-trajectory replay —
piano (10-min retention), an exergame tutorial, PE schoolchildren, cycling
effort. All applications are analogical. Dartfish is vendor marketing about
a coaching pattern. Meta's guidance is general Quest advice, not Quest-3
benchmarks with our exact materials.

## The build plan this supports (ranked)

1. **GHOST vs GHOST — synchronized overlay of two attempts** (finding 3+4):
   pick any two walks in RUN HISTORY → both ghosts replay on the same
   runway, aligned by ALONG-TRACK position (not wall-clock — SimulCam's
   insight), current attempt in Carolina, the comparison in silver/white;
   the player bar drives both. All data already recorded; display-only.
2. **Marker moments become coached moments** (finding 5): as the ghost
   nears a ring, auto slow-mo (the 0.5X machinery exists) + one line of the
   engine's own cue copy for that kind — what-to-look-for scaffolding.
3. **One-pass hologram ghost** (finding 7): replace the stacked capsules
   with a single fresnel-rim + faint scanline ShaderMaterial (Carolina tint,
   cheap fragment math) — fewer overdraw layers AND a more premium read.
4. **Framing copy** (finding 4): "YOUR BEST LINE" / delta chips in the
   comparison mode — self-competition without a live ghost.
5. **Do not build**: articulated legs/gait on the ghost (finding 8), any
   in-walk ghost (finding 2 + founder veto), expert-reference ghosts sold
   as proven (refuted).

Open questions for on-device/founder taste: does the abstract capsule vs a
more figurative silhouette change what trainees THINK we measured; actual
Quest-3 frame cost of the current 5-layer ghost vs the one-pass shader.
