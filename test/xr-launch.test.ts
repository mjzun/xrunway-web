import { describe, expect, it } from "vitest";

import {
  beginWalkAction,
  enterHeadsetAction,
  launchWatchdogVerdict,
  type XrLaunchState,
} from "../src/xr-launch.ts";

function state(overrides: Partial<XrLaunchState> = {}): XrLaunchState {
  return {
    immersed: false,
    cameraLive: false,
    xrPresent: true,
    arSupported: true,
    ...overrides,
  };
}

describe("beginWalkAction", () => {
  it("runs the show in place while immersed (the trainee physically walks)", () => {
    expect(beginWalkAction(state({ immersed: true }))).toBe("begin-walk");
    // Immersed wins over everything else.
    expect(
      beginWalkAction(
        state({ immersed: true, xrPresent: false, arSupported: false }),
      ),
    ).toBe("begin-walk");
  });

  it("runs the show in place when a companion camera is streaming", () => {
    expect(beginWalkAction(state({ cameraLive: true }))).toBe("begin-walk");
    expect(
      beginWalkAction(
        state({ cameraLive: true, xrPresent: false, arSupported: false }),
      ),
    ).toBe("begin-walk");
  });

  it("launches XR when immersive-ar is supported", () => {
    expect(beginWalkAction(state())).toBe("launch-xr");
  });

  it("launches optimistically while support is still resolving (watchdog covers failure)", () => {
    expect(beginWalkAction(state({ arSupported: null }))).toBe("launch-xr");
  });

  it("falls to the desktop preview on desktop Chrome (xr present, AR unsupported)", () => {
    // THE dead-end case from findings #1/#7: navigator.xr exists, no device.
    expect(beginWalkAction(state({ arSupported: false }))).toBe(
      "desktop-preview",
    );
  });

  it("falls to the desktop preview when no WebXR runtime exists at all", () => {
    expect(
      beginWalkAction(state({ xrPresent: false, arSupported: false })),
    ).toBe("desktop-preview");
  });
});

describe("enterHeadsetAction", () => {
  it("exits when already immersed", () => {
    expect(enterHeadsetAction(state({ immersed: true }))).toBe("exit-xr");
  });

  it("launches when supported or still resolving", () => {
    expect(enterHeadsetAction(state())).toBe("launch-xr");
    expect(enterHeadsetAction(state({ arSupported: null }))).toBe("launch-xr");
  });

  it("hints instead of dead-clicking when AR is unsupported", () => {
    expect(enterHeadsetAction(state({ arSupported: false }))).toBe(
      "unsupported-hint",
    );
    expect(
      enterHeadsetAction(state({ xrPresent: false, arSupported: false })),
    ).toBe("unsupported-hint");
  });

  it("never launches off bare xrPresent once support resolved false", () => {
    // A camera stream doesn't make ENTER HEADSET launch either.
    expect(
      enterHeadsetAction(state({ cameraLive: true, arSupported: false })),
    ).toBe("unsupported-hint");
  });
});

describe("launchWatchdogVerdict (the 5 s watchdog's truth table)", () => {
  it("stays silent when a session became active (the launch worked)", () => {
    expect(launchWatchdogVerdict(false, true)).toBe("silent");
    expect(launchWatchdogVerdict(false, false)).toBe("silent");
    expect(launchWatchdogVerdict(false, null)).toBe("silent");
  });

  it("blames the headset ONLY when AR support is confirmed true", () => {
    expect(launchWatchdogVerdict(true, true)).toBe("declined-toast");
  });

  it("routes to the caller's no-AR fallback when support resolved false — there is no headset to blame", () => {
    expect(launchWatchdogVerdict(true, false)).toBe("fallback");
  });

  it("routes to the fallback when the probe never settled (null) — an optimistic launch that raced it", () => {
    expect(launchWatchdogVerdict(true, null)).toBe("fallback");
  });
});
