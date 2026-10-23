import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LiveCue } from "../src/coach-live.ts";
import {
  cancelCoachVoice,
  EARCON_LEAD_MS,
  speakCue,
} from "../src/coach-voice.ts";
import type { MusicPrefs } from "../src/music-prefs.ts";

// Delivery-layer timing pinned by the module (not exported — by design, the
// tests mirror the user-facing contract): duck tail 300 ms, watchdog 10 s.
const DUCK_TAIL_MS = 300;
const SPEECH_WATCHDOG_MS = 10000;

class FakeUtterance {
  text: string;
  rate = 1;
  volume = 1;
  voice: unknown = null;
  lang = "";
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

/** A HUNG TTS engine — the exact device class the watchdog exists for:
 * speak() never fires end on its own; cancel() fires each cancelled
 * utterance's onerror on a macrotask (the standard async 'interrupted'
 * dispatch in real browser bindings). */
function makeHungSynth() {
  const live: FakeUtterance[] = [];
  return {
    live,
    cancelCalls: 0,
    speak(u: FakeUtterance): void {
      live.push(u);
    },
    cancel(): void {
      this.cancelCalls++;
      const cancelled = live.splice(0, live.length);
      for (const u of cancelled) {
        setTimeout(() => u.onerror?.(), 0);
      }
    },
    getVoices(): never[] {
      return [];
    },
  };
}

function makeDuck() {
  return {
    holds: 0,
    releases: 0,
    hold(): void {
      this.holds++;
    },
    release(): void {
      this.releases++;
    },
  };
}

const CUE_A: LiveCue = {
  kind: "pace-fast",
  text: "Slow it down - long, even strides.",
};
const CUE_B: LiveCue = { kind: "center-up", text: "Find the centerline." };
const AUDIBLE: MusicPrefs = { enabled: true, volume: 1 };

let synth: ReturnType<typeof makeHungSynth>;

beforeEach(() => {
  vi.useFakeTimers();
  synth = makeHungSynth();
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
});

afterEach(() => {
  cancelCoachVoice(); // reset the module-level delivery state between tests
  vi.runOnlyPendingTimers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("coach-voice delivery — duck lifecycle", () => {
  it("holds the duck for the cue and releases it at utterance end + tail", () => {
    const duck = makeDuck();
    speakCue(CUE_A, AUDIBLE, duck);
    expect(duck.holds).toBe(1);
    vi.advanceTimersByTime(EARCON_LEAD_MS); // speech lead — utterance goes out
    expect(synth.live.length).toBe(1);
    synth.live[0].onend?.(); // the engine finishes naturally
    expect(duck.releases).toBe(0); // tail still running
    vi.advanceTimersByTime(DUCK_TAIL_MS);
    expect(duck.releases).toBe(1); // balanced: 1 hold / 1 release
  });

  it("mute means silence: volume 0 delivers nothing and holds no duck", () => {
    const duck = makeDuck();
    speakCue(CUE_A, { enabled: true, volume: 0 }, duck);
    speakCue(CUE_A, { enabled: false, volume: 1 }, duck);
    vi.advanceTimersByTime(5000);
    expect(duck.holds).toBe(0);
    expect(synth.live.length).toBe(0);
  });
});

describe("coach-voice delivery — stale cancelled-utterance events (night-review #3)", () => {
  it("a hung cue's late onerror can no longer release the successor's duck", () => {
    const duck = makeDuck();
    // Cue A goes out and HANGS (no end/error from the engine).
    speakCue(CUE_A, AUDIBLE, duck);
    vi.advanceTimersByTime(EARCON_LEAD_MS);
    expect(synth.live.length).toBe(1);
    vi.advanceTimersByTime(5000); // still speaking at the next cue

    // Cue B: speakCue cancels A first (the engine fires A's onerror on a
    // macrotask, AFTER B already holds its duck) and delivers B.
    speakCue(CUE_B, AUDIBLE, duck);
    expect(duck.holds).toBe(2);
    expect(duck.releases).toBe(1); // A's duck released by the cancel itself

    // A's stale onerror fires inside this window; B's utterance goes out.
    vi.advanceTimersByTime(EARCON_LEAD_MS);
    expect(synth.live.length).toBe(1);
    expect(synth.live[0].text).toBe(CUE_B.text);

    // Pre-fix: A's stale handler scheduleRelease()d ~300 ms in, popping the
    // music back up mid-sentence AND clearing B's 10 s watchdog. Post-fix
    // the generation token orphans it — B's duck stays held.
    vi.advanceTimersByTime(2000);
    expect(duck.releases).toBe(1);
  });

  it("the successor's watchdog survives the stale event and still fires", () => {
    const duck = makeDuck();
    speakCue(CUE_A, AUDIBLE, duck);
    vi.advanceTimersByTime(EARCON_LEAD_MS + 5000); // A hung mid-speech
    speakCue(CUE_B, AUDIBLE, duck);
    vi.advanceTimersByTime(EARCON_LEAD_MS); // B speaking; A's stale error consumed

    // B also hangs. Its watchdog — which the stale event used to clear —
    // must still hard-stop the engine and release the duck at 10 s.
    const cancelsBefore = synth.cancelCalls;
    vi.advanceTimersByTime(SPEECH_WATCHDOG_MS);
    expect(duck.releases).toBe(2); // B's duck released by B's OWN watchdog
    expect(synth.cancelCalls).toBeGreaterThan(cancelsBefore);
    expect(duck.holds).toBe(duck.releases); // balanced by construction
  });
});
