/**
 * (X)RUNWAY — M9 BEAT-IN-THE-HAND: BeatHapticsSystem (engine wiring only —
 * spec §2.3/§4.5, adjudication §E binding; the arithmetic lives in
 * beat-stats.ts, the per-frame gate/delivery decisions in
 * beat-haptics-core.ts, both pure and pin-tested).
 *
 * Pulses the controller haptic actuators on the go-anchored beat grid at
 * the RUN'S LATCHED tempo (globals.goBpm — the value MusicSystem armed the
 * grid with; 62/100/125, music-prefs.ts) — through the countdown (pref
 * `countdown`, default on: pre-scoring, ends at GO) and through the walk
 * (pref `walk`, default off: a scored condition, stamped on the walk record
 * via BeatStats.reference). Delivery is ALWAYS the every-beat grid: the
 * kick is four-on-the-floor at the delivered tempo (music.ts), so the hand
 * mirrors what the room plays 1:1 — the scoring subdivision (beat-stats.ts
 * chooser) is never a delivery construct.
 *
 * SCHEDULING LAW (§3.7): per-frame polling with lead. pulse() executes
 * IMMEDIATELY (WebXR exposes no schedule-ahead haptic API), so the pulse
 * fires when `now + lead >= nextT` — one ctx.currentTime read + one compare
 * per frame, zero allocation; setTimeout was rejected (throttleable wall
 * clock, drifts off the audio grid). Lead is actuator-aware: 12 ms
 * (BEAT_PULSE_LEAD_SEC — half a frame + assumed LRA onset) with actuators,
 * 50 ms (BEAT_EARCON_LEAD_SEC) for the hand-tracking earcon fallback, whose
 * per-event nodes are scheduled AT the exact grid time (sample-accurate).
 * Missed ticks (GC hitch > BEAT) advance past `now` WITHOUT burst-firing
 * (advancePulseTick — the music.ts visibilitychange re-anchor law).
 * Countdown pulses landing within 60 ms after a countdown tick are SKIPPED
 * (countdownFlamSuppressed, adjudication §H) so the two percussive reads
 * never fuse into a flam; GO stays on-grid.
 *
 * THE GO ANCHOR is cached at the countdown edge UNCONDITIONALLY (§E —
 * independent of prefs) with the sfx.ts scheduleCountdown freshness window,
 * so a mid-walk enable arms from the cached grid: the gated-off frames keep
 * ADVANCING the tick pointer (beat-haptics-core.ts), never firing. This
 * system is registered AFTER MusicSystem (index.ts) so armDropAtGo has
 * published globals.goAudioTime before our phase subscriber reads it — the
 * SfxSystem ordering precedent. A dead ctx at the edge leaves the run
 * unarmed (no delivery, gate closed — honest); a garbage anchor can only
 * mis-place delivery, never a measurement (MetricsSystem validates its own
 * goAudioTime at walk start).
 *
 * DELIVERY HONESTY: `globals.beatDelivery` is ONE preallocated plain object
 * `{ walk: "haptic" | "earcon" | null }` (the holdLive plain-ref pattern,
 * incl. the cleanup guard) — the single source of truth the M9 reference
 * gate reads. `walk` is non-null only while walk-phase pulses are ACTUALLY
 * being emitted (countdown pulses never open the gate); EVERY disarm path
 * (pref off, phase exit, suspended ctx, actuator loss with the earcon
 * muted) nulls it in the SAME frame (walkDeliveryNext — §E). The earcon is
 * level-scaled by the music prefs (MUTE MEANS SILENCE #6): a muted earcon
 * is NOT a delivered reference and reports null.
 *
 * Zero draw calls, no stage-budget rows; audio nodes are event-scoped (the
 * music.ts/sfx.ts voice precedent — at most ~2 pulses/s). The earcon rides
 * the SHARED AudioContext via peekAudioContext (NEVER acquires — the sfx
 * flag-driven law) through a lazily built system-owned gain; an in-flight
 * earcon on a show reset can leak at most one 63 ms tick (lead 50 ms —
 * accepted, unlike sfx's minutes-ahead schedule that needs the retired
 * show bus).
 */

import { createSystem } from "@iwsdk/core";
import type { Signal } from "@preact/signals-core";

import { peekAudioContext } from "./audio-core.js";
import {
  goReinforceFires,
  pulseFrameAction,
  walkDeliveryNext,
  type PulsePhase,
  type WalkDeliveryKind,
} from "./beat-haptics-core.js";
import { DEFAULT_BEAT, type BeatPrefs } from "./beat-prefs.js";
import {
  advancePulseTick,
  BEAT_EARCON_ATTACK_SEC,
  BEAT_EARCON_DECAY_SEC,
  BEAT_EARCON_HZ,
  BEAT_EARCON_LEAD_SEC,
  BEAT_EARCON_LEVEL,
  BEAT_PULSE_INTENSITY,
  BEAT_PULSE_LEAD_SEC,
  BEAT_PULSE_SEC,
  countdownFlamSuppressed,
  firstPulseTick,
} from "./beat-stats.js";
import {
  DEFAULT_MUSIC,
  resolveMusicBpm,
  type MusicPrefs,
} from "./music-prefs.js";
import type { ShowPhaseValue } from "./show.js";
import { beatSecOf, COUNTDOWN_SEC } from "./show-timing.js";

/** Narrow structural view of the raw WebXR GamepadHapticActuator — the TS
 * DOM lib's shape varies across versions (some expose only playEffect), so
 * the optional call keeps a missing pulse() as "no actuator" -> the earcon
 * path, never a crash (spec §9 risk 2). Never `any`. */
interface PulseActuator {
  pulse?(value: number, durationMs: number): unknown;
}

/** Narrow view of StatefulGamepad's raw `gamepad` (verified against
 * @iwsdk/xr-input stateful-gamepad.d.ts — `readonly gamepad: Gamepad`). */
interface HapticsGamepad {
  gamepad?: { hapticActuators?: ReadonlyArray<PulseActuator> };
}

export class BeatHapticsSystem extends createSystem({}, {}) {
  private prefsSig: Signal<BeatPrefs> | null = null;
  private musicSig: Signal<MusicPrefs> | null = null;

  /** The train's phase view (countdown / walk / off) — phase subscription. */
  private phase: PulsePhase = "off";
  /** Grid anchor cached for this run (countdown edge; false = no clock —
   * the whole run stays silent and undelivered). */
  private armed = false;
  /** The cached GO instant on the audio clock (flam suppression + the grid
   * the tick pointer walks). NaN while unarmed. */
  private goAudio = NaN;
  /** Next pulse tick on the go-anchored beat grid (audio clock, s). */
  private nextT = NaN;
  /** The run's LATCHED beat period (s) — cached at the arm edge beside
   * goAudio from the tempo MusicSystem armed the grid with (globals.goBpm,
   * published in the same countdown edge one priority earlier), else the
   * resolved pref. Seeding, advancing, and the GO-tick tolerance all read
   * THIS — a mid-run pref change can never shear the train off the music.
   * NaN while unarmed. */
  private runBeatSec = NaN;

  /** THE delivery fact (globals.beatDelivery) — preallocated plain object,
   * per-frame writes, readers peek defensively (the holdLive pattern). */
  private readonly delivery: { walk: WalkDeliveryKind } = { walk: null };

  /** Earcon output gain on the SHARED context (rebuilt if the ctx was
   * replaced); per-event tick nodes route through it. */
  private earconBus: GainNode | null = null;
  private earconCtx: AudioContext | null = null;

  init(): void {
    const g = this.globals;
    this.prefsSig = (g.beatPrefs as Signal<BeatPrefs> | undefined) ?? null;
    this.musicSig = (g.musicPrefs as Signal<MusicPrefs> | undefined) ?? null;

    // Publish the delivery fact (plain ref, never a signal — per-frame
    // writes). Cleanup guard mirrors holdLive: only remove OUR object.
    g.beatDelivery = this.delivery;
    this.cleanupFuncs.push(() => {
      if (g.beatDelivery === this.delivery) {
        g.beatDelivery = null;
      }
      if (this.earconBus !== null) {
        try {
          this.earconBus.disconnect();
        } catch {
          /* graph already torn down — non-fatal */
        }
        this.earconBus = null;
        this.earconCtx = null;
      }
    });

    const phaseSig = g.showPhase as Signal<ShowPhaseValue> | undefined;
    if (phaseSig) {
      this.cleanupFuncs.push(
        phaseSig.subscribe((phase) => {
          switch (phase) {
            case "countdown":
              this.phase = "countdown";
              this.armCountdown();
              // Countdown pulses never open the reference gate (§E).
              this.delivery.walk = null;
              break;
            case "walk":
              // The train continues on the SAME go-anchored grid; the
              // per-frame pref gate decides firing from here on.
              this.phase = "walk";
              break;
            default:
              // Phase exit (summary / idle / brief): stop the train and
              // null the delivery fact in the SAME frame (§E — the M9
              // reference gate must never see a stale "delivering" claim).
              this.phase = "off";
              this.armed = false;
              this.delivery.walk = null;
          }
        }),
      );
    }
  }

  /**
   * Countdown edge: cache the GO anchor UNCONDITIONALLY (§E — independent
   * of prefs, so a mid-walk enable arms from the cached grid) and point the
   * tick train at the first on-grid pulse (negative k through the countdown
   * covers the ~6 pre-GO beats; the k = 0 GO tick is inclusive — the pulse
   * ON the drop reinforces it). goAudioTime freshness = the sfx.ts
   * scheduleCountdown window verbatim (same shared clock, same threat);
   * absent/stale falls back to now + COUNTDOWN_SEC exactly like the sfx
   * countdown ticks do — delivery-side only, never a measurement input.
   */
  private armCountdown(): void {
    const ctx = peekAudioContext(); // never creates (the sfx flag law)
    if (ctx === null) {
      this.armed = false;
      this.goAudio = NaN;
      this.nextT = NaN;
      this.runBeatSec = NaN;
      return;
    }
    const now = ctx.currentTime;
    const shared = this.globals.goAudioTime;
    const sharedFresh =
      typeof shared === "number" &&
      shared > now - 0.05 &&
      shared < now + COUNTDOWN_SEC + 2.5;
    const go = sharedFresh ? (shared as number) : now + COUNTDOWN_SEC;
    this.goAudio = go;
    // Latch the run's tempo beside the anchor: trust globals.goBpm only when
    // the shared anchor itself was fresh (music published both in the same
    // arm — a stale anchor means a stale tempo too); the fallback resolves
    // the pref exactly like MusicSystem's own adoptTempo would.
    const sharedBpm = this.globals.goBpm;
    this.runBeatSec = beatSecOf(
      sharedFresh && typeof sharedBpm === "number" && Number.isFinite(sharedBpm)
        ? sharedBpm
        : resolveMusicBpm(
            this.musicSig !== null ? this.musicSig.peek() : DEFAULT_MUSIC,
            (
              this.globals.activeMode as
                | { peek(): { id: string } }
                | undefined
            )?.peek()?.id ?? null,
          ),
    );
    // Seed with the SAME actuator-aware lead update() fires on (the earcon
    // path uses BEAT_EARCON_LEAD_SEC): seeding with the shorter default lead
    // could pick a first tick the earcon path then fires ahead of its assumed
    // >= 50 ms schedule-ahead. anyActuator() is stable within a run.
    const lead = this.anyActuator() ? BEAT_PULSE_LEAD_SEC : BEAT_EARCON_LEAD_SEC;
    this.nextT = firstPulseTick(now, go, this.runBeatSec, lead);
    this.armed = true;
  }

  /** Zero-alloc frame: peeks + scalar compares on the idle path; nodes are
   * created only ON a fired earcon tick (event-scoped, ~2/s max). */
  update(): void {
    if (!this.armed || this.phase === "off") {
      return; // delivery was nulled at the arming/phase edges
    }
    const ctx = peekAudioContext();
    const ctxRunning = ctx !== null && ctx.state === "running";
    const p = this.prefsSig !== null ? this.prefsSig.peek() : DEFAULT_BEAT;
    // The pure §E gate: fire / advance-only (pref off) / idle (no clock).
    const action = pulseFrameAction(this.phase, ctxRunning, p.countdown, p.walk);

    let ticked = false;
    let fired: WalkDeliveryKind = null;
    if (action !== "idle" && ctx !== null) {
      const now = ctx.currentTime;
      // Actuator-aware lead (§3.7): pulse() is immediate (12 ms lead); the
      // earcon is schedule-ahead (50 ms) and lands sample-accurate.
      const hasActuator = this.anyActuator();
      const lead = hasActuator ? BEAT_PULSE_LEAD_SEC : BEAT_EARCON_LEAD_SEC;
      if (now + lead >= this.nextT) {
        const tick = this.nextT;
        ticked = true;
        // Countdown flam suppression (§H): a pulse inside [tick, tick+60ms]
        // after a countdown second-boundary tick is skipped (<= 3 per run
        // by construction; GO stays on-grid). Walk ticks can never land in
        // the windows (they all sit >= 1 s pre-GO) — phase-gated anyway.
        const suppressed =
          this.phase === "countdown" &&
          countdownFlamSuppressed(tick, this.goAudio);
        // The GO downbeat (k=0) is the unique grid tick within a quarter of
        // the RUN'S latched beat of the cached anchor (ticks are goAudio +
        // k*runBeatSec; float slop from the repeated advance is ~1e-14).
        const isGoTick = Math.abs(tick - this.goAudio) < this.runBeatSec * 0.25;
        if (action === "fire" && !suppressed) {
          // The phase gate is open: emit AND (walk phase only, via
          // walkDeliveryNext below) open the M9 reference gate.
          fired = this.emitPulse(ctx, tick, hasActuator);
        } else if (
          goReinforceFires(isGoTick, p.countdown, ctxRunning) &&
          !suppressed
        ) {
          // The phase gate is closed but this is the GO reinforcement: emit
          // it phase-INDEPENDENTLY (deterministic across the countdown->walk
          // flip race) WITHOUT touching `fired` — a countdown-owned drop
          // pulse never opens the reference gate (walkDeliveryNext returns
          // null for this non-"fire" action). Zero measurement effect.
          this.emitPulse(ctx, tick, hasActuator);
        }
        // Skip past missed ticks WITHOUT burst-firing (the music.ts
        // visibilitychange re-anchor law) — also on gated-off frames, so a
        // mid-walk enable resumes on the live grid, never in the past.
        this.nextT = advancePulseTick(tick, now, this.runBeatSec, lead);
      }
    }
    // §E: every disarm path nulls the fact in the SAME frame.
    this.delivery.walk = walkDeliveryNext(
      this.phase,
      action,
      ticked,
      fired,
      this.delivery.walk,
    );
  }

  /** One beat's emission: both hands' actuators, else the disclosed earcon
   * tick. Returns what ACTUALLY went out — null when nothing did (no
   * actuators AND the earcon muted): the setting never fakes delivery. */
  private emitPulse(
    ctx: AudioContext,
    tickSec: number,
    hasActuator: boolean,
  ): WalkDeliveryKind {
    if (hasActuator && this.pulseBothHands()) {
      return "haptic";
    }
    return this.earconAt(ctx, tickSec) ? "earcon" : null;
  }

  /** True when either hand exposes a callable pulse() (hand-tracking
   * sessions have NO actuators — the earcon path). Plain property reads. */
  private anyActuator(): boolean {
    return (
      this.handActuator(this.input.xr.gamepads.left) !== null ||
      this.handActuator(this.input.xr.gamepads.right) !== null
    );
  }

  private handActuator(pad: unknown): PulseActuator | null {
    const act = (pad as HapticsGamepad | undefined)?.gamepad
      ?.hapticActuators?.[0];
    return act !== undefined && typeof act.pulse === "function" ? act : null;
  }

  /** Fire both hands (never short-circuit — a one-controller rig still
   * pulses the hand it has). pulse() throws on some stacks mid-session
   * teardown — swallowed as "did not fire". */
  private pulseBothHands(): boolean {
    const left = this.pulseHand(this.input.xr.gamepads.left);
    const right = this.pulseHand(this.input.xr.gamepads.right);
    return left || right;
  }

  private pulseHand(pad: unknown): boolean {
    const act = this.handActuator(pad);
    if (act === null) {
      return false;
    }
    try {
      void act.pulse!(BEAT_PULSE_INTENSITY, BEAT_PULSE_SEC * 1000);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The hand-tracking fallback: one sine tick (B6 — a major sixth above the
   * countdown tick's D6 voice, beat-stats.ts) scheduled AT the grid time,
   * per-event nodes through the system-owned gain (the sfx voice law).
   * Level obeys MUTE MEANS SILENCE (#6): scaled by the music prefs; level 0
   * returns false — a muted earcon is NOT a delivered reference.
   */
  private earconAt(ctx: AudioContext, tickSec: number): boolean {
    const mp = this.musicSig !== null ? this.musicSig.peek() : DEFAULT_MUSIC;
    const level = BEAT_EARCON_LEVEL * (mp.enabled ? mp.volume : 0);
    if (level <= 0) {
      return false;
    }
    if (this.earconCtx !== ctx || this.earconBus === null) {
      // (Re)build the output gain on the (possibly replaced) shared ctx.
      if (this.earconBus !== null) {
        try {
          this.earconBus.disconnect();
        } catch {
          /* old context gone — non-fatal */
        }
      }
      const bus = ctx.createGain();
      bus.gain.value = 1;
      bus.connect(ctx.destination);
      this.earconBus = bus;
      this.earconCtx = ctx;
    }
    // AT the grid time (sample-accurate; the 50 ms lead guarantees the
    // future timestamp — max(now, t) only guards a degenerate first frame).
    const t = Math.max(ctx.currentTime, tickSec);
    const end = t + BEAT_EARCON_ATTACK_SEC + BEAT_EARCON_DECAY_SEC;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(BEAT_EARCON_HZ, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(level, t + BEAT_EARCON_ATTACK_SEC);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(g);
    g.connect(this.earconBus);
    osc.start(t);
    osc.stop(end + 0.02);
    return true;
  }
}
