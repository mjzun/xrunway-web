/**
 * (X)RUNWAY — THE HOUSE REACTS (idea-starter #5; pure curves in
 * house-reacts-core.ts).
 *
 * The room is no longer emotionally silent: a low synthesized crowd-murmur
 * bed sits under the show (filtered noise + a slow wander — no files, the
 * sfx.ts house style), HUSHES fast on the countdown, stays attentive
 * through the walk, and APPLAUDS at the score reveal — intensity scaled by
 * the walk's own overall vs its pass bar (theatrical delivery of the real
 * number: the medal / judges-paddle precedent).
 *
 * LAWS (inherited from sfx.ts, learned the hard way):
 * - ONE shared AudioContext (audio-core.ts): acquire only on the phase
 *   chain's user-gesture edges; peek elsewhere; silent when absent.
 * - globals.musicPrefs governs the layer exactly like music/SFX: off =
 *   silent master, volume scales it, live changes retarget the gain.
 * - The applause schedules ahead → it rides a retire-on-reset bus: reset
 *   to idle mutes AND RETIRES the bus (a fresh run builds a fresh one), so
 *   a cancelled run never claps into the house later.
 * - Zero per-frame work: everything is phase-edge driven; update() is not
 *   even implemented. The bed eases via setTargetAtTime; the wander is one
 *   slow LFO node, not JS.
 */

import { createSystem } from "@iwsdk/core";
import type { Signal } from "@preact/signals-core";

import { acquireAudioContext, sharedNoiseBuffer } from "./audio-core.js";
import {
  applauseGrains,
  applauseIntensity,
  HOUSE_MASTER_LEVEL,
  houseBedLevel,
  houseBedTau,
} from "./house-reacts-core.js";
import { DEFAULT_MUSIC, type MusicPrefs } from "./music-prefs.js";
import {
  DEFAULT_PASS_THRESHOLD,
  REVEAL_DELAY_SEC,
  sfxLevel,
} from "./sfx-timeline.js";
import type { ShowPhaseValue, ShowSummary } from "./show.js";

export class HouseReactsSystem extends createSystem({}, {}) {
  private phaseSig!: Signal<ShowPhaseValue>;
  private prefsSig: Signal<MusicPrefs> | null = null;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** The murmur bed chain (lives as long as the graph). */
  private bedGain: GainNode | null = null;
  private bedNodes: AudioNode[] = [];
  private bedLevel = 0;
  /** Retire-on-reset bus for the scheduled-ahead applause. */
  private applauseBus: GainNode | null = null;

  init(): void {
    const g = this.globals;
    this.phaseSig = g.showPhase as Signal<ShowPhaseValue>;
    this.prefsSig = (g.musicPrefs as Signal<MusicPrefs> | undefined) ?? null;

    if (this.prefsSig) {
      this.cleanupFuncs.push(this.prefsSig.subscribe(() => this.applyLevel()));
    }
    this.cleanupFuncs.push(
      this.phaseSig.subscribe((phase) => this.onPhase(phase)),
    );
    this.cleanupFuncs.push(() => this.teardown());
  }

  private onPhase(phase: ShowPhaseValue): void {
    // The brief is the user-gesture edge (the sfx.ts precedent) — safe to
    // create the shared context + the bed graph there. Other phases only
    // retarget what already exists.
    if (phase === "brief") this.ensureGraph();
    if (phase === "idle") this.retireApplause();
    this.easeBedTo(phase);
    if (phase === "summary") this.applaud();
  }

  /** Build (or rebuild after context replacement) the master + murmur bed. */
  private ensureGraph(): boolean {
    const ctx = acquireAudioContext();
    if (!ctx) return false;
    if (ctx === this.ctx && this.master !== null) return true;
    this.teardown();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    // The murmur bed: looped shared noise through two vocal-band bandpasses
    // (a roomful of low conversation, not hiss) + a slow LFO wander so the
    // bed breathes instead of droning.
    const src = ctx.createBufferSource();
    src.buffer = sharedNoiseBuffer(ctx);
    src.loop = true;
    const bp1 = ctx.createBiquadFilter();
    bp1.type = "bandpass";
    bp1.frequency.value = 260;
    bp1.Q.value = 1.1;
    const bp2 = ctx.createBiquadFilter();
    bp2.type = "bandpass";
    bp2.frequency.value = 620;
    bp2.Q.value = 0.9;
    this.bedGain = ctx.createGain();
    this.bedGain.gain.value = 0;
    const wander = ctx.createOscillator();
    wander.type = "sine";
    wander.frequency.value = 0.13;
    const wanderDepth = ctx.createGain();
    wanderDepth.gain.value = 0.25;
    wander.connect(wanderDepth);
    wanderDepth.connect(this.bedGain.gain);
    src.connect(bp1);
    bp1.connect(bp2);
    bp2.connect(this.bedGain);
    this.bedGain.connect(this.master);
    src.start();
    wander.start();
    this.bedNodes = [src, bp1, bp2, wander, wanderDepth];

    this.bedLevel = 0;
    this.applyLevel();
    return true;
  }

  /** Master follows musicPrefs (off = silent), under the house ceiling. */
  private applyLevel(): void {
    if (!this.ctx || !this.master) return;
    const prefs = this.prefsSig ? this.prefsSig.peek() : DEFAULT_MUSIC;
    const level =
      (sfxLevel(prefs) / 0.5) * HOUSE_MASTER_LEVEL; // prefs curve, house ceiling
    this.master.gain.setTargetAtTime(level, this.ctx.currentTime, 0.12);
  }

  /** Ease the murmur bed to the phase's level — fast hush, slow swell. */
  private easeBedTo(phase: ShowPhaseValue): void {
    if (!this.ctx || !this.bedGain) return;
    const to = houseBedLevel(phase);
    const tau = houseBedTau(this.bedLevel, to);
    this.bedGain.gain.setTargetAtTime(to, this.ctx.currentTime, tau);
    this.bedLevel = to;
  }

  /** Applause at the reveal: intensity from the summary's own overall vs
   * its LOCKED pass bar; grains scheduled onto the retire-on-reset bus. */
  private applaud(): void {
    if (!this.ctx || !this.master || this.ctx.state !== "running") return;
    const summary = (
      this.globals.summary as Signal<ShowSummary | null> | undefined
    )?.peek();
    if (!summary) return;
    const intensity = applauseIntensity(
      summary.overall,
      summary.passThreshold ?? DEFAULT_PASS_THRESHOLD,
    );
    if (intensity <= 0) return;
    this.retireApplause();
    const ctx = this.ctx;
    const bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(this.master);
    this.applauseBus = bus;
    const t0 = ctx.currentTime + REVEAL_DELAY_SEC;
    // Seed off the walk (deterministic per summary, varied across walks).
    const grains = applauseGrains(
      intensity,
      Math.round(summary.overall * 97 + summary.durationSec * 13),
    );
    const noise = sharedNoiseBuffer(ctx);
    for (const grain of grains) {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      // Random in-buffer start so grains never phase-align into a buzz.
      const offset = (grain.t * 7.13) % 1.2;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = grain.freq;
      bp.Q.value = 2.2;
      const gn = ctx.createGain();
      const at = t0 + grain.t;
      gn.gain.setValueAtTime(0.0001, at);
      gn.gain.linearRampToValueAtTime(grain.level * 0.5, at + 0.004);
      gn.gain.exponentialRampToValueAtTime(0.0001, at + 0.055);
      src.connect(bp);
      bp.connect(gn);
      gn.connect(bus);
      src.start(at, offset, 0.08);
    }
  }

  /** Mute + orphan the applause bus (reset law — pending claps die silent). */
  private retireApplause(): void {
    if (this.applauseBus && this.ctx) {
      this.applauseBus.gain.setValueAtTime(0, this.ctx.currentTime);
      this.applauseBus.disconnect();
    }
    this.applauseBus = null;
  }

  private teardown(): void {
    this.retireApplause();
    for (const n of this.bedNodes) {
      try {
        (n as AudioScheduledSourceNode).stop?.();
      } catch {
        /* already stopped */
      }
      n.disconnect();
    }
    this.bedNodes = [];
    this.bedGain = null;
    if (this.master) this.master.disconnect();
    this.master = null;
    this.ctx = null;
  }
}
