/**
 * (X)RUNWAY — show SFX layer (#19). Fully synthesized, zero audio files.
 *
 * The show's signature moments were completely silent outside the music bed:
 * the countdown counted mutely against the HUD digits, GO passed unmarked,
 * footstrikes heaved the floor without a sound, the pose-mark paparazzi storm
 * was a purely visual burst, and the finale/score reveal landed on a shrug.
 * This system voices exactly those beats (the event table + every level and
 * recipe live in sfx-timeline.ts — pure, unit-tested):
 *
 *   countdown-tick  phase:countdown   ticks ON the HUD's second boundaries,
 *                                     scheduled against the armed GO instant
 *   go-hit          clock:go          sample-aligned with THE DROP (#44 —
 *                                     globals.goAudioTime, shared AudioContext)
 *   footstrike      edge:lastStep     tiny tap per strike; rides show energy
 *   pose-sting      edge:poseBurst    shutter cluster + chime at the mark
 *   finale-hit      edge:finishBurst  boom + splash on the finish line (#18)
 *   reveal-sting    phase:summary     graded PASS / NEEDS-WORK, +0.9 s
 *
 * LAWS (learned the hard way — commit 98a571b):
 *  - poseBurst / finishBurst / lastStep are SHARED, durable globals with
 *    multiple readers. This system edge-detects with PRIVATE prev latches and
 *    NEVER writes any of them.
 *  - Zero per-frame allocation: update() only reads plain refs/signals and
 *    compares numbers; audio nodes are created per EVENT (the music.ts voice
 *    precedent), never per frame.
 *  - globals.musicPrefs governs the layer exactly like the music engine (#6):
 *    off = silent master, volume scales it; live changes retarget the gain.
 *  - AudioContext discipline is shared with music.ts via audio-core.ts: ONE
 *    lazily-created context (autoplay-unlocked by the user-gesture phase
 *    chain), acquired only on phase edges; flag-driven voices use
 *    peekAudioContext() and stay silent until the show unlocked audio.
 *  - Scheduled-ahead one-shots (ticks / GO / reveal) route through a show bus
 *    that is muted AND RETIRED the instant the show resets to idle, so a
 *    cancelled run never leaks its pending sounds into the house: the
 *    orphaned bus keeps the stale nodes silent forever, and a reopened run
 *    builds a FRESH GainNode (mute-only retirement was resurrectable —
 *    ensureGraph's reuse path re-opened the same bus and un-muted the old
 *    run's pending ticks/GO/sting, night-review #2).
 */

import { createSystem } from "@iwsdk/core";
import type { Signal } from "@preact/signals-core";

import {
  acquireAudioContext,
  peekAudioContext,
  sharedNoiseBuffer,
} from "./audio-core.js";
import { DEFAULT_MUSIC, type MusicPrefs } from "./music-prefs.js";
import type { ShowPhaseValue, ShowSummary } from "./show.js";
import { COUNTDOWN_SEC, countdownTickTimes } from "./show-timing.js";
import {
  REVEAL_DELAY_SEC,
  revealVariant,
  SFX_VOICES,
  sfxEvent,
  sfxLevel,
} from "./sfx-timeline.js";

export class SfxSystem extends createSystem({}, {}) {
  private phaseSig!: Signal<ShowPhaseValue>;
  private energySig: Signal<number> | null = null;
  private prefsSig: Signal<MusicPrefs> | null = null;

  // Per-context graph (rebuilt if the shared context was replaced).
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  /** Bus for scheduled-ahead one-shots — muted instantly on reset/idle. */
  private showBus: GainNode | null = null;

  // Private rising-edge latches — the shared flags are NEVER written here.
  private posePrev = false;
  private finishPrev = false;
  private lastStepTime = -1;
  private footParity = 0;
  /** GO hit already scheduled for the current run (countdown edge). */
  private goArmed = false;

  init(): void {
    const g = this.globals;
    this.phaseSig = g.showPhase as Signal<ShowPhaseValue>;
    this.energySig = (g.showEnergy as Signal<number> | undefined) ?? null;
    this.prefsSig = (g.musicPrefs as Signal<MusicPrefs> | undefined) ?? null;

    // Seed the footstrike latch so a strike that predates this system never
    // fires a ghost tap on the first frame.
    const step = g.lastStep as { time: number } | null | undefined;
    this.lastStepTime = step ? step.time : -1;

    if (this.prefsSig) {
      // Live mute toggle / volume drag — same behavior as the music master.
      this.cleanupFuncs.push(this.prefsSig.subscribe(() => this.applyLevel()));
    }

    // Mid-walk remap: the director clears and re-latches the shared poseBurst
    // against the NEW mark — re-arm the private edge latch so the re-fired
    // pose sting isn't swallowed (night-review; mirrors CoachLiveSystem).
    // Outside a walk the flag is durable/stale, so the latch stays put.
    const pathSig = g.compiledPath as Signal<unknown> | undefined;
    if (pathSig !== undefined) {
      this.cleanupFuncs.push(
        pathSig.subscribe(() => {
          if (this.phaseSig.peek() === "walk") {
            this.posePrev = false;
          }
        }),
      );
    }

    this.cleanupFuncs.push(
      this.phaseSig.subscribe((phase) => this.onPhase(phase)),
    );

    this.cleanupFuncs.push(() => this.teardown());
  }

  update(): void {
    // Flag-driven voices: cheap reads + number compares only (zero alloc).
    const g = this.globals;

    const pose = g.poseBurst === true;
    const finish = g.finishBurst === true;
    const step = g.lastStep as
      | { time: number; z: number; seg?: number }
      | null
      | undefined;

    // peek — never create a context outside the user-gesture phase chain.
    const ctx = this.ctx !== null ? peekAudioContext() : null;
    const live = ctx !== null && ctx === this.ctx && this.master !== null;

    // Pose/finale route to the MASTER (no idle-mute backstop), so they need
    // the same running-state guard footTick has: on a suspended context
    // currentTime is frozen and every sting/boom of the run would pile onto
    // one timestamp, bursting together at the next unlock (night-review #15).
    // The prev latches still advance below — suspended edges are consumed
    // silently, never backlogged.
    if (pose && !this.posePrev && live && ctx!.state === "running") {
      this.poseSting(ctx!.currentTime);
    }
    this.posePrev = pose;

    if (finish && !this.finishPrev && live && ctx!.state === "running") {
      this.finaleHit(ctx!.currentTime);
    }
    this.finishPrev = finish;

    if (step && step.time !== this.lastStepTime) {
      this.lastStepTime = step.time; // consume even when silent (no backlog)
      if (live && ctx!.state === "running") {
        this.footTick(ctx!.currentTime);
      }
    }
  }

  // -- show choreography ------------------------------------------------------

  private onPhase(phase: ShowPhaseValue): void {
    switch (phase) {
      case "brief":
        // User-gesture path — safe to create/unlock the shared context.
        this.ensureGraph();
        this.goArmed = false;
        break;
      case "countdown":
        if (this.ensureGraph()) {
          this.scheduleCountdown();
        }
        break;
      case "walk":
        // Normally the GO hit was armed at the countdown edge; cover the
        // degenerate direct-to-walk path (tests / ctx recovered late).
        if (!this.goArmed && this.ensureGraph() && this.ctx) {
          this.goHit(this.ctx.currentTime);
        }
        this.goArmed = false;
        break;
      case "summary":
        this.scheduleReveal();
        break;
      case "idle":
        // Reset mid-run: kill everything scheduled ahead (ticks/GO/reveal).
        this.muteShowBus();
        break;
    }
  }

  /** Countdown ticks on the HUD's second boundaries + the GO hit ON the drop.
   * The GO instant comes from globals.goAudioTime (armed by MusicSystem on
   * the SAME AudioContext clock, #44); fall back to now + COUNTDOWN_SEC. */
  private scheduleCountdown(): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    this.openShowBus();
    const now = ctx.currentTime;
    const shared = this.globals.goAudioTime;
    const go =
      typeof shared === "number" &&
      shared > now - 0.05 &&
      shared < now + COUNTDOWN_SEC + 2.5
        ? shared
        : now + COUNTDOWN_SEC;
    const ticks = countdownTickTimes(go);
    for (let i = 0; i < ticks.length; i++) {
      if (ticks[i] >= now - 1e-3) {
        this.tick(Math.max(now, ticks[i]));
      }
    }
    this.goHit(go);
    this.goArmed = true;
  }

  /** Graded score-reveal sting, one beat after the summary lands (#18/#19). */
  private scheduleReveal(): void {
    const ctx = this.ctx;
    if (!ctx || !this.showBus) {
      return;
    }
    const summary = (
      this.globals.summary as Signal<ShowSummary | null> | undefined
    )?.peek();
    if (summary === null || summary === undefined) {
      return;
    }
    const variant = revealVariant(summary.overall, summary.passThreshold);
    this.reveal(ctx.currentTime + REVEAL_DELAY_SEC, variant);
  }

  // -- voices (nodes are event-scoped, the music.ts precedent) ----------------

  /** Soft, precise countdown tick (the old metronome's D6 voice). */
  private tick(t: number): void {
    const ctx = this.ctx!;
    const level = sfxEvent("countdown-tick").level;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(SFX_VOICES.tick.freq, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(level, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + SFX_VOICES.tick.decay);
    osc.connect(g);
    g.connect(this.showBus!);
    osc.start(t);
    osc.stop(t + SFX_VOICES.tick.decay + 0.02);
  }

  /** GO: bright two-tone affirmation + snap transient, ON the drop downbeat. */
  private goHit(t: number): void {
    const ctx = this.ctx!;
    const level = sfxEvent("go-hit").level;
    const freqs = SFX_VOICES.go.freqs;
    for (let i = 0; i < freqs.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freqs[i], t);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(level * (i === 0 ? 1 : 0.6), t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + SFX_VOICES.go.decay);
      osc.connect(g);
      g.connect(this.showBus!);
      osc.start(t);
      osc.stop(t + SFX_VOICES.go.decay + 0.02);
    }
    // Snap transient: a 25 ms high-passed noise click under the tones.
    const src = ctx.createBufferSource();
    src.buffer = sharedNoiseBuffer(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 3000;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(level * 0.8, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
    src.connect(hp);
    hp.connect(ng);
    ng.connect(this.showBus!);
    src.start(t, 0.2, 0.05);
  }

  /** Subtle footstrike tap — L/R alternate brightness, gain rides energy. */
  private footTick(t: number): void {
    const ctx = this.ctx!;
    const v = SFX_VOICES.foot;
    const energy = this.energySig !== null ? this.energySig.peek() : 0;
    const gain = v.baseGain + v.energySpan * (energy < 0 ? 0 : energy > 1 ? 1 : energy);
    const freq = this.footParity === 0 ? v.freqL : v.freqR;
    this.footParity ^= 1;
    const src = ctx.createBufferSource();
    src.buffer = sharedNoiseBuffer(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = freq;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + v.decay);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master!);
    src.start(t, Math.random() * 0.8, v.decay + 0.03);
  }

  /** Pose-mark sting: shutter-click cluster + one bright chime — the audio
   * twin of the paparazzi burst (fires with the visual storm's rising edge). */
  private poseSting(t: number): void {
    const ctx = this.ctx!;
    const level = sfxEvent("pose-sting").level;
    const v = SFX_VOICES.pose;
    for (let i = 0; i < v.clicks; i++) {
      const at = t + (i / v.clicks) * v.spread + Math.random() * 0.02;
      const src = ctx.createBufferSource();
      src.buffer = sharedNoiseBuffer(ctx);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 4200;
      const g = ctx.createGain();
      g.gain.setValueAtTime(level * (0.7 + Math.random() * 0.3), at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.03);
      src.connect(hp);
      hp.connect(g);
      g.connect(this.master!);
      src.start(at, Math.random() * 0.8, 0.06);
    }
    const chime = ctx.createOscillator();
    chime.type = "sine";
    chime.frequency.setValueAtTime(v.chimeFreq, t);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, t);
    cg.gain.linearRampToValueAtTime(level * 0.55, t + 0.01);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + v.chimeDecay);
    chime.connect(cg);
    cg.connect(this.master!);
    chime.start(t);
    chime.stop(t + v.chimeDecay + 0.05);
  }

  /** Finale hit: sub boom + noise splash the instant the walk finishes (#18).
   * The musical cadence (music.ts) resolves right behind it on the beat. */
  private finaleHit(t: number): void {
    const ctx = this.ctx!;
    const level = sfxEvent("finale-hit").level;
    const v = SFX_VOICES.finale;
    const boom = ctx.createOscillator();
    boom.type = "sine";
    boom.frequency.setValueAtTime(v.boomFrom, t);
    boom.frequency.exponentialRampToValueAtTime(v.boomTo, t + v.boomDecay * 0.7);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.linearRampToValueAtTime(level, t + 0.006);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + v.boomDecay);
    boom.connect(bg);
    bg.connect(this.master!);
    boom.start(t);
    boom.stop(t + v.boomDecay + 0.05);

    const splash = ctx.createBufferSource();
    splash.buffer = sharedNoiseBuffer(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = v.splashFreq;
    bp.Q.value = 0.8;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(level * 0.55, t);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + v.splashDecay);
    splash.connect(bp);
    bp.connect(sg);
    sg.connect(this.master!);
    splash.start(t, Math.random() * 0.5, v.splashDecay + 0.05);
  }

  /** Graded reveal: PASS = ascending sparkle; NEEDS WORK = gentle low settle. */
  private reveal(t: number, variant: "pass" | "needswork"): void {
    const ctx = this.ctx!;
    const level = sfxEvent("reveal-sting").level;
    const v = SFX_VOICES.reveal;
    const notes = variant === "pass" ? v.pass : v.needswork;
    for (let i = 0; i < notes.length; i++) {
      const at = t + i * v.noteGap;
      const osc = ctx.createOscillator();
      osc.type = variant === "pass" ? "sine" : "triangle";
      osc.frequency.setValueAtTime(notes[i], at);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(level, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + v.decay);
      osc.connect(g);
      g.connect(this.showBus!);
      osc.start(at);
      osc.stop(at + v.decay + 0.05);
    }
  }

  // -- graph / levels ----------------------------------------------------------

  /** The layer's master target — the music engine's exact pref law (#6). */
  private currentLevel(): number {
    const p = this.prefsSig ? this.prefsSig.peek() : DEFAULT_MUSIC;
    return sfxLevel(p);
  }

  /** Pref change (mute toggle / volume drag): ease the live master over. */
  private applyLevel(): void {
    if (!this.ctx || !this.master) {
      return;
    }
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(this.currentLevel(), now, 0.12);
  }

  /** Acquire the shared context and (re)build this layer's graph on it. */
  private ensureGraph(): boolean {
    const ctx = acquireAudioContext();
    if (!ctx) {
      return false;
    }
    if (ctx === this.ctx && this.master !== null) {
      if (this.showBus === null) {
        // The previous run's bus was RETIRED on idle (muteShowBus) — build a
        // fresh one so nothing can un-mute that run's pending nodes.
        this.showBus = this.buildShowBus(ctx, this.master);
      } else {
        this.openShowBus();
      }
      return true;
    }
    // Fresh or replaced context — rebuild.
    this.teardown();
    this.ctx = ctx;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 24;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.002;
    compressor.release.value = 0.2;
    compressor.connect(ctx.destination);
    const master = ctx.createGain();
    master.gain.value = this.currentLevel();
    master.connect(compressor);
    this.master = master;
    this.compressor = compressor;
    this.showBus = this.buildShowBus(ctx, master);
    return true;
  }

  /** One run's bus for scheduled-ahead one-shots. Built per run/graph —
   * muteShowBus retires the old one, orphaned nodes and all. */
  private buildShowBus(ctx: AudioContext, master: GainNode): GainNode {
    const bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(master);
    return bus;
  }

  private openShowBus(): void {
    if (!this.ctx || !this.showBus) {
      return;
    }
    const now = this.ctx.currentTime;
    this.showBus.gain.cancelScheduledValues(now);
    this.showBus.gain.setValueAtTime(1, now);
  }

  /** The idle/reset edge: mute (the ramp keeps the cut click-free) and then
   * RETIRE the bus. Nulling the field forces ensureGraph to build a fresh
   * GainNode for the next run, so the cancelled run's scheduled-ahead nodes
   * — ticks, the GO hit, a pending reveal sting, all started with absolute
   * future timestamps that survive a mute — stay wired to this orphan and
   * render silently (openShowBus can never resurrect them, night-review #2).
   * The orphan is disconnected once the ramp has settled; its sources end on
   * their own schedule and become collectable. */
  private muteShowBus(): void {
    const bus = this.showBus;
    if (!this.ctx || !bus) {
      return;
    }
    const now = this.ctx.currentTime;
    bus.gain.cancelScheduledValues(now);
    bus.gain.setTargetAtTime(0.0001, now, 0.05);
    this.showBus = null;
    setTimeout(() => {
      try {
        bus.disconnect();
      } catch {
        /* context/graph already torn down — non-fatal */
      }
    }, 400);
  }

  /** Disconnect this layer's graph. The shared context itself is owned (and
   * closed on teardown) by MusicSystem via audio-core. */
  private teardown(): void {
    if (this.master) {
      this.master.disconnect();
    }
    if (this.compressor) {
      this.compressor.disconnect();
    }
    this.master = null;
    this.compressor = null;
    this.showBus = null;
    this.ctx = null;
  }
}
