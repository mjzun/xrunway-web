/**
 * (X)RUNWAY — Browser free-look camera.
 *
 * IWSDK locomotion (features.locomotion.browserControls) handles WASD/gamepad
 * MOVEMENT but leaves the camera app-owned, so this wires mouse-look: drag on
 * the 3D canvas (NOT the UI overlay) to rotate `world.camera`. Locomotion then
 * slides `world.player` along wherever the camera is pointing — so WASD + drag
 * gives a free-fly/free-walk feel in the 2D pitch, and you can look around while
 * the PREVIEW WALK auto-pilots the rig down the runway.
 *
 * Only active in the 2D browser (NonImmersive) — in a headset the head IS the
 * camera and the thumbstick moves you. Drags that begin on an interactive UI
 * control never reach the canvas (the overlay is pointer-events:none except its
 * buttons), so this never steals clicks from the landing.
 *
 * Returns a disposer.
 */

import { VisibilityState, type World } from "@iwsdk/core";

const SENSITIVITY = 0.0026; // radians per pixel
const PITCH_LIMIT = 1.2; // ~69° up/down

export function installFreeLook(world: World): () => void {
  if (typeof window === "undefined") return () => {};
  const canvas: HTMLElement | null =
    (world.renderer as { domElement?: HTMLCanvasElement } | undefined)
      ?.domElement ?? document.querySelector("canvas");
  if (!canvas) {
    console.warn("[freelook] no canvas — mouse-look disabled");
    return () => {};
  }

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let yaw = 0;
  let pitch = 0;

  const inBrowser = (): boolean =>
    world.visibilityState.peek() === VisibilityState.NonImmersive;

  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !inBrowser()) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    // Seed from the camera's current orientation so look-drag is continuous.
    yaw = world.camera.rotation.y;
    pitch = world.camera.rotation.x;
    canvas.style.cursor = "grabbing";
  };

  const onMove = (e: PointerEvent): void => {
    // Guard inBrowser() too: if a drag is mid-flight when an XR session starts,
    // the headset owns the camera — keep look-drag from fighting it.
    if (!dragging || !inBrowser()) return;
    yaw -= (e.clientX - lastX) * SENSITIVITY;
    pitch -= (e.clientY - lastY) * SENSITIVITY;
    if (pitch > PITCH_LIMIT) pitch = PITCH_LIMIT;
    if (pitch < -PITCH_LIMIT) pitch = -PITCH_LIMIT;
    lastX = e.clientX;
    lastY = e.clientY;
    // YXZ so yaw is applied before pitch (no roll, FPS-style look).
    world.camera.rotation.set(pitch, yaw, 0, "YXZ");
  };

  const onUp = (): void => {
    if (!dragging) return;
    dragging = false;
    canvas.style.cursor = "";
  };

  // Pressing a movement key during the PREVIEW WALK hands control to the user:
  // the demo hard-sets the player each frame, so it must yield for WASD to take
  // effect. stop() is a no-op when no demo is running.
  const MOVE_KEYS = new Set([
    "KeyW",
    "KeyA",
    "KeyS",
    "KeyD",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
  ]);
  const onKey = (e: KeyboardEvent): void => {
    if (!inBrowser() || !MOVE_KEYS.has(e.code)) return;
    const demo = (world.globals as Record<string, unknown>).demoControls as
      | { stop(): void }
      | null
      | undefined;
    demo?.stop();
  };

  canvas.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("keydown", onKey);

  return () => {
    canvas.removeEventListener("pointerdown", onDown);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("keydown", onKey);
  };
}
