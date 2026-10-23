/**
 * (X)RUNWAY — ONE shared AudioContext for every synthesized sound.
 *
 * MusicSystem (the 122 BPM engine) and SfxSystem (the show SFX layer, #19)
 * ride the SAME context — one autoplay unlock, one clock (so the SFX GO hit
 * is sample-aligned with THE DROP, #44), one output chain to keep in budget.
 *
 * Discipline (carried over from music.ts, the original owner):
 *  - LAZY: created only from a user-initiated phase change (autoplay rules).
 *    Systems that fire outside a gesture context (footstrike ticks) must use
 *    {@link peekAudioContext} and stay silent until the show unlocked audio.
 *  - Creation failure (headless / no output device) is non-fatal: callers get
 *    null and the show goes on silently.
 *  - MusicSystem's cleanup remains the closer ({@link closeSharedAudioContext},
 *    HMR teardown); a later {@link acquireAudioContext} transparently rebuilds.
 *  - The shared 1.5 s white-noise buffer (hats/claps/risers/shutters) is built
 *    once per context.
 */

let sharedCtx: AudioContext | null = null;
let sharedNoise: AudioBuffer | null = null;

/** Get-or-create the shared context (user-gesture call paths only). Resumes a
 * suspended context. Returns null when WebAudio is unavailable. */
export function acquireAudioContext(): AudioContext | null {
  if (sharedCtx === null || sharedCtx.state === "closed") {
    try {
      sharedCtx = new AudioContext({ latencyHint: "interactive" });
    } catch (err) {
      // Audio-less environment: the show must go on silently rather than
      // unwind the phase-change signal chain.
      console.warn("[audio] AudioContext unavailable:", err);
      sharedCtx = null;
      return null;
    }
    sharedNoise = null; // buffers are per-context
  }
  if (sharedCtx.state === "suspended") {
    void sharedCtx.resume();
  }
  return sharedCtx;
}

/** The existing context, or null — NEVER creates (safe outside user gestures). */
export function peekAudioContext(): AudioContext | null {
  return sharedCtx !== null && sharedCtx.state !== "closed" ? sharedCtx : null;
}

/** Shared white-noise buffer for `ctx` (hats, claps, risers, shutter clicks). */
export function sharedNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (sharedNoise === null || sharedNoise.sampleRate !== ctx.sampleRate) {
    const len = Math.floor(ctx.sampleRate * 1.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    sharedNoise = buf;
  }
  return sharedNoise;
}

/** Close + forget the shared context (HMR/system teardown — MusicSystem calls
 * this, preserving its original ownership). Safe to call repeatedly. */
export function closeSharedAudioContext(): void {
  if (sharedCtx !== null && sharedCtx.state !== "closed") {
    void sharedCtx.close();
  }
  sharedCtx = null;
  sharedNoise = null;
}
