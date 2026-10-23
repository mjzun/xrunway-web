/**
 * (X)RUNWAY — Passthrough backdrop driver.
 *
 * Wires `world.globals.activeScene` to the IWSDK background on the active level
 * root:
 *   - a photoreal scene -> add/update a DomeTexture (equirect panorama ->
 *     scene.background) AND hide the dark gradient-dome SPHERE (which, once the
 *     EnvironmentSystem has created it, lives forever and would occlude the
 *     panorama in non-AR);
 *   - "AR / NONE"        -> remove the DomeTexture, clear scene.background, and
 *     show the gradient dome again (the headset / no-backdrop look).
 *
 * The DomeGradient component stays on the root the whole time (added in
 * index.ts); we only toggle the texture + the dome mesh's visibility. The
 * EnvironmentSystem still hides the backdrop in immersive AR, so in a real
 * headset the runway sits on the actual room and these scenes only show in the
 * 2D/desktop pitch. IBLGradient stays put, preserving the dramatic stage light.
 *
 * Pure signal wiring — no per-frame work. Returns a disposer.
 */

import { DomeTexture, EnvironmentSystem, type World } from "@iwsdk/core";
import type { Signal } from "@preact/signals-core";

import type { PassthroughScene } from "./scenes.js";

interface MaybeDomeMesh {
  isMesh?: boolean;
  geometry?: { type?: string };
  visible: boolean;
}

/** Reset the EnvironmentSystem's cached background source so the next DomeTexture
 * selection re-applies even if its `src` matches the last one. There is no public
 * reset hook, so this reaches the system's internal `state.backgroundSource`;
 * it degrades to a no-op (the bug, not a crash) if that field ever moves. */
function invalidateBackgroundCache(world: World): void {
  const env = world.getSystem(EnvironmentSystem) as unknown as
    | { state?: { backgroundSource?: string } }
    | undefined;
  if (env?.state) env.state.backgroundSource = "";
}

export function installEnvironment(world: World): () => void {
  const g = world.globals as Record<string, unknown>;
  const sceneSig = g.activeScene as Signal<PassthroughScene> | undefined;
  if (!sceneSig) {
    console.warn("[environment] globals.activeScene missing — backdrops disabled");
    return () => {};
  }

  // The gradient dome is the ONLY SphereGeometry mesh in the scene (the stage
  // uses boxes/planes/etc.), so we can find it reliably to toggle visibility.
  const setGradientDomeVisible = (visible: boolean): void => {
    world.scene.traverse((o: unknown) => {
      const m = o as MaybeDomeMesh;
      if (m.isMesh === true && m.geometry?.type === "SphereGeometry") {
        m.visible = visible;
      }
    });
  };

  const apply = (scene: PassthroughScene): void => {
    const root = world.activeLevel.value;
    if (!root) return;

    if (scene.src === null) {
      // AR / no backdrop: drop the texture, clear the (stale) equirect, and let
      // the dark gradient dome be the background again.
      if (root.hasComponent(DomeTexture)) {
        root.removeComponent(DomeTexture);
      }
      world.scene.background = null;
      // EnvironmentSystem only re-applies a DomeTexture whose `src` DIFFERS from
      // the last one it loaded (its cached `state.backgroundSource`). Clearing
      // scene.background here is out-of-band, so that cache stays pointed at the
      // old src — re-selecting the SAME backdrop would be treated as "unchanged"
      // and never re-applied, leaving a black void. Invalidate it so any later
      // selection re-applies.
      invalidateBackgroundCache(world);
      setGradientDomeVisible(true);
      return;
    }

    // Photoreal backdrop: DomeTexture owns scene.background; hide the dome mesh
    // so it doesn't occlude the panorama. Re-add (not setValue) on every switch
    // — a fresh component reliably reloads the new src, whereas setValue on the
    // existing one does not re-trigger the EnvironmentSystem's texture load.
    if (root.hasComponent(DomeTexture)) {
      root.removeComponent(DomeTexture);
    }
    root.addComponent(DomeTexture, {
      src: scene.src,
      intensity: scene.intensity,
      rotation: [0, scene.yaw, 0],
    });
    setGradientDomeVisible(false);
  };

  apply(sceneSig.peek());
  const dispose = sceneSig.subscribe((s) => apply(s));

  if (Array.isArray(g.cleanupFuncs)) {
    (g.cleanupFuncs as Array<() => void>).push(dispose);
  }
  return dispose;
}
