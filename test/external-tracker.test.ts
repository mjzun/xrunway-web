import { beforeEach, describe, expect, it } from "vitest";

import { ExternalTracker, type PoseFrame } from "../src/external-tracker.ts";

function frame(t: number, source = "test"): PoseFrame {
  return { t, source, space: "world", keypoints: {} };
}

describe("ExternalTracker", () => {
  let now: number;
  let tracker: ExternalTracker;
  beforeEach(() => {
    now = 0;
    tracker = new ExternalTracker(() => now);
  });

  it("starts disconnected with no frame", () => {
    expect(tracker.latest()).toBeNull();
    const s = tracker.status();
    expect(s.connected).toBe(false);
    expect(s.source).toBeNull();
    expect(s.ageSec).toBe(Infinity);
  });

  it("reports a fresh pushed frame as connected", () => {
    tracker.push(frame(now, "iphone-arkit"));
    expect(tracker.latest()).not.toBeNull();
    const s = tracker.status();
    expect(s.connected).toBe(true);
    expect(s.source).toBe("iphone-arkit");
    expect(s.ageSec).toBeCloseTo(0, 3);
  });

  it("goes stale after the 0.6s window", () => {
    tracker.push(frame(now));
    now += 500; // 0.5s — still fresh
    expect(tracker.latest()).not.toBeNull();
    expect(tracker.status().connected).toBe(true);
    now += 200; // 0.7s total — stale
    expect(tracker.latest()).toBeNull();
    expect(tracker.status().connected).toBe(false);
  });

  it("a newer frame refreshes freshness", () => {
    tracker.push(frame(now));
    now += 700;
    expect(tracker.latest()).toBeNull();
    tracker.push(frame(now)); // new frame at the current clock
    expect(tracker.latest()).not.toBeNull();
    expect(tracker.status().connected).toBe(true);
  });

  it("computes fps over a 1s window", () => {
    // The window only recomputes fps on a push at/after the 1s mark, so push
    // frames every 50ms through now=1000 (21 pushes) to cross it.
    for (let i = 0; i <= 20; i++) {
      tracker.push(frame(now));
      now += 50;
    }
    const fps = tracker.status().fps;
    expect(fps).toBeGreaterThan(15);
    expect(fps).toBeLessThan(25);
  });
});
