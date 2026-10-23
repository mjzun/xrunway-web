# Replay ghost VISUAL research — the founder's "not shippable" escalation (2026-07-27)

The 2026-07-23 research pass (docs/RESEARCH-replay-ghost.md) settled the
LEARNING SCIENCE and the honesty boundary (no limbs/gait — cited). The
founder then rejected BOTH shipped figures ("this is not shippable as is"):
v1 the floating additive capsule pill, v2/v3 the alpha-blended dress-form
croquis that reads as a dark dead statue on the dark stage. This pass is
about VISUAL CRAFT only.

Method: 18-agent workflow — 5 research angles (game replay ghosts, hologram
shader craft, fashion form language, honest motion cues, dark-scene
readability) -> 48 raw findings -> top 12 adversarially verified by
independent skeptic agents (each fetched sources + checked the math) ->
one synthesized build spec. ALL 12 verified techniques survived; the
verifiers' refinements are folded into the spec below.

THE ROOT CAUSE (verified, first-principles + Cyanilux): normal alpha
blending composites src*a + dst*(1-a) — where fresnel is low the figure's
facing surfaces are near-black at a~0.14, so the ghost REPLACES the dark
stage with darker pixels. It mathematically cannot read luminous. Additive
blending (ONE, ONE) can only ADD light; on the #0a0c10 house even 0.05 of
tint reads as glow. Everything else builds on that switch.

The verified technique list (full detail + verifier verdicts in the
workflow journal, wf_6f657865-119):
- **Additive blending is the correct mode on a dark stage (the v2 'dead silhouette' root cause)**
- **Inverted-fresnel interior fill: the body must have its own glow gradient, not just a rim**
- **Depth prepass (colorWrite:false) for clean self-occlusion of the translucent figure**
- **Scanlines must be an additive brightness term, not an alpha multiplier, and coarser**
- **HDR-ish over-bright color values fake bloom without a post pass**
- **Fake vertical bloom: a cheap additive billboard 'aura' quad instead of a bloom pass**
- **Motion trail via 2-3 fading afterimage shells (no limbs needed) — the racing-ghost motion cue**
- **Proportions + anchor cues: taller croquis, hot 'presence' core at the head, hem light-dissolve**
- **Micro-life: breathing gain modulation and 1-2 Hz shimmer instead of glitch**
- **Additive blending against dark backgrounds (the #1 'dead silhouette' fix)**
- **Bruno Simon's exact hologram fragment recipe: view-facing fresnel + pow-sharpened stripes + grazing-angle falloff**
- **DoubleSide + gl_FrontFacing normal flip (see-through volume without a second pass)**

---

# REPLAY GHOST v3 — "Light Croquis" Design Spec

**One-line thesis:** v2 died because normal alpha blending mathematically *cannot* make a dark tinted core read luminous over a #0a0c10 stage. v3 is one additive-blended, self-lit editorial croquis with interior body-glow, visible traveling scan bands, honest trajectory echoes, and a floor handoff — 3 translucent layers max, zero limbs, zero post-processing.

**Ranked priority (build in this order; #1 alone clears the "dead statue" rejection):**
1. Additive blend + rim/core energy rewrite (the fix)
2. Proportions + head hotspot + hem dissolve (the figure)
3. Scan bands + micro-life (the alive-at-rest layer)
4. Trajectory echoes (the alive-in-motion layer)
5. Floor handoff retune
6. Silver comparison variant

---

## 1. The Figure — lathe profile (~1.80 m, 9-head editorial croquis)

Widest radius must be ≤ ~12% of height (v2's 0.315 m hem on 1.7 m = squat pawn). LatheGeometry `[radius, y]` points, local y=0 at deck:

```
[0.001, 0.000]   // hem touches deck (geometry touches; light dissolves — see §4)
[0.215, 0.020]   // gown hem flare
[0.190, 0.350]   // skirt
[0.145, 0.750]   // lower gown taper
[0.105, 0.980]   // high hip
[0.088, 1.120]   // waist
[0.125, 1.320]   // bust
[0.155, 1.450]   // shoulder half-width
[0.060, 1.520]   // neck base
[0.045, 1.575]   // neck top
```

Head: keep the separate oval (sphere scaled to 0.085 × 0.115 × 0.090), center y = 1.69 → crown ≈ 1.80 m. Head keeps the recorded pitch/yaw tilt; body keeps the speed-driven lean. Same material instance for body + head (one uniform set).

~48 lathe segments is plenty; this is a hero object viewed at 2–6 m.

## 2. The Material — ONE ShaderMaterial, additive, self-lit

**Material flags (non-negotiable):**
```js
transparent: true,
blending: THREE.AdditiveBlending,
depthWrite: false,
depthTest: true,
side: THREE.DoubleSide,     // far rim adds through near = free volumetric read
forceSinglePass: true       // and require three >= r151
```

**Vertex shader must output:** world-space `vWorldPos` and `vWorldNormal` (modelMatrix-transformed — the ghost translates along the runway, local-space fresnel breaks), **plus** `vLocalY = position.y` (pre-modelMatrix, for hem dissolve and gradient — do NOT use world y, the deck is not at world 0).

**Fragment recipe (additive: alpha pinned to 1.0, all attenuation lives in RGB):**

```glsl
vec3 V = normalize(cameraPosition - vWorldPos);
vec3 N = normalize(vWorldNormal);
float ndv  = abs(dot(N, V));                    // abs() = facing-invariant; no gl_FrontFacing (Adreno-safe)
float fres = pow(1.0 - ndv, 1.5);               // 1.5 not 2.1 — wider mid-tone band for the white rolloff

// scan bands: sawtooth, pow-sharpened, upward drift, fwidth AA against Quest shimmer
float saw  = mod((vWorldPos.y - uTime * 0.035) * 13.0, 1.0);
float band = pow(saw, 3.0);
band *= smoothstep(0.5, 0.15, fwidth(vWorldPos.y) * 13.0);   // fade bands out when they alias

// interior fill: pale ice-blue core, brighter toward chest/head
vec3  coreColor = vec3(0.72, 0.86, 1.0);
float grad = mix(0.35, 1.0, smoothstep(0.0, 1.7, vLocalY));

// energy composition (targets: core floor ~0.10-0.14, rim peak 2.0-2.6 pre-clip)
float energy = 0.12 * grad                      // body floor — never a void
             + 2.2 * fres                       // hot rim
             + band * (0.10 + 0.55 * fres);     // bands live mostly on the shell

energy *= smoothstep(0.85, 0.25, fres) * 0.6 + 0.7;  // grazing-angle falloff, tame the extreme edge

// micro-life (luminance only — never vertex animation)
energy *= 0.85 + 0.15 * sin(uTime * 0.9);            // ~7 s breathe
energy *= 0.94 + 0.06 * sin(vWorldPos.y * 7.0 + uTime * 3.7); // shimmer
energy *= 1.0 + 0.13 * uSpeedNorm;                    // recorded speed → gain (uSpeedNorm = smoothed 0..1)

// hem dissolve + head hotspot (§4, §2b)
energy *= smoothstep(0.0, 0.14, vLocalY);
float headHot = smoothstep(0.16, 0.0, distance(vWorldPos, uHeadCenter));
energy += headHot * 1.6;                              // the measured point burns hottest

// incandescent white rolloff — Carolina Blue at mid-energy, blue-white at peaks
vec3 col = mix(uTint, vec3(0.88, 0.96, 1.0), smoothstep(0.9, 2.2, energy)) * energy;
col *= uGhostGain;                                    // 1.0 hero, per-echo scalar for shells

// 8-bit banding guard on near-black
col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;

gl_FragColor = vec4(col, 1.0);
```

**Uniforms:** `uTint` (#4B9CD3), `uTime` (CPU-wrapped `mod(t, 1000.0)` — mediump sin protection), `uSpeedNorm` (6 Hz speed, exp-smoothed tau ≈ 0.4 s), `uHeadCenter` (world pos of head oval center, updated with pitch tilt), `uGhostGain`.

**Why each ingredient:** additive = can never be darker than the stage (root-cause fix). `abs(dot)` fresnel = DoubleSide correctness without gl_FrontFacing driver risk. Core floor = body, not hollow wireframe. White rolloff = "incandescent light source", not "colored plastic"; cool white, never pure white, so the blue identity survives. Bands at ×13 world-y ≈ 7–8 cm — readable at 2–6 m where v2's ×46 aliased to mush; drift 0.035 m/s = visibly alive at rest. Dither because smooth additive gradients over #0a0c10 band hard in sRGB8.

**Tuning law:** cap composite peaks so ghost + floor disc overlap doesn't clip to cyan-white; the ONLY intended clip is the head hotspot and extreme grazing rim.

## 3. Motion / Life Layer — trajectory echoes (honest, free data)

Re-render the SAME lathe+head at past transforms sampled from the recorded 6 Hz track. Nothing invented: echoes are literal re-samples of measured along/lateral/yaw.

- **Count:** 2 echoes desktop, **1 on Quest**. Energies via `uGhostGain` = 0.40 and 0.15. No third echo — 0.06 is invisible on a Quest LCD, pure wasted fill.
- **Spacing by distance, not time:** target 0.35 m along-track per echo → `offsetTime = clamp(0.35 / max(speed, 0.2), 0.15, 0.5)` s. Fixed-time echoes hide inside the hero silhouette at walk speed.
- **Inflation:** push vertices `+normal * 0.015 * echoIndex` (vertex shader uniform) so echo rims peek outside the hero.
- **Gating:** zero echoes below ~0.4 m/s; fade `uGhostGain` in/out over 0.3 s across the threshold — no popping at walk start/stop.
- **Overdraw:** additive (order-independent, overlap brightens), small silhouette area, gain-scaled. Well under budget.

Micro-life terms (§2) run on echoes too — same shader, shared clock, so they read as one organism.

## 4. Grounding — the floor handoff

- **Hem light-dissolve:** `smoothstep(0.0, 0.14, vLocalY)` (already in §2). Geometry still touches the deck (`[0.001, 0]` point stays) — the dissolve is optical, not geometric. The figure condenses out of the floor glow instead of standing like a statue.
- **Floor disc retune (guards against a v1 "floats" repeat):** shrink the existing additive disc r 0.34 → **0.25** to match the slim 0.215 hem; opacity 0.2 → **0.28**. There must be no dark ring between hem dissolve and disc.
- Disc follows the ghost as now; echoes get NO disc (budget + it would read as three ghosts).
- renderOrder: floor disc < echoes < hero ghost, pinned explicitly — all are depthWrite-off transparents and three.js center-sorting will flip them per frame otherwise.

## 5. The Comparison Ghost (silver)

Same shader, per-ghost uniforms only:
- `uTint = vec3(0.78, 0.80, 0.84)` (cool silver #C7CCD6-ish); white-rolloff target stays cool white so the two never converge at peaks — the blue ghost peaks blue-white, silver peaks neutral.
- Silver runs at `uGhostGain = 0.8` overall so the trainee's blue is always the hero.
- **Silver gets 0 echoes and no floor disc** — this halves comparison-mode overdraw and visually subordinates it. If both ghosts overlap mid-comparison, additive overlap just brightens; no sorting bug possible.
- Head hotspot on both (it's the honesty marker), but silver's at ×1.2 not ×1.6.

## 6. What NOT to do

- **No limbs, legs, arms, gait, skeleton, cloth sim, or walk-cycle of any kind** — hard methodology boundary. Echoes and luminance are the ONLY motion language.
- **No aura billboard quad** — evaluate after the additive switch; the emissive body + Quest pancake-lens glare almost certainly supply the halo. Only add it if on-device review demands it, and it then replaces one echo in the budget.
- **No depth prepass** — it kills the back-face additive accumulation that gives the volumetric read. Back-pocket only if a normal-blend variant ever returns.
- **No glitch/flicker/random-step artifacts** — wrong register for a premium fashion product; calm breathe + shimmer only.
- **No vertex-animated "breathing"** or region-weighted chest pulse — luminance modulation only (fabricated physiology).
- **Never render this ghost over passthrough/bright backgrounds** — additive vanishes; replay theater is the dark stage, full stop.
- **Don't promise a "double contour"** — on a rotationally symmetric lathe, DoubleSide manifests as a hotter rim + interior volume glow, not two offset edges.
- **Don't expand the disc or add large translucent floor layers** — overdraw is the budget.

## Overdraw ledger (per hero ghost, Quest)
| Layer | Cost |
|---|---|
| Croquis body+head, additive DoubleSide | 1 layer (~2× fill inside a small silhouette) |
| 1 trajectory echo (speed-gated) | 1 layer, small |
| Floor disc r 0.25 | 1 small layer |
| **Total** | **3 — at budget** (silver adds only its body layer) |

## Verify on-device (Quest 3)
1. Torso legible (not a void) when viewed low-angle against the brightest floor region.
2. Ghost + disc overlap does not clip to white at the hem.
3. Scan bands visible at 4 m, no shimmer during head motion.
4. Echo readable at walk pace, invisible when standing, no pop at gait threshold.
5. Blue vs silver instantly distinguishable at peak brightness.
