# Research — Runway walking pace, cadence & music BPM

*Deep-research run 2026-07-08 (99 agents, 17 sources fetched, 25 claims adversarially verified, 7 refuted). Purpose: verify/correct the app's pace + cadence targets and calibrate the multi-BPM music feature.*

## Bottom line for the app

| Metric | App today | Evidence | Verdict |
|---|---|---|---|
| **Cadence (spm)** | ~96–108 | Measured runway cadence ≈ **122–130 spm (~125)** | **Too low** — our target matches *novice/everyday* heeled walking, not trained runway |
| **Speed (m/s)** | 0.72–1.05 | No source measured runway speed in m/s | **Unverified** but defensible as a deliberately slow, controlled pace |
| **Music BPM** | (procedural, none stated) | No credible source establishes show BPM | **Do NOT claim an industry BPM** — derive it instead (below) |

## The findings (with confidence)

1. **Runway cadence is ~125 spm and uniform across styles/eras — HIGH.** The one peer-reviewed direct measurement (Kobayashi/Saito/Murahori, *Sensors*, June 2024, PMC11207723) analyzed 69 models' opening "first-look" walks at Dolce & Gabbana / Louis Vuitton / Valentino / Versace / Saint Laurent (Paris/Milan, 1995–2023). Per-cluster median cadence: 129.6 / 124.8 / 124.8 / 124.8 / 122.4 spm. A Kruskal–Wallis test found **no significant difference across the five walk-style clusters** — cadence is essentially constant regardless of style or era. Reports cadence *only* — no m/s, no step length (skeletons size-normalized), no BPM.

2. **Our 96–108 spm actually matches everyday/novice walking — HIGH.** A 2025 controlled study (30 inexperienced heel-wearers, ~age 22) measured ~99 spm in 7 cm heels at 0.97 m/s. The CADENCE-Adults study (Tudor-Locke 2020) pins 100 spm = moderate-intensity walking (3 METs), 130 spm = vigorous (6 METs). So 96–108 spm is "normal moderate walking," and real runway (~125 spm) sits near the brisk end.

3. **Our speed range is inferred, not measured — MEDIUM.** No study measured runway walking speed. General references bracket us from above: comfortable young-adult walking is 1.05–1.43 m/s; self-selected heeled corridor walking 1.28 m/s. Our 0.72–1.05 m/s reads as a deliberately slow, controlled gait, consistent with Naomi Campbell's coaching ("slower than the street, don't rush"). **Internal-consistency flag:** ~125 spm × the *long strides* coaches prescribe implies a speed *above* our 1.05 m/s ceiling — our cadence and speed targets may not be mutually consistent with real runway walking.

4. **Music BPM is genuinely unestablished — HIGH (negative).** The authoritative music-supervisor interview (Michel Gaubert / Frédéric Sanchez — the two people who actually score the major shows, *System Magazine* #9) contains **zero** BPM/tempo data; it's about creative concept, not tempo. Every specific figure (110–125, 120–130, 115–125, 120–128 BPM) traced to vendor/blog/AI/forum sources and was **refuted in verification (0-3 or split)**. Any "runway music is X BPM" claim is unsupported — we must not print one.

5. **Beat entrainment is real but conditional — MEDIUM.** Campbell (MasterClass): "I hear the music. I hear the rhythm. I hear the bass… and that's it." Models set pace to the beat *when the track has a walkable rhythm*, and pace off the model ahead when it doesn't. So syncing the walk to the beat is standard — but conditional on a danceable tempo.

6. **All published coaching is qualitative — HIGH.** Long strides, knees slightly higher than usual, feet placed directly in line, consistent pace held through the *return* walk, deliberately slower than street walking. No source gives any numeric pace/cadence/BPM target (corroborated across MasterClass, Backstage, John Casablancas, StarNow, Skylar).

## What this means for our two open builds

### Cadence target (RHYTHM metric + modes.ts)
The evidence says **raise the cadence target toward ~120–125 spm** for editorial authenticity. But because our runway is short (7 m) and walks now hold a pose, our *speed* is partly a function of runway length + hold time, not pure gait — so speed and cadence can't both be lifted naively without breaking `speed = cadence × step length`. **This is a founder calibration call** (and it's golden-affecting — touches modes.json + scoring), so I'm asking before changing it.

### Music BPM (the multi-BPM feature)
Even though no source gives show BPM, we can **derive** authentic options honestly:
- Measured cadence ≈ 125 spm, and models step on-beat when the track is walkable (findings 1 + 5).
- So a track at **~125 BPM → one step per beat** at true runway cadence. **~62 BPM → one step per two beats** (half-time, a slow editorial feel). **~100 BPM** → an everyday-walk feel (what we have now).
- Honest framing: we offer a spread (e.g. a slow/editorial, a standard/on-beat-at-runway-cadence, and a brisk option) and let the beat-lock feature sync the walk — we present these as *design choices tied to measured cadence*, never as "the industry uses X BPM."

## Sources
- Kobayashi, Saito & Murahori, "Classification of Fashion Models' Walking Styles," *Sensors* 2024 — https://pmc.ncbi.nlm.nih.gov/articles/PMC11207723/ (the only direct runway measurement)
- Comfortable walking speed review, *PMC6595586* — https://pmc.ncbi.nlm.nih.gov/articles/PMC6595586/
- Slow walking in high heels — https://hpc.edu.pl/GAIT-CYCLE-OF-SLOW-WALKING-IN-HIGH-HEELS,184036,0,2.html
- Heeled corridor gait, *PMC12225787* — https://pmc.ncbi.nlm.nih.gov/articles/PMC12225787/
- CADENCE-Adults (Tudor-Locke 2020) — https://link.springer.com/article/10.1186/s12966-020-01045-z
- Naomi Campbell runway coaching (MasterClass) — https://www.masterclass.com/articles/runway-walk
- Gaubert/Sanchez music-supervision interview (*System* #9) — https://system-magazine.com/issues/issue-9/soundtrack-michel-gaubert-frederic-sanchez

## Refuted / do-not-use
All specific music-BPM figures (110–125 / 120–130 / 115–125 / 120–128) — vendor/blog/forum origin, failed verification. "Models ignore the beat" — refuted 0-3. Do not cite these.
