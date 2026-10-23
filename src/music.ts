/**
 * (X)RUNWAY — runway music engine.
 *
 * Fully synthesized house at the SELECTED tempo (music-prefs.ts: 62 / 100 /
 * 125 BPM, mode default while unset) — confident, minimal, glossy. No assets.
 *
 *   kick   — sine pitch-drop, four on the floor
 *   hat    — offbeat open hat (filtered white noise)
 *   clap   — layered noise bursts on beats 2 & 4 (bandpassed)
 *   bass   — two-bar offbeat sub line (A1 / F1), sine + soft octave
 *   pad    — detuned-saw Am7(add9) bed through a slow lowpass
 *   duck   — sidechain-style gain dip on every kick (pad + bass bus)
 *
 * Timing: classic look-ahead scheduler (setInterval 25 ms, 0.1 s lookahead)
 * on an 8th-note grid anchored at `gridStart`. The AudioContext is created
 * lazily on the first user-initiated phase change (autoplay rules).
 *
 * ONE CLOCK (#44): the show timeline owns the beat. At the countdown edge the
 * bar grid is RE-ANCHORED (alignGridToGo, show-timing.ts) so that GO —
 * countdown start + COUNTDOWN_SEC, the instant ShowDirector flips to walk —
 * IS a bar boundary, and the drop is pre-armed for exactly that moment. The
 * re-anchor is inaudible: pre-drop the transport plays only sustained pads.
 * Countdown ticks fire on the SAME whole-second boundaries the HUD digits
 * flip on (not the old every-beat metronome), so one pulse counts 3-2-1 into
 * the drop downbeat. `globals.goAudioTime` publishes the armed GO instant on
 * this AudioContext's clock for sibling audio (the SFX layer's GO hit).
 *
 * The AudioContext itself is SHARED with the SFX layer (audio-core.ts): one
 * lazy context, one autoplay unlock, one clock. This system remains its
 * closer on teardown. Countdown ticks + the GO hit live in sfx.ts (#19).
 *
 * Show choreography (phase subscription):
 *   brief      → pads fade in (master 0.8 s), no drums
 *   countdown  → grid re-anchored to GO; riser runs the countdown into GO
 *   walk       → THE DROP: full pattern enters ON the GO downbeat
 *   summary    → FINALE CADENCE (#18): button hit on the beat, drums out,
 *                long sub root + a graded crash bloom under the score
 *                reveal (the melodic pass/fail sting is sfx.ts's); the
 *                pads groove on softly (energy 0.45 closes the filter)
 *   idle/reset → master fades out 0.8 s, graph torn down (no leaks)
 *
 * Energy (globals.showEnergy, peeked per frame) maps to the pad lowpass
 * cutoff and hat level — idle→walk feels like the doors opening.
 *
 * Volume/mute (#6): `globals.musicPrefs` (on/off + volume 0..1 + tempo,
 * persisted) is the engine's public control surface — the landing MUSIC
 * controls and the in-headset settings rows write it. The pref scales
 * MASTER_LEVEL into every master ramp (fade-in, mid-fade rescue, live
 * retarget); off = a silent master, the show itself is untouched.
 *
 * TEMPO LATCH (the multi-BPM founder call — heard = felt = scored): the
 * resolved tempo (pref else mode default, music-prefs.ts) is adopted at the
 * two per-run anchor points — ensurePlaying (a fresh transport) and
 * armDropAtGo (the countdown edge, where the grid re-anchor is silent) —
 * and then LOCKED for the run. armDropAtGo publishes the armed value as
 * `globals.goBpm` beside `goAudioTime`, the single per-run tempo latch the
 * haptic pulse train and the M9 scoring grid read; a pref change after the
 * countdown edge takes effect on the NEXT run, never under a scored walk.
 */

import { createSystem } from "@iwsdk/core";
import type { Signal } from "@preact/signals-core";
import {
  acquireAudioContext,
  closeSharedAudioContext,
  sharedNoiseBuffer,
} from "./audio-core.js";
import {
  DEFAULT_MUSIC,
  resolveMusicBpm,
  type MusicBpm,
  type MusicPrefs,
} from "./music-prefs.js";
import type { ShowPhaseValue, ShowSummary } from "./show.js";
import {
  alignGridToGo,
  barSecOf,
  beatSecOf,
  COUNTDOWN_SEC,
  stepSecOf,
  STEPS_PER_BAR,
} from "./show-timing.js";

const LOOKAHEAD = 0.1; // s
const TICK_MS = 25;
const FADE = 0.8; // s, master in/out
const MASTER_LEVEL = 0.7;
/** Coach-voice duck (#20/#48): the master multiplier while a spoken cue is
 * in flight (~35 % dip). Applied INSIDE masterLevel() so every master ramp
 * (fade-in, mid-fade rescue, pref retarget) respects it for free. */
const VOICE_DUCK_LEVEL = 0.65;

// Notes.
const BASS_A1 = 55.0;
const BASS_F1 = 43.654;
/** Am7(add9) voicing without the third's crowding — airy, editorial. */
const PAD_NOTES: ReadonlyArray<number> = [110.0, 164.81, 196.0, 246.94];
const PAD_DETUNE_CENTS = 6;

export class MusicSystem extends createSystem({}, {}) {
  private phaseSig!: Signal<ShowPhaseValue>;
  private energySig!: Signal<number>;
  /** Persisted on/off + volume (globals.musicPrefs) — may be absent in tests. */
  private prefsSig: Signal<MusicPrefs> | null = null;
  private phase: ShowPhaseValue = "idle";

  // Lazy, session-persistent.
  private ctx: AudioContext | null = null;
  private noiseBuf: AudioBuffer | null = null;

  // Per-run graph (rebuilt every start, torn down on stop — no leaks).
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private duck: GainNode | null = null;
  private padGain: GainNode | null = null;
  private padFilter: BiquadFilterNode | null = null;
  private padLfo: OscillatorNode | null = null;
  private padLfoDepth: GainNode | null = null;
  private padOscs: OscillatorNode[] = [];
  private bassGain: GainNode | null = null;
  private kickBus: GainNode | null = null;
  private hatFilter: BiquadFilterNode | null = null;
  private hatGain: GainNode | null = null;
  private clapFilter: BiquadFilterNode | null = null;
  private clapBus: GainNode | null = null;

  // The active countdown riser (night-review #16): armDropAtGo schedules a
  // countdown-long sweep whose stop() sits at the armed GO instant. A reset
  // mid-countdown only fades the master (teardown deferred ~1 s), so a
  // restart inside that window hit ensurePlaying's mid-fade rescue, ramped
  // the SAME master back up, and resurrected the old sweep — rising to a
  // hard cut at the STALE GO under the new brief's pads. Track the nodes so
  // cancellation is explicit (fadeOutAndStop + every re-arm).
  private riserSrc: AudioBufferSourceNode | null = null;
  private riserGain: GainNode | null = null;

  // Scheduler state.
  private intervalId = 0;
  private stopHandle = 0;
  private playing = false;
  private fadingOut = false;
  private gridStart = 0;
  private step = 0;
  private nextStepTime = 0;
  private dropTime = Infinity;

  // The run's latched tempo (adopted at ensurePlaying + the countdown edge,
  // then locked — see the header's TEMPO LATCH law). Every musical duration
  // in this file reads THESE fields, never a module constant.
  private bpm: MusicBpm = 100;
  private beatSec = beatSecOf(100);
  private barSec = barSecOf(100);
  private stepSec = stepSecOf(100);

  // Energy-mapping caches (avoid spamming AudioParam automation).
  private lastCutoff = -1;
  private lastHatLevel = -1;

  /** Coach-voice duck holds (#20/#48). Counted, not boolean — the delivery
   * layer balances hold/release, but a counter can never under-release. */
  private voiceDuckHolds = 0;

  private readonly schedulerTick = (): void => {
    const ctx = this.ctx;
    if (!ctx || !this.playing) {
      return;
    }
    while (this.nextStepTime < ctx.currentTime + LOOKAHEAD) {
      this.scheduleStep(this.step, this.nextStepTime);
      this.step++;
      this.nextStepTime += this.stepSec;
    }
  };

  init(): void {
    const g = this.globals;
    this.phaseSig = g.showPhase as Signal<ShowPhaseValue>;
    this.energySig = g.showEnergy as Signal<number>;
    this.prefsSig = (g.musicPrefs as Signal<MusicPrefs> | undefined) ?? null;
    if (this.prefsSig) {
      // Live mute toggle / volume drag: retarget the playing master. (subscribe
      // fires once immediately — a no-op while nothing is playing.)
      this.cleanupFuncs.push(
        this.prefsSig.subscribe(() => this.applyMasterLevel()),
      );
    }

    this.cleanupFuncs.push(
      this.phaseSig.subscribe((phase) => {
        this.phase = phase;
        switch (phase) {
          case "brief":
            this.ensurePlaying(); // user gesture path — safe to create ctx
            this.dropTime = Infinity; // pads only until the drop
            break;
          case "countdown":
            this.ensurePlaying();
            this.armDropAtGo();
            break;
          case "walk":
            this.ensurePlaying();
            // The drop was pre-armed at the countdown edge to land EXACTLY on
            // this flip (#44). Only fall back to next-bar scheduling when it
            // wasn't (music started this very phase — ctx failure at brief /
            // countdown, or a test driving phases directly).
            if (this.dropTime === Infinity) {
              this.scheduleDrop();
            }
            break;
          case "summary":
            this.finaleCadence(); // the walk just ENDED — resolve, don't shrug (#18)
            break;
          case "idle":
            this.fadeOutAndStop();
            break;
        }
      }),
    );

    // Coach-voice duck handle (#20/#48): coach-voice.ts holds while a spoken
    // cue plays and releases utterance-end + tail. Published on globals (the
    // showControls handoff pattern) so the delivery layer needs no import of
    // this system. Each transition re-targets the master through the SAME
    // ramp discipline every other level change uses (applyMasterLevel).
    const duckControls = {
      hold: (): void => {
        this.voiceDuckHolds++;
        this.applyMasterLevel();
      },
      release: (): void => {
        if (this.voiceDuckHolds > 0) {
          this.voiceDuckHolds--;
        }
        this.applyMasterLevel();
      },
    };
    g.musicDuck = duckControls;
    this.cleanupFuncs.push(() => {
      if (g.musicDuck === duckControls) {
        g.musicDuck = null;
      }
    });

    // Background-tab handling: the ECS clock is rAF-driven and freezes while
    // the tab is hidden, but the wall-clock scheduler + AudioContext keep
    // running — the music would desync from (or outlive) the frozen show.
    // Suspend the context while hidden; on return, re-anchor the step grid so
    // the missed steps are skipped rather than burst-scheduled.
    const onVisibilityChange = (): void => {
      const ctx = this.ctx;
      if (!ctx) {
        return;
      }
      if (document.hidden) {
        if (this.playing) {
          void ctx.suspend();
        }
      } else {
        if (this.playing && ctx.state === "suspended") {
          void ctx.resume();
          this.nextStepTime = Math.max(
            this.nextStepTime,
            ctx.currentTime + 0.05,
          );
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    this.cleanupFuncs.push(() => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (this.stopHandle !== 0) {
        clearTimeout(this.stopHandle);
        this.stopHandle = 0;
      }
      this.teardownGraph();
      // This system owns closing the SHARED context (audio-core.ts) — the SFX
      // layer only disconnects its own subgraph. Safe if already closed.
      closeSharedAudioContext();
      this.ctx = null;
      this.noiseBuf = null;
    });
  }

  update(): void {
    const ctx = this.ctx;
    const padFilter = this.padFilter;
    const hatGain = this.hatGain;
    if (!this.playing || !ctx || !padFilter || !hatGain) {
      return;
    }
    const energy = this.energySig.peek();
    const now = ctx.currentTime;

    // Lowpass: ~160 Hz closed → ~7.8 kHz wide open (perceptual sweep).
    const cutoff = 160 * Math.pow(2, energy * 5.6);
    if (Math.abs(cutoff - this.lastCutoff) > this.lastCutoff * 0.015) {
      padFilter.frequency.setTargetAtTime(cutoff, now, 0.12);
      this.lastCutoff = cutoff;
    }

    const hatLevel = energy * energy * 0.5;
    if (Math.abs(hatLevel - this.lastHatLevel) > 0.01) {
      hatGain.gain.setTargetAtTime(hatLevel, now, 0.1);
      this.lastHatLevel = hatLevel;
    }
  }

  // -- transport --------------------------------------------------------------

  /** Adopt the currently resolved tempo (pref else active-mode default)
   * into the run's latched fields. Called ONLY at the per-run anchor points
   * (ensurePlaying, armDropAtGo) — never per frame or per schedule, so a
   * pref change can never move the grid under an armed run. */
  private adoptTempo(): void {
    const p = this.prefsSig ? this.prefsSig.peek() : DEFAULT_MUSIC;
    const mode = (
      this.globals.activeMode as Signal<{ id: string }> | undefined
    )?.peek();
    this.bpm = resolveMusicBpm(p, mode?.id ?? null);
    this.beatSec = beatSecOf(this.bpm);
    this.barSec = barSecOf(this.bpm);
    this.stepSec = stepSecOf(this.bpm);
  }

  /** The master target: MASTER_LEVEL scaled by the persisted prefs (0 when
   * muted), dipped by the coach-voice duck while a cue speaks (#20/#48).
   * Every master ramp targets THIS, never the raw constant. */
  private masterLevel(): number {
    const p = this.prefsSig ? this.prefsSig.peek() : DEFAULT_MUSIC;
    const base = p.enabled ? MASTER_LEVEL * p.volume : 0;
    return this.voiceDuckHolds > 0 ? base * VOICE_DUCK_LEVEL : base;
  }

  /** Pref change while playing — ease the master to the new level. The
   * fade-out path keeps ownership of the gain (it's already heading to 0). */
  private applyMasterLevel(): void {
    if (!this.playing || this.fadingOut || !this.ctx || !this.master) {
      return;
    }
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(this.masterLevel(), now, 0.12);
  }

  private ensurePlaying(): void {
    if (this.stopHandle !== 0) {
      clearTimeout(this.stopHandle);
      this.stopHandle = 0;
    }
    if (this.playing) {
      if (this.fadingOut && this.ctx && this.master) {
        // Rescued mid-fade: ramp the master back up (to the pref-scaled level).
        const now = this.ctx.currentTime;
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setTargetAtTime(this.masterLevel(), now, 0.2);
        this.fadingOut = false;
      }
      return;
    }

    // Shared context (audio-core.ts): created lazily here — this is the
    // user-gesture path — and reused by the SFX layer. Null = audio-less
    // environment; the show goes on silently.
    this.ctx = acquireAudioContext();
    if (!this.ctx) {
      return;
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    this.noiseBuf = sharedNoiseBuffer(this.ctx);

    this.buildGraph(this.ctx);

    this.adoptTempo(); // a fresh transport grooves at the current selection

    const now = this.ctx.currentTime;
    this.gridStart = now + 0.06;
    this.step = 0;
    this.nextStepTime = this.gridStart;
    this.dropTime = Infinity;
    this.lastCutoff = -1;
    this.lastHatLevel = -1;

    const master = this.master!;
    master.gain.setValueAtTime(0.0001, now);
    master.gain.linearRampToValueAtTime(this.masterLevel(), now + FADE);

    this.intervalId = window.setInterval(this.schedulerTick, TICK_MS);
    this.playing = true;
    this.fadingOut = false;
  }

  private fadeOutAndStop(): void {
    if (!this.playing || !this.ctx || !this.master || this.fadingOut) {
      return;
    }
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(0.0001, now, FADE / 4);
    this.stopRiser(); // a mid-fade rescue must never resurrect the old sweep
    this.fadingOut = true;
    this.dropTime = Infinity; // drums out immediately during the fade
    this.stopHandle = window.setTimeout(() => {
      this.stopHandle = 0;
      this.teardownGraph();
    }, (FADE + 0.2) * 1000);
  }

  /** Stop the scheduler, kill the pads, disconnect everything. Reusable. */
  private teardownGraph(): void {
    if (this.intervalId !== 0) {
      clearInterval(this.intervalId);
      this.intervalId = 0;
    }
    for (let i = 0; i < this.padOscs.length; i++) {
      try {
        this.padOscs[i].stop();
      } catch {
        /* already stopped */
      }
    }
    this.padOscs.length = 0;
    if (this.padLfo) {
      try {
        this.padLfo.stop();
      } catch {
        /* already stopped */
      }
    }
    // Disconnecting the master detaches the whole per-run subgraph;
    // any in-flight one-shots end (≤ 0.5 s) and become collectable.
    if (this.master) {
      this.master.disconnect();
    }
    if (this.compressor) {
      this.compressor.disconnect();
    }
    this.master = null;
    this.compressor = null;
    this.duck = null;
    this.padGain = null;
    this.padFilter = null;
    this.padLfo = null;
    this.padLfoDepth = null;
    this.bassGain = null;
    this.kickBus = null;
    this.hatFilter = null;
    this.hatGain = null;
    this.clapFilter = null;
    this.clapBus = null;
    this.riserSrc = null; // died with the master's disconnect
    this.riserGain = null;
    this.playing = false;
    this.fadingOut = false;
  }

  /**
   * Countdown edge (#44): GO is `now + COUNTDOWN_SEC` — re-anchor the bar grid
   * so GO IS a bar boundary, pre-arm the drop for exactly that instant, and
   * run the riser the whole countdown into it. Publishes the armed GO instant
   * as `globals.goAudioTime` — the SFX layer (sfx.ts, same shared context)
   * schedules its second-boundary countdown ticks + GO hit against it.
   */
  private armDropAtGo(): void {
    const ctx = this.ctx;
    if (!ctx || !this.playing) {
      return;
    }
    const now = ctx.currentTime;
    const go = now + COUNTDOWN_SEC;
    // Inaudible re-anchor: pre-drop only the sustained pads play (drums enter
    // at the drop, the old metronome is gone), so the grid can move freely —
    // which also makes this the run's tempo-adoption point: a pref change
    // since brief lands here silently, then the tempo is LOCKED for the run.
    this.adoptTempo();
    const grid = alignGridToGo(now, go, this.barSec, this.stepSec);
    this.gridStart = grid.gridStart;
    this.step = grid.step;
    this.nextStepTime = grid.nextStepTime;
    this.dropTime = go;
    this.globals.goAudioTime = go;
    // The per-run tempo latch: what the GO grid was ARMED with. BeatHaptics
    // (same countdown edge, later priority) and MetricsSystem (walk start)
    // read this so the pulse train and the scoring grid can never run a
    // different tempo than the audible music (heard = felt = scored).
    this.globals.goBpm = this.bpm;
    this.riser(now, go);
  }

  /**
   * Finale cadence (#18): finishing the walk used to be `case "summary":
   * break` — the same loop grooving on, softer. Now the music RESOLVES: a
   * button hit (kick + clap + duck dip) on the next beat boundary, a long
   * sub-root under the score reveal, a crash bloom — and the drums go OUT so
   * the pads breathe under the summary. The crash timbre is graded (brighter
   * + longer on a PASS); the melodic pass/fail statement is the SFX layer's
   * reveal sting (sfx.ts). (ShowDirector publishes the summary BEFORE the
   * phase flips, so the stamp is always readable here.)
   */
  private finaleCadence(): void {
    const ctx = this.ctx;
    if (!ctx || !this.playing || this.fadingOut) {
      return;
    }
    const now = ctx.currentTime;
    // Land the button ON the beat grid (≥ 60 ms of scheduling headroom): the
    // finish instant is the trainee's, the resolution stays musical.
    const beats = Math.ceil((now + 0.06 - this.gridStart) / this.beatSec);
    const t = this.gridStart + beats * this.beatSec;

    // Drums out from here — the groove resolves instead of carrying on. (A
    // step already inside the 0.1 s lookahead may still land; it reads as the
    // last hit before the button.)
    this.dropTime = Infinity;

    const summary = (
      this.globals.summary as Signal<ShowSummary | null> | undefined
    )?.peek();
    const pass =
      summary === null || summary === undefined
        ? true
        : summary.overall >= (summary.passThreshold ?? 75);

    // The button: final kick + clap + sidechain dip, like the last bar of a set.
    this.kick(t);
    this.clap(t);
    this.duckAt(t);

    // Long sub root (A1) holding under the score reveal — 2 beats.
    const subDur = this.beatSec * 2;
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(BASS_A1, t);
    const subG = ctx.createGain();
    subG.gain.setValueAtTime(0.0001, t);
    subG.gain.linearRampToValueAtTime(0.85, t + 0.012);
    subG.gain.exponentialRampToValueAtTime(0.0001, t + subDur);
    sub.connect(subG);
    subG.connect(this.bassGain!);
    sub.start(t);
    sub.stop(t + subDur + 0.05);

    // Crash bloom: high-passed noise, ~1.1 s decay (brighter + longer on PASS).
    const crash = ctx.createBufferSource();
    crash.buffer = this.noiseBuf;
    const crashHp = ctx.createBiquadFilter();
    crashHp.type = "highpass";
    crashHp.frequency.value = pass ? 5200 : 3400;
    const crashG = ctx.createGain();
    const crashDur = pass ? 1.2 : 0.7;
    crashG.gain.setValueAtTime(pass ? 0.5 : 0.3, t);
    crashG.gain.exponentialRampToValueAtTime(0.0001, t + crashDur);
    crash.connect(crashHp);
    crashHp.connect(crashG);
    crashG.connect(this.master!);
    crash.start(t, Math.random() * 0.5, crashDur + 0.05);

    // (The MELODIC pass/fail statement is the SFX layer's graded reveal sting
    // — sfx.ts, +0.9 s — so the cadence grades only its crash timbre and the
    // reveal never says the same thing twice.)
  }

  /** Fallback only (music started mid-show): drop on the next bar boundary
   * ≥ one lookahead away. The normal path pre-arms the drop AT GO. */
  private scheduleDrop(): void {
    const ctx = this.ctx;
    if (!ctx || !this.playing) {
      return;
    }
    const now = ctx.currentTime;
    const bars = Math.ceil(
      (now + LOOKAHEAD + 0.05 - this.gridStart) / this.barSec,
    );
    this.dropTime = this.gridStart + bars * this.barSec;
    if (this.dropTime - now > 0.4) {
      this.riser(now, this.dropTime);
    }
  }

  // -- pattern ----------------------------------------------------------------

  private scheduleStep(step: number, t: number): void {
    const inBar = step % STEPS_PER_BAR;

    // (The old every-beat countdown metronome is gone — ticks now fire on the
    // HUD's whole-second boundaries, scheduled once in armDropAtGo (#44).)

    // Drums + bass only after the drop.
    if (t < this.dropTime - 1e-3) {
      return;
    }

    if (inBar % 2 === 0) {
      this.kick(t);
      this.duckAt(t);
    } else {
      this.hat(t);
      const bar = Math.floor(step / STEPS_PER_BAR);
      this.bassNote(t, bar % 2 === 0 ? BASS_A1 : BASS_F1);
    }
    if (inBar === 2 || inBar === 6) {
      this.clap(t);
    }
  }

  // -- voices -----------------------------------------------------------------

  private kick(t: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(46, t + 0.11);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(1, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(g);
    g.connect(this.kickBus!);
    osc.start(t);
    osc.stop(t + 0.32);
  }

  /** Sidechain-style dip on the pad+bass bus — cheap gain automation. */
  private duckAt(t: number): void {
    const duck = this.duck!.gain;
    duck.cancelScheduledValues(t);
    duck.setValueAtTime(0.95, t);
    duck.linearRampToValueAtTime(0.4, t + 0.03);
    duck.linearRampToValueAtTime(1, t + this.beatSec * 0.8);
  }

  private hat(t: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.7, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    src.connect(g);
    g.connect(this.hatFilter!);
    src.start(t, Math.random() * 0.8, 0.25);
  }

  private clap(t: number): void {
    const ctx = this.ctx!;
    // Three micro-bursts — the last carries the tail. Reads as one clap.
    for (let i = 0; i < 3; i++) {
      const at = t + i * 0.013;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const g = ctx.createGain();
      const peak = i === 2 ? 0.85 : 0.45;
      const decay = i === 2 ? 0.22 : 0.035;
      g.gain.setValueAtTime(peak, at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      src.connect(g);
      g.connect(this.clapFilter!);
      src.start(at, Math.random() * 0.8, decay + 0.05);
    }
  }

  private bassNote(t: number, freq: number): void {
    const ctx = this.ctx!;
    const dur = this.beatSec * 0.5;
    // Sub sine.
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(freq, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.9, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    sub.connect(g);
    g.connect(this.bassGain!);
    sub.start(t);
    sub.stop(t + dur + 0.02);
    // Quiet octave triangle for definition on small speakers.
    const oct = ctx.createOscillator();
    oct.type = "triangle";
    oct.frequency.setValueAtTime(freq * 2, t);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.linearRampToValueAtTime(0.22, t + 0.008);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    oct.connect(g2);
    g2.connect(this.bassGain!);
    oct.start(t);
    oct.stop(t + dur + 0.02);
  }

  /** Stop + silence any in-flight riser (reset mid-countdown / re-arm) so a
   * rescued or re-armed run can never carry a sweep aimed at a stale GO. */
  private stopRiser(): void {
    const src = this.riserSrc;
    const gain = this.riserGain;
    this.riserSrc = null;
    this.riserGain = null;
    if (gain !== null && this.ctx !== null) {
      const now = this.ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(0.0001, now);
    }
    if (src !== null) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
  }

  /** White-noise sweep into the drop — cut dead ON the downbeat. */
  private riser(t0: number, t1: number): void {
    this.stopRiser(); // never two risers in flight
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(400, t0);
    bp.frequency.exponentialRampToValueAtTime(3600, t1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.16, t1 - 0.02);
    g.gain.setValueAtTime(0.0001, t1); // hard cut at the drop
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master!);
    src.start(t0);
    src.stop(t1);
    this.riserSrc = src;
    this.riserGain = g;
  }

  // -- graph ------------------------------------------------------------------

  private buildGraph(ctx: AudioContext): void {
    // master → compressor (gloss + safety) → speakers
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 24;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    compressor.connect(ctx.destination);

    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(compressor);

    // Sidechain bus (pad + bass).
    const duck = ctx.createGain();
    duck.gain.value = 1;
    duck.connect(master);

    // Pad: 4 notes × 2 detuned saws → padGain → lowpass → duck.
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = "lowpass";
    padFilter.frequency.value = 300;
    padFilter.Q.value = 0.6;
    padFilter.connect(duck);

    const padGain = ctx.createGain();
    padGain.gain.value = 0.16;
    padGain.connect(padFilter);

    for (let n = 0; n < PAD_NOTES.length; n++) {
      for (let d = 0; d < 2; d++) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = PAD_NOTES[n];
        osc.detune.value = d === 0 ? -PAD_DETUNE_CENTS : PAD_DETUNE_CENTS;
        const g = ctx.createGain();
        g.gain.value = 0.12;
        osc.connect(g);
        g.connect(padGain);
        osc.start();
        this.padOscs.push(osc);
      }
    }

    // Gentle autonomous motion on the pad filter (±140 Hz, 0.07 Hz).
    const padLfo = ctx.createOscillator();
    padLfo.type = "sine";
    padLfo.frequency.value = 0.07;
    const padLfoDepth = ctx.createGain();
    padLfoDepth.gain.value = 140;
    padLfo.connect(padLfoDepth);
    padLfoDepth.connect(padFilter.frequency);
    padLfo.start();

    // Bass → duck.
    const bassGain = ctx.createGain();
    bassGain.gain.value = 0.55;
    bassGain.connect(duck);

    // Kick → master (not ducked — it IS the duck trigger).
    const kickBus = ctx.createGain();
    kickBus.gain.value = 0.95;
    kickBus.connect(master);

    // Hats: per-note env → highpass → energy-driven level → master.
    const hatFilter = ctx.createBiquadFilter();
    hatFilter.type = "highpass";
    hatFilter.frequency.value = 7200;
    const hatGain = ctx.createGain();
    hatGain.gain.value = 0;
    hatFilter.connect(hatGain);
    hatGain.connect(master);

    // Claps: per-burst env → bandpass → bus → master.
    const clapFilter = ctx.createBiquadFilter();
    clapFilter.type = "bandpass";
    clapFilter.frequency.value = 1750;
    clapFilter.Q.value = 1.1;
    const clapBus = ctx.createGain();
    clapBus.gain.value = 0.5;
    clapFilter.connect(clapBus);
    clapBus.connect(master);

    this.master = master;
    this.compressor = compressor;
    this.duck = duck;
    this.padGain = padGain;
    this.padFilter = padFilter;
    this.padLfo = padLfo;
    this.padLfoDepth = padLfoDepth;
    this.bassGain = bassGain;
    this.kickBus = kickBus;
    this.hatFilter = hatFilter;
    this.hatGain = hatGain;
    this.clapFilter = clapFilter;
    this.clapBus = clapBus;
  }
}
